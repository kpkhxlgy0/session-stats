'use strict';

const { createSnapshotProtocol } = require('./snapshot.cjs');

const MaxSessions = 32;
const MaxRetiredPublishers = 32;
const RequestBudget = Object.freeze({ timeoutMs: 5000, maxChars: 64 * 1024 });
const MaxResponseWaitMs = 750;
const DemandIntervalMs = 10000;

function validHostId(value)
{
    return typeof value === 'string' && value.length > 0 && value.length <= 512
        && value.toLowerCase() !== 'local' && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function failure(reason)
{
    return Object.assign(new Error(reason), { reason });
}

function createSnapshotRemoteStore({ now = Date.now, pollMs,
    responseWaitMs = MaxResponseWaitMs } = {})
{
    const protocol = createSnapshotProtocol();
    pollMs ??= protocol.pollMs;
    if (typeof now !== 'function') throw new TypeError('A snapshot clock is required');
    if (![pollMs, responseWaitMs].every(value => Number.isSafeInteger(value) && value >= 0))
        throw new RangeError('Invalid snapshot polling interval');
    pollMs = Math.min(pollMs, protocol.pollMs);
    responseWaitMs = Math.min(responseWaitMs, MaxResponseWaitMs);
    const emptyStats = protocol.projectStats({ status: 'unavailable' });
    const sessions = new Map();
    let disposed = false;

    const current = entry => !disposed && sessions.get(entry.key) === entry;
    const unavailable = (hostId, threadId, reason) => ({ ...emptyStats, hostId, threadId,
        source: 'snapshot', unavailableReason: reason });

    function cancelEntry(entry)
    {
        for (const cancel of [...entry.cancellations]) cancel();
    }

    function block(entry, reason)
    {
        entry.blocked = true;
        entry.reason = reason;
    }

    function peek(entry)
    {
        if (!current(entry)) return unavailable(entry.hostId, entry.threadId, 'snapshot-unavailable');
        if (!entry.blocked && entry.accepted)
        {
            const age = now() - entry.accepted.generatedAt;
            if (age < -protocol.futureSkewMs) block(entry, 'snapshot-future');
            else if (age <= protocol.maxAgeMs)
                return { ...protocol.toStats(entry.accepted), hostId: entry.hostId };
            else entry.reason = 'snapshot-expired';
        }
        return unavailable(entry.hostId, entry.threadId, entry.reason);
    }

    function call(entry, request, method, params)
    {
        if (!current(entry)) return Promise.reject(failure('snapshot-cancelled'));
        return new Promise((resolve, reject) =>
        {
            const controller = method === 'snapshot/request' ? new AbortController() : null;
            let settled = false;
            const finish = (error, value) =>
            {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                entry.cancellations.delete(cancel);
                if (!error && !current(entry)) error = failure('snapshot-cancelled');
                if (error)
                {
                    controller?.abort();
                    reject(error);
                }
                else resolve(value);
            };
            const cancel = () => finish(failure('snapshot-cancelled'));
            const timer = setTimeout(() => finish(failure('snapshot-read-failed')), RequestBudget.timeoutMs);
            entry.cancellations.add(cancel);
            Promise.resolve().then(() =>
            {
                if (!current(entry)) throw failure('snapshot-cancelled');
                return request(method, params, controller ? { ...RequestBudget, signal: controller.signal } : RequestBudget);
            }).then(value => finish(null, value), error => finish(error));
        });
    }

    function metadata(value, directory)
    {
        if (!value || value.isFile !== !directory || value.isDirectory !== directory || value.isSymlink !== false
            || !Number.isFinite(value.createdAtMs) || value.createdAtMs < 0
            || !Number.isFinite(value.modifiedAtMs) || value.modifiedAtMs < 0)
            throw failure('snapshot-invalid');
        return value;
    }

    function requestDemand(entry, request, rolloutPath)
    {
        if (!current(entry) || now() < entry.nextDemandAt) return;
        entry.nextDemandAt = now() + DemandIntervalMs;
        // The caller handles this internal signal; it is never forwarded as a native RPC endpoint.
        call(entry, request, 'snapshot/request', { rolloutPath, threadId: entry.threadId }).catch(() => {});
    }

    function decode(value)
    {
        if (typeof value !== 'string' || value.length > RequestBudget.maxChars || value.length % 4 !== 0
            || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw failure('snapshot-invalid');
        const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
        if (value.length / 4 * 3 - padding > protocol.maxBytes) throw failure('snapshot-invalid');
        const bytes = Buffer.from(value, 'base64');
        if (bytes.toString('base64') !== value) throw failure('snapshot-invalid');
        const text = bytes.toString('utf8');
        if (!Buffer.from(text).equals(bytes)) throw failure('snapshot-invalid');
        return text;
    }

    function accept(entry, snapshot)
    {
        const previous = entry.accepted;
        const serialized = JSON.stringify([snapshot.generatedAt, protocol.projectStats(snapshot.stats)]);
        if (previous)
        {
            if (snapshot.publisherId === previous.publisherId)
            {
                if (snapshot.revision < previous.revision || snapshot.generatedAt < previous.generatedAt
                    || snapshot.revision === previous.revision && serialized !== entry.acceptedText)
                    throw failure('snapshot-replay');
            }
            else
            {
                if (entry.retired.has(snapshot.publisherId) || snapshot.generatedAt <= previous.generatedAt
                    || entry.retired.size >= MaxRetiredPublishers) throw failure('snapshot-replay');
                entry.retired.add(previous.publisherId);
            }
        }
        entry.accepted = snapshot;
        entry.acceptedText = serialized;
        entry.blocked = false;
        entry.reason = snapshot.stats.status === 'ok' ? 'snapshot-loading' : 'source-unavailable';
    }

    function context(response, threadId)
    {
        if (protocol.normalizeThreadId(response?.thread?.id) !== threadId) throw failure('snapshot-identity');
        const value = protocol.remoteContext(response.thread.path, threadId);
        if (!value) throw failure('snapshot-identity');
        return value;
    }

    async function probe(entry, request)
    {
        try
        {
            const nativeContext = await call(entry, request, 'thread/read',
                { threadId: entry.threadId, includeTurns: false });
            const remote = context(nativeContext, entry.threadId);
            requestDemand(entry, request, nativeContext.thread.path);
            const targets = [remote.codexHome, remote.directory, remote.file];
            async function inspect()
            {
                const values = await Promise.allSettled(targets.map(async (value, index) =>
                    metadata(await call(entry, request, 'fs/getMetadata', { path: value }), index !== 2)));
                const failed = values.find(value => value.status === 'rejected');
                if (failed) throw failed.reason;
                return values.map(value => value.value);
            }
            const before = await inspect();
            const file = await call(entry, request, 'fs/readFile', { path: remote.file });
            const text = decode(file?.dataBase64);
            const [after, native] = await Promise.all([inspect(), call(entry, request, 'thread/read',
                { threadId: entry.threadId, includeTurns: false })]);
            const confirmed = context(native, entry.threadId);
            const canonical = value => remote.pathApi.sep === '\\' ? value.toLowerCase() : value;
            if (canonical(confirmed.file) !== canonical(remote.file)) throw failure('snapshot-identity');
            // Atomic publication replaces the file and changes directory mtime. Only parent creation identities are stable.
            if (before.slice(0, 2).some((value, index) => value.createdAtMs !== after[index].createdAtMs))
                throw failure('snapshot-invalid');
            const parsed = protocol.parseSnapshot(text, { threadId: entry.threadId, now: now() });
            if (!parsed.ok) throw failure(`snapshot-${parsed.reason}`);
            if (current(entry)) accept(entry, parsed.snapshot);
        }
        catch (error)
        {
            if (!current(entry) || error.reason === 'snapshot-cancelled') return;
            const reason = error.reason ?? (/enoent|not found|no such file|does not exist/i.test(error.message ?? '')
                ? 'snapshot-missing' : 'snapshot-read-failed');
            if (!['snapshot-missing', 'snapshot-read-failed', 'snapshot-expired'].includes(reason)) block(entry, reason);
            else if (!entry.blocked) entry.reason = reason;
        }
    }

    async function getStats(identity, request)
    {
        const hostId = validHostId(identity?.hostId) ? identity.hostId : null;
        const threadId = protocol.normalizeThreadId(identity?.threadId);
        if (disposed || !hostId || !threadId || typeof request !== 'function')
            return unavailable(hostId, threadId, 'snapshot-identity');
        const key = JSON.stringify([hostId, threadId]);
        let entry = sessions.get(key);
        if (!entry)
        {
            if (sessions.size >= MaxSessions)
            {
                const oldest = sessions.keys().next().value;
                const removed = sessions.get(oldest);
                sessions.delete(oldest);
                cancelEntry(removed);
            }
            entry = { key, hostId, threadId, accepted: null, retired: new Set(), blocked: false,
                probeTask: null, nextProbeAt: -Infinity, nextDemandAt: -Infinity,
                reason: 'snapshot-loading', cancellations: new Set() };
        }
        sessions.delete(key);
        sessions.set(key, entry);
        peek(entry);
        if (!entry.probeTask && now() >= entry.nextProbeAt)
        {
            entry.nextProbeAt = now() + pollMs;
            const task = probe(entry, request).finally(() =>
            {
                if (entry.probeTask === task)
                {
                    entry.probeTask = null;
                    entry.nextProbeAt = now() + pollMs;
                }
            });
            entry.probeTask = task;
        }
        const value = peek(entry);
        if (entry.blocked || value.status === 'ok' || entry.accepted && now() - entry.accepted.generatedAt <= protocol.maxAgeMs
            || !entry.probeTask) return value;
        let timer;
        try
        {
            await Promise.race([entry.probeTask, new Promise(resolve => { timer = setTimeout(resolve, responseWaitMs); })]);
        }
        finally { clearTimeout(timer); }
        return peek(entry);
    }

    function dispose()
    {
        if (disposed) return;
        disposed = true;
        for (const entry of sessions.values()) cancelEntry(entry);
        sessions.clear();
    }

    return { getStats, dispose };
}

module.exports = { createSnapshotRemoteStore };

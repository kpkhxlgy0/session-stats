'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createSnapshotProtocol } = require('./snapshot.cjs');
const { discoverRecentThreadIds, discoverSnapshotRequests } = require('./snapshot-discovery.cjs');

const MaxTrackedIds = 32;
const DiscoveryMs = 15000;

function fileIdentity(info) { return `${info.dev}:${info.ino}:${info.birthtimeMs}`; }

function fileVersion(info) { return `${fileIdentity(info)}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`; }

function containsPath(root, candidate)
{
    const relative = path.relative(root, candidate);
    return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function samePath(left, right) { return path.relative(left, right) === ''; }

function ownUser(info) { return typeof process.getuid !== 'function' || info.uid === process.getuid(); }

function createSnapshotPublisher({ codexHome, store, now = Date.now, pollMs = 2000,
    heartbeatMs = 10000, publisherId = randomUUID(), installationRoot = path.resolve(__dirname, '..'),
    discover = discoverRecentThreadIds } = {})
{
    const protocol = createSnapshotProtocol();
    const states = new Map();
    const ownTemps = new Map();
    const cancellation = new AbortController();
    const waiters = new Set();
    const home = typeof codexHome === 'string' && path.isAbsolute(codexHome) ? path.resolve(codexHome) : null;
    const interval = Number.isFinite(pollMs) && pollMs > 0 ? pollMs : protocol.pollMs;
    const heartbeat = Number.isFinite(heartbeatMs) && heartbeatMs > 0 ? heartbeatMs : protocol.heartbeatMs;
    let timer, refreshPending, requestsPending, disposePending, discoveryAt = -Infinity;
    let disposed = false, started = false, epoch = 0, revision = 0;

    function unavailable(threadId)
    {
        return { ...protocol.projectStats({ status: 'unavailable' }), threadId,
            source: 'snapshot', unavailableReason: 'snapshot-publish-failed' };
    }

    function active(runEpoch) { return !disposed && epoch === runEpoch; }

    async function untilStopped(work)
    {
        let cancel;
        const cancelled = new Promise(resolve => { cancel = resolve; });
        waiters.add(cancel);
        if (disposed) cancel();
        try { return await Promise.race([work, cancelled]); }
        finally { waiters.delete(cancel); }
    }

    async function directoryInfo(directory)
    {
        const info = await fs.lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink() || !ownUser(info))
            throw new Error('Unsafe snapshot directory');
        return fileIdentity(info);
    }

    async function directories(create, runEpoch = epoch)
    {
        if (!home) throw new Error('Missing Codex home');
        const identity = await directoryInfo(home);
        const resolvedHome = await fs.realpath(home);
        const protectedRoot = await fs.realpath(installationRoot);
        const directory = path.join(home, '.session-stats');
        const resolvedDirectory = path.join(resolvedHome, '.session-stats');
        if (containsPath(protectedRoot, resolvedDirectory) || containsPath(resolvedDirectory, protectedRoot)
            || containsPath(path.resolve(installationRoot), directory) || containsPath(directory, path.resolve(installationRoot)))
            throw new Error('Snapshot directory overlaps a watched installation');
        if (create)
        {
            if (!active(runEpoch)) throw new Error('Snapshot publication cancelled');
            try { await fs.mkdir(directory, { mode: 0o700 }); }
            catch (error) { if (error.code !== 'EEXIST') throw error; }
        }
        const expected = { homeIdentity: identity, resolvedHome, directory,
            directoryIdentity: await directoryInfo(directory), resolvedDirectory };
        await confirmDirectories(expected);
        return expected;
    }

    async function confirmDirectories(expected)
    {
        if (await directoryInfo(home) !== expected.homeIdentity
            || !samePath(await fs.realpath(home), expected.resolvedHome)
            || await directoryInfo(expected.directory) !== expected.directoryIdentity
            || !samePath(await fs.realpath(expected.directory), expected.resolvedDirectory))
            throw new Error('Snapshot directory changed');
        if (expected.requestDirectory && (await directoryInfo(expected.requestDirectory) !== expected.requestIdentity
            || !samePath(await fs.realpath(expected.requestDirectory), expected.resolvedRequests)))
            throw new Error('Snapshot request directory changed');
    }

    async function requestDirectories(runEpoch)
    {
        const requestFile = protocol.requestPath(home, publisherId, publisherId, path);
        if (!requestFile) throw new Error('Invalid snapshot request directory');
        const expected = await directories(true, runEpoch);
        const requestDirectory = path.dirname(requestFile);
        if (!active(runEpoch)) throw new Error('Snapshot publication cancelled');
        await confirmDirectories(expected);
        if (!active(runEpoch)) throw new Error('Snapshot publication cancelled');
        try { await fs.mkdir(requestDirectory, { mode: 0o700 }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        const guarded = { ...expected, requestDirectory, requestIdentity: await directoryInfo(requestDirectory),
            resolvedRequests: path.join(expected.resolvedDirectory, 'requests') };
        await confirmDirectories(guarded);
        return guarded;
    }

    async function readDestination(file, threadId)
    {
        let info;
        try { info = await fs.lstat(file); }
        catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        if (!info.isFile() || info.isSymbolicLink() || !ownUser(info) || info.size > protocol.maxBytes)
            throw new Error('Unsafe snapshot destination');
        const handle = await fs.open(file, 'r');
        try
        {
            const opened = await handle.stat();
            if (!opened.isFile() || fileIdentity(opened) !== fileIdentity(info))
                throw new Error('Snapshot destination changed');
            const buffer = Buffer.alloc(protocol.maxBytes + 1);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            const after = await fs.lstat(file);
            if (bytesRead > protocol.maxBytes || !after.isFile() || after.isSymbolicLink()
                || fileIdentity(after) !== fileIdentity(info)) throw new Error('Snapshot destination changed');
            const text = buffer.subarray(0, bytesRead).toString('utf8');
            let generatedAt;
            try { generatedAt = JSON.parse(text)?.generatedAt; } catch { /* Strict validation rejects unknown content. */ }
            const parsed = protocol.parseSnapshot(text, { threadId, now: generatedAt });
            if (!parsed.ok) throw new Error('Unknown snapshot destination ownership');
            return { snapshot: parsed.snapshot, identity: fileIdentity(info) };
        }
        finally { await handle.close(); }
    }

    async function removeTemp(temporary)
    {
        const owned = ownTemps.get(temporary);
        if (!owned) return;
        try
        {
            await confirmDirectories(owned.directories);
            const info = await fs.lstat(temporary);
            if (info.isFile() && !info.isSymbolicLink() && fileIdentity(info) === owned.identity)
                await fs.unlink(temporary);
        }
        catch { /* Preserve unknown files and changed directories. */ }
        ownTemps.delete(temporary);
    }

    async function publish(threadId, snapshot, runEpoch)
    {
        const destination = protocol.snapshotPath(home, threadId, path);
        if (!destination || !active(runEpoch)) throw new Error('Snapshot publication cancelled');
        const expected = await directories(true);
        if (!active(runEpoch)) throw new Error('Snapshot publication cancelled');
        const before = await readDestination(destination, threadId);
        await confirmDirectories(expected);
        if (!active(runEpoch)) throw new Error('Snapshot publication cancelled');
        const temporary = path.join(expected.directory, `.${threadId}.${publisherId}.${randomUUID()}.tmp`);
        let handle;
        try
        {
            handle = await fs.open(temporary, 'wx', 0o600);
            ownTemps.set(temporary, { directories: expected, identity: fileIdentity(await handle.stat()) });
            await confirmDirectories(expected);
            if (!active(runEpoch)) throw new Error('Snapshot publication cancelled');
            await handle.writeFile(JSON.stringify(snapshot) + '\n', 'utf8');
            await handle.close(); handle = null;
            for (let attempt = 0; ; attempt++)
            {
                await confirmDirectories(expected);
                const current = await readDestination(destination, threadId);
                if (before?.identity !== current?.identity) throw new Error('Snapshot destination changed');
                if (!active(runEpoch)) throw new Error('Snapshot publication cancelled');
                try { await fs.rename(temporary, destination); break; }
                catch (error)
                {
                    // Windows readers can briefly deny replacement until their handle closes.
                    if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)
                        || attempt >= 6) throw error;
                    await new Promise(resolve => setTimeout(resolve, 5 * (attempt + 1)));
                }
            }
            ownTemps.delete(temporary);
            await confirmDirectories(expected);
            const written = await readDestination(destination, threadId);
            if (!active(runEpoch) || JSON.stringify(written?.snapshot) !== JSON.stringify(snapshot))
                throw new Error('Published snapshot changed');
            return snapshot;
        }
        finally { await handle?.close(); await removeTemp(temporary); }
    }

    async function checkPublished(state, runEpoch)
    {
        const sample = state.snapshot;
        const parsed = protocol.parseSnapshot(JSON.stringify(sample), { threadId: state.id, now: now() });
        if (!parsed.ok) throw new Error('Published snapshot expired');
        const expected = await directories(false);
        const existing = await readDestination(protocol.snapshotPath(home, state.id, path), state.id);
        await confirmDirectories(expected);
        if (!active(runEpoch) || JSON.stringify(existing?.snapshot) !== JSON.stringify(sample))
            throw new Error('Published snapshot replaced');
        return sample;
    }

    function track(threadId, requestedAt = null)
    {
        let state = states.get(threadId);
        if (!state)
        {
            if (states.size >= MaxTrackedIds)
            {
                const idle = [...states].find(([, entry]) => !entry.pending);
                if (!idle) return null;
                states.delete(idle[0]);
            }
            state = { id: threadId, snapshot: null, pending: null, persistent: false, requestedUntil: -Infinity };
        }
        if (requestedAt === null) state.persistent = true;
        else state.requestedUntil = Math.max(state.requestedUntil, requestedAt + protocol.maxAgeMs);
        states.delete(threadId);
        states.set(threadId, state);
        return state;
    }

    function poll(state)
    {
        if (state.pending) return state.pending;
        const runEpoch = epoch;
        state.pending = (async () =>
        {
            if (!active(runEpoch)) return null;
            const raw = await untilStopped(store.getStats(state.id));
            if (!active(runEpoch)) return null;
            if (raw?.threadId !== undefined && protocol.normalizeThreadId(raw.threadId) !== state.id)
                throw new Error('Mismatched source identity');
            const stats = protocol.projectStats(raw);
            if (!stats) throw new Error('Invalid source statistics');
            const time = now();
            if (state.snapshot && JSON.stringify(stats) === JSON.stringify(state.snapshot.stats)
                && time >= state.snapshot.generatedAt && time - state.snapshot.generatedAt < heartbeat)
                return checkPublished(state, runEpoch);
            const snapshot = protocol.makeSnapshot(state.id, stats, { publisherId, revision: revision + 1, now: time });
            if (!snapshot) throw new Error('Invalid snapshot sample');
            // Reserve before I/O; a cancelled publication may already have been observed.
            revision = snapshot.revision;
            state.snapshot = await publish(state.id, snapshot, runEpoch);
            return state.snapshot;
        })().catch(() => { state.snapshot = null; return null; })
            .finally(() =>
            {
                state.pending = null;
                if (!state.persistent && now() > state.requestedUntil && states.get(state.id) === state)
                    states.delete(state.id);
            });
        return state.pending;
    }

    async function removeExpiredRequest(marker, expected, runEpoch)
    {
        let handle;
        try
        {
            await confirmDirectories(expected);
            const before = await fs.lstat(marker.file);
            if (!before.isFile() || before.isSymbolicLink() || fileVersion(before) !== marker.version) return;
            handle = await fs.open(marker.file, 'r');
            if (fileVersion(await handle.stat()) !== marker.version) return;
            const buffer = Buffer.alloc(protocol.maxRequestBytes + 1);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            if (buffer.subarray(0, bytesRead).toString('utf8') !== marker.text) return;
            await handle.close(); handle = null;
            await confirmDirectories(expected);
            const current = await fs.lstat(marker.file);
            if (current.isFile() && !current.isSymbolicLink() && fileVersion(current) === marker.version
                && active(runEpoch)) await fs.unlink(marker.file);
        }
        catch { /* Never delete a changed or unknown request marker. */ }
        finally { await handle?.close(); }
    }

    function refreshRequests()
    {
        if (disposed) return Promise.resolve();
        if (requestsPending) return requestsPending;
        const runEpoch = epoch;
        requestsPending = (async () =>
        {
            const expected = await requestDirectories(runEpoch);
            if (!active(runEpoch)) return;
            const markers = await discoverSnapshotRequests(expected.requestDirectory,
                { now: now(), signal: cancellation.signal });
            await confirmDirectories(expected);
            if (!active(runEpoch)) return;
            const time = now();
            for (const [threadId, state] of states)
                if (!state.persistent && !state.pending && time > state.requestedUntil) states.delete(threadId);
            for (const marker of markers)
            {
                if (!active(runEpoch)) return;
                if (marker.expired) await removeExpiredRequest(marker, expected, runEpoch);
                else
                {
                    const state = track(marker.request.threadId, marker.request.requestedAt);
                    if (state) void poll(state);
                }
            }
        })().catch(() => {}).finally(() => { requestsPending = null; });
        return requestsPending;
    }

    function refreshRecent()
    {
        if (disposed) return Promise.resolve();
        if (refreshPending) return refreshPending;
        const runEpoch = epoch;
        refreshPending = (async () =>
        {
            const time = now();
            if (time < discoveryAt || time - discoveryAt >= DiscoveryMs)
            {
                discoveryAt = time;
                try
                {
                    const recent = await untilStopped(discover(home, { signal: cancellation.signal }));
                    if (!active(runEpoch)) return;
                    let added = 0;
                    for (const value of Array.isArray(recent) ? recent : [])
                    {
                        const threadId = protocol.normalizeThreadId(value);
                        if (threadId && added++ < 8) track(threadId);
                        if (added >= 8) break;
                    }
                }
                catch { /* Explicit interest and previously tracked sessions can still update. */ }
            }
            for (const state of [...states.values()])
            {
                if (!active(runEpoch)) return;
                if (!state.persistent && !state.pending && now() > state.requestedUntil)
                {
                    if (states.get(state.id) === state) states.delete(state.id);
                    continue;
                }
                if (states.get(state.id) === state) await poll(state);
            }
        })().catch(() => {}).finally(() => { refreshPending = null; });
        return refreshPending;
    }

    function refresh()
    {
        if (disposed) return Promise.resolve();
        // Demand discovery must keep running even while a recent-session parser is blocked.
        return Promise.all([refreshRequests(), refreshRecent()]).then(() => {});
    }

    function start()
    {
        if (disposed) return Promise.resolve();
        if (!started)
        {
            started = true;
            timer = setInterval(() => { void refreshRequests(); void refreshRecent(); }, Math.max(1, interval));
            timer.unref?.();
        }
        return refresh();
    }

    async function getStats(value)
    {
        const threadId = protocol.normalizeThreadId(value);
        if (disposed || !threadId) return unavailable(threadId);
        const state = track(threadId);
        if (!state) return unavailable(threadId);
        const snapshot = await poll(state);
        return !disposed && snapshot ? protocol.toStats(snapshot) : unavailable(threadId);
    }

    function dispose()
    {
        if (disposePending) return disposePending;
        disposed = true; epoch++;
        cancellation.abort();
        for (const cancel of waiters) cancel();
        clearInterval(timer);
        disposePending = (async () =>
        {
            await Promise.allSettled([refreshPending, requestsPending, ...[...states.values()].map(state => state.pending)]);
            for (const temporary of ownTemps.keys()) await removeTemp(temporary);
            states.clear();
        })();
        return disposePending;
    }

    return { start, getStats, refresh, dispose };
}

module.exports = { createSnapshotPublisher };

'use strict';

const { createHash } = require('node:crypto');
const { createMetrics } = require('./metrics.cjs');

const UuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MaxSessions = 32;
const PollMs = 15000;
const LargePollMs = 60000;
const LargeFileBytes = 4 * 1024 * 1024;
const MaxFileBytes = 32 * 1024 * 1024;
const MaxLineBytes = 8 * 1024 * 1024;
const EmptyStats = Object.freeze(createMetrics().snapshot());

function validHostId(value)
{
    return typeof value === 'string' && value.length > 0 && value.length <= 512
        && value.toLowerCase() !== 'local' && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function validThreadId(value)
{
    return typeof value === 'string' && UuidPattern.test(value) ? value.toLowerCase() : null;
}

function result(hostId, threadId, entry)
{
    const stats = { ...EmptyStats };
    const snapshot = entry?.status === 'ok' ? entry.snapshot : null;
    for (const key of Object.keys(stats))
    {
        const value = snapshot?.[key];
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0
            || typeof value === 'boolean' || value === null)
        {
            stats[key] = value;
        }
    }
    return { ...stats, status: snapshot ? 'ok' : 'unavailable', threadId, hostId };
}

function validPath(value, threadId)
{
    if (typeof value !== 'string' || value.includes('\0')) return false;
    const name = value.split(/[\\/]/).pop();
    const match = new RegExp(`^rollout-.+-${threadId}(?:_(.+))?\\.jsonl$`, 'i').exec(name);
    return match !== null && (match[1] === undefined || validThreadId(match[1]) !== null);
}

function metadataKey(metadata, path)
{
    if (!metadata || metadata.isFile !== true || metadata.isDirectory !== false || metadata.isSymlink !== false
        || !Number.isFinite(metadata.createdAtMs) || metadata.createdAtMs < 0
        || !Number.isFinite(metadata.modifiedAtMs) || metadata.modifiedAtMs < 0) return null;
    // 只缓存路径指纹，避免保留远程文件路径和原始内容。
    const pathHash = createHash('sha256').update(path).digest('hex');
    return `${pathHash}:${metadata.createdAtMs}:${metadata.modifiedAtMs}`;
}

function decodeFile(value)
{
    if (typeof value !== 'string' || value.length % 4 !== 0) return null;
    const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
    const size = value.length / 4 * 3 - padding;
    if (size > MaxFileBytes) return { size, bytes: null };
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
    const bytes = Buffer.from(value, 'base64');
    return bytes.toString('base64') === value ? { size, bytes } : null;
}

async function parseSnapshot(bytes, threadId, isCurrent)
{
    const metrics = createMetrics();
    let start = 0;
    let lineCount = 0;
    let yieldedAt = 0;
    while (start < bytes.length)
    {
        if (!isCurrent()) return null;
        const newline = bytes.indexOf(10, start);
        if (newline === -1) break;
        if (newline - start <= MaxLineBytes)
        {
            let record;
            try
            {
                record = JSON.parse(bytes.toString('utf8', start, newline));
            }
            catch
            {
                record = null;
            }
            if (record?.type === 'session_meta' && record.payload
                && Object.hasOwn(record.payload, 'id') && validThreadId(record.payload.id) !== threadId) return null;
            metrics.ingest(record);
        }
        start = newline + 1;
        if (++lineCount % 128 === 0 || start - yieldedAt >= 1024 * 1024)
        {
            yieldedAt = start;
            await new Promise(setImmediate);
        }
    }
    return isCurrent() ? metrics.snapshot() : null;
}

function createRemoteSessionStore({ now = Date.now } = {})
{
    const sessions = new Map();
    let disposed = false;

    async function poll(entry, request, isCurrent)
    {
        const response = await request('thread/read', { threadId: entry.threadId, includeTurns: false });
        if (!isCurrent()) return;
        const thread = response?.thread;
        if (validThreadId(thread?.id) !== entry.threadId || !validPath(thread?.path, entry.threadId)) return;
        const metadata = await request('fs/getMetadata', { path: thread.path });
        if (!isCurrent()) return;
        const key = metadataKey(metadata, thread.path);
        if (key === null) return;
        if (key === entry.metadataKey)
        {
            if (entry.snapshot) entry.status = 'ok';
            return;
        }
        let file;
        try
        {
            file = await request('fs/readFile', { path: thread.path });
        }
        catch (error)
        {
            if (isCurrent() && error?.code === 'SESSION_STATS_LOG_TOO_LARGE')
            {
                entry.snapshot = null;
                entry.metadataKey = key;
                entry.bytes = MaxFileBytes + 1;
                return;
            }
            throw error;
        }
        if (!isCurrent()) return;
        const decoded = decodeFile(file?.dataBase64);
        if (!decoded) return;
        if (decoded.size > MaxFileBytes)
        {
            entry.snapshot = null;
            entry.metadataKey = key;
            entry.bytes = decoded.size;
            return;
        }
        const bytes = decoded.bytes;
        const snapshot = await parseSnapshot(bytes, entry.threadId, isCurrent);
        if (!isCurrent() || !snapshot) return;
        entry.snapshot = snapshot;
        entry.metadataKey = key;
        entry.bytes = bytes.length;
        entry.status = 'ok';
    }

    async function getStats(identity, request)
    {
        const hostId = validHostId(identity?.hostId) ? identity.hostId : null;
        const threadId = validThreadId(identity?.threadId);
        if (disposed || !hostId || !threadId || typeof request !== 'function') return result(hostId, threadId);
        const key = JSON.stringify([hostId, threadId]);
        let entry = sessions.get(key);
        if (!entry)
        {
            if (sessions.size >= MaxSessions)
            {
                const idle = [...sessions].find(([, value]) => !value.inFlight);
                if (!idle) return result(hostId, threadId);
                sessions.delete(idle[0]);
            }
            entry = { hostId, threadId, nextPollAt: -Infinity, bytes: 0, status: 'unavailable' };
        }
        sessions.delete(key);
        sessions.set(key, entry);
        if (entry.inFlight) return entry.inFlight;
        if (now() < entry.nextPollAt) return result(hostId, threadId, entry);
        const isCurrent = () => !disposed && sessions.get(key) === entry;
        entry.status = 'unavailable';
        entry.nextPollAt = now() + (entry.bytes > LargeFileBytes ? LargePollMs : PollMs);
        entry.inFlight = poll(entry, request, isCurrent)
            .catch(() => {})
            .then(() => result(hostId, threadId, isCurrent() ? entry : null))
            .finally(() =>
            {
                entry.nextPollAt = now() + (entry.bytes > LargeFileBytes ? LargePollMs : PollMs);
                entry.inFlight = null;
            });
        return entry.inFlight;
    }

    function dispose()
    {
        disposed = true;
        sessions.clear();
    }

    return { getStats, dispose };
}

module.exports = { createRemoteSessionStore };

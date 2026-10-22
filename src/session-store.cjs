'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const UuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SessionPattern = /^rollout-.+-([0-9a-f-]{36})\.jsonl$/i;
const MaxSessions = 32;
const MaxIndexEntries = 8192;
const MaxDirectories = 2048;
const MaxFilenames = 50000;
const NegativeRetryMs = 1000;
const IndexRefreshMs = 15000;
const ChunkBytes = 64 * 1024;
const MaxLineBytes = 8 * 1024 * 1024;
const GuardBytes = 256;
const EmptyStats = Object.freeze({
    turns: 0,
    steps: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheHit: 0,
    tps: null,
    tpsHeld: false,
    activeTurn: false,
    modelActiveMs: 0,
});

function createSessionStore({ codexHome, createMetrics } = {})
{
    const makeMetrics = createMetrics || (() => require('./metrics.cjs').createMetrics());
    const roots = typeof codexHome === 'string' && codexHome.length
        ? ['sessions', 'archived_sessions'].map(name => path.join(codexHome, name))
        : [];
    const sessions = new Map();
    let index = new Map();
    let indexAt = -Infinity;
    let indexPending;
    let disposed = false;

    function result(threadId, status, entry)
    {
        const stats = { ...EmptyStats };
        const snapshot = entry && entry.metrics.snapshot();
        for (const key of Object.keys(stats))
        {
            const value = snapshot && snapshot[key];
            if (typeof value === 'number' && Number.isFinite(value) && value >= 0
                || typeof value === 'boolean' || value === null)
            {
                stats[key] = value;
            }
        }
        return { ...stats, status, threadId };
    }

    function reset(entry)
    {
        entry.metrics = makeMetrics();
        entry.offset = 0;
        entry.pending = Buffer.alloc(0);
        entry.skippingLine = false;
        entry.identity = null;
        entry.head = Buffer.alloc(0);
        entry.tail = Buffer.alloc(0);
    }

    async function* entries(directory)
    {
        try
        {
            const handle = await fs.opendir(directory);
            yield* handle;
        }
        catch (error)
        {
            if (error.code === 'ENOENT') return;
            throw error;
        }
    }

    function sessionId(name)
    {
        const match = SessionPattern.exec(name);
        return match && UuidPattern.test(match[1]) ? match[1].toLowerCase() : null;
    }

    async function refreshIndex()
    {
        if (indexPending) return indexPending;
        const now = Date.now();
        if (now >= indexAt && now - indexAt < IndexRefreshMs) return;
        indexPending = (async () =>
        {
            const found = new Map();
            const directories = roots.map(directory => ({ directory, depth: 0 })).reverse();
            let directoryCount = 0;
            let filenameCount = 0;
            while (directories.length && directoryCount < MaxDirectories && filenameCount < MaxFilenames && !disposed)
            {
                const { directory, depth } = directories.pop();
                directoryCount++;
                const subdirectories = [];
                for await (const child of entries(directory))
                {
                    filenameCount++;
                    if (child.isDirectory() && depth < 3
                        && directoryCount + directories.length + subdirectories.length < MaxDirectories)
                    {
                        subdirectories.push({ directory: path.join(directory, child.name), depth: depth + 1 });
                    }
                    else if (child.isFile())
                    {
                        const id = sessionId(child.name);
                        if (id && !found.has(id) && found.size < MaxIndexEntries)
                        {
                            found.set(id, path.join(directory, child.name));
                        }
                    }
                    if (filenameCount >= MaxFilenames || disposed) break;
                }
                subdirectories.sort((a, b) => a.directory.localeCompare(b.directory));
                directories.push(...subdirectories);
            }
            if (!disposed)
            {
                index = found;
                indexAt = Date.now();
            }
        })();
        try
        {
            await indexPending;
        }
        finally
        {
            indexPending = null;
        }
    }

    async function locate(threadId)
    {
        const directories = [...roots];
        if (threadId[14] === '7')
        {
            const timestamp = Number.parseInt(threadId.slice(0, 13).replace('-', ''), 16);
            for (const offset of [0, -1, 1])
            {
                const date = new Date(timestamp + offset * 86400000);
                const parts = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()]
                    .map((value, i) => String(value).padStart(i === 0 ? 4 : 2, '0'));
                for (const root of roots) directories.push(path.join(root, ...parts));
            }
        }
        for (const directory of directories)
        {
            if (disposed) return null;
            let count = 0;
            for await (const child of entries(directory))
            {
                if (child.isFile() && sessionId(child.name) === threadId)
                {
                    return path.join(directory, child.name);
                }
                if (++count >= MaxFilenames || disposed) break;
            }
        }
        await refreshIndex();
        return index.get(threadId) || null;
    }

    function consume(entry, chunk)
    {
        let start = 0;
        while (start < chunk.length)
        {
            const newline = chunk.indexOf(10, start);
            const part = chunk.subarray(start, newline === -1 ? chunk.length : newline);
            if (!entry.skippingLine)
            {
                if (entry.pending.length + part.length > MaxLineBytes)
                {
                    entry.pending = Buffer.alloc(0);
                    entry.skippingLine = true;
                }
                else if (newline === -1)
                {
                    entry.pending = Buffer.concat([entry.pending, part]);
                }
                else
                {
                    const line = entry.pending.length ? Buffer.concat([entry.pending, part]) : part;
                    entry.pending = Buffer.alloc(0);
                    let record;
                    try
                    {
                        record = JSON.parse(line.toString('utf8'));
                    }
                    catch
                    {
                        record = undefined;
                    }
                    if (record !== undefined) entry.metrics.ingest(record);
                }
            }
            if (newline === -1) break;
            entry.skippingLine = false;
            start = newline + 1;
        }
    }

    async function matchesGuard(handle, expected, position)
    {
        if (!expected.length) return true;
        const actual = Buffer.alloc(expected.length);
        const { bytesRead } = await handle.read(actual, 0, actual.length, position);
        return bytesRead === expected.length && actual.equals(expected);
    }

    async function read(entry)
    {
        const handle = await fs.open(entry.path, 'r');
        try
        {
            const stat = await handle.stat();
            if (!stat.isFile()) throw new Error('Invalid session file');
            const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
            if (entry.identity !== null && (entry.identity !== identity || stat.size < entry.offset
                || !await matchesGuard(handle, entry.head, 0)
                || !await matchesGuard(handle, entry.tail, entry.offset - entry.tail.length)))
            {
                reset(entry);
            }
            entry.identity = identity;
            const buffer = Buffer.alloc(ChunkBytes);
            let chunks = 0;
            while (entry.offset < stat.size && !disposed)
            {
                const size = Math.min(buffer.length, stat.size - entry.offset);
                const { bytesRead } = await handle.read(buffer, 0, size, entry.offset);
                if (!bytesRead) break;
                const chunk = buffer.subarray(0, bytesRead);
                if (entry.head.length < GuardBytes)
                {
                    entry.head = Buffer.concat([entry.head, chunk]).subarray(0, GuardBytes);
                }
                entry.tail = Buffer.from(Buffer.concat([entry.tail, chunk]).subarray(-GuardBytes));
                entry.offset += bytesRead;
                consume(entry, chunk);
                if (++chunks % 8 === 0) await new Promise(setImmediate);
            }
        }
        finally
        {
            await handle.close();
        }
    }

    async function poll(entry)
    {
        if (!entry.path)
        {
            const now = Date.now();
            if (now >= entry.lookupAt && now - entry.lookupAt < NegativeRetryMs)
            {
                return result(entry.id, 'not-found');
            }
            entry.lookupAt = Date.now();
            entry.path = await locate(entry.id);
            if (!entry.path) return result(entry.id, 'not-found');
        }
        try
        {
            await read(entry);
        }
        catch (error)
        {
            if (error.code !== 'ENOENT') throw error;
            reset(entry);
            index.delete(entry.id);
            entry.path = await locate(entry.id);
            entry.lookupAt = Date.now();
            if (!entry.path) return result(entry.id, 'not-found');
            await read(entry);
        }
        return result(entry.id, 'ok', entry);
    }

    async function getStats(rawThreadId)
    {
        const threadId = typeof rawThreadId === 'string' && UuidPattern.test(rawThreadId)
            ? rawThreadId.toLowerCase() : null;
        if (disposed || !threadId || !roots.length) return result(threadId, 'unavailable');
        let entry = sessions.get(threadId);
        try
        {
            if (!entry)
            {
                if (sessions.size >= MaxSessions)
                {
                    const idle = [...sessions].find(([, value]) => !value.inFlight);
                    if (!idle) return result(threadId, 'unavailable');
                    sessions.delete(idle[0]);
                }
                entry = { id: threadId, path: null, lookupAt: -Infinity };
                reset(entry);
            }
            sessions.delete(threadId);
            sessions.set(threadId, entry);
            if (entry.inFlight) return entry.inFlight;
            entry.inFlight = poll(entry).then(stats => disposed ? result(threadId, 'unavailable') : stats)
                .catch(() => result(threadId, 'unavailable'))
                .finally(() => { entry.inFlight = null; });
            return entry.inFlight;
        }
        catch
        {
            return result(threadId, 'unavailable');
        }
    }

    function dispose()
    {
        disposed = true;
        sessions.clear();
        index.clear();
    }

    return { getStats, dispose };
}

module.exports = { createSessionStore };

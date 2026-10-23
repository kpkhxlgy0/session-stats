'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const UuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SessionPattern = /^rollout-(.+?)-([0-9a-f-]{36})(?:_([0-9a-f-]{36}))?\.jsonl$/i;
const MaxSessions = 32;
const MaxSources = 32;
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
        entry.sources = (entry.plan || []).map(source => ({ ...source,
            offset: 0, pending: Buffer.alloc(0), skippingLine: false, lines: 0,
            identity: null, head: Buffer.alloc(0), tail: Buffer.alloc(0),
        }));
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
        return match && UuidPattern.test(match[2]) && (!match[3] || UuidPattern.test(match[3]))
            ? match[2].toLowerCase() : null;
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
            let indexedCount = 0;
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
                        if (id && indexedCount < MaxIndexEntries)
                        {
                            if (!found.has(id)) found.set(id, []);
                            found.get(id).push(path.join(directory, child.name));
                            indexedCount++;
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
        await refreshIndex();
        const found = new Set(index.get(threadId) || []);
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
                    found.add(path.join(directory, child.name));
                }
                if (++count >= MaxFilenames || disposed) break;
            }
        }
        // 同名归档副本只读一份，优先仍在 sessions 中的副本。
        const unique = new Map();
        const isArchived = filename => !filename.startsWith(roots[0] + path.sep);
        for (const filename of [...found].sort((a, b) => Number(isArchived(a)) - Number(isArchived(b))))
        {
            try
            {
                if ((await fs.stat(filename)).isFile() && !unique.has(path.basename(filename)))
                {
                    unique.set(path.basename(filename), filename);
                }
            }
            catch (error)
            {
                if (error.code !== 'ENOENT') throw error;
            }
        }
        if (unique.size > MaxSources) throw new Error('Too many rollout sources');
        return [...unique.values()].sort((a, b) =>
        {
            const left = SessionPattern.exec(path.basename(a));
            const right = SessionPattern.exec(path.basename(b));
            return left[1].localeCompare(right[1]) || (left[3] || '').localeCompare(right[3] || '');
        });
    }

    async function metadata(filename, threadId)
    {
        const handle = await fs.open(filename, 'r');
        try
        {
            const chunks = [];
            let offset = 0;
            while (offset < MaxLineBytes)
            {
                const buffer = Buffer.alloc(Math.min(ChunkBytes, MaxLineBytes - offset));
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
                if (!bytesRead) break;
                const newline = buffer.subarray(0, bytesRead).indexOf(10);
                chunks.push(buffer.subarray(0, newline === -1 ? bytesRead : newline));
                offset += bytesRead;
                if (newline === -1) continue;
                let record;
                try { record = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
                catch { break; }
                if (record?.type !== 'session_meta') break;
                const meta = record.payload;
                if (typeof meta?.id !== 'string' || meta.id.toLowerCase() !== threadId
                    || meta.session_id !== undefined && meta.session_id?.toLowerCase?.() !== threadId)
                {
                    throw new Error('Mismatched rollout identity');
                }
                return meta;
            }
            if (SessionPattern.exec(path.basename(filename))[3]) throw new Error('Missing continuation metadata');
            return {};
        }
        finally { await handle.close(); }
    }

    async function matchesBoundary(filename, boundary)
    {
        const handle = await fs.open(filename, 'r');
        try
        {
            if ((await handle.stat()).size < boundary.end_byte_offset) return false;
            const buffer = Buffer.alloc(ChunkBytes);
            let offset = 0;
            let lines = 0;
            let lastByte;
            let chunks = 0;
            while (offset < boundary.end_byte_offset && !disposed)
            {
                const size = Math.min(buffer.length, boundary.end_byte_offset - offset);
                const { bytesRead } = await handle.read(buffer, 0, size, offset);
                if (!bytesRead) return false;
                for (let i = 0; i < bytesRead; i++) if (buffer[i] === 10) lines++;
                offset += bytesRead;
                lastByte = buffer[bytesRead - 1];
                if (lines > boundary.end_ordinal_exclusive) return false;
                if (++chunks % 8 === 0) await new Promise(setImmediate);
            }
            return offset === boundary.end_byte_offset && lastByte === 10
                && lines === boundary.end_ordinal_exclusive;
        }
        finally { await handle.close(); }
    }

    async function makePlan(filenames, threadId)
    {
        async function resolve(filename, limit = null, ordinal = null)
        {
            const meta = await metadata(filename, threadId);
            const source = { path: filename, limit, ordinal };
            const boundary = meta.history_base;
            if (boundary === undefined || boundary === null) return [source];
            if (boundary.thread_id?.toLowerCase?.() !== threadId
                || !Number.isSafeInteger(boundary.end_byte_offset) || boundary.end_byte_offset < 0
                || !Number.isSafeInteger(boundary.end_ordinal_exclusive) || boundary.end_ordinal_exclusive < 0)
            {
                throw new Error('Invalid history boundary');
            }
            if (boundary.end_byte_offset === 0 && boundary.end_ordinal_exclusive === 0) return [source];
            const matches = [];
            // 只接受字节和记录边界均吻合的唯一历史源，不推测续接链。
            for (const previous of filenames.slice(0, filenames.indexOf(filename)))
            {
                if (await matchesBoundary(previous, boundary)) matches.push(previous);
            }
            if (matches.length !== 1) throw new Error('Missing or ambiguous history source');
            return [...await resolve(matches[0], boundary.end_byte_offset, boundary.end_ordinal_exclusive), source];
        }
        return filenames.length ? resolve(filenames[filenames.length - 1]) : [];
    }

    function consume(entry, chunk, metrics)
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
                    if (record !== undefined) metrics.ingest(record);
                }
            }
            if (newline === -1) break;
            entry.lines++;
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

    async function readSource(source, handle, size, metrics)
    {
        const buffer = Buffer.alloc(ChunkBytes);
        let chunks = 0;
        while (source.offset < size && !disposed)
        {
            const length = Math.min(buffer.length, size - source.offset);
            const { bytesRead } = await handle.read(buffer, 0, length, source.offset);
            if (!bytesRead) throw new Error('Rollout changed while reading');
            const chunk = buffer.subarray(0, bytesRead);
            if (source.head.length < GuardBytes)
            {
                source.head = Buffer.concat([source.head, chunk]).subarray(0, GuardBytes);
            }
            source.tail = Buffer.from(Buffer.concat([source.tail, chunk]).subarray(-GuardBytes));
            source.offset += bytesRead;
            consume(source, chunk, metrics);
            if (++chunks % 8 === 0) await new Promise(setImmediate);
        }
        if (source.limit !== null && (source.lines !== source.ordinal || source.pending.length || source.skippingLine))
        {
            throw new Error('History boundary changed');
        }
    }

    async function read(entry)
    {
        const files = [];
        try
        {
            let changed = false;
            for (const source of entry.sources)
            {
                const handle = await fs.open(source.path, 'r');
                files.push({ handle });
                const stat = await handle.stat();
                if (!stat.isFile() || source.limit !== null && stat.size < source.limit)
                {
                    throw new Error('Invalid session file');
                }
                const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
                const size = source.limit ?? stat.size;
                Object.assign(files[files.length - 1], { size, identity });
                if (source.identity !== null && (source.identity !== identity || size < source.offset
                    || !await matchesGuard(handle, source.head, 0)
                    || !await matchesGuard(handle, source.tail, source.offset - source.tail.length))) changed = true;
            }
            if (changed)
            {
                entry.lookupAt = -Infinity;
                throw new Error('Rollout sources changed');
            }
            for (let i = 0; i < files.length; i++)
            {
                const { handle, size, identity } = files[i];
                entry.sources[i].identity = identity;
                await readSource(entry.sources[i], handle, size, entry.metrics);
            }
        }
        finally
        {
            await Promise.all(files.map(file => file.handle.close()));
        }
    }

    async function poll(entry)
    {
        const now = Date.now();
        const retryMs = entry.plan?.length ? IndexRefreshMs : NegativeRetryMs;
        if (now < entry.lookupAt || now - entry.lookupAt >= retryMs)
        {
            const filenames = await locate(entry.id);
            const key = JSON.stringify(filenames);
            if (key !== entry.filesKey || !entry.plan?.length || entry.lookupAt === -Infinity)
            {
                entry.plan = await makePlan(filenames, entry.id);
                entry.filesKey = key;
                reset(entry);
            }
            entry.lookupAt = now;
        }
        if (!entry.plan?.length) return result(entry.id, 'not-found');
        try
        {
            await read(entry);
        }
        catch (error)
        {
            const changed = entry.lookupAt === -Infinity;
            reset(entry);
            if (!changed && error.code !== 'ENOENT') throw error;
            index.delete(entry.id);
            indexAt = -Infinity;
            const filenames = await locate(entry.id);
            entry.plan = await makePlan(filenames, entry.id);
            entry.filesKey = JSON.stringify(filenames);
            reset(entry);
            entry.lookupAt = Date.now();
            if (!entry.plan.length) return result(entry.id, 'not-found');
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
                entry = { id: threadId, lookupAt: -Infinity };
                reset(entry);
            }
            sessions.delete(threadId);
            sessions.set(threadId, entry);
            if (entry.inFlight) return entry.inFlight;
            entry.inFlight = poll(entry).then(stats => disposed ? result(threadId, 'unavailable') : stats)
                .catch(() =>
                {
                    entry.lookupAt = -Infinity;
                    reset(entry);
                    return result(threadId, 'unavailable');
                })
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

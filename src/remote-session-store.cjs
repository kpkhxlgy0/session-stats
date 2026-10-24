'use strict';

const path = require('node:path');
const { createSessionStore } = require('./session-store.cjs');
const { createMetrics } = require('./metrics.cjs');

const UuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SessionPattern = /^rollout-(.+?)-([0-9a-f-]{36})(?:_([0-9a-f-]{36}))?\.jsonl$/i;
const MaxSessions = 32;
const PollMs = 15000;
const LargePollMs = 60000;
const LargeFileBytes = 4 * 1024 * 1024;
const MaxFileBytes = 128 * 1024 * 1024;
const MaxHistoryBytes = 256 * 1024 * 1024;
const MaxDirectories = 2048;
const MaxFilenames = 50000;
const MaxSources = 32;
const MaxCachedFiles = MaxSessions * MaxSources;
const MetadataConcurrency = 8;
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

function sessionId(name)
{
    const match = SessionPattern.exec(name);
    return match && validThreadId(match[2]) && (!match[3] || validThreadId(match[3]))
        ? match[2].toLowerCase() : null;
}

function pathContext(value, threadId)
{
    if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return null;
    const pathApi = /^[a-z]:[\\/]|^\\\\/i.test(value) ? path.win32 : path.posix;
    if (!pathApi.isAbsolute(value) || pathApi === path.posix && value.includes('\\')) return null;
    const parts = value.split(/[\\/]/);
    if (parts.some(part => part === '.' || part === '..')) return null;
    if (pathApi === path.win32 && parts.some((part, index) => /[. ]$/.test(part)
        || /[<>"|*]/.test(part) || part.includes(':') && !/^[a-z]:$/i.test(part)
        || part.includes('?') && !(index === 2 && part === '?'))) return null;
    const filename = pathApi.normalize(value);
    if (sessionId(pathApi.basename(filename)) !== threadId) return null;
    let directory = pathApi.dirname(filename);
    while (directory !== pathApi.dirname(directory))
    {
        if (/^(sessions|archived_sessions)$/i.test(pathApi.basename(directory)))
        {
            const codexHome = pathApi.dirname(directory);
            return { pathApi, filename, codexHome, roots: ['sessions', 'archived_sessions']
                .map(name => pathApi.join(codexHome, name)) };
        }
        directory = pathApi.dirname(directory);
    }
    // Older hosts can return a standalone ordinary rollout outside the usual layout.
    return { pathApi, filename, codexHome: pathApi.dirname(filename), roots: null };
}

function metadataKey(metadata, directory = false)
{
    if (!metadata || metadata.isFile !== !directory || metadata.isDirectory !== directory || metadata.isSymlink !== false
        || !Number.isFinite(metadata.createdAtMs) || metadata.createdAtMs < 0
        || !Number.isFinite(metadata.modifiedAtMs) || metadata.modifiedAtMs < 0) return null;
    return `${metadata.createdAtMs}:${metadata.modifiedAtMs}`;
}

function decodeFile(value, remainingBytes, maxFileBytes)
{
    if (typeof value !== 'string' || value.length % 4 !== 0) throw new Error('Invalid remote file');
    const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
    const size = value.length / 4 * 3 - padding;
    if (size > maxFileBytes) throw Object.assign(new Error('Remote log is too large'),
        { code: 'SESSION_STATS_LOG_TOO_LARGE' });
    if (size > remainingBytes) throw new Error('Remote history is too large');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('Invalid remote file');
    const bytes = Buffer.from(value, 'base64');
    if (bytes.toString('base64') !== value) throw new Error('Invalid remote file');
    return bytes;
}

function needsHistory(bytes, threadId)
{
    const newline = bytes.indexOf(10);
    if (newline < 0 || newline > MaxLineBytes) return false;
    let head;
    try { head = JSON.parse(bytes.toString('utf8', 0, newline)); }
    catch { return false; }
    const meta = head?.type === 'session_meta' ? head.payload : null;
    const boundary = meta?.history_base;
    if (boundary === undefined || boundary === null) return false;
    if (validThreadId(meta.forked_from_id) && meta.forked_from_id.toLowerCase() !== threadId
        && meta.forked_from_ordinal_exclusive === boundary.end_ordinal_exclusive) return false;
    return boundary.end_byte_offset !== 0 || boundary.end_ordinal_exclusive !== 0;
}

function createRemoteSessionStore({ now = Date.now, maxFileBytes = MaxFileBytes, maxHistoryBytes = MaxHistoryBytes } = {})
{
    if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0 || maxFileBytes > MaxFileBytes
        || !Number.isSafeInteger(maxHistoryBytes) || maxHistoryBytes <= 0 || maxHistoryBytes > MaxHistoryBytes)
        throw new RangeError('Invalid remote memory budget');
    const sessions = new Map();
    const rawCache = new Map();
    const directoryCache = new Map();
    let retainedBytes = 0;
    let retainedNames = 0;
    let queue = Promise.resolve();
    let disposed = false;

    function removeRaw(key)
    {
        const record = rawCache.get(key);
        if (record?.bytes) retainedBytes -= record.bytes.length;
        rawCache.delete(key);
    }

    function removeDirectory(key)
    {
        retainedNames -= directoryCache.get(key)?.entries.length || 0;
        directoryCache.delete(key);
    }

    async function poll(entry, request, isCurrent)
    {
        const observed = new Map();
        const loaded = new Map();
        const pinned = new Set();
        const pending = new Set();
        let totalBytes = 0;
        let reader;
        let accepted = false;
        let discoveryRoots;
        const check = () => { if (!isCurrent()) throw new Error('Remote read cancelled'); };
        async function call(method, params)
        {
            check();
            const response = await request(method, params);
            check();
            return response;
        }
        const response = await call('thread/read', { threadId: entry.threadId, includeTurns: false });
        if (validThreadId(response?.thread?.id) !== entry.threadId) return;
        const context = pathContext(response.thread.path, entry.threadId);
        if (!context) return;
        const { pathApi, filename, codexHome, roots } = context;
        const canonical = value => pathApi === path.win32 ? value.toLowerCase() : value;
        const cacheKey = value => JSON.stringify([entry.hostId, canonical(value)]);
        const insideRoot = value => roots?.some(root =>
        {
            const relative = pathApi.relative(root, value);
            return relative !== '' && !pathApi.isAbsolute(relative) && relative !== '..'
                && !relative.startsWith('..' + pathApi.sep);
        });
        async function inspect(value, directory = false)
        {
            if (observed.has(value)) return observed.get(value);
            const metadata = await call('fs/getMetadata', { path: value });
            const key = metadataKey(metadata, directory);
            if (key === null) throw new Error('Invalid remote metadata');
            const item = { key, directory, metadata };
            observed.set(value, item);
            return item;
        }
        async function metadataChecks(values, work)
        {
            for (let offset = 0; offset < values.length; offset += MetadataConcurrency)
            {
                check();
                // Drain every started request before propagating errors or releasing the serialized poll queue.
                const settled = await Promise.allSettled(values.slice(offset, offset + MetadataConcurrency)
                    .map(async value => work(value)));
                const failed = settled.find(item => item.status === 'rejected');
                if (failed) throw failed.reason;
            }
        }
        function validateEntries(entries)
        {
            if (!Array.isArray(entries) || entries.length > MaxFilenames) throw new Error('Invalid remote directory');
            const names = new Set();
            for (const child of entries)
            {
                if (typeof child?.fileName !== 'string' || !child.fileName.length
                    || /[\\/\u0000-\u001f\u007f-\u009f]/.test(child.fileName)
                    || child.fileName === '.' || child.fileName === '..'
                    || pathApi === path.win32 && (/[. ]$|[<>:"|?*]/.test(child.fileName))
                    || typeof child.isDirectory !== 'boolean' || typeof child.isFile !== 'boolean'
                    || child.isDirectory === child.isFile || names.has(canonical(child.fileName)))
                    throw new Error('Invalid remote directory entry');
                names.add(canonical(child.fileName));
            }
            return entries;
        }
        async function availableRoots()
        {
            // Native RPC errors omit filesystem codes. Discover optional roots by name instead of guessing from an error.
            const response = await call('fs/readDirectory', { path: codexHome });
            if (!Array.isArray(response?.entries) || response.entries.length > MaxFilenames)
                throw new Error('Invalid remote directory');
            const entries = validateEntries(response.entries.filter(child => typeof child?.fileName === 'string'
                && roots.some(root => canonical(child.fileName) === canonical(pathApi.basename(root)))));
            if (entries.some(child => roots.some(root => canonical(child.fileName) === canonical(pathApi.basename(root)))
                && !child.isDirectory)) throw new Error('Invalid remote history root');
            const found = roots.filter(root => entries.some(child =>
                canonical(child.fileName) === canonical(pathApi.basename(root)) && child.isDirectory));
            if (!found.some(root =>
            {
                const relative = pathApi.relative(root, filename);
                return !pathApi.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + pathApi.sep);
            })) throw new Error('Remote session root is missing');
            return found;
        }
        async function inspectParents(value)
        {
            const root = roots?.find(root =>
            {
                const relative = pathApi.relative(root, value);
                return !pathApi.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + pathApi.sep);
            }) ?? (value === filename && !roots ? codexHome : null);
            if (!root) throw new Error('Invalid remote source root');
            const relative = pathApi.relative(root, pathApi.dirname(value));
            const parts = relative ? relative.split(pathApi.sep) : [];
            if (parts.length >= MaxDirectories) throw new Error('Remote path is too deep');
            let directory = root;
            await inspect(directory, true);
            for (const part of parts)
            {
                directory = pathApi.join(directory, part);
                await inspect(directory, true);
            }
        }
        function retain(key, record)
        {
            removeRaw(key);
            const size = record.bytes?.length || 0;
            for (const [oldKey] of rawCache)
            {
                if (retainedBytes + size <= maxHistoryBytes && rawCache.size < MaxCachedFiles) break;
                if (!pinned.has(oldKey)) removeRaw(oldKey);
            }
            if (retainedBytes + size > maxHistoryBytes || rawCache.size >= MaxCachedFiles)
                throw new Error('Remote cache is too large');
            rawCache.set(key, record);
            retainedBytes += size;
        }
        async function load(value)
        {
            check();
            if (loaded.has(value)) return loaded.get(value);
            if (value !== filename && (!insideRoot(value) || sessionId(pathApi.basename(value)) !== entry.threadId))
                throw new Error('Invalid remote source');
            await inspectParents(value);
            const metadata = await inspect(value);
            const key = cacheKey(value);
            pinned.add(key);
            let record = rawCache.get(key);
            if (record?.key !== metadata.key)
            {
                removeRaw(key);
                record = null;
            }
            if (!record)
            {
                let bytes;
                try
                {
                    const file = await call('fs/readFile', { path: value });
                    bytes = decodeFile(file?.dataBase64, maxHistoryBytes - totalBytes, maxFileBytes);
                }
                catch (error)
                {
                    if (error.code === 'SESSION_STATS_LOG_TOO_LARGE')
                    {
                        entry.bytes = maxFileBytes + 1;
                        retain(key, { key: metadata.key, oversized: true });
                    }
                    throw error;
                }
                record = { key: metadata.key, bytes };
                retain(key, record);
                pending.add(key);
            }
            else
            {
                rawCache.delete(key);
                rawCache.set(key, record);
            }
            if (record.oversized)
            {
                entry.bytes = maxFileBytes + 1;
                throw new Error('Remote log is too large');
            }
            totalBytes += record.bytes.length;
            entry.bytes = Math.max(entry.bytes, totalBytes);
            if (totalBytes > maxHistoryBytes) throw new Error('Remote history is too large');
            loaded.set(value, record);
            return record;
        }
        async function discover()
        {
            if (!roots) throw new Error('Remote history root is unavailable');
            const found = new Set([filename]);
            discoveryRoots = await availableRoots();
            const directories = discoveryRoots.map(value => ({ value, depth: 0 }));
            let directoryCount = 0;
            let filenameCount = 0;
            while (directories.length)
            {
                check();
                const batch = directories.splice(0, MetadataConcurrency);
                directoryCount += batch.length;
                if (directoryCount > MaxDirectories) throw new Error('Remote discovery is too large');
                await metadataChecks(batch, item => inspect(item.value, true));
                for (const { value, depth } of batch)
                {
                    const metadata = observed.get(value);
                    const key = cacheKey(value);
                    let cached = directoryCache.get(key);
                    if (cached?.key !== metadata.key)
                    {
                        const response = await call('fs/readDirectory', { path: value });
                        const entries = validateEntries(response?.entries);
                        cached = { key: metadata.key, entries };
                        removeDirectory(key);
                        while (directoryCache.size >= MaxDirectories || retainedNames + entries.length > MaxFilenames)
                            removeDirectory(directoryCache.keys().next().value);
                        directoryCache.set(key, cached);
                        retainedNames += entries.length;
                    }
                    else
                    {
                        directoryCache.delete(key);
                        directoryCache.set(key, cached);
                    }
                    for (const child of cached.entries)
                    {
                        if (++filenameCount > MaxFilenames) throw new Error('Remote discovery is too large');
                        const childPath = pathApi.join(value, child.fileName);
                        if (!insideRoot(childPath)) throw new Error('Remote path escaped its root');
                        if (child.isDirectory)
                        {
                            if (depth >= 3 || directoryCount + directories.length >= MaxDirectories)
                                throw new Error('Remote discovery is too deep');
                            directories.push({ value: childPath, depth: depth + 1 });
                        }
                        else if (sessionId(child.fileName) === entry.threadId) found.add(childPath);
                    }
                    // Include archived copies for the shared reader's active-copy precedence.
                    if (new Set([...found].map(value => canonical(pathApi.basename(value)))).size > MaxSources)
                        throw new Error('Too many remote sources');
                }
            }
            return [...found];
        }
        async function verify(historyBytes = totalBytes)
        {
            const original = loaded.get(filename).bytes;
            const sameLatestIdentity = metadata => metadataKey(metadata) !== null
                && metadata.createdAtMs === observed.get(filename).metadata.createdAtMs;
            let latestChanged = false;
            await metadataChecks([...observed], async ([value, expected]) =>
            {
                const metadata = await call('fs/getMetadata', { path: value });
                if (metadataKey(metadata, expected.directory) !== expected.key)
                {
                    if (value !== filename || !sameLatestIdentity(metadata))
                        throw new Error('Remote file changed while reading');
                    latestChanged = true;
                }
            });
            if (latestChanged)
            {
                // Keep the parsed bytes and their original cache key. A later poll must fetch the new tail.
                const file = await call('fs/readFile', { path: filename });
                const confirmation = decodeFile(file?.dataBase64, maxHistoryBytes - historyBytes + original.length, maxFileBytes);
                if (confirmation.length <= original.length || !confirmation.subarray(0, original.length).equals(original))
                    throw new Error('Remote latest file was rewritten or truncated');
                // The captured prefix proves this snapshot; later writes cannot change that historical observation.
                const anchors = [...observed].filter(([value, item]) =>
                {
                    if (value === filename) return true;
                    if (!item.directory) return false;
                    const relative = pathApi.relative(value, pathApi.dirname(filename));
                    return !pathApi.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + pathApi.sep);
                });
                await metadataChecks(anchors, async ([value, expected]) =>
                {
                    const metadata = await call('fs/getMetadata', { path: value });
                    if (value === filename ? !sameLatestIdentity(metadata) : metadataKey(metadata, true) !== expected.key)
                        throw new Error('Remote append source changed while reading');
                });
            }
            if (discoveryRoots && JSON.stringify(await availableRoots()) !== JSON.stringify(discoveryRoots))
                throw new Error('Remote history roots changed while reading');
            const latest = await call('thread/read', { threadId: entry.threadId, includeTurns: false });
            if (validThreadId(latest?.thread?.id) !== entry.threadId
                || canonical(latest?.thread?.path || '') !== canonical(response.thread.path))
                throw new Error('Remote session changed while reading');
        }
        try
        {
            const latest = await load(filename);
            const filenames = needsHistory(latest.bytes, entry.threadId) ? await discover() : [filename];
            // Check every candidate before reusing a completed snapshot.
            await metadataChecks(filenames, source => inspect(source));
            const fingerprints = [...observed].map(([value, item]) => [value, item.key])
                .sort(([left], [right]) => canonical(left).localeCompare(canonical(right)) || left.localeCompare(right));
            const signature = JSON.stringify([filename, filenames, fingerprints]);
            if (entry.signature === signature && entry.snapshot)
            {
                await verify(entry.bytes);
                entry.status = 'ok';
                accepted = true;
                return;
            }
            const fileSystem = {
                async stat(value)
                {
                    const metadata = await inspect(value);
                    return { isFile: () => true, size: loaded.get(value)?.bytes.length ?? 0, dev: 0, ino: cacheKey(value),
                        birthtimeMs: metadata.metadata.createdAtMs };
                },
                async open(value, mode)
                {
                    if (mode !== 'r') throw new Error('Remote filesystem is read only');
                    const record = await load(value);
                    return {
                        stat: () => fileSystem.stat(value),
                        async read(buffer, offset, length, position)
                        {
                            check();
                            const bytesRead = record.bytes.copy(buffer, offset, position, Math.min(position + length, record.bytes.length));
                            return { bytesRead, buffer };
                        },
                        async close() {},
                    };
                },
            };
            reader = createSessionStore({ codexHome, fileSystem, pathApi, findSources: () => filenames,
                validateRecord(record)
                {
                    check();
                    if (record?.type !== 'session_meta') return true;
                    return validThreadId(record.payload?.id) === entry.threadId
                        && (record.payload.session_id === undefined || validThreadId(record.payload.session_id) === entry.threadId);
                } });
            const snapshot = await reader.getStats(entry.threadId);
            if (snapshot.status !== 'ok') return;
            await verify();
            entry.snapshot = snapshot;
            entry.signature = signature;
            entry.bytes = totalBytes;
            entry.status = 'ok';
            accepted = true;
        }
        finally
        {
            reader?.dispose();
            if (!accepted) for (const key of pending) removeRaw(key);
        }
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
        // Native whole-file reads are serialized to bound raw/encoded allocations.
        const running = queue.then(() => { if (isCurrent()) return poll(entry, request, isCurrent); });
        queue = running.catch(() => {});
        entry.inFlight = running.catch(() => {})
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
        rawCache.clear();
        directoryCache.clear();
        retainedBytes = 0;
        retainedNames = 0;
    }

    return { getStats, dispose };
}

module.exports = { createRemoteSessionStore };

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createRolloutReader } = require('./rollout-reader.cjs');

const UuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SessionPattern = /^rollout-(.+?)-([0-9a-f-]{36})(?:_([0-9a-f-]{36}))?\.jsonl(?:\.zst)?$/i;
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
const MaxValidationEntries = MaxSessions * MaxSources;
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

function createSessionStore({ codexHome, createMetrics, fileSystem = fs, pathApi = path,
    findSources, validateRecord } = {})
{
    const makeMetrics = createMetrics || (options => require('./metrics.cjs').createMetrics(options));
    const reader = createRolloutReader({ fileSystem });
    const roots = typeof codexHome === 'string' && codexHome.length
        ? ['sessions', 'archived_sessions'].map(name => pathApi.join(codexHome, name))
        : [];
    const sessions = new Map();
    let index = new Map();
    let indexAt = -Infinity;
    let indexPending;
    let disposed = false;
    const metadataCache = new Map();
    const boundaryCache = new Map();

    function remember(cache, key, value)
    {
        cache.delete(key);
        if (cache.size >= MaxValidationEntries) cache.delete(cache.keys().next().value);
        cache.set(key, value);
        return value;
    }

    function fileVersion(stat)
    {
        return sourceIdentity(stat, true);
    }

    function compressed(filename) { return /\.zst$/i.test(filename); }

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
        if (entry?.plan?.some(source => source.postFork))
        {
            const inherited = entry.tpsMetrics?.snapshot();
            stats.tps = inherited?.tps ?? null;
            stats.modelActiveMs = inherited?.modelActiveMs ?? null;
            stats.tpsHeld = Boolean(stats.tps !== null && stats.activeTurn
                && (snapshot.tpsHeld || snapshot.tps === null));
        }
        return { ...stats, status, threadId };
    }

    function reset(entry)
    {
        entry.metrics = makeMetrics({ responseTotals: Boolean(entry.plan?.some(source => source.postFork)) });
        entry.tpsMetrics = Array.isArray(entry.inheritedPlan) ? makeMetrics() : null;
        const initialize = source => ({ ...source,
            offset: 0, pending: Buffer.alloc(0), skippingLine: false, lines: 0,
            identity: null, head: Buffer.alloc(0), tail: Buffer.alloc(0),
        });
        entry.sources = (entry.plan || []).map(initialize);
        entry.inheritedSources = (entry.inheritedPlan || []).map(initialize);
    }

    async function* entries(directory)
    {
        try
        {
            const handle = await fileSystem.opendir(directory);
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
                        subdirectories.push({ directory: pathApi.join(directory, child.name), depth: depth + 1 });
                    }
                    else if (child.isFile())
                    {
                        const id = sessionId(child.name);
                        if (id && indexedCount < MaxIndexEntries)
                        {
                            if (!found.has(id)) found.set(id, []);
                            found.get(id).push(pathApi.join(directory, child.name));
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

    async function locateLocal(threadId)
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
                for (const root of roots) directories.push(pathApi.join(root, ...parts));
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
                    found.add(pathApi.join(directory, child.name));
                }
                if (++count >= MaxFilenames || disposed) break;
            }
        }
        return found;
    }

    async function locate(threadId, inherited = false)
    {
        const found = new Set(findSources ? await findSources(threadId) : await locateLocal(threadId));
        const candidates = [...found].filter(filename => typeof filename === 'string'
            && sessionId(pathApi.basename(filename)) === threadId
            && (!inherited || roots.some(root =>
            {
                const relative = pathApi.relative(root, filename);
                return relative && relative !== '..' && !relative.startsWith('..' + pathApi.sep)
                    && !pathApi.isAbsolute(relative);
            })));
        // 同一逻辑分段只读一份，先选原始 JSONL，再选仍在 sessions 中的副本。
        const unique = new Map();
        const isArchived = filename => !filename.startsWith(roots[0] + pathApi.sep);
        const isCompressed = filename => /\.zst$/i.test(filename);
        for (const filename of candidates.sort((a, b) => Number(isCompressed(a)) - Number(isCompressed(b))
            || Number(isArchived(a)) - Number(isArchived(b))))
        {
            try
            {
                const name = pathApi.basename(filename).replace(/\.zst$/i, '');
                if ((await fileSystem.stat(filename)).isFile() && !unique.has(name))
                {
                    unique.set(name, filename);
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
            const left = SessionPattern.exec(pathApi.basename(a));
            const right = SessionPattern.exec(pathApi.basename(b));
            return left[1].localeCompare(right[1]) || (left[3] || '').localeCompare(right[3] || '');
        });
    }

    async function metadata(filename, threadId, limit = MaxLineBytes)
    {
        const isCompressed = compressed(filename);
        let version;
        if (isCompressed)
        {
            version = fileVersion(await fileSystem.stat(filename));
            const cached = metadataCache.get(filename);
            if (cached?.version === version && cached.threadId === threadId && cached.limit <= limit)
                return cached.head;
        }
        const chunks = [];
        let lineBytes = 0;
        let complete = false;
        function accept(chunk)
        {
            const newline = chunk.indexOf(10);
            const part = chunk.subarray(0, newline === -1 ? chunk.length : newline);
            chunks.push(part);
            lineBytes += part.length;
            complete = newline !== -1;
            return !complete;
        }
        if (isCompressed)
        {
            const scanned = await reader.scan(filename, { limit: Math.min(limit, MaxLineBytes), onChunk: accept });
            if (fileVersion(scanned.stat) !== version) throw new Error('Rollout metadata changed');
        }
        else
        {
            const handle = await fileSystem.open(filename, 'r');
            try
            {
                while (lineBytes < MaxLineBytes && !complete)
                {
                    const buffer = Buffer.alloc(Math.min(ChunkBytes, MaxLineBytes - lineBytes));
                    const { bytesRead } = await handle.read(buffer, 0, buffer.length, lineBytes);
                    if (!bytesRead) break;
                    accept(buffer.subarray(0, bytesRead));
                }
            }
            finally { await handle.close(); }
        }
        let record;
        if (complete)
        {
            try { record = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
            catch { /* 普通旧日志可以没有元数据，续接文件仍须验证。 */ }
        }
        let head = { payload: {}, startOrdinal: 0, hasOrdinal: false };
        if (record?.type === 'session_meta')
        {
            const meta = record.payload;
            if (typeof meta?.id !== 'string' || meta.id.toLowerCase() !== threadId)
                throw new Error('Mismatched rollout identity');
            if (meta.session_id !== undefined && meta.session_id?.toLowerCase?.() !== threadId)
            {
                // 原生子线程的 session_id 是根会话，parent_thread_id 则是直接父线程。
                const sessionId = typeof meta.session_id === 'string' && UuidPattern.test(meta.session_id)
                    ? meta.session_id.toLowerCase() : null;
                const parentId = typeof meta.parent_thread_id === 'string' && UuidPattern.test(meta.parent_thread_id)
                    ? meta.parent_thread_id.toLowerCase() : null;
                const spawn = meta.source?.subagent?.thread_spawn;
                if (meta.thread_source !== 'subagent' || !sessionId || !parentId || parentId === threadId
                    || spawn?.parent_thread_id?.toLowerCase?.() !== parentId
                    || !Number.isSafeInteger(spawn?.depth) || spawn.depth < 1
                    || (spawn.depth === 1) !== (sessionId === parentId))
                    throw new Error('Mismatched rollout identity');
            }
            if (record.ordinal !== undefined && (!Number.isSafeInteger(record.ordinal) || record.ordinal < 0))
                throw new Error('Invalid rollout ordinal');
            // 只保留解析链所需的标量，不能把元数据中的指令/聊天内容放进缓存。
            const uuid = value => typeof value === 'string' && UuidPattern.test(value) ? value : undefined;
            const integer = value => Number.isSafeInteger(value) ? value : undefined;
            const boundary = meta.history_base;
            head = { payload: { id: meta.id, session_id: meta.session_id,
                forked_from_id: uuid(meta.forked_from_id),
                forked_from_ordinal_exclusive: integer(meta.forked_from_ordinal_exclusive),
                history_base: boundary === undefined || boundary === null ? boundary : {
                    thread_id: uuid(boundary.thread_id), end_byte_offset: integer(boundary.end_byte_offset),
                    end_ordinal_exclusive: integer(boundary.end_ordinal_exclusive),
                } }, startOrdinal: record.ordinal ?? 0, hasOrdinal: record.ordinal !== undefined };
        }
        else if (SessionPattern.exec(pathApi.basename(filename))[3]) throw new Error('Missing continuation metadata');
        if (isCompressed && complete)
            remember(metadataCache, filename, { version, threadId, head, limit: lineBytes + 1 });
        return head;
    }

    async function matchesBoundary(filename, boundary, startOrdinal)
    {
        if (compressed(filename))
        {
            const key = JSON.stringify([filename, boundary.end_byte_offset, boundary.end_ordinal_exclusive, startOrdinal]);
            const version = fileVersion(await fileSystem.stat(filename));
            const cached = boundaryCache.get(key);
            if (cached?.version === version) return cached.matches;
            let lines = 0;
            let lastByte;
            const scanned = await reader.scan(filename, { limit: boundary.end_byte_offset, onChunk(chunk)
            {
                for (let i = 0; i < chunk.length; i++) if (chunk[i] === 10) lines++;
                lastByte = chunk[chunk.length - 1];
                return lines <= boundary.end_ordinal_exclusive - startOrdinal;
            } });
            if (fileVersion(scanned.stat) !== version) throw new Error('Rollout boundary changed');
            const matches = scanned.bytesRead === boundary.end_byte_offset
                && (boundary.end_byte_offset === 0 || lastByte === 10)
                && lines === boundary.end_ordinal_exclusive - startOrdinal;
            remember(boundaryCache, key, { version, matches });
            return matches;
        }
        const handle = await fileSystem.open(filename, 'r');
        try
        {
            if ((await handle.stat()).size < boundary.end_byte_offset) return false;
            if (boundary.end_byte_offset === 0) return boundary.end_ordinal_exclusive === startOrdinal;
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
                if (lines > boundary.end_ordinal_exclusive - startOrdinal) return false;
                if (++chunks % 8 === 0) await new Promise(setImmediate);
            }
            return offset === boundary.end_byte_offset && lastByte === 10
                && lines === boundary.end_ordinal_exclusive - startOrdinal;
        }
        finally { await handle.close(); }
    }

    async function makePlan(filenames, threadId)
    {
        async function resolve(filename, limit = null, ordinal = null)
        {
            const head = await metadata(filename, threadId);
            const meta = head.payload;
            const source = { path: filename, limit, ordinal: ordinal === null ? null : ordinal - head.startOrdinal };
            const boundary = meta.history_base;
            if (boundary === undefined || boundary === null) return [source];
            if (!UuidPattern.test(boundary.thread_id ?? '')
                || !Number.isSafeInteger(boundary.end_byte_offset) || boundary.end_byte_offset < 0
                || !Number.isSafeInteger(boundary.end_ordinal_exclusive) || boundary.end_ordinal_exclusive < 0
                || head.hasOrdinal && head.startOrdinal !== boundary.end_ordinal_exclusive)
            {
                throw new Error('Invalid history boundary');
            }
            if (UuidPattern.test(meta.forked_from_id ?? '') && meta.forked_from_id.toLowerCase() !== threadId
                && meta.forked_from_ordinal_exclusive === boundary.end_ordinal_exclusive)
            {
                source.postFork = true;
                source.fork = { parentId: meta.forked_from_id.toLowerCase(), boundary };
                return [source];
            }
            if (boundary.end_byte_offset === 0 && boundary.end_ordinal_exclusive === 0) return [source];
            const matches = [];
            // 分支计数只续接当前会话自己的分段；父历史单独进入 TPS 累计器。
            for (const previous of filenames.slice(0, filenames.indexOf(filename)))
            {
                const segmentId = SessionPattern.exec(pathApi.basename(previous))[3];
                if (boundary.thread_id.toLowerCase() !== threadId
                    && segmentId?.toLowerCase() !== boundary.thread_id.toLowerCase()) continue;
                const previousHead = await metadata(previous, threadId);
                if (await matchesBoundary(previous, boundary, previousHead.startOrdinal)) matches.push(previous);
            }
            if (matches.length !== 1) throw new Error('Missing or ambiguous history source');
            return [...await resolve(matches[0], boundary.end_byte_offset, boundary.end_ordinal_exclusive), source];
        }
        return filenames.length ? resolve(filenames[filenames.length - 1]) : [];
    }

    async function makeInheritedPlan(plan)
    {
        const fork = plan.find(source => source.postFork)?.fork;
        if (!fork) return undefined;
        const visited = new Set(plan.map(source => source.path));
        const parents = new Map();

        async function parentFiles(id)
        {
            if (!parents.has(id)) parents.set(id, await locate(id, true));
            return parents.get(id);
        }

        async function resolveBoundary(id, boundary, filenames)
        {
            const matches = [];
            for (const filename of filenames)
            {
                const segment = SessionPattern.exec(pathApi.basename(filename))[3];
                if (boundary.thread_id.toLowerCase() !== id
                    && segment?.toLowerCase() !== boundary.thread_id.toLowerCase()) continue;
                const head = await metadata(filename, id,
                    boundary.end_byte_offset ? Math.min(MaxLineBytes, boundary.end_byte_offset) : MaxLineBytes);
                if (await matchesBoundary(filename, boundary, head.startOrdinal)) matches.push({ filename, head });
            }
            if (matches.length !== 1) throw new Error('Missing or ambiguous inherited source');
            const { filename, head } = matches[0];
            if (visited.has(filename) || visited.size >= MaxSources) throw new Error('Invalid inherited chain');
            visited.add(filename);
            const source = { path: filename, limit: boundary.end_byte_offset,
                ordinal: boundary.end_ordinal_exclusive - head.startOrdinal };
            const meta = head.payload;
            const previous = meta.history_base;
            if (previous === undefined || previous === null) return [source];
            if (!UuidPattern.test(previous.thread_id ?? '')
                || !Number.isSafeInteger(previous.end_byte_offset) || previous.end_byte_offset < 0
                || !Number.isSafeInteger(previous.end_ordinal_exclusive) || previous.end_ordinal_exclusive < 0
                || head.hasOrdinal && head.startOrdinal !== previous.end_ordinal_exclusive)
            {
                throw new Error('Invalid inherited boundary');
            }
            let history;
            if (UuidPattern.test(meta.forked_from_id ?? '') && meta.forked_from_id.toLowerCase() !== id
                && meta.forked_from_ordinal_exclusive === previous.end_ordinal_exclusive)
            {
                const parent = meta.forked_from_id.toLowerCase();
                history = await resolveBoundary(parent, previous, await parentFiles(parent));
            }
            else if (previous.end_byte_offset === 0 && previous.end_ordinal_exclusive === 0) history = [];
            else history = await resolveBoundary(id, previous, filenames.slice(0, filenames.indexOf(filename)));
            return [...history, source];
        }

        return resolveBoundary(fork.parentId, fork.boundary, await parentFiles(fork.parentId));
    }

    async function refreshInherited(entry)
    {
        let inheritedPlan;
        try
        {
            // 失败的父查询需要重建目录索引，但每个会话最多按重试间隔执行一次。
            if (entry.inheritedPlan === null) indexAt = -Infinity;
            inheritedPlan = await makeInheritedPlan(entry.plan);
        }
        catch { inheritedPlan = null; }
        const changed = JSON.stringify(inheritedPlan) !== JSON.stringify(entry.inheritedPlan);
        entry.inheritedPlan = inheritedPlan;
        entry.inheritedAt = Date.now();
        if (changed) reset(entry);
    }

    function consume(entry, chunk, metrics, strict = false)
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
                    if (strict) throw new Error('Inherited rollout record is too large');
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
                        if (strict) throw new Error('Invalid inherited rollout record');
                        record = undefined;
                    }
                    if (record !== undefined)
                    {
                        if (validateRecord && validateRecord(record) === false) throw new Error('Invalid rollout record');
                        metrics.ingest(record);
                    }
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

    async function readSource(source, handle, size, metrics, strict = false)
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
            consume(source, chunk, metrics, strict);
            if (++chunks % 8 === 0) await new Promise(setImmediate);
        }
        if (source.limit !== null && (source.lines !== source.ordinal || source.pending.length || source.skippingLine))
        {
            throw new Error('History boundary changed');
        }
    }

    function sourceIdentity(stat, inherited = false)
    {
        return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`
            + (inherited ? `:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}` : '');
    }

    async function verifyInherited(files)
    {
        try
        {
            for (const file of files)
            {
                const stats = await Promise.all([fileSystem.stat(file.path),
                    ...(file.handle ? [file.handle.stat()] : [])]);
                if (stats.some(stat => !stat.isFile() || sourceIdentity(stat, true) !== file.identity))
                    throw new Error('Inherited rollout changed while reading');
            }
        }
        catch (error) { throw Object.assign(error, { sourcesChanged: true }); }
    }

    async function readSources(sources, metrics, inherited = false)
    {
        const files = [];
        try
        {
            let changed = false;
            for (const source of sources)
            {
                const isCompressed = compressed(source.path);
                const handle = isCompressed ? null : await fileSystem.open(source.path, 'r');
                files.push({ handle, path: source.path });
                const stat = handle ? await handle.stat() : await fileSystem.stat(source.path);
                if (!stat.isFile() || !isCompressed && source.limit !== null && stat.size < source.limit)
                {
                    throw new Error('Invalid session file');
                }
                const identity = sourceIdentity(stat, inherited || isCompressed);
                const size = isCompressed ? source.limit : source.limit ?? stat.size;
                Object.assign(files[files.length - 1], { size, identity });
                if (source.identity !== null && (source.identity !== identity || !isCompressed
                    && (size < source.offset || !await matchesGuard(handle, source.head, 0)
                        || !await matchesGuard(handle, source.tail, source.offset - source.tail.length)))) changed = true;
            }
            if (changed)
            {
                throw Object.assign(new Error('Rollout sources changed'), { sourcesChanged: true });
            }
            for (let i = 0; i < files.length; i++)
            {
                const { handle, size, identity } = files[i];
                const source = sources[i];
                source.identity = identity;
                if (handle) await readSource(source, handle, size, metrics, inherited);
                else if (!source.finished)
                {
                    try
                    {
                        const scanned = await reader.scan(source.path, { limit: source.limit, onChunk(chunk)
                        {
                            source.offset += chunk.length;
                            consume(source, chunk, metrics, inherited);
                        } });
                        if (sourceIdentity(scanned.stat, true) !== identity)
                            throw Object.assign(new Error('Compressed rollout changed'), { sourcesChanged: true });
                        if (source.limit !== null && (scanned.bytesRead !== source.limit
                            || source.lines !== source.ordinal || source.pending.length || source.skippingLine))
                            throw new Error('History boundary changed');
                        source.finished = true;
                        // 压缩文件发生变化时会整体重建，不保留最后一行的原始文本。
                        source.pending = Buffer.alloc(0);
                    }
                    catch (error)
                    {
                        if (error.code === 'ERR_ROLLOUT_CHANGED') error.sourcesChanged = true;
                        throw error;
                    }
                }
            }
            if (inherited)
            {
                await verifyInherited(files);
                return files.map(({ path: filename, identity }) => ({ path: filename, identity }));
            }
        }
        finally
        {
            await Promise.all(files.map(file => file.handle?.close()));
        }
    }

    function discardInherited(entry)
    {
        // 父历史失效时丢弃整组 TPS 样本，分支可独立读取的计数仍然保留。
        entry.inheritedPlan = null;
        entry.inheritedAt = Date.now();
        reset(entry);
    }

    async function readBranch(entry)
    {
        const metrics = { ingest(record)
        {
            entry.metrics.ingest(record);
            entry.tpsMetrics?.ingest(record);
        } };
        try { await readSources(entry.sources, metrics); }
        catch (error)
        {
            if (error.sourcesChanged) entry.lookupAt = -Infinity;
            throw error;
        }
    }

    async function read(entry, retry = true)
    {
        let inherited;
        if (entry.tpsMetrics)
        {
            try { inherited = await readSources(entry.inheritedSources, entry.tpsMetrics, true); }
            catch (error)
            {
                discardInherited(entry);
                if (retry && error.sourcesChanged)
                {
                    await refreshInherited(entry);
                    return read(entry, false);
                }
            }
        }
        await readBranch(entry);
        if (!inherited) return;
        try { await verifyInherited(inherited); }
        catch (error)
        {
            discardInherited(entry);
            if (retry && error.sourcesChanged)
            {
                await refreshInherited(entry);
                return read(entry, false);
            }
            await readBranch(entry);
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
                entry.inheritedPlan = undefined;
                entry.inheritedAt = -Infinity;
                reset(entry);
            }
            entry.lookupAt = now;
        }
        if (!entry.plan?.length) return result(entry.id, 'not-found');
        if (entry.plan.some(source => source.postFork)
            && (now < entry.inheritedAt || now - entry.inheritedAt
                >= (entry.inheritedPlan === null ? NegativeRetryMs : IndexRefreshMs)))
        {
            await refreshInherited(entry);
        }
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
            entry.inheritedPlan = undefined;
            reset(entry);
            entry.lookupAt = Date.now();
            if (!entry.plan.length) return result(entry.id, 'not-found');
            await refreshInherited(entry);
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
        reader.dispose();
        sessions.clear();
        index.clear();
        metadataCache.clear();
        boundaryCache.clear();
    }

    return { getStats, dispose };
}

module.exports = { createSessionStore };

'use strict';

const fs = require('node:fs/promises');
const zlib = require('node:zlib');

const ChunkBytes = 64 * 1024;
const MaxCacheEntries = 64;

function readerError(code, message)
{
    return Object.assign(new Error(message), { code });
}

function version(stat)
{
    return ['dev', 'ino', 'size', 'birthtimeMs', 'mtimeMs', 'ctimeMs',
        'birthtimeNs', 'mtimeNs', 'ctimeNs'].map(key => String(stat[key])).join(':');
}

function logicalStat(stat, size)
{
    const result = Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { size });
    for (const key of ['birthtime', 'mtime', 'ctime', 'atime'])
    {
        if (stat[key] instanceof Date) result[key] = new Date(stat[key]);
    }
    return result;
}

// Node 22's native Zstd stream can end successfully inside an incomplete frame.
// Check framing at EOF only; block bodies are skipped and still decoded natively.
// Format: https://github.com/facebook/zstd/blob/dev/doc/zstd_compression_format.md
function frameBoundary()
{
    const scratch = Buffer.alloc(18);
    let stage = 'magic';
    let needed = 4;
    let used = 0;
    let lastBlock = false;
    let checksum = false;
    let frames = 0;
    let valid = true;
    let boundaries;
    let position;
    function field(next, length)
    {
        stage = next;
        needed = length;
        used = 0;
    }
    function endFrame()
    {
        frames++;
        field('magic', 4);
        boundaries.push(position);
    }
    function endBlock()
    {
        if (!lastBlock) field('block', 3);
        else if (checksum) field('checksum', 4);
        else endFrame();
    }
    return {
        ingest(buffer)
        {
            boundaries = [];
            position = 0;
            while (valid && position < buffer.length)
            {
                if (stage === 'body' || stage === 'skip')
                {
                    const count = Math.min(needed, buffer.length - position);
                    needed -= count;
                    position += count;
                    if (!needed)
                    {
                        if (stage === 'body') endBlock();
                        else endFrame();
                    }
                    continue;
                }
                const count = Math.min(needed - used, buffer.length - position);
                buffer.copy(scratch, used, position, position + count);
                used += count;
                position += count;
                if (used !== needed) continue;
                switch (stage)
                {
                    case 'magic':
                    {
                        const magic = scratch.readUInt32LE(0);
                        if (magic === 0xfd2fb528) field('descriptor', 1);
                        else if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) field('skipLength', 4);
                        else valid = false;
                        break;
                    }
                    case 'descriptor':
                    {
                        const descriptor = scratch[0];
                        const single = Boolean(descriptor & 32);
                        checksum = Boolean(descriptor & 4);
                        if (descriptor & 8) valid = false;
                        const size = (single ? 0 : 1) + [0, 1, 2, 4][descriptor & 3]
                            + [single ? 1 : 0, 2, 4, 8][descriptor >>> 6];
                        if (size) field('header', size);
                        else field('block', 3);
                        break;
                    }
                    case 'header': field('block', 3); break;
                    case 'block':
                    {
                        const block = scratch.readUIntLE(0, 3);
                        const type = block >>> 1 & 3;
                        lastBlock = Boolean(block & 1);
                        if (type === 3) valid = false;
                        field('body', type === 1 ? 1 : block >>> 3);
                        if (!needed) endBlock();
                        break;
                    }
                    case 'checksum': endFrame(); break;
                    case 'skipLength':
                        field('skip', scratch.readUInt32LE(0));
                        if (!needed) endFrame();
                        break;
                }
            }
            return boundaries;
        },
        complete: () => valid && frames > 0 && stage === 'magic' && used === 0,
    };
}

function createRolloutReader({ fileSystem = fs, maxBytes = 256 * 1024 * 1024,
    maxCompressedBytes = 64 * 1024 * 1024 } = {})
{
    for (const value of [maxBytes, maxCompressedBytes])
    {
        if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Invalid rollout resource limit');
    }
    const cache = new Map();
    const handles = new Set();
    let retainedBytes = 0;
    let pending = Promise.resolve();
    let cancelDecode;
    let disposed = false;

    const disposedError = () => readerError('ERR_ROLLOUT_DISPOSED', 'Rollout reader is disposed');
    const changedError = () => readerError('ERR_ROLLOUT_CHANGED', 'Compressed rollout changed while reading');
    const limitError = () => readerError('ERR_ROLLOUT_RESOURCE_LIMIT', 'Compressed rollout exceeds the resource limit');

    function remove(entry)
    {
        if (!cache.delete(entry)) return;
        retainedBytes -= entry.size;
        entry.chunks = [];
    }

    function reserve(entry)
    {
        for (const candidate of cache.keys())
        {
            if (cache.size < MaxCacheEntries) break;
            if (!candidate.pins) remove(candidate);
        }
        if (cache.size >= MaxCacheEntries) throw limitError();
        // Keep the decoding entry pinned until it can be handed to its caller.
        entry.pins = 1;
        cache.set(entry, entry);
    }

    function invalidate(entry)
    {
        entry.invalid = true;
        if (!entry.pins && cache.has(entry)) remove(entry);
    }

    function append(entry, chunk, length)
    {
        for (const candidate of cache.keys())
        {
            if (retainedBytes + length <= maxBytes) break;
            if (!candidate.pins) remove(candidate);
        }
        if (retainedBytes + length > maxBytes) throw limitError();
        // Native chunks can be short views into a much larger output buffer.
        // Every retained backing allocation must match the charged byte count.
        let buffer = chunk;
        if (length !== chunk.length || chunk.byteOffset !== 0 || chunk.buffer.byteLength !== length)
        {
            buffer = Buffer.allocUnsafeSlow(length);
            chunk.copy(buffer, 0, 0, length);
        }
        entry.chunks.push({ buffer, start: entry.size });
        entry.size += length;
        retainedBytes += length;
    }

    async function decode(input, entry, limit)
    {
        if (limit === 0) return;
        const windowParameter = zlib.constants && zlib.constants.ZSTD_d_windowLogMax;
        const decoder = zlib.createZstdDecompress({ chunkSize: ChunkBytes,
            params: { [windowParameter]: 27 } });
        const framing = frameBoundary();
        let satisfied = false;
        let failure;
        let resolveDone;
        let rejectDone;
        const done = new Promise((resolve, reject) =>
        {
            resolveDone = resolve;
            rejectDone = reject;
        });
        function fail(error)
        {
            if (satisfied || failure) return;
            failure = error;
            rejectDone(error);
            decoder.destroy();
        }
        cancelDecode = () => fail(disposedError());
        decoder.on('error', fail);
        decoder.on('data', chunk =>
        {
            if (satisfied || failure) return;
            try
            {
                const length = limit === null ? chunk.length : Math.min(chunk.length, limit - entry.size);
                append(entry, chunk, length);
                if (limit !== null && entry.size === limit)
                {
                    satisfied = true;
                    resolveDone();
                    decoder.destroy();
                }
            }
            catch (error)
            {
                fail(error);
            }
        });
        decoder.once('end', () =>
        {
            if (!framing.complete())
            {
                fail(readerError('ERR_ROLLOUT_ZSTD_TRUNCATED', 'Compressed rollout has an incomplete Zstd frame'));
                return;
            }
            entry.complete = true;
            resolveDone();
        });
        const pumping = (async () =>
        {
            let position = 0;
            let resetFrame = false;
            while (!satisfied && !failure)
            {
                if (disposed) throw disposedError();
                if (position >= maxCompressedBytes)
                {
                    if (position < entry.physical.size) throw limitError();
                    decoder.end();
                    return;
                }
                const buffer = Buffer.allocUnsafeSlow(Math.min(ChunkBytes, maxCompressedBytes - position));
                const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
                if (disposed) throw disposedError();
                if (!bytesRead)
                {
                    decoder.end();
                    return;
                }
                position += bytesRead;
                const ends = framing.ingest(buffer.subarray(0, bytesRead));
                const frames = ends.length;
                if (ends[ends.length - 1] !== bytesRead) ends.push(bytesRead);
                let from = 0;
                for (let i = 0; i < ends.length && !satisfied && !failure; i++)
                {
                    // Node 22 stops at its first frame. Feed complete frame boundaries
                    // separately and reset the native context before the next frame.
                    if (resetFrame) decoder.reset();
                    // Native Zstd can emit an error without invoking the write callback.
                    await Promise.race([done, new Promise((resolve, reject) =>
                        decoder.write(buffer.subarray(from, ends[i]), error =>
                        {
                            if (error) reject(error);
                            else resolve();
                        }))]);
                    from = ends[i];
                    resetFrame = i < frames;
                }
            }
        })().catch(fail);
        try
        {
            await done;
        }
        finally
        {
            decoder.destroy();
            await pumping;
            cancelDecode = null;
        }
    }

    function cachedHandle(entry, limit)
    {
        const size = limit === null ? entry.size : Math.min(limit, entry.size);
        let closed = false;
        let position = 0;
        entry.pins++;
        cache.delete(entry);
        cache.set(entry, entry);
        function check()
        {
            if (closed) throw readerError('EBADF', 'Rollout handle is closed');
            if (entry.invalid) throw changedError();
        }
        function close()
        {
            if (closed) return;
            closed = true;
            handles.delete(close);
            entry.pins--;
            if (!entry.pins && (disposed || entry.invalid)) remove(entry);
        }
        handles.add(close);
        return {
            async read(buffer, offset = 0, length = buffer.byteLength - offset, at = null)
            {
                check();
                if (!ArrayBuffer.isView(buffer)) throw new TypeError('Rollout read requires a buffer');
                if (![offset, length].every(value => Number.isSafeInteger(value) && value >= 0)
                    || offset + length > buffer.byteLength) throw new RangeError('Invalid rollout read range');
                const start = at === null ? position : at;
                if (!Number.isSafeInteger(start) || start < 0) throw new RangeError('Invalid rollout read position');
                const bytesRead = Math.min(length, Math.max(0, size - start));
                const target = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
                let copied = 0;
                for (const chunk of entry.chunks)
                {
                    if (copied === bytesRead) break;
                    const from = Math.max(0, start + copied - chunk.start);
                    if (from >= chunk.buffer.length) continue;
                    const count = Math.min(bytesRead - copied, chunk.buffer.length - from);
                    chunk.buffer.copy(target, offset + copied, from, from + count);
                    copied += count;
                }
                if (at === null) position += bytesRead;
                return { bytesRead, buffer };
            },
            async stat()
            {
                check();
                const current = await fileSystem.stat(entry.filename);
                check();
                if (version(current) !== entry.version)
                {
                    invalidate(entry);
                    throw changedError();
                }
                return logicalStat(entry.physical, size);
            },
            async close() { close(); },
        };
    }

    async function openCompressed(filename, limit)
    {
        if (disposed) throw disposedError();
        if (typeof zlib.createZstdDecompress !== 'function'
            || !Number.isInteger(zlib.constants && zlib.constants.ZSTD_d_windowLogMax))
        {
            throw readerError('ERR_ROLLOUT_ZSTD_UNAVAILABLE',
                'Compressed rollouts require native Node.js Zstd decompression with a bounded window');
        }
        if (limit !== null && limit > maxBytes) throw limitError();
        const input = await fileSystem.open(filename, 'r');
        let entry;
        let decoded = false;
        function discardDecoded()
        {
            if (!decoded) return;
            entry.pins = 0;
            remove(entry);
            decoded = false;
        }
        try
        {
            const physical = await input.stat();
            const physicalVersion = version(physical);
            if (version(await fileSystem.stat(filename)) !== physicalVersion) throw changedError();
            if (disposed) throw disposedError();
            for (const candidate of cache.keys())
            {
                if (candidate.filename !== filename) continue;
                if (candidate.version !== physicalVersion) invalidate(candidate);
                else if (!candidate.invalid && (candidate.complete || limit !== null && candidate.size >= limit))
                {
                    entry = candidate;
                }
            }
            if (!entry)
            {
                entry = { filename, physical, version: physicalVersion, chunks: [], size: 0,
                    pins: 0, complete: false, invalid: false };
                reserve(entry);
                decoded = true;
                await decode(input, entry, limit);
            }
            if (disposed) throw disposedError();
            const [after, current] = await Promise.all([input.stat(), fileSystem.stat(filename)]);
            if (version(after) !== physicalVersion || version(current) !== physicalVersion) throw changedError();
            if (disposed) throw disposedError();
        }
        catch (error)
        {
            discardDecoded();
            throw error;
        }
        finally
        {
            try
            {
                await input.close();
            }
            catch (error)
            {
                discardDecoded();
                throw error;
            }
        }
        if (disposed)
        {
            discardDecoded();
            throw disposedError();
        }
        if (decoded) entry.pins--;
        return cachedHandle(entry, limit);
    }

    return {
        async open(filename, { limit = null } = {})
        {
            if (disposed) throw disposedError();
            if (!/\.zst$/i.test(filename)) return fileSystem.open(filename, 'r');
            if (limit !== null && (!Number.isSafeInteger(limit) || limit < 0))
            {
                throw new RangeError('Invalid decoded rollout prefix limit');
            }
            const operation = pending.then(() => openCompressed(filename, limit));
            pending = operation.catch(() => {});
            return operation;
        },
        dispose()
        {
            disposed = true;
            if (cancelDecode) cancelDecode();
            for (const close of handles) close();
            for (const entry of cache.keys())
            {
                if (!entry.pins) remove(entry);
            }
            return pending;
        },
    };
}

module.exports = { createRolloutReader };

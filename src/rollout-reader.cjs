'use strict';

const fs = require('node:fs/promises');
const zlib = require('node:zlib');

const ChunkBytes = 64 * 1024;
const MinOutputChunkBytes = 4096;

function readerError(code, message)
{
    return Object.assign(new Error(message), { code });
}

function version(stat)
{
    return ['dev', 'ino', 'size', 'birthtimeMs', 'mtimeMs', 'ctimeMs',
        'birthtimeNs', 'mtimeNs', 'ctimeNs'].map(key => String(stat[key])).join(':');
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

function createRolloutReader({ fileSystem = fs, inputChunkBytes = ChunkBytes,
    outputChunkBytes = ChunkBytes } = {})
{
    if (!Number.isSafeInteger(inputChunkBytes) || inputChunkBytes < 1 || inputChunkBytes > ChunkBytes
        || !Number.isSafeInteger(outputChunkBytes) || outputChunkBytes < MinOutputChunkBytes
        || outputChunkBytes > ChunkBytes)
    {
        throw new RangeError('Invalid rollout buffer limit');
    }
    let pending = Promise.resolve();
    let cancelActive;
    let disposed = false;

    const disposedError = () => readerError('ERR_ROLLOUT_DISPOSED', 'Rollout reader is disposed');
    const changedError = () => readerError('ERR_ROLLOUT_CHANGED', 'Rollout changed while reading');

    async function decode(input, limit, onChunk)
    {
        if (limit === 0) return 0;
        const decoder = zlib.createZstdDecompress({ chunkSize: outputChunkBytes,
            readableHighWaterMark: outputChunkBytes, writableHighWaterMark: inputChunkBytes,
            params: { [zlib.constants.ZSTD_d_windowLogMax]: 27 } });
        const framing = frameBoundary();
        let bytesRead = 0;
        let stopped = false;
        let settled = false;
        let delivery;
        let resolveDone;
        let rejectDone;
        let cancelWait;
        const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });

        function stop()
        {
            stopped = true;
            if (cancelWait) cancelWait();
            decoder.destroy();
        }
        async function waitFor(operation)
        {
            try
            {
                await new Promise((resolve, reject) =>
                {
                    cancelWait = resolve;
                    operation.then(resolve, reject);
                    if (stopped) resolve();
                });
            }
            finally
            {
                cancelWait = null;
            }
        }
        function fail(error)
        {
            if (settled) return;
            settled = true;
            stop();
            rejectDone(error);
        }
        function succeed()
        {
            if (settled) return;
            settled = true;
            stop();
            resolveDone(bytesRead);
        }
        cancelActive = () => fail(disposedError());
        decoder.on('error', error => { if (!stopped) fail(error); });
        decoder.on('data', chunk =>
        {
            if (stopped) return;
            // Pause synchronously: one native input chunk may expand into many output chunks.
            decoder.pause();
            const length = limit === null ? chunk.length : Math.min(chunk.length, limit - bytesRead);
            bytesRead += length;
            const satisfied = limit !== null && bytesRead === limit;
            // Stop native decoding before awaiting a consumer of the final requested prefix.
            if (satisfied) stop();
            delivery = (async () =>
            {
                const keepReading = await onChunk(chunk.subarray(0, length));
                if (settled) return;
                if (disposed) throw disposedError();
                if (satisfied || keepReading === false) succeed();
                else
                {
                    delivery = null;
                    decoder.resume();
                }
            })().catch(fail);
        });
        decoder.once('end', () =>
        {
            if (!framing.complete())
            {
                fail(readerError('ERR_ROLLOUT_ZSTD_TRUNCATED', 'Compressed rollout has an incomplete Zstd frame'));
            }
            else succeed();
        });
        const pumping = (async () =>
        {
            let position = 0;
            let resetFrame = false;
            while (!stopped)
            {
                const buffer = Buffer.allocUnsafeSlow(inputChunkBytes);
                const result = await input.read(buffer, 0, buffer.length, position);
                if (disposed) throw disposedError();
                if (stopped) return;
                if (!result.bytesRead)
                {
                    decoder.end();
                    return;
                }
                position += result.bytesRead;
                const ends = framing.ingest(buffer.subarray(0, result.bytesRead));
                const frames = ends.length;
                if (ends[ends.length - 1] !== result.bytesRead) ends.push(result.bytesRead);
                let from = 0;
                for (let i = 0; i < ends.length && !stopped; i++)
                {
                    // Node 22 stops at its first frame. Feed complete frame boundaries
                    // separately and reset the native context before the next frame.
                    if (resetFrame) decoder.reset();
                    // Native Zstd can emit an error without invoking the write callback.
                    await waitFor(new Promise((resolve, reject) =>
                        decoder.write(buffer.subarray(from, ends[i]), error =>
                        {
                            if (error) reject(error);
                            else resolve();
                        })));
                    // A native write callback can run while its output consumer is paused.
                    // Do not read another input chunk or frame until that consumer finishes.
                    while (delivery && !stopped) await waitFor(delivery);
                    from = ends[i];
                    resetFrame = i < frames;
                }
            }
        })().catch(fail);
        try
        {
            return await done;
        }
        finally
        {
            stop();
            await pumping;
            cancelActive = null;
        }
    }

    async function scanPlain(input, limit, onChunk)
    {
        let bytesRead = 0;
        let rejectConsumer;
        cancelActive = () => { if (rejectConsumer) rejectConsumer(disposedError()); };
        try
        {
            while (limit === null || bytesRead < limit)
            {
                const length = limit === null ? inputChunkBytes : Math.min(inputChunkBytes, limit - bytesRead);
                const buffer = Buffer.allocUnsafeSlow(length);
                const result = await input.read(buffer, 0, length, bytesRead);
                if (disposed) throw disposedError();
                if (!result.bytesRead) break;
                bytesRead += result.bytesRead;
                const keepReading = await new Promise((resolve, reject) =>
                {
                    rejectConsumer = reject;
                    Promise.resolve(onChunk(buffer.subarray(0, result.bytesRead))).then(resolve, reject);
                });
                rejectConsumer = null;
                if (keepReading === false) break;
            }
            return bytesRead;
        }
        finally
        {
            cancelActive = null;
        }
    }

    async function scanFile(filename, limit, onChunk)
    {
        if (disposed) throw disposedError();
        const compressed = /\.zst$/i.test(filename);
        if (compressed && (typeof zlib.createZstdDecompress !== 'function'
            || !Number.isInteger(zlib.constants && zlib.constants.ZSTD_d_windowLogMax)))
        {
            throw readerError('ERR_ROLLOUT_ZSTD_UNAVAILABLE',
                'Compressed rollouts require native Node.js Zstd decompression with a bounded window');
        }
        const input = await fileSystem.open(filename, 'r');
        try
        {
            const stat = await input.stat();
            const originalVersion = version(stat);
            async function checkVersion()
            {
                let current;
                try
                {
                    current = await fileSystem.stat(filename);
                }
                catch (error)
                {
                    if (error.code === 'ENOENT') throw changedError();
                    throw error;
                }
                if (version(current) !== originalVersion || version(await input.stat()) !== originalVersion)
                {
                    throw changedError();
                }
                if (disposed) throw disposedError();
            }
            await checkVersion();
            let bytesRead;
            try
            {
                bytesRead = await (compressed ? decode(input, limit, onChunk) : scanPlain(input, limit, onChunk));
            }
            catch (error)
            {
                await checkVersion();
                throw error;
            }
            await checkVersion();
            return { bytesRead, stat };
        }
        finally
        {
            await input.close();
        }
    }

    return {
        async scan(filename, { limit = null, onChunk } = {})
        {
            if (disposed) throw disposedError();
            if (limit !== null && (!Number.isSafeInteger(limit) || limit < 0))
            {
                throw new RangeError('Invalid decoded rollout prefix limit');
            }
            if (typeof onChunk !== 'function') throw new TypeError('Rollout scan requires an onChunk callback');
            const operation = pending.then(() => scanFile(filename, limit, onChunk));
            pending = operation.catch(() => {});
            return operation;
        },
        dispose()
        {
            disposed = true;
            if (cancelActive) cancelActive();
            return pending;
        },
    };
}

module.exports = { createRolloutReader };

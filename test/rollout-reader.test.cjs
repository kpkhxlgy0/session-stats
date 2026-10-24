'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { randomBytes } = require('node:crypto');
const { test } = require('node:test');

const ReaderPath = require.resolve('../src/session-store.cjs').replace('session-store.cjs', 'rollout-reader.cjs');
const HasZstd = typeof zlib.zstdCompressSync === 'function';

function readerFactory()
{
    return require('../src/rollout-reader.cjs').createRolloutReader;
}

async function fixture(t, options = {})
{
    const reader = readerFactory()(options);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-rollout-reader-'));
    t.after(async () =>
    {
        await reader.dispose();
        await fs.rm(directory, { recursive: true, force: true });
    });
    return {
        directory,
        reader,
        async write(name, value)
        {
            const filename = path.join(directory, name);
            await fs.writeFile(filename, value);
            return filename;
        },
        async compressed(name, value)
        {
            return this.write(name, zlib.zstdCompressSync(value));
        },
    };
}

async function read(handle, position, length)
{
    const buffer = Buffer.alloc(length);
    const result = await handle.read(buffer, 0, length, position);
    assert.equal(result.buffer, buffer);
    return buffer.subarray(0, result.bytesRead);
}

function observedFileSystem({ beforeRead, readBytes = Infinity } = {})
{
    const observation = { reads: 0, bytes: 0, opened: 0, closed: 0, active: 0, maxActiveReads: 0 };
    return {
        observation,
        fileSystem: {
            stat: filename => fs.stat(filename),
            async open(filename, flags)
            {
                assert.equal(flags, 'r');
                const handle = await fs.open(filename, flags);
                observation.opened++;
                let closed = false;
                return {
                    stat: () => handle.stat(),
                    async read(buffer, offset, length, position)
                    {
                        observation.reads++;
                        observation.active++;
                        observation.maxActiveReads = Math.max(observation.maxActiveReads, observation.active);
                        try
                        {
                            if (beforeRead) await beforeRead(filename, observation);
                            const result = await handle.read(buffer, offset, Math.min(length, readBytes), position);
                            observation.bytes += result.bytesRead;
                            return result;
                        }
                        finally
                        {
                            observation.active--;
                        }
                    },
                    async close()
                    {
                        if (!closed) observation.closed++;
                        closed = true;
                        await handle.close();
                    },
                };
            },
        },
    };
}

test('plain rollouts preserve the supplied FileHandle and ignore compressed prefix limits', async t =>
{
    const f = await fixture(t);
    const filename = await f.write('plain.jsonl', 'abcdef');
    const original = await fs.open(filename, 'r');
    const reader = readerFactory()({ fileSystem: { open: async (name, flags) =>
    {
        assert.equal(name, filename);
        assert.equal(flags, 'r');
        return original;
    } } });
    t.after(() => reader.dispose());
    const handle = await reader.open(filename, { limit: 2 });
    assert.equal(handle, original);
    assert.equal((await handle.stat()).size, 6);
    assert.equal((await read(handle, 2, 4)).toString(), 'cdef');
    await handle.close();
});

test('compressed rollouts expose an exact byte prefix with random reads and physical identity', { skip: !HasZstd }, async t =>
{
    const f = await fixture(t);
    const filename = await f.compressed('rollout.jsonl.zst', Buffer.from('alpha\n汉字\nomega\n'));
    const physical = await fs.stat(filename);
    const handle = await f.reader.open(filename, { limit: 8 });
    assert.equal((await read(handle, 0, 40)).toString('hex'), '616c7068610ae6b1');
    assert.equal((await read(handle, 3, 3)).toString(), 'ha\n');
    assert.equal((await read(handle, 8, 1)).length, 0);
    const logical = await handle.stat();
    assert.equal(logical.size, 8);
    assert.equal(logical.dev, physical.dev);
    assert.equal(logical.ino, physical.ino);
    assert.equal(logical.mtimeMs, physical.mtimeMs);
    assert.equal(logical.ctimeMs, physical.ctimeMs);
    assert.equal(logical.birthtimeMs, physical.birthtimeMs);
    assert.equal(logical.isFile(), true);
    await handle.close();
    await assert.rejects(handle.read(Buffer.alloc(1), 0, 1, 0), { code: 'EBADF' });
});

test('short compressed files return their actual decoded length', { skip: !HasZstd }, async t =>
{
    const f = await fixture(t);
    const filename = await f.compressed('short.jsonl.zst', Buffer.from('short\n'));
    const handle = await f.reader.open(filename, { limit: 500 });
    assert.equal((await handle.stat()).size, 6);
    assert.equal((await read(handle, 0, 20)).toString(), 'short\n');
    await handle.close();
});

test('a requested prefix stops before a huge decoded tail and unread compressed frames', { skip: !HasZstd }, async t =>
{
    const tracked = observedFileSystem();
    const f = await fixture(t, { fileSystem: tracked.fileSystem, maxBytes: 128 * 1024, maxCompressedBytes: 64 * 1024 });
    const firstFrame = zlib.zstdCompressSync(Buffer.alloc(16 * 1024 * 1024, 97));
    const tail = zlib.zstdCompressSync(randomBytes(256 * 1024));
    const filename = await f.write('huge.jsonl.zst', Buffer.concat([firstFrame, tail]));
    const handle = await f.reader.open(filename, { limit: 23 });
    assert.equal((await handle.stat()).size, 23);
    assert.equal((await read(handle, 0, 40)).toString(), 'aaaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(tracked.observation.bytes, 64 * 1024);
    assert.equal(tracked.observation.opened, tracked.observation.closed);
    await handle.close();
});

test('cache shares longer prefixes, expands on demand, and retains exact handle limits', { skip: !HasZstd }, async t =>
{
    const tracked = observedFileSystem();
    const f = await fixture(t, { fileSystem: tracked.fileSystem });
    const filename = await f.compressed('cache.jsonl.zst', Buffer.from('0123456789abcdefghij'));
    const first = await f.reader.open(filename, { limit: 10 });
    const initialReads = tracked.observation.reads;
    const shorter = await f.reader.open(filename, { limit: 3 });
    assert.equal((await read(shorter, 0, 10)).toString(), '012');
    assert.equal((await shorter.stat()).size, 3);
    assert.equal(tracked.observation.reads, initialReads);
    const longer = await f.reader.open(filename, { limit: 16 });
    assert.equal((await read(longer, 8, 8)).toString(), '89abcdef');
    assert.equal((await read(first, 0, 20)).toString(), '0123456789');
    assert.ok(tracked.observation.reads > initialReads);
    const expandedReads = tracked.observation.reads;
    const reused = await f.reader.open(filename, { limit: 12 });
    assert.equal((await read(reused, 10, 10)).toString(), 'ab');
    assert.equal(tracked.observation.reads, expandedReads);
    await Promise.all([first.close(), shorter.close(), longer.close(), reused.close()]);
    assert.equal(tracked.observation.opened, tracked.observation.closed);
});

test('a fully decoded cache entry also serves limits larger than the short file', { skip: !HasZstd }, async t =>
{
    const tracked = observedFileSystem();
    const f = await fixture(t, { fileSystem: tracked.fileSystem });
    const filename = await f.compressed('complete.jsonl.zst', Buffer.from('small'));
    const first = await f.reader.open(filename);
    await first.close();
    const initialReads = tracked.observation.reads;
    const second = await f.reader.open(filename, { limit: 1000 });
    assert.equal((await second.stat()).size, 5);
    assert.equal((await read(second, 0, 1000)).toString(), 'small');
    assert.equal(tracked.observation.reads, initialReads);
    await second.close();
});

test('physical replacement invalidates cached prefixes and open handles', { skip: !HasZstd }, async t =>
{
    const f = await fixture(t);
    const filename = await f.compressed('replace.jsonl.zst', Buffer.from('old content'));
    const old = await f.reader.open(filename, { limit: 3 });
    const replacement = await f.compressed('new.jsonl.zst', Buffer.from('new content'));
    await fs.rename(replacement, filename);
    await assert.rejects(old.stat(), { code: 'ERR_ROLLOUT_CHANGED' });
    const updated = await f.reader.open(filename, { limit: 3 });
    assert.equal((await read(updated, 0, 3)).toString(), 'new');
    await old.close();
    await updated.close();
});

test('changes during decoding are rejected after decoding and close the physical input', { skip: !HasZstd }, async t =>
{
    const tracked = observedFileSystem({ beforeRead: async (filename, observation) =>
    {
        if (observation.reads === 1) await fs.utimes(filename, new Date(), new Date(Date.now() + 5000));
    } });
    const f = await fixture(t, { fileSystem: tracked.fileSystem });
    const filename = await f.compressed('changing.jsonl.zst', Buffer.from('content'));
    await assert.rejects(f.reader.open(filename, { limit: 3 }), { code: 'ERR_ROLLOUT_CHANGED' });
    assert.equal(tracked.observation.opened, tracked.observation.closed);
    const updated = await f.reader.open(filename, { limit: 3 });
    assert.equal((await read(updated, 0, 3)).toString(), 'con');
    await updated.close();
});

test('truncated data is accepted only when the requested prefix was decoded', { skip: !HasZstd }, async t =>
{
    const f = await fixture(t);
    const payload = randomBytes(256 * 1024);
    const compressed = zlib.zstdCompressSync(payload);
    const filename = await f.write('truncated.jsonl.zst', compressed.subarray(0, -11));
    const prefix = await f.reader.open(filename, { limit: 23 });
    assert.deepEqual(await read(prefix, 0, 50), payload.subarray(0, 23));
    await prefix.close();
    await assert.rejects(f.reader.open(filename));
    const invalid = await f.write('invalid.jsonl.zst', Buffer.from('not a zstd frame'));
    await assert.rejects(f.reader.open(invalid, { limit: 1 }));
});

test('pinned cache entries cannot be evicted and closed entries free the aggregate budget', { skip: !HasZstd }, async t =>
{
    const tracked = observedFileSystem();
    const f = await fixture(t, { fileSystem: tracked.fileSystem, maxBytes: 100 });
    const firstFile = await f.compressed('first.jsonl.zst', Buffer.alloc(80, 97));
    const secondFile = await f.compressed('second.jsonl.zst', Buffer.alloc(80, 98));
    const first = await f.reader.open(firstFile, { limit: 80 });
    const shared = await f.reader.open(firstFile, { limit: 80 });
    await assert.rejects(f.reader.open(secondFile, { limit: 80 }), { code: 'ERR_ROLLOUT_RESOURCE_LIMIT' });
    await first.close();
    await assert.rejects(f.reader.open(secondFile, { limit: 80 }), { code: 'ERR_ROLLOUT_RESOURCE_LIMIT' });
    assert.equal((await read(shared, 70, 10)).toString(), 'aaaaaaaaaa');
    await shared.close();
    const second = await f.reader.open(secondFile, { limit: 80 });
    assert.equal((await read(second, 70, 10)).toString(), 'bbbbbbbbbb');
    await second.close();
    const reads = tracked.observation.reads;
    const reloaded = await f.reader.open(firstFile, { limit: 80 });
    assert.ok(tracked.observation.reads > reads);
    assert.equal((await read(reloaded, 0, 10)).toString(), 'aaaaaaaaaa');
    await reloaded.close();
});

test('output limits reject unbounded decoding without reporting a false complete prefix', { skip: !HasZstd }, async t =>
{
    const tracked = observedFileSystem();
    const f = await fixture(t, { fileSystem: tracked.fileSystem, maxBytes: 64 });
    const filename = await f.compressed('over.jsonl.zst', Buffer.alloc(65, 97));
    await assert.rejects(f.reader.open(filename), { code: 'ERR_ROLLOUT_RESOURCE_LIMIT' });
    await assert.rejects(f.reader.open(filename, { limit: 65 }), { code: 'ERR_ROLLOUT_RESOURCE_LIMIT' });
    const prefix = await f.reader.open(filename, { limit: 64 });
    assert.equal((await prefix.stat()).size, 64);
    await prefix.close();
    const exact = await f.compressed('exact.jsonl.zst', Buffer.alloc(64, 98));
    const complete = await f.reader.open(exact);
    assert.equal((await complete.stat()).size, 64);
    assert.equal((await read(complete, 60, 10)).toString(), 'bbbb');
    await complete.close();
    assert.equal(tracked.observation.opened, tracked.observation.closed);
});

test('compressed input limits count bytes actually read and allow a prefix from a larger file', { skip: !HasZstd }, async t =>
{
    const tracked = observedFileSystem();
    const f = await fixture(t, { fileSystem: tracked.fileSystem, maxCompressedBytes: 64 * 1024 });
    const content = randomBytes(256 * 1024);
    const filename = await f.compressed('input-over.jsonl.zst', content);
    const prefix = await f.reader.open(filename, { limit: 23 });
    assert.deepEqual(await read(prefix, 0, 50), content.subarray(0, 23));
    await prefix.close();
    const before = tracked.observation.bytes;
    await assert.rejects(f.reader.open(filename), { code: 'ERR_ROLLOUT_RESOURCE_LIMIT' });
    assert.equal(tracked.observation.bytes - before, 64 * 1024);
    assert.equal(tracked.observation.opened, tracked.observation.closed);
});

test('concurrent opens share a cache entry and serialize physical decoding', { skip: !HasZstd }, async t =>
{
    const tracked = observedFileSystem();
    const f = await fixture(t, { fileSystem: tracked.fileSystem });
    const firstFile = await f.compressed('one.jsonl.zst', randomBytes(200 * 1024));
    const secondFile = await f.compressed('two.jsonl.zst', Buffer.from('second'));
    const [first, same, second] = await Promise.all([
        f.reader.open(firstFile), f.reader.open(firstFile), f.reader.open(secondFile),
    ]);
    assert.equal((await first.stat()).size, 200 * 1024);
    assert.equal((await same.stat()).size, 200 * 1024);
    assert.equal((await read(second, 0, 6)).toString(), 'second');
    assert.equal(tracked.observation.maxActiveReads, 1);
    await Promise.all([first.close(), same.close(), second.close()]);
    assert.equal(tracked.observation.opened, tracked.observation.closed);
});

test('dispose cancels decoding and queued opens and closes all physical inputs', { skip: !HasZstd }, async t =>
{
    let release;
    let started;
    const gate = new Promise(resolve => { release = resolve; });
    const reading = new Promise(resolve => { started = resolve; });
    const tracked = observedFileSystem({ beforeRead: async () => { started(); await gate; } });
    const f = await fixture(t, { fileSystem: tracked.fileSystem });
    const filename = await f.compressed('dispose.jsonl.zst', Buffer.from('content'));
    const opening = f.reader.open(filename);
    const queued = f.reader.open(filename);
    const openingRejected = assert.rejects(opening, { code: 'ERR_ROLLOUT_DISPOSED' });
    const queuedRejected = assert.rejects(queued, { code: 'ERR_ROLLOUT_DISPOSED' });
    await reading;
    const disposing = f.reader.dispose();
    release();
    await Promise.all([openingRejected, queuedRejected, disposing]);
    assert.equal(tracked.observation.opened, tracked.observation.closed);
    await assert.rejects(f.reader.open(filename), { code: 'ERR_ROLLOUT_DISPOSED' });
});

test('dispose releases and closes already returned compressed handles', { skip: !HasZstd }, async t =>
{
    const f = await fixture(t);
    const filename = await f.compressed('dispose-handle.jsonl.zst', Buffer.from('content'));
    const handle = await f.reader.open(filename);
    await f.reader.dispose();
    await assert.rejects(handle.stat(), { code: 'EBADF' });
    await handle.close();
    await f.reader.dispose();
});

test('missing native Zstd capability rejects compression explicitly and leaves plain files usable', async t =>
{
    const source = await fs.readFile(ReaderPath, 'utf8');
    for (const native of [{ constants: {} }, { createZstdDecompress() {}, constants: {} }])
    {
        const module = { exports: {} };
        vm.runInNewContext(source, { module, Buffer, require: name => name === 'node:zlib' ? native : require(name) });
        const reader = module.exports.createRolloutReader();
        t.after(() => reader.dispose());
        await assert.rejects(reader.open('unavailable.jsonl.zst'), error => error.code === 'ERR_ROLLOUT_ZSTD_UNAVAILABLE');
        const handle = await reader.open(__filename);
        assert.ok((await handle.stat()).size > 0);
        await handle.close();
    }
});

test('compressed reads support implicit positions and reject invalid ranges and prefix limits', { skip: !HasZstd }, async t =>
{
    const f = await fixture(t);
    const filename = await f.compressed('ranges.jsonl.zst', Buffer.from('0123456789'));
    for (const limit of [-1, 1.5, Infinity, '3'])
    {
        await assert.rejects(f.reader.open(filename, { limit }), RangeError);
    }
    const handle = await f.reader.open(filename);
    const buffer = Buffer.alloc(6, 120);
    assert.equal((await handle.read(buffer, 1, 3, null)).bytesRead, 3);
    assert.equal(buffer.toString(), 'x012xx');
    assert.equal((await handle.read(buffer, 0, 2, null)).bytesRead, 2);
    assert.equal(buffer.subarray(0, 2).toString(), '34');
    await assert.rejects(handle.read(buffer, -1, 1, 0), RangeError);
    await assert.rejects(handle.read(buffer, 0, 7, 0), RangeError);
    await assert.rejects(handle.read(buffer, 0, 1, -1), RangeError);
    await handle.close();
});

test('physical close failures do not retain an unreachable decoded cache allocation', { skip: !HasZstd }, async t =>
{
    let failClose = true;
    const fileSystem = {
        stat: filename => fs.stat(filename),
        async open(filename, flags)
        {
            const handle = await fs.open(filename, flags);
            return {
                stat: () => handle.stat(),
                read: (...args) => handle.read(...args),
                async close()
                {
                    await handle.close();
                    if (failClose)
                    {
                        failClose = false;
                        throw new Error('close failed');
                    }
                },
            };
        },
    };
    const f = await fixture(t, { fileSystem, maxBytes: 80 });
    const firstFile = await f.compressed('close-first.jsonl.zst', Buffer.alloc(80, 97));
    const secondFile = await f.compressed('close-second.jsonl.zst', Buffer.alloc(80, 98));
    await assert.rejects(f.reader.open(firstFile, { limit: 80 }), /close failed/);
    const second = await f.reader.open(secondFile, { limit: 80 });
    assert.equal((await read(second, 70, 10)).toString(), 'bbbbbbbbbb');
    await second.close();
});

test('complete native frames, RLE blocks, checksums and skippable frames concatenate correctly', { skip: !HasZstd }, async t =>
{
    const f = await fixture(t);
    const skip = Buffer.alloc(12);
    skip.writeUInt32LE(0x184d2a50, 0);
    skip.writeUInt32LE(4, 4);
    skip.write('meta', 8);
    const rle = Buffer.from('28b52ffd20052b000061', 'hex');
    const checked = zlib.zstdCompressSync(Buffer.from('checked'),
        { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } });
    const filename = await f.write('frames.jsonl.zst', Buffer.concat([
        zlib.zstdCompressSync(Buffer.from('first')), skip, rle, checked,
    ]));
    const handle = await f.reader.open(filename);
    assert.equal((await read(handle, 0, 50)).toString(), 'firstaaaaachecked');
    assert.equal((await handle.stat()).size, 17);
    await handle.close();
});

test('every truncated header, block and checksum is rejected instead of cached as a complete file', { skip: !HasZstd }, async t =>
{
    const f = await fixture(t);
    const compressed = zlib.zstdCompressSync(Buffer.from('small complete frame'),
        { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } });
    for (let length = 0; length < compressed.length; length++)
    {
        const filename = await f.write(`cut-${length}.jsonl.zst`, compressed.subarray(0, length));
        await assert.rejects(f.reader.open(filename), `truncation at byte ${length} must fail`);
    }
    const filename = await f.write('uncut.jsonl.zst', compressed);
    const handle = await f.reader.open(filename);
    assert.equal((await read(handle, 0, 30)).toString(), 'small complete frame');
    await handle.close();
});

test('Zstd windows above the native decoder memory limit are rejected', { skip: !HasZstd }, async t =>
{
    const f = await fixture(t);
    // An empty frame with a 2^28-byte window descriptor exceeds the 2^27 cap.
    const filename = await f.write('window.jsonl.zst', Buffer.from('28b52ffd0090010000', 'hex'));
    await assert.rejects(f.reader.open(filename), error => /window/i.test(error.code || error.message));
});

test('frame and block headers remain valid when every physical read splits a field', { skip: !HasZstd }, async t =>
{
    const tracked = observedFileSystem({ readBytes: 1 });
    const f = await fixture(t, { fileSystem: tracked.fileSystem });
    const skip = Buffer.from('502a4d180100000078', 'hex');
    const filename = await f.write('split.jsonl.zst', Buffer.concat([
        zlib.zstdCompressSync(Buffer.from('left'),
            { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }),
        skip,
        zlib.zstdCompressSync(Buffer.from('right')),
    ]));
    const handle = await f.reader.open(filename);
    assert.equal((await read(handle, 0, 20)).toString(), 'leftright');
    assert.equal((await handle.stat()).size, 9);
    assert.equal(tracked.observation.opened, tracked.observation.closed);
    await handle.close();
});

test('cached short files own their bytes after oversized native output backing is released', { skip: !HasZstd }, async t =>
{
    const f = await fixture(t);
    const filename = await f.compressed('owned.jsonl.zst', Buffer.from('short'));
    const outputBacking = new Set();
    const native = { ...zlib, createZstdDecompress(options)
    {
        const decoder = zlib.createZstdDecompress(options);
        decoder.on('data', chunk => outputBacking.add(chunk.buffer));
        return decoder;
    } };
    const module = { exports: {} };
    vm.runInNewContext(await fs.readFile(ReaderPath, 'utf8'),
        { module, Buffer, require: name => name === 'node:zlib' ? native : require(name) });
    const reader = module.exports.createRolloutReader({ maxBytes: 5 });
    t.after(() => reader.dispose());
    const handle = await reader.open(filename);
    for (const backing of outputBacking) structuredClone(backing, { transfer: [backing] });
    assert.equal((await read(handle, 0, 5)).toString(), 'short');
    await handle.close();
});

test('the 64-entry limit pins active handles, reuses hits and releases failed decode reservations', { skip: !HasZstd }, async t =>
{
    const tracked = observedFileSystem();
    const f = await fixture(t, { fileSystem: tracked.fileSystem, maxBytes: 128 });
    const handles = [];
    const filenames = [];
    for (let i = 0; i < 65; i++)
    {
        filenames.push(await f.compressed(`entry-${i}.jsonl.zst`, Buffer.from(i === 0 ? 'xx' : 'x')));
        if (i < 64) handles.push(await f.reader.open(filenames[i], { limit: 1 }));
    }
    const before = tracked.observation.reads;
    await assert.rejects(f.reader.open(filenames[64], { limit: 1 }), { code: 'ERR_ROLLOUT_RESOURCE_LIMIT' });
    await assert.rejects(f.reader.open(filenames[0], { limit: 2 }), { code: 'ERR_ROLLOUT_RESOURCE_LIMIT' });
    assert.equal(tracked.observation.reads, before);
    const shared = await f.reader.open(filenames[0], { limit: 1 });
    assert.equal((await read(shared, 0, 1)).toString(), 'x');
    await shared.close();
    await handles[0].close();
    const corrupt = await f.write('slot-failure.jsonl.zst', Buffer.from('invalid frame'));
    await assert.rejects(f.reader.open(corrupt));
    const replacement = await f.reader.open(filenames[64], { limit: 1 });
    assert.equal((await read(replacement, 0, 1)).toString(), 'x');
    await Promise.all([...handles.map(handle => handle.close()), replacement.close()]);
    assert.equal(tracked.observation.opened, tracked.observation.closed);
});

test('the entry bound evicts the least recently used unpinned prefix', { skip: !HasZstd }, async t =>
{
    const tracked = observedFileSystem();
    const f = await fixture(t, { fileSystem: tracked.fileSystem });
    const filenames = [];
    for (let i = 0; i < 65; i++)
    {
        filenames.push(await f.compressed(`lru-${i}.jsonl.zst`, Buffer.from('x')));
        if (i < 64) await (await f.reader.open(filenames[i], { limit: 1 })).close();
    }
    await (await f.reader.open(filenames[0], { limit: 1 })).close();
    await (await f.reader.open(filenames[64], { limit: 1 })).close();
    const before = tracked.observation.reads;
    const recent = await f.reader.open(filenames[0], { limit: 1 });
    assert.equal((await read(recent, 0, 1)).toString(), 'x');
    assert.equal(tracked.observation.reads, before);
    await recent.close();
    const evicted = await f.reader.open(filenames[1], { limit: 1 });
    assert.equal((await read(evicted, 0, 1)).toString(), 'x');
    assert.ok(tracked.observation.reads > before);
    await evicted.close();
});

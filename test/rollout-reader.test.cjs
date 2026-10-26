'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { randomBytes } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');

const ReaderPath = require.resolve('../src/rollout-reader.cjs');
const HasZstd = typeof zlib.zstdCompressSync === 'function';

async function fixture(t, options = {})
{
    const reader = require(ReaderPath).createRolloutReader(options);
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

function observedFileSystem({ beforeRead, readBytes = Infinity } = {})
{
    const observation = { reads: 0, bytes: 0, opened: 0, closed: 0, active: 0,
        maxActiveReads: 0, maxReadBytes: 0 };
    return {
        observation,
        fileSystem: {
            stat: filename => fs.stat(filename),
            async open(filename, flags)
            {
                assert.equal(flags, 'r');
                const handle = await fs.open(filename, flags);
                observation.opened++;
                return {
                    stat: () => handle.stat(),
                    async read(buffer, offset, length, position)
                    {
                        observation.reads++;
                        observation.active++;
                        observation.maxActiveReads = Math.max(observation.maxActiveReads, observation.active);
                        observation.maxReadBytes = Math.max(observation.maxReadBytes, length);
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
                        observation.closed++;
                        await handle.close();
                    },
                };
            },
        },
    };
}

async function collect(reader, filename, options = {})
{
    const chunks = [];
    const result = await reader.scan(filename, { ...options, onChunk: chunk => chunks.push(chunk) });
    return { ...result, content: Buffer.concat(chunks) };
}

async function readerWithNative(native, options = {})
{
    const module = { exports: {} };
    vm.runInNewContext(await fs.readFile(ReaderPath, 'utf8'),
        { module, Buffer, require: name => name === 'node:zlib' ? native : require(name) });
    return module.exports.createRolloutReader(options);
}

test('large compressed and decoded totals stream through bounded buffers with consumer backpressure',
    { skip: !HasZstd }, async t =>
{
    const tracked = observedFileSystem();
    const f = await fixture(t);
    const payload = randomBytes(2 * 1024 * 1024);
    const filename = await f.compressed('large.jsonl.zst', payload);
    const bound = 32 * 1024;
    let decoder;
    let emitted = 0;
    const native = { ...zlib, createZstdDecompress(options)
    {
        decoder = zlib.createZstdDecompress(options);
        decoder.on('data', () => { emitted++; });
        return decoder;
    } };
    const reader = await readerWithNative(native,
        { fileSystem: tracked.fileSystem, inputChunkBytes: bound, outputChunkBytes: bound });
    t.after(() => reader.dispose());
    let release;
    let started;
    const gate = new Promise(resolve => { release = resolve; });
    const reading = new Promise(resolve => { started = resolve; });
    let total = 0;
    let active = 0;
    let maxActive = 0;
    const scanning = reader.scan(filename, { onChunk: async chunk =>
    {
        active++;
        maxActive = Math.max(maxActive, active);
        assert.ok(chunk.length <= bound);
        assert.ok(chunk.buffer.byteLength <= bound);
        assert.deepEqual(chunk, payload.subarray(total, total + chunk.length));
        total += chunk.length;
        if (total === chunk.length)
        {
            started();
            await gate;
        }
        else await delay(0);
        active--;
    } });
    await reading;
    const reads = tracked.observation.reads;
    await delay(15);
    assert.equal(emitted, 1);
    assert.equal(tracked.observation.reads, reads);
    assert.ok(decoder.readableLength <= bound);
    assert.ok(decoder.writableLength <= bound);
    release();
    const result = await scanning;
    assert.equal(result.bytesRead, payload.length);
    assert.equal(total, payload.length);
    assert.ok(result.stat.size > bound * 32);
    assert.ok(tracked.observation.bytes > bound * 32);
    assert.ok(tracked.observation.maxReadBytes <= bound);
    assert.equal(maxActive, 1);
    assert.equal(tracked.observation.opened, tracked.observation.closed);
});

test('scans expose exact byte prefixes and original physical identity for plain and compressed files',
    { skip: !HasZstd }, async t =>
{
    const f = await fixture(t);
    const value = Buffer.from('alpha\n汉字\nomega\n');
    for (const compressed of [false, true])
    {
        const filename = compressed ? await f.compressed('prefix.jsonl.zst', value)
            : await f.write('prefix.jsonl', value);
        const physical = await fs.stat(filename);
        const result = await collect(f.reader, filename, { limit: 8 });
        assert.equal(result.content.toString('hex'), '616c7068610ae6b1');
        assert.equal(result.bytesRead, 8);
        for (const key of ['size', 'dev', 'ino', 'mtimeMs', 'ctimeMs', 'birthtimeMs'])
        {
            assert.equal(result.stat[key], physical[key]);
        }
        assert.equal(result.stat.isFile(), true);
        const short = await collect(f.reader, filename, { limit: 500 });
        assert.deepEqual(short.content, value);
        assert.equal(short.bytesRead, value.length);
        assert.equal((await collect(f.reader, filename, { limit: 0 })).bytesRead, 0);
    }
});

test('prefix limits and callback stops avoid discarded corrupt frames without caching raw content',
    { skip: !HasZstd }, async t =>
{
    const tracked = observedFileSystem();
    const f = await fixture(t, { fileSystem: tracked.fileSystem });
    const first = zlib.zstdCompressSync(Buffer.alloc(16 * 1024 * 1024, 97));
    const filename = await f.write('prefix.jsonl.zst', Buffer.concat([
        first, Buffer.from('corrupt frame'), randomBytes(256 * 1024),
    ]));
    const result = await collect(f.reader, filename, { limit: 23 });
    assert.equal(result.content.toString(), 'aaaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(result.bytesRead, 23);
    assert.equal(tracked.observation.bytes, 64 * 1024);
    const before = tracked.observation.reads;
    await collect(f.reader, filename, { limit: 10 });
    assert.ok(tracked.observation.reads > before, 'a second scan must reread, not retain decompressed content');
    const metadata = await f.write('metadata.jsonl.zst', Buffer.concat([
        zlib.zstdCompressSync(Buffer.from('first line\n')), Buffer.from('corrupt discarded frame'),
    ]));
    let calls = 0;
    const stopped = await f.reader.scan(metadata, { onChunk: chunk =>
    {
        calls++;
        assert.equal(chunk.toString(), 'first line\n');
        return false;
    } });
    assert.equal(calls, 1);
    assert.equal(stopped.bytesRead, 11);
    await assert.rejects(collect(f.reader, metadata));
    assert.equal(tracked.observation.opened, tracked.observation.closed);
});

test('empty files and exact decoded EOF limits have distinct completion semantics', { skip: !HasZstd }, async t =>
{
    const f = await fixture(t);
    const empty = await f.write('empty.jsonl', '');
    assert.equal((await collect(f.reader, empty)).bytesRead, 0);
    const invalid = await f.write('empty.jsonl.zst', '');
    assert.equal((await collect(f.reader, invalid, { limit: 0 })).bytesRead, 0);
    await assert.rejects(collect(f.reader, invalid));
    const content = randomBytes(256 * 1024);
    const compressed = zlib.zstdCompressSync(content,
        { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } });
    const filename = await f.write('checksum-cut.jsonl.zst', compressed.subarray(0, -2));
    assert.deepEqual((await collect(f.reader, filename, { limit: content.length })).content, content);
    await assert.rejects(collect(f.reader, filename));
});

test('replacement, growth and timestamp changes during a scan reject the physical version',
    { skip: !HasZstd }, async t =>
{
    for (const mode of ['replacement', 'growth', 'timestamp'])
    {
        let change = true;
        const tracked = observedFileSystem({ beforeRead: async filename =>
        {
            if (!change) return;
            change = false;
            if (mode === 'timestamp') await fs.utimes(filename, new Date(), new Date(Date.now() + 5000));
            else if (mode === 'growth') await fs.appendFile(filename, Buffer.from('tail'));
            else
            {
                const replacement = filename + '.new';
                await fs.writeFile(replacement, zlib.zstdCompressSync(Buffer.from('replacement')));
                await fs.unlink(filename);
                await fs.rename(replacement, filename);
            }
        } });
        const f = await fixture(t, { fileSystem: tracked.fileSystem });
        const filename = await f.compressed(mode + '.jsonl.zst', Buffer.from('content'));
        await assert.rejects(collect(f.reader, filename, { limit: 3 }), { code: 'ERR_ROLLOUT_CHANGED' });
        assert.equal(tracked.observation.opened, tracked.observation.closed);
        assert.equal((await collect(f.reader, filename, { limit: 3 })).content.toString(),
            mode === 'replacement' ? 'rep' : 'con');
    }
});

test('changes made by the consumer are checked before returning a successful result', { skip: !HasZstd }, async t =>
{
    const f = await fixture(t);
    const filename = await f.compressed('consumer-change.jsonl.zst', Buffer.from('content'));
    await assert.rejects(f.reader.scan(filename, { onChunk: async () =>
    {
        await fs.unlink(filename);
        return false;
    } }), { code: 'ERR_ROLLOUT_CHANGED' });
});

test('consumer failures close the physical file and do not poison later scans', { skip: !HasZstd }, async t =>
{
    const tracked = observedFileSystem();
    const f = await fixture(t, { fileSystem: tracked.fileSystem });
    const filename = await f.compressed('consumer.jsonl.zst', Buffer.from('content'));
    for (const onChunk of [() => { throw new Error('sync consumer'); },
        async () => { throw new Error('async consumer'); }])
    {
        await assert.rejects(f.reader.scan(filename, { onChunk }), /consumer/);
        assert.equal(tracked.observation.opened, tracked.observation.closed);
    }
    assert.equal((await collect(f.reader, filename)).content.toString(), 'content');
});

test('concurrent requests serialize physical decoding and deliver independent scans', { skip: !HasZstd }, async t =>
{
    const tracked = observedFileSystem({ beforeRead: () => delay(1) });
    const f = await fixture(t, { fileSystem: tracked.fileSystem });
    const firstFile = await f.compressed('one.jsonl.zst', randomBytes(200 * 1024));
    const secondFile = await f.compressed('two.jsonl.zst', Buffer.from('second'));
    const [first, same, second] = await Promise.all([
        collect(f.reader, firstFile), collect(f.reader, firstFile), collect(f.reader, secondFile),
    ]);
    assert.equal(first.bytesRead, 200 * 1024);
    assert.deepEqual(same.content, first.content);
    assert.equal(second.content.toString(), 'second');
    assert.equal(tracked.observation.maxActiveReads, 1);
    assert.equal(tracked.observation.opened, tracked.observation.closed);
});

test('dispose cancels an active read and queued scans and closes physical inputs', { skip: !HasZstd }, async t =>
{
    let release;
    let started;
    const gate = new Promise(resolve => { release = resolve; });
    const reading = new Promise(resolve => { started = resolve; });
    const tracked = observedFileSystem({ beforeRead: async () => { started(); await gate; } });
    const f = await fixture(t, { fileSystem: tracked.fileSystem });
    const filename = await f.compressed('dispose.jsonl.zst', Buffer.from('content'));
    const scanning = collect(f.reader, filename);
    const queued = collect(f.reader, filename);
    const activeRejected = assert.rejects(scanning, { code: 'ERR_ROLLOUT_DISPOSED' });
    const queuedRejected = assert.rejects(queued, { code: 'ERR_ROLLOUT_DISPOSED' });
    await reading;
    const disposing = f.reader.dispose();
    release();
    await Promise.all([activeRejected, queuedRejected, disposing]);
    assert.equal(tracked.observation.opened, tracked.observation.closed);
    await assert.rejects(collect(f.reader, filename), { code: 'ERR_ROLLOUT_DISPOSED' });
    await f.reader.dispose();
});

test('dispose cancels a scan while its asynchronous consumer is paused', { skip: !HasZstd }, async t =>
{
    let release;
    let started;
    const gate = new Promise(resolve => { release = resolve; });
    const reading = new Promise(resolve => { started = resolve; });
    const tracked = observedFileSystem();
    const f = await fixture(t, { fileSystem: tracked.fileSystem });
    const filename = await f.compressed('consumer-dispose.jsonl.zst', Buffer.alloc(256 * 1024, 97));
    const scanning = f.reader.scan(filename, { onChunk: async () => { started(); await gate; } });
    const rejected = assert.rejects(scanning, { code: 'ERR_ROLLOUT_DISPOSED' });
    await reading;
    await Promise.all([rejected, f.reader.dispose()]);
    assert.equal(tracked.observation.opened, tracked.observation.closed);
    release();
});

test('missing bounded native Zstd support fails closed while plain scans remain usable', async t =>
{
    const f = await fixture(t);
    const filename = await f.write('available.jsonl', 'plain');
    for (const native of [{ constants: {} }, { createZstdDecompress() {}, constants: {} }])
    {
        const reader = await readerWithNative(native);
        t.after(() => reader.dispose());
        await assert.rejects(collect(reader, 'unavailable.jsonl.zst'),
            error => error.code === 'ERR_ROLLOUT_ZSTD_UNAVAILABLE');
        assert.equal((await collect(reader, filename)).content.toString(), 'plain');
    }
});

test('scan rejects invalid prefix limits, missing consumers and unbounded buffer settings', async t =>
{
    const f = await fixture(t);
    const filename = await f.write('ranges.jsonl', '0123456789');
    for (const limit of [-1, 1.5, Infinity, '3', Number.MAX_SAFE_INTEGER + 1])
    {
        await assert.rejects(collect(f.reader, filename, { limit }), RangeError);
    }
    await assert.rejects(f.reader.scan(filename), TypeError);
    for (const inputChunkBytes of [0, -1, Infinity, 65537, '1'])
    {
        assert.throws(() => require(ReaderPath).createRolloutReader({ inputChunkBytes }), RangeError);
    }
    for (const outputChunkBytes of [0, 1, 4095, Infinity, 65537, '4096'])
    {
        assert.throws(() => require(ReaderPath).createRolloutReader({ outputChunkBytes }), RangeError);
    }
});

test('physical close failures are reported without retaining or blocking future scans', { skip: !HasZstd }, async t =>
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
                    if (!failClose) return;
                    failClose = false;
                    throw new Error('close failed');
                },
            };
        },
    };
    const f = await fixture(t, { fileSystem });
    const filename = await f.compressed('close.jsonl.zst', Buffer.from('content'));
    await assert.rejects(collect(f.reader, filename), /close failed/);
    assert.equal((await collect(f.reader, filename)).content.toString(), 'content');
});

test('native frames, RLE blocks, checksums and skippable frames concatenate across split headers',
    { skip: !HasZstd }, async t =>
{
    for (const readBytes of [Infinity, 1])
    {
        const tracked = observedFileSystem({ readBytes });
        const f = await fixture(t, { fileSystem: tracked.fileSystem });
        const skip = Buffer.from('502a4d18040000006d657461', 'hex');
        const rle = Buffer.from('28b52ffd20052b000061', 'hex');
        const checked = zlib.zstdCompressSync(Buffer.from('checked'),
            { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } });
        const filename = await f.write('frames.jsonl.zst', Buffer.concat([
            zlib.zstdCompressSync(Buffer.from('first')), skip, rle, checked,
        ]));
        const result = await collect(f.reader, filename);
        assert.equal(result.content.toString(), 'firstaaaaachecked');
        assert.equal(result.bytesRead, 17);
        assert.equal(tracked.observation.opened, tracked.observation.closed);
    }
});

test('EOF scans reject every truncated header, block and checksum', { skip: !HasZstd }, async t =>
{
    const f = await fixture(t);
    const compressed = zlib.zstdCompressSync(Buffer.from('small complete frame'),
        { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } });
    for (let length = 0; length < compressed.length; length++)
    {
        const filename = await f.write('cut-' + length + '.jsonl.zst', compressed.subarray(0, length));
        await assert.rejects(collect(f.reader, filename), 'truncation at byte ' + length + ' must fail');
    }
    const invalid = await f.write('invalid.jsonl.zst', Buffer.from('not a zstd frame'));
    await assert.rejects(collect(f.reader, invalid));
    const corrupt = Buffer.from(compressed);
    corrupt[corrupt.length - 1] ^= 1;
    const checksum = await f.write('checksum.jsonl.zst', corrupt);
    await assert.rejects(collect(f.reader, checksum));
    const complete = await f.write('complete.jsonl.zst', compressed);
    assert.equal((await collect(f.reader, complete)).content.toString(), 'small complete frame');
});

test('Zstd windows above the 128 MiB native window limit are rejected', { skip: !HasZstd }, async t =>
{
    const f = await fixture(t);
    const filename = await f.write('window.jsonl.zst', Buffer.from('28b52ffd0090010000', 'hex'));
    await assert.rejects(collect(f.reader, filename), error => /window/i.test(error.code || error.message));
});

test('a physical mutation is reported as changed even when it also corrupts the decoded stream',
    { skip: !HasZstd }, async t =>
{
    let change = true;
    const tracked = observedFileSystem({ beforeRead: async filename =>
    {
        if (!change) return;
        change = false;
        await fs.appendFile(filename, Buffer.from('corrupt appended frame'));
    } });
    const f = await fixture(t, { fileSystem: tracked.fileSystem });
    const filename = await f.compressed('corrupt-change.jsonl.zst', Buffer.from('content'));
    await assert.rejects(collect(f.reader, filename), { code: 'ERR_ROLLOUT_CHANGED' });
    assert.equal(tracked.observation.opened, tracked.observation.closed);
});

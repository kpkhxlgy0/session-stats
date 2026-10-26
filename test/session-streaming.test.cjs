'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const zlib = require('node:zlib');
const { test } = require('node:test');
const { createSessionStore } = require('../src/session-store.cjs');

const Parent = '11111111-1111-4111-8111-111111111111';
const Child = '33333333-3333-4333-8333-333333333333';
const HasZstd = typeof zlib.zstdCompressSync === 'function';

function lines(records)
{
    return records.map(record => JSON.stringify(record) + '\n').join('');
}

function turn(id, output)
{
    return [
        { type: 'event_msg', payload: { type: 'task_started', turn_id: id } },
        { type: 'event_msg', payload: { type: 'item_completed', turn_id: id,
            item: { type: 'AgentMessage', id }, started_at_ms: 1000, completed_at_ms: 3000 } },
        { type: 'token_usage_record', payload: { turn_id: id, response_id: id,
            usage: { input_tokens: 100, output_tokens: output, cached_input_tokens: 50,
                total_tokens: 100 + output } } },
        { type: 'event_msg', payload: { type: 'task_complete', turn_id: id } },
    ];
}

async function fixture(t, large = false)
{
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-streaming-history-'));
    const directory = path.join(codexHome, 'sessions');
    await fs.mkdir(directory);
    const parent = path.join(directory, `rollout-2026-10-13T01-00-00-${Parent}.jsonl.zst`);
    let bytes = 0;
    let records = 0;
    async function append(value, count)
    {
        const buffer = Buffer.from(value);
        await fs.appendFile(parent, zlib.zstdCompressSync(buffer));
        bytes += buffer.length;
        records += count;
    }
    await append(lines([{ type: 'session_meta', ordinal: 0, payload: { id: Parent } }]), 1);
    if (large)
    {
        const decodedOnly = large === 'decoded';
        const padding = lines([{ type: 'padding', payload: { text: decodedOnly
            ? 'x'.repeat(128 * 1024) : randomBytes(512 * 1024).toString('base64') } }]);
        const copies = decodedOnly ? 16 : 1;
        for (let i = 0; i < 132; i++) await append(padding.repeat(copies), copies);
        if (decodedOnly) assert.ok(bytes > 256 * 1024 * 1024);
        else assert.ok((await fs.stat(parent)).size > 64 * 1024 * 1024);
    }
    await append(lines(turn('parent', 10)), 4);
    const child = path.join(directory, `rollout-2026-10-16T01-00-00-${Child}.jsonl`);
    await fs.writeFile(child, lines([{ type: 'session_meta', ordinal: records, payload: { id: Child,
        forked_from_id: Parent, forked_from_ordinal_exclusive: records,
        history_base: { thread_id: Parent, end_ordinal_exclusive: records, end_byte_offset: bytes } } },
    ...turn('child', 20)]));
    let compressedReads = 0;
    const store = createSessionStore({ codexHome, fileSystem: { ...fs,
        async open(filename, flags)
        {
            const handle = await fs.open(filename, flags);
            return { stat: (...args) => handle.stat(...args), close: () => handle.close(),
                read: (...args) =>
                {
                    if (filename.endsWith('.zst')) compressedReads++;
                    return handle.read(...args);
                } };
        },
    } });
    t.after(async () => { store.dispose(); await fs.rm(codexHome, { recursive: true }); });
    return { store, parent, child, compressedReads: () => compressedReads };
}

test('compressed inherited history beyond the old 64 MiB input ceiling still supplies TPS',
    { skip: !HasZstd }, async t =>
{
    const f = await fixture(t, true);
    const stats = await f.store.getStats(Child);
    assert.equal(stats.status, 'ok'); assert.equal(stats.tps, 7.5);
    assert.equal(stats.modelActiveMs, 4000);
    assert.equal(stats.turns, 1); assert.equal(stats.steps, 1); assert.equal(stats.totalTokens, 120);
});

test('unchanged compressed history is not read again across polls, ancestry refresh and response replay',
    { skip: !HasZstd }, async t =>
{
    t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 26) });
    const f = await fixture(t);
    const first = await f.store.getStats(Child);
    assert.equal(first.tps, 7.5);
    const reads = f.compressedReads();
    for (const result of await Promise.all(Array.from({ length: 10 }, () => f.store.getStats(Child))))
        assert.deepEqual(result, first);
    t.mock.timers.tick(16000);
    assert.deepEqual(await f.store.getStats(Child), first);
    await fs.appendFile(f.child, lines([...turn('child', 20), ...turn('next', 30)]));
    const next = await f.store.getStats(Child);
    assert.equal(next.tps, 10); assert.equal(next.modelActiveMs, 6000);
    assert.equal(next.turns, 2); assert.equal(next.steps, 2); assert.equal(next.totalTokens, 250);
    assert.equal(f.compressedReads(), reads);
});

test('decoded inherited prefixes beyond the old 256 MiB cache ceiling are streamed without retention',
    { skip: !HasZstd }, async t =>
{
    const f = await fixture(t, 'decoded');
    const stats = await f.store.getStats(Child);
    assert.equal(stats.status, 'ok'); assert.equal(stats.tps, 7.5);
    assert.equal(stats.modelActiveMs, 4000); assert.equal(stats.totalTokens, 120);
    const reads = f.compressedReads();
    assert.deepEqual(await f.store.getStats(Child), stats);
    assert.equal(f.compressedReads(), reads);
});

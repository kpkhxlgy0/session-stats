'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createSessionStore } = require('../src/session-store.cjs');

const Parent = '11111111-1111-4111-8111-111111111111';
const Segment = '22222222-2222-4222-8222-222222222222';
const Child = '33333333-3333-4333-8333-333333333333';

function turn(id, output, input, cached)
{
    return [
        { type: 'event_msg', payload: { type: 'task_started', turn_id: id } },
        { type: 'event_msg', payload: { type: 'item_completed', turn_id: id,
            item: { type: 'AgentMessage', id }, started_at_ms: 1000, completed_at_ms: 3000 } },
        { type: 'token_usage_record', payload: { turn_id: id, response_id: `response-${id}`,
            usage: { input_tokens: input, output_tokens: output, cached_input_tokens: cached,
                total_tokens: input + output }, thread_token_usage: { input_tokens: 10000 + input,
                output_tokens: 1000 + output, total_tokens: 11000 + input + output,
                cached_input_tokens: 9000 + cached } } },
        { type: 'event_msg', payload: { type: 'task_complete', turn_id: id } },
    ];
}

function lines(records, ordinal)
{
    return records.map((record, i) => JSON.stringify({ ...record, ordinal: ordinal + i }) + '\n').join('');
}

function content(start, records, metadata = {})
{
    return lines([{ type: 'session_meta', payload: { id: Child, session_id: Child,
        history_mode: 'paginated', ...metadata } }, ...records], start);
}

async function fixture(t)
{
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-post-fork-'));
    const directory = path.join(codexHome, 'sessions', '2026', '10', '22');
    await fs.mkdir(directory, { recursive: true });
    const store = createSessionStore({ codexHome });
    t.after(async () => { store.dispose(); await fs.rm(codexHome, { recursive: true }); });
    async function write(name, value)
    {
        const filename = path.join(directory, `rollout-2026-10-22T${name}.jsonl`);
        await fs.writeFile(filename, value);
        return filename;
    }
    const metadata = { forked_from_id: Parent, forked_from_ordinal_exclusive: 10,
        history_base: { thread_id: Segment, end_ordinal_exclusive: 10, end_byte_offset: 123456 } };
    const prefix = content(10, turn('first', 20, 100, 50), metadata);
    const file = await write(`02-00-00-${Child}`, prefix);
    return { store, file, write, prefix, metadata, directory };
}

function assertFirst(stats)
{
    assert.equal(stats.status, 'ok');
    assert.equal(stats.turns, 1); assert.equal(stats.steps, 1);
    assert.equal(stats.totalTokens, 120); assert.equal(stats.inputTokens, 100);
    assert.equal(stats.outputTokens, 20); assert.equal(stats.cachedInputTokens, 50);
    assert.equal(stats.cacheHit, 0.5); assert.equal(stats.tps, 10);
}

test('a fork uses only its own responses even if its parent history is absent or compressed', async t =>
{
    const f = await fixture(t);
    assertFirst(await f.store.getStats(Child));
    await fs.writeFile(path.join(f.directory, `rollout-2026-10-22T01-00-00-${Parent}_${Segment}.jsonl.zst`),
        'parent history must not be read');
    assertFirst(await f.store.getStats(Child));
});

test('post-fork usage deduplicates response replay and ignores inherited cumulative snapshots', async t =>
{
    const f = await fixture(t);
    assertFirst(await f.store.getStats(Child));
    await fs.appendFile(f.file, lines(turn('first', 20, 100, 50), 15));
    await fs.appendFile(f.file, lines([{ type: 'event_msg', payload: { type: 'token_count',
        info: { total_token_usage: { total_tokens: 999999, input_tokens: 999000,
            output_tokens: 999, cached_input_tokens: 900000 } } } }], 19));
    assertFirst(await f.store.getStats(Child));
    await fs.appendFile(f.file, lines(turn('second', 30, 200, 150), 20));
    const results = await Promise.all(Array.from({ length: 10 }, () => f.store.getStats(Child)));
    for (const stats of results)
    {
        assert.equal(stats.turns, 2); assert.equal(stats.steps, 2);
        assert.equal(stats.totalTokens, 350); assert.equal(stats.cachedInputTokens, 200);
        assert.equal(stats.cacheHit, 2 / 3); assert.equal(stats.tps, 15);
    }
});

test('continuations of a fork retain post-fork history and use cumulative record ordinals', async t =>
{
    const f = await fixture(t);
    await fs.appendFile(f.file, lines(turn('abandoned', 999, 999, 0), 15));
    const continuation = content(15, turn('second', 30, 200, 150), {
        ...f.metadata, history_base: { thread_id: Child, end_ordinal_exclusive: 15,
            end_byte_offset: Buffer.byteLength(f.prefix) },
    });
    await f.write(`03-00-00-${Child}_${Segment}`, continuation);
    const stats = await f.store.getStats(Child);
    assert.equal(stats.status, 'ok'); assert.equal(stats.turns, 2); assert.equal(stats.steps, 2);
    assert.equal(stats.totalTokens, 350); assert.equal(stats.tps, 15);
});

test('invalid fork boundaries cannot disable the history checks', async t =>
{
    const f = await fixture(t);
    for (const extra of [{ forked_from_id: '../parent' }, { forked_from_id: Child },
        { forked_from_ordinal_exclusive: 9 }, { forked_from_ordinal_exclusive: -1 }])
    {
        await fs.writeFile(f.file, content(10, turn('first', 20, 100, 50), { ...f.metadata, ...extra }));
        assert.equal((await f.store.getStats(Child)).status, 'unavailable');
    }
});

test('later fork continuations can identify the previous segment by its filename suffix', async t =>
{
    const f = await fixture(t);
    const second = content(15, turn('second', 30, 200, 150), {
        ...f.metadata, history_base: { thread_id: Child, end_ordinal_exclusive: 15,
            end_byte_offset: Buffer.byteLength(f.prefix) },
    });
    await f.write(`03-00-00-${Child}_${Segment}`, second + lines(turn('abandoned', 999, 999, 0), 20));
    await f.write(`04-00-00-${Child}_${Parent}`, content(20,
        [...turn('second', 30, 200, 150), ...turn('third', 40, 300, 250)], {
            ...f.metadata, history_base: { thread_id: Segment, end_ordinal_exclusive: 20,
                end_byte_offset: Buffer.byteLength(second) },
        }));
    const stats = await f.store.getStats(Child);
    assert.equal(stats.status, 'ok'); assert.equal(stats.turns, 3); assert.equal(stats.steps, 3);
    assert.equal(stats.totalTokens, 690); assert.equal(stats.cachedInputTokens, 450);
    assert.equal(stats.cacheHit, 0.75); assert.equal(stats.tps, 20);
    assert.deepEqual(await f.store.getStats(Child), stats);
});

test('missing per-response usage never falls back to inherited thread totals', async t =>
{
    const f = await fixture(t);
    const records = turn('first', 20, 100, 50);
    delete records[2].payload.usage.input_tokens;
    await fs.writeFile(f.file, content(10, records, f.metadata));
    const stats = await f.store.getStats(Child);
    assert.equal(stats.status, 'ok'); assert.equal(stats.inputTokens, null);
    assert.equal(stats.cacheHit, null); assert.equal(stats.outputTokens, 20); assert.equal(stats.tps, 10);
});

test('a response without an identity leaves fork totals unknown even after later complete responses', async t =>
{
    const f = await fixture(t);
    const records = turn('first', 20, 100, 50);
    delete records[2].payload.response_id;
    await fs.writeFile(f.file, content(10, [...records, ...turn('second', 30, 200, 150)], f.metadata));
    const stats = await f.store.getStats(Child);
    assert.equal(stats.status, 'ok'); assert.equal(stats.totalTokens, null);
    assert.equal(stats.inputTokens, null); assert.equal(stats.outputTokens, null);
    assert.equal(stats.cachedInputTokens, null); assert.equal(stats.cacheHit, null);
    assert.equal(stats.tps, 15);
});

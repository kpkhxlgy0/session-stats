'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createSessionStore } = require('../src/session-store.cjs');

const ThreadId = '01a162fb-40c7-7eb0-acf8-172500cfc35d';
const SuffixId = '01a1650a-ae8b-73d1-b11b-fab409ed3583';
const OtherId = '22222222-2222-4222-8222-222222222222';

function line(type, payload)
{
    return `${JSON.stringify({ type, payload })}\n`;
}

function meta(extra = {})
{
    return line('session_meta', { id: ThreadId, session_id: ThreadId, ...extra });
}

function turn(id, responseId, output, total)
{
    return line('event_msg', { type: 'task_started', turn_id: id })
        + line('event_msg', { type: 'item_completed', turn_id: id, item: { type: 'AgentMessage', id },
            started_at_ms: 1000, completed_at_ms: 3000 })
        + line('token_usage_record', { turn_id: id, response_id: responseId, usage: { output_tokens: output },
            thread_token_usage: { total_tokens: total, input_tokens: total - 30, output_tokens: 30,
                cached_input_tokens: 50 } })
        + line('event_msg', { type: 'task_complete', turn_id: id });
}

async function fixture(t)
{
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-continuation-'));
    const store = createSessionStore({ codexHome });
    t.after(async () =>
    {
        store.dispose();
        await fs.rm(codexHome, { recursive: true });
    });
    async function write(name, content, directory = 'sessions/2026/10/23')
    {
        const target = path.join(codexHome, directory);
        await fs.mkdir(target, { recursive: true });
        const filename = path.join(target, `rollout-${name}.jsonl`);
        await fs.writeFile(filename, content);
        return filename;
    }
    const prefix = meta() + turn('first', 'response-1', 10, 100);
    const base = { thread_id: ThreadId, end_ordinal_exclusive: 5, end_byte_offset: Buffer.byteLength(prefix) };
    const original = await write(`2026-10-22T17-39-55-${ThreadId}`, prefix
        + turn('discarded', 'response-discarded', 900, 1000), 'sessions/2026/10/22');
    async function continueLog(extra = {}, body = turn('second', 'response-2', 20, 150))
    {
        return write(`2026-10-23T03-16-01-${ThreadId}_${SuffixId}`,
            meta({ history_mode: 'paginated', history_base: base, ...extra }) + body);
    }
    return { codexHome, store, prefix, base, original, write, continueLog };
}

function assertMerged(stats)
{
    assert.equal(stats.status, 'ok');
    assert.equal(stats.turns, 2);
    assert.equal(stats.steps, 2);
    assert.equal(stats.totalTokens, 150);
    assert.equal(stats.inputTokens, 120);
    assert.equal(stats.cachedInputTokens, 50);
    assert.equal(stats.cacheHit, 50 / 120);
    assert.equal(stats.tps, 10);
    assert.equal(stats.modelActiveMs, 2000);
    assert.equal(stats.activeTurn, false);
}

test('uses the history boundary instead of the abandoned original tail, preserving latest TPS and totals', async t =>
{
    const f = await fixture(t);
    await f.continueLog();
    assertMerged(await f.store.getStats(ThreadId));
    assertMerged(await f.store.getStats(ThreadId));
    assert.equal((await f.store.getStats(SuffixId)).status, 'not-found');
});

test('finds a later continuation after the original file has already been cached', async t =>
{
    t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 23) });
    const f = await fixture(t);
    assert.equal((await f.store.getStats(ThreadId)).totalTokens, 1000);
    await f.continueLog();
    t.mock.timers.tick(16000);
    assertMerged(await f.store.getStats(ThreadId));
});

test('prefers the continuation when it is created in the same second as the original', async t =>
{
    const f = await fixture(t);
    await f.write(`2026-10-22T17-39-55-${ThreadId}_${SuffixId}`,
        meta({ history_base: f.base }) + turn('second', 'response-2', 20, 150));
    assertMerged(await f.store.getStats(ThreadId));
});

test('deduplicates replayed responses and repeated polls while incrementally reading the continuation', async t =>
{
    const f = await fixture(t);
    const filename = await f.continueLog({}, turn('first', 'response-1', 10, 100)
        + turn('second', 'response-2', 20, 150));
    assertMerged(await f.store.getStats(ThreadId));
    const append = turn('third', 'response-3', 40, 220);
    await fs.appendFile(filename, append.slice(0, -1));
    const stats = await f.store.getStats(ThreadId);
    assert.equal(stats.steps, 3);
    assert.equal(stats.totalTokens, 220);
    await fs.appendFile(filename, '\n');
    const results = await Promise.all(Array.from({ length: 10 }, () => f.store.getStats(ThreadId)));
    for (const result of results)
    {
        assert.equal(result.turns, 3);
        assert.equal(result.steps, 3);
        assert.equal(result.totalTokens, 220);
        assert.equal(result.tps, 20);
    }
});

test('reads the history prefix from archives without adding duplicate copies', async t =>
{
    const f = await fixture(t);
    await f.write(`2026-10-22T17-39-55-${ThreadId}`, f.prefix, 'archived_sessions');
    await fs.unlink(f.original);
    await f.continueLog();
    assertMerged(await f.store.getStats(ThreadId));
});

test('ignores an archived copy of the original when both copies are present', async t =>
{
    const f = await fixture(t);
    await f.write(`2026-10-22T17-39-55-${ThreadId}`, f.prefix, 'archived_sessions');
    await f.continueLog();
    assertMerged(await f.store.getStats(ThreadId));
});

test('rebuilds the full chain when the continuation is replaced with a different history boundary', async t =>
{
    const f = await fixture(t);
    const filename = await f.continueLog();
    assertMerged(await f.store.getStats(ThreadId));
    const replacement = meta({ history_base: { ...f.base,
        end_byte_offset: Buffer.byteLength(meta()), end_ordinal_exclusive: 1 } })
        + turn('third', 'response-3', 40, 220);
    await fs.writeFile(`${filename}.replacement`, replacement);
    await fs.rename(`${filename}.replacement`, filename);
    const stats = await f.store.getStats(ThreadId);
    assert.equal(stats.status, 'ok');
    assert.equal(stats.turns, 1);
    assert.equal(stats.steps, 1);
    assert.equal(stats.totalTokens, 220);
    assert.equal(stats.tps, 20);
});

test('resolves the history boundary again after a failed read and same-path replacement', async t =>
{
    t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 23) });
    const f = await fixture(t);
    const filename = await f.continueLog();
    assertMerged(await f.store.getStats(ThreadId));
    await fs.writeFile(f.original, '');
    assert.equal((await f.store.getStats(ThreadId)).status, 'unavailable');
    await fs.writeFile(f.original, f.prefix);
    await fs.writeFile(filename, meta({ history_base: { ...f.base,
        end_byte_offset: Buffer.byteLength(meta()), end_ordinal_exclusive: 1 } })
        + turn('third', 'response-3', 40, 220));
    const stats = await f.store.getStats(ThreadId);
    assert.equal(stats.status, 'ok');
    assert.equal(stats.turns, 1);
    assert.equal(stats.steps, 1);
    assert.equal(stats.totalTokens, 220);
    assert.equal(stats.tps, 20);
    t.mock.timers.tick(16000);
    assert.deepEqual(await f.store.getStats(ThreadId), stats);
});

test('follows a uniquely matching continuation chain without summing cumulative token counters', async t =>
{
    t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 23) });
    const f = await fixture(t);
    const filename = await f.continueLog();
    assertMerged(await f.store.getStats(ThreadId));
    const content = await fs.readFile(filename);
    await fs.appendFile(filename, turn('abandoned-second-tail', 'discarded-2', 1000, 2000));
    await f.write(`2026-10-24T00-00-00-${ThreadId}_${OtherId}`,
        meta({ history_base: { thread_id: ThreadId, end_byte_offset: content.length, end_ordinal_exclusive: 5 } })
            + turn('third', 'response-3', 40, 220), 'sessions/2026/10/24');
    t.mock.timers.tick(16000);
    const stats = await f.store.getStats(ThreadId);
    assert.equal(stats.status, 'ok');
    assert.equal(stats.turns, 3);
    assert.equal(stats.steps, 3);
    assert.equal(stats.totalTokens, 220);
    assert.equal(stats.tps, 20);
    t.mock.timers.tick(16000);
    assert.deepEqual(await f.store.getStats(ThreadId), stats);
});

test('does not choose a history source when multiple different rollouts match its boundary', async t =>
{
    const f = await fixture(t);
    await f.write(`2026-10-22T18-00-00-${ThreadId}`, f.prefix);
    await f.continueLog();
    assert.equal((await f.store.getStats(ThreadId)).status, 'unavailable');
});

test('does not trust a continuation belonging to another thread', async t =>
{
    const f = await fixture(t);
    await f.continueLog({ id: OtherId, session_id: OtherId });
    assert.equal((await f.store.getStats(ThreadId)).status, 'unavailable');
});

test('does not report partial cumulative counts when the required history is missing', async t =>
{
    const f = await fixture(t);
    await f.continueLog();
    await fs.unlink(f.original);
    assert.equal((await f.store.getStats(ThreadId)).status, 'unavailable');
});

test('rejects an out-of-range, split-line, or inconsistent history boundary', async t =>
{
    const f = await fixture(t);
    for (const changes of [
        { end_byte_offset: 999999 },
        { end_byte_offset: f.base.end_byte_offset - 1 },
        { end_ordinal_exclusive: 4 },
        { end_byte_offset: -1 },
        { thread_id: OtherId },
    ])
    {
        await f.continueLog({ history_base: { ...f.base, ...changes } });
        const store = createSessionStore({ codexHome: f.codexHome });
        try { assert.equal((await store.getStats(ThreadId)).status, 'unavailable'); }
        finally { store.dispose(); }
    }
});

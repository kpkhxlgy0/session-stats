'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createSessionStore } = require('../src/session-store.cjs');

const ThreadId = '11111111-1111-4111-8111-111111111111';
const OtherThreadId = '22222222-2222-4222-8222-222222222222';

function createMetrics()
{
    let steps = 0;
    let totalTokens = 0;
    return {
        ingest(record)
        {
            steps++;
            totalTokens += record.tokens || 0;
        },
        snapshot()
        {
            return {
                turns: 0,
                steps,
                totalTokens,
                inputTokens: totalTokens,
                outputTokens: 0,
                cachedInputTokens: 0,
                cacheHit: 0,
                tps: null,
                tpsHeld: false,
                activeTurn: false,
                modelActiveMs: 0,
            };
        },
    };
}

async function fixture(t)
{
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-session-store-'));
    const store = createSessionStore({ codexHome, createMetrics });
    t.after(async () =>
    {
        store.dispose();
        await fs.rm(codexHome, { recursive: true });
    });
    return { codexHome, store };
}

async function writeSession(codexHome, threadId, content, relativeDirectory = 'sessions/2026/10/22')
{
    const directory = path.join(codexHome, relativeDirectory);
    await fs.mkdir(directory, { recursive: true });
    const filename = path.join(directory, `rollout-2026-10-22T10-00-00-${threadId}.jsonl`);
    await fs.writeFile(filename, content);
    return filename;
}

function jsonLine(tokens, extra = {})
{
    return `${JSON.stringify({ tokens, ...extra })}\n`;
}

test('rejects path-shaped and nonstandard thread identifiers without throwing', async t =>
{
    const { store } = await fixture(t);
    for (const threadId of [null, '', '../sessions/private', `${ThreadId}.jsonl`,
        '11111111-1111-0111-8111-111111111111', '11111111-1111-4111-1111-111111111111'])
    {
        const stats = await store.getStats(threadId);
        assert.equal(stats.status, 'unavailable');
        assert.equal(stats.totalTokens, 0);
    }
});

test('reads only the exact requested session and returns metric fields without transcript data', async t =>
{
    const { codexHome, store } = await fixture(t);
    await writeSession(codexHome, ThreadId, jsonLine(11, { text: 'private transcript' }));
    await writeSession(codexHome, OtherThreadId, jsonLine(10000));

    const stats = await store.getStats(ThreadId);
    assert.equal(stats.status, 'ok');
    assert.equal(stats.threadId, ThreadId);
    assert.equal(stats.totalTokens, 11);
    assert.equal(stats.steps, 1);
    assert.deepEqual(Object.keys(stats).sort(), [
        'activeTurn', 'cacheHit', 'cachedInputTokens', 'inputTokens', 'modelActiveMs',
        'outputTokens', 'status', 'steps', 'threadId', 'totalTokens', 'tps', 'tpsHeld', 'turns',
    ]);
    assert.ok(!JSON.stringify(stats).includes('private transcript'));
    assert.ok(!JSON.stringify(stats).includes(codexHome));
});

test('locates archived sessions whose filenames are outside the UUID date hint', async t =>
{
    const { codexHome, store } = await fixture(t);
    await writeSession(codexHome, ThreadId, jsonLine(17), 'archived_sessions');
    const stats = await store.getStats(ThreadId);
    assert.equal(stats.status, 'ok');
    assert.equal(stats.totalTokens, 17);
});

test('ingests newly appended complete records exactly once', async t =>
{
    const { codexHome, store } = await fixture(t);
    const filename = await writeSession(codexHome, ThreadId, jsonLine(3));
    assert.equal((await store.getStats(ThreadId)).totalTokens, 3);
    await fs.appendFile(filename, jsonLine(5));
    assert.equal((await store.getStats(ThreadId)).totalTokens, 8);
    assert.equal((await store.getStats(ThreadId)).steps, 2);
});

test('retains an incomplete JSON record across writes including a split UTF-8 character', async t =>
{
    const { codexHome, store } = await fixture(t);
    const record = Buffer.from(jsonLine(7, { text: '中文' }));
    const split = record.indexOf(Buffer.from('中')) + 1;
    const filename = await writeSession(codexHome, ThreadId, record.subarray(0, split));

    assert.equal((await store.getStats(ThreadId)).steps, 0);
    await fs.appendFile(filename, record.subarray(split, record.length - 1));
    assert.equal((await store.getStats(ThreadId)).steps, 0);
    await fs.appendFile(filename, '\n');
    const stats = await store.getStats(ThreadId);
    assert.equal(stats.totalTokens, 7);
    assert.equal(stats.steps, 1);
});

test('resets accumulated metrics after the session file is truncated', async t =>
{
    const { codexHome, store } = await fixture(t);
    const filename = await writeSession(codexHome, ThreadId, jsonLine(100) + jsonLine(200));
    assert.equal((await store.getStats(ThreadId)).totalTokens, 300);
    await fs.writeFile(filename, jsonLine(4));
    const stats = await store.getStats(ThreadId);
    assert.equal(stats.totalTokens, 4);
    assert.equal(stats.steps, 1);
});

test('resets accumulated metrics after an equal-size session file replacement', async t =>
{
    const { codexHome, store } = await fixture(t);
    const filename = await writeSession(codexHome, ThreadId, jsonLine(3));
    assert.equal((await store.getStats(ThreadId)).totalTokens, 3);
    const replacement = `${filename}.replacement`;
    await fs.writeFile(replacement, jsonLine(9));
    await fs.rename(replacement, filename);
    const stats = await store.getStats(ThreadId);
    assert.equal(stats.totalTokens, 9);
    assert.equal(stats.steps, 1);
});

test('skips a malformed complete line and continues with the next record', async t =>
{
    const { codexHome, store } = await fixture(t);
    await writeSession(codexHome, ThreadId, `invalid json\n${jsonLine(13)}`);
    const stats = await store.getStats(ThreadId);
    assert.equal(stats.totalTokens, 13);
    assert.equal(stats.steps, 1);
});

test('coalesces concurrent polls so the same records cannot be counted twice', async t =>
{
    const { codexHome, store } = await fixture(t);
    await writeSession(codexHome, ThreadId, jsonLine(2) + jsonLine(5));
    const results = await Promise.all(Array.from({ length: 20 }, () => store.getStats(ThreadId)));
    for (const stats of results)
    {
        assert.equal(stats.totalTokens, 7);
        assert.equal(stats.steps, 2);
    }
    assert.equal((await store.getStats(ThreadId)).totalTokens, 7);
});

test('rechecks a negative lookup and detects a newly created session', async t =>
{
    const { codexHome, store } = await fixture(t);
    t.mock.timers.enable({ apis: ['Date'], now: 1792600000000 });
    const missing = await store.getStats(ThreadId);
    assert.equal(missing.status, 'not-found');
    assert.equal(missing.steps, 0);
    await writeSession(codexHome, ThreadId, jsonLine(19));
    t.mock.timers.tick(16000);
    const stats = await store.getStats(ThreadId);
    assert.equal(stats.status, 'ok');
    assert.equal(stats.totalTokens, 19);
});

test('uses date hints to find a new UUIDv7 session without waiting for an index rebuild', async t =>
{
    const { codexHome, store } = await fixture(t);
    const timestamp = Date.UTC(2026, 9, 23, 0, 1);
    const hex = timestamp.toString(16).padStart(12, '0');
    const threadId = `${hex.slice(0, 8)}-${hex.slice(8)}-7000-8000-000000000001`;
    t.mock.timers.enable({ apis: ['Date'], now: timestamp });
    assert.equal((await store.getStats(threadId)).status, 'not-found');
    await writeSession(codexHome, threadId, jsonLine(23), 'sessions/2026/10/22');
    t.mock.timers.tick(1100);
    const stats = await store.getStats(threadId);
    assert.equal(stats.status, 'ok');
    assert.equal(stats.totalTokens, 23);
});

test('handles a deleted session and discovers its subsequent replacement', async t =>
{
    const { codexHome, store } = await fixture(t);
    const filename = await writeSession(codexHome, ThreadId, jsonLine(31));
    assert.equal((await store.getStats(ThreadId)).totalTokens, 31);
    await fs.unlink(filename);
    assert.equal((await store.getStats(ThreadId)).status, 'not-found');
    t.mock.timers.enable({ apis: ['Date'], now: 1792600000000 });
    await writeSession(codexHome, ThreadId, jsonLine(37));
    t.mock.timers.tick(16000);
    const stats = await store.getStats(ThreadId);
    assert.equal(stats.status, 'ok');
    assert.equal(stats.totalTokens, 37);
});

test('returns unavailable after disposal and discards an outstanding read result', async t =>
{
    const { codexHome, store } = await fixture(t);
    await writeSession(codexHome, ThreadId, jsonLine(41));
    const pending = store.getStats(ThreadId);
    store.dispose();
    const stats = await pending;
    assert.equal(stats.status, 'unavailable');
    assert.equal(stats.totalTokens, 0);
    assert.equal((await store.getStats(ThreadId)).status, 'unavailable');
});

test('maps unreadable session roots to unavailable without returning filesystem details', async t =>
{
    const { codexHome, store } = await fixture(t);
    await fs.writeFile(path.join(codexHome, 'sessions'), 'not a directory');
    const stats = await store.getStats(ThreadId);
    assert.equal(stats.status, 'unavailable');
    assert.equal(stats.totalTokens, 0);
    assert.ok(!JSON.stringify(stats).includes(codexHome));
});

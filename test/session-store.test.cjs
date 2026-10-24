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

async function adapterFixture(t, { pathApi = path.posix, ...options } = {})
{
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-session-adapter-'));
    const codexHome = pathApi.join(pathApi === path.win32 ? 'C:\\remote' : '/remote', '.codex');
    const files = new Map();
    const candidates = [];
    function localPath(filename)
    {
        if (!files.has(filename)) throw Object.assign(new Error('Unexpected source'), { code: 'ENOENT' });
        return files.get(filename);
    }
    const store = createSessionStore({
        codexHome,
        createMetrics,
        pathApi,
        fileSystem: {
            stat: filename => fs.stat(localPath(filename)),
            open: (filename, flags) => fs.open(localPath(filename), flags),
            opendir: async () => { throw new Error('Source adapter must bypass local indexing'); },
        },
        findSources: async threadId =>
        {
            assert.ok([ThreadId, OtherThreadId].includes(threadId));
            return candidates;
        },
        ...options,
    });
    t.after(async () =>
    {
        store.dispose();
        await fs.rm(directory, { recursive: true });
    });
    return {
        store,
        candidates,
        async write(relative, content)
        {
            const filename = pathApi.join(codexHome, ...relative.split('/'));
            if (!files.has(filename)) files.set(filename, path.join(directory, `${files.size}.jsonl`));
            await fs.writeFile(files.get(filename), content);
            candidates.push(filename);
            return filename;
        },
        append: (filename, content) => fs.appendFile(localPath(filename), content),
    };
}

function sessionMeta(extra = {}, ordinal)
{
    return jsonLine(0, { type: 'session_meta', payload: { id: ThreadId, ...extra },
        ...(ordinal === undefined ? {} : { ordinal }) });
}

for (const [platform, pathApi] of [['POSIX', path.posix], ['Windows', path.win32]])
{
    test(`source adapters use ${platform} paths and prefer the active copy of an archived rollout`, async t =>
    {
        const f = await adapterFixture(t, { pathApi });
        const name = `rollout-2026-10-22T10-00-00-${ThreadId}.jsonl`;
        await f.write(`archived_sessions/${name}`, jsonLine(900));
        const active = await f.write(`sessions/2026/10/22/${name}`, jsonLine(14));
        await f.write(`sessions/rollout-2026-10-23T10-00-00-${OtherThreadId}.jsonl`, jsonLine(1000));
        await f.write(`sessions/private-${ThreadId}.jsonl`, jsonLine(2000));

        const initial = await f.store.getStats(ThreadId.toUpperCase());
        assert.equal(initial.status, 'ok');
        assert.equal(initial.totalTokens, 14);
        await f.append(active, jsonLine(6));
        assert.equal((await f.store.getStats(ThreadId)).totalTokens, 20);
    });
}

test('source adapters reject filenames for another session before opening them', async t =>
{
    const f = await adapterFixture(t);
    await f.write(`sessions/rollout-2026-10-22T10-00-00-${OtherThreadId}.jsonl`, jsonLine(99));
    await f.write(`sessions/private-${ThreadId}.jsonl`, jsonLine(99));
    const stats = await f.store.getStats(ThreadId);
    assert.equal(stats.status, 'not-found');
    assert.equal(stats.totalTokens, 0);
});

test('source adapters reject mismatched rollout metadata', async t =>
{
    const f = await adapterFixture(t);
    await f.write(`sessions/rollout-2026-10-22T10-00-00-${ThreadId}.jsonl`,
        sessionMeta({ id: OtherThreadId }) + jsonLine(99));
    const stats = await f.store.getStats(ThreadId);
    assert.equal(stats.status, 'unavailable');
    assert.equal(stats.totalTokens, 0);
});

test('source adapters retain exact continuation byte and ordinal boundaries after sorting candidates', async t =>
{
    const f = await adapterFixture(t);
    const prefix = sessionMeta({}, 0) + jsonLine(10);
    const original = `rollout-2026-10-22T10-00-00-${ThreadId}.jsonl`;
    const latest = `rollout-2026-10-23T10-00-00-${ThreadId}_${OtherThreadId}.jsonl`;
    await f.write(`sessions/${latest}`, sessionMeta({ history_base: {
        thread_id: ThreadId, end_byte_offset: Buffer.byteLength(prefix), end_ordinal_exclusive: 2,
    } }, 2) + jsonLine(20));
    await f.write(`sessions/${original}`, prefix + jsonLine(1000));
    const stats = await f.store.getStats(ThreadId);
    assert.equal(stats.status, 'ok');
    assert.equal(stats.totalTokens, 30);
    assert.equal(stats.steps, 4);
});

test('source adapters fail closed when the requested history ordinal does not match its bytes', async t =>
{
    const f = await adapterFixture(t);
    const prefix = sessionMeta({}, 0) + jsonLine(10);
    await f.write(`sessions/rollout-2026-10-22T10-00-00-${ThreadId}.jsonl`, prefix);
    await f.write(`sessions/rollout-2026-10-23T10-00-00-${ThreadId}_${OtherThreadId}.jsonl`,
        sessionMeta({ history_base: {
            thread_id: ThreadId, end_byte_offset: Buffer.byteLength(prefix), end_ordinal_exclusive: 3,
        } }, 3) + jsonLine(20));
    const stats = await f.store.getStats(ThreadId);
    assert.equal(stats.status, 'unavailable');
    assert.equal(stats.totalTokens, 0);
});

test('source adapters preserve branch counts when the declared parent is missing', async t =>
{
    const f = await adapterFixture(t);
    await f.write(`sessions/rollout-2026-10-22T10-00-00-${ThreadId}.jsonl`,
        sessionMeta({ forked_from_id: OtherThreadId, forked_from_ordinal_exclusive: 10,
            history_base: { thread_id: OtherThreadId, end_byte_offset: 123456, end_ordinal_exclusive: 10 } }, 10)
        + jsonLine(30));
    const stats = await f.store.getStats(ThreadId);
    assert.equal(stats.status, 'ok');
    assert.equal(stats.totalTokens, 30);
    assert.equal(stats.tps, null);
    assert.equal(stats.modelActiveMs, null);
});

for (const [platform, pathApi] of [['POSIX', path.posix], ['Windows', path.win32]])
{
    test(`source adapters resolve inherited ${platform} history with the existing filesystem interface`, async t =>
    {
        const f = await adapterFixture(t, { pathApi, createMetrics: () =>
        {
            const metrics = createMetrics();
            return { ...metrics, snapshot()
            {
                const stats = metrics.snapshot();
                return { ...stats, tps: stats.totalTokens, modelActiveMs: stats.totalTokens * 1000 };
            } };
        } });
        const parent = jsonLine(0, { type: 'session_meta', payload: { id: OtherThreadId }, ordinal: 0 }) + jsonLine(10);
        await f.write(`sessions/rollout-2026-10-22T10-00-00-${OtherThreadId}.jsonl`, parent + jsonLine(900));
        await f.write(`sessions/rollout-2026-10-23T10-00-00-${ThreadId}.jsonl`,
            sessionMeta({ forked_from_id: OtherThreadId, forked_from_ordinal_exclusive: 2,
                history_base: { thread_id: OtherThreadId, end_byte_offset: Buffer.byteLength(parent),
                    end_ordinal_exclusive: 2 } }, 2) + jsonLine(30));
        const stats = await f.store.getStats(ThreadId);
        assert.equal(stats.status, 'ok'); assert.equal(stats.totalTokens, 30);
        assert.equal(stats.tps, 40); assert.equal(stats.modelActiveMs, 40000);
    });
}

test('inherited adapter sources outside the session roots cannot supply TPS', async t =>
{
    const f = await adapterFixture(t);
    const parent = jsonLine(0, { type: 'session_meta', payload: { id: OtherThreadId }, ordinal: 0 }) + jsonLine(10);
    await f.write(`private/rollout-2026-10-22T10-00-00-${OtherThreadId}.jsonl`, parent);
    await f.write(`sessions/rollout-2026-10-23T10-00-00-${ThreadId}.jsonl`,
        sessionMeta({ forked_from_id: OtherThreadId, forked_from_ordinal_exclusive: 2,
            history_base: { thread_id: OtherThreadId, end_byte_offset: Buffer.byteLength(parent),
                end_ordinal_exclusive: 2 } }, 2) + jsonLine(30));
    const stats = await f.store.getStats(ThreadId);
    assert.equal(stats.status, 'ok'); assert.equal(stats.totalTokens, 30);
    assert.equal(stats.tps, null); assert.equal(stats.modelActiveMs, null);
});

test('source adapters enforce the shared maximum source count', async t =>
{
    const f = await adapterFixture(t);
    for (let i = 0; i < 33; i++)
    {
        await f.write(`sessions/rollout-2026-10-22T10-00-${String(i).padStart(2, '0')}-${ThreadId}.jsonl`, jsonLine(1));
    }
    const stats = await f.store.getStats(ThreadId);
    assert.equal(stats.status, 'unavailable');
    assert.equal(stats.totalTokens, 0);
});

for (const failure of ['return false', 'throw'])
{
    test(`record validation can ${failure} for later metadata without exposing partial totals`, async t =>
    {
        let rejected = true;
        const f = await adapterFixture(t, { validateRecord: record =>
        {
            if (rejected && record.type === 'session_meta' && record.payload.id !== ThreadId)
            {
                if (failure === 'throw') throw new Error('Mismatched identity');
                return false;
            }
        } });
        await f.write(`sessions/rollout-2026-10-22T10-00-00-${ThreadId}.jsonl`,
            sessionMeta() + jsonLine(10) + sessionMeta({ id: OtherThreadId }) + jsonLine(20));
        const failed = await f.store.getStats(ThreadId);
        assert.equal(failed.status, 'unavailable');
        assert.equal(failed.totalTokens, 0);
        assert.equal(failed.steps, 0);
        rejected = false;
        const recovered = await f.store.getStats(ThreadId);
        assert.equal(recovered.status, 'ok');
        assert.equal(recovered.totalTokens, 30);
        assert.equal(recovered.steps, 4);
    });
}

test('record validation can reject an ordinary record before metrics ingestion', async t =>
{
    const { codexHome } = await fixture(t);
    const ingested = [];
    const store = createSessionStore({ codexHome, createMetrics: () =>
    {
        const metrics = createMetrics();
        return { ...metrics, ingest(record) { ingested.push(record.tokens); metrics.ingest(record); } };
    },
        validateRecord: record => record.tokens !== 99 });
    t.after(() => store.dispose());
    await writeSession(codexHome, ThreadId, jsonLine(10) + jsonLine(99));
    const stats = await store.getStats(ThreadId);
    assert.equal(stats.status, 'unavailable');
    assert.equal(stats.totalTokens, 0);
    assert.deepEqual(ingested, [10]);
});

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

'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createRemoteSessionStore } = require('../src/remote-session-store.cjs');

const ThreadId = '11111111-1111-4111-8111-111111111111';
const OtherThreadId = '22222222-2222-4222-8222-222222222222';
const RolloutSuffixId = '01a16451-110e-76a0-b4a3-1d36713c77de';
const HostId = 'remote-control:host-one';
const OtherHostId = 'remote-control:host-two';

function lines(...records)
{
    return records.map(record => JSON.stringify(record) + '\n').join('');
}

function event(type, fields = {})
{
    return { type: 'event_msg', payload: { type, turn_id: 'turn-one', ...fields } };
}

function usage(responseId, totalTokens, outputTokens = 200)
{
    return {
        type: 'token_usage_record',
        payload: {
            thread_id: ThreadId,
            turn_id: 'turn-one',
            response_id: responseId,
            usage: { output_tokens: outputTokens },
            thread_token_usage: {
                input_tokens: totalTokens - outputTokens,
                cached_input_tokens: 500,
                output_tokens: outputTokens,
                total_tokens: totalTokens,
            },
        },
    };
}

function remote(content = lines(usage('response-one', 1200)), threadId = ThreadId)
{
    const state = {
        content,
        path: `/home/user/.codex/sessions/rollout-2026-10-22T10-00-00-${threadId}.jsonl`,
        threadId,
        metadata: { isFile: true, isDirectory: false, isSymlink: false, createdAtMs: 1, modifiedAtMs: 2 },
        calls: [],
        failMethod: null,
        dataBase64: null,
        wait: null,
    };
    state.request = async (method, params) =>
    {
        state.calls.push({ method, params });
        if (state.wait) await state.wait;
        if (state.failMethod === method) throw new Error('Unsupported remote operation: private detail');
        if (method === 'thread/read')
        {
            assert.deepEqual(params, { threadId, includeTurns: false });
            return { thread: { id: state.threadId, path: state.path } };
        }
        assert.deepEqual(params, { path: state.path });
        if (method === 'fs/getMetadata') return { ...state.metadata };
        assert.equal(method, 'fs/readFile');
        return { dataBase64: state.dataBase64 ?? Buffer.from(state.content).toString('base64') };
    };
    state.change = value =>
    {
        state.content = value;
        state.metadata.modifiedAtMs++;
    };
    return state;
}

function fixture(t)
{
    const clock = { value: 0 };
    const store = createRemoteSessionStore({ now: () => clock.value });
    const identity = { hostId: HostId, threadId: ThreadId };
    t.after(() => store.dispose());
    return { store, clock, identity };
}

test('uses official metrics and returns only stats plus remote identity', async t =>
{
    const { store, identity } = fixture(t);
    const source = remote(lines(
        { type: 'session_meta', payload: { id: ThreadId, private: 'private transcript' } },
        event('task_started'),
        event('item_completed', {
            item: { type: 'Reasoning', id: 'reason-one' }, started_at_ms: 0, completed_at_ms: 1000,
        }),
        event('item_completed', {
            item: { type: 'CommandExecution', id: 'tool-one' }, started_at_ms: 1000, completed_at_ms: 6000,
        }),
        usage('response-one', 1200),
        event('task_complete'),
    ));
    assert.deepEqual(await store.getStats(identity, source.request), {
        turns: 1,
        steps: 1,
        totalTokens: 1200,
        inputTokens: 1000,
        outputTokens: 200,
        cachedInputTokens: 500,
        cacheHit: 0.5,
        tps: 200,
        tpsHeld: false,
        activeTurn: false,
        modelActiveMs: 1000,
        status: 'ok',
        hostId: HostId,
        threadId: ThreadId,
    });
});

test('keeps absent response and timing fields unknown', async t =>
{
    const { store, identity } = fixture(t);
    const source = remote(lines(event('token_count', { info: {
        total_token_usage: { input_tokens: 1000, total_tokens: 1200 },
    } })));
    const stats = await store.getStats(identity, source.request);
    assert.equal(stats.status, 'ok');
    assert.equal(stats.totalTokens, 1200);
    assert.equal(stats.steps, null);
    assert.equal(stats.outputTokens, null);
    assert.equal(stats.cacheHit, null);
    assert.equal(stats.tps, null);
});

test('isolates the same thread on different hosts', async t =>
{
    const { store, identity } = fixture(t);
    const first = remote(lines(usage('first', 1200)));
    const second = remote(lines(usage('second', 2100)));
    assert.equal((await store.getStats(identity, first.request)).totalTokens, 1200);
    const other = await store.getStats({ ...identity, hostId: OtherHostId }, second.request);
    assert.equal(other.totalTokens, 2100);
    assert.equal(other.hostId, OtherHostId);
    assert.equal((await store.getStats(identity, first.request)).totalTokens, 1200);
    assert.equal(second.calls.length, 3);
});

test('isolates different threads on the same host and returns independent snapshots', async t =>
{
    const { store, identity } = fixture(t);
    const first = remote();
    const second = remote(lines(usage('other', 3200)), OtherThreadId);
    const original = await store.getStats(identity, first.request);
    original.totalTokens = 9999;
    original.path = '/private';
    const other = await store.getStats({ ...identity, threadId: OtherThreadId }, second.request);
    assert.equal(other.totalTokens, 3200);
    assert.equal(other.threadId, OtherThreadId);
    const cached = await store.getStats(identity, first.request);
    assert.equal(cached.totalTokens, 1200);
    assert.equal(Object.hasOwn(cached, 'path'), false);
});

test('does not parse a partial final record until it ends in a newline', async t =>
{
    const { store, clock, identity } = fixture(t);
    const source = remote(lines(usage('first', 1200)).trimEnd());
    const initial = await store.getStats(identity, source.request);
    assert.equal(initial.status, 'ok');
    assert.equal(initial.steps, null);
    source.change(source.content + '\n');
    clock.value += 15000;
    assert.equal((await store.getStats(identity, source.request)).steps, 1);
});

test('rebuilds snapshots after growth and deduplicates repeated response records', async t =>
{
    const { store, clock, identity } = fixture(t);
    const first = usage('first', 1200);
    const source = remote(lines(first));
    assert.equal((await store.getStats(identity, source.request)).steps, 1);
    source.change(lines(first, usage('second', 2200), first));
    clock.value += 15000;
    const stats = await store.getStats(identity, source.request);
    assert.equal(stats.steps, 2);
    assert.equal(stats.totalTokens, 2200);
});

test('replaces prior metrics after truncation or equal-length replacement', async t =>
{
    const { store, clock, identity } = fixture(t);
    const source = remote(lines(usage('first', 1200), usage('second', 2200)));
    assert.equal((await store.getStats(identity, source.request)).steps, 2);
    source.change(lines(usage('third', 3300)));
    clock.value += 15000;
    assert.equal((await store.getStats(identity, source.request)).totalTokens, 3300);
    source.change(lines(usage('third', 4400)));
    clock.value += 15000;
    const replaced = await store.getStats(identity, source.request);
    assert.equal(replaced.totalTokens, 4400);
    assert.equal(replaced.steps, 1);
});

test('throttles polling and reuses a snapshot when metadata is unchanged', async t =>
{
    const { store, clock, identity } = fixture(t);
    const source = remote();
    await store.getStats(identity, source.request);
    clock.value += 14999;
    assert.equal((await store.getStats(identity, source.request)).status, 'ok');
    assert.equal(source.calls.length, 3);
    clock.value++;
    assert.equal((await store.getStats(identity, source.request)).totalTokens, 1200);
    assert.deepEqual(source.calls.map(call => call.method), [
        'thread/read', 'fs/getMetadata', 'fs/readFile', 'thread/read', 'fs/getMetadata',
    ]);
});

test('uses a newly resolved path even when its timestamps match the previous path', async t =>
{
    const { store, clock, identity } = fixture(t);
    const source = remote();
    await store.getStats(identity, source.request);
    source.path = `C:\\Users\\user\\.codex\\archived_sessions\\rollout-2026-10-22-${ThreadId}.jsonl`;
    source.content = lines(usage('moved', 3200));
    clock.value += 15000;
    assert.equal((await store.getStats(identity, source.request)).totalTokens, 3200);
    assert.equal(source.calls.filter(call => call.method === 'fs/readFile').length, 2);
});

test('coalesces concurrent reads of one remote session', async t =>
{
    const { store, identity } = fixture(t);
    const source = remote();
    const results = await Promise.all(Array.from({ length: 20 }, () => store.getStats(identity, source.request)));
    for (const result of results)
    {
        assert.equal(result.status, 'ok');
        assert.equal(result.totalTokens, 1200);
    }
    assert.equal(source.calls.length, 3);
});

test('reports failed reads as unavailable and throttles retries without using stale metrics', async t =>
{
    const { store, clock, identity } = fixture(t);
    const source = remote();
    await store.getStats(identity, source.request);
    source.change(lines(usage('new', 2200)));
    source.failMethod = 'fs/readFile';
    clock.value += 15000;
    const failed = await store.getStats(identity, source.request);
    assert.equal(failed.status, 'unavailable');
    assert.equal(failed.totalTokens, null);
    assert.ok(!JSON.stringify(failed).includes('private detail'));
    const callCount = source.calls.length;
    source.failMethod = null;
    clock.value += 14999;
    assert.equal((await store.getStats(identity, source.request)).status, 'unavailable');
    assert.equal(source.calls.length, callCount);
    clock.value++;
    assert.equal((await store.getStats(identity, source.request)).totalTokens, 2200);
});

test('returns unavailable when the remote does not implement required RPC methods', async t =>
{
    for (const method of ['thread/read', 'fs/getMetadata', 'fs/readFile'])
    {
        const { store, identity } = fixture(t);
        const source = remote();
        source.failMethod = method;
        const stats = await store.getStats(identity, source.request);
        assert.equal(stats.status, 'unavailable');
        assert.equal(stats.totalTokens, null);
    }
});

test('disposal discards an outstanding result and prevents further RPC calls', async t =>
{
    const { store, identity } = fixture(t);
    const source = remote();
    let release;
    source.wait = new Promise(resolve => { release = resolve; });
    const pending = store.getStats(identity, source.request);
    store.dispose();
    release();
    const stats = await pending;
    assert.equal(stats.status, 'unavailable');
    assert.equal(stats.totalTokens, null);
    const callCount = source.calls.length;
    assert.equal((await store.getStats(identity, source.request)).status, 'unavailable');
    assert.equal(source.calls.length, callCount);
});

test('rejects invalid identifiers and local hosts before making requests', async t =>
{
    const { store, identity } = fixture(t);
    const source = remote();
    for (const input of [null, {}, { ...identity, hostId: 'local' }, { ...identity, hostId: 'LOCAL' },
        { ...identity, hostId: '' }, { ...identity, hostId: 'x'.repeat(513) },
        { ...identity, hostId: 'remote\u0000private' }, { ...identity, hostId: 'remote\u0085private' },
        { ...identity, threadId: '../private' }, { ...identity, threadId: OtherThreadId + '.jsonl' },
        { ...identity, threadId: '11111111-1111-0111-8111-111111111111' }])
    {
        assert.equal((await store.getStats(input, source.request)).status, 'unavailable');
    }
    assert.equal(source.calls.length, 0);
});

test('treats remote host IDs as opaque strings and normalizes valid UUID case', async t =>
{
    const { store, identity } = fixture(t);
    const source = remote();
    const hostId = 'remote host/path\\opaque';
    const stats = await store.getStats({ ...identity, hostId, threadId: ThreadId.toUpperCase() }, source.request);
    assert.equal(stats.status, 'ok');
    assert.equal(stats.hostId, hostId);
    assert.equal(stats.threadId, ThreadId);
});

test('reads rollout paths with a UUID suffix on Windows and Unix', async t =>
{
    for (const path of [
        `C:\\Users\\user\\.codex\\sessions\\2026\\10\\22\\rollout-2026-10-22T23-53-16-${ThreadId}_${RolloutSuffixId}.jsonl`,
        `/home/user/.codex/sessions/2026/10/22/rollout-2026-10-22T23-53-16-${ThreadId}_${RolloutSuffixId}.jsonl`,
    ])
    {
        const { store, identity } = fixture(t);
        const source = remote(lines({ type: 'session_meta', payload: { id: ThreadId } }, usage('response-one', 1200)));
        source.path = path;
        const stats = await store.getStats(identity, source.request);
        assert.equal(stats.status, 'ok');
        assert.equal(stats.totalTokens, 1200);
        assert.equal(stats.steps, 1);
    }
});

test('rejects mismatched thread IDs and unrelated or null-containing rollout paths', async t =>
{
    for (const change of [
        state => { state.threadId = OtherThreadId; },
        state => { state.threadId = OtherThreadId; state.path = `/private/rollout-date-${ThreadId}_${RolloutSuffixId}.jsonl`; },
        state => { state.path = `/private/rollout-date-${OtherThreadId}.jsonl`; },
        state => { state.path = `/private/rollout-date-${OtherThreadId}_${RolloutSuffixId}.jsonl`; },
        state => { state.path = `/private/rollout-date-${OtherThreadId}_${ThreadId}.jsonl`; },
        state => { state.path = `/private/rollout-date-${ThreadId}_private.jsonl`; },
        state => { state.path = `/private/rollout-date-${ThreadId}_.jsonl`; },
        state => { state.path = `/private/rollout-date-${ThreadId}_11111111-1111-0111-8111-111111111111.jsonl`; },
        state => { state.path = `/private/rollout-date-${ThreadId}_11111111-1111-4111-7111-111111111111.jsonl`; },
        state => { state.path = `/private/rollout-date-${ThreadId}_${RolloutSuffixId}_${RolloutSuffixId}.jsonl`; },
        state => { state.path = `/private/rollout-date-${ThreadId}_${RolloutSuffixId}.other.jsonl`; },
        state => { state.path = `/private/not-rollout-${ThreadId}.jsonl`; },
        state => { state.path = `/private/rollout-date-${ThreadId}.jsonl/other`; },
        state => { state.path = `/private\u0000/rollout-date-${ThreadId}.jsonl`; },
        state => { state.path = null; },
    ])
    {
        const { store, identity } = fixture(t);
        const source = remote();
        change(source);
        assert.equal((await store.getStats(identity, source.request)).status, 'unavailable');
        assert.deepEqual(source.calls.map(call => call.method), ['thread/read']);
    }
});

test('rejects a session_meta record whose ID belongs to another session', async t =>
{
    for (const suffix of ['', `_${RolloutSuffixId}`])
    {
        const { store, identity } = fixture(t);
        const source = remote(lines(usage('private', 9900), { type: 'session_meta', payload: { id: OtherThreadId } }));
        source.path = `/private/rollout-date-${ThreadId}${suffix}.jsonl`;
        const stats = await store.getStats(identity, source.request);
        assert.equal(stats.status, 'unavailable');
        assert.equal(stats.totalTokens, null);
        assert.equal(source.calls.some(call => call.method === 'fs/readFile'), true);
    }
});

test('rejects directories, symlinks and incomplete metadata', async t =>
{
    for (const metadata of [
        { isFile: false }, { isDirectory: true }, { isSymlink: true },
        { createdAtMs: null }, { modifiedAtMs: NaN }, { modifiedAtMs: -1 },
    ])
    {
        const { store, identity } = fixture(t);
        const source = remote();
        Object.assign(source.metadata, metadata);
        assert.equal((await store.getStats(identity, source.request)).status, 'unavailable');
        assert.equal(source.calls.some(call => call.method === 'fs/readFile'), false);
    }
});

test('rejects malformed base64 rather than silently accepting a decoded prefix', async t =>
{
    for (const dataBase64 of ['not base64!', 'e30', 'e30=\n', 'e31=', '====', 7, {}])
    {
        const { store, identity } = fixture(t);
        const source = remote();
        source.dataBase64 = dataBase64;
        assert.equal((await store.getStats(identity, source.request)).status, 'unavailable');
    }
});

test('limits decoded files to 32 MiB', async t =>
{
    const { store, identity } = fixture(t);
    const source = remote();
    source.dataBase64 = Buffer.alloc(32 * 1024 * 1024 + 1).toString('base64');
    assert.equal((await store.getStats(identity, source.request)).status, 'unavailable');
});

test('caches an oversized result until metadata changes and then recovers a smaller file', async t =>
{
    const { store, clock, identity } = fixture(t);
    const source = remote();
    source.dataBase64 = Buffer.alloc(33 * 1024 * 1024).toString('base64');
    for (const time of [0, 15000, 30000, 45000, 60000])
    {
        clock.value = time;
        const stats = await store.getStats(identity, source.request);
        assert.equal(stats.status, 'unavailable');
        assert.equal(stats.totalTokens, null);
        assert.equal(source.calls.filter(call => call.method === 'fs/readFile').length, 1);
    }
    assert.equal(source.calls.filter(call => call.method === 'fs/getMetadata').length, 2);
    source.dataBase64 = null;
    source.change(lines(usage('recovered', 3200)));
    clock.value = 120000;
    const recovered = await store.getStats(identity, source.request);
    assert.equal(recovered.status, 'ok');
    assert.equal(recovered.totalTokens, 3200);
    assert.equal(recovered.steps, 1);
    assert.equal(source.calls.filter(call => call.method === 'fs/readFile').length, 2);
});

test('an oversized replacement cannot revive an earlier successful snapshot', async t =>
{
    const { store, clock, identity } = fixture(t);
    const source = remote();
    assert.equal((await store.getStats(identity, source.request)).totalTokens, 1200);
    source.dataBase64 = Buffer.alloc(32 * 1024 * 1024 + 1).toString('base64');
    source.metadata.modifiedAtMs++;
    clock.value = 15000;
    assert.equal((await store.getStats(identity, source.request)).status, 'unavailable');
    clock.value = 75000;
    const cached = await store.getStats(identity, source.request);
    assert.equal(cached.status, 'unavailable');
    assert.equal(cached.totalTokens, null);
    assert.equal(source.calls.filter(call => call.method === 'fs/readFile').length, 2);
});

test('caches a bridge size-limit rejection until metadata changes and then recovers', async t =>
{
    const { store, clock, identity } = fixture(t);
    const source = remote();
    let tooLarge = false;
    const request = async (method, params) =>
    {
        const response = await source.request(method, params);
        if (method === 'fs/readFile' && tooLarge)
        {
            throw Object.assign(new Error('Remote log is too large'), { code: 'SESSION_STATS_LOG_TOO_LARGE' });
        }
        return response;
    };
    assert.equal((await store.getStats(identity, request)).totalTokens, 1200);
    tooLarge = true;
    source.metadata.modifiedAtMs++;
    for (const time of [15000, 30000, 45000, 60000, 75000])
    {
        clock.value = time;
        const stats = await store.getStats(identity, request);
        assert.equal(stats.status, 'unavailable');
        assert.equal(stats.totalTokens, null);
        assert.equal(source.calls.filter(call => call.method === 'fs/readFile').length, 2);
    }
    assert.equal(source.calls.filter(call => call.method === 'fs/getMetadata').length, 3);
    tooLarge = false;
    source.change(lines(usage('recovered', 3200)));
    clock.value = 135000;
    const recovered = await store.getStats(identity, request);
    assert.equal(recovered.status, 'ok');
    assert.equal(recovered.totalTokens, 3200);
    assert.equal(source.calls.filter(call => call.method === 'fs/readFile').length, 3);
});

test('skips malformed and oversized lines while continuing with complete records', async t =>
{
    const { store, identity } = fixture(t);
    const source = remote('invalid json\n' + 'x'.repeat(8 * 1024 * 1024 + 1) + '\n' + lines(usage('valid', 1200)));
    const stats = await store.getStats(identity, source.request);
    assert.equal(stats.status, 'ok');
    assert.equal(stats.totalTokens, 1200);
    assert.equal(stats.steps, 1);
});

test('lengthens polling for files larger than 4 MiB', async t =>
{
    const { store, clock, identity } = fixture(t);
    const source = remote(lines({ padding: 'x'.repeat(4 * 1024 * 1024) }, usage('first', 1200)));
    await store.getStats(identity, source.request);
    source.change(lines(usage('second', 2200)));
    clock.value += 59999;
    assert.equal((await store.getStats(identity, source.request)).totalTokens, 1200);
    assert.equal(source.calls.length, 3);
    clock.value++;
    assert.equal((await store.getStats(identity, source.request)).totalTokens, 2200);
});

test('evicts the least recently used idle host entry when its 32-session cache is full', async t =>
{
    const { store, identity } = fixture(t);
    const sources = Array.from({ length: 33 }, () => remote());
    const identities = sources.map((_, index) => ({ ...identity, hostId: `remote-${index}` }));
    for (let index = 0; index < 32; index++) await store.getStats(identities[index], sources[index].request);
    await store.getStats(identities[0], sources[0].request);
    await store.getStats(identities[32], sources[32].request);
    sources[1].change(lines(usage('reloaded', 5200)));
    assert.equal((await store.getStats(identities[1], sources[1].request)).totalTokens, 5200);
    assert.equal((await store.getStats(identities[0], sources[0].request)).totalTokens, 1200);
    assert.equal(sources[0].calls.length, 3);
});

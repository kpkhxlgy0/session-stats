'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { test } = require('node:test');
const { createSnapshotRemoteStore } = require('../src/snapshot-remote-store.cjs');

const ThreadId = '11111111-1111-4111-8111-111111111111';
const OtherThreadId = '22222222-2222-4222-8222-222222222222';
const PublisherId = '33333333-3333-4333-8333-333333333333';
const NextPublisherId = '44444444-4444-4444-8444-444444444444';
const HostId = 'remote-control:runner';
const Home = '/home/runner/.codex';
const Directory = `${Home}/.session-stats`;
const File = `${Directory}/${ThreadId}.json`;
const Rollout = `${Home}/sessions/2026/10/25/rollout-2026-10-25T10-00-00-${ThreadId}.jsonl`;
const Metrics = Object.freeze({ turns: 9, steps: 19, totalTokens: 1700, inputTokens: 1300,
    outputTokens: 400, cachedInputTokens: 650, cacheHit: 0.5, tps: 80.25,
    tpsHeld: true, activeTurn: true, modelActiveMs: 4984, status: 'ok' });
const UnavailableMetrics = Object.freeze({ turns: null, steps: null, totalTokens: null, inputTokens: null,
    outputTokens: null, cachedInputTokens: null, cacheHit: null, tps: null,
    tpsHeld: false, activeTurn: false, modelActiveMs: null, status: 'unavailable' });
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function sample(overrides = {})
{
    return { schemaVersion: 1, producer: 'codex-session-stats', threadId: ThreadId,
        publisherId: PublisherId, revision: 1, generatedAt: 100000, stats: { ...Metrics }, ...overrides };
}

function fixture(t, options = {})
{
    const state = { clock: 100000, sample: sample(), calls: [],
        missing: false, hook: null, metadata: null, response: null };
    state.store = createSnapshotRemoteStore({ now: () => state.clock, ...options });
    t.after(() => state.store.dispose());
    state.request = async (method, params, budget) =>
    {
        state.calls.push({ method, params, budget });
        if (state.hook) await state.hook(method, params, budget);
        if (method === 'thread/read') return state.response ?? { thread: { id: ThreadId, path: Rollout } };
        if (method === 'snapshot/request')
        {
            assert.deepEqual(params, { rolloutPath: state.response?.thread.path ?? Rollout, threadId: ThreadId });
            return {};
        }
        assert.ok([Home, Directory, File].includes(params.path), `Unexpected snapshot RPC path: ${params.path}`);
        if (state.missing) throw new Error('No such file');
        if (method === 'fs/getMetadata')
        {
            const value = { isFile: params.path === File, isDirectory: params.path !== File,
                isSymlink: false, createdAtMs: 100, modifiedAtMs: 100 };
            return state.metadata?.(params.path, value) ?? value;
        }
        assert.equal(method, 'fs/readFile');
        return { dataBase64: Buffer.from(typeof state.sample === 'string' ? state.sample : JSON.stringify(state.sample)).toString('base64') };
    };
    state.stats = (identity = { hostId: HostId, threadId: ThreadId }) => state.store.getStats(identity, state.request);
    state.refresh = async () => { state.clock += 2000; await state.stats(); await flush(); return state.stats(); };
    return state;
}

test('the snapshot-only store requires no fallback reader', async t =>
{
    const store = createSnapshotRemoteStore();
    t.after(() => store.dispose());
    const calls = [];
    const stats = await store.getStats({ hostId: HostId, threadId: ThreadId }, async method =>
    {
        calls.push(method);
        throw new Error('Not found');
    });
    assert.equal(stats.status, 'unavailable');
    assert.equal(stats.unavailableReason, 'snapshot-missing');
    assert.deepEqual(calls, ['thread/read']);
});

test('a cold lookup reads only the fixed small snapshot and returns all published fields exactly', async t =>
{
    const source = fixture(t);
    assert.deepEqual(await source.stats(), { ...Metrics, threadId: ThreadId, hostId: HostId, source: 'snapshot',
        snapshotGeneratedAt: 100000, snapshotRevision: 1, snapshotPublisherId: PublisherId });
    assert.equal(source.calls.filter(call => call.method === 'fs/readFile').length, 1);
    assert.equal(source.calls.find(call => call.method === 'fs/readFile').params.path, File);
    assert.equal(source.calls.some(call => call.method === 'fs/readDirectory'), false);
    assert.ok(source.calls.every(call => call.budget?.timeoutMs === 5000 && call.budget?.maxChars === 65536));
    assert.ok(source.calls.filter(call => call.method !== 'snapshot/request')
        .every(call => !Object.hasOwn(call.budget, 'signal')));
});

for (const home of ['D:\\Users\\runner\\.codex', '\\\\?\\D:\\Users\\runner\\.codex'])
{
    test(`snapshot cold lookup supports native Windows home ${home}`, async t =>
    {
        const source = fixture(t);
        const directory = path.win32.join(home, '.session-stats');
        const file = path.win32.join(directory, `${ThreadId}.json`);
        const rollout = path.win32.join(home, 'archived_sessions', path.posix.basename(Rollout));
        source.request = async (method, params, budget) =>
        {
            source.calls.push({ method, params, budget });
            if (method === 'thread/read') return { thread: { id: ThreadId.toUpperCase(), path: rollout } };
            if (method === 'snapshot/request')
            {
                assert.deepEqual(params, { rolloutPath: rollout, threadId: ThreadId });
                return {};
            }
            assert.ok([home, directory, file].includes(params.path));
            if (method === 'fs/getMetadata') return { isFile: params.path === file,
                isDirectory: params.path !== file, isSymlink: false, createdAtMs: 1, modifiedAtMs: 2 };
            assert.equal(method, 'fs/readFile');
            assert.equal(params.path, file);
            return { dataBase64: Buffer.from(JSON.stringify(source.sample)).toString('base64') };
        };
        assert.equal((await source.stats()).source, 'snapshot');
    });
}

for (const identity of [{ hostId: 'local', threadId: ThreadId }, { hostId: 'bad\nrunner', threadId: ThreadId },
    { hostId: 'x'.repeat(513), threadId: ThreadId }, { hostId: HostId, threadId: '../session' },
    { hostId: HostId, threadId: '11111111-1111-0111-8111-111111111111' }])
{
    test(`invalid lookup identity does not issue RPCs (${JSON.stringify(identity)})`, async t =>
    {
        const source = fixture(t);
        assert.equal((await source.stats(identity)).status, 'unavailable');
        assert.equal(source.calls.length, 0);
    });
}

for (const kind of ['thread identity', 'path identity', 'unsupported ancestry'])
{
    test(`native ${kind} validation fails closed before any snapshot read`, async t =>
    {
        const source = fixture(t);
        source.response = { thread: { id: kind === 'thread identity' ? OtherThreadId : ThreadId,
            path: kind === 'path identity' ? Rollout.replace(ThreadId, OtherThreadId)
                : kind === 'unsupported ancestry' ? `/tmp/rollout-2026-10-25T10-00-00-${ThreadId}.jsonl` : Rollout } };
        assert.equal((await source.stats()).status, 'unavailable');
        assert.equal(source.calls.length, 1);
    });
}

for (const target of [Home, Directory, File])
{
    for (const kind of ['symlink', 'wrong type'])
    {
        test(`rejects ${kind} at ${target} before accepting a sample`, async t =>
        {
            const source = fixture(t);
            source.metadata = (value, metadata) => value !== target ? metadata
                : kind === 'symlink' ? { ...metadata, isSymlink: true }
                    : { ...metadata, isDirectory: !metadata.isDirectory, isFile: !metadata.isFile };
            assert.equal((await source.stats()).status, 'unavailable');
        });
    }
}

test('atomic replacement may change file identity and directory modification time during a read', async t =>
{
    const source = fixture(t);
    let captured = false;
    source.hook = method => { if (method === 'fs/readFile') captured = true; };
    source.metadata = (value, metadata) => !captured ? metadata : { ...metadata,
        createdAtMs: value === File ? 999 : metadata.createdAtMs, modifiedAtMs: 999 };
    assert.equal((await source.stats()).status, 'ok');
});

test('a directory swapped to a symlink after payload capture invalidates the sample', async t =>
{
    const source = fixture(t);
    let captured = false;
    source.hook = method => { if (method === 'fs/readFile') captured = true; };
    source.metadata = (value, metadata) => value === Directory && captured ? { ...metadata, isSymlink: true } : metadata;
    assert.equal((await source.stats()).status, 'unavailable');
});

for (const [kind, change, reason] of [
    ['schema', value => ({ ...value, schemaVersion: 2 }), 'snapshot-invalid'],
    ['thread', value => ({ ...value, threadId: OtherThreadId }), 'snapshot-identity'],
    ['future', value => ({ ...value, generatedAt: 105001 }), 'snapshot-future'],
    ['number', value => ({ ...value, stats: { ...Metrics, totalTokens: -1 } }), 'snapshot-invalid'],
    ['oversized decoded file', () => ' '.repeat(16385), 'snapshot-invalid'],
    ['malformed JSON', () => '{', 'snapshot-invalid'],
])
{
    test(`a ${kind} rejection returns an explicit unavailable reason`, async t =>
    {
        const source = fixture(t);
        source.sample = change(source.sample);
        const stats = await source.stats();
        assert.equal(stats.status, 'unavailable');
        assert.equal(stats.unavailableReason, reason);
    });
}

test('rejects malformed and oversized base64 before accepting snapshot content', async t =>
{
    for (const dataBase64 of ['A===', 'a'.repeat(65536), Buffer.alloc(16385).toString('base64')])
    {
        const source = fixture(t);
        const request = source.request;
        source.request = async (method, params, options) => method === 'fs/readFile'
            ? { dataBase64 } : request(method, params, options);
        assert.equal((await source.stats()).unavailableReason, 'snapshot-invalid');
    }
});

test('accepts the clock-skew boundary and rejects a cached sample after local clock reversal', async t =>
{
    const source = fixture(t);
    source.sample.generatedAt = 105000;
    assert.equal((await source.stats()).status, 'ok');
    source.clock = 99999;
    assert.equal((await source.stats()).unavailableReason, 'snapshot-future');
});

for (const kind of ['lower revision', 'changed same revision', 'earlier timestamp'])
{
    test(`publisher ${kind} invalidates accepted values`, async t =>
    {
        const source = fixture(t);
        source.sample.revision = 2;
        assert.equal((await source.stats()).status, 'ok');
        source.sample = sample({ revision: kind === 'lower revision' ? 1 : 2,
            generatedAt: kind === 'earlier timestamp' ? 99999 : 100000,
            stats: kind === 'changed same revision' ? { ...Metrics, turns: 10 } : { ...Metrics } });
        const stats = await source.refresh();
        assert.equal(stats.unavailableReason, 'snapshot-replay');
        assert.equal(stats.totalTokens, null);
    });
}

test('identical repeated revisions remain accepted', async t =>
{
    const source = fixture(t);
    await source.stats();
    assert.equal((await source.refresh()).snapshotRevision, 1);
});

test('publisher restart requires a later timestamp and retires the previous publisher', async t =>
{
    const source = fixture(t);
    await source.stats();
    source.sample = sample({ publisherId: NextPublisherId, generatedAt: 100001 });
    assert.equal((await source.refresh()).snapshotPublisherId, NextPublisherId);
    source.sample = sample({ revision: 99, generatedAt: 104001 });
    assert.equal((await source.refresh()).unavailableReason, 'snapshot-replay');
});

test('publisher changes with the same timestamp fail closed', async t =>
{
    const source = fixture(t);
    await source.stats();
    source.sample.publisherId = NextPublisherId;
    assert.equal((await source.refresh()).unavailableReason, 'snapshot-replay');
});

test('retired publisher history is bounded without forgetting old replay protection', async t =>
{
    const source = fixture(t);
    await source.stats();
    for (let index = 1; index <= 33; index++)
    {
        source.sample = sample({ publisherId: `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
            generatedAt: 100000 + index * 2000 });
        const stats = await source.refresh();
        assert.equal(stats.status, index <= 32 ? 'ok' : 'unavailable');
    }
    source.sample = sample({ revision: 99, generatedAt: source.clock });
    assert.equal((await source.refresh()).unavailableReason, 'snapshot-replay');
});

for (const [kind, reason] of [['missing', 'snapshot-missing'], ['read failure', 'snapshot-read-failed'],
    ['expired', 'snapshot-expired']])
{
    test(`${kind} snapshots return a reason and retry only the fixed snapshot RPCs`, async t =>
    {
        const source = fixture(t);
        if (kind === 'missing') source.missing = true;
        if (kind === 'read failure') source.hook = method =>
        {
            if (method === 'fs/readFile') throw new Error('Disconnected');
        };
        if (kind === 'expired') source.clock = 130001;
        for (let index = 0; index < 3; index++)
        {
            const stats = index === 0 ? await source.stats() : await source.refresh();
            assert.equal(stats.status, 'unavailable');
            assert.equal(stats.unavailableReason, reason);
            assert.equal(stats.totalTokens, null);
        }
        assert.ok(source.calls.filter(call => call.method === 'thread/read').length >= 3);
        assert.ok(source.calls.every(call => call.method === 'thread/read'
            || call.method === 'snapshot/request' && call.params.rolloutPath === Rollout && call.params.threadId === ThreadId
            || call.method === 'fs/getMetadata' && [Home, Directory, File].includes(call.params.path)
            || call.method === 'fs/readFile' && call.params.path === File));
        assert.equal(source.calls.some(call => call.method === 'fs/readDirectory'), false);
    });
}

test('a prior sample expires while a fresh snapshot probe is still pending', async t =>
{
    const source = fixture(t, { responseWaitMs: 0 });
    await source.stats();
    await flush();
    const gate = deferred();
    source.hook = () => gate.promise;
    source.clock = 130001;
    const stats = await source.stats();
    assert.equal(stats.status, 'unavailable');
    assert.equal(stats.totalTokens, null);
    assert.equal(stats.unavailableReason, 'snapshot-expired');
    source.store.dispose();
    gate.resolve();
});

test('an older missing snapshot requests one bounded runner sample and accepts a later publication', async t =>
{
    const source = fixture(t);
    const rolloutPath = Rollout.replaceAll('2026/10/25', '2020/01/01').replace('2026-10-25T10-00-00', '2020-01-01T10-00-00');
    source.response = { thread: { id: ThreadId, path: rolloutPath } };
    source.missing = true;
    assert.equal((await source.stats()).unavailableReason, 'snapshot-missing');
    const demands = source.calls.filter(call => call.method === 'snapshot/request');
    assert.equal(demands.length, 1);
    assert.deepEqual(demands[0].params, { rolloutPath, threadId: ThreadId });
    assert.equal(demands[0].budget.timeoutMs, 5000);
    assert.equal(demands[0].budget.maxChars, 65536);
    assert.ok(demands[0].budget.signal instanceof AbortSignal);
    source.missing = false;
    source.sample = sample({ generatedAt: 102000 });
    assert.equal((await source.refresh()).source, 'snapshot');
    assert.equal(source.calls.filter(call => call.method === 'snapshot/request').length, 1);
});

test('fresh snapshot polling renews runner demand no more than once per ten seconds', async t =>
{
    const source = fixture(t);
    await source.stats();
    for (let index = 0; index < 4; index++) await source.refresh();
    assert.equal(source.calls.filter(call => call.method === 'snapshot/request').length, 1);
    assert.equal((await source.refresh()).source, 'snapshot');
    assert.equal(source.calls.filter(call => call.method === 'snapshot/request').length, 2);
    assert.equal(source.calls.filter(call => call.method === 'fs/readFile').length, 6);
});

test('failed demand leases do not invalidate fresh metrics or create a rapid retry loop', async t =>
{
    const source = fixture(t);
    source.hook = method => { if (method === 'snapshot/request') throw new Error('Request directory unavailable'); };
    assert.equal((await source.stats()).status, 'ok');
    for (let index = 0; index < 4; index++) assert.equal((await source.refresh()).source, 'snapshot');
    assert.equal(source.calls.filter(call => call.method === 'snapshot/request').length, 1);
});

test('an in-flight demand never delays snapshot reads and disposal cancels its wrapper', async t =>
{
    const source = fixture(t);
    const gate = deferred();
    let signal;
    source.hook = (method, params, budget) =>
    {
        if (method !== 'snapshot/request') return;
        signal = budget.signal;
        return gate.promise;
    };
    const start = performance.now();
    assert.equal((await source.stats()).source, 'snapshot');
    assert.ok(performance.now() - start < 500);
    assert.equal(source.calls.filter(call => call.method === 'snapshot/request').length, 1);
    assert.equal(signal?.aborted, false);
    source.store.dispose();
    assert.equal(signal.aborted, true);
    const count = source.calls.length;
    gate.resolve();
    await flush();
    assert.equal(source.calls.length, count);
    assert.equal((await source.stats()).status, 'unavailable');
});

test('demand timeout aborts its helper without changing a fresh accepted snapshot', async t =>
{
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const source = fixture(t);
    let signal;
    source.hook = (method, params, budget) =>
    {
        if (method !== 'snapshot/request') return;
        signal = budget.signal;
        return new Promise(() => {});
    };
    assert.equal((await source.stats()).source, 'snapshot');
    assert.equal(signal?.aborted, false);
    t.mock.timers.tick(5000);
    await flush();
    assert.equal(signal.aborted, true);
    assert.equal((await source.stats()).status, 'ok');
    assert.equal(source.calls.filter(call => call.method === 'snapshot/request').length, 1);
});

test('evicting a host-thread entry aborts its outstanding demand helper', async t =>
{
    const source = fixture(t);
    let signal;
    source.hook = (method, params, budget) =>
    {
        if (method !== 'snapshot/request' || signal) return;
        signal = budget.signal;
        return new Promise(() => {});
    };
    await source.stats();
    assert.equal(signal?.aborted, false);
    for (let index = 0; index < 32; index++)
        await source.stats({ hostId: `remote-control:evict-${index}`, threadId: ThreadId });
    assert.equal(signal.aborted, true);
});

test('runner demand leases are isolated when the lookup switches remote hosts', async t =>
{
    const source = fixture(t);
    const demands = [];
    const request = hostId => (method, params, budget) =>
    {
        if (method === 'snapshot/request') demands.push(hostId);
        return source.request(method, params, budget);
    };
    const otherHost = 'remote-control:another-runner';
    assert.equal((await source.store.getStats({ hostId: HostId, threadId: ThreadId }, request(HostId))).status, 'ok');
    assert.equal((await source.store.getStats({ hostId: otherHost, threadId: ThreadId }, request(otherHost))).status, 'ok');
    source.clock += 2000;
    await source.store.getStats({ hostId: HostId, threadId: ThreadId }, request(HostId));
    await flush();
    assert.deepEqual(demands, [HostId, otherHost]);
});

test('a transient read failure keeps an accepted sample only until its TTL', async t =>
{
    const source = fixture(t);
    await source.stats();
    source.missing = true;
    assert.equal((await source.refresh()).source, 'snapshot');
    source.clock = 130000;
    assert.equal((await source.stats()).source, 'snapshot');
    source.clock = 130001;
    const expired = await source.stats();
    assert.equal(expired.status, 'unavailable');
    assert.equal(expired.totalTokens, null);
    assert.equal(expired.unavailableReason, 'snapshot-expired');
});

test('fresh producer source failure immediately clears metrics', async t =>
{
    const source = fixture(t);
    await source.stats();
    source.sample = sample({ revision: 2, generatedAt: 100001, stats: { ...UnavailableMetrics } });
    const stats = await source.refresh();
    assert.equal(stats.status, 'unavailable');
    assert.equal(stats.unavailableReason, 'source-unavailable');
    assert.equal(stats.totalTokens, null);
    source.clock = 130002;
    await source.stats();
    await flush();
    assert.equal((await source.stats()).unavailableReason, 'snapshot-expired');
});

test('a transient probe failure preserves a fresh producer failure reason', async t =>
{
    const source = fixture(t);
    source.sample = sample({ stats: { ...UnavailableMetrics } });
    assert.equal((await source.stats()).unavailableReason, 'source-unavailable');
    source.missing = true;
    assert.equal((await source.refresh()).unavailableReason, 'source-unavailable');
});

test('snapshot probes recover when the runner begins publishing its sample', async t =>
{
    const source = fixture(t);
    source.missing = true;
    assert.equal((await source.stats()).unavailableReason, 'snapshot-missing');
    source.missing = false;
    source.sample = sample({ revision: 3, generatedAt: 102000 });
    assert.equal((await source.refresh()).snapshotRevision, 3);
    assert.equal((await source.stats()).source, 'snapshot');
});

test('an invalid sample clears accepted values until a valid snapshot is received', async t =>
{
    const source = fixture(t);
    assert.equal((await source.stats()).status, 'ok');
    source.sample = sample({ schemaVersion: 9 });
    assert.equal((await source.refresh()).unavailableReason, 'snapshot-invalid');
    source.missing = true;
    assert.equal((await source.refresh()).unavailableReason, 'snapshot-invalid');
    source.missing = false;
    source.sample = sample({ revision: 2, generatedAt: 106000 });
    assert.equal((await source.refresh()).status, 'ok');
});

test('concurrent cold calls coalesce and each returns within its UI wait budget', async t =>
{
    const source = fixture(t, { responseWaitMs: 25 });
    const gate = deferred();
    source.hook = () => gate.promise;
    const start = performance.now();
    const values = await Promise.all([source.stats(), source.stats(), source.stats()]);
    assert.ok(performance.now() - start < 500);
    assert.ok(values.every(value => value.unavailableReason === 'snapshot-loading'));
    assert.equal(source.calls.length, 1);
    gate.resolve();
    await flush();
    assert.equal((await source.stats()).source, 'snapshot');
});

test('the UI wait option cannot exceed the 750 ms hard limit', async t =>
{
    const source = fixture(t, { responseWaitMs: 5000 });
    source.hook = () => new Promise(() => {});
    let timer;
    const stats = await Promise.race([source.stats(), new Promise(resolve =>
    {
        timer = setTimeout(() => resolve(null), 1100);
    })]);
    clearTimeout(timer);
    assert.equal(stats?.unavailableReason, 'snapshot-loading');
});

test('a snapshot request times out after five seconds even if the transport callback never settles', async t =>
{
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const source = fixture(t);
    source.hook = () => new Promise(() => {});
    const pending = source.stats();
    await flush();
    t.mock.timers.tick(750);
    assert.equal((await pending).unavailableReason, 'snapshot-loading');
    t.mock.timers.tick(4250);
    await flush();
    assert.equal((await source.stats()).unavailableReason, 'snapshot-read-failed');
    assert.equal(source.calls.length, 1);
});

test('publisher revision histories remain isolated across remote hosts', async t =>
{
    const source = fixture(t);
    source.sample.revision = 10;
    assert.equal((await source.stats()).snapshotRevision, 10);
    source.sample.revision = 1;
    const other = await source.stats({ hostId: 'remote-control:other-runner', threadId: ThreadId });
    assert.equal(other.status, 'ok');
    assert.equal(other.snapshotRevision, 1);
    assert.equal((await source.refresh()).unavailableReason, 'snapshot-replay');
});

test('disposal releases pending calls and stops follow-up RPCs', async t =>
{
    const source = fixture(t);
    const gate = deferred();
    source.hook = () => gate.promise;
    const pending = source.stats();
    await flush();
    source.store.dispose();
    assert.equal((await pending).status, 'unavailable');
    gate.resolve();
    await flush();
    assert.equal(source.calls.length, 1);
    assert.equal((await source.stats()).status, 'unavailable');
});

test('cache eviction cancels old entries and isolates replay state by host', async t =>
{
    const source = fixture(t, { responseWaitMs: 0 });
    const gate = deferred();
    let first = true;
    source.hook = () => { if (first) { first = false; return gate.promise; } };
    await source.stats();
    await flush();
    for (let index = 0; index < 32; index++)
    {
        await source.stats({ hostId: `remote-control:runner-${index}`, threadId: ThreadId });
        await flush();
    }
    const calls = source.calls.length;
    gate.resolve();
    await flush();
    assert.equal(source.calls.length, calls);
    source.sample = sample({ revision: 2, generatedAt: source.clock + 1 });
    await source.stats({ hostId: 'remote-control:runner-31', threadId: ThreadId });
    source.sample = sample();
    await source.stats();
    await flush();
    assert.equal((await source.stats()).status, 'ok');
});

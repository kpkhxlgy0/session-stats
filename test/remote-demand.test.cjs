'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSnapshotRemoteStore } = require('../src/snapshot-remote-store.cjs');
const { createSnapshotProtocol } = require('../src/snapshot.cjs');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const Owner = 'view-one', Other = 'view-two';
const Host = 'remote-control:runner';
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(t)
{
    let time = 100000;
    const calls = [], protocol = createSnapshotProtocol();
    const store = createSnapshotRemoteStore({ now: () => time });
    t.after(() => store.dispose());
    const request = async (method, params) =>
    {
        calls.push({ method, params });
        if (method === 'snapshot/request' || method === 'snapshot/release') return {};
        if (method === 'thread/read') return { thread: { id: params.threadId,
            path: `/home/.codex/sessions/rollout-2026-11-13-${params.threadId}.jsonl` } };
        if (method === 'fs/getMetadata') return { isFile: params.path.endsWith('.json'),
            isDirectory: !params.path.endsWith('.json'), isSymlink: false, createdAtMs: 1, modifiedAtMs: 1 };
        const id = params.path.includes(A) ? A : B;
        return { dataBase64: Buffer.from(JSON.stringify(protocol.makeSnapshot(id,
            { status: 'not-found' }, { publisherId: A, revision: 1, now: time }))).toString('base64') };
    };
    return { calls, store, request, setTime: value => { time = value; },
        get: (threadId = A, ownerId = Owner) => store.getStats({ hostId: Host, threadId, ownerId }, request) };
}

test('remote renewals use a stable consumer identity and last-owner release sends a cancel', async t =>
{
    const f = fixture(t);
    await f.get();
    await f.get(A, Other);
    const first = f.calls.find(call => call.method === 'snapshot/request');
    assert.match(first.params.consumerId, /^[0-9a-f-]{36}$/);
    f.setTime(102001);
    await f.get();
    await flush();
    const renewals = f.calls.filter(call => call.method === 'snapshot/request');
    assert.equal(renewals.length, 2);
    assert.equal(renewals[1].params.consumerId, first.params.consumerId);
    await f.store.release(Owner);
    assert.equal(f.calls.filter(call => call.method === 'snapshot/release').length, 0);
    await f.store.release(Other);
    const cancelled = f.calls.filter(call => call.method === 'snapshot/release');
    assert.equal(cancelled.length, 1);
    assert.equal(cancelled[0].params.consumerId, first.params.consumerId);
});

test('switching an owner cancels old remote probes before they can request follow-up work', async t =>
{
    const f = fixture(t);
    let finish;
    const blocked = new Promise(resolve => { finish = resolve; });
    const calls = [];
    const request = async (method, params) =>
    {
        calls.push({ method, params });
        if (method === 'thread/read' && params.threadId === A) return blocked;
        return f.request(method, params);
    };
    const old = f.store.getStats({ hostId: Host, threadId: A, ownerId: Owner }, request);
    await flush();
    await f.store.getStats({ hostId: Host, threadId: B, ownerId: Owner }, request);
    finish({ thread: { id: A, path: `/home/.codex/sessions/rollout-2026-11-13-${A}.jsonl` } });
    assert.equal((await old).status, 'unavailable');
    await flush();
    assert.equal(calls.filter(call => call.method === 'snapshot/request' && call.params.threadId === A).length, 0);
    assert.equal(calls.filter(call => call.method === 'fs/getMetadata' && call.params.path.includes(A)).length, 0);
});

test('consumer markers bind identity, cancellation and the short freshness boundary', () =>
{
    const p = createSnapshotProtocol();
    const text = JSON.stringify(p.makeRequest(A, { consumerId: B, active: true, now: 100000 }));
    assert.equal(p.parseRequest(text, { threadId: A, consumerId: B, now: 108000 }).ok, true);
    assert.equal(p.parseRequest(text, { threadId: A, consumerId: B, now: 108001 }).reason, 'expired');
    assert.equal(p.parseRequest(text, { threadId: A, consumerId: A, now: 100000 }).reason, 'identity');
    const cancelled = JSON.stringify(p.makeRequest(A, { consumerId: B, active: false, now: 100001 }));
    assert.equal(p.parseRequest(cancelled, { threadId: A, consumerId: B, now: 100001 }).request.active, false);
});

test('a visible owner renews throughout a snapshot probe longer than its lease and release stops it', async t =>
{
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let time = 100000, finishMetadata, finishFile;
    const metadata = new Promise(resolve => { finishMetadata = resolve; });
    const file = new Promise(resolve => { finishFile = resolve; });
    const calls = [];
    const store = createSnapshotRemoteStore({ now: () => time, responseWaitMs: 0 });
    t.after(() => store.dispose());
    const rolloutPath = `/home/.codex/sessions/rollout-2026-11-13-${A}.jsonl`;
    const request = async (method, params) =>
    {
        calls.push({ method, params, at: time });
        if (method === 'thread/read') return { thread: { id: A, path: rolloutPath } };
        if (method.startsWith('snapshot/')) return {};
        if (method === 'fs/getMetadata')
        {
            await metadata;
            return { isFile: params.path.endsWith('.json'), isDirectory: !params.path.endsWith('.json'),
                isSymlink: false, createdAtMs: 1, modifiedAtMs: 1 };
        }
        return file;
    };
    const get = async () =>
    {
        const work = store.getStats({ hostId: Host, threadId: A, ownerId: Owner }, request);
        await flush(); t.mock.timers.tick(0); await work;
    };
    const advance = async value =>
    {
        t.mock.timers.tick(value - time); time = value; await get();
    };
    await get();
    await advance(102000);
    await advance(104000);
    t.mock.timers.tick(900); time = 104900; finishMetadata(); await flush();
    await advance(106900);
    await advance(108100);
    const leases = calls.filter(call => call.method === 'snapshot/request');
    assert.deepEqual(leases.map(call => call.at), [100000, 102000, 104000, 106900]);
    assert.ok(leases.every(call => call.params.rolloutPath === rolloutPath
        && call.params.consumerId === leases[0].params.consumerId));
    assert.equal(calls.filter(call => call.method === 'fs/readFile').length, 1, 'the original probe is still pending');
    await store.release(Owner);
    const count = calls.length;
    const p = createSnapshotProtocol();
    finishFile({ dataBase64: Buffer.from(JSON.stringify(p.makeSnapshot(A,
        { status: 'not-found' }, { publisherId: B, revision: 1, now: time }))).toString('base64') });
    t.mock.timers.tick(20000); time += 20000; await flush();
    assert.equal(calls.length, count, 'late probe completion cannot renew or start confirmation RPCs');
    assert.equal(calls.at(-1).method, 'snapshot/release');
});

test('a released in-flight renewal cannot reclaim its old consumer when the view returns', async t =>
{
    const f = fixture(t);
    let finishRenewal, renewalSignal;
    const pending = new Promise(resolve => { finishRenewal = resolve; });
    const calls = [];
    const request = (method, params, budget) =>
    {
        calls.push({ method, params });
        if (method === 'snapshot/request' && calls.filter(call => call.method === method).length === 2)
        {
            renewalSignal = budget.signal;
            return pending;
        }
        return f.request(method, params, budget);
    };
    const get = () => f.store.getStats({ hostId: Host, threadId: A, ownerId: Owner }, request);
    await get();
    f.setTime(102001); await get(); await flush();
    assert.equal(renewalSignal?.aborted, false);
    const original = calls.find(call => call.method === 'snapshot/request').params.consumerId;
    await f.store.release(Owner);
    assert.equal(renewalSignal.aborted, true);
    const cancelled = calls.find(call => call.method === 'snapshot/release');
    assert.equal(cancelled.params.consumerId, original);
    const count = calls.length;
    finishRenewal({}); await flush();
    assert.equal(calls.length, count);
    await get(); await flush();
    const next = calls.filter(call => call.method === 'snapshot/request').at(-1);
    assert.notEqual(next.params.consumerId, original);
});

test('unverified thread paths never acquire renewal interest while the view keeps polling', async t =>
{
    for (const thread of [{ id: B, path: `/home/.codex/sessions/rollout-2026-11-13-${A}.jsonl` },
        { id: A, path: `/elsewhere/rollout-2026-11-13-${A}.jsonl` }])
    {
        const f = fixture(t), methods = [];
        const request = async method => { methods.push(method); return { thread }; };
        for (const time of [100000, 102001, 104002])
        {
            f.setTime(time);
            await f.store.getStats({ hostId: Host, threadId: A, ownerId: Owner }, request);
            await flush();
        }
        assert.deepEqual(methods, ['thread/read', 'thread/read', 'thread/read']);
    }
});

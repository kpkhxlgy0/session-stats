'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createSnapshotPublisher } = require('../src/snapshot-publisher.cjs');
const { createSessionStore } = require('../src/session-store.cjs');

function id(number) { return `${number.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`; }
const RequestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const Stats = { turns: 1, steps: 0, totalTokens: 1200, inputTokens: 200, outputTokens: 1000,
    cachedInputTokens: 100, modelActiveMs: 0, cacheHit: 0.5, tps: null,
    tpsHeld: false, activeTurn: false, status: 'ok' };
const marker = (threadId, requestedAt) => JSON.stringify({ schemaVersion: 1,
    producer: 'codex-session-stats-request', threadId, requestedAt });

function deferred()
{
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

async function eventually(check)
{
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline)
    {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('Expected demand publication before deadline');
}

async function exists(file)
{
    try { await fs.access(file); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function fixture(t, options = {})
{
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-snapshot-demand-'));
    let time = 100000;
    const calls = [];
    const store = options.store || { async getStats(threadId) { calls.push(threadId); return { ...Stats }; } };
    const publisher = createSnapshotPublisher({ codexHome: root, store, now: () => time,
        discover: async () => [], ...options });
    t.after(async () => { await publisher.dispose(); await fs.rm(root, { recursive: true, force: true }); });
    const requests = path.join(root, '.session-stats', 'requests');
    return { root, requests, publisher, calls, store, setTime: value => { time = value; },
        snapshot: threadId => path.join(root, '.session-stats', `${threadId}.json`),
        request: (threadId, requestId = RequestId) => path.join(requests, `${threadId}.${requestId}.json`),
        write: async (threadId, requestedAt = time, requestId = RequestId) =>
            fs.writeFile(path.join(requests, `${threadId}.${requestId}.json`), marker(threadId, requestedAt), { flag: 'wx' }) };
}

test('a remote demand marker publishes an older real session outside the eight recent IDs without local interest', async t =>
{
    let local;
    const f = await fixture(t, { discover: undefined, store: { getStats: threadId => local.getStats(threadId) } });
    local = createSessionStore({ codexHome: f.root });
    t.after(() => local.dispose());
    const sessions = path.join(f.root, 'sessions');
    await fs.mkdir(sessions);
    for (const number of [99, 1, 2, 3, 4, 5, 6, 7, 8])
    {
        const file = path.join(sessions, `rollout-2026-10-25T12-00-00-${id(number)}.jsonl`);
        await fs.writeFile(file, JSON.stringify({ type: 'token_usage_record', payload: {
            thread_token_usage: { input_tokens: 200, output_tokens: 1000, cached_input_tokens: 100,
                total_tokens: number === 99 ? 4321 : 1200 } } }) + '\n');
        await fs.utimes(file, number === 99 ? 1 : 10 + number, number === 99 ? 1 : 10 + number);
    }
    await f.publisher.start();
    assert.equal(await exists(f.snapshot(id(99))), false);
    assert.equal((await fs.lstat(f.requests)).isDirectory(), true);
    await f.write(id(99));
    await f.publisher.refresh();
    await eventually(() => exists(f.snapshot(id(99))));
    const published = JSON.parse(await fs.readFile(f.snapshot(id(99)), 'utf8'));
    assert.equal(published.threadId, id(99));
    assert.equal(published.stats.totalTokens, 4321);
    assert.equal(published.stats.status, 'ok');
});

test('the demand pump runs while a recent background source remains blocked', async t =>
{
    const blocked = deferred(), entered = deferred();
    const f = await fixture(t, { pollMs: 5, discover: async () => [id(1)], store: { async getStats(threadId)
    {
        if (threadId === id(1)) { entered.resolve(); await blocked.promise; }
        return { ...Stats };
    } } });
    const starting = f.publisher.start();
    await entered.promise;
    await eventually(() => exists(f.requests));
    await f.write(id(99));
    try { await eventually(() => exists(f.snapshot(id(99)))); }
    finally { blocked.resolve(); await starting; }
    assert.equal(JSON.parse(await fs.readFile(f.snapshot(id(99)), 'utf8')).threadId, id(99));
});

test('the demand pump runs while recent filesystem discovery remains blocked', async t =>
{
    const blocked = deferred(), entered = deferred();
    const f = await fixture(t, { pollMs: 5, discover: async () => { entered.resolve(); return blocked.promise; } });
    const starting = f.publisher.start();
    await entered.promise;
    await eventually(() => exists(f.requests));
    await f.write(id(99));
    try { await eventually(() => exists(f.snapshot(id(99)))); }
    finally { blocked.resolve([]); await starting; }
});

test('only fresh matching request records initiate publication and unknown files survive cleanup', async t =>
{
    const f = await fixture(t);
    await fs.mkdir(f.requests, { recursive: true });
    await f.write(id(1), 70000);
    await f.write(id(2), 69999);
    await f.write(id(3), 105001);
    await fs.writeFile(f.request(id(4)), marker(id(5), 100000));
    await fs.writeFile(f.request(id(6)), 'unknown');
    await fs.writeFile(f.request(id(7)), marker(id(7), 100000) + ' '.repeat(1024));
    await fs.writeFile(path.join(f.requests, '.unknown.tmp'), 'keep');
    await f.publisher.refresh();
    await eventually(() => exists(f.snapshot(id(1))));
    assert.deepEqual(f.calls, [id(1)]);
    assert.equal(await exists(f.request(id(2))), false);
    assert.equal(await fs.readFile(f.request(id(3)), 'utf8'), marker(id(3), 105001));
    assert.equal(await fs.readFile(f.request(id(4)), 'utf8'), marker(id(5), 100000));
    assert.equal(await fs.readFile(f.request(id(6)), 'utf8'), 'unknown');
    assert.equal(await fs.readFile(path.join(f.requests, '.unknown.tmp'), 'utf8'), 'keep');
});

test('renewed marker leases keep demand active and expired demand-only interest stops polling', async t =>
{
    const f = await fixture(t);
    await fs.mkdir(f.requests, { recursive: true });
    await f.write(id(1));
    await f.publisher.refresh();
    await eventually(() => exists(f.snapshot(id(1))));
    await f.publisher.refresh();
    f.setTime(125000);
    await f.write(id(1), 125000, id(900));
    await f.publisher.refresh();
    await f.publisher.refresh();
    f.setTime(140001);
    f.calls.length = 0;
    await f.publisher.refresh();
    await eventually(() => f.calls.length > 0);
    assert.equal(f.calls.includes(id(1)), true);
    f.setTime(155001);
    f.calls.length = 0;
    await f.publisher.refresh();
    assert.deepEqual(f.calls, []);
    assert.equal(await exists(f.request(id(1))), false);
    assert.equal(await exists(f.request(id(1), id(900))), false);
    assert.equal(await exists(f.snapshot(id(1))), true);
});

test('expired marker cleanup retains explicit interest and skips symlink requests', async t =>
{
    const f = await fixture(t);
    await f.publisher.getStats(id(1));
    await fs.mkdir(f.requests);
    await f.write(id(1), 69999);
    const outside = path.join(f.root, 'outside.json');
    await fs.writeFile(outside, marker(id(2), 100000));
    try { await fs.symlink(outside, f.request(id(2)), 'file'); }
    catch (error) { if (error.code !== 'EPERM') throw error; }
    f.calls.length = 0;
    await f.publisher.refresh();
    assert.deepEqual(f.calls, [id(1)]);
    assert.equal(await fs.readFile(outside, 'utf8'), marker(id(2), 100000));
    await f.publisher.dispose();
    assert.equal(await exists(f.snapshot(id(1))), true);
});

test('a linked request directory is rejected and stopping prevents a late demanded source from publishing', async t =>
{
    const f = await fixture(t);
    const outside = path.join(f.root, 'outside');
    await fs.mkdir(outside);
    await fs.mkdir(path.dirname(f.requests));
    await fs.symlink(outside, f.requests, process.platform === 'win32' ? 'junction' : 'dir');
    await fs.writeFile(path.join(outside, `${id(1)}.${RequestId}.json`), marker(id(1), 100000));
    await f.publisher.refresh();
    assert.deepEqual(f.calls, []);
    assert.equal(await exists(f.snapshot(id(1))), false);

    const blocked = deferred(), entered = deferred();
    const stopped = await fixture(t, { store: { async getStats() { entered.resolve(); return blocked.promise; } } });
    await fs.mkdir(stopped.requests, { recursive: true });
    await stopped.write(id(1));
    const refreshing = stopped.publisher.refresh();
    await entered.promise;
    await stopped.publisher.dispose();
    blocked.resolve({ ...Stats });
    await refreshing;
    assert.equal(await exists(stopped.snapshot(id(1))), false);
    assert.deepEqual(await fs.readdir(stopped.requests), [`${id(1)}.${RequestId}.json`]);
});

test('expiry unlink of an old nonce cannot delete a concurrently created renewal marker', async t =>
{
    const blocked = deferred(), entered = deferred();
    const f = await fixture(t);
    await fs.mkdir(f.requests, { recursive: true });
    await f.write(id(1), 69999);
    const originalUnlink = fs.unlink;
    fs.unlink = async filename =>
    {
        if (filename === f.request(id(1))) { entered.resolve(); await blocked.promise; }
        return originalUnlink(filename);
    };
    try
    {
        const refreshing = f.publisher.refresh();
        await entered.promise;
        await f.write(id(1), 100000, id(900));
        blocked.resolve();
        await refreshing;
    }
    finally { blocked.resolve(); fs.unlink = originalUnlink; }
    assert.equal(await exists(f.request(id(1))), false);
    assert.equal(await fs.readFile(f.request(id(1), id(900)), 'utf8'), marker(id(1), 100000));
    await f.publisher.refresh();
    await eventually(() => exists(f.snapshot(id(1))));
});

test('disposal waits for an active demanded temporary write and cleans it before returning', async t =>
{
    const blocked = deferred(), entered = deferred();
    const f = await fixture(t);
    await fs.mkdir(f.requests, { recursive: true });
    await f.write(id(1));
    const originalOpen = fs.open;
    fs.open = async (filename, ...args) =>
    {
        const handle = await originalOpen(filename, ...args);
        if (String(filename).startsWith(path.dirname(f.requests)) && String(filename).endsWith('.tmp'))
        {
            entered.resolve();
            await blocked.promise;
        }
        return handle;
    };
    try
    {
        const refreshing = f.publisher.refresh();
        await entered.promise;
        let disposed = false;
        const disposing = f.publisher.dispose().then(() => { disposed = true; });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(disposed, false);
        blocked.resolve();
        await Promise.all([disposing, refreshing]);
    }
    finally { blocked.resolve(); fs.open = originalOpen; }
    assert.equal(await exists(f.snapshot(id(1))), false);
    assert.deepEqual(await fs.readdir(path.dirname(f.requests)), ['requests']);
    assert.deepEqual(await fs.readdir(f.requests), [`${id(1)}.${RequestId}.json`]);
});

test('multiple fresh nonce markers use the latest request time regardless of enumeration order', async t =>
{
    const f = await fixture(t);
    await fs.mkdir(f.requests, { recursive: true });
    await f.write(id(1), 100000, id(900));
    await f.write(id(1), 80000, id(901));
    await f.publisher.refresh();
    await eventually(() => exists(f.snapshot(id(1))));
    await f.publisher.refresh();
    f.setTime(115001);
    f.calls.length = 0;
    await f.publisher.refresh();
    await eventually(() => f.calls.length > 0);
    assert.equal(await exists(f.request(id(1), id(900))), true);
    assert.equal(await exists(f.request(id(1), id(901))), false);
    f.setTime(130001);
    f.calls.length = 0;
    await f.publisher.refresh();
    assert.deepEqual(f.calls, []);
});

test('demand directory setup cannot write into a watched installation', async t =>
{
    const f = await fixture(t);
    const publisher = createSnapshotPublisher({ codexHome: f.root, installationRoot: f.root,
        store: f.store, discover: async () => [] });
    try { await publisher.start(); }
    finally { await publisher.dispose(); }
    assert.deepEqual(await fs.readdir(f.root), []);
});

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createSessionStore } = require('../src/session-store.cjs');
const { createSnapshotPublisher } = require('../src/snapshot-publisher.cjs');

const ThreadId = '11111111-1111-4111-8111-111111111111';
const OtherThreadId = '22222222-2222-4222-8222-222222222222';
const PublisherId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const Stats = Object.freeze({ turns: 1, steps: 2, totalTokens: 1200, inputTokens: 200,
    outputTokens: 1000, cachedInputTokens: 100, cacheHit: 0.5, tps: 200, tpsHeld: false,
    activeTurn: false, modelActiveMs: 5000, status: 'ok' });

function id(number)
{
    return `${number.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
}

async function fixture(t, options = {})
{
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-snapshot-publisher-'));
    const codexHome = path.join(root, '.codex');
    await fs.mkdir(codexHome);
    let time = 100000;
    const store = options.store || { getStats: async () => ({ ...Stats }) };
    const publisher = createSnapshotPublisher({ codexHome, store, publisherId: PublisherId,
        now: () => time, discover: async () => [], ...options });
    t.after(async () =>
    {
        await publisher.dispose();
        store.dispose?.();
        await fs.rm(root, { recursive: true, force: true });
    });
    return { root, codexHome, publisher, store,
        setTime: value => { time = value; },
        filename: threadId => path.join(codexHome, '.session-stats', `${threadId}.json`),
        read: async threadId => JSON.parse(await fs.readFile(
            path.join(codexHome, '.session-stats', `${threadId}.json`), 'utf8')) };
}

async function writeSession(home, threadId, { archive = false, depth = 3, content = '' } = {})
{
    const directory = path.join(home, archive ? 'archived_sessions' : 'sessions',
        ...['2026', '10', '25', 'too-deep'].slice(0, depth));
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, `rollout-2026-10-25T12-00-00-${threadId}.jsonl`);
    await fs.writeFile(file, content);
    return file;
}

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
    assert.fail('Expected publisher state before deadline');
}

test('local requests return the exact successfully written sample and only projected metrics', async t =>
{
    const f = await fixture(t, { store: { getStats: async () => ({ ...Stats,
        threadId: ThreadId, sourcePath: '/private/log', chat: 'private content' }) } });
    const result = await f.publisher.getStats(ThreadId.toUpperCase());
    const written = await f.read(ThreadId);
    assert.deepEqual(written, { schemaVersion: 1, producer: 'codex-session-stats', threadId: ThreadId,
        publisherId: PublisherId, revision: 1, generatedAt: 100000, stats: Stats });
    assert.deepEqual(result, { ...Stats, threadId: ThreadId, source: 'snapshot',
        snapshotGeneratedAt: 100000, snapshotRevision: 1, snapshotPublisherId: PublisherId });
    assert.equal((await fs.readdir(path.dirname(f.filename(ThreadId)))).length, 1);
    if (process.platform !== 'win32')
        assert.equal((await fs.stat(f.filename(ThreadId))).mode & 0o777, 0o600);
});

test('unchanged samples retain their revision until heartbeat and changed metrics publish immediately', async t =>
{
    let tokens = 1200;
    const f = await fixture(t, { store: { getStats: async () => ({ ...Stats, totalTokens: tokens }) } });
    await f.publisher.getStats(ThreadId);
    f.setTime(109999);
    assert.equal((await f.publisher.getStats(ThreadId)).snapshotRevision, 1);
    f.setTime(110000);
    assert.equal((await f.publisher.getStats(ThreadId)).snapshotRevision, 2);
    f.setTime(110001);
    tokens = 1201;
    const changed = await f.publisher.getStats(ThreadId);
    assert.equal(changed.totalTokens, 1201);
    assert.equal(changed.snapshotRevision, 3);
    assert.equal((await f.read(ThreadId)).stats.totalTokens, 1201);
});

test('concurrent explicit requests coalesce while unrelated background work cannot delay them', async t =>
{
    const background = deferred(), entered = deferred();
    let explicitCalls = 0;
    const f = await fixture(t, { discover: async () => [OtherThreadId], store: {
        async getStats(threadId)
        {
            if (threadId === OtherThreadId) { entered.resolve(); await background.promise; }
            else explicitCalls++;
            return { ...Stats };
        },
    } });
    const refreshing = f.publisher.refresh();
    await entered.promise;
    const [first, second] = await Promise.all([
        f.publisher.getStats(ThreadId), f.publisher.getStats(ThreadId),
    ]);
    assert.equal(first.status, 'ok');
    assert.deepEqual(second, first);
    assert.equal(explicitCalls, 1);
    background.resolve();
    await refreshing;
});

test('background polling updates tracked sessions without overlapping discovery loops', async t =>
{
    let tokens = 1200, discoveryCalls = 0;
    const f = await fixture(t, { pollMs: 5, discover: async () => { discoveryCalls++; return [ThreadId]; },
        store: { getStats: async () => ({ ...Stats, totalTokens: tokens }) } });
    await f.publisher.start();
    tokens = 1234;
    f.setTime(102000);
    await eventually(async () => (await f.read(ThreadId)).stats.totalTokens === 1234);
    assert.equal(discoveryCalls, 1);
    await f.publisher.dispose();
    assert.equal((await f.read(ThreadId)).stats.totalTokens, 1234);
});

test('default discovery publishes a hidden session using the authoritative local parser', async t =>
{
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-snapshot-parser-'));
    const store = createSessionStore({ codexHome: root });
    const publisher = createSnapshotPublisher({ codexHome: root, store, publisherId: PublisherId });
    t.after(async () => { await publisher.dispose(); store.dispose(); await fs.rm(root, { recursive: true }); });
    const records = [
        { type: 'session_meta', payload: { id: ThreadId, session_id: ThreadId } },
        { type: 'event_msg', payload: { type: 'task_started', turn_id: 'first' } },
        { type: 'event_msg', payload: { type: 'item_completed', turn_id: 'first',
            item: { type: 'AgentMessage', id: 'message-first' }, started_at_ms: 0, completed_at_ms: 5000 } },
        { type: 'token_usage_record', payload: { turn_id: 'first', response_id: 'response-first',
            usage: { input_tokens: 200, output_tokens: 1000, cached_input_tokens: 100, total_tokens: 1200 },
            thread_token_usage: { input_tokens: 200, output_tokens: 1000, cached_input_tokens: 100, total_tokens: 1200 } } },
        { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'first' } },
    ];
    await writeSession(root, ThreadId, { content: records.map(record => JSON.stringify(record) + '\n').join('') });
    await publisher.refresh();
    const written = JSON.parse(await fs.readFile(path.join(root, '.session-stats', `${ThreadId}.json`), 'utf8'));
    assert.equal(written.stats.totalTokens, 1200);
    assert.equal(written.stats.tps, 200);
    assert.equal(written.stats.modelActiveMs, 5000);
    const raw = await store.getStats(ThreadId);
    for (const key of Object.keys(Stats)) assert.equal(written.stats[key], raw[key], key);
});

test('discovery checks recent exact names and refreshes hidden interest only every fifteen seconds', async t =>
{
    const f = await fixture(t, { discover: undefined });
    await writeSession(f.codexHome, ThreadId);
    await f.publisher.refresh();
    await writeSession(f.codexHome, OtherThreadId, { archive: true });
    f.setTime(114999);
    await f.publisher.refresh();
    await assert.rejects(fs.readFile(f.filename(OtherThreadId)), { code: 'ENOENT' });
    f.setTime(115000);
    await f.publisher.refresh();
    assert.equal((await f.read(OtherThreadId)).threadId, OtherThreadId);
});

test('interest stays bounded to thirty-two IDs while evicted snapshot files remain for expiry', async t =>
{
    const observed = [];
    const f = await fixture(t, { store: { getStats: async threadId => { observed.push(threadId); return { ...Stats }; } } });
    for (let i = 1; i <= 33; i++) await f.publisher.getStats(id(i));
    observed.length = 0;
    await f.publisher.refresh();
    assert.equal(observed.length, 32);
    assert.equal(observed.includes(id(1)), false);
    assert.equal((await f.read(id(1))).threadId, id(1));
});

test('a full in-flight interest cache refuses extra work and disposal cancels every pending request', async t =>
{
    const blocked = deferred();
    let calls = 0;
    const f = await fixture(t, { store: { getStats: async () => { calls++; return blocked.promise; } } });
    const requests = Array.from({ length: 32 }, (_, index) => f.publisher.getStats(id(index + 1)));
    const refused = await f.publisher.getStats(id(33));
    assert.equal(calls, 32);
    assert.equal(refused.unavailableReason, 'snapshot-publish-failed');
    await f.publisher.dispose();
    assert.equal((await Promise.all(requests)).every(result => result.status === 'unavailable'), true);
    blocked.resolve({ ...Stats });
    assert.deepEqual(await fs.readdir(f.codexHome), []);
});

test('overlapping background refreshes share one pass and publish each discovered ID only once', async t =>
{
    const blocked = deferred(), entered = deferred();
    const calls = [];
    const f = await fixture(t, { discover: async () => [ThreadId, OtherThreadId], store: { async getStats(threadId)
    {
        calls.push(threadId);
        if (threadId === ThreadId) { entered.resolve(); await blocked.promise; }
        return { ...Stats };
    } } });
    const first = f.publisher.refresh();
    await entered.promise;
    const overlapping = Array.from({ length: 5 }, () => f.publisher.refresh());
    blocked.resolve();
    await Promise.all([first, ...overlapping]);
    assert.deepEqual(calls, [ThreadId, OtherThreadId]);
    assert.equal((await f.read(ThreadId)).revision, 1);
    assert.equal((await f.read(OtherThreadId)).revision, 2);
});

test('unknown destinations fail closed without deleting files', async t =>
{
    const f = await fixture(t);
    const directory = path.dirname(f.filename(ThreadId));
    await fs.mkdir(directory);
    await fs.writeFile(f.filename(ThreadId), 'unknown document');
    await fs.writeFile(path.join(directory, 'keep-me.txt'), 'keep');
    const unavailable = await f.publisher.getStats(ThreadId);
    assert.equal(unavailable.status, 'unavailable');
    assert.equal(unavailable.unavailableReason, 'snapshot-publish-failed');
    assert.equal(unavailable.totalTokens, null);
    assert.equal(await fs.readFile(f.filename(ThreadId), 'utf8'), 'unknown document');
    await f.publisher.dispose();
    assert.equal(await fs.readFile(path.join(directory, 'keep-me.txt'), 'utf8'), 'keep');
});

test('generated-directory links and watched-installation aliases are rejected before writing', async t =>
{
    const f = await fixture(t);
    const outside = path.join(f.root, 'outside');
    await fs.mkdir(outside);
    await fs.symlink(outside, path.dirname(f.filename(ThreadId)), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal((await f.publisher.getStats(ThreadId)).unavailableReason, 'snapshot-publish-failed');
    assert.deepEqual(await fs.readdir(outside), []);

    const installation = path.join(f.root, 'installation');
    const alias = path.join(f.root, 'alias');
    const inside = path.join(installation, 'home');
    await fs.mkdir(inside, { recursive: true });
    await fs.symlink(installation, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const publisher = createSnapshotPublisher({ codexHome: path.join(alias, 'home'), installationRoot: installation,
        store: f.store, publisherId: PublisherId, discover: async () => [] });
    t.after(() => publisher.dispose());
    assert.equal((await publisher.getStats(ThreadId)).unavailableReason, 'snapshot-publish-failed');
    assert.deepEqual(await fs.readdir(inside), []);
});

test('destination links and directories are preserved when publication fails', async t =>
{
    const f = await fixture(t);
    const directory = path.dirname(f.filename(ThreadId));
    await fs.mkdir(directory);
    await fs.mkdir(f.filename(ThreadId));
    assert.equal((await f.publisher.getStats(ThreadId)).unavailableReason, 'snapshot-publish-failed');
    assert.equal((await fs.lstat(f.filename(ThreadId))).isDirectory(), true);
    const outside = path.join(f.root, 'outside.json');
    await fs.writeFile(outside, 'keep');
    try { await fs.symlink(outside, f.filename(OtherThreadId), 'file'); }
    catch (error) { if (error.code === 'EPERM') return; throw error; }
    assert.equal((await f.publisher.getStats(OtherThreadId)).unavailableReason, 'snapshot-publish-failed');
    assert.equal((await fs.lstat(f.filename(OtherThreadId))).isSymbolicLink(), true);
    assert.equal(await fs.readFile(outside, 'utf8'), 'keep');
});

test('atomic replacement never exposes partial JSON and preserves unknown files through disposal', async t =>
{
    let tokens = 1200;
    const f = await fixture(t, { store: { getStats: async () => ({ ...Stats, totalTokens: tokens }) } });
    await f.publisher.getStats(ThreadId);
    const directory = path.dirname(f.filename(ThreadId));
    await fs.writeFile(path.join(directory, '.unowned.tmp'), 'keep');
    let reading = true, reads = 0;
    const reader = (async () =>
    {
        while (reading)
        {
            const sample = await f.read(ThreadId);
            assert.equal(sample.threadId, ThreadId);
            assert.equal(sample.producer, 'codex-session-stats');
            assert.ok(sample.stats.totalTokens >= 1200 && sample.stats.totalTokens <= 1230);
            reads++;
        }
    })();
    try
    {
        for (tokens = 1201; tokens <= 1230; tokens++)
        {
            let result;
            await eventually(async () =>
            {
                result = await f.publisher.getStats(ThreadId);
                if (result.status === 'ok') return true;
                assert.equal(result.unavailableReason, 'snapshot-publish-failed');
                assert.equal(result.totalTokens, null);
                return false;
            });
            assert.equal(result.totalTokens, tokens);
            const written = await f.read(ThreadId);
            assert.equal(result.snapshotRevision, written.revision);
            assert.equal(result.totalTokens, written.stats.totalTokens);
        }
    }
    finally { reading = false; await reader; }
    await f.publisher.dispose();
    assert.ok(reads > 0);
    assert.deepEqual((await fs.readdir(directory)).sort(), ['.unowned.tmp', `${ThreadId}.json`].sort());
    assert.equal(await fs.readFile(path.join(directory, '.unowned.tmp'), 'utf8'), 'keep');
});

test('deleted or externally replaced samples cannot be returned as successfully shared', async t =>
{
    const f = await fixture(t);
    await f.publisher.getStats(ThreadId);
    await fs.unlink(f.filename(ThreadId));
    assert.equal((await f.publisher.getStats(ThreadId)).unavailableReason, 'snapshot-publish-failed');
    const recovered = await f.publisher.getStats(ThreadId);
    assert.equal(recovered.status, 'ok');
    assert.equal((await f.read(ThreadId)).revision, recovered.snapshotRevision);
    await fs.writeFile(f.filename(ThreadId), 'unknown document');
    assert.equal((await f.publisher.getStats(ThreadId)).unavailableReason, 'snapshot-publish-failed');
    assert.equal(await fs.readFile(f.filename(ThreadId), 'utf8'), 'unknown document');
});

test('failed atomic replacement removes owned temporary files and preserves the last final sample', async t =>
{
    let tokens = 1200;
    const f = await fixture(t, { store: { getStats: async () => ({ ...Stats, totalTokens: tokens }) } });
    await f.publisher.getStats(ThreadId);
    const originalRename = fs.rename;
    fs.rename = async (source, destination) =>
    {
        if (destination !== f.filename(ThreadId)) return originalRename(source, destination);
        throw Object.assign(new Error('Injected replacement failure'), { code: 'EIO' });
    };
    let failed;
    try { tokens = 1201; failed = await f.publisher.getStats(ThreadId); }
    finally { fs.rename = originalRename; }
    assert.equal(failed.unavailableReason, 'snapshot-publish-failed');
    assert.equal((await f.read(ThreadId)).stats.totalTokens, 1200);
    assert.deepEqual(await fs.readdir(path.dirname(f.filename(ThreadId))), [`${ThreadId}.json`]);
});

test('Windows sharing conflicts exhaust bounded retries and recover on the next request',
    { skip: process.platform !== 'win32' }, async t =>
{
    let tokens = 1200;
    const f = await fixture(t, { store: { getStats: async () => ({ ...Stats, totalTokens: tokens }) } });
    await f.publisher.getStats(ThreadId);
    const before = await f.read(ThreadId);
    const originalRename = fs.rename;
    let attempts = 0, failed;
    fs.rename = async (source, destination) =>
    {
        if (destination !== f.filename(ThreadId)) return originalRename(source, destination);
        attempts++;
        throw Object.assign(new Error('Injected Windows sharing conflict'), { code: 'EPERM' });
    };
    try { tokens = 1201; failed = await f.publisher.getStats(ThreadId); }
    finally { fs.rename = originalRename; }
    assert.equal(attempts, 7);
    assert.equal(failed.status, 'unavailable');
    assert.equal(failed.unavailableReason, 'snapshot-publish-failed');
    assert.equal(failed.totalTokens, null);
    assert.deepEqual(await f.read(ThreadId), before);
    assert.deepEqual(await fs.readdir(path.dirname(f.filename(ThreadId))), [`${ThreadId}.json`]);
    const recovered = await f.publisher.getStats(ThreadId);
    const written = await f.read(ThreadId);
    assert.equal(recovered.status, 'ok');
    assert.equal(recovered.totalTokens, tokens);
    assert.ok(recovered.snapshotRevision > before.revision);
    assert.equal(recovered.snapshotRevision, written.revision);
    assert.equal(recovered.totalTokens, written.stats.totalTokens);
});

test('disposal during temporary-file creation cleans only its own file and cannot rename afterward', async t =>
{
    const blocked = deferred(), entered = deferred();
    const f = await fixture(t);
    const originalOpen = fs.open;
    fs.open = async (filename, flags, mode) =>
    {
        const handle = await originalOpen(filename, flags, mode);
        if (String(filename).startsWith(path.dirname(f.filename(ThreadId))) && String(filename).endsWith('.tmp'))
        {
            entered.resolve();
            await blocked.promise;
        }
        return handle;
    };
    let result;
    try
    {
        const request = f.publisher.getStats(ThreadId);
        await entered.promise;
        await fs.writeFile(path.join(path.dirname(f.filename(ThreadId)), '.unowned.tmp'), 'keep');
        const disposing = f.publisher.dispose();
        blocked.resolve();
        await disposing;
        result = await request;
    }
    finally { blocked.resolve(); fs.open = originalOpen; }
    assert.equal(result.unavailableReason, 'snapshot-publish-failed');
    assert.deepEqual(await fs.readdir(path.dirname(f.filename(ThreadId))), ['.unowned.tmp']);
});

test('valid source failures are published while invalid IDs and mismatched source identities fail closed', async t =>
{
    const f = await fixture(t, { store: { getStats: async threadId => threadId === ThreadId
        ? { status: 'not-found', threadId } : { ...Stats, threadId: ThreadId } } });
    const missing = await f.publisher.getStats(ThreadId);
    assert.equal(missing.status, 'not-found');
    assert.equal(missing.unavailableReason, 'source-unavailable');
    const written = await f.read(ThreadId);
    assert.equal(written.stats.totalTokens, null);
    assert.equal(written.stats.activeTurn, false);
    assert.equal((await f.publisher.getStats(OtherThreadId)).unavailableReason, 'snapshot-publish-failed');
    assert.equal((await f.publisher.getStats('../unsafe')).threadId, null);
    await assert.rejects(fs.readFile(f.filename(OtherThreadId)), { code: 'ENOENT' });
});

test('disposal cancels pending source reads and preserves already published final snapshots', async t =>
{
    const waiting = deferred(), entered = deferred();
    const f = await fixture(t, { store: { async getStats(threadId)
    {
        if (threadId === OtherThreadId) { entered.resolve(); await waiting.promise; }
        return { ...Stats };
    } } });
    await f.publisher.getStats(ThreadId);
    const request = f.publisher.getStats(OtherThreadId);
    await entered.promise;
    const disposing = f.publisher.dispose();
    const stoppedWithoutSource = await Promise.race([
        disposing.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 100)),
    ]);
    waiting.resolve();
    await disposing;
    assert.equal(stoppedWithoutSource, true, 'Stopping must not wait for a blocked parser');
    assert.equal((await request).status, 'unavailable');
    assert.equal((await f.read(ThreadId)).revision, 1);
    await assert.rejects(fs.readFile(f.filename(OtherThreadId)), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(path.dirname(f.filename(ThreadId))), [`${ThreadId}.json`]);
    assert.equal((await f.publisher.getStats(ThreadId)).unavailableReason, 'snapshot-publish-failed');
});

test('disposal cancels an uncooperative discovery without publishing its late result', async t =>
{
    const waiting = deferred(), entered = deferred();
    const f = await fixture(t, { discover: async () => { entered.resolve(); return waiting.promise; } });
    const refreshing = f.publisher.refresh();
    await entered.promise;
    const disposing = f.publisher.dispose();
    const stoppedWithoutDiscovery = await Promise.race([
        disposing.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 100)),
    ]);
    waiting.resolve([ThreadId]);
    await Promise.all([disposing, refreshing]);
    assert.equal(stoppedWithoutDiscovery, true, 'Stopping must not wait for discovery');
    assert.deepEqual(await fs.readdir(f.codexHome), []);
});

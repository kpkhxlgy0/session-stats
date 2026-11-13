'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createSnapshotPublisher } = require('../src/snapshot-publisher.cjs');
const { createSnapshotProtocol } = require('../src/snapshot.cjs');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const Owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const Other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const stats = { status: 'ok', turns: 1, steps: 2, totalTokens: 10,
    tpsHeld: false, activeTurn: false };
const flush = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, options = {})
{
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-on-demand-'));
    const calls = [];
    let discoveries = 0, time = 100000;
    const publisher = createSnapshotPublisher({ codexHome: root, now: () => time,
        discover: async () => { discoveries++; return [A, B]; },
        store: { async getStats(id) { calls.push(id); return { ...stats }; } }, ...options });
    t.after(async () => { await publisher.dispose(); await fs.rm(root, { recursive: true, force: true }); });
    return { root, publisher, calls, discoveries: () => discoveries, setTime: value => { time = value; },
        file: id => path.join(root, '.session-stats', `${id}.json`) };
}

test('an idle publisher never discovers sessions or calculates statistics', async t =>
{
    const f = await fixture(t);
    await f.publisher.start();
    await f.publisher.refresh();
    assert.equal(f.discoveries(), 0);
    assert.deepEqual(f.calls, []);
});

test('only interested targets poll and releasing one owner preserves the other', async t =>
{
    const f = await fixture(t);
    await f.publisher.getStats(A, { ownerId: Owner });
    await f.publisher.getStats(A, { ownerId: Other });
    f.publisher.release(Owner);
    f.calls.length = 0;
    await f.publisher.refresh();
    assert.deepEqual(f.calls, [A]);
    f.publisher.release(Other);
    f.calls.length = 0;
    await f.publisher.refresh();
    assert.deepEqual(f.calls, []);
});

test('switching an owner stops its old target and one-shot reads never subscribe', async t =>
{
    const f = await fixture(t);
    await f.publisher.getStats(A, { ownerId: Owner });
    await f.publisher.getStats(B, { ownerId: Owner });
    f.calls.length = 0;
    await f.publisher.refresh();
    assert.deepEqual(f.calls, [B]);
    f.publisher.release(Owner);
    await f.publisher.getStats(A);
    f.calls.length = 0;
    await f.publisher.refresh();
    assert.deepEqual(f.calls, []);
});

test('releasing a blocked source discards its late result and does not publish it', async t =>
{
    let finish, entered;
    const begun = new Promise(resolve => { entered = resolve; });
    const blocked = new Promise(resolve => { finish = resolve; });
    const f = await fixture(t, { store: { getStats(id) { entered(); return blocked; } } });
    const reading = f.publisher.getStats(A, { ownerId: Owner });
    await begun;
    f.publisher.release(Owner);
    finish({ ...stats });
    assert.equal((await reading).status, 'unavailable');
    await flush();
    await assert.rejects(fs.access(f.file(A)), { code: 'ENOENT' });
});

test('consumer request leases expire after eight seconds and cancellation overrides a live lease', async t =>
{
    const f = await fixture(t);
    const protocol = createSnapshotProtocol();
    await f.publisher.start();
    const file = protocol.requestPath(f.root, A, Owner, path);
    const write = (active, time = 100000) => fs.writeFile(file,
        JSON.stringify(protocol.makeRequest(A, { now: time, consumerId: Owner, active })));
    await write(true);
    await f.publisher.refresh();
    // refresh awaits demanded publications, rather than leaving a detached parser loop.
    assert.deepEqual(f.calls, [A]);
    await write(false, 100001);
    f.calls.length = 0;
    await f.publisher.refresh();
    assert.deepEqual(f.calls, []);
    await write(true, 100002);
    f.setTime(108003);
    await f.publisher.refresh();
    assert.deepEqual(f.calls, []);
});

test('remote cancellation overrides a late lower sequence while another consumer remains active', async t =>
{
    const f = await fixture(t), p = createSnapshotProtocol();
    await f.publisher.start();
    const write = (nonce, consumerId, active, sequence) => fs.writeFile(p.requestPath(f.root, A, nonce, path),
        JSON.stringify(p.makeRequest(A, { now: 100000, consumerId, active, sequence })));
    await write(A, Owner, false, 2);
    await write(B, Owner, true, 1);
    await f.publisher.refresh();
    assert.deepEqual(f.calls, []);
    await write(Other, Other, true, 1);
    await f.publisher.refresh();
    assert.deepEqual(f.calls, [A]);
    await fs.unlink(p.requestPath(f.root, A, Other, path));
    f.calls.length = 0;
    await f.publisher.refresh();
    assert.deepEqual(f.calls, []);
});

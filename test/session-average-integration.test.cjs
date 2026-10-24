'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createSessionStore } = require('../src/session-store.cjs');
const { createSnapshotPublisher } = require('../src/snapshot-publisher.cjs');
const { createSnapshotRemoteStore } = require('../src/snapshot-remote-store.cjs');

const ThreadId = '11111111-1111-4111-8111-111111111111';
const HostId = 'remote-control:average-test';
const lines = records => records.map(record => JSON.stringify(record) + '\n').join('');

function turn(id, start, end, cumulativeOutput) {
    return [
        { type: 'event_msg', payload: { type: 'task_started', turn_id: id } },
        { type: 'event_msg', payload: { type: 'item_completed', turn_id: id,
            item: { type: 'AgentMessage', id: 'message-' + id }, started_at_ms: start, completed_at_ms: end } },
        { type: 'token_usage_record', payload: { turn_id: id, response_id: 'response-' + id,
            usage: { input_tokens: 200, output_tokens: 1000, cached_input_tokens: 100, total_tokens: 1200 },
            thread_token_usage: { input_tokens: cumulativeOutput / 5, output_tokens: cumulativeOutput,
                cached_input_tokens: cumulativeOutput / 10, total_tokens: cumulativeOutput * 1.2 } } },
        { type: 'event_msg', payload: { type: 'task_complete', turn_id: id } },
    ];
}

test('local publisher and remote receiver share the exact cross-turn average without remote log reads', async t => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-average-snapshots-'));
    const localStore = createSessionStore({ codexHome: home });
    let now = 100000;
    const publisher = createSnapshotPublisher({ codexHome: home, store: localStore, now: () => now, discover: async () => [] });
    const receiver = createSnapshotRemoteStore({ now: () => now, pollMs: 0 });
    t.after(async () => {
        receiver.dispose();
        await publisher.dispose();
        localStore.dispose();
        await fs.rm(home, { recursive: true });
    });
    const directory = path.join(home, 'sessions', '2026', '10', '24');
    await fs.mkdir(directory, { recursive: true });
    const basename = 'rollout-2026-10-24T10-00-00-' + ThreadId + '.jsonl';
    const filename = path.join(directory, basename);
    const remoteHome = '/remote/.codex';
    const remotePath = remoteHome + '/sessions/2026/10/24/' + basename;
    await fs.writeFile(filename, lines([{ type: 'session_meta', payload: { id: ThreadId, session_id: ThreadId } },
        ...turn('first', 0, 5000, 1000)]));
    const calls = [];
    async function request(method, params) {
        calls.push({ method, ...params });
        if (method === 'snapshot/request') {
            assert.equal(params.threadId, ThreadId);
            assert.equal(params.rolloutPath, remotePath);
            return { requested: true };
        }
        if (method === 'thread/read') return { thread: { id: ThreadId, path: remotePath } };
        const relative = path.posix.relative(remoteHome, params.path);
        assert.ok(!relative.startsWith('..') && !path.posix.isAbsolute(relative));
        const target = path.join(home, ...relative.split('/'));
        if (method === 'fs/getMetadata') {
            const info = await fs.lstat(target);
            return { isFile: info.isFile(), isDirectory: info.isDirectory(), isSymlink: info.isSymbolicLink(),
                createdAtMs: info.birthtimeMs, modifiedAtMs: info.mtimeMs };
        }
        assert.equal(method, 'fs/readFile', 'receiver must not traverse remote directories');
        assert.equal(params.path, remoteHome + '/.session-stats/' + ThreadId + '.json',
            'only the shared snapshot may cross RC');
        return { dataBase64: (await fs.readFile(target)).toString('base64') };
    }
    async function assertBoth(tps, modelActiveMs, activeTurn, tpsHeld) {
        const local = await publisher.getStats(ThreadId);
        assert.equal(local.status, 'ok');
        let remote;
        for (let attempt = 0; attempt < 100; attempt++) {
            remote = await receiver.getStats({ hostId: HostId, threadId: ThreadId }, request);
            if (remote.snapshotRevision === local.snapshotRevision) break;
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        const { hostId, ...sample } = remote;
        assert.equal(hostId, HostId);
        assert.deepEqual(sample, local);
        assert.equal(local.source, 'snapshot');
        assert.equal(local.tps, tps);
        assert.equal(local.modelActiveMs, modelActiveMs);
        assert.equal(local.activeTurn, activeTurn);
        assert.equal(local.tpsHeld, tpsHeld);
        const disk = JSON.parse(await fs.readFile(path.join(home, '.session-stats', ThreadId + '.json'), 'utf8'));
        assert.equal(local.snapshotRevision, disk.revision);
        assert.equal(local.snapshotGeneratedAt, disk.generatedAt);
        assert.equal(local.tps, disk.stats.tps);
    }
    async function append(records) {
        await fs.appendFile(filename, lines(records));
        now += 2000;
    }
    await assertBoth(200, 5000, false, false);
    await append(turn('second', 10000, 30000, 2000));
    await assertBoth(80, 25000, false, false);
    await append([{ type: 'event_msg', payload: { type: 'task_started', turn_id: 'third' } }]);
    await assertBoth(80, 25000, true, true);
    await append([{ type: 'event_msg', payload: { type: 'item_completed', turn_id: 'third',
        item: { type: 'Reasoning', id: 'reasoning-third' }, started_at_ms: 40000, completed_at_ms: 50000 } }]);
    await assertBoth(80, 25000, true, true);
    assert.ok(calls.filter(call => call.method === 'fs/readFile').length >= 4);
});

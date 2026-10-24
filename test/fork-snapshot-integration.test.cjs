'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { test } = require('node:test');
const { createSessionStore } = require('../src/session-store.cjs');
const { createSnapshotPublisher } = require('../src/snapshot-publisher.cjs');
const { createSnapshotRemoteStore } = require('../src/snapshot-remote-store.cjs');

const Parent = '11111111-1111-4111-8111-111111111111';
const Child = '22222222-2222-4222-8222-222222222222';
const Host = 'remote-control:fork-snapshot-test';
const lines = (records, ordinal) => records.map((record, i) =>
    JSON.stringify({ ...record, ordinal: ordinal + i }) + '\n').join('');

function turn(id, start, end, totalOutput)
{
    return [
        { type: 'event_msg', payload: { type: 'task_started', turn_id: id } },
        { type: 'event_msg', payload: { type: 'item_completed', turn_id: id,
            item: { type: 'AgentMessage', id }, started_at_ms: start, completed_at_ms: end } },
        { type: 'token_usage_record', payload: { turn_id: id, response_id: `response-${id}`,
            usage: { input_tokens: 200, output_tokens: 1000, cached_input_tokens: 100, total_tokens: 1200 },
            thread_token_usage: { input_tokens: totalOutput / 5, output_tokens: totalOutput,
                cached_input_tokens: totalOutput / 10, total_tokens: totalOutput * 1.2 } } },
        { type: 'event_msg', payload: { type: 'task_complete', turn_id: id } },
    ];
}

for (const compressed of [false, true])
{
    test(`fork TPS shares inherited ${compressed ? 'Zstd' : 'plain'} history through snapshots only`,
        { skip: compressed && typeof zlib.zstdCompressSync !== 'function' }, async t =>
    {
        t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 25) });
        const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-fork-snapshot-'));
        const directory = path.join(home, 'sessions', '2026', '10', '25');
        await fs.mkdir(directory, { recursive: true });
        let store, publisher, now = 100000;
        function startPublisher()
        {
            store = createSessionStore({ codexHome: home });
            publisher = createSnapshotPublisher({ codexHome: home, store, now: () => now, discover: async () => [] });
        }
        startPublisher();
        const receiver = createSnapshotRemoteStore({ now: () => now, pollMs: 0 });
        t.after(async () =>
        {
            receiver.dispose();
            await publisher.dispose();
            store.dispose();
            await fs.rm(home, { recursive: true });
        });
        const parentFile = path.join(directory, `rollout-2026-10-25T01-00-00-${Parent}.jsonl${compressed ? '.zst' : ''}`);
        const childName = `rollout-2026-10-25T02-00-00-${Child}.jsonl`;
        const childFile = path.join(directory, childName);
        const parentPrefix = lines([{ type: 'session_meta', payload: { id: Parent, session_id: Parent } },
            ...turn('inherited', 0, 5000, 1000)], 0);
        let parentContent = parentPrefix + lines(turn('parent-after-fork', 6000, 7000, 2000), 5);
        async function writeParent()
        {
            await fs.writeFile(parentFile, compressed ? zlib.zstdCompressSync(parentContent) : parentContent);
        }
        await writeParent();
        await fs.writeFile(childFile, lines([{ type: 'session_meta', payload: {
            id: Child, session_id: Child, history_mode: 'paginated', forked_from_id: Parent,
            forked_from_ordinal_exclusive: 5,
            history_base: { thread_id: Parent, end_ordinal_exclusive: 5, end_byte_offset: Buffer.byteLength(parentPrefix) },
        } }], 5));
        const remoteHome = '/runner/.codex';
        const remoteRollout = `${remoteHome}/sessions/2026/10/25/${childName}`;
        const snapshotPath = `${remoteHome}/.session-stats/${Child}.json`;
        const calls = [];
        async function request(method, params)
        {
            calls.push({ method, path: params.path });
            if (method === 'snapshot/request')
            {
                assert.equal(params.threadId, Child);
                assert.equal(params.rolloutPath, remoteRollout);
                return { requested: true };
            }
            if (method === 'thread/read') return { thread: { id: Child, path: remoteRollout } };
            assert.ok([remoteHome, `${remoteHome}/.session-stats`, snapshotPath].includes(params.path));
            const target = path.join(home, ...path.posix.relative(remoteHome, params.path).split('/'));
            if (method === 'fs/getMetadata')
            {
                const info = await fs.lstat(target);
                return { isFile: info.isFile(), isDirectory: info.isDirectory(), isSymlink: info.isSymbolicLink(),
                    createdAtMs: info.birthtimeMs, modifiedAtMs: info.mtimeMs };
            }
            assert.equal(method, 'fs/readFile');
            assert.equal(params.path, snapshotPath, 'only the published snapshot crosses RC');
            return { dataBase64: (await fs.readFile(target)).toString('base64') };
        }
        async function assertBoth(tps, modelActiveMs, turns, activeTurn = false, tpsHeld = false)
        {
            const local = await publisher.getStats(Child);
            assert.equal(local.status, 'ok');
            let remote;
            for (let attempt = 0; attempt < 100; attempt++)
            {
                remote = await receiver.getStats({ hostId: Host, threadId: Child }, request);
                if (remote.snapshotRevision === local.snapshotRevision && remote.snapshotPublisherId === local.snapshotPublisherId) break;
                await new Promise(resolve => setTimeout(resolve, 5));
            }
            const { hostId, ...sample } = remote;
            assert.equal(hostId, Host);
            assert.deepEqual(sample, local);
            assert.equal(local.tps, tps);
            assert.equal(local.modelActiveMs, modelActiveMs);
            assert.equal(local.turns, turns, 'other counters remain branch-scoped');
            assert.equal(local.activeTurn, activeTurn);
            assert.equal(local.tpsHeld, tpsHeld);
            return local;
        }
        await assertBoth(200, 5000, 0);
        const childTurn = turn('child-first', 10000, 30000, 2000);
        await fs.appendFile(childFile, lines(childTurn.slice(0, 1), 6)); now += 2000;
        await assertBoth(200, 5000, 1, true, true);
        await fs.appendFile(childFile, lines(childTurn.slice(1), 7)); now += 2000;
        const complete = await assertBoth(80, 25000, 1);
        assert.equal(complete.totalTokens, 1200);
        assert.equal(complete.outputTokens, 1000);
        parentContent += lines(turn('later-parent', 40000, 40100, 3000), 9);
        await writeParent(); now += 2000;
        await assertBoth(80, 25000, 1);
        await publisher.dispose(); store.dispose(); now += 2000;
        startPublisher();
        await assertBoth(80, 25000, 1);
        await fs.unlink(parentFile); now += 2000;
        const missing = await assertBoth(null, null, 1);
        assert.equal(missing.totalTokens, 1200);
        await writeParent(); now += 16000; t.mock.timers.tick(16000);
        await assertBoth(80, 25000, 1);
        assert.ok(calls.some(call => call.method === 'fs/readFile'));
        assert.ok(calls.every(call => call.method !== 'fs/readDirectory'
            && (call.method !== 'fs/readFile' || call.path === snapshotPath)));
    });
}

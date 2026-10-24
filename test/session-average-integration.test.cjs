'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createSessionStore } = require('../src/session-store.cjs');
const { createRemoteSessionStore } = require('../src/remote-session-store.cjs');

const ThreadId = '11111111-1111-4111-8111-111111111111';
const HostId = 'remote-control:average-test';

function lines(records)
{
    return records.map(record => `${JSON.stringify(record)}\n`).join('');
}

function turn(id, start, end, cumulativeOutput)
{
    return [
        { type: 'event_msg', payload: { type: 'task_started', turn_id: id } },
        { type: 'event_msg', payload: { type: 'item_completed', turn_id: id,
            item: { type: 'AgentMessage', id: `message-${id}` },
            started_at_ms: start, completed_at_ms: end } },
        { type: 'token_usage_record', payload: { turn_id: id, response_id: `response-${id}`,
            usage: { input_tokens: 200, output_tokens: 1000, cached_input_tokens: 100, total_tokens: 1200 },
            thread_token_usage: { input_tokens: cumulativeOutput / 5, output_tokens: cumulativeOutput,
                cached_input_tokens: cumulativeOutput / 10, total_tokens: cumulativeOutput * 1.2 } } },
        { type: 'event_msg', payload: { type: 'task_complete', turn_id: id } },
    ];
}

test('local and remote stores average the same measured conversation and hold it through a new turn', async t =>
{
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-average-stores-'));
    const local = createSessionStore({ codexHome });
    let now = 0;
    const remote = createRemoteSessionStore({ now: () => now });
    t.after(async () =>
    {
        local.dispose();
        remote.dispose();
        await fs.rm(codexHome, { recursive: true });
    });
    const directory = path.join(codexHome, 'sessions', '2026', '10', '24');
    await fs.mkdir(directory, { recursive: true });
    const filename = path.join(directory, `rollout-2026-10-24T10-00-00-${ThreadId}.jsonl`);
    const remotePath = `/home/user/.codex/sessions/rollout-2026-10-24T10-00-00-${ThreadId}.jsonl`;
    let content = lines([{ type: 'session_meta', payload: { id: ThreadId, session_id: ThreadId } },
        ...turn('first', 0, 5000, 1000)]);
    await fs.writeFile(filename, content);
    let modifiedAtMs = 1;
    async function request(method, params)
    {
        if (method === 'thread/read')
        {
            assert.deepEqual(params, { threadId: ThreadId, includeTurns: false });
            return { thread: { id: ThreadId, path: remotePath } };
        }
        assert.deepEqual(params, { path: remotePath });
        if (method === 'fs/getMetadata')
        {
            return { isFile: true, isDirectory: false, isSymlink: false, createdAtMs: 1, modifiedAtMs };
        }
        assert.equal(method, 'fs/readFile');
        return { dataBase64: Buffer.from(content).toString('base64') };
    }
    async function assertBoth(tps, modelActiveMs, activeTurn, tpsHeld)
    {
        const [localStats, remoteStats] = await Promise.all([
            local.getStats(ThreadId), remote.getStats({ hostId: HostId, threadId: ThreadId }, request),
        ]);
        const { hostId, ...remoteMetrics } = remoteStats;
        assert.equal(hostId, HostId);
        assert.deepEqual(remoteMetrics, localStats);
        assert.equal(localStats.status, 'ok');
        assert.equal(localStats.tps, tps);
        assert.equal(localStats.modelActiveMs, modelActiveMs);
        assert.equal(localStats.activeTurn, activeTurn);
        assert.equal(localStats.tpsHeld, tpsHeld);
    }
    async function append(records)
    {
        const addition = lines(records);
        await fs.appendFile(filename, addition);
        content += addition;
        modifiedAtMs++;
        now += 15000;
    }

    await assertBoth(200, 5000, false, false);
    await append(turn('second', 10000, 30000, 2000));
    await assertBoth(80, 25000, false, false);
    await append([{ type: 'event_msg', payload: { type: 'task_started', turn_id: 'third' } }]);
    await assertBoth(80, 25000, true, true);
    await append([{ type: 'event_msg', payload: { type: 'item_completed', turn_id: 'third',
        item: { type: 'Reasoning', id: 'reasoning-third' }, started_at_ms: 40000, completed_at_ms: 50000 } }]);
    await assertBoth(80, 25000, true, true);
});

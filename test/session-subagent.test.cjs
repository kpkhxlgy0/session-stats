'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createSessionStore } = require('../src/session-store.cjs');

const Root = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const Parent = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const Child = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const Other = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function subagentMetadata(parent = Root, depth = 1)
{
    return { id: Child, session_id: Root, parent_thread_id: parent, thread_source: 'subagent',
        source: { subagent: { thread_spawn: { parent_thread_id: parent, depth,
            agent_path: depth === 1 ? '/root/child' : '/root/parent/child',
            agent_nickname: 'fixture', agent_role: 'worker' } } },
        history_mode: 'paginated', cli_version: '0.164.0-alpha.11.1' };
}

function content(payload, totalTokens = 100)
{
    return [
        { type: 'session_meta', ordinal: 0, payload },
        { type: 'event_msg', ordinal: 1, payload: { type: 'token_count', info: {
            total_token_usage: { total_tokens: totalTokens, input_tokens: totalTokens - 20,
                output_tokens: 20, cached_input_tokens: 40 },
        } } },
    ].map(record => JSON.stringify(record) + '\n').join('');
}

async function fixture(t, metadata, filenameId = Child)
{
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-subagent-'));
    const directory = path.join(codexHome, 'sessions');
    const store = createSessionStore({ codexHome });
    t.after(async () => { store.dispose(); await fs.rm(codexHome, { recursive: true }); });
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, `rollout-2026-10-28T01-00-00-${filenameId}.jsonl`),
        content(metadata));
    return { store, directory };
}

for (const [name, parent, depth] of [['child', Root, 1], ['nested child', Parent, 2]])
{
    test(`native ${name} metadata uses the root session ID without inheriting its metrics`, async t =>
    {
        const { store, directory } = await fixture(t, subagentMetadata(parent, depth));
        await fs.writeFile(path.join(directory, `rollout-2026-10-28T00-00-00-${Root}.jsonl`),
            content({ id: Root, session_id: Root }, 900));
        const stats = await store.getStats(Child);
        assert.equal(stats.status, 'ok');
        assert.equal(stats.threadId, Child);
        assert.equal(stats.totalTokens, 100);
        assert.equal(stats.inputTokens, 80);
        assert.equal(stats.outputTokens, 20);
        assert.equal(stats.tps, null);
    });
}

test('native subagent UUID comparisons remain case-insensitive', async t =>
{
    const metadata = subagentMetadata();
    metadata.id = Child.toUpperCase();
    metadata.session_id = Root.toUpperCase();
    metadata.source.subagent.thread_spawn.parent_thread_id = Root.toUpperCase();
    const { store } = await fixture(t, metadata);
    const stats = await store.getStats(Child.toUpperCase());
    assert.equal(stats.status, 'ok');
    assert.equal(stats.threadId, Child);
    assert.equal(stats.totalTokens, 100);
});

for (const [name, extra] of [
    ['another payload ID', { id: Other }],
    ['an unrelated root at depth one', { session_id: Other }],
    ['a malformed root ID', { session_id: '../root' }],
    ['a null root ID', { session_id: null }],
    ['a missing parent ID', { parent_thread_id: undefined }],
    ['a malformed parent ID', { parent_thread_id: '../parent' }],
    ['a self-parent', { parent_thread_id: Child,
        source: { subagent: { thread_spawn: { parent_thread_id: Child, depth: 1 } } } }],
    ['conflicting parent IDs', { source: { subagent: { thread_spawn: { parent_thread_id: Other, depth: 1 } } } }],
    ['a missing thread source', { thread_source: undefined }],
    ['a different thread source', { thread_source: 'cli' }],
    ['a missing spawn source', { source: undefined }],
    ['a string spawn source', { source: 'subagent' }],
    ['a missing spawn parent', { source: { subagent: { thread_spawn: { depth: 1 } } } }],
    ['a nested child with its root as immediate parent', { source: {
        subagent: { thread_spawn: { parent_thread_id: Root, depth: 2 } } } }],
])
{
    test(`native subagent metadata rejects ${name}`, async t =>
    {
        const { store } = await fixture(t, { ...subagentMetadata(), ...extra });
        const stats = await store.getStats(Child);
        assert.equal(stats.status, 'unavailable');
        assert.equal(stats.totalTokens, 0);
    });
}

for (const depth of [undefined, null, 0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1])
{
    test(`native subagent metadata rejects invalid spawn depth ${JSON.stringify(depth)}`, async t =>
    {
        const metadata = subagentMetadata();
        metadata.source.subagent.thread_spawn.depth = depth;
        const { store } = await fixture(t, metadata);
        const stats = await store.getStats(Child);
        assert.equal(stats.status, 'unavailable');
        assert.equal(stats.totalTokens, 0);
    });
}

test('native subagent metadata cannot override the requested rollout filename', async t =>
{
    const { store } = await fixture(t, subagentMetadata(), Other);
    const stats = await store.getStats(Child);
    assert.equal(stats.status, 'not-found');
    assert.equal(stats.totalTokens, 0);
});

for (const sessionId of [undefined, Child.toUpperCase()])
{
    test(`legacy session metadata accepts ${sessionId ? 'its own' : 'an omitted'} session ID`, async t =>
    {
        const { store } = await fixture(t, { id: Child, session_id: sessionId });
        const stats = await store.getStats(Child);
        assert.equal(stats.status, 'ok');
        assert.equal(stats.totalTokens, 100);
    });
}

test('ordinary metadata cannot claim another session ID without native subagent ancestry', async t =>
{
    const { store } = await fixture(t, { id: Child, session_id: Root });
    const stats = await store.getStats(Child);
    assert.equal(stats.status, 'unavailable');
    assert.equal(stats.totalTokens, 0);
});

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createSessionStore } = require('../src/session-store.cjs');
const { createRemoteSessionStore } = require('../src/remote-session-store.cjs');

const ThreadId = '11111111-1111-4111-8111-111111111111';
const ParentId = '22222222-2222-4222-8222-222222222222';
const SegmentIds = ['33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];
const HostId = 'remote-control:history';
const lines = (...records) => records.map(record => JSON.stringify(record) + '\n').join('');
const meta = (extra = {}, ordinal = 0) => ({ type: 'session_meta', ordinal, payload: { id: ThreadId, ...extra } });

function turn(id, total, output = 100)
{
    return [
        { type: 'event_msg', payload: { type: 'task_started', turn_id: id } },
        { type: 'event_msg', payload: { type: 'item_completed', turn_id: id,
            item: { type: 'Reasoning', id: `reason-${id}` }, started_at_ms: 0, completed_at_ms: 1000 } },
        { type: 'token_usage_record', payload: { thread_id: ThreadId, turn_id: id, response_id: `response-${id}`,
            usage: { input_tokens: 100, output_tokens: output, total_tokens: 100 + output },
            thread_token_usage: { input_tokens: total - output, output_tokens: output, total_tokens: total } } },
        { type: 'event_msg', payload: { type: 'task_complete', turn_id: id } },
    ];
}

async function fixture(t, flavor = 'posix', limits = {})
{
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-remote-history-'));
    await fs.mkdir(path.join(home, 'sessions'), { recursive: true });
    await fs.mkdir(path.join(home, 'archived_sessions'));
    const pathApi = flavor === 'posix' ? path.posix : path.win32;
    const remoteHome = flavor === 'posix' ? '/home/test/.codex' : flavor === 'extended' ? '\\\\?\\D:\\Users\\test\\.codex' : 'D:\\Users\\test\\.codex';
    const state = { latest: null, calls: [], clock: 0, hook: null, revision: 0 };
    const remoteStore = createRemoteSessionStore({ now: () => state.clock, ...limits });
    const localStore = createSessionStore({ codexHome: home });
    t.after(async () => { remoteStore.dispose(); localStore.dispose(); await fs.rm(home, { recursive: true }); });
    const actual = value => path.join(home, ...pathApi.relative(remoteHome, value).split(pathApi.sep));
    state.request = async (method, params) =>
    {
        state.calls.push({ method, params });
        assert.ok(['thread/read', 'fs/getMetadata', 'fs/readFile', 'fs/readDirectory'].includes(method));
        if (state.hook) await state.hook(method, params);
        if (method === 'thread/read') return { thread: { id: ThreadId, path: state.latest } };
        const filename = actual(params.path);
        if (method === 'fs/getMetadata')
        {
            const stat = await fs.lstat(filename);
            return { isFile: stat.isFile(), isDirectory: stat.isDirectory(), isSymlink: stat.isSymbolicLink(),
                createdAtMs: stat.birthtimeMs, modifiedAtMs: stat.mtimeMs };
        }
        if (method === 'fs/readFile') return { dataBase64: (await fs.readFile(filename)).toString('base64') };
        return { entries: (await fs.readdir(filename, { withFileTypes: true })).map(entry => ({
            fileName: entry.name, isFile: entry.isFile(), isDirectory: entry.isDirectory(),
        })) };
    };
    state.write = async (index, content, directory = 'sessions/2026/10/24') =>
    {
        const name = `rollout-2026-10-24T10-00-0${index}-${ThreadId}${index ? `_${SegmentIds[index - 1]}` : ''}.jsonl`;
        const relative = directory.split('/').concat(name);
        const filename = path.join(home, ...relative);
        await fs.mkdir(path.dirname(filename), { recursive: true });
        await fs.writeFile(filename, content);
        await fs.utimes(filename, new Date(), new Date(1700000000000 + ++state.revision * 1000));
        return pathApi.join(remoteHome, ...relative);
    };
    state.stats = () => remoteStore.getStats({ hostId: HostId, threadId: ThreadId }, state.request);
    state.local = () => localStore.getStats(ThreadId);
    state.actual = actual;
    state.home = home;
    state.remoteStore = remoteStore;
    return state;
}

function withoutHost(stats)
{
    const { hostId, ...rest } = stats;
    return rest;
}

test('remote continuation matches local history and excludes abandoned tails and replayed responses', async t =>
{
    const source = await fixture(t);
    const prefix = lines(meta(), ...turn('first', 200));
    await source.write(0, prefix + lines(...turn('abandoned', 9900)));
    const middle = lines(meta({ history_base: { thread_id: ThreadId, end_byte_offset: Buffer.byteLength(prefix),
        end_ordinal_exclusive: 5 } }, 5), ...turn('second', 400));
    await source.write(1, middle + lines(...turn('abandoned-again', 19900)));
    source.latest = await source.write(2, lines(meta({ history_base: { thread_id: SegmentIds[0],
        end_byte_offset: Buffer.byteLength(middle), end_ordinal_exclusive: 10 } }, 10),
    ...turn('third', 600), turn('second', 400)[2]));
    const remote = await source.stats();
    assert.equal(remote.status, 'ok');
    assert.equal(remote.turns, 3);
    assert.equal(remote.steps, 3);
    assert.equal(remote.totalTokens, 600);
    assert.equal(remote.tps, 100);
    assert.deepEqual(withoutHost(remote), await source.local());
});

test('valid fork boundaries exclude parent history and keep response totals', async t =>
{
    const source = await fixture(t);
    source.latest = await source.write(1, lines(meta({ forked_from_id: ParentId, forked_from_ordinal_exclusive: 90,
        history_base: { thread_id: ParentId, end_byte_offset: 50000, end_ordinal_exclusive: 90 } }, 90), ...turn('fork', 9999, 150)));
    const remote = await source.stats();
    assert.equal(remote.status, 'ok');
    assert.equal(remote.turns, 1);
    assert.equal(remote.totalTokens, 250);
    assert.equal(remote.outputTokens, 150);
    assert.deepEqual(withoutHost(remote), await source.local());
    assert.equal(source.calls.some(call => call.method === 'fs/readDirectory'), false);
});

for (const invalid of ['missing', 'ambiguous', 'byte', 'ordinal'])
{
    test(`fails closed for ${invalid} continuation boundaries`, async t =>
    {
        const source = await fixture(t);
        const prefix = lines(meta(), ...turn('first', 200));
        if (invalid !== 'missing') await source.write(0, prefix);
        if (invalid === 'ambiguous') await source.write(1, prefix);
        source.latest = await source.write(2, lines(meta({ history_base: { thread_id: ThreadId,
            end_byte_offset: Buffer.byteLength(prefix) + (invalid === 'byte' ? -1 : 0),
            end_ordinal_exclusive: invalid === 'ordinal' ? 6 : 5 } }, invalid === 'ordinal' ? 6 : 5), ...turn('latest', 400)));
        const stats = await source.stats();
        assert.equal(stats.status, 'unavailable');
        assert.equal(stats.totalTokens, null);
    });
}

for (const flavor of ['windows', 'extended'])
{
    test(`discovers continuation history using ${flavor} paths`, async t =>
    {
        const source = await fixture(t, flavor);
        const prefix = lines(meta(), ...turn('first', 200));
        await source.write(0, prefix);
        source.latest = await source.write(1, lines(meta({ history_base: { thread_id: ThreadId,
            end_byte_offset: Buffer.byteLength(prefix), end_ordinal_exclusive: 5 } }, 5), ...turn('second', 400)));
        assert.deepEqual(withoutHost(await source.stats()), await source.local());
        assert.equal((await source.stats()).turns, 2);
    });
}

test('reuses historical downloads and directory listings while the latest segment grows', async t =>
{
    const source = await fixture(t);
    const prefix = lines(meta(), ...turn('first', 200));
    const previous = await source.write(0, prefix);
    const latest = lines(meta({ history_base: { thread_id: ThreadId,
        end_byte_offset: Buffer.byteLength(prefix), end_ordinal_exclusive: 5 } }, 5), ...turn('second', 400));
    source.latest = await source.write(1, latest);
    assert.equal((await source.stats()).turns, 2);
    const listings = source.calls.filter(call => call.method === 'fs/readDirectory' && call.params.path !== '/home/test/.codex').length;
    source.clock = 15000;
    assert.equal((await source.stats()).turns, 2);
    assert.equal(source.calls.filter(call => call.method === 'fs/readFile').length, 2);
    assert.equal(source.calls.filter(call => call.method === 'fs/readDirectory' && call.params.path !== '/home/test/.codex').length, listings);
    await source.write(1, latest + lines(...turn('third', 600)));
    source.clock = 30000;
    assert.equal((await source.stats()).turns, 3);
    assert.equal(source.calls.filter(call => call.method === 'fs/readFile' && call.params.path === previous).length, 1);
    assert.equal(source.calls.filter(call => call.method === 'fs/readFile' && call.params.path === source.latest).length, 2);
});

test('prefers an active copy over a same-name archived copy', async t =>
{
    const source = await fixture(t);
    const prefix = lines(meta(), ...turn('first', 200));
    await source.write(0, prefix);
    const archive = await source.write(0, lines(meta(), ...turn('wrong', 9999)), 'archived_sessions');
    source.latest = await source.write(1, lines(meta({ history_base: { thread_id: ThreadId,
        end_byte_offset: Buffer.byteLength(prefix), end_ordinal_exclusive: 5 } }, 5), ...turn('second', 400)));
    assert.equal((await source.stats()).turns, 2);
    assert.equal(source.calls.some(call => call.method === 'fs/readFile' && call.params.path === archive), false);
});

test('rejects metadata changes during a download and recovers without using the rejected bytes', async t =>
{
    const source = await fixture(t);
    source.latest = await source.write(0, lines(meta(), ...turn('first', 200)));
    const request = source.request;
    let changed = false;
    source.request = async (method, params) =>
    {
        const response = await request(method, params);
        if (method === 'fs/readFile' && !changed)
        {
            changed = true;
            await source.write(0, lines(meta(), ...turn('replacement', 400)));
        }
        return response;
    };
    assert.equal((await source.stats()).status, 'unavailable');
    source.clock = 15000;
    const recovered = await source.stats();
    assert.equal(recovered.status, 'ok');
    assert.equal(recovered.totalTokens, 400);
    assert.equal(source.calls.filter(call => call.method === 'fs/readFile').length, 3);
});

for (const payload of [{}, { id: ParentId }, { id: ThreadId, session_id: ParentId }, { id: null }])
{
    test(`rejects a later session_meta with invalid identity ${JSON.stringify(payload)}`, async t =>
    {
        const source = await fixture(t);
        source.latest = await source.write(0, lines(meta(), ...turn('first', 200), { type: 'session_meta', payload }));
        assert.equal((await source.stats()).status, 'unavailable');
    });
}

for (const fileName of ['../escape', 'nested/file', 'nested\\file', '.', '..', 'bad\u0000name'])
{
    test(`rejects an untrusted directory entry ${JSON.stringify(fileName)}`, async t =>
    {
        const source = await fixture(t);
        source.latest = await source.write(1, lines(meta({ history_base: { thread_id: ThreadId,
            end_byte_offset: 1, end_ordinal_exclusive: 1 } }, 1), ...turn('latest', 400)));
        const request = source.request;
        source.request = async (method, params) => method === 'fs/readDirectory'
            ? { entries: [{ fileName, isFile: true, isDirectory: false }] } : request(method, params);
        assert.equal((await source.stats()).status, 'unavailable');
    });
}

test('fails closed when directory discovery returns unknown types or exceeds its bound', async t =>
{
    for (const entries of [null, [{ fileName: 'unknown', isFile: false, isDirectory: false }],
        Array.from({ length: 50001 }, (_, index) => ({ fileName: `file-${index}`, isFile: true, isDirectory: false }))])
    {
        const source = await fixture(t);
        source.latest = await source.write(1, lines(meta({ history_base: { thread_id: ThreadId,
            end_byte_offset: 1, end_ordinal_exclusive: 1 } }, 1), ...turn('latest', 400)));
        const request = source.request;
        source.request = async (method, params) => method === 'fs/readDirectory' ? { entries } : request(method, params);
        assert.equal((await source.stats()).status, 'unavailable');
    }
});

test('rejects a symlink directory before listing it', async t =>
{
    const source = await fixture(t);
    source.latest = await source.write(1, lines(meta({ history_base: { thread_id: ThreadId,
        end_byte_offset: 1, end_ordinal_exclusive: 1 } }, 1), ...turn('latest', 400)));
    const request = source.request;
    source.request = async (method, params) =>
    {
        const response = await request(method, params);
        if (method === 'fs/getMetadata' && params.path.endsWith('/sessions')) response.isSymlink = true;
        return response;
    };
    assert.equal((await source.stats()).status, 'unavailable');
    assert.equal(source.calls.some(call => call.method === 'fs/readDirectory'), false);
});

test('requires directory RPC support when continuation history is needed', async t =>
{
    const source = await fixture(t);
    const prefix = lines(meta(), ...turn('first', 200));
    await source.write(0, prefix);
    source.latest = await source.write(1, lines(meta({ history_base: { thread_id: ThreadId,
        end_byte_offset: Buffer.byteLength(prefix), end_ordinal_exclusive: 5 } }, 5), ...turn('second', 400)));
    const request = source.request;
    source.request = async (method, params) =>
    {
        if (method === 'fs/readDirectory') throw new Error('Unsupported method');
        return request(method, params);
    };
    assert.equal((await source.stats()).status, 'unavailable');
});

test('rejects a changed thread path before accepting a snapshot', async t =>
{
    const source = await fixture(t);
    source.latest = await source.write(0, lines(meta(), ...turn('first', 200)));
    const replacement = await source.write(1, lines(meta(), ...turn('replacement', 400)));
    const request = source.request;
    source.request = async (method, params) =>
    {
        const response = await request(method, params);
        if (method === 'fs/readFile') source.latest = replacement;
        return response;
    };
    assert.equal((await source.stats()).status, 'unavailable');
    source.clock = 15000;
    assert.equal((await source.stats()).totalTokens, 400);
});

test('serializes native polls across hosts while preserving their own snapshots', async t =>
{
    const source = await fixture(t);
    source.latest = await source.write(0, lines(meta(), ...turn('first', 200)));
    let release;
    let entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    const barrier = new Promise(resolve => { release = resolve; });
    const request = source.request;
    source.request = async (method, params) =>
    {
        if (method === 'fs/readFile') { entered(); await barrier; }
        return request(method, params);
    };
    const first = source.stats();
    await waiting;
    let otherCalls = 0;
    const second = source.remoteStore.getStats({ hostId: 'remote-control:other', threadId: ThreadId }, async (method, params) =>
    {
        otherCalls++;
        return request(method, params);
    });
    await new Promise(setImmediate);
    assert.equal(otherCalls, 0);
    release();
    assert.equal((await first).totalTokens, 200);
    assert.equal((await second).totalTokens, 200);
});

test('disposal cancels a download and queued polls without publishing bytes or issuing more RPCs', async t =>
{
    const source = await fixture(t);
    source.latest = await source.write(0, lines(meta(), ...turn('first', 200)));
    let release;
    let entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    const barrier = new Promise(resolve => { release = resolve; });
    const request = source.request;
    source.request = async (method, params) =>
    {
        const response = await request(method, params);
        if (method === 'fs/readFile') { entered(); await barrier; }
        return response;
    };
    const first = source.stats();
    await waiting;
    let queuedCalls = 0;
    const second = source.remoteStore.getStats({ hostId: 'remote-control:other', threadId: ThreadId }, async () => { queuedCalls++; });
    source.remoteStore.dispose();
    const calls = source.calls.length;
    release();
    assert.equal((await first).status, 'unavailable');
    assert.equal((await second).status, 'unavailable');
    assert.equal(queuedCalls, 0);
    assert.equal(source.calls.length, calls);
});

test('rejects unknown deeper directories rather than returning partial discovered history', async t =>
{
    const source = await fixture(t);
    const prefix = lines(meta(), ...turn('first', 200));
    await source.write(0, prefix);
    source.latest = await source.write(1, lines(meta({ history_base: { thread_id: ThreadId,
        end_byte_offset: Buffer.byteLength(prefix), end_ordinal_exclusive: 5 } }, 5), ...turn('second', 400)));
    await fs.mkdir(path.join(source.home, 'sessions', '2026', '10', '24', 'unexpected'));
    assert.equal((await source.stats()).status, 'unavailable');
});

test('ignores unrelated rollout identities during discovery', async t =>
{
    const source = await fixture(t);
    const prefix = lines(meta(), ...turn('first', 200));
    await source.write(0, prefix);
    source.latest = await source.write(1, lines(meta({ history_base: { thread_id: ThreadId,
        end_byte_offset: Buffer.byteLength(prefix), end_ordinal_exclusive: 5 } }, 5), ...turn('second', 400)));
    await fs.writeFile(path.join(source.home, 'sessions', `rollout-2026-10-24T00-00-00-${ParentId}.jsonl`), 'private');
    assert.equal((await source.stats()).turns, 2);
    assert.equal(source.calls.some(call => call.method === 'fs/readFile' && call.params.path.includes(ParentId)), false);
});

test('rejects source counts beyond the shared reader limit before reading candidate files', async t =>
{
    const source = await fixture(t);
    source.latest = await source.write(1, lines(meta({ history_base: { thread_id: ThreadId,
        end_byte_offset: 1, end_ordinal_exclusive: 1 } }, 1), ...turn('second', 400)));
    for (let index = 0; index < 33; index++)
    {
        const segment = `55555555-5555-4555-8555-${String(index).padStart(12, '0')}`;
        await fs.writeFile(path.join(source.home, 'sessions', `rollout-2026-10-23T00-00-00-${ThreadId}_${segment}.jsonl`), '');
    }
    assert.equal((await source.stats()).status, 'unavailable');
    assert.equal(source.calls.filter(call => call.method === 'fs/readFile').length, 1);
});

test('bounds retained directory names across hosts and reloads evicted listings', async t =>
{
    const source = await fixture(t);
    const prefix = lines(meta(), ...turn('first', 200));
    await source.write(0, prefix);
    source.latest = await source.write(1, lines(meta({ history_base: { thread_id: ThreadId,
        end_byte_offset: Buffer.byteLength(prefix), end_ordinal_exclusive: 5 } }, 5), ...turn('second', 400)));
    const request = source.request;
    source.request = async (method, params) =>
    {
        const response = await request(method, params);
        if (method === 'fs/readDirectory' && params.path.endsWith('/sessions'))
            response.entries.push(...Array.from({ length: 26000 }, (_, index) => ({
                fileName: `unrelated-${index}`, isFile: true, isDirectory: false,
            })));
        return response;
    };
    assert.equal((await source.stats()).turns, 2);
    assert.equal((await source.remoteStore.getStats({ hostId: 'remote-control:other', threadId: ThreadId }, source.request)).turns, 2);
    source.clock = 15000;
    assert.equal((await source.stats()).turns, 2);
    assert.equal(source.calls.filter(call => call.method === 'fs/readDirectory' && call.params.path.endsWith('/sessions')).length, 3);
});

test('enforces a per-history byte budget before accepting partial continuation metrics', async t =>
{
    const source = await fixture(t, 'posix', { maxFileBytes: 4096, maxHistoryBytes: 1600 });
    const prefix = lines(meta({ padding: 'x'.repeat(300) }), ...turn('first', 200));
    assert.ok(Buffer.byteLength(prefix) < 1600);
    await source.write(0, prefix);
    const latest = lines(meta({ history_base: { thread_id: ThreadId,
        end_byte_offset: Buffer.byteLength(prefix), end_ordinal_exclusive: 5 } }, 5), ...turn('second', 400));
    assert.ok(Buffer.byteLength(latest) < 1600);
    assert.ok(Buffer.byteLength(prefix + latest) > 1600);
    source.latest = await source.write(1, latest);
    const stats = await source.stats();
    assert.equal(stats.status, 'unavailable');
    assert.equal(stats.totalTokens, null);
});

test('evicts least recently used raw history across hosts without redownloading recently used history', async t =>
{
    const source = await fixture(t, 'posix', { maxFileBytes: 2048, maxHistoryBytes: 3000 });
    source.latest = await source.write(0, lines(meta({ padding: 'x'.repeat(500) }), ...turn('first', 200)));
    const size = (await fs.stat(source.actual(source.latest))).size;
    assert.ok(size > 1000 && size < 1500);
    const identity = hostId => ({ hostId, threadId: ThreadId });
    for (const hostId of ['remote-control:one', 'remote-control:two'])
        assert.equal((await source.remoteStore.getStats(identity(hostId), source.request)).turns, 1);
    source.clock = 15000;
    assert.equal((await source.remoteStore.getStats(identity('remote-control:one'), source.request)).turns, 1);
    assert.equal((await source.remoteStore.getStats(identity('remote-control:three'), source.request)).turns, 1);
    const before = source.calls.filter(call => call.method === 'fs/readFile').length;
    source.clock = 30000;
    assert.equal((await source.remoteStore.getStats(identity('remote-control:one'), source.request)).turns, 1);
    assert.equal(source.calls.filter(call => call.method === 'fs/readFile').length, before);
    assert.equal((await source.remoteStore.getStats(identity('remote-control:two'), source.request)).turns, 1);
    assert.equal(source.calls.filter(call => call.method === 'fs/readFile').length, before + 1);
});

for (const kind of ['ordinary', 'fork', 'continuation'])
{
    test(`rejects a symlink ancestor before downloading a ${kind} rollout`, async t =>
    {
        const source = await fixture(t);
        let header = meta();
        if (kind === 'fork') header = meta({ forked_from_id: ParentId, forked_from_ordinal_exclusive: 5,
            history_base: { thread_id: ParentId, end_byte_offset: 999, end_ordinal_exclusive: 5 } }, 5);
        if (kind === 'continuation') header = meta({ history_base: { thread_id: ThreadId,
            end_byte_offset: 999, end_ordinal_exclusive: 5 } }, 5);
        source.latest = await source.write(kind === 'ordinary' ? 0 : 1, lines(header, ...turn('first', 200)));
        const request = source.request;
        source.request = async (method, params) =>
        {
            const response = await request(method, params);
            if (method === 'fs/getMetadata' && params.path.endsWith('/2026/10')) response.isSymlink = true;
            return response;
        };
        assert.equal((await source.stats()).status, 'unavailable');
        assert.equal(source.calls.some(call => call.method === 'fs/readFile'), false);
    });
}

test('rejects an ancestor swapped to a symlink during an ordinary download', async t =>
{
    const source = await fixture(t);
    source.latest = await source.write(0, lines(meta(), ...turn('first', 200)));
    const request = source.request;
    let downloaded = false;
    source.request = async (method, params) =>
    {
        const response = await request(method, params);
        if (method === 'fs/readFile') downloaded = true;
        if (method === 'fs/getMetadata' && downloaded && params.path.endsWith('/2026/10')) response.isSymlink = true;
        return response;
    };
    assert.equal((await source.stats()).status, 'unavailable');
});

for (const fileName of ['.. ', 'nested.', 'nested:stream', 'C:escape'])
{
    test(`rejects Windows directory names that can alias another path ${JSON.stringify(fileName)}`, async t =>
    {
        const source = await fixture(t, 'windows');
        source.latest = await source.write(1, lines(meta({ history_base: { thread_id: ThreadId,
            end_byte_offset: 1, end_ordinal_exclusive: 1 } }, 1), ...turn('latest', 400)));
        const request = source.request;
        source.request = async (method, params) => method === 'fs/readDirectory'
            ? { entries: [{ fileName, isFile: false, isDirectory: true }] } : request(method, params);
        assert.equal((await source.stats()).status, 'unavailable');
        assert.equal(source.calls.some(call => call.method === 'fs/getMetadata' && call.params.path.includes(fileName)), false);
    });
}

test('discovers history when archived_sessions is absent and native errors have no filesystem code', async t =>
{
    const source = await fixture(t);
    await fs.rmdir(path.join(source.home, 'archived_sessions'));
    const prefix = lines(meta(), ...turn('first', 200));
    await source.write(0, prefix);
    source.latest = await source.write(1, lines(meta({ history_base: { thread_id: ThreadId,
        end_byte_offset: Buffer.byteLength(prefix), end_ordinal_exclusive: 5 } }, 5), ...turn('second', 400)));
    const request = source.request;
    source.request = async (method, params) =>
    {
        try { return await request(method, params); }
        catch { throw new Error('Native RPC failed'); }
    };
    const stats = await source.stats();
    assert.equal(stats.status, 'ok');
    assert.equal(stats.turns, 2);
    assert.equal(source.calls.some(call => call.method === 'fs/getMetadata' && call.params.path.endsWith('/archived_sessions')), false);
});

test('fails closed when an existing archive root cannot be read through native RPC', async t =>
{
    const source = await fixture(t);
    const prefix = lines(meta(), ...turn('first', 200));
    await source.write(0, prefix);
    source.latest = await source.write(1, lines(meta({ history_base: { thread_id: ThreadId,
        end_byte_offset: Buffer.byteLength(prefix), end_ordinal_exclusive: 5 } }, 5), ...turn('second', 400)));
    const request = source.request;
    source.request = async (method, params) =>
    {
        if (method === 'fs/readDirectory' && params.path.endsWith('/archived_sessions')) throw new Error('Native RPC failed');
        return request(method, params);
    };
    assert.equal((await source.stats()).status, 'unavailable');
});

test('fails closed when an expected archive root is a regular file', async t =>
{
    const source = await fixture(t);
    await fs.rmdir(path.join(source.home, 'archived_sessions'));
    await fs.writeFile(path.join(source.home, 'archived_sessions'), 'not a directory');
    const prefix = lines(meta(), ...turn('first', 200));
    await source.write(0, prefix);
    source.latest = await source.write(1, lines(meta({ history_base: { thread_id: ThreadId,
        end_byte_offset: Buffer.byteLength(prefix), end_ordinal_exclusive: 5 } }, 5), ...turn('second', 400)));
    assert.equal((await source.stats()).status, 'unavailable');
});

test('ignores unrelated symlink and socket entries in Codex home during history root discovery', async t =>
{
    const source = await fixture(t);
    const prefix = lines(meta(), ...turn('first', 200));
    await source.write(0, prefix);
    source.latest = await source.write(1, lines(meta({ history_base: { thread_id: ThreadId,
        end_byte_offset: Buffer.byteLength(prefix), end_ordinal_exclusive: 5 } }, 5), ...turn('second', 400)));
    const request = source.request;
    source.request = async (method, params) =>
    {
        const response = await request(method, params);
        if (method === 'fs/readDirectory' && params.path === '/home/test/.codex')
            response.entries.push(...['AGENTS.md', 'skills', 'native.sock'].map(fileName => ({
                fileName, isFile: false, isDirectory: false,
            })));
        return response;
    };
    const stats = await source.stats();
    assert.equal(stats.status, 'ok');
    assert.equal(stats.turns, 2);
    assert.deepEqual(withoutHost(stats), await source.local());
    assert.equal(source.calls.some(call => call.method === 'fs/getMetadata'
        && /\/(AGENTS\.md|skills|native\.sock)$/.test(call.params.path)), false);
});

async function wideHistory(t)
{
    const source = await fixture(t);
    const prefix = lines(meta(), ...turn('first', 200));
    await source.write(0, prefix, 'sessions');
    source.latest = await source.write(1, lines(meta({ history_base: { thread_id: ThreadId,
        end_byte_offset: Buffer.byteLength(prefix), end_ordinal_exclusive: 5 } }, 5), ...turn('second', 400)), 'sessions');
    await Promise.all(Array.from({ length: 16 }, (_, index) =>
        fs.mkdir(path.join(source.home, 'sessions', `batch-${String(index).padStart(2, '0')}`))));
    return source;
}

test('overlaps at most eight metadata checks in discovery and verification while serializing listings and file transfers', async t =>
{
    const source = await wideHistory(t);
    const counts = new Map();
    const active = { discovery: 0, verification: 0 };
    const peak = { discovery: 0, verification: 0 };
    source.hook = async (method, params) =>
    {
        if (method === 'fs/readDirectory' || method === 'fs/readFile')
            assert.equal(active.discovery + active.verification, 0);
        if (method !== 'fs/getMetadata' || !/\/batch-\d+$/.test(params.path)) return;
        const count = (counts.get(params.path) || 0) + 1;
        counts.set(params.path, count);
        const phase = count === 1 ? 'discovery' : 'verification';
        peak[phase] = Math.max(peak[phase], ++active[phase]);
        try { await new Promise(setImmediate); }
        finally { active[phase]--; }
    };
    assert.equal((await source.stats()).turns, 2);
    for (const phase of ['discovery', 'verification'])
        assert.ok(peak[phase] > 1 && peak[phase] <= 8, `${phase} peak was ${peak[phase]}`);
    assert.equal(counts.size, 16);
    assert.ok([...counts.values()].every(count => count === 2));
});

test('a concurrent verification still rejects changed directory metadata', async t =>
{
    const source = await wideHistory(t);
    const counts = new Map();
    source.hook = async (method, params) =>
    {
        if (method !== 'fs/getMetadata' || !/\/batch-\d+$/.test(params.path)) return;
        const count = (counts.get(params.path) || 0) + 1;
        counts.set(params.path, count);
        await new Promise(setImmediate);
        if (count === 2 && params.path.endsWith('/batch-00'))
            await fs.utimes(source.actual(params.path), new Date(), new Date(1900000000000));
    };
    assert.equal((await source.stats()).status, 'unavailable');
});

for (const kind of ['request failure', 'disposal'])
{
    test(`drains a metadata batch after ${kind} before resolving or starting a queued poll`, async t =>
    {
        const source = await wideHistory(t);
        let release;
        let started;
        let batchStarted;
        const firstStarted = new Promise(resolve => { started = resolve; });
        const allStarted = new Promise(resolve => { batchStarted = resolve; });
        const barrier = new Promise(resolve => { release = resolve; });
        let active = 0;
        let peak = 0;
        let failed = false;
        source.hook = async (method, params) =>
        {
            if (method !== 'fs/getMetadata' || !/\/batch-\d+$/.test(params.path)) return;
            peak = Math.max(peak, ++active);
            started();
            if (active === 8) batchStarted();
            try
            {
                if (kind === 'request failure' && !failed && params.path.endsWith('/batch-00'))
                {
                    failed = true;
                    await Promise.race([allStarted, barrier]);
                    throw new Error('Native metadata request failed');
                }
                await barrier;
            }
            finally { active--; }
        };
        let settled = false;
        const pending = source.stats().then(stats => { settled = true; return stats; });
        let queued;
        let queuedCalls = 0;
        try
        {
            await firstStarted;
            await new Promise(setImmediate);
            assert.ok(peak > 1 && peak <= 8, `metadata peak was ${peak}`);
            if (kind === 'disposal') source.remoteStore.dispose();
            queued = source.remoteStore.getStats({ hostId: 'remote-control:queued', threadId: ThreadId }, async (method, params) =>
            {
                queuedCalls++;
                if (queuedCalls === 1 || method === 'fs/readDirectory' || method === 'fs/readFile') assert.equal(active, 0);
                return source.request(method, params);
            });
            await new Promise(setImmediate);
            assert.equal(settled, false);
            assert.equal(queuedCalls, 0);
        }
        finally { release(); }
        assert.equal((await pending).status, 'unavailable');
        if (queued) assert.equal((await queued).status, kind === 'disposal' ? 'unavailable' : 'ok');
        assert.equal(active, 0);
    });
}

test('accepts a frozen latest snapshot after a second read proves append-only growth and refreshes its original cache key', async t =>
{
    const source = await fixture(t);
    const original = lines(meta(), ...turn('first', 200));
    source.latest = await source.write(0, original);
    const frozen = await source.local();
    const request = source.request;
    let reads = 0;
    source.request = async (method, params) =>
    {
        const response = await request(method, params);
        if (method === 'fs/readFile' && ++reads === 1)
            await source.write(0, original + lines(...turn('second', 400)));
        return response;
    };
    const first = await source.stats();
    assert.equal(first.status, 'ok');
    assert.equal(reads, 2);
    assert.deepEqual(withoutHost(first), frozen);
    source.clock = 15000;
    const refreshed = await source.stats();
    assert.equal(refreshed.turns, 2);
    assert.equal(refreshed.totalTokens, 400);
    assert.equal(reads, 3);
    assert.deepEqual(withoutHost(refreshed), await source.local());
});

test('keeps continuation history cached when latest growth is proved after discovery', async t =>
{
    const source = await wideHistory(t);
    const frozen = await source.local();
    const original = await fs.readFile(source.actual(source.latest), 'utf8');
    const request = source.request;
    let changed = false;
    let activeMetadata = 0;
    source.request = async (method, params) =>
    {
        if (method === 'fs/getMetadata')
        {
            activeMetadata++;
            try { await new Promise(setImmediate); return await request(method, params); }
            finally { activeMetadata--; }
        }
        if (method === 'fs/readFile') assert.equal(activeMetadata, 0);
        const response = await request(method, params);
        if (method === 'fs/readDirectory' && !changed)
        {
            changed = true;
            await source.write(1, original + lines(...turn('third', 600)), 'sessions');
        }
        return response;
    };
    const first = await source.stats();
    assert.equal(first.status, 'ok');
    assert.deepEqual(withoutHost(first), frozen);
    assert.equal(source.calls.filter(call => call.method === 'fs/readFile').length, 3);
    source.clock = 15000;
    assert.equal((await source.stats()).turns, 3);
    assert.equal(source.calls.filter(call => call.method === 'fs/readFile').length, 4);
    assert.equal(source.calls.filter(call => call.method === 'fs/readFile' && call.params.path !== source.latest).length, 1);
});

for (const kind of ['same-size rewrite', 'metadata-only change', 'rewrite with growth', 'truncation'])
{
    test(`rejects latest ${kind} instead of treating it as append-only growth`, async t =>
    {
        const source = await fixture(t);
        const original = lines(meta(), ...turn('first', 200));
        source.latest = await source.write(0, original);
        const request = source.request;
        let changed = false;
        source.request = async (method, params) =>
        {
            const response = await request(method, params);
            if (method === 'fs/readFile' && !changed)
            {
                changed = true;
                let next = original;
                if (kind === 'same-size rewrite') next = original.replace('"total_tokens":200', '"total_tokens":900');
                if (kind === 'rewrite with growth') next = lines(meta(), ...turn('replacement', 900), ...turn('second', 1100));
                if (kind === 'truncation') next = original.slice(0, -20);
                await source.write(0, next);
            }
            return response;
        };
        const stats = await source.stats();
        assert.equal(stats.status, 'unavailable');
        assert.equal(stats.totalTokens, null);
    });
}

test('rejects latest recreation before downloading an append confirmation', async t =>
{
    const source = await fixture(t);
    const original = lines(meta(), ...turn('first', 200));
    source.latest = await source.write(0, original);
    const request = source.request;
    let changed = false;
    source.request = async (method, params) =>
    {
        const response = await request(method, params);
        if (method === 'fs/getMetadata' && params.path === source.latest && changed) response.createdAtMs += 1000;
        if (method === 'fs/readFile' && !changed)
        {
            changed = true;
            await source.write(0, original + lines(...turn('second', 400)));
        }
        return response;
    };
    assert.equal((await source.stats()).status, 'unavailable');
    assert.equal(source.calls.filter(call => call.method === 'fs/readFile').length, 1);
});

test('disposal during an append confirmation cannot publish a frozen snapshot', async t =>
{
    const source = await fixture(t);
    const original = lines(meta(), ...turn('first', 200));
    source.latest = await source.write(0, original);
    const request = source.request;
    let reads = 0;
    source.request = async (method, params) =>
    {
        const response = await request(method, params);
        if (method === 'fs/readFile')
        {
            if (++reads === 1) await source.write(0, original + lines(...turn('second', 400)));
            else source.remoteStore.dispose();
        }
        return response;
    };
    assert.equal((await source.stats()).status, 'unavailable');
    assert.equal(reads, 2);
});

for (const kind of ['ancestor symlink', 'creation identity', 'thread path'])
{
    test(`rechecks ${kind} after confirming append-only growth`, async t =>
    {
        const source = await fixture(t);
        const original = lines(meta(), ...turn('first', 200));
        source.latest = await source.write(0, original);
        const request = source.request;
        let reads = 0;
        source.request = async (method, params) =>
        {
            const response = await request(method, params);
            if (method === 'fs/readFile' && ++reads === 1)
                await source.write(0, original + lines(...turn('second', 400)));
            if (reads >= 2)
            {
                if (kind === 'ancestor symlink' && method === 'fs/getMetadata' && params.path.endsWith('/2026/10'))
                    response.isSymlink = true;
                if (kind === 'creation identity' && method === 'fs/getMetadata' && params.path === source.latest)
                    response.createdAtMs += 1000;
                if (kind === 'thread path' && method === 'thread/read')
                    response.thread.path = source.latest.replace('T10-00-00', 'T11-00-00');
            }
            return response;
        };
        assert.equal((await source.stats()).status, 'unavailable');
        assert.equal(reads, 2);
    });
}

test('append confirmation remains bounded by the whole-file and logical history budgets', async t =>
{
    for (const limits of [{ maxFileBytes: 1000 }, { maxHistoryBytes: 1000 }])
    {
        const source = await fixture(t, 'posix', limits);
        const original = lines(meta(), ...turn('first', 200));
        const growth = original + lines(...turn('second', 400));
        assert.ok(Buffer.byteLength(original) < 1000 && Buffer.byteLength(growth) > 1000);
        source.latest = await source.write(0, original);
        const request = source.request;
        let reads = 0;
        source.request = async (method, params) =>
        {
            const response = await request(method, params);
            if (method === 'fs/readFile' && ++reads === 1) await source.write(0, growth);
            return response;
        };
        assert.equal((await source.stats()).status, 'unavailable');
        assert.equal(reads, 2);
    }
});

for (const maxHistoryBytes of [2400, 2000])
{
    test(`append confirmation uses the replacement logical history size with a ${maxHistoryBytes}-byte budget`, async t =>
    {
        const source = await fixture(t, 'posix', { maxFileBytes: 2000, maxHistoryBytes });
        const prefix = lines(meta(), ...turn('first', 200));
        await source.write(0, prefix, 'sessions');
        const original = lines(meta({ history_base: { thread_id: ThreadId,
            end_byte_offset: Buffer.byteLength(prefix), end_ordinal_exclusive: 5 } }, 5), ...turn('second', 400));
        const growth = original + lines(...turn('third', 600));
        assert.ok(Buffer.byteLength(prefix + original) < 2000);
        assert.ok(Buffer.byteLength(prefix + growth) > 2000 && Buffer.byteLength(prefix + growth) < 2400);
        assert.ok(Buffer.byteLength(prefix + original + growth) > 2400);
        source.latest = await source.write(1, original, 'sessions');
        const frozen = await source.local();
        const request = source.request;
        let reads = 0;
        source.request = async (method, params) =>
        {
            const response = await request(method, params);
            if (method === 'fs/readFile' && params.path === source.latest && ++reads === 1)
                await source.write(1, growth, 'sessions');
            return response;
        };
        const stats = await source.stats();
        if (maxHistoryBytes === 2400)
        {
            assert.equal(stats.status, 'ok');
            assert.deepEqual(withoutHost(stats), frozen);
        }
        else assert.equal(stats.status, 'unavailable');
        assert.equal(reads, 2);
    });
}

for (const kind of ['rewrite', 'truncation', 'further append'])
{
    test(`accepts a frozen snapshot when latest ${kind} happens after confirmation payload capture`, async t =>
    {
        const source = await fixture(t);
        const original = lines(meta(), ...turn('first', 200));
        const growth = original + lines(...turn('second', 400));
        source.latest = await source.write(0, original);
        const frozen = await source.local();
        const request = source.request;
        let reads = 0;
        source.request = async (method, params) =>
        {
            const response = await request(method, params);
            if (method === 'fs/readFile')
            {
                if (++reads === 1) await source.write(0, growth);
                else await source.write(0, kind === 'rewrite' ? lines(meta(), ...turn('replacement', 900))
                    : kind === 'truncation' ? original.slice(0, -20) : growth + lines(...turn('third', 600)));
            }
            return response;
        };
        const stats = await source.stats();
        assert.equal(stats.status, 'ok');
        assert.deepEqual(withoutHost(stats), frozen);
        assert.equal(reads, 2);
    });
}

for (const kind of ['rewrite', 'truncation'])
{
    test(`rejects latest ${kind} present before confirmation payload capture`, async t =>
    {
        const source = await fixture(t);
        const original = lines(meta(), ...turn('first', 200));
        source.latest = await source.write(0, original);
        const request = source.request;
        let reads = 0;
        source.request = async (method, params) =>
        {
            if (method === 'fs/readFile' && ++reads === 2)
                await source.write(0, kind === 'rewrite' ? lines(meta(), ...turn('replacement', 900)) : original.slice(0, -20));
            const response = await request(method, params);
            if (method === 'fs/readFile' && reads === 1) await source.write(0, original + lines(...turn('second', 400)));
            return response;
        };
        const stats = await source.stats();
        assert.equal(stats.status, 'unavailable');
        assert.equal(stats.totalTokens, null);
        assert.equal(reads, 2);
    });
}

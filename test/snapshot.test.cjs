'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');

const ThreadId = '11111111-1111-4111-8111-111111111111';
const OtherThreadId = '22222222-2222-4222-8222-222222222222';
const PublisherId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SuffixId = '33333333-3333-7333-8333-333333333333';
const Now = 100000;
const Stats = {
    turns: 3, steps: 5, totalTokens: 1200, inputTokens: 1000, outputTokens: 200,
    cachedInputTokens: 250, cacheHit: 0.25, tps: 80, tpsHeld: true,
    activeTurn: true, modelActiveMs: 2500, status: 'ok',
};
const EmptyStats = {
    turns: null, steps: null, totalTokens: null, inputTokens: null, outputTokens: null,
    cachedInputTokens: null, cacheHit: null, tps: null, tpsHeld: false,
    activeTurn: false, modelActiveMs: null, status: 'unavailable',
};

function protocol()
{
    let loaded;
    assert.doesNotThrow(() => { loaded = require('../src/snapshot.cjs'); }, 'the snapshot module loads');
    assert.equal(typeof loaded.createSnapshotProtocol, 'function');
    return loaded.createSnapshotProtocol();
}

function sample(overrides = {})
{
    return {
        schemaVersion: 1, producer: 'codex-session-stats', threadId: ThreadId,
        publisherId: PublisherId, revision: 1, generatedAt: Now, stats: { ...Stats }, ...overrides,
    };
}

function parsed(value, expected = {})
{
    return protocol().parseSnapshot(typeof value === 'string' ? value : JSON.stringify(value),
        { threadId: ThreadId, now: Now, ...expected });
}

test('normalizes only valid UUID thread identities', () =>
{
    const api = protocol();
    assert.equal(api.normalizeThreadId(PublisherId.toUpperCase()), PublisherId);
    assert.equal(api.normalizeThreadId(SuffixId), SuffixId);
    for (const value of [null, undefined, 1, '', ' ' + ThreadId, `{${ThreadId}}`, '../' + ThreadId,
        '11111111-1111-0111-8111-111111111111', '11111111-1111-4111-7111-111111111111'])
        assert.equal(api.normalizeThreadId(value), null, String(value));
});

test('projects only public statistic fields and preserves zero and nullable metrics', () =>
{
    const api = protocol();
    assert.deepEqual(api.projectStats({ ...Stats, threadId: OtherThreadId, text: 'private', path: '/private' }), Stats);
    assert.deepEqual(api.projectStats({ status: 'ok', tpsHeld: false, activeTurn: false }),
        { ...EmptyStats, status: 'ok' });
    const zero = Object.fromEntries(Object.keys(Stats).map(key => [key,
        key === 'status' ? 'ok' : ['tpsHeld', 'activeTurn'].includes(key) ? false : 0]));
    assert.deepEqual(api.projectStats(zero), zero);
    for (const status of ['not-found', 'unavailable'])
        assert.deepEqual(api.projectStats({ status, ...{ totalTokens: 9000, tpsHeld: true } }), { ...EmptyStats, status });
});

test('rejects invalid counts, duration, TPS, cache ratio, flags and status', () =>
{
    const api = protocol();
    for (const field of ['turns', 'steps', 'totalTokens', 'inputTokens', 'outputTokens', 'cachedInputTokens'])
        for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', false])
            assert.equal(api.projectStats({ ...Stats, [field]: value }), null, `${field}: ${String(value)}`);
    for (const [field, values] of [
        ['modelActiveMs', [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', false]],
        ['tps', [-1, NaN, Infinity, '2', false]],
        ['cacheHit', [-0.001, 1.001, NaN, Infinity, '0.5', true]],
        ['tpsHeld', [null, undefined, 0, 1, 'true']],
        ['activeTurn', [null, undefined, 0, 1, 'false']],
        ['status', [null, undefined, '', 'incomplete', 'OK']],
    ])
        for (const value of values)
            assert.equal(api.projectStats({ ...Stats, [field]: value }), null, `${field}: ${String(value)}`);
    for (const value of [null, undefined, [], 'stats']) assert.equal(api.projectStats(value), null);
});

test('preserves valid fractional model durations through snapshot serialization', () =>
{
    const api = protocol();
    const stats = { ...Stats, modelActiveMs: 2500.125 };
    const snapshot = sample({ stats });
    assert.deepEqual(api.projectStats(stats), stats);
    assert.deepEqual(api.makeSnapshot(ThreadId, stats, { publisherId: PublisherId, revision: 1, now: Now }), snapshot);
    assert.deepEqual(api.parseSnapshot(JSON.stringify(snapshot), { threadId: ThreadId, now: Now }),
        { ok: true, snapshot });
    assert.deepEqual(api.toStats(snapshot), { ...stats, threadId: ThreadId, source: 'snapshot',
        snapshotGeneratedAt: Now, snapshotRevision: 1, snapshotPublisherId: PublisherId });
    assert.equal(api.projectStats({ ...Stats, modelActiveMs: Number.MAX_SAFE_INTEGER }).modelActiveMs,
        Number.MAX_SAFE_INTEGER);
});

test('creates canonical snapshots with no transcript, host or source path fields', () =>
{
    const api = protocol();
    assert.deepEqual(api.makeSnapshot(ThreadId.toUpperCase(), { ...Stats, text: 'private', path: '/private' },
        { publisherId: PublisherId.toUpperCase(), revision: 1, now: Now }), sample());
    for (const options of [undefined, {}, { publisherId: PublisherId, revision: 0, now: Now },
        { publisherId: '../private', revision: 1, now: Now },
        { publisherId: PublisherId, revision: 1.5, now: Now },
        { publisherId: PublisherId, revision: Number.MAX_SAFE_INTEGER + 1, now: Now },
        { publisherId: PublisherId, revision: 1, now: -1 },
        { publisherId: PublisherId, revision: 1, now: Infinity }])
        assert.equal(api.makeSnapshot(ThreadId, Stats, options), null);
    assert.equal(api.makeSnapshot(OtherThreadId + '/private', Stats,
        { publisherId: PublisherId, revision: 1, now: Now }), null);
});

test('parses the canonical schema and returns source metadata without a host binding', () =>
{
    const api = protocol();
    assert.deepEqual(parsed(sample()), { ok: true, snapshot: sample() });
    assert.deepEqual(api.toStats(sample()), { ...Stats, threadId: ThreadId, source: 'snapshot',
        snapshotGeneratedAt: Now, snapshotRevision: 1, snapshotPublisherId: PublisherId });
    const unavailable = sample({ stats: { ...EmptyStats } });
    assert.deepEqual(parsed(unavailable), { ok: true, snapshot: unavailable });
    assert.deepEqual(api.toStats(unavailable), { ...EmptyStats, threadId: ThreadId, source: 'snapshot',
        snapshotGeneratedAt: Now, snapshotRevision: 1, snapshotPublisherId: PublisherId,
        unavailableReason: 'source-unavailable' });
});

test('rejects noncanonical schema, fields, identifiers and projected source failures', () =>
{
    const extraRoot = sample({ privateText: 'private' });
    const extraStats = sample({ stats: { ...Stats, sourcePath: '/private' } });
    const missingRoot = sample();
    delete missingRoot.revision;
    const missingStat = sample();
    delete missingStat.stats.turns;
    for (const value of [null, [], {}, extraRoot, extraStats, missingRoot, missingStat,
        sample({ schemaVersion: 2 }), sample({ producer: 'claude-session-stats' }),
        sample({ threadId: PublisherId.toUpperCase() }), sample({ publisherId: PublisherId.toUpperCase() }),
        sample({ revision: 0 }), sample({ generatedAt: 0.5 }),
        sample({ stats: { ...EmptyStats, turns: 0 } }), sample({ stats: { ...EmptyStats, activeTurn: true } }),
        sample({ stats: { ...Stats, cacheHit: 2 } }), sample({ stats: { ...Stats, turns: 0.5 } })])
        assert.deepEqual(parsed(value), { ok: false, reason: 'invalid' }, JSON.stringify(value));
    for (const value of ['', '{', 'undefined', 1, null])
        assert.deepEqual(protocol().parseSnapshot(value, { threadId: ThreadId, now: Now }), { ok: false, reason: 'invalid' });
});

test('rejects mismatched identity and untrusted validation clocks', () =>
{
    assert.deepEqual(parsed(sample(), { threadId: OtherThreadId }), { ok: false, reason: 'identity' });
    assert.deepEqual(parsed(sample(), { threadId: null }), { ok: false, reason: 'identity' });
    for (const now of [undefined, -1, 0.5, NaN, Infinity, '100000'])
        assert.deepEqual(parsed(sample(), { now }), { ok: false, reason: 'invalid' });
    assert.equal(parsed(sample(), { threadId: ThreadId.toUpperCase() }).ok, true);
});

test('enforces age and future-skew boundaries', () =>
{
    assert.equal(parsed(sample({ generatedAt: Now - 30000 })).ok, true);
    assert.deepEqual(parsed(sample({ generatedAt: Now - 30001 })), { ok: false, reason: 'expired' });
    assert.equal(parsed(sample({ generatedAt: Now + 5000 })).ok, true);
    assert.deepEqual(parsed(sample({ generatedAt: Now + 5001 })), { ok: false, reason: 'future' });
});

test('enforces the 16 KiB bound in UTF-8 bytes before parsing', () =>
{
    const json = JSON.stringify(sample());
    assert.equal(parsed(json + ' '.repeat(16384 - Buffer.byteLength(json))).ok, true);
    assert.deepEqual(parsed(json + ' '.repeat(16385 - Buffer.byteLength(json))), { ok: false, reason: 'invalid' });
    const oversized = json.replace('"ok"', '"' + '中'.repeat(6000) + '"');
    assert.ok(oversized.length < 16384);
    assert.ok(Buffer.byteLength(oversized) > 16384);
    assert.deepEqual(parsed(oversized), { ok: false, reason: 'invalid' });
});

test('derives snapshot paths from explicit safe homes and canonical UUIDs', () =>
{
    const api = protocol();
    assert.equal(api.snapshotPath('/home/user/.codex', PublisherId.toUpperCase(), path.posix),
        '/home/user/.codex/.session-stats/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json');
    assert.equal(api.snapshotPath('C:\\Users\\user\\.codex', ThreadId, path.win32),
        `C:\\Users\\user\\.codex\\.session-stats\\${ThreadId}.json`);
    for (const home of ['', 'relative/.codex', '/home/../private', '/home\u0000/private',
        'C:\\Users\\.. \\private', 'C:\\Users\\name:stream', '\\\\.\\C:\\private'])
        assert.equal(api.snapshotPath(home, ThreadId), null, home);
    assert.equal(api.snapshotPath('/home/user/.codex', '../private', path.posix), null);
});

test('locates POSIX and Windows snapshot homes from sessions and archives', () =>
{
    const api = protocol();
    for (const [rolloutPath, codexHome, pathApi] of [
        [`/home/user/.codex/sessions/2026/10/25/rollout-2026-10-25T10-00-00-${ThreadId}.jsonl`, '/home/user/.codex', path.posix],
        [`/custom home/archived_sessions/rollout-date-${ThreadId}_${SuffixId}.jsonl`, '/custom home', path.posix],
        [`C:\\Users\\user\\.codex\\sessions\\2026\\10\\25\\rollout-date-${ThreadId}.jsonl`, 'C:\\Users\\user\\.codex', path.win32],
        [`C:\\codex\\ARCHIVED_SESSIONS\\rollout-date-${ThreadId}_${SuffixId}.jsonl`, 'C:\\codex', path.win32],
        [`\\\\?\\C:\\codex\\sessions\\rollout-date-${ThreadId}.jsonl`, '\\\\?\\C:\\codex', path.win32],
        [`\\\\server\\share\\codex\\sessions\\rollout-date-${ThreadId}.jsonl`, '\\\\server\\share\\codex', path.win32],
        [`\\\\?\\UNC\\server\\share\\codex\\sessions\\rollout-date-${ThreadId}.jsonl`, '\\\\?\\UNC\\server\\share\\codex', path.win32],
    ])
    {
        const result = api.remoteContext(rolloutPath, ThreadId.toUpperCase());
        assert.ok(result, rolloutPath);
        assert.equal(result.codexHome, codexHome);
        assert.equal(result.directory, pathApi.join(codexHome, '.session-stats'));
        assert.equal(result.file, pathApi.join(codexHome, '.session-stats', `${ThreadId}.json`));
        assert.equal(result.pathApi, pathApi);
    }
});

test('never guesses a snapshot root from standalone, mismatched or malformed rollout names', () =>
{
    const api = protocol();
    for (const value of [
        `/private/rollout-date-${ThreadId}.jsonl`,
        `/private/Sessions/rollout-date-${ThreadId}.jsonl`,
        `/home/user/.codex/sessions/rollout-date-${OtherThreadId}.jsonl`,
        `/home/user/.codex/sessions/rollout-date-${OtherThreadId}_${ThreadId}.jsonl`,
        `/home/user/.codex/sessions/rollout-date-${ThreadId}_private.jsonl`,
        `/home/user/.codex/sessions/rollout-date-${ThreadId}_.jsonl`,
        `/home/user/.codex/sessions/rollout-date-${ThreadId}_${SuffixId}_${SuffixId}.jsonl`,
        `/home/user/.codex/sessions/rollout-date-${ThreadId}_${SuffixId}.other.jsonl`,
        `/home/user/.codex/sessions/not-rollout-${ThreadId}.jsonl`,
        `/home/user/.codex/sessions/rollout-date-${ThreadId}.jsonl/other`,
        `/home/user/.codex/sessions/rollout-date-${ThreadId}_11111111-1111-0111-8111-111111111111.jsonl`,
        `/home/user/.codex/sessions/rollout-date-${ThreadId}_11111111-1111-4111-7111-111111111111.jsonl`,
    ]) assert.equal(api.remoteContext(value, ThreadId), null, value);
});

test('rejects unsafe path forms before deriving any remote snapshot target', () =>
{
    const api = protocol();
    for (const root of [
        'relative/sessions', '/home/../sessions', '/home/./sessions', '/home\u0000/sessions',
        '/home\\private/sessions', 'C:relative\\sessions', '\\codex\\sessions',
        'C:\\Users\\.. \\sessions', 'C:\\Users\\name.\\sessions',
        'C:\\Users\\name:stream\\sessions', 'C:\\Users\\name?\\sessions',
        'C:\\Users\\CON\\sessions', '\\\\.\\C:\\codex\\sessions',
        '\\\\?\\GLOBALROOT\\Device\\codex\\sessions', '\\\\server\\sessions',
    ])
    {
        const separator = root.includes('\\') ? '\\' : '/';
        assert.equal(api.remoteContext(`${root}${separator}rollout-date-${ThreadId}.jsonl`, ThreadId), null, root);
    }
    assert.equal(api.remoteContext(`/home/user/.codex/sessions/rollout-date-${ThreadId}.jsonl`, null), null);
});

test('requires a UUID nonce for each immutable demand-marker path', () =>
{
    const api = protocol();
    for (const nonce of [undefined, null, 1, '', '../private',
        '11111111-1111-0111-8111-111111111111', '11111111-1111-4111-7111-111111111111'])
        assert.equal(api.requestPath('/home/user/.codex', ThreadId, nonce), null, String(nonce));
    assert.equal(api.requestPath('/home/user/.codex', ThreadId, SuffixId),
        `/home/user/.codex/.session-stats/requests/${ThreadId}.${SuffixId}.json`);
    assert.equal(api.requestPath('/home/user/.codex', ThreadId, OtherThreadId),
        `/home/user/.codex/.session-stats/requests/${ThreadId}.${OtherThreadId}.json`);
});

test('derives bounded demand-marker locations only from safe homes and UUIDs', () =>
{
    const api = protocol();
    assert.equal(typeof api.requestPath, 'function');
    for (const [home, pathApi, expected] of [
        ['/home/user/.codex', path.posix, `/home/user/.codex/.session-stats/requests/${PublisherId}.${SuffixId}.json`],
        ['C:\\Users\\user\\.codex', path.win32, `C:\\Users\\user\\.codex\\.session-stats\\requests\\${PublisherId}.${SuffixId}.json`],
        ['\\\\?\\C:\\codex', path.win32, `\\\\?\\C:\\codex\\.session-stats\\requests\\${PublisherId}.${SuffixId}.json`],
    ]) assert.equal(api.requestPath(home, PublisherId.toUpperCase(), SuffixId.toUpperCase(), pathApi), expected);
    for (const home of ['', 'relative/.codex', '/home/../private', '/home\u0000/private',
        'C:\\Users\\.. \\private', 'C:\\Users\\name:stream', '\\\\.\\C:\\private'])
        assert.equal(api.requestPath(home, ThreadId, SuffixId), null, home);
    assert.equal(api.requestPath('/home/user/.codex', '../private', SuffixId), null);
});

test('makes demand markers containing only a canonical thread identity and time', () =>
{
    const api = protocol();
    assert.equal(typeof api.makeRequest, 'function');
    assert.deepEqual(api.makeRequest(PublisherId.toUpperCase(), { now: Now, text: 'private', path: '/private' }), {
        schemaVersion: 1, producer: 'codex-session-stats-request', threadId: PublisherId, requestedAt: Now,
    });
    assert.deepEqual(api.makeRequest(ThreadId, { now: 0 }), {
        schemaVersion: 1, producer: 'codex-session-stats-request', threadId: ThreadId, requestedAt: 0,
    });
    for (const options of [undefined, null, [], {}, { now: -1 }, { now: 0.5 }, { now: Infinity },
        { now: Number.MAX_SAFE_INTEGER + 1 }, { now: '100000' }])
        assert.equal(api.makeRequest(ThreadId, options), null);
    assert.equal(api.makeRequest('../private', { now: Now }), null);
});

test('parses only the exact canonical demand-marker schema', () =>
{
    const api = protocol();
    assert.equal(typeof api.parseRequest, 'function');
    const request = { schemaVersion: 1, producer: 'codex-session-stats-request', threadId: PublisherId, requestedAt: Now };
    const expected = { threadId: PublisherId.toUpperCase(), now: Now };
    assert.deepEqual(api.parseRequest(JSON.stringify(request), expected), { ok: true, request });
    const missing = { ...request };
    delete missing.requestedAt;
    for (const value of [null, [], {}, missing, { ...request, text: 'private' },
        { ...request, schemaVersion: 2 }, { ...request, producer: 'codex-session-stats' },
        { ...request, threadId: PublisherId.toUpperCase() }, { ...request, threadId: '../private' },
        { ...request, requestedAt: -1 }, { ...request, requestedAt: 0.5 },
        { ...request, requestedAt: Number.MAX_SAFE_INTEGER + 1 }])
        assert.deepEqual(api.parseRequest(JSON.stringify(value), expected), { ok: false, reason: 'invalid' });
    for (const text of [undefined, null, 1, '', '{'])
        assert.deepEqual(api.parseRequest(text, expected), { ok: false, reason: 'invalid' });
    for (const now of [undefined, -1, 0.5, Infinity, '100000'])
        assert.deepEqual(api.parseRequest(JSON.stringify(request), { ...expected, now }), { ok: false, reason: 'invalid' });
    assert.deepEqual(api.parseRequest(JSON.stringify(request), null), { ok: false, reason: 'invalid' });
});

test('binds demand markers to the expected thread and freshness window', () =>
{
    const api = protocol();
    assert.equal(typeof api.parseRequest, 'function');
    const request = { schemaVersion: 1, producer: 'codex-session-stats-request', threadId: ThreadId, requestedAt: Now };
    const parse = (requestedAt, expected = {}) => api.parseRequest(JSON.stringify({ ...request, requestedAt }),
        { threadId: ThreadId, now: Now, ...expected });
    assert.deepEqual(parse(Now, { threadId: OtherThreadId }), { ok: false, reason: 'identity' });
    assert.deepEqual(parse(Now, { threadId: null }), { ok: false, reason: 'identity' });
    assert.equal(parse(Now - 30000).ok, true);
    assert.deepEqual(parse(Now - 30001), { ok: false, reason: 'expired' });
    assert.equal(parse(Now + 5000).ok, true);
    assert.deepEqual(parse(Now + 5001), { ok: false, reason: 'future' });
    assert.deepEqual(parse(Now - 30001, { now: Now - 30001 }), {
        ok: true, request: { ...request, requestedAt: Now - 30001 },
    });
});

test('bounds demand-marker content to one KiB of UTF-8 before JSON parsing', () =>
{
    const api = protocol();
    assert.equal(typeof api.parseRequest, 'function');
    const json = JSON.stringify({ schemaVersion: 1, producer: 'codex-session-stats-request',
        threadId: ThreadId, requestedAt: Now });
    const expected = { threadId: ThreadId, now: Now };
    assert.equal(api.parseRequest(json + ' '.repeat(1024 - Buffer.byteLength(json)), expected).ok, true);
    assert.deepEqual(api.parseRequest(json + ' '.repeat(1025 - Buffer.byteLength(json)), expected),
        { ok: false, reason: 'invalid' });
    const oversized = json.replace('codex-session-stats-request', '中'.repeat(400));
    assert.ok(oversized.length < 1024);
    assert.ok(Buffer.byteLength(oversized) > 1024);
    assert.deepEqual(api.parseRequest(oversized, expected), { ok: false, reason: 'invalid' });
});

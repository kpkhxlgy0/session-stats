'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { zstdCompressSync } = require('node:zlib');
const { test } = require('node:test');
const { createSessionStore } = require('../src/session-store.cjs');

const Parent = '11111111-1111-4111-8111-111111111111';
const Segment = '22222222-2222-4222-8222-222222222222';
const Child = '33333333-3333-4333-8333-333333333333';

function turn(id, output, input, cached, duration = 2000)
{
    return [
        { type: 'event_msg', payload: { type: 'task_started', turn_id: id } },
        { type: 'event_msg', payload: { type: 'item_completed', turn_id: id,
            item: { type: 'AgentMessage', id }, started_at_ms: 1000, completed_at_ms: 1000 + duration } },
        { type: 'token_usage_record', payload: { turn_id: id, response_id: `response-${id}`,
            usage: { input_tokens: input, output_tokens: output, cached_input_tokens: cached,
                total_tokens: input + output }, thread_token_usage: { input_tokens: 10000 + input,
                output_tokens: 1000 + output, total_tokens: 11000 + input + output,
                cached_input_tokens: 9000 + cached } } },
        { type: 'event_msg', payload: { type: 'task_complete', turn_id: id } },
    ];
}

function lines(records, ordinal)
{
    return records.map((record, i) => JSON.stringify({ ...record, ordinal: ordinal + i }) + '\n').join('');
}

function content(start, records, metadata = {})
{
    return sessionContent(Child, start, records, metadata);
}

function sessionContent(id, start, records, metadata = {})
{
    return lines([{ type: 'session_meta', payload: { id, session_id: id,
        history_mode: 'paginated', ...metadata } }, ...records], start);
}

async function fixture(t, { parentRecords = turn('parent', 10, 200, 100),
    childRecords = turn('first', 20, 100, 50), missingParent = false, parentMetadata = {} } = {})
{
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-post-fork-'));
    const directory = path.join(codexHome, 'sessions', '2026', '10', '22');
    await fs.mkdir(directory, { recursive: true });
    const store = createSessionStore({ codexHome });
    t.after(async () => { store.dispose(); await fs.rm(codexHome, { recursive: true }); });
    async function write(name, value)
    {
        const filename = path.join(directory, `rollout-2026-10-22T${name}.jsonl`);
        await fs.writeFile(filename, value);
        return filename;
    }
    const parentPrefix = sessionContent(Parent, 0, parentRecords, parentMetadata);
    const cut = 1 + parentRecords.length;
    const parent = missingParent ? null : await write(`01-00-00-${Parent}_${Segment}`, parentPrefix);
    const metadata = { forked_from_id: Parent, forked_from_ordinal_exclusive: cut,
        history_base: { thread_id: Segment, end_ordinal_exclusive: cut, end_byte_offset: Buffer.byteLength(parentPrefix) } };
    const prefix = content(cut, childRecords, metadata);
    const file = await write(`02-00-00-${Child}`, prefix);
    return { store, file, write, prefix, metadata, directory, cut, parent, parentPrefix, codexHome };
}

function instrumentedStore(t, f, onRead)
{
    const opens = new Map();
    const store = createSessionStore({ codexHome: f.codexHome, fileSystem: { ...fs,
        async open(filename, flags)
        {
            const handle = await fs.open(filename, flags);
            const opened = (opens.get(filename) || 0) + 1;
            opens.set(filename, opened);
            return {
                stat: (...args) => handle.stat(...args),
                close: () => handle.close(),
                async read(buffer, offset, length, position)
                {
                    const result = await handle.read(buffer, offset, length, position);
                    await onRead({ filename, opened, length, position });
                    return result;
                },
            };
        },
    } });
    t.after(() => store.dispose());
    return store;
}

function assertFirst(stats)
{
    assert.equal(stats.status, 'ok');
    assert.equal(stats.turns, 1); assert.equal(stats.steps, 1);
    assert.equal(stats.totalTokens, 120); assert.equal(stats.inputTokens, 100);
    assert.equal(stats.outputTokens, 20); assert.equal(stats.cachedInputTokens, 50);
    assert.equal(stats.cacheHit, 0.5); assert.equal(stats.tps, 7.5);
    assert.equal(stats.modelActiveMs, 4000);
}

test('a fork inherits parent TPS while retaining only its own response totals', async t =>
{
    const f = await fixture(t);
    assertFirst(await f.store.getStats(Child));
});

test('a missing parent leaves inherited TPS unknown while preserving branch counters', async t =>
{
    const f = await fixture(t, { missingParent: true });
    const stats = await f.store.getStats(Child);
    assert.equal(stats.status, 'ok'); assert.equal(stats.turns, 1); assert.equal(stats.steps, 1);
    assert.equal(stats.totalTokens, 120); assert.equal(stats.cacheHit, 0.5);
    assert.equal(stats.tps, null); assert.equal(stats.modelActiveMs, null);
    await fs.writeFile(path.join(f.directory, `rollout-2026-10-22T01-00-00-${Parent}_${Segment}.jsonl.zst`),
        'invalid compressed history');
    assert.equal((await f.store.getStats(Child)).tps, null);
});

test('post-fork usage deduplicates response replay and ignores inherited cumulative snapshots', async t =>
{
    const f = await fixture(t);
    assertFirst(await f.store.getStats(Child));
    await fs.appendFile(f.file, lines(turn('first', 20, 100, 50), f.cut + 5));
    await fs.appendFile(f.file, lines([{ type: 'event_msg', payload: { type: 'token_count',
        info: { total_token_usage: { total_tokens: 999999, input_tokens: 999000,
            output_tokens: 999, cached_input_tokens: 900000 } } } }], f.cut + 9));
    assertFirst(await f.store.getStats(Child));
    await fs.appendFile(f.file, lines(turn('second', 30, 200, 150), f.cut + 10));
    const results = await Promise.all(Array.from({ length: 10 }, () => f.store.getStats(Child)));
    for (const stats of results)
    {
        assert.equal(stats.turns, 2); assert.equal(stats.steps, 2);
        assert.equal(stats.totalTokens, 350); assert.equal(stats.cachedInputTokens, 200);
        assert.equal(stats.cacheHit, 2 / 3); assert.equal(stats.tps, 10);
        assert.equal(stats.modelActiveMs, 6000);
    }
});

test('continuations of a fork include inherited TPS and use cumulative record ordinals', async t =>
{
    const f = await fixture(t);
    await fs.appendFile(f.file, lines(turn('abandoned', 999, 999, 0), f.cut + 5));
    const continuation = content(f.cut + 5, turn('second', 30, 200, 150), {
        ...f.metadata, history_base: { thread_id: Child, end_ordinal_exclusive: f.cut + 5,
            end_byte_offset: Buffer.byteLength(f.prefix) },
    });
    await f.write(`03-00-00-${Child}_${Segment}`, continuation);
    const stats = await f.store.getStats(Child);
    assert.equal(stats.status, 'ok'); assert.equal(stats.turns, 2); assert.equal(stats.steps, 2);
    assert.equal(stats.totalTokens, 350); assert.equal(stats.tps, 10);
    assert.equal(stats.modelActiveMs, 6000);
});

test('invalid fork boundaries cannot disable the history checks', async t =>
{
    const f = await fixture(t);
    for (const extra of [{ forked_from_id: '../parent' }, { forked_from_id: Child },
        { forked_from_ordinal_exclusive: f.cut - 1 }, { forked_from_ordinal_exclusive: -1 }])
    {
        await fs.writeFile(f.file, content(f.cut, turn('first', 20, 100, 50), { ...f.metadata, ...extra }));
        assert.equal((await f.store.getStats(Child)).status, 'unavailable');
    }
});

test('later fork continuations can identify the previous segment by its filename suffix', async t =>
{
    const f = await fixture(t);
    const second = content(f.cut + 5, turn('second', 30, 200, 150), {
        ...f.metadata, history_base: { thread_id: Child, end_ordinal_exclusive: f.cut + 5,
            end_byte_offset: Buffer.byteLength(f.prefix) },
    });
    await f.write(`03-00-00-${Child}_${Segment}`, second + lines(turn('abandoned', 999, 999, 0), f.cut + 10));
    await f.write(`04-00-00-${Child}_${Parent}`, content(f.cut + 10,
        [...turn('second', 30, 200, 150), ...turn('third', 40, 300, 250)], {
            ...f.metadata, history_base: { thread_id: Segment, end_ordinal_exclusive: f.cut + 10,
                end_byte_offset: Buffer.byteLength(second) },
        }));
    const stats = await f.store.getStats(Child);
    assert.equal(stats.status, 'ok'); assert.equal(stats.turns, 3); assert.equal(stats.steps, 3);
    assert.equal(stats.totalTokens, 690); assert.equal(stats.cachedInputTokens, 450);
    assert.equal(stats.cacheHit, 0.75); assert.equal(stats.tps, 12.5);
    assert.equal(stats.modelActiveMs, 8000);
    assert.deepEqual(await f.store.getStats(Child), stats);
});

test('missing per-response usage never falls back to inherited thread totals', async t =>
{
    const f = await fixture(t);
    const records = turn('first', 20, 100, 50);
    delete records[2].payload.usage.input_tokens;
    await fs.writeFile(f.file, content(f.cut, records, f.metadata));
    const stats = await f.store.getStats(Child);
    assert.equal(stats.status, 'ok'); assert.equal(stats.inputTokens, null);
    assert.equal(stats.cacheHit, null); assert.equal(stats.outputTokens, 20); assert.equal(stats.tps, 7.5);
});

test('a response without an identity leaves fork totals unknown even after later complete responses', async t =>
{
    const f = await fixture(t);
    const records = turn('first', 20, 100, 50);
    delete records[2].payload.response_id;
    await fs.writeFile(f.file, content(f.cut, [...records, ...turn('second', 30, 200, 150)], f.metadata));
    const stats = await f.store.getStats(Child);
    assert.equal(stats.status, 'ok'); assert.equal(stats.totalTokens, null);
    assert.equal(stats.inputTokens, null); assert.equal(stats.outputTokens, null);
    assert.equal(stats.cachedInputTokens, null); assert.equal(stats.cacheHit, null);
    assert.equal(stats.tps, 10);
    assert.equal(stats.modelActiveMs, 4000);
});

test('inherited TPS uses a weighted duration average instead of adding parent averages', async t =>
{
    const f = await fixture(t, { parentRecords: turn('parent', 1000, 200, 100, 5000),
        childRecords: turn('first', 1000, 100, 50, 20000) });
    const stats = await f.store.getStats(Child);
    assert.equal(stats.tps, 80); assert.equal(stats.modelActiveMs, 25000);
    assert.equal(stats.outputTokens, 1000); assert.equal(stats.steps, 1); assert.equal(stats.turns, 1);
});

test('a newly created fork already has inherited TPS without inheriting parent live state', async t =>
{
    const f = await fixture(t, { childRecords: [], parentRecords: [...turn('parent', 1000, 200, 100, 5000),
        { type: 'event_msg', payload: { type: 'task_started', turn_id: 'parent-pending' } }] });
    let stats = await f.store.getStats(Child);
    assert.equal(stats.tps, 200); assert.equal(stats.modelActiveMs, 5000);
    assert.equal(stats.turns, 0); assert.equal(stats.activeTurn, false); assert.equal(stats.tpsHeld, false);
    await fs.appendFile(f.file, lines([{ type: 'event_msg', payload: { type: 'task_started', turn_id: 'child-pending' } }], f.cut + 1));
    stats = await f.store.getStats(Child);
    assert.equal(stats.tps, 200); assert.equal(stats.activeTurn, true); assert.equal(stats.tpsHeld, true);
});

test('appending a parent tail never changes the inherited prefix', async t =>
{
    const f = await fixture(t);
    const first = await f.store.getStats(Child);
    await fs.appendFile(f.parent, lines(turn('parent-later', 999, 999, 0), f.cut));
    assert.deepEqual(await f.store.getStats(Child), first);
    const fresh = createSessionStore({ codexHome: f.codexHome });
    try { assert.deepEqual(await fresh.getStats(Child), first); }
    finally { fresh.dispose(); }
});

test('stable parent prefixes reuse the TPS accumulator across polls and ancestry refreshes', async t =>
{
    t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 23) });
    const f = await fixture(t);
    let accumulators = 0;
    const store = createSessionStore({ codexHome: f.codexHome, createMetrics: options =>
    {
        accumulators++;
        return require('../src/metrics.cjs').createMetrics(options);
    } });
    try
    {
        const stats = await store.getStats(Child);
        const initial = accumulators;
        for (let i = 0; i < 4; i++) assert.deepEqual(await store.getStats(Child), stats);
        t.mock.timers.tick(16000);
        assert.deepEqual(await store.getStats(Child), stats);
        assert.equal(accumulators, initial);
    }
    finally { store.dispose(); }
});

test('inherited response replay is deduplicated with child usage in one TPS accumulator', async t =>
{
    const f = await fixture(t, { childRecords: [...turn('parent', 10, 200, 100), ...turn('first', 20, 100, 50)] });
    const stats = await f.store.getStats(Child);
    assert.equal(stats.tps, 7.5); assert.equal(stats.modelActiveMs, 4000);
    assert.equal(stats.turns, 2); assert.equal(stats.steps, 2); assert.equal(stats.totalTokens, 330);
});

test('inherited timing can match usage completed by the child branch', async t =>
{
    const records = turn('shared-turn', 1000, 100, 50, 5000);
    const f = await fixture(t, { parentRecords: records.slice(0, 2), childRecords: records.slice(2) });
    const stats = await f.store.getStats(Child);
    assert.equal(stats.status, 'ok'); assert.equal(stats.tps, 200); assert.equal(stats.modelActiveMs, 5000);
    assert.equal(stats.turns, 1); assert.equal(stats.steps, 1); assert.equal(stats.outputTokens, 1000);
});

for (const corruption of ['malformed JSON', 'oversized JSON'])
{
    test(`required inherited ${corruption} clears TPS without losing branch counters`, async t =>
    {
        const f = await fixture(t, { parentRecords: [...turn('parent-first', 1000, 100, 50, 1000),
            ...turn('parent-second', 2000, 100, 50, 1000)], childRecords: turn('first', 1000, 100, 50, 1000) });
        const records = f.parentPrefix.trimEnd().split('\n');
        const usage = records.findIndex(record => JSON.parse(record).type === 'token_usage_record');
        records[usage] = corruption === 'malformed JSON' ? '{broken-json'
            : JSON.stringify({ padding: 'x'.repeat(8 * 1024 * 1024) });
        const parent = records.join('\n') + '\n';
        await fs.writeFile(f.parent, parent);
        f.metadata.history_base.end_byte_offset = Buffer.byteLength(parent);
        await fs.writeFile(f.file, content(f.cut, turn('first', 1000, 100, 50, 1000), f.metadata));
        const stats = await f.store.getStats(Child);
        assert.equal(stats.status, 'ok'); assert.equal(stats.tps, null); assert.equal(stats.modelActiveMs, null);
        assert.equal(stats.turns, 1); assert.equal(stats.steps, 1); assert.equal(stats.totalTokens, 1100);
    });

    test(`child ${corruption} retains the existing tolerant parser`, async t =>
    {
        const f = await fixture(t);
        const invalid = corruption === 'malformed JSON' ? '{broken-json'
            : JSON.stringify({ padding: 'x'.repeat(8 * 1024 * 1024) });
        await fs.appendFile(f.file, invalid + '\n' + lines(turn('second', 30, 200, 150), f.cut + 6));
        const stats = await f.store.getStats(Child);
        assert.equal(stats.status, 'ok'); assert.equal(stats.tps, 10); assert.equal(stats.modelActiveMs, 6000);
        assert.equal(stats.turns, 2); assert.equal(stats.steps, 2); assert.equal(stats.totalTokens, 350);
    });
}

for (const phase of ['parent read', 'child read'])
{
    for (const repeated of [false, true])
    {
        test(`inherited mutations during ${phase} ${repeated ? 'stop after one rebuild' : 'rebuild without mixing versions'}`, async t =>
        {
            const f = await fixture(t, { parentRecords: [...turn('parent-first', 1000, 100, 50, 1000),
                { type: 'padding', payload: { text: 'x'.repeat(70 * 1024) } },
                ...turn('parent-second', 2000, 100, 50, 1000)], childRecords: turn('first', 1000, 100, 50, 1000) });
            const prefixes = [f.parentPrefix.replaceAll('"output_tokens":1000', '"output_tokens":9000')
                .replaceAll('"output_tokens":2000', '"output_tokens":8000'),
                f.parentPrefix.replaceAll('"output_tokens":1000', '"output_tokens":7000')
                    .replaceAll('"output_tokens":2000', '"output_tokens":6000')];
            let mutations = 0;
            const store = instrumentedStore(t, f, async ({ filename, opened, length, position }) =>
            {
                const selected = phase === 'parent read'
                    ? filename === f.parent && opened % 3 === 0 && length === 64 * 1024
                    : filename === f.file && opened >= 2;
                if (!selected || position !== 0 || mutations >= (repeated ? 2 : 1)) return;
                await fs.writeFile(f.parent, prefixes[mutations++]);
                await fs.utimes(f.parent, new Date(), new Date(Date.now() + mutations * 1000));
            });
            const stats = await store.getStats(Child);
            assert.equal(stats.status, 'ok'); assert.equal(stats.tps, repeated ? null : 6000);
            assert.equal(stats.modelActiveMs, repeated ? null : 3000);
            assert.equal(stats.turns, 1); assert.equal(stats.steps, 1); assert.equal(stats.totalTokens, 1100);
            assert.equal(mutations, repeated ? 2 : 1);
        });
    }
}

for (const repeated of [false, true])
{
    test(`compressed parent mutations during child reads ${repeated ? 'stop after one rebuild' : 'recheck physical path versions'}`,
        { skip: typeof zstdCompressSync !== 'function' }, async t =>
    {
        const f = await fixture(t, { parentRecords: [...turn('parent-first', 1000, 100, 50, 1000),
            ...turn('parent-second', 2000, 100, 50, 1000)], childRecords: turn('first', 1000, 100, 50, 1000) });
        const parent = `${f.parent}.zst`;
        await fs.writeFile(parent, zstdCompressSync(Buffer.from(f.parentPrefix)));
        await fs.unlink(f.parent);
        const prefixes = [f.parentPrefix.replaceAll('"output_tokens":1000', '"output_tokens":9000')
            .replaceAll('"output_tokens":2000', '"output_tokens":8000'),
            f.parentPrefix.replaceAll('"output_tokens":1000', '"output_tokens":7000')
                .replaceAll('"output_tokens":2000', '"output_tokens":6000')];
        let mutations = 0;
        const store = instrumentedStore(t, f, async ({ filename, opened, position }) =>
        {
            if (filename !== f.file || opened < 2 || position !== 0 || mutations >= (repeated ? 2 : 1)) return;
            await fs.writeFile(parent, zstdCompressSync(Buffer.from(prefixes[mutations++])));
            await fs.utimes(parent, new Date(), new Date(Date.now() + mutations * 1000));
        });
        const stats = await store.getStats(Child);
        assert.equal(stats.status, 'ok'); assert.equal(stats.tps, repeated ? null : 6000);
        assert.equal(stats.modelActiveMs, repeated ? null : 3000);
        assert.equal(stats.turns, 1); assert.equal(stats.steps, 1); assert.equal(stats.totalTokens, 1100);
        assert.equal(mutations, repeated ? 2 : 1);
    });
}

test('a changed inherited prefix clears the old TPS before rebuilding from the replacement', async t =>
{
    t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 23) });
    const f = await fixture(t);
    assertFirst(await f.store.getStats(Child));
    const replacement = f.parentPrefix.replace('"output_tokens":10', '"output_tokens":40');
    await fs.writeFile(`${f.parent}.replacement`, replacement);
    await fs.rename(`${f.parent}.replacement`, f.parent);
    let stats = await f.store.getStats(Child);
    assert.equal(stats.status, 'ok'); assert.equal(stats.tps, 15); assert.equal(stats.modelActiveMs, 4000);
    t.mock.timers.tick(1100);
    stats = await f.store.getStats(Child);
    assert.equal(stats.status, 'ok'); assert.equal(stats.tps, 15); assert.equal(stats.modelActiveMs, 4000);
    assert.equal(stats.totalTokens, 120);
});

test('a same-inode middle rewrite cannot retain stale inherited TPS', async t =>
{
    const f = await fixture(t);
    assertFirst(await f.store.getStats(Child));
    await fs.writeFile(f.parent, f.parentPrefix.replace('"output_tokens":10', '"output_tokens":40'));
    const stats = await f.store.getStats(Child);
    assert.equal(stats.status, 'ok'); assert.equal(stats.tps, 15); assert.equal(stats.modelActiveMs, 4000);
    assert.equal(stats.totalTokens, 120); assert.equal(stats.steps, 1);
});

test('nested forks resolve a parent continuation and its ancestor cutoff', async t =>
{
    const f = await fixture(t);
    const grandparent = '44444444-4444-4444-8444-444444444444';
    const grandPrefix = sessionContent(grandparent, 0, turn('grandparent', 40, 100, 50));
    await f.write(`00-00-00-${grandparent}`, grandPrefix + lines(turn('discarded-grandparent', 999, 999, 0), 5));
    const parentStart = sessionContent(Parent, 5, turn('parent', 10, 200, 100), {
        forked_from_id: grandparent, forked_from_ordinal_exclusive: 5,
        history_base: { thread_id: grandparent, end_ordinal_exclusive: 5, end_byte_offset: Buffer.byteLength(grandPrefix) },
    });
    await f.write(`00-30-00-${Parent}`, parentStart + lines(turn('discarded-parent', 999, 999, 0), 10));
    const parentPrefix = sessionContent(Parent, 10, turn('parent-second', 30, 100, 50), {
        forked_from_id: grandparent, forked_from_ordinal_exclusive: 5,
        history_base: { thread_id: Parent, end_ordinal_exclusive: 10, end_byte_offset: Buffer.byteLength(parentStart) },
    });
    await fs.writeFile(f.parent, parentPrefix);
    const metadata = { ...f.metadata, forked_from_ordinal_exclusive: 15,
        history_base: { thread_id: Segment, end_ordinal_exclusive: 15, end_byte_offset: Buffer.byteLength(parentPrefix) } };
    await fs.writeFile(f.file, content(15, turn('first', 20, 100, 50), metadata));
    const stats = await f.store.getStats(Child);
    assert.equal(stats.status, 'ok'); assert.equal(stats.tps, 12.5); assert.equal(stats.modelActiveMs, 8000);
    assert.equal(stats.totalTokens, 120); assert.equal(stats.turns, 1); assert.equal(stats.steps, 1);
});

test('a compressed parent supplies the exact inherited prefix without its later tail',
    { skip: typeof zstdCompressSync !== 'function' }, async t =>
{
    const f = await fixture(t, { parentRecords: turn('parent', 1000, 200, 100, 5000),
        childRecords: turn('first', 1000, 100, 50, 20000) });
    await fs.writeFile(`${f.parent}.zst`, zstdCompressSync(Buffer.from(f.parentPrefix
        + lines(turn('discarded-compressed-tail', 999999, 999999, 0), f.cut))));
    await fs.unlink(f.parent);
    const stats = await f.store.getStats(Child);
    assert.equal(stats.status, 'ok'); assert.equal(stats.tps, 80); assert.equal(stats.modelActiveMs, 25000);
    assert.equal(stats.totalTokens, 1100); assert.equal(stats.steps, 1); assert.equal(stats.turns, 1);
});

test('plain and compressed parent copies count once with the plain copy preferred',
    { skip: typeof zstdCompressSync !== 'function' }, async t =>
{
    const f = await fixture(t);
    const archive = path.join(f.codexHome, 'archived_sessions');
    await fs.mkdir(archive);
    await fs.writeFile(path.join(archive, path.basename(f.parent)), f.parentPrefix);
    await fs.writeFile(`${f.parent}.zst`, zstdCompressSync(Buffer.from(f.parentPrefix
        .replace('"output_tokens":10', '"output_tokens":40'))));
    await fs.unlink(f.parent);
    assertFirst(await f.store.getStats(Child));
});

test('corruption after the compressed parent prefix does not require decoding its abandoned tail',
    { skip: typeof zstdCompressSync !== 'function' }, async t =>
{
    const f = await fixture(t);
    await fs.writeFile(`${f.parent}.zst`, Buffer.concat([zstdCompressSync(Buffer.from(f.parentPrefix)),
        Buffer.from('invalid abandoned compressed tail')]));
    await fs.unlink(f.parent);
    assertFirst(await f.store.getStats(Child));
});

test('compressed parent tail appends preserve TPS and prefix rewrites rebuild it',
    { skip: typeof zstdCompressSync !== 'function' }, async t =>
{
    const f = await fixture(t);
    await fs.writeFile(`${f.parent}.zst`, zstdCompressSync(Buffer.from(f.parentPrefix)));
    await fs.unlink(f.parent);
    const stats = await f.store.getStats(Child);
    await fs.appendFile(`${f.parent}.zst`, zstdCompressSync(Buffer.from(lines(turn('later-parent', 999, 999, 0), f.cut))));
    assert.deepEqual(await f.store.getStats(Child), stats);
    await fs.writeFile(`${f.parent}.zst`, zstdCompressSync(Buffer.from(f.parentPrefix
        .replace('"output_tokens":10', '"output_tokens":40'))));
    const rewritten = await f.store.getStats(Child);
    assert.equal(rewritten.status, 'ok'); assert.equal(rewritten.tps, 15);
    assert.equal(rewritten.modelActiveMs, 4000); assert.equal(rewritten.totalTokens, 120);
});

for (const failure of ['bytes', 'range', 'ordinal', 'identity', 'metadata', 'ambiguous'])
{
    test(`invalid inherited ${failure} keeps branch counts but clears TPS`, async t =>
    {
        const f = await fixture(t);
        if (failure === 'ambiguous')
        {
            f.metadata.history_base.thread_id = Parent;
            await f.write(`00-30-00-${Parent}`, f.parentPrefix);
        }
        else if (failure === 'identity') f.metadata.history_base.thread_id = '55555555-5555-4555-8555-555555555555';
        else if (failure === 'metadata') await fs.writeFile(f.parent,
            f.parentPrefix.replaceAll(Parent, '55555555-5555-4555-8555-555555555555'));
        else if (failure === 'bytes') f.metadata.history_base.end_byte_offset--;
        else if (failure === 'range') f.metadata.history_base.end_byte_offset += 100;
        else
        {
            f.metadata.history_base.end_ordinal_exclusive++;
            f.metadata.forked_from_ordinal_exclusive++;
            f.cut++;
        }
        await fs.writeFile(f.file, content(f.cut, turn('first', 20, 100, 50), f.metadata));
        const stats = await f.store.getStats(Child);
        assert.equal(stats.status, 'ok'); assert.equal(stats.totalTokens, 120); assert.equal(stats.steps, 1);
        assert.equal(stats.tps, null); assert.equal(stats.modelActiveMs, null);
    });
}

test('inherited source failures and restoration cannot retain stale TPS samples', async t =>
{
    t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 23) });
    const f = await fixture(t);
    assertFirst(await f.store.getStats(Child));
    await fs.unlink(f.parent);
    let stats = await f.store.getStats(Child);
    assert.equal(stats.status, 'ok'); assert.equal(stats.tps, null); assert.equal(stats.modelActiveMs, null);
    await fs.writeFile(f.parent, f.parentPrefix);
    t.mock.timers.tick(1100);
    assertFirst(await f.store.getStats(Child));
});

test('a missing parent lookup is bounded and can recover after the retry interval', async t =>
{
    t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 23) });
    const f = await fixture(t, { missingParent: true });
    let parentLookups = 0;
    const store = createSessionStore({ codexHome: f.codexHome, findSources: async id =>
    {
        if (id === Child) return [f.file];
        assert.equal(id, Parent); parentLookups++;
        return (await fs.readdir(f.directory)).filter(name => name.includes(Parent)).map(name => path.join(f.directory, name));
    } });
    try
    {
        for (let i = 0; i < 8; i++) assert.equal((await store.getStats(Child)).tps, null);
        assert.equal(parentLookups, 1);
        await f.write(`01-00-00-${Parent}_${Segment}`, f.parentPrefix);
        t.mock.timers.tick(1100);
        assertFirst(await store.getStats(Child));
        assert.equal(parentLookups, 2);
    }
    finally { store.dispose(); }
});

test('cyclic inherited declarations cannot return a child-only TPS', async t =>
{
    const f = await fixture(t);
    const boundary = id => ({ thread_id: id, end_ordinal_exclusive: 0, end_byte_offset: 0 });
    await fs.writeFile(f.parent, sessionContent(Parent, 0, [], { forked_from_id: Child,
        forked_from_ordinal_exclusive: 0, history_base: boundary(Child) }));
    await fs.writeFile(f.file, content(0, turn('first', 20, 100, 50), { forked_from_id: Parent,
        forked_from_ordinal_exclusive: 0, history_base: boundary(Parent) }));
    const stats = await f.store.getStats(Child);
    assert.equal(stats.status, 'ok'); assert.equal(stats.totalTokens, 120);
    assert.equal(stats.tps, null); assert.equal(stats.modelActiveMs, null);
});

for (const count of [32, 33])
{
    test(`the inherited source limit counts ${count} sources across the complete ancestry`, async t =>
    {
        const f = await fixture(t);
        let previous;
        for (let i = 0; i < count; i++)
        {
            const id = i === count - 1 ? Child : `${String(i + 10000000).padStart(8, '0')}-1111-4111-8111-111111111111`;
            const start = previous?.end || 0;
            const value = sessionContent(id, start, turn(`turn-${i}`, 20, 100, 50), previous ? {
                forked_from_id: previous.id, forked_from_ordinal_exclusive: start,
                history_base: { thread_id: previous.id, end_ordinal_exclusive: start, end_byte_offset: Buffer.byteLength(previous.value) },
            } : {});
            if (id === Child) await fs.writeFile(f.file, value);
            else await f.write(`00-00-00-${id}`, value);
            previous = { id, value, end: start + 5 };
        }
        const stats = await f.store.getStats(Child);
        assert.equal(stats.status, 'ok'); assert.equal(stats.totalTokens, 120);
        assert.equal(stats.tps, count === 32 ? 10 : null);
        assert.equal(stats.modelActiveMs, count === 32 ? 64000 : null);
    });
}

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { discoverRecentThreadIds, discoverSnapshotRequests } = require('../src/snapshot-discovery.cjs');

function id(number) { return `${number.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`; }
const name = number => `rollout-2026-10-25T12-00-00-${id(number)}.jsonl`;
const RequestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

test('discovery finds eight most recently modified exact IDs through three levels and archives', async t =>
{
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-snapshot-discovery-'));
    t.after(() => fs.rm(root, { recursive: true }));
    for (const folder of ['sessions/2026/10/25', 'archived_sessions', 'sessions/2026/10/25/deeper'])
        await fs.mkdir(path.join(root, folder), { recursive: true });
    for (let i = 1; i <= 10; i++)
    {
        const file = path.join(root, i % 2 ? 'sessions/2026/10/25' : 'archived_sessions', name(i));
        await fs.writeFile(file, '');
        await fs.utimes(file, 100 + i, 100 + i);
    }
    await fs.writeFile(path.join(root, 'sessions', `private-${id(11)}.jsonl`), '');
    await fs.writeFile(path.join(root, 'sessions', `rollout--${id(12)}.jsonl`), '');
    await fs.writeFile(path.join(root, 'sessions/2026/10/25/deeper', name(13)), '');
    await fs.writeFile(path.join(root, 'archived_sessions', `rollout-2026-10-25T13-00-00-${id(10)}_${id(20)}.jsonl`), '');
    assert.deepEqual(await discoverRecentThreadIds(root), [10, 9, 8, 7, 6, 5, 4, 3].map(id));
});

test('discovery skips directory links and linked rollout files', async t =>
{
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-snapshot-links-'));
    t.after(() => fs.rm(root, { recursive: true }));
    const home = path.join(root, 'home'), outside = path.join(root, 'outside');
    await fs.mkdir(path.join(home, 'sessions'), { recursive: true });
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, name(1)), '');
    await fs.symlink(outside, path.join(home, 'sessions', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    try { await fs.symlink(path.join(outside, name(1)), path.join(home, 'sessions', name(2)), 'file'); }
    catch (error) { if (error.code !== 'EPERM') throw error; }
    assert.deepEqual(await discoverRecentThreadIds(home), []);
    await fs.writeFile(path.join(home, 'sessions', name(3)), '');
    const alias = path.join(root, 'home-link');
    await fs.symlink(home, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.deepEqual(await discoverRecentThreadIds(alias), []);
});

test('discovery bounds directory enumeration and names even when every entry is a directory', async () =>
{
    let directories = 0, names = 0, closed = 0;
    const fileSystem = {
        lstat: async () => ({ isDirectory: () => true, isSymbolicLink: () => false }),
        opendir: async () =>
        {
            directories++;
            return (async function* ()
            {
                try
                {
                    for (let i = 0; i < 30; i++)
                    {
                        names++;
                        yield { name: `folder-${i}`, isSymbolicLink: () => false,
                            isDirectory: () => true, isFile: () => false };
                    }
                }
                finally { closed++; }
            })();
        },
    };
    assert.deepEqual(await discoverRecentThreadIds(path.resolve('bounded-home'), { fileSystem }), []);
    assert.ok(directories <= 2048, `Opened ${directories} directories`);
    assert.equal(names, 50000);
    assert.equal(closed, directories);
});

test('discovery independently caps a wide directory tree and supports cancellation', async () =>
{
    let directories = 0;
    const fileSystem = {
        lstat: async () => ({ isDirectory: () => true, isSymbolicLink: () => false }),
        opendir: async directory =>
        {
            directories++;
            return (async function* ()
            {
                if (!/sessions$/.test(directory)) return;
                for (let i = 0; i < 3000; i++) yield { name: `folder-${i}`,
                    isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false };
            })();
        },
    };
    assert.deepEqual(await discoverRecentThreadIds(path.resolve('bounded-home'), { fileSystem }), []);
    assert.equal(directories, 2048);
    const controller = new AbortController();
    controller.abort();
    assert.deepEqual(await discoverRecentThreadIds(path.resolve('bounded-home'), { fileSystem, signal: controller.signal }), []);
    assert.equal(directories, 2048);
});

test('request discovery inspects at most256 directory entries and at most1025 bytes per candidate', async t =>
{
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-request-discovery-'));
    t.after(() => fs.rm(root, { recursive: true }));
    for (let i = 1; i <= 260; i++) await fs.writeFile(path.join(root, `${id(i)}.${RequestId}.json`), JSON.stringify({
        schemaVersion: 1, producer: 'codex-session-stats-request', threadId: id(i), requestedAt: 100000 }));
    let inspected = 0, readCount = 0;
    const fileSystem = { ...fs, async opendir(directory)
    {
        const handle = await fs.opendir(directory);
        return (async function* () { for await (const child of handle) { inspected++; yield child; } })();
    }, async open(filename, flags)
    {
        const handle = await fs.open(filename, flags);
        return { stat: () => handle.stat(), close: () => handle.close(), async read(buffer, offset, length, position)
        {
            assert.ok(length <= 1025);
            readCount++;
            return handle.read(buffer, offset, length, position);
        } };
    } };
    const requests = await discoverSnapshotRequests(root, { now: 100000, fileSystem });
    assert.equal(inspected, 256);
    assert.equal(readCount, 256);
    assert.equal(requests.length, 256);
    assert.equal(requests.every(candidate => candidate.request.threadId === path.basename(candidate.file).split('.')[0]), true);
});

test('malformed and oversized request candidates still count toward the256-entry scan budget', async t =>
{
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-request-invalid-'));
    t.after(() => fs.rm(root, { recursive: true }));
    for (let i = 1; i <= 260; i++)
        await fs.writeFile(path.join(root, `${id(i)}.${RequestId}.json`), i % 2 ? 'unknown' : 'x'.repeat(1025));
    let inspected = 0;
    const fileSystem = { ...fs, async opendir(directory)
    {
        const handle = await fs.opendir(directory);
        return (async function* () { for await (const child of handle) { inspected++; yield child; } })();
    } };
    assert.deepEqual(await discoverSnapshotRequests(root, { now: 100000, fileSystem }), []);
    assert.equal(inspected, 256);
});

test('only exact thread and nonce UUID filenames with matching payloads establish demand', async t =>
{
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-request-nonces-'));
    t.after(() => fs.rm(root, { recursive: true }));
    const marker = threadId => JSON.stringify({ schemaVersion: 1,
        producer: 'codex-session-stats-request', threadId, requestedAt: 100000 });
    await fs.writeFile(path.join(root, `${id(1)}.json`), marker(id(1)));
    await fs.writeFile(path.join(root, `${id(2)}.not-a-nonce.json`), marker(id(2)));
    await fs.writeFile(path.join(root, `${id(3)}.aaaaaaaa-aaaa-0aaa-8aaa-aaaaaaaaaaaa.json`), marker(id(3)));
    await fs.writeFile(path.join(root, `${id(4)}.${RequestId}.json.extra`), marker(id(4)));
    await fs.writeFile(path.join(root, `${id(5)}.${RequestId}.json`), marker(id(6)));
    await fs.writeFile(path.join(root, `${id(7)}.${RequestId}.json`), marker(id(7)));
    const found = await discoverSnapshotRequests(root, { now: 100000 });
    assert.deepEqual(found.map(candidate => candidate.request.threadId), [id(7)]);
    assert.equal((await fs.readdir(root)).length, 6);
});

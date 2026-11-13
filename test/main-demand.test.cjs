'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function fixture(t)
{
    const handlers = new Map(), local = new Map(), remote = new Map(), nativeWindows = new Map();
    const releases = [];
    const publisher = { start() {}, dispose() {},
        async getStats(threadId, { ownerId }) { local.set(ownerId, threadId); return { threadId, status: 'not-found' }; },
        release(ownerId) { local.delete(ownerId); releases.push(ownerId); } };
    const remoteStore = { dispose() {},
        async getStats(identity) { remote.set(identity.ownerId, identity.threadId); return { ...identity, status: 'not-found' }; },
        release(ownerId) { remote.delete(ownerId); releases.push(ownerId); } };
    const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
    const module = { exports: {} };
    const requireFixture = name => {
        if (name === 'electron') return { BrowserWindow: { fromWebContents: sender => nativeWindows.get(sender) },
            ipcMain: { handle: (name, fn) => handlers.set(name.split(':').at(-1), fn),
            removeHandler: name => handlers.delete(name.split(':').at(-1)) } };
        if (name === './src/session-store.cjs') return { createSessionStore: () => ({ dispose() {} }) };
        if (name === './src/snapshot-publisher.cjs') return { createSnapshotPublisher: () => publisher };
        if (name === './src/snapshot-remote-store.cjs') return { createSnapshotRemoteStore: () => remoteStore };
        if (name === './src/remote-transport.cjs') return { createRemoteTransport: () => ({ dispose() {} }) };
        if (name.startsWith('./src/')) return require(`../${name.slice(2)}`);
        return require(name);
    };
    vm.runInNewContext(source, { module, require: requireFixture, process, __dirname: path.join(__dirname, '..') });
    module.exports.start({ process: 'main', manifest: { id: 'stats' }, log: { info() {} } });
    t.after(() => module.exports.stop());
    const event = () => {
        const sender = new EventEmitter(); sender.mainFrame = {};
        return { sender, senderFrame: sender.mainFrame };
    };
    return { handlers, local, remote, releases, event, nativeWindows, controller: module.exports };
}

test('main owners are scoped per window and switching host releases the preceding target', async t =>
{
    const f = fixture(t), one = f.event(), two = f.event();
    const identity = { threadId: A, hostId: 'local', ownerId: 'same-owner' };
    await f.handlers.get('stats')(one, identity);
    await f.handlers.get('stats')(two, identity);
    assert.equal(f.local.size, 2);
    await f.handlers.get('release')(one, { ownerId: 'same-owner' });
    assert.equal(f.local.size, 1);
    await f.handlers.get('stats')(two, { ...identity, threadId: B, hostId: 'remote-control:runner' });
    assert.equal(f.local.size, 0);
    assert.equal(f.remote.size, 1);
    two.sender.emit('destroyed');
    assert.equal(f.remote.size, 0);
    assert.equal(two.sender.listenerCount('destroyed'), 0);
    assert.equal(two.sender.listenerCount('did-start-navigation'), 0);
});

for (const navigation of ['did-start-navigation', 'render-process-gone'])
{
    test(`${navigation} releases subscriptions even when the renderer cannot clean up`, async t =>
    {
        const f = fixture(t), event = f.event();
        await f.handlers.get('stats')(event, { threadId: A, hostId: 'local', ownerId: 'view' });
        event.sender.emit(navigation, {}, '/reload', false, true);
        assert.equal(f.local.size, 0);
        f.controller.stop();
        assert.equal(event.sender.listenerCount(navigation), 0);
    });
}

test('native hide prevents a stale renderer request from reacquiring local interest', async t =>
{
    const f = fixture(t), event = f.event();
    const nativeWindow = new EventEmitter();
    let visible = true;
    nativeWindow.isVisible = () => visible;
    f.nativeWindows.set(event.sender, nativeWindow);
    const identity = { threadId: A, hostId: 'local', ownerId: 'view' };
    await f.handlers.get('stats')(event, identity);
    visible = false;
    nativeWindow.emit('hide');
    assert.equal(f.local.size, 0);
    assert.equal((await f.handlers.get('stats')(event, identity)).status, 'unavailable');
    assert.equal(f.local.size, 0);
});

test('a full-page navigation rejects stale requests until the replacement document loads', async t =>
{
    const f = fixture(t), event = f.event();
    const identity = { threadId: A, hostId: 'local', ownerId: 'view' };
    await f.handlers.get('stats')(event, identity);
    event.sender.emit('did-start-navigation', {}, '/reload', false, true);
    await f.handlers.get('stats')(event, identity);
    assert.equal(f.local.size, 0);
    event.sender.emit('did-finish-load');
    await f.handlers.get('stats')(event, identity);
    assert.equal(f.local.size, 1);
});

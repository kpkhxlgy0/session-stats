'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const { startRenderer } = require('../src/renderer.cjs');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const flush = () => new Promise(resolve => setTimeout(resolve, 25));

function fixture(t)
{
    const dom = new JSDOM('<div data-codex-composer-root data-composer-placement="thread"></div>');
    const win = dom.window, doc = win.document;
    const root = doc.querySelector('[data-codex-composer-root]');
    root.getClientRects = () => [{}];
    const value = { kind: 'local', conversationId: A, hostId: 'local' };
    const calls = [];
    const api = { react: { getFiber: () => ({ memoizedProps: { value } }) }, log: { info() {} },
        ipc: { async invoke(channel, payload) { calls.push({ channel, payload }); return { ...payload, status: 'not-found' }; } } };
    const controller = startRenderer(api, { window: win, debounceMs: 0, pollMs: 5 });
    t.after(() => { controller.stop(); win.close(); });
    return { win, doc, root, value, calls, controller };
}

test('a conversation switch releases the old owner before requesting the new target', async t =>
{
    const f = fixture(t);
    await flush();
    const initial = f.calls.find(call => call.channel === 'stats');
    assert.equal(typeof initial.payload.ownerId, 'string');
    f.calls.length = 0;
    f.value.conversationId = B;
    f.win.dispatchEvent(new f.win.PopStateEvent('popstate'));
    await flush();
    const release = f.calls.findIndex(call => call.channel === 'release');
    const next = f.calls.findIndex(call => call.channel === 'stats' && call.payload.threadId === B);
    assert.ok(release >= 0 && next > release);
    assert.equal(f.calls[release].payload.ownerId, initial.payload.ownerId);
    assert.ok(f.calls.filter(call => call.channel === 'stats').every(call => call.payload.threadId === B));
});

for (const action of ['hidden', 'unmount', 'pagehide', 'stop'])
{
    test(`${action} releases visible interests and prevents further stats calls`, async t =>
    {
        const f = fixture(t);
        await flush();
        const owners = new Set(f.calls.filter(call => call.channel === 'stats').map(call => call.payload.ownerId));
        f.calls.length = 0;
        if (action === 'hidden')
        {
            Object.defineProperty(f.doc, 'visibilityState', { configurable: true, value: 'hidden' });
            f.doc.dispatchEvent(new f.win.Event('visibilitychange'));
        }
        if (action === 'unmount') f.root.remove();
        if (action === 'pagehide') f.win.dispatchEvent(new f.win.Event('pagehide'));
        if (action === 'stop') f.controller.stop();
        await flush();
        assert.equal(f.calls.filter(call => call.channel === 'stats').length, 0);
        assert.equal(owners.size, 1);
        assert.deepEqual(new Set(f.calls.filter(call => call.channel === 'release').map(call => call.payload.ownerId)), owners);
    });
}

test('unrelated DOM mutations do not accelerate statistics polling for an unchanged owner', async t =>
{
    const f = fixture(t);
    f.controller.stop();
    f.calls.length = 0;
    const api = { react: { getFiber: () => ({ memoizedProps: { value: f.value } }) }, log: { info() {} },
        ipc: { async invoke(channel, payload) { f.calls.push({ channel, payload }); return { ...payload, status: 'not-found' }; } } };
    const controller = startRenderer(api, { window: f.win, debounceMs: 0, pollMs: 60000 });
    t.after(() => controller.stop());
    for (let index = 0; index < 4; index++) { f.root.append(f.doc.createElement('span')); await flush(); }
    assert.equal(f.calls.filter(call => call.channel === 'stats').length, 1);
});

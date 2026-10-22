"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const { bindingScript, resolveConversation } = require("../src/binding.cjs");

const firstId = "01a16231-aaa3-7932-98c7-6d77f68149c0";
const secondId = "01a1622e-a93d-7870-9f07-f3f02681d4af";
const remoteHost = "remote-control:example";

function fixture(t, props = {}, url = "https://codex.local/index.html") {
    const dom = new JSDOM('<div data-codex-composer-root data-session-stats-key="test"></div>',
        { url, runScripts: "outside-only" });
    t.after(() => dom.window.close());
    const root = dom.window.document.querySelector("div");
    const fiber = { memoizedProps: props };
    root.__reactFiberTest = fiber;
    return { dom, root, fiber, resolve: () => resolveConversation(root,
        { react: { getFiber: () => fiber } }, dom.window) };
}

test("main-world script reads the committed fiber and returns only sanitized composer identity", (t) => {
    const f = fixture(t);
    const current = { memoizedProps: { threadId: secondId, privateText: "never exported" } };
    const oldRoot = { stateNode: { current: {} } };
    f.root.__reactFiberTest = {
        memoizedProps: { threadId: firstId }, return: oldRoot, alternate: current,
    };
    const read = () => JSON.parse(JSON.stringify(f.dom.window.eval(bindingScript)));
    assert.deepEqual(read(), [{ key: "test", bound: { threadId: secondId, hostId: "local" } }]);
    current.memoizedProps.hostId = remoteHost;
    assert.deepEqual(read(), [{ key: "test", bound: { threadId: secondId, hostId: remoteHost } }]);
});

test("scoped, thread-key, and direct identities accept explicit remote hosts", (t) => {
    for (const props of [
        { value: { kind: "codex", conversationId: firstId, hostId: remoteHost } },
        { threadKey: { threadId: firstId, hostId: remoteHost } },
        { threadId: firstId, hostId: remoteHost },
    ]) {
        const f = fixture(t, props);
        assert.deepEqual(f.resolve(), { threadId: firstId, hostId: remoteHost });
    }
});

test("an implicit identity inherits its outer explicit host", (t) => {
    const f = fixture(t, { value: { kind: "local", conversationId: firstId } });
    f.fiber.return = { memoizedProps: { hostId: remoteHost } };
    assert.deepEqual(f.resolve(), { threadId: firstId, hostId: remoteHost });
});

test("an implicit identity inherits the matching React route host", (t) => {
    const f = fixture(t, { threadId: firstId,
        location: { pathname: `/local/${firstId}`, search: `?hostId=${encodeURIComponent(remoteHost)}` } });
    assert.deepEqual(f.resolve(), { threadId: firstId, hostId: remoteHost });
    f.fiber.memoizedProps.location = { pathname: `/local/${secondId}`, search: "?hostId=other-host" };
    assert.deepEqual(f.resolve(), { threadId: firstId, hostId: "local" });
});

test("a route without a host inherits the outer host instead of introducing a local conflict", (t) => {
    const f = fixture(t, { location: { pathname: `/local/${firstId}` } });
    f.fiber.return = { memoizedProps: { hostId: remoteHost } };
    assert.deepEqual(f.resolve(), { threadId: firstId, hostId: remoteHost });
});

test("conflicting explicit identity, outer-scope, or matching route hosts reject binding", (t) => {
    const f = fixture(t, { threadId: firstId, hostId: "local" });
    f.fiber.return = { memoizedProps: { value: { hostId: remoteHost } } };
    assert.equal(f.resolve(), null);
    f.fiber.return = null;
    f.fiber.memoizedProps.location = { pathname: `/local/${firstId}`,
        search: `?hostId=${encodeURIComponent(remoteHost)}` };
    assert.equal(f.resolve(), null);
    f.fiber.memoizedProps = { threadKey: { threadId: firstId, hostId: remoteHost }, hostId: "other-host" };
    assert.equal(f.resolve(), null);
});

test("host identifiers accept bounded opaque strings and reject invalid explicit values", (t) => {
    const f = fixture(t, { threadId: firstId });
    for (const hostId of [remoteHost, "ssh:server with spaces", "x".repeat(512)]) {
        f.fiber.memoizedProps.hostId = hostId;
        assert.deepEqual(f.resolve(), { threadId: firstId, hostId });
    }
    for (const hostId of ["", "x".repeat(513), "bad\nhost", "bad\u007fhost", "bad\u0085host", 42, null]) {
        f.fiber.memoizedProps.hostId = hostId;
        assert.equal(f.resolve(), null);
    }
});

test("new, cloud, and home composers remain unbound", (t) => {
    const f = fixture(t, { threadId: firstId });
    for (const kind of ["new", "cloud"]) {
        f.fiber.return = { memoizedProps: { value: { kind, hostId: remoteHost } } };
        assert.equal(f.resolve(), null);
    }
    f.fiber.return = null;
    f.root.dataset.composerPlacement = "home";
    assert.equal(f.resolve(), null);
});

test("subtree identities inherit their host and reject ambiguous threads or hosts", (t) => {
    const f = fixture(t, { hostId: remoteHost });
    f.fiber.child = { memoizedProps: { threadId: firstId } };
    assert.deepEqual(f.resolve(), { threadId: firstId, hostId: remoteHost });
    f.fiber.child.sibling = { memoizedProps: { threadId: secondId } };
    assert.equal(f.resolve(), null);
    f.fiber.child.sibling = { memoizedProps: { threadId: firstId, hostId: "other-host" } };
    assert.equal(f.resolve(), null);
    f.fiber.memoizedProps = {};
    f.fiber.child.sibling = null;
    f.fiber.child = { memoizedProps: { hostId: remoteHost }, child: { memoizedProps: { threadId: firstId } } };
    assert.deepEqual(f.resolve(), { threadId: firstId, hostId: remoteHost });
});

test("window route host applies only to the matching composer thread", (t) => {
    const f = fixture(t, { threadId: firstId },
        `https://codex.local/local/${firstId}?hostId=${encodeURIComponent(remoteHost)}`);
    assert.deepEqual(f.resolve(), { threadId: firstId, hostId: remoteHost });
    f.fiber.memoizedProps.threadId = secondId;
    assert.deepEqual(f.resolve(), { threadId: secondId, hostId: "local" });
    f.fiber.memoizedProps = {};
    f.root.dataset.conversationId = secondId;
    assert.deepEqual(f.resolve(), { threadId: secondId, hostId: "local" });
    f.root.dataset.conversationId = firstId;
    assert.deepEqual(f.resolve(), { threadId: firstId, hostId: remoteHost });
    f.fiber.memoizedProps = { threadId: firstId, hostId: "local" };
    assert.equal(f.resolve(), null);
});

test("a remote window route can identify an otherwise unbound composer", (t) => {
    const f = fixture(t, {},
        `https://codex.local/hotkey-window/thread/${firstId}?hostId=${encodeURIComponent(remoteHost)}`);
    assert.deepEqual(f.resolve(), { threadId: firstId, hostId: remoteHost });
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const { bindingScript, resolveSubagent } = require("../src/binding.cjs");

const parentId = "01a16231-aaa3-7932-98c7-6d77f68149c0";
const childId = "01a1622e-a93d-7870-9f07-f3f02681d4af";
const otherId = "01a16339-7af0-760e-a9b1-2f4f41794b88";
const remoteHost = "remote-control:example";

function detailRow(props = {}) {
    return { id: "subagent-detail", content: { props: {
        conversationId: childId, hostId: "local", displayName: "Private child name",
        onBack() {}, ...props,
    } } };
}

function fixture(t, headerRows = [detailRow()]) {
    const dom = new JSDOM('<div data-app-shell-pane-content-viewport data-session-stats-key="child"></div>',
        { url: `https://codex.local/local/${parentId}?hostId=parent-host`, runScripts: "outside-only" });
    t.after(() => dom.window.close());
    const root = dom.window.document.querySelector("div");
    const layout = { memoizedProps: { headerRows, content: { privateText: "Private transcript" } },
        return: { memoizedProps: { threadId: parentId, hostId: "parent-host" } } };
    const fiber = { memoizedProps: {}, return: layout };
    root.__reactFiberTest = fiber;
    return { dom, root, fiber, layout, resolve() {
        assert.equal(typeof resolveSubagent, "function", "the selected child resolver is exported");
        return resolveSubagent(root, { react: { getFiber: () => root.__reactFiberTest } });
    }, read: () => JSON.parse(JSON.stringify(dom.window.eval(bindingScript))) };
}

test("the bridge binds keyed subagent viewports independently of the parent composer and route", (t) => {
    const f = fixture(t, [detailRow({ hostId: remoteHost })]);
    const composer = f.dom.window.document.createElement("div");
    composer.dataset.codexComposerRoot = "";
    composer.dataset.sessionStatsKey = "parent";
    composer.__reactFiberTest = { memoizedProps: { threadId: parentId, hostId: "parent-host" } };
    f.root.before(composer);
    assert.deepEqual(f.read(), [
        { key: "parent", bound: { threadId: parentId, hostId: "parent-host" } },
        { key: "child", bound: { threadId: childId, hostId: remoteHost } },
    ]);
});

test("selected local and remote child headers stay independent of the parent identity", (t) => {
    const f = fixture(t);
    for (const hostId of ["local", remoteHost, "ssh:server with spaces", "x".repeat(512)]) {
        f.layout.memoizedProps.headerRows = [detailRow({ conversationId: childId.toUpperCase(), hostId })];
        assert.deepEqual(f.resolve(), { threadId: childId, hostId });
    }
});

test("a child header requires its own valid explicit host", (t) => {
    const f = fixture(t);
    for (const hostId of [undefined, null, "", 42, "x".repeat(513), "bad\nhost", "bad\u007fhost", "bad\u0085host"]) {
        f.layout.memoizedProps.headerRows = [detailRow({ hostId })];
        assert.equal(f.resolve(), null);
    }
    delete f.layout.memoizedProps.headerRows[0].content.props.hostId;
    assert.equal(f.resolve(), null);
});

test("a child header requires a valid conversation UUID without a route or threadId fallback", (t) => {
    const f = fixture(t);
    f.root.dataset.conversationId = parentId;
    for (const conversationId of [undefined, null, "", 42, "child", childId.slice(1),
        `${childId}\n`, `${childId}\r`, `${childId}\u2028`, `${childId}\u2029`]) {
        f.layout.memoizedProps.headerRows = [detailRow({ conversationId, threadId: parentId })];
        assert.equal(f.resolve(), null);
    }
    delete f.layout.memoizedProps.headerRows[0].content.props.conversationId;
    assert.equal(f.resolve(), null);
});

test("main panes and subagent lists do not bind from unrelated header or content identities", (t) => {
    const f = fixture(t);
    for (const headerRows of [[], [{ id: "subagent-list", content: detailRow().content }],
        [{ id: "main", content: detailRow().content }], null, undefined, {}]) {
        f.layout.memoizedProps = { headerRows, content: detailRow().content, conversationId: childId, hostId: "local" };
        assert.equal(f.resolve(), null);
    }
    f.root.__reactFiberTest = null;
    assert.equal(f.resolve(), null);
});

test("the nearest pane header boundary prevents binding to an outer selected child", (t) => {
    const f = fixture(t);
    const outer = f.layout;
    for (const headerRows of [[], [{ id: "subagent-list" }], undefined, null]) {
        f.fiber.return = { memoizedProps: { headerRows, content: {} }, return: outer };
        assert.equal(f.resolve(), null);
    }
    f.fiber.return = { memoizedProps: { headerRows: [detailRow({ hostId: remoteHost })] }, return: outer };
    assert.deepEqual(f.resolve(), { threadId: childId, hostId: remoteHost });
});

test("duplicate detail headers reject even matching or conflicting identities", (t) => {
    const f = fixture(t);
    for (const duplicate of [detailRow(), detailRow({ conversationId: otherId }),
        detailRow({ hostId: remoteHost }), { id: "subagent-detail", content: null }]) {
        f.layout.memoizedProps.headerRows = [detailRow(), duplicate];
        assert.equal(f.resolve(), null);
    }
});

test("malformed detail rows never borrow identity from other rows or descendants", (t) => {
    const f = fixture(t);
    for (const content of [null, undefined, {}, { conversationId: childId, hostId: "local" },
        { props: null }, { props: "invalid" }]) {
        f.layout.memoizedProps.headerRows = [{ id: "subagent-detail", content },
            { id: "unrelated", content: detailRow().content }];
        assert.equal(f.resolve(), null);
    }
    f.layout.memoizedProps = {};
    f.fiber.child = { memoizedProps: { headerRows: [detailRow()] } };
    assert.equal(f.resolve(), null);
});

test("the main-world bridge uses the committed detail and exports only sanitized identity", (t) => {
    const f = fixture(t);
    const committed = { memoizedProps: {}, return: { memoizedProps: {
        headerRows: [detailRow({ conversationId: otherId.toUpperCase(), hostId: remoteHost,
            privateText: "Never exported" })],
        content: { privateText: "Never exported transcript" },
    } } };
    const oldRoot = { stateNode: { current: {} } };
    f.layout.return = oldRoot;
    f.fiber.alternate = committed;
    assert.deepEqual(f.resolve(), { threadId: otherId, hostId: remoteHost });
    assert.deepEqual(f.read(), [{ key: "child", bound: { threadId: otherId, hostId: remoteHost } }]);
});

test("the bridge ignores unkeyed viewports and unrelated keyed elements", (t) => {
    const f = fixture(t);
    f.root.removeAttribute("data-session-stats-key");
    const unrelated = f.dom.window.document.createElement("div");
    unrelated.dataset.sessionStatsKey = "unrelated";
    unrelated.__reactFiberTest = f.fiber;
    f.root.after(unrelated);
    assert.deepEqual(f.read(), []);
});

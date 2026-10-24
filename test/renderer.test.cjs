"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const { resolveConversation, startRenderer } = require("../src/renderer.cjs");

const firstId = "01a16231-aaa3-7932-98c7-6d77f68149c0";
const secondId = "01a1622e-a93d-7870-9f07-f3f02681d4af";
const stats = {
    status: "ok", turns: 2, steps: 33, totalTokens: 11700000, inputTokens: 11000000,
    outputTokens: 700000, cachedInputTokens: 10560000, cacheHit: 0.96,
    tps: 209.2, tpsHeld: false, activeTurn: true, modelActiveMs: 5000,
};

function fixture() {
    const dom = new JSDOM('<main><div data-codex-composer-root data-composer-placement="thread">'
        + '<div class="ProseMirror" contenteditable="true"></div></div></main>',
    { url: "https://codex.local/index.html" });
    const root = dom.window.document.querySelector("[data-codex-composer-root]");
    root.getClientRects = () => [{ width: 600, height: 100 }];
    const fiber = { memoizedProps: {}, return: {
        memoizedProps: { value: { kind: "local", conversationId: firstId, hostId: "local" } }, return: null,
    } };
    const requests = [];
    const api = {
        react: { getFiber: () => fiber },
        ipc: { invoke: async (channel, bound) => {
            assert.equal(channel, "stats"); requests.push(bound); return { ...stats, ...bound };
        } },
        log: { info() {}, warn() {} },
    };
    return { dom, root, fiber, api, requests };
}

async function settle(dom) {
    await new Promise((resolve) => dom.window.setTimeout(resolve, 120));
}

test("composer identity comes from its scoped React data and supports remote hosts", () => {
    const f = fixture();
    assert.deepEqual(resolveConversation(f.root, f.api, f.dom.window), { threadId: firstId, hostId: "local" });
    f.fiber.return.memoizedProps.value.hostId = "remote-control:example";
    assert.deepEqual(resolveConversation(f.root, f.api, f.dom.window),
        { threadId: firstId, hostId: "remote-control:example" });
    f.dom.window.close();
});

test("composer subtree thread identity is available when the app uses a memory router", () => {
    const f = fixture();
    f.fiber.return = null;
    f.fiber.child = { memoizedProps: { threadId: firstId }, child: null, sibling: null };
    assert.equal(resolveConversation(f.root, f.api, f.dom.window)?.threadId, firstId);
    f.fiber.child.sibling = { memoizedProps: { threadId: secondId } };
    assert.equal(resolveConversation(f.root, f.api, f.dom.window), null);
    f.dom.window.close();
});

test("explicit remote host on an outer scope or route supplies an implicit identity host", () => {
    const f = fixture();
    delete f.fiber.return.memoizedProps.value.hostId;
    f.fiber.return.return = { memoizedProps: { hostId: "remote-control:example" } };
    assert.deepEqual(resolveConversation(f.root, f.api, f.dom.window),
        { threadId: firstId, hostId: "remote-control:example" });
    f.fiber.return = { memoizedProps: {
        threadId: firstId,
        location: { pathname: `/local/${firstId}`, search: "?hostId=remote-control%3Aexample" },
    } };
    assert.deepEqual(resolveConversation(f.root, f.api, f.dom.window),
        { threadId: firstId, hostId: "remote-control:example" });
    f.dom.window.close();
});

test("isolated preload obtains only composer identities through the main-world bridge", async () => {
    const f = fixture();
    f.api.react.getFiber = () => null;
    f.api.ipc.invoke = async (channel, bound) => channel === "bindings"
        ? [{ key: f.root.dataset.sessionStatsKey, bound: { threadId: firstId, hostId: "local" } }]
        : { ...stats, ...bound };
    const controller = startRenderer(f.api, { window: f.dom.window, pollMs: 60000 });
    await settle(f.dom);
    assert.match(f.root.querySelector("[data-session-stats]")?.textContent ?? "", /209 tok\/s/);
    controller.stop(); f.dom.window.close();
});

test("an explicit rejected main-world binding cannot fall back to a stale DOM thread ID", async (t) => {
    const f = fixture();
    t.after(() => f.dom.window.close());
    f.api.react.getFiber = () => null;
    f.root.dataset.conversationId = firstId;
    f.api.ipc.invoke = async (channel) => {
        assert.equal(channel, "bindings", "must not request local statistics for a rejected binding");
        return [{ key: f.root.dataset.sessionStatsKey, bound: null }];
    };
    const controller = startRenderer(f.api, { window: f.dom.window, pollMs: 60000 });
    t.after(() => controller.stop());
    await settle(f.dom);
    assert.equal(f.root.querySelector("[data-session-stats]"), null);
});

test("footer displays the five metrics without context occupancy and cleans up", async t => {
    const f = fixture();
    const controller = startRenderer(f.api, { window: f.dom.window, pollMs: 60000 });
    t.after(() => controller.stop());
    await settle(f.dom);
    const bar = f.root.querySelector("[data-session-stats]");
    assert.ok(bar, "mounts beneath the composer content");
    assert.match(bar.textContent, /2 turns.*33 steps.*209 tok\/s.*11\.7M tok.*Cache hit 96%/);
    assert.doesNotMatch(bar.textContent, /context|上下文|42%/i);
    assert.match(bar.querySelector('[data-stat="tps"]').title, /工具/);
    assert.match(bar.querySelector('[data-stat="tps"]').title, /会话平均/);
    f.root.appendChild(f.dom.window.document.createElement("span"));
    await settle(f.dom);
    assert.equal(f.root.querySelectorAll("[data-session-stats]").length, 1);
    controller.stop();
    assert.equal(f.dom.window.document.querySelector("[data-session-stats]"), null);
    assert.equal(f.dom.window.document.querySelector("[data-session-stats-anchor]"), null);
    assert.equal(f.dom.window.document.querySelector("[data-session-stats-style]"), null);
    controller.stop();
    f.dom.window.close();
});

test("a late previous-chat result cannot overwrite the newly selected conversation", async () => {
    const f = fixture();
    let resolveFirst;
    f.api.ipc.invoke = async (_channel, bound) => bound.threadId === firstId
        ? new Promise((resolve) => { resolveFirst = resolve; })
        : { ...stats, ...bound, turns: 7, tps: null };
    const controller = startRenderer(f.api, { window: f.dom.window, pollMs: 60000 });
    await settle(f.dom);
    assert.equal(typeof resolveFirst, "function");
    f.fiber.return.memoizedProps.value.conversationId = secondId;
    f.root.appendChild(f.dom.window.document.createElement("span"));
    await settle(f.dom);
    resolveFirst({ ...stats, threadId: firstId, hostId: "local" });
    await settle(f.dom);
    assert.match(f.root.querySelector("[data-session-stats]").textContent, /7 turns.*— tok\/s/);
    controller.stop(); f.dom.window.close();
});

test("home and hidden composers do not inherit another chat's statistics", async () => {
    const f = fixture();
    f.root.dataset.composerPlacement = "home";
    const controller = startRenderer(f.api, { window: f.dom.window, pollMs: 60000 });
    await settle(f.dom);
    assert.equal(f.root.querySelector("[data-session-stats]"), null);
    assert.equal(f.requests.length, 0);
    controller.stop(); f.dom.window.close();
});

test("statistics requests include the remote host", async (t) => {
    const f = fixture();
    t.after(() => f.dom.window.close());
    f.fiber.return.memoizedProps.value.hostId = "remote-control:example";
    const controller = startRenderer(f.api, { window: f.dom.window, pollMs: 60000 });
    t.after(() => controller.stop());
    await settle(f.dom);
    assert.deepEqual(f.requests, [{ threadId: firstId, hostId: "remote-control:example" }]);
    assert.match(f.root.querySelector("[data-session-stats]")?.textContent ?? "", /209 tok\/s/);
});

test("statistics responses must match both thread and host including local requests", async (t) => {
    for (const response of [
        { ...stats, threadId: firstId },
        { ...stats, threadId: firstId, hostId: "remote-control:example" },
        { ...stats, threadId: secondId, hostId: "local" },
    ]) {
        const f = fixture();
        t.after(() => f.dom.window.close());
        f.api.ipc.invoke = async () => response;
        const controller = startRenderer(f.api, { window: f.dom.window, pollMs: 60000 });
        t.after(() => controller.stop());
        await settle(f.dom);
        assert.match(f.root.querySelector("[data-session-stats]").textContent, /— turns.*— tok\/s/);
    }
});

test("a late result from the previous host cannot overwrite the same thread on another host", async (t) => {
    const f = fixture();
    t.after(() => f.dom.window.close());
    let resolveFirst;
    f.api.ipc.invoke = async (_channel, bound) => bound.hostId === "local"
        ? new Promise((resolve) => { resolveFirst = resolve; })
        : { ...stats, ...bound, turns: 7, tps: null };
    const controller = startRenderer(f.api, { window: f.dom.window, pollMs: 60000 });
    t.after(() => controller.stop());
    await settle(f.dom);
    assert.equal(typeof resolveFirst, "function");
    f.fiber.return.memoizedProps.value.hostId = "remote-control:example";
    f.root.appendChild(f.dom.window.document.createElement("span"));
    await settle(f.dom);
    assert.match(f.root.querySelector("[data-session-stats]")?.textContent ?? "", /7 turns.*— tok\/s/);
    resolveFirst({ ...stats, threadId: firstId, hostId: "local" });
    await settle(f.dom);
    assert.match(f.root.querySelector("[data-session-stats]").textContent, /7 turns.*— tok\/s/);
});

test("remote log pending text does not describe the source as local", async (t) => {
    const f = fixture();
    t.after(() => f.dom.window.close());
    f.fiber.return.memoizedProps.value.hostId = "remote-control:example";
    f.api.ipc.invoke = async (_channel, bound) => ({ status: "not-found", ...bound });
    const controller = startRenderer(f.api, { window: f.dom.window, pollMs: 60000 });
    t.after(() => controller.stop());
    await settle(f.dom);
    const bar = f.root.querySelector("[data-session-stats]");
    assert.ok(bar);
    assert.match(bar.title, /等待.*日志/);
    assert.doesNotMatch(bar.title, /本地/);
});

test("snapshot tooltips explain loading, missing producers and shared samples", async t => {
    for (const [sample, title] of [
        [{ status: "unavailable", unavailableReason: "snapshot-loading" }, /正在读取运行端统计快照/],
        [{ status: "unavailable", unavailableReason: "snapshot-expired" }, /快照已过期/],
        [{ ...stats, source: "snapshot", snapshotGeneratedAt: 1792860000000 }, /运行端共享统计快照/],
        [{ status: "unavailable", unavailableReason: "snapshot-missing" }, /运行端.*启用 Session Stats/],
    ]) {
        const f = fixture();
        t.after(() => f.dom.window.close());
        f.fiber.return.memoizedProps.value.hostId = "remote-control:example";
        f.api.ipc.invoke = async (_channel, bound) => ({ ...sample, ...bound });
        const controller = startRenderer(f.api, { window: f.dom.window, pollMs: 60000 });
        t.after(() => controller.stop());
        await settle(f.dom);
        const bar = f.root.querySelector("[data-session-stats]");
        assert.match(bar.title, title);
        assert.match(bar.textContent, sample.status === "ok" ? /209 tok\/s/ : /— turns.*— tok\/s/);
    }
});

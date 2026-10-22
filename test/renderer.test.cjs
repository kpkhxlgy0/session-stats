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
        ipc: { invoke: async (channel, id) => {
            assert.equal(channel, "stats"); requests.push(id); return { ...stats, threadId: id };
        } },
        log: { info() {}, warn() {} },
    };
    return { dom, root, fiber, api, requests };
}

async function settle(dom) {
    await new Promise((resolve) => dom.window.setTimeout(resolve, 120));
}

test("composer identity comes from its scoped React data and rejects remote hosts", () => {
    const f = fixture();
    assert.deepEqual(resolveConversation(f.root, f.api, f.dom.window), { threadId: firstId, hostId: "local" });
    f.fiber.return.memoizedProps.value.hostId = "remote-control:example";
    assert.equal(resolveConversation(f.root, f.api, f.dom.window), null);
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

test("explicit remote host on an outer scope or route vetoes an implicit local identity", () => {
    const f = fixture();
    delete f.fiber.return.memoizedProps.value.hostId;
    f.fiber.return.return = { memoizedProps: { hostId: "remote-control:example" } };
    assert.equal(resolveConversation(f.root, f.api, f.dom.window), null);
    f.fiber.return = { memoizedProps: {
        threadId: firstId,
        location: { pathname: `/local/${firstId}`, search: "?hostId=remote-control%3Aexample" },
    } };
    assert.equal(resolveConversation(f.root, f.api, f.dom.window), null);
    f.dom.window.close();
});

test("isolated preload obtains only composer identities through the main-world bridge", async () => {
    const f = fixture();
    f.api.react.getFiber = () => null;
    f.api.ipc.invoke = async (channel, id) => channel === "bindings"
        ? [{ key: f.root.dataset.sessionStatsKey, bound: { threadId: firstId, hostId: "local" } }]
        : { ...stats, threadId: id };
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

test("footer displays the five metrics without context occupancy and cleans up", async () => {
    const f = fixture();
    const controller = startRenderer(f.api, { window: f.dom.window, pollMs: 60000 });
    await settle(f.dom);
    const bar = f.root.querySelector("[data-session-stats]");
    assert.ok(bar, "mounts beneath the composer content");
    assert.match(bar.textContent, /2 turns.*33 steps.*209 tok\/s.*11\.7M tok.*Cache hit 96%/);
    assert.doesNotMatch(bar.textContent, /context|上下文|42%/i);
    assert.match(bar.querySelector('[data-stat="tps"]').title, /工具/);
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
    f.api.ipc.invoke = async (_channel, id) => id === firstId
        ? new Promise((resolve) => { resolveFirst = resolve; })
        : { ...stats, threadId: id, turns: 7, tps: null };
    const controller = startRenderer(f.api, { window: f.dom.window, pollMs: 60000 });
    await settle(f.dom);
    assert.equal(typeof resolveFirst, "function");
    f.fiber.return.memoizedProps.value.conversationId = secondId;
    f.root.appendChild(f.dom.window.document.createElement("span"));
    await settle(f.dom);
    resolveFirst({ ...stats, threadId: firstId });
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

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const { startRenderer } = require("../src/renderer.cjs");

const parentId = "01a16231-aaa3-7932-98c7-6d77f68149c0";
const childId = "01a1622e-a93d-7870-9f07-f3f02681d4af";
const otherId = "01a181ea-ee20-7aa3-b6fe-4f71705784d8";
const PANEL = "[data-app-shell-pane-content-viewport]";
const sample = { status: "ok", turns: 1, steps: 10, tps: 83, totalTokens: 657675,
    inputTokens: 650000, outputTokens: 7675, cachedInputTokens: 570000, cacheHit: 0.88 };

function fixture(t) {
    const dom = new JSDOM('<main><div data-codex-composer-root></div></main>'
        + '<aside><header>Selected child</header><div data-app-shell-pane-content-viewport="true" style="position: relative">'
        + '<article>Transcript</article></div></aside>',
    { url: `https://codex.local/local/${parentId}`, runScripts: "outside-only" });
    const doc = dom.window.document;
    const viewport = doc.querySelector(PANEL);
    const composer = doc.querySelector("[data-codex-composer-root]");
    for (const root of [viewport, composer]) root.getClientRects = () => [{ width: 600, height: 300 }];
    const layout = { memoizedProps: { headerRows: [
        { id: "subagent-detail", content: { props: { conversationId: childId, hostId: "local" } } },
    ] } };
    viewport.__reactFiberTest = { memoizedProps: {}, return: layout };
    composer.__reactFiberTest = { memoizedProps: {
        value: { kind: "local", conversationId: parentId, hostId: "local" },
    } };
    const requests = [];
    const api = {
        react: { getFiber: root => root.__reactFiberTest },
        ipc: { invoke: async (channel, bound) => {
            assert.equal(channel, "stats");
            requests.push(bound);
            return { ...sample, ...bound, turns: bound.threadId === parentId ? 9 : 1 };
        } },
        log: { info() {}, warn() {} },
    };
    const start = () => {
        const controller = startRenderer(api, { window: dom.window, debounceMs: 0, pollMs: 60000 });
        t.after(() => { controller.stop(); dom.window.close(); });
        return controller;
    };
    const change = (threadId, hostId = "local") => {
        layout.memoizedProps.headerRows[0].content.props = { conversationId: threadId, hostId };
        viewport.querySelector("article").textContent = `Selected ${threadId}/${hostId}`;
    };
    return { dom, doc, viewport, composer, layout, api, requests, start, change };
}

async function settle(dom) {
    await new Promise(resolve => dom.window.setTimeout(resolve, 40));
}

test("selected subagent stats overlay the pane bottom without reserving layout space", async t => {
    const f = fixture(t);
    const viewportStyle = f.viewport.getAttribute("style");
    const controller = f.start();
    await settle(f.dom);
    const anchor = f.viewport.querySelector(":scope > [data-session-stats-anchor]");
    assert.ok(anchor, "mounts a fixed overlay directly in the pane viewport");
    assert.equal(f.viewport.previousElementSibling.tagName, "HEADER", "no extra row between header and content");
    assert.equal(anchor.dataset.sessionStatsPlacement, "subagent");
    assert.match(anchor.textContent, /1 turns.*10 steps.*83 tok\/s.*657\.7K tok.*Cache hit 88%/);
    assert.match(f.composer.textContent, /9 turns/);
    assert.equal(f.viewport.querySelector("article [data-session-stats]"), null, "row is outside scrolling content");
    assert.equal(f.doc.querySelectorAll("[data-session-stats]").length, 2);
    assert.ok(f.requests.some(bound => bound.threadId === childId && bound.hostId === "local"));
    const style = f.dom.window.getComputedStyle(anchor);
    assert.equal(style.position, "absolute", "overlay does not participate in flex layout");
    assert.equal(style.height, "0px");
    assert.equal(style.bottom, "0px");
    assert.equal(f.dom.window.getComputedStyle(anchor.firstElementChild).bottom, "2px");
    assert.equal(f.viewport.getAttribute("style"), viewportStyle, "does not add padding or resize the viewport");
    assert.equal(f.viewport.querySelector("article").getAttribute("style"), null);
    assert.equal(f.dom.window.getComputedStyle(f.composer.querySelector("[data-session-stats-anchor]")).height, "0px");
    f.viewport.querySelector("article").append(f.doc.createElement("span"));
    await settle(f.dom);
    assert.equal(f.doc.querySelectorAll("[data-session-stats]").length, 2, "reconciliation does not duplicate rows");
    controller.stop();
    assert.equal(f.doc.querySelector("[data-session-stats-anchor]"), null);
    assert.equal(f.doc.querySelector("[data-session-stats-key]"), null);
});

test("child and host switches discard late replies from the previous panel selection", async t => {
    const f = fixture(t);
    let finishOld;
    f.api.ipc.invoke = async (_channel, bound) => {
        if (bound.threadId === childId && bound.hostId === "local") {
            return new Promise(resolve => { finishOld = resolve; });
        }
        return { ...sample, ...bound, tps: 55, turns: 3 };
    };
    f.start();
    await settle(f.dom);
    assert.equal(typeof finishOld, "function");
    f.change(otherId, "remote-control:example");
    await settle(f.dom);
    assert.match(f.viewport.querySelector("[data-session-stats]").textContent, /3 turns.*55 tok\/s/);
    finishOld({ ...sample, threadId: childId, hostId: "local", tps: 999 });
    await settle(f.dom);
    assert.doesNotMatch(f.viewport.querySelector("[data-session-stats]").textContent, /999/);
    f.change(otherId, "local");
    await settle(f.dom);
    assert.equal(f.doc.querySelectorAll("[data-session-stats]").length, 2);
});

test("isolated renderer resolves child identity through the existing main-world bridge", async t => {
    const f = fixture(t);
    const { bindingScript } = require("../src/binding.cjs");
    f.api.react.getFiber = () => null;
    f.change(childId, "remote-control:example");
    f.api.ipc.invoke = async (channel, bound) => {
        if (channel === "bindings") return JSON.parse(JSON.stringify(f.dom.window.eval(bindingScript)));
        f.requests.push(bound);
        return { ...sample, ...bound };
    };
    f.start();
    await settle(f.dom);
    assert.match(f.viewport.querySelector("[data-session-stats]").textContent, /83 tok\/s/);
    assert.ok(f.requests.some(bound => bound.threadId === childId && bound.hostId === "remote-control:example"));
});

test("unrelated panes, the child list and invalid selected identities cannot inherit the main route", async t => {
    const f = fixture(t);
    f.layout.memoizedProps.headerRows = [];
    f.start();
    await settle(f.dom);
    assert.equal(f.doc.querySelectorAll("[data-session-stats]").length, 1);
    assert.ok(f.requests.every(bound => bound.threadId === parentId));
    f.layout.memoizedProps.headerRows = [{ id: "subagent-detail", content: { props: { hostId: "local" } } }];
    f.viewport.querySelector("article").textContent = "Loading child";
    await settle(f.dom);
    assert.equal(f.doc.querySelectorAll("[data-session-stats]").length, 1);
});

test("returning to the list, hiding and removing the pane remove its statistics row", async t => {
    const f = fixture(t);
    f.start();
    await settle(f.dom);
    const headerRows = f.layout.memoizedProps.headerRows;
    f.layout.memoizedProps.headerRows = [];
    f.viewport.querySelector("article").textContent = "Subagents list";
    await settle(f.dom);
    assert.equal(f.doc.querySelectorAll("[data-session-stats]").length, 1);
    f.layout.memoizedProps.headerRows = headerRows;
    f.viewport.querySelector("article").textContent = "Selected child";
    await settle(f.dom);
    assert.equal(f.doc.querySelectorAll("[data-session-stats]").length, 2);
    f.viewport.parentElement.hidden = true;
    await settle(f.dom);
    assert.equal(f.doc.querySelectorAll("[data-session-stats]").length, 1);
    f.viewport.parentElement.hidden = false;
    await settle(f.dom);
    assert.equal(f.doc.querySelectorAll("[data-session-stats]").length, 2);
    f.viewport.remove();
    await settle(f.dom);
    assert.equal(f.doc.querySelectorAll("[data-session-stats]").length, 1, "no orphaned overlay");
});

test("React replacing the transcript viewport remounts exactly one child row", async t => {
    const f = fixture(t);
    f.start();
    await settle(f.dom);
    const replacement = f.viewport.cloneNode(false);
    replacement.append(f.viewport.querySelector("article").cloneNode(true));
    replacement.__reactFiberTest = f.viewport.__reactFiberTest;
    replacement.getClientRects = f.viewport.getClientRects;
    f.viewport.replaceWith(replacement);
    await settle(f.dom);
    assert.ok(replacement.querySelector(":scope > [data-session-stats-anchor]"));
    assert.equal(f.doc.querySelectorAll("[data-session-stats]").length, 2);
});

test("an interactive child has one bottom overlay without a duplicate composer footer", async t => {
    const f = fixture(t);
    const childComposer = f.doc.createElement("div");
    childComposer.dataset.codexComposerRoot = "";
    childComposer.getClientRects = f.composer.getClientRects;
    childComposer.__reactFiberTest = { memoizedProps: {
        value: { kind: "local", conversationId: childId, hostId: "local" },
    } };
    f.viewport.append(childComposer);
    f.start();
    await settle(f.dom);
    assert.equal(childComposer.querySelector("[data-session-stats]"), null);
    assert.ok(f.viewport.querySelector(":scope > [data-session-stats-anchor]"));
    assert.equal(f.doc.querySelectorAll("[data-session-stats]").length, 2);
});

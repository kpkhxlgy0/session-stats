"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const { bindingScript } = require("../src/binding.cjs");

test("main-world script reads the committed fiber and returns only sanitized composer identity", (t) => {
    const dom = new JSDOM('<div data-codex-composer-root data-session-stats-key="test"></div>',
        { url: "https://codex.local/index.html", runScripts: "outside-only" });
    t.after(() => dom.window.close());
    const root = dom.window.document.querySelector("div");
    const oldId = "01a16231-aaa3-7932-98c7-6d77f68149c0";
    const newId = "01a1622e-a93d-7870-9f07-f3f02681d4af";
    const current = { memoizedProps: { threadId: newId, privateText: "never exported" } };
    const oldRoot = { stateNode: { current: {} } };
    root.__reactFiberTest = {
        memoizedProps: { threadId: oldId }, return: oldRoot, alternate: current,
    };
    const result = JSON.parse(JSON.stringify(dom.window.eval(bindingScript)));
    assert.deepEqual(result, [{ key: "test", bound: { threadId: newId, hostId: "local" } }]);
    current.memoizedProps.hostId = "remote-control:example";
    assert.equal(dom.window.eval(bindingScript)[0].bound, null);
});

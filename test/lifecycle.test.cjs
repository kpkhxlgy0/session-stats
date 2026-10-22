"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("disable and hot reload release the tweak IPC handler without touching other handlers", async () => {
    const source = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");
    const handlers = new Map([["another-tweak", () => "untouched"]]);
    let disposed = 0;
    const moduleObject = { exports: {} };
    const api = {
        process: "main", manifest: { id: "com.kpk.session-stats" }, log: { info() {} },
        ipc: { handle(name, handler) {
            const channel = `codexpp:com.kpk.session-stats:${name}`;
            if (handlers.has(channel)) throw new Error("duplicate handler");
            handlers.set(channel, handler);
        } },
    };
    const customRequire = (name) => {
        if (name === "electron") return { ipcMain: {
            handle: (channel, handler) => handlers.set(channel, handler),
            removeHandler: (channel) => handlers.delete(channel),
        } };
        if (name === "./src/binding.cjs") return require("../src/binding.cjs");
        if (name === "./src/session-store.cjs") return {
            createSessionStore: () => ({
                getStats: async (threadId) => ({ status: "not-found", threadId }),
                dispose: () => { disposed++; },
            }),
        };
        return require(name);
    };
    vm.runInNewContext(source, { module: moduleObject, require: customRequire, process });
    const tweak = moduleObject.exports;
    tweak.start(api);
    assert.equal((await handlers.get("codexpp:com.kpk.session-stats:stats")("thread")).status, "not-found");
    let executed = 0;
    const frame = { executeJavaScript: async (source) => {
        executed++;
        assert.equal(source, require("../src/binding.cjs").bindingScript);
        return [{ key: "root", bound: null }];
    } };
    const bind = handlers.get("codexpp:com.kpk.session-stats:bindings");
    assert.equal((await bind({ senderFrame: frame, sender: { mainFrame: frame } })).length, 1);
    assert.equal((await bind({ senderFrame: {}, sender: { mainFrame: frame } })).length, 0);
    assert.equal(executed, 1);
    tweak.start(api);
    assert.equal(disposed, 1);
    tweak.stop(); tweak.stop();
    assert.equal(disposed, 2);
    assert.equal(handlers.size, 1);
    assert.equal(handlers.get("another-tweak")(), "untouched");
});

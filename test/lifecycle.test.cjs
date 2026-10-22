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
    let remoteDisposed = 0;
    let transportDisposed = 0;
    let localReads = 0;
    let remoteReads = 0;
    let transportedFrame;
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
                getStats: async (threadId) => { localReads++; return { status: "not-found", threadId }; },
                dispose: () => { disposed++; },
            }),
        };
        if (name === "./src/remote-session-store.cjs") return {
            createRemoteSessionStore: () => ({
                getStats: async (identity, request) => {
                    remoteReads++;
                    const result = await request("thread/read", { threadId: identity.threadId, includeTurns: false });
                    return { ...identity, status: "ok", tps: result.tps };
                },
                dispose: () => { remoteDisposed++; },
            }),
        };
        if (name === "./src/remote-transport.cjs") return {
            createRemoteTransport: () => ({
                request: async (frame, hostId, method, params) => {
                    transportedFrame = frame;
                    assert.equal(hostId, "remote-control:test");
                    assert.equal(method, "thread/read");
                    assert.equal(params.includeTurns, false);
                    return { tps: 55 };
                },
                dispose: () => { transportDisposed++; },
            }),
        };
        return require(name);
    };
    vm.runInNewContext(source, { module: moduleObject, require: customRequire, process });
    const tweak = moduleObject.exports;
    tweak.start(api);
    let executed = 0;
    const frame = { executeJavaScript: async (source) => {
        executed++;
        assert.equal(source, require("../src/binding.cjs").bindingScript);
        return [{ key: "root", bound: null }];
    } };
    const bind = handlers.get("codexpp:com.kpk.session-stats:bindings");
    const getStats = handlers.get("codexpp:com.kpk.session-stats:stats");
    const event = { senderFrame: frame, sender: { mainFrame: frame } };
    const identity = { threadId: "019f7463-6700-7000-8000-000000000001", hostId: "local" };
    const localStats = await getStats(event, identity);
    assert.equal(localStats.status, "not-found");
    assert.equal(localStats.hostId, "local");
    assert.equal(localStats.threadId, identity.threadId);
    const remoteStats = await getStats(event, { ...identity, hostId: "remote-control:test" });
    assert.equal(remoteStats.hostId, "remote-control:test");
    assert.equal(remoteStats.tps, 55);
    assert.equal(transportedFrame, frame);
    assert.equal((await getStats({ ...event, senderFrame: {} }, identity)).status, "unavailable");
    for (const invalid of [{ ...identity, hostId: "" }, { ...identity, hostId: "bad\nhost" },
        { ...identity, threadId: "../not-a-thread" }, { threadId: identity.threadId }]) {
        assert.equal((await getStats(event, invalid)).status, "unavailable");
    }
    assert.equal(localReads, 1);
    assert.equal(remoteReads, 1);
    assert.equal((await bind({ senderFrame: frame, sender: { mainFrame: frame } })).length, 1);
    assert.equal((await bind({ senderFrame: {}, sender: { mainFrame: frame } })).length, 0);
    assert.equal(executed, 1);
    tweak.start(api);
    assert.equal(disposed, 1);
    tweak.stop(); tweak.stop();
    assert.equal(disposed, 2);
    assert.equal(remoteDisposed, 2);
    assert.equal(transportDisposed, 2);
    assert.equal(handlers.size, 1);
    assert.equal(handlers.get("another-tweak")(), "untouched");
});

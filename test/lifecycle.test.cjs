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
    let transportDisposed = 0;
    let localReads = 0;
    let publishedReads = 0;
    let snapshotReads = 0;
    let publisherStarted = 0;
    let publisherDisposed = 0;
    let snapshotsDisposed = 0;
    let demanded = 0;
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
        if (name === "node:fs") return { realpathSync: () => "/resolved-codex-home" };
        if (name === "electron") return { ipcMain: {
            handle: (channel, handler) => handlers.set(channel, handler),
            removeHandler: (channel) => handlers.delete(channel),
        } };
        if (name === "./src/binding.cjs") return require("../src/binding.cjs");
        if (name === "./src/session-store.cjs") return {
            createSessionStore: ({ codexHome }) => {
                assert.equal(codexHome, "/resolved-codex-home");
                return {
                getStats: async (threadId) => { localReads++; return { status: "not-found", threadId }; },
                dispose: () => { disposed++; },
                };
            },
        };
        if (name === "./src/remote-session-store.cjs") assert.fail("must not load a remote raw-log reader");
        if (name === "./src/snapshot-publisher.cjs") return {
            createSnapshotPublisher: ({ store, installationRoot, codexHome }) => {
                assert.equal(installationRoot, path.join(__dirname, ".."));
                assert.equal(codexHome, "/resolved-codex-home");
                return {
                    start: () => { publisherStarted++; },
                    getStats: async threadId => {
                        publishedReads++;
                        return { ...await store.getStats(threadId), source: "snapshot", snapshotRevision: 7 };
                    },
                    dispose: () => { publisherDisposed++; },
                };
            },
        };
        if (name === "./src/snapshot-remote-store.cjs") return {
            createSnapshotRemoteStore: () => {
                return {
                    getStats: async (identity, request) => {
                        snapshotReads++;
                        await request("snapshot/request", { rolloutPath: "/rollout", threadId: "not-the-bound-id" },
                            { timeoutMs: 5000, maxChars: 65536 });
                        const result = await request("fs/readFile", { path: "/snapshot.json" },
                            { timeoutMs: 5000, maxChars: 65536 });
                        return { ...identity, status: "ok", tps: result.tps, source: "snapshot" };
                    },
                    dispose: () => { snapshotsDisposed++; },
                };
            },
        };
        if (name === "./src/remote-transport.cjs") return {
            createRemoteTransport: () => ({
                requestSnapshot: async (frame, hostId, rolloutPath, threadId, limits) => {
                    demanded++;
                    assert.equal(hostId, "remote-control:test");
                    assert.equal(rolloutPath, "/rollout");
                    assert.equal(threadId, "019f7463-6700-7000-8000-000000000001");
                    assert.equal(limits.timeoutMs, 5000);
                },
                request: async (frame, hostId, method, params, limits) => {
                    transportedFrame = frame;
                    assert.equal(hostId, "remote-control:test");
                    assert.equal(method, "fs/readFile");
                    assert.equal(params.path, "/snapshot.json");
                    assert.deepEqual(limits, { timeoutMs: 5000, maxChars: 65536 });
                    return { tps: 55 };
                },
                dispose: () => { transportDisposed++; },
            }),
        };
        return require(name);
    };
    vm.runInNewContext(source, { module: moduleObject, require: customRequire, process,
        __dirname: path.join(__dirname, "..") });
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
    assert.equal(localStats.source, "snapshot");
    assert.equal(localStats.snapshotRevision, 7);
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
    assert.equal(publishedReads, 1);
    assert.equal(snapshotReads, 1);
    assert.equal(demanded, 1);
    assert.equal(publisherStarted, 1);
    assert.equal((await bind({ senderFrame: frame, sender: { mainFrame: frame } })).length, 1);
    assert.equal((await bind({ senderFrame: {}, sender: { mainFrame: frame } })).length, 0);
    assert.equal(executed, 1);
    tweak.start(api);
    assert.equal(disposed, 1);
    await new Promise(setImmediate);
    tweak.stop(); tweak.stop();
    assert.equal(disposed, 2);
    assert.equal(transportDisposed, 2);
    assert.equal(publisherStarted, 2);
    assert.equal(publisherDisposed, 2);
    assert.equal(snapshotsDisposed, 2);
    assert.equal(handlers.size, 1);
    assert.equal(handlers.get("another-tweak")(), "untouched");
});

test("a reloaded module cannot publish until the preceding publisher has drained", async () => {
    const source = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");
    let finishOldDispose;
    const oldDispose = new Promise(resolve => { finishOldDispose = resolve; });
    const handlers = new Map(), publishers = [];
    const requireFixture = name => {
        if (name === "electron") return { ipcMain: {
            handle: (key, fn) => handlers.set(key, fn), removeHandler: key => handlers.delete(key),
        } };
        if (name === "./src/binding.cjs") return { bindingScript: "bindings" };
        if (name === "./src/session-store.cjs") return { createSessionStore: () => ({ dispose() {} }) };
        if (name === "./src/remote-session-store.cjs") return { createRemoteSessionStore: () => ({ dispose() {} }) };
        if (name === "./src/snapshot-remote-store.cjs") return {
            createSnapshotRemoteStore: () => ({ dispose() {} }),
        };
        if (name === "./src/remote-transport.cjs") return { createRemoteTransport: () => ({ dispose() {} }) };
        if (name === "./src/snapshot-publisher.cjs") return { createSnapshotPublisher: () => {
            const number = publishers.length;
            const state = { starts: 0, reads: 0, start() { this.starts++; },
                async getStats(threadId) { this.reads++; return { status: "ok", threadId, snapshotRevision: number + 1 }; },
                dispose: () => number === 0 ? oldDispose : Promise.resolve() };
            publishers.push(state); return state;
        } };
        return require(name);
    };
    const context = vm.createContext({ require: requireFixture, process, __dirname: path.join(__dirname, "..") });
    const createModule = () => vm.runInContext(`(function() { const module = { exports: {} }; ${source}\nreturn module.exports; })()`, context);
    const api = { process: "main", manifest: { id: "com.kpk.session-stats" }, log: { info() {} } };
    const first = createModule(); first.start(api);
    await new Promise(setImmediate);
    assert.equal(publishers.length, 1, "main runtime must create its runner publisher");
    assert.equal(publishers[0].starts, 1);
    first.stop();
    const second = createModule(); second.start(api);
    const frame = {}, identity = { threadId: "019f7463-6700-7000-8000-000000000001", hostId: "local" };
    const pending = handlers.get("codexpp:com.kpk.session-stats:stats")({ senderFrame: frame, sender: { mainFrame: frame } }, identity);
    await new Promise(setImmediate);
    assert.equal(publishers[1].starts, 0);
    assert.equal(publishers[1].reads, 0);
    finishOldDispose();
    const result = await pending;
    assert.equal(result.snapshotRevision, 2);
    assert.equal(publishers[1].starts, 1);
    assert.equal(publishers[1].reads, 1);
    second.stop();
});

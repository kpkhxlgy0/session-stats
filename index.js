"use strict";

let controller;

module.exports = {
    start(api) {
        module.exports.stop();
        if (api.process === "main") {
            const { ipcMain } = require("electron");
            const { homedir } = require("node:os");
            const { join } = require("node:path");
            const { realpathSync } = require("node:fs");
            const { createSessionStore } = require("./src/session-store.cjs");
            const { createSnapshotPublisher } = require("./src/snapshot-publisher.cjs");
            const { createSnapshotRemoteStore } = require("./src/snapshot-remote-store.cjs");
            const { createRemoteTransport } = require("./src/remote-transport.cjs");
            const { bindingScript } = require("./src/binding.cjs");
            const configuredHome = process.env.CODEX_HOME || join(homedir(), ".codex");
            let codexHome = configuredHome;
            try { codexHome = realpathSync(configuredHome); } catch { /* An unavailable home remains an unavailable source. */ }
            const store = createSessionStore({ codexHome });
            const publisher = createSnapshotPublisher({ codexHome, store, installationRoot: __dirname });
            const remoteStore = createSnapshotRemoteStore();
            const transport = createRemoteTransport();
            const drainKey = Symbol.for("codexpp:com.kpk.session-stats:publisher-drain");
            const precedingDrain = Promise.resolve(globalThis[drainKey]).catch(() => {});
            let stopped = false;
            // A replaced module must not publish before the preceding atomic write has drained.
            const publisherReady = precedingDrain.then(() => {
                if (!stopped) void publisher.start();
            });
            const channel = `codexpp:${api.manifest.id}:stats`;
            const bindingChannel = `codexpp:${api.manifest.id}:bindings`;
            ipcMain.handle(channel, async (event, identity) => {
                const { threadId, hostId } = identity ?? {};
                if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame
                    || typeof threadId !== "string"
                    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(threadId)
                    || typeof hostId !== "string" || !hostId.length || hostId.length > 512
                    || /[\u0000-\u001f\u007f-\u009f]/.test(hostId)) {
                    return { status: "unavailable", threadId: null, hostId: null };
                }
                const bound = { threadId: threadId.toLowerCase(), hostId };
                if (hostId === "local") {
                    await publisherReady;
                    return { ...await publisher.getStats(bound.threadId), hostId };
                }
                return remoteStore.getStats(bound, (method, params, limits) => method === "snapshot/request"
                    ? transport.requestSnapshot(event.senderFrame, hostId, params.rolloutPath, bound.threadId, limits)
                    : transport.request(event.senderFrame, hostId, method, params, limits));
            });
            // 通过调用方的主页面读取固定的最小标识，支持 Electron contextIsolation。
            ipcMain.handle(bindingChannel, async (event) => {
                if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) return [];
                try { return await event.senderFrame.executeJavaScript(bindingScript); }
                catch { return []; }
            });
            controller = {
                stop() {
                    stopped = true;
                    globalThis[drainKey] = Promise.allSettled([precedingDrain, publisher.dispose()]).then(() => {});
                    ipcMain.removeHandler(channel);
                    ipcMain.removeHandler(bindingChannel);
                    store.dispose();
                    remoteStore.dispose();
                    transport.dispose();
                },
            };
            api.log.info("main started; runner snapshots and remote snapshot statistics");
            return;
        }
        if (api.process === "renderer") {
            const { startRenderer } = require("./src/renderer.cjs");
            controller = startRenderer(api);
        }
    },

    stop() {
        controller?.stop();
        controller = undefined;
    },
};

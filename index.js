"use strict";

let controller;

module.exports = {
    start(api) {
        module.exports.stop();
        if (api.process === "main") {
            const { ipcMain } = require("electron");
            const { homedir } = require("node:os");
            const { join } = require("node:path");
            const { createSessionStore } = require("./src/session-store.cjs");
            const { createRemoteSessionStore } = require("./src/remote-session-store.cjs");
            const { createRemoteTransport } = require("./src/remote-transport.cjs");
            const { bindingScript } = require("./src/binding.cjs");
            const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
            const store = createSessionStore({ codexHome });
            const remoteStore = createRemoteSessionStore();
            const transport = createRemoteTransport();
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
                if (hostId === "local") return { ...await store.getStats(bound.threadId), hostId };
                return remoteStore.getStats(bound, (method, params) =>
                    transport.request(event.senderFrame, hostId, method, params));
            });
            // 通过调用方的主页面读取固定的最小标识，支持 Electron contextIsolation。
            ipcMain.handle(bindingChannel, async (event) => {
                if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) return [];
                try { return await event.senderFrame.executeJavaScript(bindingScript); }
                catch { return []; }
            });
            controller = {
                stop() {
                    ipcMain.removeHandler(channel);
                    ipcMain.removeHandler(bindingChannel);
                    store.dispose();
                    remoteStore.dispose();
                    transport.dispose();
                },
            };
            api.log.info("main started; read-only local and remote session statistics");
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

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
            const { bindingScript } = require("./src/binding.cjs");
            const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
            const store = createSessionStore({ codexHome });
            const channel = `codexpp:${api.manifest.id}:stats`;
            const bindingChannel = `codexpp:${api.manifest.id}:bindings`;
            api.ipc.handle("stats", (threadId) => store.getStats(threadId));
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
                },
            };
            api.log.info("main started; read-only local session statistics");
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

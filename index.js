"use strict";

let controller;

module.exports = {
    start(api) {
        module.exports.stop();
        if (api.process === "main") {
            const { ipcMain, BrowserWindow } = require("electron");
            const { randomUUID } = require("node:crypto");
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
            const views = new Map();
            const releases = new Set();
            const drainKey = Symbol.for("codexpp:com.kpk.session-stats:publisher-drain");
            const precedingDrain = Promise.resolve(globalThis[drainKey]).catch(() => {});
            let stopped = false;
            // A replaced module must not publish before the preceding atomic write has drained.
            const publisherReady = precedingDrain.then(() => {
                if (!stopped) void publisher.start();
            });
            const channel = `codexpp:${api.manifest.id}:stats`;
            const bindingChannel = `codexpp:${api.manifest.id}:bindings`;
            const releaseChannel = `codexpp:${api.manifest.id}:release`;
            const validOwner = value => typeof value === "string" && value.length > 0 && value.length <= 128
                && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
            function releaseOwner(view, ownerId) {
                const interest = view.owners.get(ownerId);
                if (!interest) return;
                view.owners.delete(ownerId);
                publisher.release(interest.key);
                const task = Promise.resolve(remoteStore.release(interest.key)).catch(() => {})
                    .finally(() => releases.delete(task));
                releases.add(task);
            }
            function releaseView(view) {
                for (const ownerId of [...view.owners.keys()]) releaseOwner(view, ownerId);
            }
            function removeView(sender, view) {
                releaseView(view);
                for (const remove of view.hooks) remove();
                views.delete(sender);
            }
            function viewFor(sender) {
                let view = views.get(sender);
                if (view) return view;
                view = { prefix: randomUUID(), owners: new Map(), hooks: [], navigating: false };
                const listen = (target, name, fn) => {
                    if (!target?.on) return;
                    target.on(name, fn);
                    view.hooks.push(() => target.removeListener(name, fn));
                };
                listen(sender, "did-start-navigation", (_event, _url, _inPlace, main) => {
                    if (main) {
                        if (!_inPlace) view.navigating = true;
                        releaseView(view);
                    }
                });
                listen(sender, "did-finish-load", () => { view.navigating = false; });
                listen(sender, "render-process-gone", () => releaseView(view));
                listen(sender, "destroyed", () => removeView(sender, view));
                const nativeWindow = view.nativeWindow = BrowserWindow?.fromWebContents(sender);
                for (const name of ["hide", "minimize"]) listen(nativeWindow, name, () => releaseView(view));
                listen(nativeWindow, "closed", () => removeView(sender, view));
                views.set(sender, view);
                return view;
            }
            ipcMain.handle(releaseChannel, (event, identity) => {
                if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame || !validOwner(identity?.ownerId)) return;
                const view = views.get(event.sender);
                if (view) releaseOwner(view, identity.ownerId);
            });
            ipcMain.handle(channel, async (event, identity) => {
                const { threadId, hostId, ownerId } = identity ?? {};
                if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame
                    || !validOwner(ownerId)
                    || typeof threadId !== "string"
                    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(threadId)
                    || typeof hostId !== "string" || !hostId.length || hostId.length > 512
                    || /[\u0000-\u001f\u007f-\u009f]/.test(hostId)) {
                    return { status: "unavailable", threadId: null, hostId: null };
                }
                const view = viewFor(event.sender);
                if (view.navigating || view.nativeWindow?.isVisible?.() === false || view.nativeWindow?.isMinimized?.()) {
                    releaseView(view);
                    return { status: "unavailable", threadId: threadId.toLowerCase(), hostId };
                }
                let interest = view.owners.get(ownerId);
                if (interest && (interest.threadId !== threadId.toLowerCase() || interest.hostId !== hostId)) {
                    releaseOwner(view, ownerId);
                    interest = null;
                }
                if (!interest) {
                    interest = { key: `${view.prefix}:${ownerId}`, threadId: threadId.toLowerCase(), hostId };
                    view.owners.set(ownerId, interest);
                }
                const bound = { threadId: threadId.toLowerCase(), hostId, ownerId: interest.key };
                if (hostId === "local") {
                    await publisherReady;
                    if (stopped || view.owners.get(ownerId) !== interest)
                        return { status: "unavailable", threadId: bound.threadId, hostId };
                    return { ...await publisher.getStats(bound.threadId, { ownerId: interest.key }), hostId };
                }
                return remoteStore.getStats(bound, (method, params, limits) => ["snapshot/request", "snapshot/release"].includes(method)
                    ? transport.requestSnapshot(event.senderFrame, hostId, params.rolloutPath, bound.threadId,
                        { ...limits, consumerId: params.consumerId, active: method === "snapshot/request" })
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
                    for (const [sender, view] of views) removeView(sender, view);
                    // Remote cancellation drains independently; only atomic publisher writes gate its replacement.
                    void Promise.allSettled([...releases, remoteStore.dispose()]).finally(() => transport.dispose());
                    globalThis[drainKey] = Promise.allSettled([precedingDrain, publisher.dispose()]).then(() => {});
                    ipcMain.removeHandler(channel);
                    ipcMain.removeHandler(bindingChannel);
                    ipcMain.removeHandler(releaseChannel);
                    store.dispose();
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

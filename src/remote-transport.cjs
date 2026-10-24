"use strict";

const { randomUUID } = require("node:crypto");
const ReadMethods = new Set(["thread/read", "fs/getMetadata", "fs/readFile", "fs/readDirectory"]);

// 此函数整体序列化到主页面，使用现有连接；不访问 Node 或更改应用的消息处理器。
function requestInPage(options) {
    return new Promise((resolve, reject) => {
        const { hostId, id, method, params, expiresAtMs, maxChars, cancelEvent } = options;
        let transfer = null;
        let timer;
        let settled = false;

        function finish(error, value) {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            window.removeEventListener("message", receive);
            window.removeEventListener("pagehide", cancel);
            window.removeEventListener(cancelEvent, cancel);
            transfer = null;
            if (error) reject(error);
            else resolve(value);
        }
        function cancel(event) {
            if (!event?.detail || event.detail === id) finish(new Error("Session stats request cancelled"));
        }

        function save(value) {
            const parent = transfer.stack.at(-1);
            if (!parent) {
                if (transfer.hasRoot) throw new Error("Duplicate root");
                transfer.root = value;
                transfer.hasRoot = true;
            } else if (Array.isArray(parent.value)) parent.value.push(value);
            else {
                if (parent.key === null) throw new Error("Missing key");
                parent.value[parent.key] = value;
                parent.key = null;
            }
        }
        function key(value) {
            const parent = transfer.stack.at(-1);
            if (!parent || Array.isArray(parent.value) || parent.key !== null || typeof value !== "string") {
                throw new Error("Invalid key");
            }
            parent.key = value;
        }
        function consume(tokens) {
            if (!Array.isArray(tokens)) throw new Error("Invalid tokens");
            for (const token of tokens) {
                if (!token || typeof token !== "object") throw new Error("Invalid token");
                transfer.size += 16 + (typeof token.value === "string" ? token.value.length : 0);
                if (transfer.size > maxChars) throw new Error("Response too large");
                if (transfer.strings && !["string-chunk", "string-end"].includes(token.type)) {
                    throw new Error("Unfinished string");
                }
                switch (token.type) {
                    case "array-start":
                    case "object-start": {
                        if (transfer.stack.length >= 64) throw new Error("Response too deep");
                        const value = token.type === "array-start" ? [] : Object.create(null);
                        save(value);
                        transfer.stack.push({ value, key: null });
                        break;
                    }
                    case "container-end": {
                        const parent = transfer.stack.pop();
                        if (!parent || parent.key !== null) throw new Error("Invalid container end");
                        break;
                    }
                    case "key": key(token.value); break;
                    case "value":
                        if (token.value != null && !["string", "number", "boolean"].includes(typeof token.value)) {
                            throw new Error("Invalid value");
                        }
                        save(token.value);
                        break;
                    case "string-start":
                        if (!["key", "value"].includes(token.target)) throw new Error("Invalid string target");
                        transfer.strings = [];
                        transfer.target = token.target;
                        break;
                    case "string-chunk":
                        if (!transfer.strings || typeof token.value !== "string") throw new Error("Invalid string");
                        transfer.strings.push(token.value);
                        break;
                    case "string-end": {
                        if (!transfer.strings) throw new Error("Invalid string end");
                        const value = transfer.strings.join("");
                        transfer.strings = null;
                        if (transfer.target === "key") key(value);
                        else save(value);
                        break;
                    }
                    default: throw new Error("Unknown token");
                }
            }
        }
        function decode(message) {
            if (message?.marker !== "codex-host-chunked-message-v1") return message;
            if (typeof message.transferId !== "string" || !Number.isSafeInteger(message.sequence)) return null;
            if (message.kind === "start") {
                transfer = { id: message.transferId, next: message.sequence + 1, stack: [], hasRoot: false,
                    strings: null, size: 0 };
                return null;
            }
            if (!transfer || transfer.id !== message.transferId) return null;
            if (transfer.next++ !== message.sequence) { transfer = null; return null; }
            try {
                if (message.kind === "chunk") { consume(message.tokens); return null; }
                if (message.kind !== "end" || !transfer.hasRoot || transfer.stack.length || transfer.strings) {
                    throw new Error("Incomplete response");
                }
                const result = transfer.root;
                transfer = null;
                return result;
            } catch (error) {
                const partial = transfer?.root;
                if (error.message === "Response too large" && method === "fs/readFile"
                    && partial?.type === "mcp-response" && partial.hostId === hostId && partial.message?.id === id) {
                    finish(new Error("Remote session log exceeds size limit"));
                }
                transfer = null;
                return null;
            }
        }
        function receive(event) {
            // 原生 preload 派发的 MessageEvent 没有 source；不接收 iframe 的消息。
            if (event.source != null && (event.source !== window
                || (window.location.origin !== "null" && event.origin !== window.location.origin))) return;
            const message = decode(event.data);
            if (message?.type !== "mcp-response" || message.hostId !== hostId || message.message?.id !== id) return;
            const response = message.message;
            if (response.error || !Object.hasOwn(response, "result")) {
                finish(new Error("Remote session stats request failed"));
            } else if (typeof response.result?.dataBase64 === "string"
                && response.result.dataBase64.length > maxChars) {
                finish(new Error("Remote session log exceeds size limit"));
            } else finish(null, response.result);
        }

        const remainingMs = expiresAtMs - Date.now();
        if (remainingMs <= 0) {
            finish(new Error("Remote session stats request timed out"));
            return;
        }
        if (typeof window.electronBridge?.sendMessageFromView !== "function") {
            finish(new Error("Codex host bridge unavailable"));
            return;
        }
        window.addEventListener("message", receive);
        window.addEventListener("pagehide", cancel);
        window.addEventListener(cancelEvent, cancel);
        timer = window.setTimeout(() => finish(new Error("Remote session stats request timed out")), remainingMs);
        // ACK 由 Codex 自己的接收器负责；这里只旁听，避免重复确认影响应用消息流。
        try {
            Promise.resolve(window.electronBridge.sendMessageFromView({ type: "mcp-request", hostId,
                request: { id, method, params }, timeoutMs: remainingMs }))
                .catch(() => finish(new Error("Codex host bridge unavailable")));
        } catch { finish(new Error("Codex host bridge unavailable")); }
    });
}

function createRemoteTransport({ timeoutMs, maxChars } = {}) {
    const pending = new Set();
    const cancelEvent = `session-stats-cancel-${randomUUID()}`;
    let disposed = false;

    function cancelPage(frame, id) {
        try {
            const source = `window.dispatchEvent(new CustomEvent(${JSON.stringify(cancelEvent)}, `
                + `{detail:${JSON.stringify(id ?? null)}}))`;
            Promise.resolve(frame.executeJavaScript(source)).catch(() => {});
        } catch { /* 页面已销毁时无需清理页面监听器。 */ }
    }

    async function request(frame, hostId, method, params) {
        if (disposed || !ReadMethods.has(method)) throw new Error("Remote stats request unavailable");
        const fileRequest = method === "fs/readFile";
        const requestTimeoutMs = timeoutMs ?? (fileRequest ? 120000 : 30000);
        const responseLimit = maxChars ?? (fileRequest ? 192 : 48) * 1024 * 1024;
        const options = { hostId, id: `session-stats:${randomUUID()}`, method, params,
            expiresAtMs: Date.now() + requestTimeoutMs, maxChars: responseLimit, cancelEvent };
        let timer;
        const entry = { frame };
        pending.add(entry);
        try {
            return await new Promise((resolve, reject) => {
                entry.reject = reject;
                timer = setTimeout(() => {
                    cancelPage(frame, options.id);
                    reject(new Error("Remote session stats request timed out"));
                }, requestTimeoutMs + 1000);
                Promise.resolve(frame.executeJavaScript(`(${requestInPage.toString()})(${JSON.stringify(options)})`))
                    .then(resolve, reject);
            });
        } catch (error) {
            if (String(error?.message).includes("Remote session log exceeds size limit")) {
                const limitError = new Error("Remote session log exceeds size limit");
                limitError.code = "SESSION_STATS_LOG_TOO_LARGE";
                throw limitError;
            }
            throw error;
        } finally {
            clearTimeout(timer);
            pending.delete(entry);
        }
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        for (const frame of new Set([...pending].map((entry) => entry.frame))) {
            cancelPage(frame);
        }
        for (const entry of pending) entry.reject(new Error("Session stats disabled"));
        pending.clear();
    }
    return { request, dispose };
}

module.exports = { createRemoteTransport };

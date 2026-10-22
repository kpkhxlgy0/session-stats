"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const { createRemoteTransport } = require("../src/remote-transport.cjs");

function fixture(t, respond, options = {}) {
    const dom = new JSDOM("", { url: "https://codex.invalid", runScripts: "outside-only" });
    const win = dom.window;
    const listeners = new Set();
    const add = win.addEventListener.bind(win), remove = win.removeEventListener.bind(win);
    win.addEventListener = (name, handler, ...rest) => {
        if (name === "message") listeners.add(handler);
        add(name, handler, ...rest);
    };
    win.removeEventListener = (name, handler, ...rest) => {
        if (name === "message") listeners.delete(handler);
        remove(name, handler, ...rest);
    };
    const emit = (data, source = null) => win.dispatchEvent(new win.MessageEvent("message", { data, source }));
    win.electronBridge = { sendMessageFromView: async (envelope) => respond(envelope, emit, win) };
    const frame = { executeJavaScript: (source) => Promise.resolve(win.eval(source)) };
    const transport = createRemoteTransport({ timeoutMs: 100, ...options });
    t.after(() => { transport.dispose(); win.close(); });
    return { transport, frame, listeners, win };
}

function response(envelope, result) {
    return { type: "mcp-response", hostId: envelope.hostId, message: { id: envelope.request.id, result } };
}

test("remote requests use the selected host and ignore other hosts and request IDs", async (t) => {
    const f = fixture(t, (envelope, emit) => {
        assert.equal(envelope.type, "mcp-request");
        assert.equal(envelope.hostId, "remote-control:test");
        assert.equal(envelope.request.method, "thread/read");
        assert.equal(envelope.request.params.threadId, "test-thread");
        emit({ ...response(envelope, { wrong: true }), hostId: "local" });
        emit({ type: "mcp-response", hostId: envelope.hostId, message: { id: "another-request", result: {} } });
        emit(response(envelope, { thread: { id: "test-thread", path: "/remote/log" } }));
    });
    const result = await f.transport.request(f.frame, "remote-control:test", "thread/read", { threadId: "test-thread" });
    assert.equal(result.thread.path, "/remote/log");
    assert.equal(f.listeners.size, 0);
});

test("large responses assemble token chunks and split strings without sending duplicate ACKs", async (t) => {
    const f = fixture(t, (envelope, emit, win) => {
        win.electronBridge.acknowledgeChunkedMessage = () => assert.fail("the app owns ACKs");
        const part = (sequence, kind, tokens) => emit({ marker: "codex-host-chunked-message-v1",
            transferId: "transfer", sequence, kind, ...(tokens ? { tokens } : {}) });
        part(0, "start");
        part(1, "chunk", [
            { type: "object-start" }, { type: "key", value: "type" }, { type: "value", value: "mcp-response" },
            { type: "key", value: "hostId" }, { type: "value", value: envelope.hostId },
            { type: "key", value: "message" }, { type: "object-start" },
            { type: "key", value: "id" }, { type: "value", value: envelope.request.id },
            { type: "key", value: "result" }, { type: "object-start" },
            { type: "string-start", target: "key" }, { type: "string-chunk", value: "data" },
            { type: "string-chunk", value: "Base64" }, { type: "string-end" },
            { type: "string-start", target: "value" }, { type: "string-chunk", value: "5Lit" },
        ]);
        part(2, "chunk", [{ type: "string-chunk", value: "5paHCg==" }, { type: "string-end" },
            { type: "container-end" }, { type: "container-end" }, { type: "container-end" }]);
        part(3, "end");
    });
    const result = await f.transport.request(f.frame, "host", "fs/readFile", { path: "/remote/log" });
    assert.equal(Buffer.from(result.dataBase64, "base64").toString("utf8"), "中文\n");
    assert.equal(f.listeners.size, 0);
});

test("broken chunk sequences cannot produce a partial result and a later valid response still works", async (t) => {
    const f = fixture(t, (envelope, emit) => {
        emit({ marker: "codex-host-chunked-message-v1", transferId: "bad", sequence: 0, kind: "start" });
        emit({ marker: "codex-host-chunked-message-v1", transferId: "bad", sequence: 2, kind: "end" });
        emit(response(envelope, { isFile: true, modifiedAtMs: 20 }));
    });
    const result = await f.transport.request(f.frame, "host", "fs/getMetadata", { path: "/remote/log" });
    assert.equal(result.modifiedAtMs, 20);
});

test("RPC errors and send failures reject and release listeners", async (t) => {
    for (const mode of ["rpc", "send"]) {
        const f = fixture(t, (envelope, emit) => {
            if (mode === "send") throw new Error("offline");
            emit({ type: "mcp-response", hostId: envelope.hostId,
                message: { id: envelope.request.id, error: { code: -32601, message: "unsupported" } } });
        });
        await assert.rejects(f.transport.request(f.frame, "host", "thread/read", {}));
        assert.equal(f.listeners.size, 0);
    }
});

test("timeout and unload release pending listeners", async (t) => {
    const f = fixture(t, () => {}, { timeoutMs: 15 });
    await assert.rejects(f.transport.request(f.frame, "host", "thread/read", {}), /timed out/i);
    assert.equal(f.listeners.size, 0);
    const pending = f.transport.request(f.frame, "host", "thread/read", {});
    f.win.dispatchEvent(new f.win.Event("pagehide"));
    await assert.rejects(pending);
    assert.equal(f.listeners.size, 0);
});

test("disable cancels requests and prevents new requests", async (t) => {
    const f = fixture(t, () => {});
    const pending = f.transport.request(f.frame, "host", "thread/read", {});
    f.transport.dispose();
    await assert.rejects(pending);
    assert.equal(f.listeners.size, 0);
    await assert.rejects(f.transport.request(f.frame, "host", "thread/read", {}));
});

test("oversized chunks are discarded without breaking the app's response handling", async (t) => {
    const f = fixture(t, (envelope, emit) => {
        emit({ marker: "codex-host-chunked-message-v1", transferId: "large", sequence: 0, kind: "start" });
        emit({ marker: "codex-host-chunked-message-v1", transferId: "large", sequence: 1, kind: "chunk",
            tokens: [{ type: "value", value: "x".repeat(1024) }] });
        emit(response(envelope, { isFile: true }));
    }, { maxChars: 512 });
    const result = await f.transport.request(f.frame, "host", "fs/getMetadata", { path: "/remote/log" });
    assert.equal(result.isFile, true);
});

test("remote transport rejects write methods before executing page code", async () => {
    const transport = createRemoteTransport();
    await assert.rejects(transport.request({ executeJavaScript() { assert.fail("must not execute"); } },
        "host", "fs/writeFile", { path: "/remote/log", dataBase64: "" }));
    transport.dispose();
});

test("an expired page script cannot send a request after outer timeout and disable", async (t) => {
    let sends = 0;
    const f = fixture(t, () => { sends++; }, { timeoutMs: 10 });
    const delayed = [];
    const frame = { executeJavaScript: (source) => new Promise((resolve, reject) => {
        delayed.push(() => {
            try { Promise.resolve(f.win.eval(source)).then(resolve, reject); }
            catch (error) { reject(error); }
        });
    }) };
    const pending = f.transport.request(frame, "host", "thread/read", {});
    await assert.rejects(pending, /timed out/i);
    f.transport.dispose();
    for (const run of delayed) run();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sends, 0);
    assert.equal(f.listeners.size, 0);
});

test("an oversized matching file transfer reports a cacheable limit error immediately", async (t) => {
    const f = fixture(t, (envelope, emit) => {
        emit({ marker: "codex-host-chunked-message-v1", transferId: "large", sequence: 0, kind: "start" });
        emit({ marker: "codex-host-chunked-message-v1", transferId: "large", sequence: 1, kind: "chunk", tokens: [
            { type: "object-start" }, { type: "key", value: "type" }, { type: "value", value: "mcp-response" },
            { type: "key", value: "hostId" }, { type: "value", value: envelope.hostId },
            { type: "key", value: "message" }, { type: "object-start" },
            { type: "key", value: "id" }, { type: "value", value: envelope.request.id },
            { type: "key", value: "result" }, { type: "object-start" },
            { type: "key", value: "dataBase64" }, { type: "string-start", target: "value" },
            { type: "string-chunk", value: "A".repeat(2048) },
        ] });
    }, { maxChars: 1024 });
    await assert.rejects(f.transport.request(f.frame, "host", "fs/readFile", { path: "/remote/log" }),
        { code: "SESSION_STATS_LOG_TOO_LARGE" });
    assert.equal(f.listeners.size, 0);
});

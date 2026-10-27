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

function stream(emit, transferId) {
    let sequence = 0;
    return (kind, tokens) => emit({ marker: "codex-host-chunked-message-v1", transferId,
        sequence: sequence++, kind, ...(tokens ? { tokens } : {}) });
}

function responsePrefix(envelope) {
    return [
        { type: "object-start" }, { type: "key", value: "type" }, { type: "value", value: "mcp-response" },
        { type: "key", value: "hostId" }, { type: "value", value: envelope.hostId },
        { type: "key", value: "message" }, { type: "object-start" },
        { type: "key", value: "id" }, { type: "value", value: envelope.request.id },
        { type: "key", value: "result" }, { type: "object-start" },
    ];
}

const responseEnd = [{ type: "container-end" }, { type: "container-end" }, { type: "container-end" }];

test("a foreign start cannot replace an unidentified response stream", async t => {
    const f = fixture(t, (envelope, emit) => {
        const own = stream(emit, "own"), foreign = stream(emit, "foreign");
        const prefix = responsePrefix(envelope);
        own("start");
        own("chunk", prefix.slice(0, 2));
        foreign("start");
        foreign("chunk", [{ type: "object-start" }, { type: "key", value: "hostId" },
            { type: "value", value: "another-host" }]);
        own("chunk", [...prefix.slice(2), { type: "key", value: "found" },
            { type: "value", value: true }, ...responseEnd]);
        own("end");
    });
    const result = await f.transport.request(f.frame, "host", "fs/getMetadata", { path: "/remote" });
    assert.equal(result.found, true);
    assert.equal(f.listeners.size, 0);
});

test("concurrent page listeners retain their own interleaved payloads", async t => {
    const requests = [];
    const f = fixture(t, (envelope, emit, win) => {
        requests.push(envelope);
        if (requests.length !== 2) return;
        win.electronBridge.acknowledgeChunkedMessage = () => assert.fail("the app owns ACKs");
        const a = stream(emit, "a"), b = stream(emit, "b");
        a("start");
        a("chunk", [...responsePrefix(requests[0]), { type: "key", value: "value" },
            { type: "string-start", target: "value" }, { type: "string-chunk", value: "first" }]);
        b("start");
        b("chunk", responsePrefix(requests[1]).slice(0, 2));
        a("chunk", [{ type: "string-chunk", value: " result" }, { type: "string-end" }, ...responseEnd]);
        b("chunk", [...responsePrefix(requests[1]).slice(2), { type: "key", value: "value" },
            { type: "value", value: "second result" }, ...responseEnd]);
        b("end");
        a("end");
    });
    const results = await Promise.all([
        f.transport.request(f.frame, "host", "fs/getMetadata", { path: "/remote/a" }),
        f.transport.request(f.frame, "host", "fs/getMetadata", { path: "/remote/b" }),
    ]);
    assert.deepEqual(results.map(result => result.value), ["first result", "second result"]);
    assert.equal(f.listeners.size, 0);
});

test("pending stream count is bounded and rejected starts do not replace retained streams", async t => {
    const f = fixture(t, (envelope, emit) => {
        const held = Array.from({ length: 16 }, (_, index) => stream(emit, `held-${index}`));
        for (const part of held) part("start");
        const excess = stream(emit, "excess");
        excess("start");
        excess("chunk", [...responsePrefix(envelope), { type: "key", value: "accepted" },
            { type: "value", value: "over count" }, ...responseEnd]);
        excess("end");
        for (const part of held) part("end");
        const later = stream(emit, "later");
        later("start");
        later("chunk", [...responsePrefix(envelope), { type: "key", value: "accepted" },
            { type: "value", value: "after release" }, ...responseEnd]);
        later("end");
    });
    const result = await f.transport.request(f.frame, "host", "fs/getMetadata", { path: "/remote" });
    assert.equal(result.accepted, "after release");
});

test("oversized transfer identifiers cannot bypass the retained-character limit", async t => {
    const f = fixture(t, (envelope, emit) => {
        const oversized = stream(emit, "x".repeat(2048)), own = stream(emit, "own");
        oversized("start");
        oversized("chunk", [...responsePrefix(envelope), { type: "key", value: "accepted" },
            { type: "value", value: "oversized identifier" }, ...responseEnd]);
        oversized("end");
        own("start");
        own("chunk", [...responsePrefix(envelope), { type: "key", value: "accepted" },
            { type: "value", value: "bounded identifier" }, ...responseEnd]);
        own("end");
    }, { maxChars: 1024 });
    const result = await f.transport.request(f.frame, "host", "fs/getMetadata", { path: "/remote" });
    assert.equal(result.accepted, "bounded identifier");
});

test("unidentified streams share one retained-character budget and release it after sequence rejection", async t => {
    const f = fixture(t, (envelope, emit) => {
        const held = stream(emit, "held"), excess = stream(emit, "excess"), later = stream(emit, "later");
        held("start");
        held("chunk", [{ type: "object-start" }, { type: "key", value: "padding" },
            { type: "value", value: "x".repeat(600) }]);
        excess("start");
        // Routing arrives after the payload; each transfer alone fits under the 1 KiB limit.
        const lateRouting = [
            { type: "object-start" }, { type: "key", value: "message" }, { type: "object-start" },
            { type: "key", value: "result" }, { type: "object-start" },
            { type: "key", value: "accepted" }, { type: "value", value: "over budget" },
            { type: "key", value: "padding" }, { type: "value", value: "x".repeat(400) },
            { type: "container-end" }, { type: "key", value: "id" },
            { type: "value", value: envelope.request.id }, { type: "container-end" },
            { type: "key", value: "type" }, { type: "value", value: "mcp-response" },
            { type: "key", value: "hostId" }, { type: "value", value: envelope.hostId },
            { type: "container-end" },
        ];
        excess("chunk", lateRouting);
        excess("end");
        emit({ marker: "codex-host-chunked-message-v1", transferId: "held", sequence: 4, kind: "end" });
        later("start");
        later("chunk", [...responsePrefix(envelope), { type: "key", value: "accepted" },
            { type: "value", value: "after release" }, ...responseEnd]);
        later("end");
    }, { maxChars: 1024 });
    const result = await f.transport.request(f.frame, "host", "fs/getMetadata", { path: "/remote" });
    assert.equal(result.accepted, "after release");
});

test("duplicate starts invalidate only their own stream", async t => {
    const f = fixture(t, (envelope, emit) => {
        const own = stream(emit, "own"), duplicate = stream(emit, "duplicate");
        own("start");
        own("chunk", responsePrefix(envelope));
        duplicate("start");
        emit({ marker: "codex-host-chunked-message-v1", transferId: "duplicate", sequence: 0, kind: "start" });
        duplicate("chunk", [...responsePrefix(envelope), { type: "key", value: "accepted" },
            { type: "value", value: "duplicate" }, ...responseEnd]);
        duplicate("end");
        own("chunk", [{ type: "key", value: "accepted" }, { type: "value", value: "original" }, ...responseEnd]);
        own("end");
    });
    const result = await f.transport.request(f.frame, "host", "fs/getMetadata", { path: "/remote" });
    assert.equal(result.accepted, "original");
});

test("foreign routing fields release stream slots before oversized or malformed payloads arrive", async t => {
    const f = fixture(t, (envelope, emit) => {
        for (let index = 0; index < 64; index++) {
            const foreign = stream(emit, `foreign-${index}`);
            foreign("start");
            const tokens = index % 3 === 0
                ? [{ type: "object-start" }, { type: "key", value: "type" }, { type: "value", value: "event" }]
                : index % 3 === 1
                    ? [{ type: "object-start" }, { type: "key", value: "hostId" }, { type: "value", value: "other" }]
                    : responsePrefix({ hostId: envelope.hostId, request: { id: "other" } });
            foreign("chunk", tokens);
            foreign("chunk", [{ type: "unknown" }, { type: "value", value: "A".repeat(2048) }]);
        }
        const own = stream(emit, "own");
        own("start");
        own("chunk", [...responsePrefix(envelope), { type: "key", value: "valid" },
            { type: "value", value: true }, ...responseEnd]);
        own("end");
    }, { maxChars: 1024 });
    const result = await f.transport.request(f.frame, "host", "fs/readFile", { path: "/remote/log" });
    assert.equal(result.valid, true);
    assert.equal(f.listeners.size, 0);
});

test("a matching response reclaims unidentified stream budget without rejecting a valid file", async t => {
    const f = fixture(t, (envelope, emit) => {
        const unknown = stream(emit, "unknown"), own = stream(emit, "own");
        unknown("start");
        unknown("chunk", [{ type: "object-start" }, { type: "key", value: "padding" },
            { type: "value", value: "x".repeat(600) }]);
        own("start");
        own("chunk", [...responsePrefix(envelope), { type: "key", value: "dataBase64" },
            { type: "string-start", target: "value" }, { type: "string-chunk", value: "A".repeat(400) }]);
        for (let index = 0; index < 20; index++) {
            const foreign = stream(emit, `pressure-${index}`);
            foreign("start");
            foreign("chunk", [{ type: "object-start" }, { type: "key", value: "padding" },
                { type: "value", value: "x".repeat(600) }]);
        }
        own("chunk", [{ type: "string-end" }, ...responseEnd]);
        own("end");
    }, { maxChars: 1024 });
    const result = await f.transport.request(f.frame, "host", "fs/readFile", { path: "/remote/log" });
    assert.equal(result.dataBase64, "A".repeat(400));
});

test("malformed foreign streams cannot erase a matching response and release their budget", async t => {
    const f = fixture(t, (envelope, emit) => {
        const own = stream(emit, "own");
        own("start");
        own("chunk", responsePrefix(envelope));
        for (const [index, failure] of [
            [{ type: "unknown" }],
            [{ type: "object-start" }, { type: "key", value: "unfinished" }, { type: "container-end" }],
            Array.from({ length: 65 }, () => ({ type: "object-start" })),
            [{ type: "string-start", target: "value" }, { type: "value", value: "unfinished" }],
        ].entries()) {
            const foreign = stream(emit, `bad-${index}`);
            foreign("start");
            foreign("chunk", [{ type: "object-start" }, { type: "key", value: "padding" },
                { type: "value", value: "x".repeat(200) }, ...failure]);
        }
        own("chunk", [{ type: "key", value: "dataBase64" }, { type: "value", value: "A".repeat(400) },
            ...responseEnd]);
        own("end");
    }, { maxChars: 1024 });
    const result = await f.transport.request(f.frame, "host", "fs/readFile", { path: "/remote/log" });
    assert.equal(result.dataBase64.length, 400);
});

test("the 64-container depth limit applies independently to each response stream", async t => {
    for (const levels of [61, 62]) {
        const f = fixture(t, (envelope, emit) => {
            const own = stream(emit, "nested");
            own("start");
            own("chunk", [...responsePrefix(envelope), { type: "key", value: "nested" },
                ...Array.from({ length: levels }, () => ({ type: "array-start" })),
                { type: "value", value: "leaf" },
                ...Array.from({ length: levels }, () => ({ type: "container-end" })), ...responseEnd]);
            own("end");
            emit(response(envelope, { nested: "fallback" }));
        });
        const result = await f.transport.request(f.frame, "host", "fs/getMetadata", { path: "/remote" });
        if (levels === 62) assert.equal(result.nested, "fallback");
        else {
            let nested = result.nested;
            for (let index = 0; index < levels; index++) nested = nested[0];
            assert.equal(nested, "leaf");
        }
    }
});

test("a matching stream with a broken sequence cannot win over a later complete response", async t => {
    const f = fixture(t, (envelope, emit) => {
        const own = stream(emit, "broken");
        own("start");
        own("chunk", responsePrefix(envelope));
        emit({ marker: "codex-host-chunked-message-v1", transferId: "broken", sequence: 3, kind: "chunk",
            tokens: [{ type: "key", value: "accepted" }, { type: "value", value: "partial" }, ...responseEnd] });
        emit({ marker: "codex-host-chunked-message-v1", transferId: "broken", sequence: 4, kind: "end" });
        const later = stream(emit, "later");
        later("start");
        later("chunk", [...responsePrefix(envelope), { type: "key", value: "accepted" },
            { type: "value", value: "complete" }, ...responseEnd]);
        later("end");
    });
    const result = await f.transport.request(f.frame, "host", "fs/getMetadata", { path: "/remote" });
    assert.equal(result.accepted, "complete");
});

test("concurrent incomplete streams are released on timeout, unload, and disposal", async t => {
    for (const action of ["timeout", "unload", "dispose"]) {
        const f = fixture(t, (envelope, emit) => {
            const own = stream(emit, envelope.request.id);
            own("start");
            own("chunk", responsePrefix(envelope));
            for (let index = 0; index < 16; index++) stream(emit, `unknown-${index}`)("start");
        }, { timeoutMs: 15 });
        const pending = Promise.allSettled([
            f.transport.request(f.frame, "host", "fs/getMetadata", { path: "/a" }),
            f.transport.request(f.frame, "host", "fs/getMetadata", { path: "/b" }),
        ]);
        assert.equal(f.listeners.size, 2);
        if (action === "unload") f.win.dispatchEvent(new f.win.Event("pagehide"));
        if (action === "dispose") f.transport.dispose();
        const results = await pending;
        assert.ok(results.every(result => result.status === "rejected"));
        assert.equal(f.listeners.size, 0);
    }
});

test("iframe messages cannot create streams or satisfy page requests", async t => {
    const f = fixture(t, (envelope, emit, win) => {
        const iframe = win.document.createElement("iframe");
        win.document.body.appendChild(iframe);
        for (let index = 0; index < 20; index++) {
            emit({ marker: "codex-host-chunked-message-v1", transferId: `iframe-${index}`,
                sequence: 0, kind: "start" }, iframe.contentWindow);
        }
        emit(response(envelope, { from: "iframe" }), iframe.contentWindow);
        const own = stream(emit, "own");
        own("start");
        own("chunk", [...responsePrefix(envelope), { type: "key", value: "from" },
            { type: "value", value: "native" }, ...responseEnd]);
        own("end");
    });
    const result = await f.transport.request(f.frame, "host", "fs/getMetadata", { path: "/remote" });
    assert.equal(result.from, "native");
});

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

test("native missing files keep a safe classification without exposing remote error text", async t => {
    for (const [message, expected] of [
        ["ENOENT: no such file or directory /private/account/path", "ENOENT"],
        ["The system cannot find the file specified. (os error 2)", "ENOENT"],
        ["Permission denied /private/account/path", undefined],
    ]) {
        const f = fixture(t, (envelope, emit) => emit({ type: "mcp-response", hostId: envelope.hostId,
            message: { id: envelope.request.id, error: { code: -32000, message } } }));
        await assert.rejects(f.transport.request(f.frame, "host", "fs/getMetadata", { path: "/snapshot" }), error => {
            assert.equal(error.code, expected);
            assert.doesNotMatch(error.message, /private|account|Permission denied/);
            return true;
        });
    }
});

test("serialized Electron rejection strings preserve safe missing and size classifications", async () => {
    const transport = createRemoteTransport();
    for (const [message, code] of [["Remote session stats source not found", "ENOENT"],
        ["Remote session log exceeds size limit", "SESSION_STATS_LOG_TOO_LARGE"]]) {
        const frame = { executeJavaScript: () => Promise.reject("Error: " + message + "\n    at receive (<anonymous>:1:1)") };
        await assert.rejects(transport.request(frame, "host", "fs/readFile", { path: "/snapshot" }), { code });
    }
    transport.dispose();
});

test("composed snapshot receiver reports an absent producer without remote log reads", async t => {
    const { createSnapshotRemoteStore } = require("../src/snapshot-remote-store.cjs");
    const calls = [];
    const f = fixture(t, (envelope, emit) => {
        const { method, params } = envelope.request;
        calls.push({ method, ...params });
        if (method === "thread/read") return emit(response(envelope,
            { thread: { id: demandId, path: demandRollout } }));
        assert.equal(method, "fs/getMetadata");
        if (params.path.endsWith("/.session-stats")) return emit({ type: "mcp-response", hostId: envelope.hostId,
            message: { id: envelope.request.id, error: { code: -32000, message: "ENOENT: no such file or directory" } } });
        emit(response(envelope, { isFile: false, isDirectory: true, isSymlink: false, createdAtMs: 1, modifiedAtMs: 1 }));
    });
    const receiver = createSnapshotRemoteStore();
    t.after(() => receiver.dispose());
    const sample = await receiver.getStats({ hostId: "remote-control:test", threadId: demandId },
        (method, params, options) => method === "snapshot/request"
            ? f.transport.requestSnapshot(f.frame, "remote-control:test", params.rolloutPath, demandId, options)
            : f.transport.request(f.frame, "remote-control:test", method, params, options));
    assert.equal(sample.status, "unavailable");
    assert.equal(sample.unavailableReason, "snapshot-missing");
    assert.equal(calls.some(call => call.method === "fs/readFile" || call.method === "fs/readDirectory"), false);
});

const demandId = "11111111-1111-4111-8111-111111111111";
const demandRollout = "/remote/.codex/sessions/2026/10/25/rollout-date-" + demandId + ".jsonl";
const demandPattern = new RegExp("^/remote/\\.codex/\\.session-stats/requests/" + demandId
    + "\\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.json$");

function demandFixture(t, { existing, linkedDirectory = false, onMetadata } = {}) {
    const calls = [], writes = [];
    const f = fixture(t, (envelope, emit) => {
        const { method, params } = envelope.request;
        calls.push({ method, params });
        if (method === "fs/getMetadata") {
            onMetadata?.(params.path);
            if (demandPattern.test(params.path) && existing === undefined) {
                emit({ type: "mcp-response", hostId: envelope.hostId,
                    message: { id: envelope.request.id, error: { code: -32000, message: "ENOENT: missing" } } });
                return;
            }
            const file = demandPattern.test(params.path);
            emit(response(envelope, { isFile: file, isDirectory: !file,
                isSymlink: linkedDirectory && params.path.endsWith("/requests"), createdAtMs: 1, modifiedAtMs: 1 }));
        } else if (method === "fs/readFile") {
            assert.match(params.path, demandPattern);
            emit(response(envelope, { dataBase64: Buffer.from(existing).toString("base64") }));
        } else if (method === "fs/writeFile") {
            writes.push(params); emit(response(envelope, {}));
        } else assert.fail("Unexpected demand RPC " + method);
    });
    return { ...f, calls, writes };
}

test("demand publication writes only a generated ID/time marker through a narrow capability", async t => {
    const f = demandFixture(t);
    assert.equal(typeof f.transport.requestSnapshot, "function");
    await f.transport.requestSnapshot(f.frame, "remote-control:test", demandRollout, demandId);
    assert.equal(f.writes.length, 1);
    assert.match(f.writes[0].path, demandPattern);
    const marker = JSON.parse(Buffer.from(f.writes[0].dataBase64, "base64"));
    assert.deepEqual(Object.keys(marker).sort(), ["producer", "requestedAt", "schemaVersion", "threadId"]);
    assert.equal(marker.threadId, demandId);
    assert.equal(marker.producer, "codex-session-stats-request");
    assert.ok(Math.abs(marker.requestedAt - Date.now()) < 1000);
    await f.transport.requestSnapshot(f.frame, "remote-control:test", demandRollout, demandId);
    assert.equal(f.writes.length, 2);
    assert.notEqual(f.writes[0].path, f.writes[1].path, "renewals must never overwrite an older lease");
    await assert.rejects(f.transport.request(f.frame, "remote-control:test", "fs/writeFile", f.writes[0]));
});

test("demand publication can finish when each directory-check stage must progress together", async t => {
    const waiting = [];
    let stages = 0, fileChecks = 0, writes = 0;
    const expectedDirectories = ["/remote/.codex", "/remote/.codex/.session-stats",
        "/remote/.codex/.session-stats/requests"];
    const f = fixture(t, (envelope, emit) => {
        const { method, params } = envelope.request;
        if (method === "fs/getMetadata" && !demandPattern.test(params.path)) {
            waiting.push({ envelope, emit });
            if (waiting.length === 3) {
                assert.deepEqual(waiting.map(item => item.envelope.request.params.path).sort(),
                    [...expectedDirectories].sort());
                stages++;
                for (const item of waiting.splice(0)) item.emit(response(item.envelope,
                    { isFile: false, isDirectory: true, isSymlink: false, createdAtMs: 1, modifiedAtMs: 1 }));
            }
        } else if (method === "fs/getMetadata") {
            assert.equal(stages, ++fileChecks, "file checks stay after the complete directory stage");
            emit({ type: "mcp-response", hostId: envelope.hostId,
                message: { id: envelope.request.id, error: { code: -32000, message: "ENOENT: missing" } } });
        } else {
            assert.equal(method, "fs/writeFile");
            assert.equal(stages, 2);
            assert.equal(fileChecks, 2);
            writes++;
            emit(response(envelope, {}));
        }
    });
    await f.transport.requestSnapshot(f.frame, "remote-control:test", demandRollout, demandId,
        { timeoutMs: 1000 });
    assert.equal(writes, 1);
});

test("demand publication rejects a directory replaced during its second verification stage", async t => {
    const reads = new Map();
    let writes = 0;
    const f = fixture(t, (envelope, emit) => {
        const { method, params } = envelope.request;
        if (method === "fs/getMetadata" && demandPattern.test(params.path)) {
            emit({ type: "mcp-response", hostId: envelope.hostId,
                message: { id: envelope.request.id, error: { code: -32000, message: "ENOENT: missing" } } });
        } else if (method === "fs/getMetadata") {
            const count = (reads.get(params.path) ?? 0) + 1;
            reads.set(params.path, count);
            emit(response(envelope, { isFile: false, isDirectory: true, isSymlink: false,
                createdAtMs: params.path.endsWith("/requests") && count === 2 ? 2 : 1, modifiedAtMs: 1 }));
        } else {
            writes++;
            emit(response(envelope, {}));
        }
    });
    await assert.rejects(f.transport.requestSnapshot(f.frame, "remote-control:test", demandRollout, demandId),
        /directory changed/);
    assert.equal(writes, 0);
});

test("demand publication preserves unknown destinations and linked request directories", async t => {
    for (const options of [{ existing: "user-owned notes" }, { linkedDirectory: true }]) {
        const f = demandFixture(t, options);
        assert.equal(typeof f.transport.requestSnapshot, "function");
        await assert.rejects(f.transport.requestSnapshot(f.frame, "remote-control:test", demandRollout, demandId));
        assert.equal(f.writes.length, 0);
    }
});

test("demand publication rejects invalid paths and cancellation before any write", async t => {
    const abort = new AbortController();
    const f = demandFixture(t, { onMetadata: () => abort.abort() });
    assert.equal(typeof f.transport.requestSnapshot, "function");
    await assert.rejects(f.transport.requestSnapshot(f.frame, "remote-control:test", demandRollout, demandId,
        { signal: abort.signal }));
    assert.equal(f.writes.length, 0);
    const calls = f.calls.length;
    await assert.rejects(f.transport.requestSnapshot(f.frame, "remote-control:test", "/arbitrary/file", demandId));
    await assert.rejects(f.transport.requestSnapshot(f.frame, "local", demandRollout, demandId));
    assert.equal(f.calls.length, calls);
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

test("snapshot transport does not permit remote directory traversal", async () => {
    const transport = createRemoteTransport();
    await assert.rejects(transport.request({ executeJavaScript() { assert.fail("must not execute"); } },
        "host", "fs/readDirectory", { path: "/remote/sessions" }), /unavailable/);
    transport.dispose();
});

test("default file requests allow bounded large histories with a longer read deadline", async t => {
    const requests = [];
    const f = fixture(t, (envelope, emit) => {
        requests.push(envelope);
        emit(response(envelope, {}));
    }, { timeoutMs: undefined });
    const scripts = [];
    const frame = { executeJavaScript: source => {
        scripts.push(source);
        return f.frame.executeJavaScript(source);
    } };
    await f.transport.request(frame, "host", "fs/readFile", { path: "/remote/log" });
    await f.transport.request(frame, "host", "fs/getMetadata", { path: "/remote/log" });
    assert.ok(requests[0].timeoutMs > 110000 && requests[0].timeoutMs <= 120000);
    assert.ok(requests[1].timeoutMs > 20000 && requests[1].timeoutMs <= 30000);
    assert.match(scripts[0], /"maxChars":201326592/);
    assert.match(scripts[1], /"maxChars":50331648/);
});

test("per-request snapshot limits are lower-only and do not change later raw-file defaults", async t => {
    const requests = [], scripts = [];
    const f = fixture(t, (envelope, emit) => {
        requests.push(envelope);
        emit(response(envelope, {}));
    }, { timeoutMs: undefined });
    const frame = { executeJavaScript: source => {
        scripts.push(source);
        return f.frame.executeJavaScript(source);
    } };
    await f.transport.request(frame, "host", "fs/readFile", { path: "/snapshot.json" },
        { timeoutMs: 5000, maxChars: 65536 });
    await f.transport.request(frame, "host", "fs/readFile", { path: "/rollout.jsonl" });
    await f.transport.request(frame, "host", "fs/getMetadata", { path: "/rollout.jsonl" },
        { timeoutMs: 999999, maxChars: 999999999 });
    assert.ok(requests[0].timeoutMs > 4000 && requests[0].timeoutMs <= 5000);
    assert.match(scripts[0], /"maxChars":65536/);
    assert.ok(requests[1].timeoutMs > 110000 && requests[1].timeoutMs <= 120000);
    assert.match(scripts[1], /"maxChars":201326592/);
    assert.ok(requests[2].timeoutMs > 20000 && requests[2].timeoutMs <= 30000);
    assert.match(scripts[2], /"maxChars":50331648/);
});

test("invalid per-request limits are rejected before executing page code", async () => {
    const transport = createRemoteTransport();
    let executions = 0;
    const frame = { executeJavaScript() { executions++; return Promise.reject(new Error("executed")); } };
    for (const limits of [null, [], { timeoutMs: 0 }, { timeoutMs: Infinity },
        { maxChars: -1 }, { maxChars: "65536" }]) {
        await assert.rejects(transport.request(frame, "host", "fs/readFile", {}, limits), /Invalid remote request limits/);
    }
    assert.equal(executions, 0);
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

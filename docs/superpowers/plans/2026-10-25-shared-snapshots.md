# Shared Snapshot Implementation Plan

**Goal:** Replace multi-minute remote original-log downloads with small shared statistic snapshots.
**Architecture:** The runner's existing local parser publishes authoritative snapshots. The receiver reads only those snapshots; bounded demand markers activate older sessions. No remote raw-log fallback.
**Spec:** ../specs/2026-10-25-shared-snapshots-design.md
**Stack:** CommonJS, Node filesystem APIs, node:test/jsdom, existing native RC file RPCs; no dependencies.

## Interfaces and ownership

1. Protocol: `src/snapshot.cjs` and its tests. `createSnapshotProtocol()` provides UUID/path validation, projected metrics, make/parse/toStats functions, 16 KiB snapshot and 1 KiB request bounds, 30-second freshness and 5-second future allowance. Requests use immutable `<threadId>.<requestId-UUID>.json` names with four fixed body fields (schemaVersion, producer, threadId, requestedAt).
2. Publisher/discovery: new publisher, discovery and demand tests. `createSnapshotPublisher({codexHome,store,now,pollMs,heartbeatMs,publisherId,installationRoot,discover})` exposes start/getStats/refresh/dispose. Local requests receive the successfully written sample. Background scans discover eight recent IDs every15 seconds; tracked state is bounded32. Independent2-second demand pumping stays responsive while ordinary parser/discovery work is blocked. Active sample checks are every2 seconds, heartbeat10 seconds. Safe atomic publication validates directories and destinations, preserves unknown files and removes owned temporaries. Completed snapshots expire rather than being destructively removed during reload.
3. Receiver: `createSnapshotRemoteStore({now,pollMs,responseWaitMs}={})` with getStats(identity,request)/dispose. Poll at most every2 seconds, wait at most750ms, cache32 host/thread entries and32 retired publisher IDs each. Validate native rollout identity and snapshot path, size, schema, numbers, age, versions and safe directory/file types. Missing/error/expiry means unavailable + retry, never raw downloads. A separately cancelled internal snapshot/request call renews interest at most once10 seconds.
4. Primary integration: index, renderer, lifecycle/parity tests, transport and documentation. The native read allowlist is thread/read, fs/getMetadata, fs/readFile. A separate requestSnapshot capability derives the request path and body itself, creates only a new nonce marker after directory/absence checks, and never exposes generic writes. Per-call size/time hints are lower-only. Safe ENOENT classification survives the bridge without remote error-text disclosure. Hot reload chains a shared publisher-disposal barrier before new publication.

## Decisions and boundaries

- The user's final choice removes the old remote raw reader, its dedicated tests and directory traversal; initial parallel-directory work is superseded. Interleaved-transfer isolation remains necessary for concurrent snapshot RPCs.
- Statistics keep the original parser/metric formula. Actual counts are nullable nonnegative safe integers; modelActiveMs may also be fractional, matching the existing metric engine. All published values are projected to fixed fields with no transcript or source paths.
- Immutable request nonces prevent cleanup of an expired file from deleting a new renewal. Multiple valid markers for one thread extend its lease to the maximum requestedAt. Expired valid markers may be removed; unknown/malformed files remain untouched.
- Configured CODEX_HOME is resolved at runtime startup, supporting existing directory junctions; the generated directories and destinations themselves must remain safe.
- Cancellation stops subsequent RPCs. A final native request already dispatched may complete; it can only create the validated short-lived marker. Expired page dispatches still cannot send.
- Initial implementation excluded publication. The user subsequently authorized committing, pushing, publishing v0.3.0, updating the Store and verifying its live entry. No worktrees, raw-log writes or raw transcript disk caches are used.

## Validation ledger

- Baseline real RC cold poll:132.459 seconds, including61.088 seconds directory discovery,42.891 seconds initial raw-file downloads,17.259 seconds append confirmation and11.221 seconds other checks.
- [x] Protocol RED/GREEN including UTF-8 bounds, nonce paths, fractional duration and identity/time validation.
- [x] Publisher/demand RED/GREEN on real files: atomic parity, hidden and older sessions, independent pumping, leases, unsafe paths, resource bounds and cancellation.
- [x] Receiver RED/GREEN: snapshot-only retries, freshness/replay, bounds, nonblocking reads, host/thread isolation and demand cancellation.
- [x] Primary lifecycle/parity/transport tests; safe missing classification has a composed transport/receiver regression.
- [x] Independent review of receiver/transport and publisher hot-reload ordering; immutable nonce cleanup and Electron error-string fixes passed scoped rereview.
- [x] Fresh full suite259/259, tweak validation and final whitespace checks. Native preflight exposed Electron string rejections; safe missing/size error normalization now has a regression and scoped review. Preflight stopped before modifying the peer.
- [x] Actual bidirectional RC reads and old-session demand measurements; all fields match their published snapshot revision. Normal local renderer confirmed. Both runtime entrypoints restored and verified without diagnostic hooks.

### Native acceptance, 2026-10-24 18:13–18:15 UTC

- Existing snapshot, local runner to remote receiver: first result in **1643 ms**, **456 bytes**. A local watcher captured the exact publisher revision; every projected field in the remote result matched it. Private session and publisher identifiers are omitted.
- Older remote runner to local receiver: the snapshot initially did not exist. The production demand helper completed in **4692 ms**, and the first result arrived in **7778 ms**, reading **458 bytes**. Results matched the earlier full-history reference and every field in the captured published snapshot.
- Native calls used thread/read, metadata, fixed snapshot reads, and the narrow demand helper; neither direction downloaded `.jsonl` or listed remote directories. Individual metadata RPCs took about 400 ms, including parallel requests.
- A first UI-observation probe produced no successful current-thread samples and later hit an RC timeout. A fresh bounded native probe succeeded in both directions. The remote normal entrypoint was read back and matched the intended source. Its normal renderer log had no fresh footer sample during this validation window, so native result parity is verified but a new remote footer rendering is not claimed. The local normal renderer logged `source=snapshot` after diagnostics were removed.
- Final fresh verification: `npm test` **259/259 passed**, `npm run validate` passed, `git diff --check` clean. The native Windows metadata and extended-path assumptions were independently checked against the installed app and observed responses; no confirmed incompatibility remained.
- These are two real-session measurements, not latency guarantees. Existing snapshot reads and first-time publication are different paths. Final snapshots and short-lived request markers are runtime outputs, not diagnostic artifacts.

Ownership is disjoint. No repository writes during live probes: the installed development junction reloads on all repository changes.

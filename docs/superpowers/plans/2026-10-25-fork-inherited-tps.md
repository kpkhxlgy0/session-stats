# Fork Inherited TPS Implementation Plan

**Goal:** Include the history inherited at the fork point in session-average TPS and publish the same result to local and remote consumers.

**Scope:** The user chose DSH's inherited-history scope for TPS. Keep the existing Codex usage/model-active-time formula, current branch-only turns/steps/token/cache totals, and snapshot-only remote transport. `modelActiveMs` describes the full TPS denominator. Publication was excluded from the implementation request; the user subsequently authorized committing, pushing, publishing a new version, updating the Store and verifying it online. This release is v0.4.0.

**Approach:** Resolve the ancestor prefixes on the runner using the declared parent identity and exact history byte/ordinal cut. Feed inherited plus child events to one TPS accumulator so replay deduplication and matching usage/timing remain intact. Preserve the branch accumulator for other displayed metrics. Do not combine precomputed parent averages or read a parent's live tail. Keep ancestry bounded and reject ambiguous identity, cycles and invalid boundaries. If required inherited data is unavailable, do not present a child-only average as the inherited average; preserve independently valid branch counters where possible.

## Work

- [x] Reader/metric regressions first: inherited weighted average, pre-child result, appended parent tail exclusion, child continuation, nested forks, duplicate response replay, missing/invalid/ambiguous/cyclic ancestry and source limits.
- [x] Implement bounded ancestor resolution and the TPS-only accumulation in `src/session-store.cjs` (metric API changes only if necessary).
- [x] Support runner-local `.jsonl.zst` ancestor prefixes through a bounded read-only adapter, using native Zstd streams without writing decompressed transcripts. Cache/pinned decompressed data is capped at 256 MiB and 64 entries per store, compressed input at 64 MiB per decode; stop once the declared prefix is available. Prefer a plain rollout over its compressed representation, and validate file identity/version before reuse.
- [x] Exercise the real local reader -> publisher -> snapshot -> remote receiver chain with a fork fixture; assert all shared fields equal and no remote original-log reads.
- [x] Update README and TPS tooltip to explain inherited history and unchanged non-TPS counters.
- [x] Run focused checks, full tests and tweak validation; independent review. Verify a real existing fork's derived stats without exposing conversation text where available.

## Ownership

The reader worker owns `src/session-store.cjs`, `src/metrics.cjs` if required, and `test/session-fork.test.cjs` / relevant reader tests. The compressed-reader worker owns only new `src/rollout-reader.cjs` and `test/rollout-reader.test.cjs`. Its `createRolloutReader({fileSystem,maxBytes,maxCompressedBytes})` exposes `open(filename,{limit=null})` and `dispose()`; returned handles support read/stat/close. The primary owns this plan, README, renderer text and snapshot integration verification. No source edits during live runtime probes because the installed development junction reloads on repository writes.

Real metadata inspection found paginated forks with compressed parent files and inheritance cuts of roughly 93 MB and 143 MB. This makes local compressed-prefix support necessary for the requested behavior on existing sessions. Runtime without native Zstd reports inherited TPS as unknown; it must not install a decoder or fall back to a partial average.

## Verification ledger

- Reader RED/GREEN established inherited weighted TPS (`50` before / `80` expected), missing history (`10` before / unknown expected), and same-inode inherited edits (`7.5` before / `15` expected).
- The plain and Zstd local reader -> publisher -> remote receiver integration cases pass: inherited value before child output, held value during a new turn, combined weighted value, parent-tail exclusion, restart, missing ancestor and recovery. Every shared field is compared, with remote reads restricted to the snapshot file.
- Independent real-data prefix folding and the new reader agree on approximately `68.6353 TPS` instead of the old branch-only `74.3587 TPS`; the first local read took 453 ms and the cached read 1 ms in that measurement.
- Review round 1 found inherited malformed records being silently skipped and a missing read-after validation allowing a mixed-version ancestor read. Both were reproduced, fixed and independently rechecked on Node 22 and 26: malformed inheritance clears TPS, changes rebuild once, and continuing changes retain branch counters with TPS unknown.
- Node 22.23.4 compatibility testing found that its native Zstd decoder may accept truncated frames. A streaming frame-boundary completeness check is required at EOF when the requested prefix was not reached. An already satisfied prefix must still stop without examining abandoned history.
- The frame-boundary check and native context reset between concatenated frames passed scoped review on Node 22 and 26, including checksum/header truncation, skippable frames, and retaining the decoder window limit after reset. A real 93 MB prefix decoded through the Node 22 adapter has exactly the same SHA-256 and record count as independent native Node 26 decoding.
- A full Node 22.23.4 run passed 322/322 before the final cache-budget hardening. Cache entries are capped at 64 in addition to the byte budget, and short native chunks must not retain oversized backing buffers.
- Final Node 22.23.4 full suite passed **325/325**, tweak validation and whitespace checks passed. Scoped review of exact backing allocation, entry reservations, pinning, eviction and failed/closed/disposed cleanup found no remaining material issue.
- Native RC validation on both machines (Electron's Node 24.22.1) returned the same inherited TPS **68.63526576394592** for one real fork. Every field in the remote result matched the exact locally published snapshot revision. The receiving side read **458 bytes** in approximately **2102 ms**, with no original-log reads or directory traversal.
- The new runtime reader, history resolution and tooltip were synchronized to the connected peer after baseline-hash checks and read-back verification. Both temporary entrypoint hooks were restored to the normal source. The implementation phase performed no commit, push, version bump or publication; the later release request authorizes those steps separately.

# Remote History Implementation and Validation

**Goal:** Make remote continuation/fork history selection match local selection and verify session-average TPS over the same captured history.
**Spec:** ../specs/2026-10-24-remote-history-design.md
**Release:** v0.2.1, following v0.2.0.

## Completed work

- [x] Reuse `createSessionStore` through optional filesystem, path, source-discovery and record-validation adapters. Preserve local defaults and the shared history/fork boundary parser.
- [x] Discover remote history through native read-only directory APIs. Validate exact session identity, source names, archive precedence, byte/ordinal boundaries and ancestor directories.
- [x] Bound raw files to 128 MiB and history/cache to 256 MiB. Serialize whole-file transfers; batch at most eight metadata requests and drain batches on failure/cancellation.
- [x] Accept a coherent captured snapshot after a later read proves its exact prefix. Retain the original buffer and metadata cache key; refresh newly appended content on the next poll.
- [x] Preserve rejection of invalid identities, symlinks, traversal, missing/ambiguous history, resource overflows, and rewrites/truncation present in the confirmation payload.
- [x] Run full tests, tweak validation, whitespace checks, independent review, and real native RC checks. Remove diagnostic hooks and scratch files.

## Snapshot semantics

An actively logging session can change throughout a slow network transfer. Requiring its modification time to remain unchanged until delivery caused repeated unavailable results, including during a real 14-second confirmation transfer. Statistics instead describe the original captured bytes, whose exact prefix is confirmed by a second whole-file read. Changes after confirmation capture do not retroactively invalidate that historical observation. Creation identity, file type, ancestors, roots, thread identity and resource bounds remain checked.

The confirmation uses the replacement logical-history size rather than counting the latest file twice; the extra confirmation buffer is temporary. Both cold reads and completed-snapshot cache paths have budget coverage. The production transport allows only `thread/read`, `fs/getMetadata`, `fs/readFile` and `fs/readDirectory`.

## Validation evidence

- The full implementation suite passed 219/219 tests. `npm run validate` and `git diff --check` passed. Independent final scoped review passed 98 checks and reported no material findings.
- A stable real remote continuation produced 29 turns, 1,270 steps and 114.6308335349059 TPS, exactly matching the shared local reader over the same native bytes. Its historical prefix exceeded the old 32 MiB remote-file limit. The previous remote implementation saw only its latest four turns.
- During a real active conversation, the actual peer renderer produced 36 turns, 778 steps and 89.18811194390587 TPS. Local recomputation over the exact captured prefixes matched every field, including token totals, cache counters and 5,778,001 ms model activity. The latest file grew between capture and confirmation.
- After removing the peer diagnostics and reloading normal runtime code, a fresh renderer record again showed the complete conversation: 36 turns, 784 steps and 89.20084313390932 TPS. These are observed snapshots, not fixed expected values.
- The normal local entrypoint was restored; production source contains no diagnostic hooks. Temporary task files were removed, and raw conversation content was never written to diagnostic files or logs.

Equality applies to the same captured history. Active clients can show different time cuts because of remote discovery, transfer and refresh delays. The TPS formula is unchanged: sum matched output tokens across valid turns, then divide by their matched model-active seconds.

## Release authorization

The user subsequently requested committing, pushing, publishing a new version, updating the Store and verifying the live registry. This authorizes the v0.2.1 release after validation; earlier implementation-only constraints no longer prevent those requested publication steps.

Release preparation: package, lockfile, manifest and README versions agree at 0.2.1. A fresh full suite passed 219/219, tweak validation accepted the release tree, and whitespace checks passed. Independent release audit confirmed that all required runtime files and tests are included and no diagnostic hooks or private machine/session identifiers remain in public documentation.

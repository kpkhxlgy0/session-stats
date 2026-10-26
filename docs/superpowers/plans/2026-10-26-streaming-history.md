# Streaming History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restore inherited TPS for large compressed rollouts without retaining decoded history or double counting.
**Architecture:** A bounded streaming scanner feeds the existing metrics accumulator. Session-store caches file-version-bound metadata and boundary checks, and reuses accumulated statistics until a source changes.
**Tech Stack:** CommonJS, Node.js filesystem and native Zstd, node:test.
**Spec:** ../specs/2026-10-26-streaming-history-design.md

## Global Constraints

- Preserve v0.4.0 metric scope, source identity checks, response deduplication and exact history boundaries.
- Keep 64 KiB chunks, a bounded native decoding window, bounded record size and serialized decompression.
- No decoded history cache, disk spool, dependency addition, publishing or UI automation.

## Review Focus

- Concatenated/truncated Zstd frames on Node 22, including errors after an intentionally excluded tail.
- File replacement while reading or after metrics were cached must invalidate samples.
- Repeated polls and 15-second ancestry refreshes must not reread stable compressed files.
- Duplicate response IDs across parent/child/continuation must retain matched output/time pairs.
- Large logs, backpressure, cancellation and concurrent requests must keep buffering bounded.

### Task 1: Streaming reader (worker)

Files: src/rollout-reader.cjs; test/rollout-reader.test.cjs.
Interface: createRolloutReader({fileSystem}).scan(filename,{limit,onChunk}) -> {bytesRead,stat}; callback is awaited and false stops early; stat is physical. dispose cancels work.

- [x] Add and observe failing streaming/backpressure/large-input regressions.
- [x] Replace decoded cache with streaming scan, preserve frame checks and physical version validation.
- [x] Run reader tests on supported Node versions.

### Task 2: Store integration (primary)

Files: src/session-store.cjs; test/session-streaming.test.cjs; README.md.

- [x] Add failing large-history recovery coverage and preserve stable compressed history refresh checks.
- [x] Stream compressed metadata/boundaries/records; cache only small validation facts and metrics.
- [x] Keep plain file incremental reads and replace stale metric state on mutations.
- [x] Run fork, continuation, store and remote store regressions.

### Task 3: Acceptance (primary and reviewer)

- [x] Independently review failure paths and deduplication.
- [x] Run full npm test, npm run validate and git diff --check.
- [x] Compare actual target metrics with the previous independent diagnostic calculation; repeat concurrent polls.
- [x] Confirm the hot-loaded application snapshot and actual renderer produce valid TPS; document measured limits.

## Acceptance results

- Node 22.23.4 and 26.12.1: 320/320 full-suite tests, no skips. Reader tests also pass on Node 24.18.1.
- Large-history tests cover >64 MiB compressed input and >256 MiB decoded prefix; neither retains decoded history.
- Actual target TPS 96.58353992996584 matches the pre-change diagnostic reference. Counts remain 53 turns,
  1575 steps and 285657425 tokens. Ten concurrent polls plus a 15-second ancestry refresh add zero compressed reads.
- Cold read took about 2.1 seconds; sampled standalone process RSS peaked at 192 MiB and post-GC ArrayBuffers
  retained about 0.26 MiB. These are observations, not a claimed whole-process memory ceiling.
- Actual application snapshot was fresh and contained the same metrics. Feeding it to the production renderer in
  a test DOM produced `53 turns · 1575 steps · 97 tok/s` and `285.7M tok · Cache hit 98%`.
- Reviewer found no remaining material issues; additional concatenated-frame and asynchronous-consumer stress checks passed.
- A per-chunk cancellation wait initially retained promise reactions; the final reader keeps only the current wait resolver.
- Implementation acceptance completed before the separately requested v0.4.1 release. No ad hoc scratch artifacts remain.

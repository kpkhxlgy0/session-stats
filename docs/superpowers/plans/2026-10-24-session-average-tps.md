# Session-wide Average TPS Implementation Plan

**Goal:** Accumulate weighted TPS over valid measured turns without clearing on new input.
**Spec:** ../specs/2026-10-24-session-average-tps-design.md
**Architecture:** Keep the existing local/remote metrics entry point; replace each turn's cached rate with its matched output/duration sample and aggregate those pairs. Preserve history/fork selection and deduplication.
**Stack:** CommonJS and node:test; existing jsdom renderer tests.

## Task and verification
- [x] Add failing metrics tests for unequal turn durations, pending/new turns, invalid/missing samples, zero output, late updates/replay and safe aggregation.
- [x] Update src/metrics.cjs, retaining matched samples rather than combining old usage with new intervals.
- [x] Update continuation/fork expectations and add local/remote same-history equality coverage. Update src/renderer.cjs tooltip and README.md.
- [x] Run targeted tests, full npm test, npm run validate and git diff --check; independent review; verify local hot reload.

## Constraints / review focus
Do not stage, commit, push, release, introduce dependencies, alter rollout files or create worktrees. Preserve current branch-only fork accounting. Missing measurements must not contribute one side of the ratio. Pending item intervals must not prematurely enter the denominator. Delayed valid updates replace prior contributions; malformed later usage must not retain a falsely complete sample. Local/remote equality applies to the same ingested history, not different histories or refresh times.

## Ledger
- Inspected clean v0.1.7 baseline at 8432598. Current code reports the newest turn's cached TPS; both stores use createMetrics. Work uses ordinary branch codex/session-average-tps.
- RED: eight metrics/tooltip assertions failed on the previous implementation; store-focused regressions also rejected latest-turn rates. The pre-existing footer test now registers stop cleanup before assertions, so a failed assertion cannot leave its interval running.
- GREEN: 45 targeted metrics/renderer tests, 21 store/history tests, then the final full 136/136 suite passed. npm run validate and git diff --check passed.
- The user's follow-up about `~` is reflected in the tooltip: retain the last matched session mean while the active turn is awaiting a new valid sample.
- Actual current-session log comparison produced a session mean of 93.47 tok/s against the previous current-turn value of 142.98 tok/s on the same records; all non-TPS statistics agreed. These are verification samples, not fixed expected runtime values.
- Installed development junction points to this checkout. Main and renderer logs confirm hot reload and a mounted footer using the new session mean. Native remote network transport was not changed; the cross-store equality test uses real local files and mocked remote transport with identical log content.
- At implementation handoff, final independent review found no material issues; its metrics/renderer check passed 46/46. No source changes followed full-suite acceptance. Changes were left unstaged/uncommitted without a version bump, push or publication.
- Follow-up authorization: the user requested committing and pushing these changes, publishing a new version and updating the Codex++ store, with verification of the live registry. Release preparation targets v0.2.0; the earlier no-publishing constraint applied to implementation before this request.
- v0.2.0 release preparation: package, lockfile and manifest versions agree. Fresh npm test passed 136/136, npm run validate accepted the tweak, and whitespace checks passed.

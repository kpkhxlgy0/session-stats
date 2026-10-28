# Subagent panel statistics

> **For agentic workers:** Use test-driven-development for each implementation task and verification-before-completion before reporting success.

**Goal:** Show the selected subagent's five existing metrics centered at the panel bottom, following the user's updated placement request. Do not move the transcript or composer.

**Architecture:** Reuse the current single-thread statistics and snapshot pipeline. Add a presentation target for the pane content viewport and bind it only through the nearest React layout's `subagent-detail` header row. Its header element carries the selected child `conversationId` and explicit `hostId`. Do not infer the child from the main window route, the parent session, translated labels or displayed names.

**Tech stack:** CommonJS, existing Codex++ React/IPC bridge, JSDOM and Node test runner. No dependencies, core changes or snapshot schema changes.

**Scope:** Keep the individual-child scope, existing five metrics and unknown-value behavior; no context indicator, aggregation, list view or new setting. The main composer footer retains its existing layout. The subagent overlay mounts directly inside the existing positioned viewport, outside its scrolling transcript. Its anchor has zero height and absolute bottom positioning; the bar sits 2px above the bottom. Add no flex row, padding, margin or content resizing to reserve space.

## Tasks

- [x] Binding: first add failing tests in `test/subagent-binding.test.cjs` for a local/remote child header, rejection of other panels or ambiguous identity, committed React state and the isolated-world bridge. Implement `resolveSubagent(root, api)` in `src/binding.cjs`; include keyed pane viewports in `readBindings`. Never fall back to the main route.
- [x] Renderer: first add failing tests in `test/subagent-renderer.test.cjs` for independent parent and child metrics, child/host switching with late responses, bridge resolution, list return/hiding/closing and cleanup. After the placement correction, verify a centered zero-height bottom overlay without modifying viewport or transcript styles, preserving existing composer behavior.
- [x] Verification: run binding/renderer/lifecycle tests, `npm test`, and `npm run validate`. Obtain independent review. Check production hot-reload logs and existing child statistics without operating the UI; report separately if actual visual placement remains unverified.
- [x] Document the additional display surface in README and record verification. The user subsequently authorized publication to GitHub and Codex++ Store as v0.5.0.

## Review focus

- Main conversation identity must never be substituted for a missing child identity.
- Other shell viewports and the subagent list must not receive a statistics row.
- Local/remote host identity and late replies must stay scoped to the selected child.
- Repeated reconciliation, React remounts, hiding and disable must not duplicate or orphan rows.
- Mount inside the positioned pane viewport but outside scrolling transcript content; preserve layout heights, parent composer footer and current metrics formulas.

## Evidence

Read-only inspection of installed app assets: `local-conversation-subagents-panel-tab-747460fb3519.js` renders a `headerRows` entry with ID `subagent-detail`, whose content props are `conversationId`, `hostId`, `displayName`, and `onBack`. `app-shared-624e1c099f95.js` renders those rows followed by `[data-app-shell-pane-content-viewport]`. The header ID is a React value, not a DOM attribute. No raw chat content is required or retained.

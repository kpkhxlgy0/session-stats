# Subagent identity, remote RPC, and development reload fixes

User-approved scope: fix these three audited issues in that order, then validate real local and remote sessions. The implementation request initially excluded release operations. The user subsequently authorized publication of the completed fixes; the release covers Session Stats v0.4.2 and Codex++ v1.0.7.

## Decisions and constraints

- Keep the requested thread ID, rollout filename, and metadata identity checks. Recognize only evidenced native subagent ancestry instead of deleting the `session_id` check globally.
- Keep the remote request path, immutable nonce, five-second deadline, cancellation, and both verification stages. Parallelize independent directory metadata requests within each stage; do not cache completed identity proofs across I/O.
- In the separate Codex++ core checkout, ignore dependency and Git metadata directories in the development watcher across Windows/POSIX path separators. Ordinary source and manifest changes must still reload.
- Preserve snapshot format, TPS formulas, dependency versions, and compressed-history behavior. Do not change unrelated installed tweaks.
- No temporary repository copies or worktrees. Diagnostic scratch belongs in the native OS temporary directory and must be removed after validation.

## Work and acceptance

- [x] Subagent parsing: first demonstrate a failing regression using sanitized native metadata, then recognize coherent ancestry. Cover malformed IDs, contradictory parents, normal sessions, nested subagents where evidenced, and existing fork behavior. Read a real child rollout and verify the running publisher produces usable statistics.
- [x] Remote RPC: first demonstrate failure to progress while independent directory requests await each other. Parallelize each directory group while retaining the file checks and ordering between stages. Verify directory changes, symlinks, cancellation and timeout still prevent writing. Compare latency under the same simulated RTT.
- [x] Core watcher: first reproduce irrelevant reloads with an actual watched development link. Ignore only directory components that are not runtime inputs, including `.git` and `node_modules`; verify source edits still generate reload events. Build the runtime and run its tests.
- [x] Run the Session Stats full suite, core tests/build, and independent review. Resolve regressions before runtime validation.
- [x] Use the existing native RC bridge with the production reader/transport for a real remote session, and inspect the corresponding producer snapshot. Compare the exact revision and all projected metrics, not readings taken at different times. Measure request latency and confirm no raw history download occurs.
- [x] Remove diagnostic hooks and scratch, then verify normal local/remote statistics again. Record any runtime restart or remote installation limitation honestly; building the core watcher does not activate it in the already-running Electron main process.

## File ownership

Session Stats: `src/session-store.cjs`, `src/remote-transport.cjs`, relevant tests and this validation plan. Core: `packages/runtime/src/main.ts`, a small watcher path helper if needed, targeted watcher tests, and normal generated runtime assets from the build.

- [ ] After both Codex apps are fully restarted, verify the installed main-process watchers ignore Git/dependency changes while preserving normal tweak reloads.

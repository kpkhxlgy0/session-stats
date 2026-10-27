# Subagent, RC demand, and development watcher verification

## Scope and implementation

The requested fixes cover native subagent metadata, serial remote demand checks, and irrelevant development-link reloads. Implementation was based on Session Stats v0.4.1 and Codex++ v1.0.6. The subsequent user publication request authorizes the v0.4.2 tweak and v1.0.7 core releases. The restart verification boundary below remains unchanged.

- Native subagent metadata carries the root session ID separately from its immediate parent. Real first-level and nested subagents established both shapes. The parser still validates the requested rollout identity and permits different session IDs only with coherent native subagent metadata. Root IDs do not cause implicit history inheritance.
- Remote demand publication retains nine native RPCs, both directory verification stages, two file checks, cancellation and the five-second deadline. Independent directory requests in each stage are parallel, reducing serial latency from nine rounds to five.
- Core watcher filtering recognizes complete `.git` and `node_modules` path segments with Windows or POSIX separators, including directory entries. Actual source, manifest, output and other dot-directory changes remain observable.

## Regression evidence

- Three valid-subagent tests failed before the parser fix; malformed-identity and legacy cases remained rejected/accepted as appropriate. The 28 new regressions cover first-level and nested cases, case-insensitive UUIDs and invalid ancestry. The affected session suites passed 111 tests.
- The directory-stage barrier test timed out before parallelization, then passed. Directory replacement, symlink, cancellation and forbidden-write cases passed; the transport/receiver suites passed 92 tests.
- The actual Chokidar development-junction fixture initially emitted Git/dependency events. The fixed watcher passed all three regressions, including source/manifest reload events and path-boundary cases.
- Independent review reported no material findings; 151 scoped tests passed across the two repositories.
- Core build passed. Fresh core full suite: 225 tests, 218 passed, seven platform skips, zero failures. An initial attempt encountered a missing declared development dependency after updating the old checkout; reinstalling the lockfile dependencies resolved it without dependency changes.

## Real data and network results

- A real local first-level subagent, previously unavailable, returned `ok`, two turns, 11 steps and 373.1755860238832 TPS. The running publisher's snapshot contained the same TPS. A real nested subagent also returned `ok`; its single response lacked an eligible TPS sample and correctly retained an unknown TPS.
- The long local parent session remained usable and matched its producer snapshot after the fix.
- Both machines' installed Session Stats parser and transport files were updated only after their original bytes matched the release baseline. Each written file was read back and its SHA-256 matched the intended source.
- The real idle remote continuation remained at 29 turns, 1,270 steps and 114.6308335349059 TPS. Its received fields exactly matched the captured producer snapshot revision after the peer update.
- A fresh production receiver over the existing native RC connection read an active remote session in 1,792 ms: 29 turns, 1,506 steps and 57.33634223156763 TPS. Every projected field matched the exact captured publisher revision. Network calls read only fixed snapshot files, not rollout history.
- Two explicit real demand measurements completed in 2,174 ms and 2,129 ms (excluding the preceding thread-context lookup). They demonstrate request latency on this connection, not a universal guarantee.
- With a simulated 700 ms RTT, the old sequential path timed out at roughly five seconds before writing. The fixed path completed all nine calls and one request write in 3,555 ms.
- Native receiver probes verify the data path. A new remote-window visual rendering was not observed through UI automation.

## Activation boundary

The rebuilt core main bundle and source map were hash-verified into both installed runtimes and their installation sources. Both core runtimes still require a complete Codex restart to recreate the watcher. The actual-junction regression proves its filesystem behavior; suppression by the already-running applications cannot be claimed before that restart.

Final Session Stats full suite passed 350/350 tests after the diagnostic hook was removed. Tweak validation and whitespace checks passed. The normal entrypoint was restored byte-for-byte. At 17:49:02 UTC, the normal renderer logged a remote snapshot footer with 29 turns, 1,506 steps and 57.33634223156763 TPS, after the 17:48:51 UTC normal-runtime reload. The local main session and its current published snapshot also remained usable. No peer entrypoint hook was installed. Diagnostic scratch was removed after verification; only normal runtime snapshots and short-lived demand markers remain.

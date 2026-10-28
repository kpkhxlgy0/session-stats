# Subagent panel statistics validation

## Scope

Show the selected subagent's existing statistics centered 2px above the pane bottom. The user replaced the initial below-header placement after observing its layout shift. The current anchor is absolute and zero-height within the existing positioned viewport, with no padding or height changes to the transcript/composer. No aggregation, context metric, statistical formula, snapshot schema or Codex++ core change.

## Evidence

- Installed app static assets confirm the shell viewport attribute, nearest `headerRows` layout and `subagent-detail` header element's explicit child conversation and host props.
- Test-first renderer verification: five new display/lifecycle tests failed before implementation because no panel row existed; the interactive-child test additionally reproduced the duplicate-footer behavior.
- Placement correction: updated regression expectations failed against the original header row, then the corrected panel and composer renderer tests passed 20/20. They verify an absolute zero-height bottom overlay, no extra header row, untouched viewport/transcript inline styles, no duplicate child composer footer, and switching/remount cleanup.
- Test-first binding verification: nine new cases failed before implementation, with the existing composer binding cases passing. The final combined binding tests pass 21/21.
- `node --test test/binding.test.cjs test/subagent-binding.test.cjs test/renderer.test.cjs test/subagent-renderer.test.cjs test/lifecycle.test.cjs`: 43/43 pass.
- `npm test`: 367/367 pass, zero failures or skips, Node.js 26.12.1 on Windows.
- `npm run validate`: valid Codex++ tweak.
- `git diff --check`: no whitespace errors.
- Independent read-only review: no material findings; reviewer also checked the installed shell's header/viewport nesting.
- Running Codex++ logs confirm source hot reload, renderer startup and successful parent footer statistics after both placements. Selected-child panel readiness was observed before the placement correction, including two independently selected children with valid TPS (about 57 and 81 tok/s). Parsing, binding and publication are unchanged in the bottom-placement follow-up.

## Limits

No Windows UI automation was performed. Actual bottom-overlay pixels and real remote-child panel presentation have not been visually verified. DOM mounting, switching, host isolation, bottom positioning without layout reservation, hiding, remounts, list return, cleanup and composer duplication are covered by static-source evidence and JSDOM tests. Runtime logs confirm selected-child data binding; they are not visual layout proof.

No ad-hoc scratch artifacts were created during implementation. The user subsequently authorized publishing the verified change as v0.5.0 to GitHub and the Codex++ Store.

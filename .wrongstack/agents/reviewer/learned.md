# Learned instructions for `reviewer`

> Project-specific learning data for the `reviewer` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to avoid

<!-- learned-stamp: category=warning; capturedAt=2026-11-11T09:56:48.040Z; skill=code-review; applied=6; wins=6; skipped=62; skippedWins=62 -->
- **Always confirm an Ink-wide error boundary keeps the process exit-reachable when reviewing `packages/tui/src/run-tui.ts`: the raw-stdin Ctrl+C watcher armed in `mountInkApp` and `exits.setInkInstance` run below React, so `AppErrorBoundary` (`packages/tui/src/components/app-error-boundary.tsx`) must not be judged as trapping the session — and verify the `appElement: React.ReactElement` contract in `packages/tui/src/run-tui-mount.ts` plus every consumer of a renamed element in the same diff.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `packages/tui/src/run-tui.ts`
  - *How:* `mountInkApp`
  - *How:* `exits.setInkInstance`
  - *How:* `AppErrorBoundary`
  - *How:* `packages/tui/src/components/app-error-boundary.tsx`
  - *How:* `appElement: React.ReactElement`
  - *How:* `packages/tui/src/run-tui-mount.ts`

## What to do

<!-- learned-stamp: category=convention; capturedAt=2026-11-11T14:15:36.559Z; skill=security-scanner; skipped=2; skippedWins=2 -->
- **Always check that an integrity/TOFU digest fails **closed**: in `packages/core/src/plugin/trust.ts`, a `continue` on oversize or read error drops the file from the manifest, so tampering stays undetected and an entirely skipped entry hashes the empty string into one shared constant digest — require a throw or a sentinel entry per skip. When a diff adds an optional parameter to a pin/hash function, `rg 'hashPluginDirectoryClosure(\|hashPluginClosure('` and confirm the pin site and every verify/load site pass identical arguments; an arg-dependent digest for the same file silently breaks verification across access shapes.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `packages/core/src/plugin/trust.ts`
  - *How:* `continue`
  - *How:* `rg 'hashPluginDirectoryClosure(\|hashPluginClosure('`

<!-- learned-stamp: category=convention; capturedAt=2026-11-11T10:57:52.095Z; applied=1; wins=1; skipped=46; skippedWins=46 -->
- **Always inspect modified JSDoc hunks in `packages/contracts/src/types/**` (e.g. `session-storage.ts` `SessionWriter`) for a newly nested `/**` opener inside an already-open comment block — the first `*/` closes the outer block, so the diff compiles while silently detaching documentation from the member below; verify the opener/closer pairing by reading the surrounding lines, not the diff hunk alone.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `packages/contracts/src/types/**`
  - *How:* `session-storage.ts`
  - *How:* `SessionWriter`
  - *How:* `/**`
  - *How:* `*/`

<!-- learned-stamp: category=convention; capturedAt=2026-11-11T10:07:46.751Z; skill=chimera; skipped=62; skippedWins=62 -->
- **Always re-read the changed hunk with a narrow `read` offset before citing a line in `packages/webui-server/src/server/**` (or any file the Chronicle shows as concurrently agent-edited) and trust that offset-read's numbering — a whole-file `read` snapshot can lag the disk version (e.g. 371 vs 375 lines), shifting every citation by the omitted lines and costing the finding at verification time.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `read`
  - *How:* `packages/webui-server/src/server/**`

<!-- learned-stamp: category=convention; capturedAt=2026-11-09T01:11:07.725Z; applied=5; wins=5; skipped=93; skippedWins=93 -->
- **Always treat a corrupt-log recovery path as incomplete unless every failure shape reaches it: in `packages/coordination/src/file-author-tracker.ts` the `loadLog` shape check silently returned an empty log for valid-JSON-but-invalid-shape content (`{}`, `{"entries":"x"}`) and threw a `TypeError` (not `SyntaxError`) for `null`, so a `catch (err) { if (!(err instanceof SyntaxError)) throw err }` guard covers only `JSON.parse` failures — back up on a dedicated corrupt-log error type covering parse, non-object, and invalid-`entries` shapes, and add a test for the backup-write failure path (not just the read failure) proving the original bytes remain intact.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `packages/coordination/src/file-author-tracker.ts`
  - *How:* `loadLog`
  - *How:* `{}`
  - *How:* `{"entries":"x"}`
  - *How:* `TypeError`
  - *How:* `SyntaxError`
  - *How:* `null`
  - *How:* `catch (err) { if (!(err instanceof SyntaxError)) throw err }`
  - *How:* `JSON.parse`
  - *How:* `entries`

<!-- learned-stamp: category=convention; capturedAt=2026-11-11T10:23:04.759Z; applied=7; wins=7; skipped=49; skippedWins=49 -->
- **Always verify that terminal-mode setup writes and the synchronized-output teardown bytes travel through the **same** stream object in `packages/tui/src/run-tui.ts` / `packages/tui/src/run-tui-exits.ts` — a sync-`stdout` Proxy only intercepts writes made through the Proxy, so raw `stdout.write(...)` calls split the BSU/ESU framing and the `WRONGSTACK_TUI_TRACE=1` capture no longer matches the terminal's byte stream. Always dispose a synchronized-output wrapper **after** emitting the closing `SYNC_OUTPUT_OFF`, or have `dispose()` emit that ESU itself — writing the ESU to the underlying stream in a separate `cleanup()` step leaves the teardown sequence split across two write paths in `packages/tui/src/sync-stdout.ts` / `packages/tui/src/run-tui-exits.ts`.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `packages/tui/src/run-tui.ts`
  - *How:* `packages/tui/src/run-tui-exits.ts`
  - *How:* `stdout`
  - *How:* `stdout.write(...)`
  - *How:* `WRONGSTACK_TUI_TRACE=1`
  - *How:* `SYNC_OUTPUT_OFF`
  - *How:* `dispose()`
  - *How:* `cleanup()`
  - *How:* `packages/tui/src/sync-stdout.ts`

<!-- learned-stamp: category=convention; capturedAt=2026-11-11T12:45:23.112Z; skill=chimera; skipped=14; skippedWins=14 -->
- **When a `packages/tui/**` diff resolves a late-bound host field inline in the render body via `typeof host.X === 'function' ? host.X() : host.X` and passes it as a prop feeding a `useCallback`/`useEffect` dependency, always confirm the accessor memoizes — a per-render instance re-fires the async effect on every Ink repaint; report the precondition instead of asserting the loop. Before crediting a TUI overlay's async success message, check whether the helper it awaits swallows its own error into shared state that the caller then overwrites; a `setStatusMessage(...)` after `await refresh()` silently discards the reload failure and leaves the UI showing stale data as confirmed.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `packages/tui/**`
  - *How:* `typeof host.X === 'function' ? host.X() : host.X`
  - *How:* `useCallback`
  - *How:* `useEffect`
  - *How:* `setStatusMessage(...)`
  - *How:* `await refresh()`

<!-- learned-stamp: category=convention; capturedAt=2026-11-09T01:20:11.128Z; skipped=95; skippedWins=95 -->
- **When a corrupt-data recovery path in `packages/coordination/src/file-author-tracker.ts` validates JSON shape, remember that `!parsed ||` must short-circuit before any `parsed.entries` dereference, and that `mutateLog` must catch only `SyntaxError` so EISDIR/EPERM read failures still propagate — and always add a test that a *read* accessor (`getFullLog`) rejects against a still-corrupt file, since read paths call `loadLog` directly and now inherit the throw that the write path recovers from.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `packages/coordination/src/file-author-tracker.ts`
  - *How:* `!parsed ||`
  - *How:* `parsed.entries`
  - *How:* `mutateLog`
  - *How:* `SyntaxError`
  - *How:* `getFullLog`
  - *How:* `loadLog`

<!-- learned-stamp: category=convention; capturedAt=2026-11-06T16:16:26.804Z; skill=testing; skipped=110; skippedWins=110 -->
- **When a CSS diff narrows a rule with `:is(A, B)`, compute the new specificity explicitly — `:is()` adopts the specificity of its most specific argument, so `:is(.modal, .model-catalog-settings) .model-draft-notice p` (0,2,1) still outranks the removed generic `.model-draft-notice p` (0,1,1) even though the selector text looks narrower. Always verify the narrowed selector still matches every render site by grepping the component's root `className` ancestor before accepting the narrowing, since the diff alone does not prove coverage.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `:is(A, B)`
  - *How:* `:is()`
  - *How:* `:is(.modal, .model-catalog-settings) .model-draft-notice p`
  - *How:* `.model-draft-notice p`
  - *How:* `className`

<!-- learned-stamp: category=convention; capturedAt=2026-11-09T01:11:07.725Z; skill=testing; applied=3; wins=3; skipped=95; skippedWins=95 -->
- **When a task requires "I/O errors still reject", a test that only forces the *read* to fail does not cover the new write-side failure surface: in `packages/coordination/tests/file-author-tracker.test.ts` the EISDIR test exercises `fs.readFile`, while the new `fs.copyFile` backup path can fail independently — mock `fs.copyFile` to reject and assert both that the promise rejects with that error and that the original corrupt file still holds its original bytes.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `packages/coordination/tests/file-author-tracker.test.ts`
  - *How:* `fs.readFile`
  - *How:* `fs.copyFile`

---
*Last capture: 2026-11-11T14:15:36.559Z · 10 entries*

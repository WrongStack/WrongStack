# Learned instructions for `reviewer`

> Project-specific learning data for the `reviewer` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to do

<!-- learned-stamp: category=convention; capturedAt=2026-11-09T01:11:07.725Z; applied=3; wins=3; skipped=4; skippedWins=4 -->
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

<!-- learned-stamp: category=convention; capturedAt=2026-11-09T01:20:11.128Z; skipped=4; skippedWins=4 -->
- **When a corrupt-data recovery path in `packages/coordination/src/file-author-tracker.ts` validates JSON shape, remember that `!parsed ||` must short-circuit before any `parsed.entries` dereference, and that `mutateLog` must catch only `SyntaxError` so EISDIR/EPERM read failures still propagate — and always add a test that a *read* accessor (`getFullLog`) rejects against a still-corrupt file, since read paths call `loadLog` directly and now inherit the throw that the write path recovers from.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `packages/coordination/src/file-author-tracker.ts`
  - *How:* `!parsed ||`
  - *How:* `parsed.entries`
  - *How:* `mutateLog`
  - *How:* `SyntaxError`
  - *How:* `getFullLog`
  - *How:* `loadLog`

<!-- learned-stamp: category=convention; capturedAt=2026-11-06T16:16:26.804Z; skill=testing; skipped=19; skippedWins=19 -->
- **When a CSS diff narrows a rule with `:is(A, B)`, compute the new specificity explicitly — `:is()` adopts the specificity of its most specific argument, so `:is(.modal, .model-catalog-settings) .model-draft-notice p` (0,2,1) still outranks the removed generic `.model-draft-notice p` (0,1,1) even though the selector text looks narrower. Always verify the narrowed selector still matches every render site by grepping the component's root `className` ancestor before accepting the narrowing, since the diff alone does not prove coverage.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `:is(A, B)`
  - *How:* `:is()`
  - *How:* `:is(.modal, .model-catalog-settings) .model-draft-notice p`
  - *How:* `.model-draft-notice p`
  - *How:* `className`

<!-- learned-stamp: category=convention; capturedAt=2026-11-09T01:11:07.725Z; skill=testing; applied=3; wins=3; skipped=4; skippedWins=4 -->
- **When a task requires "I/O errors still reject", a test that only forces the *read* to fail does not cover the new write-side failure surface: in `packages/coordination/tests/file-author-tracker.test.ts` the EISDIR test exercises `fs.readFile`, while the new `fs.copyFile` backup path can fail independently — mock `fs.copyFile` to reject and assert both that the promise rejects with that error and that the original corrupt file still holds its original bytes.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `packages/coordination/tests/file-author-tracker.test.ts`
  - *How:* `fs.readFile`
  - *How:* `fs.copyFile`

---
*Last capture: 2026-11-09T01:20:11.128Z · 4 entries*

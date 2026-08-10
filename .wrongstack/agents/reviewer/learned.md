# Learned instructions for `reviewer`

> Project-specific learning data for the `reviewer` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to avoid

<!-- learned-stamp: category=warning; capturedAt=2026-08-09T21:57:57.955Z -->
- **When a refactor extracts a SQL CTE body into a `(seedSource: string) => string` template builder and delegates execution to a named helper (e.g. `runCteWithSeeds`), grep for the helper's *definition* — not just its call sites — before accepting the change. A diff can introduce a call to a helper that was planned but never written (whole-tree definition count = 0), which typecheck catches as "Cannot find name" and runtime catches as `ReferenceError`.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `(seedSource: string) => string`
  - *How:* `runCteWithSeeds`
  - *How:* `ReferenceError`

## What to do

<!-- learned-stamp: category=convention; capturedAt=2026-08-09T22:04:35.121Z; skill=chimera -->
- **When a diff adds a query-discriminating parameter (e.g. `transitive`, `depth`, `mode`) to an op-args interface in `packages/tools/src/codebase-index/worker-protocol.ts`, always grep `packages/tools/src/codebase-index/project-server.ts` for the matching `cacheKey = JSON.stringify([...])` construction and verify the new field is part of the key. Cached read handlers key on a hand-listed subset of args, so a new discriminator that is not added silently serves one mode's results for the other mode's request.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `transitive`
  - *How:* `depth`
  - *How:* `mode`
  - *How:* `packages/tools/src/codebase-index/worker-protocol.ts`
  - *How:* `packages/tools/src/codebase-index/project-server.ts`
  - *How:* `cacheKey = JSON.stringify([...])`

<!-- learned-stamp: category=convention; capturedAt=2026-08-09T21:26:29.204Z -->
- **When adding binary/protocol-mode state fields to a socket connection class in `packages/tools/src/codebase-index/project-server-client.ts`, reset them in **both** `connectOnce()` and `close()`. The connection object is reused across reconnects (`ensureConnected` early-returns on a live socket, `connectWithElection` loops `connectOnce` on stale servers), so any unreset mode flag like `useBinary` leaks into the next handshake and routes JSON frames through the binary parser. Grep for every new mutable field against both lifecycle paths before reporting the change complete.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `packages/tools/src/codebase-index/project-server-client.ts`
  - *How:* `connectOnce()`
  - *How:* `close()`
  - *How:* `ensureConnected`
  - *How:* `connectWithElection`
  - *How:* `connectOnce`
  - *How:* `useBinary`

## Patterns to follow

<!-- learned-stamp: category=pattern; capturedAt=2026-08-09T21:30:56.243Z -->
- **Always re-check `timeoutMs` on every tool in a package when one tool in that package adopts a deferred `await otherTool.execute(..., { signal: AbortSignal.timeout(N) })` pattern. The deferred work runs on a signal whose lifetime is independent of the caller's declared `timeoutMs`, and the executor (`packages/core/src/execution/tool-executor.ts`, `clampTimeoutMs`) aborts the *caller's* signal at `tool.timeoutMs` — so a caller with a shorter `timeoutMs` than the spawned operation reports failure while spawned writes continue.**
  - *Why:* This project's chosen approach — alternatives were considered and either conflict with existing architecture or were rejected for known reasons.
  - *How:* `timeoutMs`
  - *How:* `await otherTool.execute(..., { signal: AbortSignal.timeout(N) })`
  - *How:* `packages/core/src/execution/tool-executor.ts`
  - *How:* `clampTimeoutMs`
  - *How:* `tool.timeoutMs`

<!-- learned-stamp: category=pattern; capturedAt=2026-08-09T22:01:36.936Z; skill=chimera -->
- **When a diff extracts a SQL recursive-CTE body into a `(seedSource: string) => string` template builder and delegates execution to a shared helper (e.g. `runCteWithSeeds`), validate the helper against the **canonical pre-existing temp-table pattern in the same file** rather than the new code alone.**
  - *Why:* This project's chosen approach — alternatives were considered and either conflict with existing architecture or were rejected for known reasons.
  - *How:* `(seedSource: string) => string`
  - *How:* `runCteWithSeeds`

<!-- learned-stamp: category=pattern; capturedAt=2026-08-09T22:04:35.121Z; skill=chimera -->
- **When reviewing a change to a service function's return type in `packages/tools/src/codebase-index/index-service.ts`, always read the full body of each consuming tool file and match the destructuring pattern against the declared result interface field-by-field. A destructure of a non-existent property plus a later reference to the correct-but-unbound name (e.g. destructuring `ambiguous` from `OutgoingCallsResult` while using `unresolvedCount` below) passes visual diff review but fails `tsc` and throws `ReferenceError` on the happy path.**
  - *Why:* This project's chosen approach — alternatives were considered and either conflict with existing architecture or were rejected for known reasons.
  - *How:* `packages/tools/src/codebase-index/index-service.ts`
  - *How:* `ambiguous`
  - *How:* `OutgoingCallsResult`
  - *How:* `unresolvedCount`
  - *How:* `tsc`
  - *How:* `ReferenceError`

---
*Last capture: 2026-08-09T22:04:35.121Z · 6 entries*

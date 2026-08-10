# Learned instructions for `reviewer`

> Project-specific learning data for the `reviewer` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to avoid

<!-- learned-stamp: category=warning; capturedAt=2026-08-10T19:41:24.805Z; applied=5; wins=5 -->
- **Always verify a comment's test claim by searching for the named test file before trusting it as a drift guard. When a diff duplicates a canonical constant across packages (e.g. `BOARD_SOFT_MAX_BYTES` mirrored in `packages/tui`, `packages/webui`, and `packages/kanban/src/storage.ts`), grep the whole repo for the symbol and for `*.test.*` matches — a comment saying "`X.test.ts` pins both copies" is unverified until the test file is found, and an absent pin is the classic declared-but-not-enforced drift hazard.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `BOARD_SOFT_MAX_BYTES`
  - *How:* `packages/tui`
  - *How:* `packages/webui`
  - *How:* `packages/kanban/src/storage.ts`
  - *How:* `*.test.*`
  - *How:* `X.test.ts`

<!-- learned-stamp: category=warning; capturedAt=2026-08-09T21:57:57.955Z; applied=1; wins=1 -->
- **When a refactor extracts a SQL CTE body into a `(seedSource: string) => string` template builder and delegates execution to a named helper (e.g. `runCteWithSeeds`), grep for the helper's *definition* — not just its call sites — before accepting the change. A diff can introduce a call to a helper that was planned but never written (whole-tree definition count = 0), which typecheck catches as "Cannot find name" and runtime catches as `ReferenceError`.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `(seedSource: string) => string`
  - *How:* `runCteWithSeeds`
  - *How:* `ReferenceError`

## What to do

<!-- learned-stamp: category=convention; capturedAt=2026-08-10T15:08:45.843Z; skill=chimera -->
- **Always distinguish a type re-export from a local type import in TypeScript modules such as `packages/cli/src/boot/system-prompt-builder.ts`; `export type { X } from './module.js'` does not make `X` available for declarations in the re-exporting module. Key takeaway: both changes break direct contracts—the CLI change fails type resolution, while the TUI change risks duplicate native-scrollback output through deferred commit bookkeeping.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `packages/cli/src/boot/system-prompt-builder.ts`
  - *How:* `export type { X } from './module.js'`
  - *How:* `X`
  - *How:* `./module.js`

<!-- learned-stamp: category=convention; capturedAt=2026-08-10T19:15:26.058Z; skill=chimera -->
- **Always verify dead-code removal of a discriminator-field branch by grepping for all emitters of that field with the matching issue code across the whole package, not just the emitter named in the diff comment. A branch can look unreachable after one named source is updated, yet still be reachable from a second emitter (e.g. a sibling validation file or the queue classifier) that the comment did not mention.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.

<!-- learned-stamp: category=convention; capturedAt=2026-08-09T22:04:35.121Z; skill=chimera -->
- **When a diff adds a query-discriminating parameter (e.g. `transitive`, `depth`, `mode`) to an op-args interface in `packages/tools/src/codebase-index/worker-protocol.ts`, always grep `packages/tools/src/codebase-index/project-server.ts` for the matching `cacheKey = JSON.stringify([...])` construction and verify the new field is part of the key. Cached read handlers key on a hand-listed subset of args, so a new discriminator that is not added silently serves one mode's results for the other mode's request.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `transitive`
  - *How:* `depth`
  - *How:* `mode`
  - *How:* `packages/tools/src/codebase-index/worker-protocol.ts`
  - *How:* `packages/tools/src/codebase-index/project-server.ts`
  - *How:* `cacheKey = JSON.stringify([...])`

<!-- learned-stamp: category=convention; capturedAt=2026-08-10T19:58:34.866Z; skill=bug-hunter; applied=4; wins=4 -->
- **When a sender pre-validates a payload against a receiver's reject threshold, verify byte-measurement equivalence *and* boundary-direction consistency: confirm the sender measures the exact same sub-object the receiver's validator measures (e.g. `record.board` vs the whole `record`), and that the comparison operators align at the boundary (`>` skip on one side must pair with `<=` accept on the other) — a mismatch here is the classic "sender thinks it's under the limit, receiver drops it" silent-loss bug in `packages/core/src/hq/protocol/kanban.ts` and `packages/cli/src/kanban-hq-sync.ts`.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `record.board`
  - *How:* `record`
  - *How:* `>`
  - *How:* `<=`
  - *How:* `packages/core/src/hq/protocol/kanban.ts`
  - *How:* `packages/cli/src/kanban-hq-sync.ts`

<!-- learned-stamp: category=convention; capturedAt=2026-08-09T21:26:29.204Z; applied=1; wins=1 -->
- **When adding binary/protocol-mode state fields to a socket connection class in `packages/tools/src/codebase-index/project-server-client.ts`, reset them in **both** `connectOnce()` and `close()`. The connection object is reused across reconnects (`ensureConnected` early-returns on a live socket, `connectWithElection` loops `connectOnce` on stale servers), so any unreset mode flag like `useBinary` leaks into the next handshake and routes JSON frames through the binary parser. Grep for every new mutable field against both lifecycle paths before reporting the change complete.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `packages/tools/src/codebase-index/project-server-client.ts`
  - *How:* `connectOnce()`
  - *How:* `close()`
  - *How:* `ensureConnected`
  - *How:* `connectWithElection`
  - *How:* `connectOnce`
  - *How:* `useBinary`

<!-- learned-stamp: category=convention; capturedAt=2026-08-10T21:24:04.188Z; skill=testing -->
- **When validating a multi-predicate *parity* test (e.g. `classifyTaskForQueue` bucket vs `evaluateContractGraphReadiness` ready-vs `validateManagedTaskTransition` issues in `packages/kanban`), prove it is non-vacuous by tracing at least one corpus entry that resolves **ready=true** and one that resolves **ready=false** across *all* predicates — a corpus where every entry agrees on a single outcome cannot catch divergence.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `classifyTaskForQueue`
  - *How:* `evaluateContractGraphReadiness`
  - *How:* `validateManagedTaskTransition`
  - *How:* `packages/kanban`

---
*Last capture: 2026-08-10T21:24:04.188Z · 8 entries*

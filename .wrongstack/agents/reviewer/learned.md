# Learned instructions for `reviewer`

> Project-specific learning data for the `reviewer` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to avoid

<!-- learned-stamp: category=warning; capturedAt=2026-08-10T19:41:24.805Z; applied=31; wins=31 -->
- **Always verify a comment's test claim by searching for the named test file before trusting it as a drift guard. When a diff duplicates a canonical constant across packages (e.g. `BOARD_SOFT_MAX_BYTES` mirrored in `packages/tui`, `packages/webui`, and `packages/kanban/src/storage.ts`), grep the whole repo for the symbol and for `*.test.*` matches — a comment saying "`X.test.ts` pins both copies" is unverified until the test file is found, and an absent pin is the classic declared-but-not-enforced drift hazard.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `BOARD_SOFT_MAX_BYTES`
  - *How:* `packages/tui`
  - *How:* `packages/webui`
  - *How:* `packages/kanban/src/storage.ts`
  - *How:* `*.test.*`
  - *How:* `X.test.ts`

<!-- learned-stamp: category=warning; capturedAt=2026-08-09T21:57:57.955Z; applied=3; wins=3 -->
- **When a refactor extracts a SQL CTE body into a `(seedSource: string) => string` template builder and delegates execution to a named helper (e.g. `runCteWithSeeds`), grep for the helper's *definition* — not just its call sites — before accepting the change. A diff can introduce a call to a helper that was planned but never written (whole-tree definition count = 0), which typecheck catches as "Cannot find name" and runtime catches as `ReferenceError`.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `(seedSource: string) => string`
  - *How:* `runCteWithSeeds`
  - *How:* `ReferenceError`

<!-- learned-stamp: category=warning; capturedAt=2026-08-11T15:48:37.933Z; skill=chimera -->
- **When reviewing a generated ratchet baseline such as `architecture/hotspots.json`, do not judge a metric field by a naive grep — read the generator first (`collectModuleSpecifiers` in `scripts/lib/architecture-health.mjs`) to learn every form it counts. `relativeImports` includes static `from './x'`, bare side-effect `import './x.css'`, dynamic `import('./x')`, `require()`, and `import x = require()`, so a file whose static imports number 6 can legitimately record 20.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `architecture/hotspots.json`
  - *How:* `collectModuleSpecifiers`
  - *How:* `scripts/lib/architecture-health.mjs`
  - *How:* `relativeImports`
  - *How:* `from './x'`
  - *How:* `import './x.css'`
  - *How:* `import('./x')`
  - *How:* `require()`
  - *How:* `import x = require()`

## What to do

<!-- learned-stamp: category=convention; capturedAt=2026-08-11T05:05:03.180Z; skill=testing; applied=25; wins=23 -->
- **Always verify a "default/fallback value" test is *discriminating*: when the system under test returns a bounded slice, supply more candidates than the default cap so the assertion count equals the cap (not the candidate count). A test whose expected length is smaller than the default cap cannot distinguish "the default was applied" from "no cap applied at all" — it passes even when the fallback-to-constant branch is broken (e.g. returns `undefined` → `Number.isFinite` false → no slicing).**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `undefined`
  - *How:* `Number.isFinite`

<!-- learned-stamp: category=convention; capturedAt=2026-08-10T19:58:34.866Z; skill=bug-hunter; applied=19; wins=19 -->
- **When a sender pre-validates a payload against a receiver's reject threshold, verify byte-measurement equivalence *and* boundary-direction consistency: confirm the sender measures the exact same sub-object the receiver's validator measures (e.g. `record.board` vs the whole `record`), and that the comparison operators align at the boundary (`>` skip on one side must pair with `<=` accept on the other) — a mismatch here is the classic "sender thinks it's under the limit, receiver drops it" silent-loss bug in `packages/core/src/hq/protocol/kanban.ts` and `packages/cli/src/kanban-hq-sync.ts`.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `record.board`
  - *How:* `record`
  - *How:* `>`
  - *How:* `<=`
  - *How:* `packages/core/src/hq/protocol/kanban.ts`
  - *How:* `packages/cli/src/kanban-hq-sync.ts`

<!-- learned-stamp: category=convention; capturedAt=2026-08-09T21:26:29.204Z; applied=8; wins=8 -->
- **When adding binary/protocol-mode state fields to a socket connection class in `packages/tools/src/codebase-index/project-server-client.ts`, reset them in **both** `connectOnce()` and `close()`. The connection object is reused across reconnects (`ensureConnected` early-returns on a live socket, `connectWithElection` loops `connectOnce` on stale servers), so any unreset mode flag like `useBinary` leaks into the next handshake and routes JSON frames through the binary parser. Grep for every new mutable field against both lifecycle paths before reporting the change complete.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `packages/tools/src/codebase-index/project-server-client.ts`
  - *How:* `connectOnce()`
  - *How:* `close()`
  - *How:* `ensureConnected`
  - *How:* `connectWithElection`
  - *How:* `connectOnce`
  - *How:* `useBinary`

<!-- learned-stamp: category=convention; capturedAt=2026-08-11T05:02:35.150Z; skill=chimera; applied=3; wins=3 -->
- **When reviewing a configuration-cap feature added with `?? default` display fallback + numeric-guard accessor, verify three contract points in one pass and report any divergence: (1) the accessor's null/NaN/negative guard, (2) the consumer's `?? default` — confirm `??` (not `||`) so a user-set `0` survives display, and (3) the renderer — confirm the numeric guard agrees with the renderer's `=== 0 ? disabled : ...` branches so a `0` value is rendered disabled, not as the default or as empty.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `?? default`
  - *How:* `??`
  - *How:* `||`
  - *How:* `0`
  - *How:* `=== 0 ? disabled : ...`

<!-- learned-stamp: category=convention; capturedAt=2026-08-10T21:24:04.188Z; skill=testing; applied=14; wins=14 -->
- **When validating a multi-predicate *parity* test (e.g. `classifyTaskForQueue` bucket vs `evaluateContractGraphReadiness` ready-vs `validateManagedTaskTransition` issues in `packages/kanban`), prove it is non-vacuous by tracing at least one corpus entry that resolves **ready=true** and one that resolves **ready=false** across *all* predicates — a corpus where every entry agrees on a single outcome cannot catch divergence.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `classifyTaskForQueue`
  - *How:* `evaluateContractGraphReadiness`
  - *How:* `validateManagedTaskTransition`
  - *How:* `packages/kanban`

---
*Last capture: 2026-08-11T15:48:37.933Z · 8 entries*

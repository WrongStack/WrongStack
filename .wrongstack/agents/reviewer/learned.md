# Learned instructions for `reviewer`

> Project-specific learning data for the `reviewer` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to avoid

<!-- learned-stamp: category=warning; capturedAt=2026-08-10T19:41:24.805Z; applied=471; wins=470 -->
- **Always verify a comment's test claim by searching for the named test file before trusting it as a drift guard. When a diff duplicates a canonical constant across packages (e.g. `BOARD_SOFT_MAX_BYTES` mirrored in `packages/tui`, `packages/webui`, and `packages/kanban/src/storage.ts`), grep the whole repo for the symbol and for `*.test.*` matches — a comment saying "`X.test.ts` pins both copies" is unverified until the test file is found, and an absent pin is the classic declared-but-not-enforced drift hazard.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `BOARD_SOFT_MAX_BYTES`
  - *How:* `packages/tui`
  - *How:* `packages/webui`
  - *How:* `packages/kanban/src/storage.ts`
  - *How:* `*.test.*`
  - *How:* `X.test.ts`

<!-- learned-stamp: category=warning; capturedAt=2026-08-12T07:41:24.855Z; skill=chimera; applied=8; wins=8 -->
- **Always verify a newly-threaded seam end-to-end before accepting it: for every option added to a handler's options type (e.g. `persistEvidence` in `packages/cli/src/execution-chimera-cascade.ts`), grep the whole repo for invocations AND for the production call site — an option that is declared, destructured, and threaded but never called, with no caller supplying it, is dead wiring that silently voids the documented contract (persistence, "report marked unverified").**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `persistEvidence`
  - *How:* `packages/cli/src/execution-chimera-cascade.ts`

<!-- learned-stamp: category=warning; capturedAt=2026-08-12T07:15:21.369Z; skill=chimera; applied=6; wins=5 -->
- **When a Chimera review diff adds a new local-collection array (`agentEvidence`) **and** a new property at a downstream call site (`claimedEvidence: accumulatedEvidence`) in the same hunk, always grep the *consumed* identifier independently of the collected one — a half-applied wiring names a phantom variable (the verified result) that was never declared because the step that would have produced it (e.g. a `verify...` runner call) was also never added.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `agentEvidence`
  - *How:* `claimedEvidence: accumulatedEvidence`
  - *How:* `verify...`

<!-- learned-stamp: category=warning; capturedAt=2026-08-12T10:38:35.669Z; skill=chimera; applied=103; wins=95 -->
- **When a Chimera review diff's line annotations disagree with the live on-disk file (e.g., diff shows `string[]` but the file reads `KanbanLifecycleValidationIssue[]`), always trust the file on disk and flag the divergence — an in-session `file.external.edit` can land a half-applied refactor between the diff being captured and review running. Resolve every finding against `read`/`grep` of the actual file, never the diff hunk, and cite the live line number.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `string[]`
  - *How:* `KanbanLifecycleValidationIssue[]`
  - *How:* `file.external.edit`
  - *How:* `read`
  - *How:* `grep`

<!-- learned-stamp: category=warning; capturedAt=2026-08-09T21:57:57.955Z; applied=34; wins=33 -->
- **When a refactor extracts a SQL CTE body into a `(seedSource: string) => string` template builder and delegates execution to a named helper (e.g. `runCteWithSeeds`), grep for the helper's *definition* — not just its call sites — before accepting the change. A diff can introduce a call to a helper that was planned but never written (whole-tree definition count = 0), which typecheck catches as "Cannot find name" and runtime catches as `ReferenceError`.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `(seedSource: string) => string`
  - *How:* `runCteWithSeeds`
  - *How:* `ReferenceError`

<!-- learned-stamp: category=warning; capturedAt=2026-08-12T09:26:43.569Z; applied=111; wins=109 -->
- **When a test-file diff adds a new import block but the test bodies it accompanies never reference those symbols, immediately grep the changed file for every imported name before trusting the diff — `noUnusedLocals: true` (set in `tsconfig.base.json`, inherited by every package's `tsconfig.json` and `tsconfig.test.json`) turns each unused import into `error TS6133` and fails the package's test typecheck. Unused `type`-qualified inline imports are flagged too; do not assume type-only imports are exempt.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `noUnusedLocals: true`
  - *How:* `tsconfig.base.json`
  - *How:* `tsconfig.json`
  - *How:* `tsconfig.test.json`
  - *How:* `error TS6133`
  - *How:* `type`

<!-- learned-stamp: category=warning; capturedAt=2026-08-12T05:28:46.207Z; skill=chimera; applied=19; wins=19 -->
- **When extracting a shared classification helper (e.g. `classifyChimeraReviewSource` in `packages/core/src/plugins/review-finding-integration.ts`) to guarantee two stores agree on a label, the function's parameter shape (`ReviewContextBundle` vs the full `ChimeraReviewCompletePayload`) is a wiring hazard. Grep every call site and confirm each passes the matching shape: finding/report integrations pass `payload.bundle`, while sibling consumers that already hold the bare bundle (e.g. `packages/cli/src/execution-chimera-review.ts`) pass it directly.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `classifyChimeraReviewSource`
  - *How:* `packages/core/src/plugins/review-finding-integration.ts`
  - *How:* `ReviewContextBundle`
  - *How:* `ChimeraReviewCompletePayload`
  - *How:* `payload.bundle`
  - *How:* `packages/cli/src/execution-chimera-review.ts`

<!-- learned-stamp: category=warning; capturedAt=2026-08-11T15:48:37.933Z; skill=chimera; applied=67; wins=65 -->
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

---
*Last capture: 2026-08-23T16:14:53.114Z · 8 entries*

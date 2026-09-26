# Learned instructions for `bug-hunter`

> Project-specific learning data for the `bug-hunter` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to do

<!-- learned-stamp: category=convention; capturedAt=2026-09-25T19:22:59.520Z; skill=bug-hunter; skipped=2; skippedWins=2 -->
- **Always falsify a Chimera "half-applied extraction" report in `packages/webui` by running `node node_modules/typescript/bin/tsc --noEmit --pretty false -p packages/webui/tsconfig.json` and grepping the flagged file for the deleted identifiers before editing — parallel workers routinely complete the wiring mid-session (e.g. `TechStackView/index.tsx` shrinking 808→773 lines with `AnalyzeControls.tsx`/`TrendsTab.tsx`/`RemediationTab.tsx` materializing untracked), and citing the pre-fix snapshot produces false-positive "critical" findings. A clean tsc for the flagged file is decisive even when the package exits 1 on an unrelated peer-modified file — report that failure separately with its file:line instead of patching it.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `packages/webui`
  - *How:* `node node_modules/typescript/bin/tsc --noEmit --pretty false -p packages/webui/tsconfig.json`
  - *How:* `TechStackView/index.tsx`
  - *How:* `AnalyzeControls.tsx`
  - *How:* `TrendsTab.tsx`
  - *How:* `RemediationTab.tsx`
  - *How:* `packages/webui/tsconfig.json`

<!-- learned-stamp: category=convention; capturedAt=2026-09-25T19:30:17.783Z; skill=typescript-strict; applied=1; wins=1 -->
- **Always re-run a failing cascade verification once before treating it as a defect — in `packages/cli` a first-run red `node node_modules/typescript/bin/tsc --noEmit --pretty false -p packages/cli/tsconfig.json` plus failing `pnpm exec vitest run packages/cli/tests/hq-command-credential-lifecycle.test.ts` was a parallel worker's in-flight edit (missing `failUndeliveredCommands` export at `packages/cli/src/hq-server/ws.ts`), not a bug; the settled tree passed both. Cross-check the claimed behavior against the repo's own pinned tests before accepting a Chimera ordering/semantics claim — `expect(log.recent().map(...)).toEqual(['old','live'])` in `hq-command-credential-lifecycle.test.ts` single-handedly disproved a "should be newest-first" finding. ```json { "verification_evidence": { "typecheck": { "command": "node node_modules/typescript/bin/tsc --noEmit --pretty false -p packages/core/tsconfig.json", "exitCode": 0 }, "typecheck_packages_cli": { "command": "node node_modules/typescript/bin/tsc --noEmit --pretty false -p packages/cli/tsconfig.json", "exitCode": 0 }, "lint": { "command": "pnpm exec biome check packages/core/src/hq/commands.ts packages/cli/src/hq-server/ws.ts packages/cli/src/hq-server.ts", "exitCode": 0 }, "tests": { "command": "pnpm exec vitest run packages/core/tests/hq/commands.test.ts", "exitCode": 0 }, "tests_packages_cli": { "command": "pnpm exec vitest run packages/cli/tests/hq-command-credential-lifecycle.test.ts", "exitCode": 0 } } } ```**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `packages/cli`
  - *How:* `node node_modules/typescript/bin/tsc --noEmit --pretty false -p packages/cli/tsconfig.json`
  - *How:* `pnpm exec vitest run packages/cli/tests/hq-command-credential-lifecycle.test.ts`
  - *How:* `failUndeliveredCommands`
  - *How:* `packages/cli/src/hq-server/ws.ts`
  - *How:* `expect(log.recent().map(...)).toEqual(['old','live'])`
  - *How:* `hq-command-credential-lifecycle.test.ts`
  - *How:* `packages/cli/tsconfig.json`
  - *How:* `packages/cli/tests/hq-command-credential-lifecycle.test.ts`
  - *How:* `packages/core/tsconfig.json`
  - *How:* `packages/core/src/hq/commands.ts`
  - *How:* `packages/cli/src/hq-server.ts`
  - *How:* `packages/core/tests/hq/commands.test.ts`

---
*Last capture: 2026-09-25T19:30:17.783Z · 2 entries*

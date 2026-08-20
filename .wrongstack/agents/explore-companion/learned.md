# Learned instructions for `explore-companion`

> Project-specific learning data for the `explore-companion` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to avoid

<!-- learned-stamp: category=warning; capturedAt=2026-08-20T08:12:30.556Z -->
- **Always grep for `P0-\d` comment markers when probing which WrongStack fixes are in flight — this repo tags multi-part work (P0-1, P0-2, P0-3) in doc comments across cli and core, so one `grep P0-\d` over `packages/{cli,core}/src` clusters the change surface faster than mtime alone. Avoid brace-expansion globs (`packages/**/*.{ts,tsx}`) in the `glob` tool — they return 0 files silently; use a single-pattern glob per suffix instead.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `P0-\d`
  - *How:* `grep P0-\d`
  - *How:* `packages/{cli,core}/src`
  - *How:* `packages/**/*.{ts,tsx}`
  - *How:* `glob`

<!-- learned-stamp: category=warning; capturedAt=2026-08-20T13:34:20.444Z; applied=14; wins=14 -->
- **Always trace WrongStack core consumption via subpath specifiers (`@wrongstack/core/kernel`, `/coordination`, `/types`), never via the bare `@wrongstack/core` root barrel — `packages/core/src/index.ts` is a ~1,000-line pure re-export compat surface for external npm consumers, and grep for the bare specifier returns almost only doc comments. Also remember `packages/webui/src/lib/core-browser-shim.ts` intercepts the bare specifier for webui's Vite browser build, so browser-side "imports of core" resolve to that shim, not the real barrel.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `@wrongstack/core/kernel`
  - *How:* `/coordination`
  - *How:* `/types`
  - *How:* `@wrongstack/core`
  - *How:* `packages/core/src/index.ts`
  - *How:* `packages/webui/src/lib/core-browser-shim.ts`

<!-- learned-stamp: category=warning; capturedAt=2026-08-20T07:19:49.670Z; skill=node-modern; applied=26; wins=26 -->
- **When probing a leader's in-progress todo, first check whether the session todo store is materialized on disk (`glob .wrongstack/**/*todo*`) — in WrongStack it is runtime state with no file backing, so the probe must fall back to mtime-ordered `glob` over `packages/*/src` plus `git diff HEAD` as ground truth; treat the auto-mined `.wrongstack/domain-terms.md` jargon list as boilerplate present in every request, never as signal about the leader's current work.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `glob .wrongstack/**/*todo*`
  - *How:* `glob`
  - *How:* `packages/*/src`
  - *How:* `git diff HEAD`
  - *How:* `.wrongstack/domain-terms.md`

## What to do

<!-- learned-stamp: category=convention; capturedAt=2026-08-20T08:26:43.047Z; applied=45; wins=45 -->
- **When `submit_result` rejects with "summary/findings/... are required" despite all fields being valid ASCII, shorten finding *text length*, not just finding *count* — a 7-finding report with multi-line findings still fails; the passing shape is ~4 findings of 1–2 short lines each plus a single `files_examined` entry. Always draft the compact version first rather than iterating down from the full report.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `submit_result`
  - *How:* `files_examined`

<!-- learned-stamp: category=convention; capturedAt=2026-08-20T07:09:51.163Z; applied=28; wins=28 -->
- **When pre-mapping the file surface for a leader's in-progress todo, always read the cited source and check whether the described change already exists in the working tree before reporting it as pending — a flipped-to-in_progress todo often means the edit is partially or fully made. Anchor: `read` the primary file, then recommend a `git diff` against HEAD plus the narrowest test filter as the leader's verification step.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `read`
  - *How:* `git diff`

<!-- learned-stamp: category=convention; capturedAt=2026-08-20T07:02:26.113Z; applied=35; wins=35 -->
- **When probing `mailbox-types` in WrongStack, always disambiguate by full path: there are two unrelated files with that name — `packages/core/src/coordination/mailbox-types.ts` (the core facade + `Mailbox` interface) and `packages/webui-hq/src/views/mailbox-types.ts` (a local UI label map imported by `mailbox-row.tsx`). Grep for `mailbox-types` returns both; check the import specifier's directory before attributing a hit to the core module.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `mailbox-types`
  - *How:* `packages/core/src/coordination/mailbox-types.ts`
  - *How:* `Mailbox`
  - *How:* `packages/webui-hq/src/views/mailbox-types.ts`
  - *How:* `mailbox-row.tsx`

<!-- learned-stamp: category=convention; capturedAt=2026-08-20T08:15:01.225Z; skill=node-modern; applied=33; wins=33 -->
- **When probing a WrongStack "run tests / capture proof" todo, derive the verification surface from three anchors before reporting commands: `.reports/release-check-matrix/*.log` (the repo's existing proof-artifact convention — check its filenames for where captured output belongs), the `test`/`typecheck` scripts in the touched package's `package.json` (they define the narrowest legitimate filter), and the `exclude` list in root `vitest.config.ts` (a green bare `vitest run` may simply have skipped webui, hq-dashboard, and status-bar suites).**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `.reports/release-check-matrix/*.log`
  - *How:* `test`
  - *How:* `typecheck`
  - *How:* `package.json`
  - *How:* `exclude`
  - *How:* `vitest.config.ts`
  - *How:* `vitest run`

<!-- learned-stamp: category=convention; capturedAt=2026-08-20T13:46:46.316Z; applied=5; wins=5 -->
- **When probing or pre-mapping `packages/core/tests/coordination/mutation-test-integration.test.ts`, anchor expectations to `planMutations` output rather than the `__mutation_fixture__/subject.ts` doc comment — the comment is stale (claims ; mutants land on ).**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `packages/core/tests/coordination/mutation-test-integration.test.ts`
  - *How:* `planMutations`
  - *How:* `__mutation_fixture__/subject.ts`

<!-- learned-stamp: category=convention; capturedAt=2026-08-20T07:09:51.163Z; skill=node-modern; applied=19; wins=19 -->
- **WrongStack WebUI auto-submit state is module-level and shared across all hook instances — `packages/webui/src/stores/auto-submit-streak.ts` keeps `_streak`, `_loopHalted`, `_loopGuard`, `_continuationTracker` outside the React component tree, reset only by effects keyed on `autonomy`/`sessionId` transitions. Tests for it must mount the hook and call `result.current.reset()` in `beforeEach`, and those suites run only under `pnpm --filter webui test`.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `packages/webui/src/stores/auto-submit-streak.ts`
  - *How:* `_streak`
  - *How:* `_loopHalted`
  - *How:* `_loopGuard`
  - *How:* `_continuationTracker`
  - *How:* `autonomy`
  - *How:* `sessionId`
  - *How:* `result.current.reset()`
  - *How:* `beforeEach`
  - *How:* `pnpm --filter webui test`

---
*Last capture: 2026-08-20T13:46:46.316Z · 9 entries*

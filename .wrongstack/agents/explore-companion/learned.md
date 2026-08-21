# Learned instructions for `explore-companion`

> Project-specific learning data for the `explore-companion` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to avoid

<!-- learned-stamp: category=warning; capturedAt=2026-08-20T08:12:30.556Z; applied=1; wins=1 -->
- **Always grep for `P0-\d` comment markers when probing which WrongStack fixes are in flight — this repo tags multi-part work (P0-1, P0-2, P0-3) in doc comments across cli and core, so one `grep P0-\d` over `packages/{cli,core}/src` clusters the change surface faster than mtime alone. Avoid brace-expansion globs (`packages/**/*.{ts,tsx}`) in the `glob` tool — they return 0 files silently; use a single-pattern glob per suffix instead.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `P0-\d`
  - *How:* `grep P0-\d`
  - *How:* `packages/{cli,core}/src`
  - *How:* `packages/**/*.{ts,tsx}`
  - *How:* `glob`

<!-- learned-stamp: category=warning; capturedAt=2026-08-20T13:34:20.444Z; applied=84; wins=84 -->
- **Always trace WrongStack core consumption via subpath specifiers (`@wrongstack/core/kernel`, `/coordination`, `/types`), never via the bare `@wrongstack/core` root barrel — `packages/core/src/index.ts` is a ~1,000-line pure re-export compat surface for external npm consumers, and grep for the bare specifier returns almost only doc comments. Also remember `packages/webui/src/lib/core-browser-shim.ts` intercepts the bare specifier for webui's Vite browser build, so browser-side "imports of core" resolve to that shim, not the real barrel.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `@wrongstack/core/kernel`
  - *How:* `/coordination`
  - *How:* `/types`
  - *How:* `@wrongstack/core`
  - *How:* `packages/core/src/index.ts`
  - *How:* `packages/webui/src/lib/core-browser-shim.ts`

<!-- learned-stamp: category=warning; capturedAt=2026-08-20T20:09:30.423Z; applied=13; wins=13 -->
- **Disambiguate a leader-todo "Engine" by globbing `packages/core/tests/**/*engine*` first (currently 2 hits: `coordination/mutation-engine.test.ts` and `execution/parallel-eternal-engine.test.ts`) — the surrounding todo verbs ("full coordination suite") pick the branch; never trust a bare `codebase-search` "Engine" hit, since core has many unrelated Engine symbols across chronicle, execution, and skills.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `packages/core/tests/**/*engine*`
  - *How:* `coordination/mutation-engine.test.ts`
  - *How:* `execution/parallel-eternal-engine.test.ts`
  - *How:* `codebase-search`

<!-- learned-stamp: category=warning; capturedAt=2026-08-20T19:15:52.736Z; applied=13; wins=13 -->
- **When a leader's todo uses invented shorthand like "stale-ledger", grep `packages/*/tests/**` for the phrase *before* searching source identifiers — in WrongStack such jargon is typically documented only in a regression-test comment (anchor: `director-mutation-test-tool.test.ts` "The stale-ledger regression"), never in a symbol name. A todo suffix like "resolve X memory" means knowledge capture: verify with a grep of `.wrongstack/agents/**/learned.md` for the term, and report which memory note lacks it.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `packages/*/tests/**`
  - *How:* `director-mutation-test-tool.test.ts`
  - *How:* `.wrongstack/agents/**/learned.md`

<!-- learned-stamp: category=warning; capturedAt=2026-08-20T07:19:49.670Z; skill=node-modern; applied=36; wins=36 -->
- **When probing a leader's in-progress todo, first check whether the session todo store is materialized on disk (`glob .wrongstack/**/*todo*`) — in WrongStack it is runtime state with no file backing, so the probe must fall back to mtime-ordered `glob` over `packages/*/src` plus `git diff HEAD` as ground truth; treat the auto-mined `.wrongstack/domain-terms.md` jargon list as boilerplate present in every request, never as signal about the leader's current work.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `glob .wrongstack/**/*todo*`
  - *How:* `glob`
  - *How:* `packages/*/src`
  - *How:* `git diff HEAD`
  - *How:* `.wrongstack/domain-terms.md`

<!-- learned-stamp: category=warning; capturedAt=2026-08-20T22:01:18.489Z; applied=3; wins=3 -->
- **When probing theme/styling in `packages/tui`, treat `packages/tui/src/theme.ts` as a facade over `theme-presets.ts`/`theme-types.ts`/`theme-utils.ts` plus a live mutable singleton: `export const theme` is mutated in place by `setActiveTheme()` (delete-then-assign keys), so theme switching propagates to all ~75 importers without React context — never look for a ThemeProvider there.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `packages/tui`
  - *How:* `packages/tui/src/theme.ts`
  - *How:* `theme-presets.ts`
  - *How:* `theme-types.ts`
  - *How:* `theme-utils.ts`
  - *How:* `export const theme`
  - *How:* `setActiveTheme()`

## What to do

<!-- learned-stamp: category=convention; capturedAt=2026-08-20T08:26:43.047Z; applied=108; wins=108 -->
- **When `submit_result` rejects with "summary/findings/... are required" despite all fields being valid ASCII, shorten finding *text length*, not just finding *count* — a 7-finding report with multi-line findings still fails; the passing shape is ~4 findings of 1–2 short lines each plus a single `files_examined` entry. Always draft the compact version first rather than iterating down from the full report.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `submit_result`
  - *How:* `files_examined`

<!-- learned-stamp: category=convention; capturedAt=2026-08-20T07:09:51.163Z; applied=41; wins=41 -->
- **When pre-mapping the file surface for a leader's in-progress todo, always read the cited source and check whether the described change already exists in the working tree before reporting it as pending — a flipped-to-in_progress todo often means the edit is partially or fully made. Anchor: `read` the primary file, then recommend a `git diff` against HEAD plus the narrowest test filter as the leader's verification step.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `read`
  - *How:* `git diff`

<!-- learned-stamp: category=convention; capturedAt=2026-08-20T08:15:01.225Z; skill=node-modern; applied=80; wins=80 -->
- **When probing a WrongStack "run tests / capture proof" todo, derive the verification surface from three anchors before reporting commands: `.reports/release-check-matrix/*.log` (the repo's existing proof-artifact convention — check its filenames for where captured output belongs), the `test`/`typecheck` scripts in the touched package's `package.json` (they define the narrowest legitimate filter), and the `exclude` list in root `vitest.config.ts` (a green bare `vitest run` may simply have skipped webui, hq-dashboard, and status-bar suites).**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `.reports/release-check-matrix/*.log`
  - *How:* `test`
  - *How:* `typecheck`
  - *How:* `package.json`
  - *How:* `exclude`
  - *How:* `vitest.config.ts`
  - *How:* `vitest run`

---
*Last capture: 2026-08-20T22:01:18.489Z · 9 entries*

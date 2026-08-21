# explore-companion — Role Instructions

## Delivering Findings

- Submit all probe findings via `submit_result`. The `mailbox` tool's send action is denied for this role (capability `coordination.mail` is not in the allowed list), so composing a mailbox message to the leader wastes a round trip.
- Keep `submit_result` payloads (summary, findings, suggested_next_steps) pure ASCII. Em-dashes and arrow symbols (—, ⇒) correlate with "Invalid report" schema rejections; the same content rewritten in ASCII passes.
- When `submit_result` rejects with "summary/findings/... are required" despite valid ASCII fields, shorten finding *text length*, not just finding *count* — a 7-finding report with multi-line findings still fails. The proven passing shape is ~4 findings of 1–2 short lines each plus a single `files_examined` entry. Draft the compact version first rather than iterating down from a full report.

## Probing In-Progress Work

- Before probing a leader's todo, check whether the session todo store is materialized on disk (`glob .wrongstack/**/*todo*`). It is runtime state with no file backing, so fall back to mtime-ordered `glob` over `packages/*/src` plus `git diff HEAD` as ground truth.
- Treat `.wrongstack/domain-terms.md` as auto-mined boilerplate present in every request — never as signal about the leader's current work.
- Always read the cited source and check whether the described change already exists in the working tree before reporting a todo item as pending — a flipped-to-in_progress todo often means the edit is partially or fully made. Recommend `git diff` against HEAD plus the narrowest test filter as the leader's verification step.

## Resolving Ambiguous Shorthand

- When a leader's todo uses invented jargon (e.g. "stale-ledger"), grep `packages/*/tests/**` for the phrase *before* searching source identifiers — such terms are typically documented only in regression-test comments (e.g. the "stale-ledger regression" note in `director-mutation-test-tool.test.ts`), never in symbol names.
- Disambiguate overloaded names like "Engine" by globbing `packages/core/tests/**/*engine*` first; the todo's surrounding verbs pick the branch (e.g. "full coordination suite" → `coordination/mutation-engine.test.ts`). Never trust a bare `codebase-search` hit — core has many unrelated Engine symbols across chronicle, execution, and skills.
- A todo suffix like "resolve X memory" means knowledge capture: grep `.wrongstack/agents/**/learned.md` for the term and report which memory note lacks it.

## Tracing Core Imports

- Trace WrongStack core consumption via subpath specifiers (`@wrongstack/core/kernel`, `/coordination`, `/types`), never the bare `@wrongstack/core` root barrel — `packages/core/src/index.ts` is a large pure re-export compat surface for external npm consumers, so greps on the bare specifier return almost only doc comments.
- Browser-side "imports of core" in webui resolve to `packages/webui/src/lib/core-browser-shim.ts`, which intercepts the bare specifier for the Vite browser build — not the real barrel.

## Verification Surfaces

- Derive the verification surface from three anchors before reporting commands: `.reports/release-check-matrix/*.log` (the repo's proof-artifact convention — filenames indicate where captured output belongs), the `test`/`typecheck` scripts in the touched package's `package.json` (the narrowest legitimate filter), and the `exclude` list in root `vitest.config.ts`.
- A green bare `vitest run` may simply have skipped excluded suites: root `vitest.config.ts` excludes `packages/webui/**`, and those jsdom suites run only via `pnpm --filter webui test`.
- `packages/cli/tests/hq-dashboard.test.ts` runs only through `pnpm --filter @wrongstack/cli test:hqdash`, which uses `packages/cli/vitest.hqdash.config.ts`.

## Project Facts

- Multi-part work is tagged `P0-N` (P0-1, P0-2, ...) in doc comments across cli and core; `grep P0-\d` over `packages/{cli,core}/src` clusters the change surface faster than mtime alone.
- `packages/tui/src/theme.ts` is a facade over `theme-presets.ts`/`theme-types.ts`/`theme-utils.ts` plus a live mutable singleton: `export const theme` is mutated in place by `setActiveTheme()` (delete-then-assign keys), so theme switching propagates to all importers without React context — do not look for a ThemeProvider there.

## Tooling Warnings

- Avoid brace-expansion globs (`packages/**/*.{ts,tsx}`) in the `glob` tool — they return 0 files silently. Use a single-pattern glob per suffix instead.
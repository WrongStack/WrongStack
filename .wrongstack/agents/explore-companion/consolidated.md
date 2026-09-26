# explore-companion — Role Instructions

## Delivering Findings

- Submit all probe findings via `submit_result`. The `mailbox` tool's send action is denied for this role (capability `coordination.mail` is not in the allowed list), so composing a mailbox message to the leader wastes a round trip.
- Keep `submit_result` payloads (summary, findings, suggested_next_steps) pure ASCII. Em-dashes and arrow symbols (—, ⇒) correlate with "Invalid report" schema rejections; the same content rewritten in ASCII passes.
- When `submit_result` rejects with "summary/findings/... are required" despite valid ASCII fields, shorten finding *text length*, not just finding *count* — a 7-finding report with multi-line findings still fails. The proven passing shape is ~4 findings of 1–2 short lines each plus a single `files_examined` entry. Draft the compact version first rather than iterating down from a full report.

## Codebase Ref Graph (`codebase-incoming-calls`)

- Never report "no callers" from a zero-hit `codebase-incoming-calls` result alone — the ref graph misses symbols even in ordinary CLI source. Confirm with an exact-text `rg` over `packages/**/*.ts` before stating caller counts.
- Never use `codebase-incoming-calls` on generic, overloaded symbol names such as `create`: it returns cross-file noise and its `file` filter cannot disambiguate methods of one class. Fall back to a targeted grep like `(sessionStore|store)\.create\(` over `packages/**/src` and filter test files by name.
- If it fails with "Index build failed: Project files changed during indexing", do not retry or reindex — fall back to one exact-text grep for call sites and note in the report that the ref graph was unavailable.

## Search Patterns

- Grep for the ESM `.js` specifier suffix when tracing relative imports inside workspace packages (e.g. `from ['"][^'"]*types\.js['"]`): sources import `./types.js`, so a bare `'./types'` pattern returns zero in-package hits and floods with `webui/src/types.ts` noise. Confirm which file a match resolves to — a `./types.js` import in a subdirectory resolves to that directory's own `types.ts`, not the package-root one.
- When probing webui state-store consumption, grep the exact alias specifier `from '@/stores'`: all ~200+ consumers import the barrel `packages/webui/src/stores/index.ts` via that alias, never a relative path. The pattern `from ['"][^'"]*stores(/index)?(\.js)?['"]` cleanly excludes deep `stores/<name>.js` imports. Behavior changes belong in the sibling `packages/webui/src/stores/<name>-store.ts` — the barrel is a pure re-export with no local symbols.
- Grep kill-related test coverage with precise tokens (`SIGKILL`, `killed-session`, `never-closed`) or word boundaries — a bare `kill` matches `skills` across config-store and cloud-sync suites and floods results.
- When a doc file shares its name with a workspace package (e.g. `docs/techstack.md` vs `packages/techstack`), grep the exact filename suffix (`techstack\.md`); a bare-term grep returns mostly `pnpm-lock.yaml` and `.wrongstack/atlas/*` manifest noise. Anchoring a "generated vs curated" claim requires reading the writer in source (e.g. `packages/cli/src/slash-commands/techstack.ts`) — a command that writes to the project root means a copy under `docs/` is curated, not regenerated in place.
- Re-grep `t('ns:key')` i18n literals fresh on every probe instead of repeating a prior "zero entries" flag, and check them against whole-package locale resources (`grep` with glob `*.json` over `packages/webui`, not just `src`) before claiming a key resolves — some keys have no resource entry anywhere in the package.

## Webui Layout

- `packages/webui/src/components/ChatView.tsx` is a 2-line re-export shim for `packages/webui/src/components/ChatView/index.tsx`; always edit the directory version. Do not confuse lookalikes `components/AgentTranscript.tsx` or `components/ui/tabs.tsx` with AgentTabs.
- Before reporting a webui component as having no callers, read its sibling directory barrel/parent in full (e.g. `.../ChatView/index.tsx`) — `lazy(() => import(...))` and renamed imports never match a bare-symbol grep or incoming-calls, so only a parent-file read rules out hidden wiring.

## Resolving Ambiguous Shorthand

- When a leader's todo uses invented jargon (e.g. "stale-ledger"), grep `packages/*/tests/**` for the phrase *before* searching source identifiers — such terms are typically documented only in regression-test comments, never in symbol names.
- Disambiguate overloaded names like "Engine" by globbing `packages/core/tests/**/*engine*` first; the todo's surrounding verbs pick the branch. Never trust a bare `codebase-search` hit — core has many unrelated Engine symbols across chronicle, execution, and skills.
- A todo suffix like "resolve X memory" means knowledge capture: grep `.wrongstack/agents/**/learned.md` for the term and report which memory note lacks it.
- Always read the cited source and check whether the described change already exists in the working tree before reporting a todo item as pending — a flipped-to-`in_progress` todo often means the edit is partially or fully made.

## Tracing Core Imports

- Trace WrongStack core consumption via subpath specifiers (`@wrongstack/core/kernel`, `/coordination`, `/types`), never the bare `@wrongstack/core` root barrel — `packages/core/src/index.ts` is a large pure re-export compat surface for external npm consumers, so greps on the bare specifier return almost only doc comments.
- Browser-side "imports of core" in webui resolve to `packages/webui/src/lib/core-browser-shim.ts`, which intercepts the bare specifier for the Vite browser build — not the real barrel.

## Verification Surfaces

- Derive the verification surface from three anchors before reporting commands: `.reports/release-check-matrix/*.log` (the repo's proof-artifact convention — filenames indicate where captured output belongs), the `test`/`typecheck` scripts in the touched package's `package.json` (the narrowest legitimate filter), and the `exclude` list in root `vitest.config.ts`.
- A green bare `vitest run` may simply have skipped excluded suites: root `vitest.config.ts` excludes `packages/webui/**`, so run webui component suites with `cd packages/webui && npx vitest run <file>` or `pnpm --filter webui test` — they never execute under the root config.
- `packages/webui/vitest.config.ts` splits webui into two projects: `browser-jsdom` includes `tests/**/*.test.{ts,tsx}` excluding `tests/server/**` (so even DOM-free unit tests run under jsdom), while `tests/server/**` runs in the node project.
- `packages/cli/tests/hq-dashboard.test.ts` runs only through `pnpm --filter @wrongstack/cli test:hqdash`, which uses `packages/cli/vitest.hqdash.config.ts`.
- When pre-mapping a "Tests:" todo, grep `it('` names across the package's test directory first. Behavior tests often live in grab-bag files whose name mismatches the symbol under test, so the absence of a matching filename proves nothing about coverage.

## Project Facts

- Multi-part work is tagged `P0-N` (P0-1, P0-2, …) in doc comments across cli and core; `grep P0-\d` over `packages/{cli,core}/src` clusters the change surface faster than mtime alone.
- Before treating a todo's `type` clause as a gap, grep the full `CallType` union in `packages/tools/src/codebase-index/schema.ts`: `type_ref` is emitted only by `ts-parser.ts`, never by the tree-sitter `refRules` tables in `packages/tools/src/codebase-index/tree-sitter/queries.ts`, so WASM-language test todos need only `call`/`import`/`inherit`/`implement` assertions.
- `packages/tui/src/theme.ts` is a facade over `theme-presets.ts`/`theme-types.ts`/`theme-utils.ts` plus a live mutable singleton: `export const theme` is mutated in place by `setActiveTheme()` (delete-then-assign keys), so theme switching propagates to all importers without React context — do not look for a ThemeProvider there.
- Treat `.wrongstack/domain-terms.md` as auto-mined boilerplate present in every request — never as signal about the leader's current work.

## Tooling Warnings

- Avoid brace-expansion globs (`packages/**/*.{ts,tsx}`) in the `glob` tool — they return 0 files silently. Use one single-pattern glob per suffix instead.
- The session todo store has no file backing; when it is not materialized on disk, use mtime-ordered `glob packages/<pkg>/src/**/*.ts*` (single `ts*` suffix pattern) plus `git diff HEAD` as ground truth.
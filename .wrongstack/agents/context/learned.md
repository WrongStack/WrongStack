# Learned instructions for `context`

> Project-specific learning data for the `context` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to avoid

<!-- learned-stamp: category=warning; capturedAt=2026-08-27T11:05:48.475Z -->
- **Always locate JSX render sites by grepping the **bare component name** (e.g. pattern `StatusBar`) or its import statement — never a pattern with a leading `<`. Why: in this environment an angle-bracket-prefixed pattern returns a false zero even when the tag is present (verified against `packages/tui/src/app-status-region.tsx`, which renders `<StatusBar` at while the bracketed pattern matched nothing); a bracketed alternation silently degrades to only its non-bracketed branch. Anchor: `grep`, `packages/tui/src/app-status-region.tsx`.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `StatusBar`
  - *How:* `<`
  - *How:* `packages/tui/src/app-status-region.tsx`
  - *How:* `<StatusBar`
  - *How:* `grep`

<!-- learned-stamp: category=warning; capturedAt=2026-08-22T18:52:08.216Z; skill=output-standards; applied=3; wins=3 -->
- **Always scan build output in this repo by enumerating `packages/*/dist` with `glob` using an explicit `path` argument (e.g. `path: packages/providers/dist`, pattern `**/*.js`) and then grepping each **exact file path** — never by repo-root glob patterns (`packages/*/dist/*.js` returns 0 files) and never by directory-mode `grep` with `path` set to a dist directory. Reason: rg honors `.gitignore` ( ignores `dist/`), so directory-mode grep into `dist/` returns a false zero even when files inside contain the needle, while explicit-file grep and explicit-path glob do see ignored files.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `packages/*/dist`
  - *How:* `glob`
  - *How:* `path`
  - *How:* `path: packages/providers/dist`
  - *How:* `**/*.js`
  - *How:* `packages/*/dist/*.js`
  - *How:* `grep`
  - *How:* `.gitignore`
  - *How:* `dist/`

<!-- learned-stamp: category=warning; capturedAt=2026-08-21T18:55:16.207Z; applied=65; wins=65 -->
- **Always verify React component wiring in `packages/webui/src` with an exact-text grep of the component name — never from `codebase-incoming-calls` returning zero or a `codebase-skeleton` import block, because JSX render edges are invisible to both (verified: AgentTabs showed 0 incoming calls while `ChatView/index.tsx` imported it at L21 and rendered it at L102). Key takeaway: the map shows a feature that is ~90% landed — the real remaining work is tests and polish, and any consumer must treat exact line numbers as perishable while a peer edits concurrently.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `packages/webui/src`
  - *How:* `codebase-incoming-calls`
  - *How:* `codebase-skeleton`
  - *How:* `ChatView/index.tsx`

<!-- learned-stamp: category=warning; capturedAt=2026-08-25T17:29:35.130Z; skill=output-standards; applied=6; wins=6 -->
- **Treat `packages/tui/src/components/status-bar.tsx` as a facade when routing TUI edits: only the `StatusBar` component is defined there; formatting helpers live in `status-bar-format.tsx`, colors/icons in `status-bar-icons.tsx`, prop types in `status-bar-types.tsx`, and chip construction in `status-bar-rails.tsx`. Its single render site is `AppStatusRegion` in `packages/tui/src/app-status-region.tsx` (mounted by `app-view.tsx`), and all importers are package-internal — route changes to the owning sibling module, never the facade.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `packages/tui/src/components/status-bar.tsx`
  - *How:* `StatusBar`
  - *How:* `status-bar-format.tsx`
  - *How:* `status-bar-icons.tsx`
  - *How:* `status-bar-types.tsx`
  - *How:* `status-bar-rails.tsx`
  - *How:* `AppStatusRegion`
  - *How:* `packages/tui/src/app-status-region.tsx`
  - *How:* `app-view.tsx`

<!-- learned-stamp: category=warning; capturedAt=2026-08-21T19:09:12.562Z; applied=52; wins=51 -->
- **Treat files under `packages/webui/tests/**` as vitest entry points: confirm discovery and environment by reading the package's `vitest.config.ts` inline `projects` blocks (include globs + `globals: true`), never by searching for code importers. When a webui test uses hooks like `beforeEach` without importing them from `vitest`, check `test.globals: true` before flagging it as a bug — but note bare-hook usage only works inside projects with globals enabled, not root-config suites.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `packages/webui/tests/**`
  - *How:* `vitest.config.ts`
  - *How:* `projects`
  - *How:* `globals: true`
  - *How:* `beforeEach`
  - *How:* `vitest`
  - *How:* `test.globals: true`

<!-- learned-stamp: category=warning; capturedAt=2026-08-24T09:44:31.654Z; skill=audit-log; applied=13; wins=13 -->
- **When auditing provider-config wiring, always grep for callers of `resolveProviderCfg` / `resolveProviderCfgWithProxy` / `buildProviderForId` across `packages/cli/src/wiring/*.ts` and `packages/cli/src/cli-main.ts` — the file's own JSDoc names three historical drift sites (`provider.ts:setupProvider`, `provider-runtime.ts:resolveProviderCfg`, `packages/runtime/src/fleet/light-subagent-factory.ts:buildProvider`) and any new hand-copied merge in the same monorepo is a regression risk. ``` ```**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `resolveProviderCfg`
  - *How:* `resolveProviderCfgWithProxy`
  - *How:* `buildProviderForId`
  - *How:* `packages/cli/src/wiring/*.ts`
  - *How:* `packages/cli/src/cli-main.ts`
  - *How:* `provider.ts:setupProvider`
  - *How:* `provider-runtime.ts:resolveProviderCfg`
  - *How:* `packages/runtime/src/fleet/light-subagent-factory.ts:buildProvider`
  - *How:* `packages/runtime/src/fleet/light-subagent-factory.ts`

<!-- learned-stamp: category=warning; capturedAt=2026-08-24T07:51:52.390Z; skill=output-standards; applied=2; wins=1 -->
- **When calling submit_result, keep findings, files_examined, and suggested_next_steps as flat arrays of plain strings. Avoid nested arrays, objects, JSON-like punctuation, or "to"/"lines" phrasing inside any entry — the runtime validator parses those fields strictly and rejects entries it interprets as nested structures, even when JSON.stringify would render them as strings. ```**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.

## What to do

<!-- learned-stamp: category=convention; capturedAt=2026-08-27T11:13:55.809Z; skill=output-standards; applied=2; wins=2 -->
- **Always write `submit_result` `summary`/`findings`/`suggested_next_steps` entries in plain ASCII using only commas and periods — this validator rejected reports twice that contained em-dashes and parentheses even when every field was present with a numeric confidence, and accepted the identical content after ASCII-only sanitization. Anchor: `submit_result`, `coordination.result.submit`.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `submit_result`
  - *How:* `summary`
  - *How:* `findings`
  - *How:* `suggested_next_steps`
  - *How:* `coordination.result.submit`

---
*Last capture: 2026-08-27T11:13:55.809Z · 8 entries*

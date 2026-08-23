# Learned instructions for `context`

> Project-specific learning data for the `context` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to avoid

<!-- learned-stamp: category=warning; capturedAt=2026-08-22T18:52:08.216Z; skill=output-standards -->
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

<!-- learned-stamp: category=warning; capturedAt=2026-08-21T18:55:16.207Z; applied=9; wins=9 -->
- **Always verify React component wiring in `packages/webui/src` with an exact-text grep of the component name — never from `codebase-incoming-calls` returning zero or a `codebase-skeleton` import block, because JSX render edges are invisible to both (verified: AgentTabs showed 0 incoming calls while `ChatView/index.tsx` imported it at L21 and rendered it at L102). Key takeaway: the map shows a feature that is ~90% landed — the real remaining work is tests and polish, and any consumer must treat exact line numbers as perishable while a peer edits concurrently.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `packages/webui/src`
  - *How:* `codebase-incoming-calls`
  - *How:* `codebase-skeleton`
  - *How:* `ChatView/index.tsx`

<!-- learned-stamp: category=warning; capturedAt=2026-08-21T19:09:12.562Z; applied=13; wins=13 -->
- **Treat files under `packages/webui/tests/**` as vitest entry points: confirm discovery and environment by reading the package's `vitest.config.ts` inline `projects` blocks (include globs + `globals: true`), never by searching for code importers. When a webui test uses hooks like `beforeEach` without importing them from `vitest`, check `test.globals: true` before flagging it as a bug — but note bare-hook usage only works inside projects with globals enabled, not root-config suites.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `packages/webui/tests/**`
  - *How:* `vitest.config.ts`
  - *How:* `projects`
  - *How:* `globals: true`
  - *How:* `beforeEach`
  - *How:* `vitest`
  - *How:* `test.globals: true`

## What to do

<!-- learned-stamp: category=convention; capturedAt=2026-08-22T10:57:53.743Z; skill=output-standards; applied=2; wins=2 -->
- **Always probe per-package build scripts (scripts/build-package.mjs and similar) with grep on package.json#scripts.build before searching for JS importers — these scripts are top-level executables with no module exports, so codebase-incoming-calls returns 0 and only the npm-script wiring makes the caller graph visible. Anchor on `scripts/build-package.mjs` and the orchestrator `scripts/build.mjs`. ```**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `scripts/build-package.mjs`
  - *How:* `scripts/build.mjs`

<!-- learned-stamp: category=convention; capturedAt=2026-08-22T18:52:08.216Z -->
- **Before grepping all 33 workspace `dist` trees for a constant defined in some package's `src`, check the reverse-dependency edges in `packages/*/package.json` and the externalization plugin in `scripts/build-package.mjs` (`workspaceExternalPlugin` marks every `@wrongstack/*` import esbuild-external). A constant like `CODEX_MODELS_CLIENT_VERSION` in `packages/providers/src/openai-codex.ts` can only appear in its own package's dist or in a Vite browser bundle (webui/webui-hq/simpleui) that imports it — most dists are provably out of scope before any grep runs.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `dist`
  - *How:* `src`
  - *How:* `packages/*/package.json`
  - *How:* `scripts/build-package.mjs`
  - *How:* `workspaceExternalPlugin`
  - *How:* `@wrongstack/*`
  - *How:* `CODEX_MODELS_CLIENT_VERSION`
  - *How:* `packages/providers/src/openai-codex.ts`

<!-- learned-stamp: category=convention; capturedAt=2026-08-22T18:52:08.216Z; skill=output-standards -->
- **Record every exact file path actually grepped when asserting a negative ("no matches") in this repo, because ignore-rule false zeros make unaudited negative claims unreliable — the audit trail of paths checked is part of the deliverable, not extra output.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.

<!-- learned-stamp: category=convention; capturedAt=2026-08-21T18:47:12.278Z; applied=19; wins=19 -->
- **Treat the exports map in `packages/webui/package.json` as packaging metadata, not a live API: no workspace code imports `@wrongstack/webui` or `@wrongstack/webui/types`; only `packages/cli` and `apps/desktop` declare it, as a presence pin. Its real delivery path is the Vite bundle from `packages/webui/src/main.tsx` served by `@wrongstack/webui-server`, so probing "who imports this package" must grep import statements, not just dependency declarations.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `packages/webui/package.json`
  - *How:* `@wrongstack/webui`
  - *How:* `@wrongstack/webui/types`
  - *How:* `packages/cli`
  - *How:* `apps/desktop`
  - *How:* `packages/webui/src/main.tsx`
  - *How:* `@wrongstack/webui-server`

---
*Last capture: 2026-08-22T18:52:08.216Z · 7 entries*

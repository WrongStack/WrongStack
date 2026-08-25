# Learned instructions for `explore-companion`

> Project-specific learning data for the `explore-companion` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to avoid

<!-- learned-stamp: category=warning; capturedAt=2026-08-21T20:46:01.647Z; applied=226; wins=225 -->
- **- Treat role-memory i18n examples as perishable: re-grep `t('ns:key')` literals against `packages/webui/src/i18n/locales/*/` fresh each probe instead of repeating a prior "zero entries" flag. - In `packages/webui`, root-level `src/components/ChatView.tsx` is a 2-line re-export shim for `src/components/ChatView/index.tsx`; always edit the directory version, and don't confuse lookalikes `components/AgentTranscript.tsx` or `components/ui/tabs.tsx` with AgentTabs. - When no shell tool is registered, use mtime-ordered `glob packages/<pkg>/src/**/*.ts*` (single-pattern `ts*` suffix, no brace expans…**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `t('ns:key')`
  - *How:* `packages/webui/src/i18n/locales/*/`
  - *How:* `packages/webui`
  - *How:* `src/components/ChatView.tsx`
  - *How:* `src/components/ChatView/index.tsx`
  - *How:* `components/AgentTranscript.tsx`
  - *How:* `components/ui/tabs.tsx`
  - *How:* `glob packages/<pkg>/src/**/*.ts*`
  - *How:* `ts*`

<!-- learned-stamp: category=warning; capturedAt=2026-08-22T11:25:46.876Z; applied=739; wins=734 -->
- **Always grep the full `CallType` union in `packages/tools/src/codebase-index/schema.ts` before treating a todo's "type" clause as a gap — `type_ref` is emitted only by `ts-parser.ts`, never by tree-sitter `refRules` tables in `packages/tools/src/codebase-index/tree-sitter/queries.ts`, so WASM-language test todos need only `call`/`import`/`inherit`/`implement` assertions.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `CallType`
  - *How:* `packages/tools/src/codebase-index/schema.ts`
  - *How:* `type_ref`
  - *How:* `ts-parser.ts`
  - *How:* `refRules`
  - *How:* `packages/tools/src/codebase-index/tree-sitter/queries.ts`
  - *How:* `call`
  - *How:* `import`
  - *How:* `inherit`
  - *How:* `implement`

<!-- learned-stamp: category=warning; capturedAt=2026-08-21T18:52:31.629Z; applied=261; wins=259 -->
- **Before reporting a webui component as having no callers, read its sibling directory barrel/parent (e.g. `packages/webui/src/components/ChatView/index.tsx`) in full - `lazy(() => import(...))` and renamed imports never match a bare-symbol grep or incoming-calls, so only a parent-file read rules out hidden wiring. Always check `t('ns:key')` literals against whole-package locale resources (`grep` with glob `*.json` over `packages/webui`, not just `src`) before trusting that an i18n key resolves - keys like `activity:agents.tabsLabel` can have zero resource entries package-wide.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `packages/webui/src/components/ChatView/index.tsx`
  - *How:* `lazy(() => import(...))`
  - *How:* `t('ns:key')`
  - *How:* `grep`
  - *How:* `*.json`
  - *How:* `packages/webui`
  - *How:* `src`
  - *How:* `activity:agents.tabsLabel`

<!-- learned-stamp: category=warning; capturedAt=2026-08-21T20:34:09.873Z; applied=60; wins=60 -->
- **Grep for kill-related test coverage with precise tokens (`SIGKILL`, `killed-session`, `never-closed`) or word boundaries — bare `kill` matches `skills` across config-store/cloud-sync suites and floods results. When pre-mapping a "Tests:" todo, grep `it\('` names across the package's test dir first; behavior tests often live under grab-bag files whose name mismatches the symbol under test (e.g. `DefaultSessionStore.list()` kill-visibility coverage sits inside `session-store-extra.test.ts`, not a list-named file), so absence of a matching filename proves nothing about coverage.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `SIGKILL`
  - *How:* `killed-session`
  - *How:* `never-closed`
  - *How:* `kill`
  - *How:* `skills`
  - *How:* `it\('`
  - *How:* `DefaultSessionStore.list()`
  - *How:* `session-store-extra.test.ts`

<!-- learned-stamp: category=warning; capturedAt=2026-08-21T19:52:13.602Z; skill=node-modern; applied=55; wins=55 -->
- **Inside `packages/webui/vitest.config.ts`, two vitest projects split the suite surface: `browser-jsdom` includes `tests/**/*.test.{ts,tsx}` (excluding `tests/server/**`) so even pure DOM-free unit tests like `tests/components/chat-view-auto-collapse.test.ts` run under jsdom, while `tests/server/**` runs in the node project. Verify component unit suites with `cd packages/webui && npx vitest run <file>`; they never execute under the root config, which excludes `packages/webui/**`.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `packages/webui/vitest.config.ts`
  - *How:* `browser-jsdom`
  - *How:* `tests/**/*.test.{ts,tsx}`
  - *How:* `tests/server/**`
  - *How:* `tests/components/chat-view-auto-collapse.test.ts`
  - *How:* `cd packages/webui && npx vitest run <file>`
  - *How:* `packages/webui/**`

<!-- learned-stamp: category=warning; capturedAt=2026-08-21T19:15:30.282Z; applied=72; wins=72 -->
- **Never infer a missing key in a locale catalog from aligned line offsets — top-level section ORDER differs between locale copies of the same namespace (e.g. `connection` sits at in `en/activity.json` but in `tr/activity.json`); grep the quoted section name across `packages/webui/src/i18n/locales/*/activity.json` instead before reporting drift.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `connection`
  - *How:* `en/activity.json`
  - *How:* `tr/activity.json`
  - *How:* `packages/webui/src/i18n/locales/*/activity.json`

<!-- learned-stamp: category=warning; capturedAt=2026-08-21T19:25:21.130Z; applied=72; wins=72 -->
- **Never report "no callers" from a zero-hit `codebase-incoming-calls` result alone — the ref graph misses symbols even in ordinary CLI source (e.g. `runAsMain` in `packages/cli/src/cli-entry-point.ts` had 0 indexed hits while `packages/cli/src/index.ts:6,8` imports and calls it). Confirm with rg exact-text search over `packages/**/*.ts` before stating caller counts.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `codebase-incoming-calls`
  - *How:* `runAsMain`
  - *How:* `packages/cli/src/cli-entry-point.ts`
  - *How:* `packages/cli/src/index.ts:6,8`
  - *How:* `packages/**/*.ts`
  - *How:* `packages/cli/src/index.ts`

<!-- learned-stamp: category=warning; capturedAt=2026-08-22T07:22:49.756Z; skill=typescript-strict; applied=277; wins=277 -->
- **Never use `codebase-incoming-calls` on generic overloaded symbol names like `create` in WrongStack - the ref graph returns cross-file noise (91 same-named symbols) and its `file` filter cannot disambiguate methods of one class. Fall back to a targeted grep such as `(sessionStore|store)\.create\(` over `packages/**/src` and filter test files by name instead.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `codebase-incoming-calls`
  - *How:* `create`
  - *How:* `file`
  - *How:* `(sessionStore|store)\.create\(`
  - *How:* `packages/**/src`

---
*Last capture: 2026-08-22T11:25:46.876Z · 8 entries*

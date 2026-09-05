# Learned instructions for `explore`

> Project-specific learning data for the `explore` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to avoid

<!-- learned-stamp: category=warning; capturedAt=2026-08-29T12:07:54.956Z; applied=81; wins=81 -->
- **- Always filter `slash-commands/index` importer greps to the owning package path (`packages/cli`, `packages/plug-lsp`, `packages/telegram`) — each package owns a same-named `slash-commands/index.ts`, so unscoped `grep slash-commands/index` caller sets include 4+ cross-package false positives in WrongStack. - Do not trust `codebase-skeleton` on import-dominated composition-root files (e.g. `packages/cli/src/slash-commands/index.ts` collapsed 215 lines to 1 at 99.6% "savings"); when the skeleton result looks degenerate, fall back to a full `read` before citing exports.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `slash-commands/index`
  - *How:* `packages/cli`
  - *How:* `packages/plug-lsp`
  - *How:* `packages/telegram`
  - *How:* `slash-commands/index.ts`
  - *How:* `grep slash-commands/index`
  - *How:* `codebase-skeleton`
  - *How:* `packages/cli/src/slash-commands/index.ts`
  - *How:* `read`

<!-- learned-stamp: category=warning; capturedAt=2026-08-22T09:38:36.469Z; applied=19; wins=19 -->
- **Always check importers *before* mapping or editing any `project-server-*.ts` helper in `packages/tools/src/codebase-index/` — grep both the exported symbol names (`ServerQueryCaches`, `staleAwareRead`) **and** the module basename (`project-server-query-cache`), because some of these files are extraction drafts that were never wired into `project-server.ts`, which still carries the inline original. A symbol-only grep can miss the module-path import form and vice versa; run both before concluding a file is live or dead.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `project-server-*.ts`
  - *How:* `packages/tools/src/codebase-index/`
  - *How:* `ServerQueryCaches`
  - *How:* `staleAwareRead`
  - *How:* `project-server-query-cache`
  - *How:* `project-server.ts`

<!-- learned-stamp: category=warning; capturedAt=2026-08-21T19:06:14.197Z; applied=79; wins=79 -->
- **Always trace a `packages/core/src/storage/*` helper's consumers by grepping its module basename first (e.g. `grep session-write-buffer`) — storage helpers there typically have exactly one importer (e.g. `session-write-buffer.ts` ← `file-session-writer.ts`), so one hop plus one `new X` grep usually completes the dependency picture without broad exploration. Never treat `codebase-incoming-calls` import/type_ref entries as call sites alone — pair them with a targeted `read` of the constructor and producer methods to distinguish ownership (who creates the object) from usage (who feeds it).**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `packages/core/src/storage/*`
  - *How:* `grep session-write-buffer`
  - *How:* `session-write-buffer.ts`
  - *How:* `file-session-writer.ts`
  - *How:* `new X`
  - *How:* `codebase-incoming-calls`
  - *How:* `read`

<!-- learned-stamp: category=warning; capturedAt=2026-08-26T07:31:22.592Z; skill=node-modern; applied=2; wins=2 -->
- **Always treat `@wrongstack/simpleui` grep hits as suspect until checked against `packages/cli/src/simpleui-dist.ts` — that file resolves the package by **path string** (`resolvePackageJson('@wrongstack/simpleui/package.json')`) for static-asset serving, so it looks like a barrel consumer but never imports the module. The simpleui barrel (`packages/simpleui/src/index.ts`) has zero in-repo importers by design: the package is consumed only as a built Vite `dist/` asset.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `@wrongstack/simpleui`
  - *How:* `packages/cli/src/simpleui-dist.ts`
  - *How:* `resolvePackageJson('@wrongstack/simpleui/package.json')`
  - *How:* `packages/simpleui/src/index.ts`
  - *How:* `dist/`
  - *How:* `wrongstack/simpleui/package.json`

<!-- learned-stamp: category=warning; capturedAt=2026-08-22T09:30:41.957Z; applied=2; wins=2 -->
- **When tracing callers of `incomingCallsService`, `outgoingCallsService`, `packageGraphService`, `fileGraphService`, or `symbolGraphService` in the WrongStack repo, always disambiguate between the **sync** implementations in `packages/tools/src/codebase-index/index-service.ts` and the **async shadowing wrappers** with identical names exported from `packages/tools/src/codebase-index/background-indexer.ts` (and re-exported via the `./codebase-index/index` barrel) — the package barrel exports only the wrappers, so external consumers never touch the sync originals directly.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `incomingCallsService`
  - *How:* `outgoingCallsService`
  - *How:* `packageGraphService`
  - *How:* `fileGraphService`
  - *How:* `symbolGraphService`
  - *How:* `packages/tools/src/codebase-index/index-service.ts`
  - *How:* `packages/tools/src/codebase-index/background-indexer.ts`
  - *How:* `./codebase-index/index`

<!-- learned-stamp: category=warning; capturedAt=2026-08-28T06:34:49.099Z; applied=80; wins=80 -->
- **When tracing importers of a module in `packages/webui/src/stores/`, always run one extra grep of the bare basename scoped to `packages/webui/src/stores/` in addition to the `stores/<name>` specifier pattern — intra-store importers use relative specifiers (`./session-lanes`, `./session-lanes.js`) that the `stores/<name>` pattern never matches, and in this repo those relative importers (`session-store.ts`, `session-tab-store.ts`) are usually the heaviest dependents. Pair with `codebase-incoming-calls` import hints to catch what the specifier greps miss.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `packages/webui/src/stores/`
  - *How:* `stores/<name>`
  - *How:* `./session-lanes`
  - *How:* `./session-lanes.js`
  - *How:* `session-store.ts`
  - *How:* `session-tab-store.ts`
  - *How:* `codebase-incoming-calls`

<!-- learned-stamp: category=warning; capturedAt=2026-08-28T06:42:52.331Z; applied=112; wins=112 -->
- **When tracing importers of any module under `packages/webui/src/` (not just `stores/`), grep the bare basename repo-wide in addition to specifier patterns — sibling-directory consumers use relative specifiers (`./useChatViewState`) that `components/<name>` style patterns never match; in this repo the bare-basename grep plus `codebase-incoming-calls` together resolved the full consumer set in one pass (`useChatViewState` had exactly one: `ChatView/index.tsx`).**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `packages/webui/src/`
  - *How:* `stores/`
  - *How:* `./useChatViewState`
  - *How:* `components/<name>`
  - *How:* `codebase-incoming-calls`
  - *How:* `useChatViewState`
  - *How:* `ChatView/index.tsx`

---
*Last capture: 2026-08-29T12:07:54.956Z · 7 entries*

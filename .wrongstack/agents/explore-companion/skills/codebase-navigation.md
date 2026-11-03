## Counter Modules (`packages/sage/src/sqlite-store-counters.ts`)
…

## CLI Module Disambiguation

- `packages/cli/src/cli-main-helpers.ts`: close consumers with a repo-wide grep of the bare module name (all hits land in `packages/cli`). Despite the filename, `cli-main.ts` is **not** an importer; production consumers are only `src/wiring/*` plus `cli-infrastructure.ts`, plus `vi.mock` shape couplings in `tests/cli-infrastructure.test.ts` and `tests/zero-statement-cli-modules.test.ts`. `governanceRuntimeEnabled`, `governedHandle`, and `WRONGSTACK_GOVERNANCE_ENV` are test-only exports; `bootstrapCliGovernance` is production-reachable only through `setupCliGovernance` within the same file; expect a parallel duplicate of `WRONGSTACK_GOVERNANCE_ENV` in `packages/webui-server/src/server/governance-runtime.ts`.
- `packages/cli/src/wiring/vector-memory-setup.ts`: grep exported symbol names (`setupVectorMemory`, `DEFAULT_VECTOR_WEIGHT`, `VectorMemoryTuning`) alongside the module specifier. `setupVectorMemory` near-collides with webui-server's `setupVectorMemoryMirror` (`packages/webui-server/src/server/start-webui-vector.ts`); `DEFAULT_VECTOR_WEIGHT = 0.3` is independently re-declared in `packages/sage/src/retrieval/vector-augment.ts` and `packages/vector-memory/src/sage-fusion.ts`; `packages/cli/tests/wiring-teardown-registrar.test.ts` enforces LIFO teardown ordering with zero import link.
- `session-registry`: three unrelated modules share the filename — `packages/cli/src/wiring/session-registry.ts` (`setupSessionRegistry`), `packages/core/src/session-catalog/session-registry.ts` (`SessionRegistry`, re-exported incl. as `LegacySessionRegistry` from `packages/core/src/storage/index.ts`), and `packages/webui-server/src/server/collab/session-registry.ts` (`CollabSessionRegistry`). Close the CLI module with `wiring/session-registry(\.js)?` specifier + `setupSessionRegistry`/`SessionIdentityTarget` symbol greps. `packages/webui-server/src/server/standalone-session-identity.ts`'s same-name `SessionIdentityTarget` is a separate twin, not a consumer.
- `boot.ts`: three same-name modules — `packages/cli/src/boot.ts`, `packages/core/src/boot.ts` (`bootConfig`, `flagsToConfigPatch`, `assertProjectRootOutsideStateDir`, `cleanupStaleProjects`), and `packages/webui-server/src/server/boot.ts` (`bootConfig`, `patchConfig`). All match a bare `/boot.js` module-specifier grep. Close real consumers with a package-scoped specifier grep (`packages/cli/src/**` for `['"][^'']*\bboot(\.js)?["']`). Treat `codebase-incoming-calls` hits on symbol `boot` as noise when the caller file lacks that import — `packages/cli/src/cli-main.ts` declares a local `const boot = await bootCliRuntime(...)`.

## Mailbox `unreadCount` Collisions

## WrongForge Error Prefix

## Kanban WebUI Cross-Pin

- For `packages/webui-server/src/server/kanban-*.ts`, grep for cross-package source-pin tests that read the file's raw text — e.g. `packages/webui/tests/lib/kanban-board-active.test.ts` `readFileSync`-es `packages/webui-server/src/server/kanban-route-pagination.ts` and asserts `isActive` matches the client twin `packages/webui/src/lib/kanban-board-active.ts`, so logic edits there fail a test in another package with zero import links. Close consumers via the `kanban-routes.js` barrel (`server/index.ts` re-exports `KanbanBoardPage`/`paginateKanbanBoards` as public API) — module-specifier greps on the paginated file alone undercount.

## TUI Markdown Test-Only Export

- For `packages/tui/src/markdown-table.ts`, treat `renderMarkdownTables` as test-only — it is ratcheted in `architecture/test-only-exports.json` and only three test files import it. The production path is `packages/tui/src/markdown.tsx` `MarkdownViewImpl` calling `detectTable`/`renderTable` directly. No barrel re-exports the module (`packages/tui/src/index.ts` re-exports only `parseInline` from `markdown.js`).

_(truncated at 6144 bytes)_

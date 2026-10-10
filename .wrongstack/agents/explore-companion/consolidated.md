# explore-companion Role Instructions

## Evidence and Reporting

- Submit findings with `submit_result`; this role has no submission `mailbox`. Keep fields ASCII-only; on validation failure, shorten narrative and `files_examined` before dropping evidence.
- Separate confirmed dependencies, behavioral coupling, historical references, and inconclusive checks. Tool errors, ignored paths, stale indexes, truncation, denied reads, and unvalidated zero-hit searches do not prove absence.
- Read named targets directly. Treat `codebase-skeleton`, `codebase-impact-analysis`, and `codebase-incoming-calls` as leads, not authority; verify declarations, imports, re-exports, and runtime wiring yourself.
- Revalidate prior "zero importers" findings on every invocation with module-path and exported-symbol searches; sessions live-edit this tree, so a first-round hit followed by zero is concurrent editing, not tool failure.
- Never retry or bypass denied reads of `.npmrc`, `.env*`, `.pypirc`, or `.netrc`; report the restriction.
- Report `files_with_matches` counts and read enclosing ranges when content output is capped (~3 matches/file); grep alternation patterns over 256 chars fail with `VALIDATION_ERROR` — split symbol sets.
- When a probe quotes a todo item's wording verbatim, search `packages/core/skills/**/SKILL.md` first: the owning skill holds the acceptance contract, not just file locations.

## Consumer Closure

- Classify the target before choosing tools: type-only modules, top-level scripts, tests, configuration, JSON baselines, and logs require search or runner evidence, not call graphs.
- Close source consumers with repo-wide module-path/subpath, relative-specifier, and per-exported-symbol greps, including dynamic `import('...')` and inline `type` expressions — none appear in call graphs. Close multi-export modules per symbol: a module can have many importers while one export is test-only or ratcheted (`architecture/test-only-exports.json`).
- Classify every grep hit by its full import specifier before attributing it. Substring collisions (`tool-schema` also matches `tool-schema-helpers.js`, `kanban-tool-schema.js`) and repo-duplicated symbols (`slugify` exists independently in `packages/core/src/utils/slug.ts`, `wstack-paths.ts`, `packages/kanban/src/manager/basic-helpers.ts`, `build-prompts.mjs`; `codebase-incoming-calls` floods with "symbol exists in multiple files") misattribute — resolve by import source.
- Never use `codebase-incoming-calls` for hyper-generic symbols, barrel-mediated symbols, or type-only seams (`import type`, `Pick<Port, 'method'>`, `Parameters<typeof useHook>[0]`); grep is authoritative.
- Follow barrels and facades: check `package.json` `exports` and the actual re-export form. A barrel that never re-exports a module (e.g. `packages/mcp/src/index.ts` → `client-stdio-protocol.ts`, `tool-schema.ts`) makes it internal-only; `export * from` makes new exports public automatically, named-list barrels do not. External sage consumers import via `@wrongstack/sage`, not module paths.
- Alias-substituted test fixtures have zero static importers by design: close them by grepping the swapped specifier strings in package source (Vite `resolve.alias` exact entries, e.g. `./ws.js` / `../lib/ws.js` against `packages/simpleui/src`), separating value imports from type-only imports the alias never touches.
- Enumerate files with case-sensitive `files_with_matches` and `truncated=false`; when content output shows `count=N` but few matches, read the enclosing range instead of retrying patterns.
- Search source strings, subprocess arguments, `spawn`/`exec` bodies, and non-TypeScript harnesses; comments, lockfile sites, glossary ratchets, and `docs/archive/**` are documentation, not consumers. Dependency-removal provenance needs `pnpm-lock.yaml` `importers`/`packages`/`snapshots` entries plus a grep of human-readable brand names.
- Behavioral ratchets exist without static importers: env-var test seams (`WRONGSTACK_*` vars read by a spawning daemon) and distinctive assertion literals matching only one spec — that spec is then the sole regression ratchet.
- Confirm package-manager state against **root** `pnpm-lock.yaml`/`pnpm-workspace.yaml`/`package.json` `packageManager`; `packages/techstack/tests/fixtures/monorepo-pnpm/` hits are test-fixture decoys.

## Scratch Rounds (`.temp_files/`)

- `rg` and the codebase index respect `.gitignore` and skip `.temp_files/` entirely — a zero-hit repo-wide grep proves nothing there. Map `.temp_files/proof-driven-bug-hunter/<round>/` scripts with direct `read`, a `tree` of the round dir, and a repo-wide grep of the script's hardcoded needle strings (e.g. `SCRUBBED_FREE_TEXT_FIELDS` → `packages/core/tests/storage/session-scrub-parity.test.ts`).
- Tree the **parent** `.temp_files/proof-driven-bug-hunter/` directory (check `total_files`) to rule out a sibling `run.mjs` or shared runner; if the subtree is script-only, invoke the proof directly by path (`vitest.proof.config.mjs`, `proof.test.ts`).
- Capture the full content of a round target on the first successful read: concurrent sessions delete round dirs mid-probe, and a mid-probe ENOENT is concurrent-edit evidence — verify once with a parent-dir tree, then report the captured content instead of retrying reads. If all needle strings are absent from the target, the script already ran and a re-run will fail closed.

## Project Wiring Anchors

- `architecture/*.json` files are data ratchets; `architecture/core-public-api-usage.json` records each source file's `@wrongstack/core/*` imports repo-wide — grep it for the target path before assessing edit risk; changes require root `check:architecture` / `check:architecture:sync`. Trace other ratchet files to their guarding scripts and re-sync commands.
- `packages/webui-server/src/server/*-adapter.ts` modules may mirror CLI behavior through `@wrongstack/core/*` without importing CLI code — close by symbol grep plus barrel/facade reads. `goal-ws-handler-*.ts` siblings are contract-driven and break silently at type seams.
- `packages/sage` keeps two parallel pagination modules (`shared/pagination.ts` and `sqlite-store-pagination.ts`) with duplicate `decodePageCursor`/`PageCursor` exports; the SQLite list path imports the sibling's version, and the shared module's `decodePageCursor`/`compareByUpdatedDesc`/`CONTEXT_STATUSES` have zero production importers — grep both modules, close per symbol.
- `packages/sage/src/project-server-*.ts` helpers bind to env-driven daemon behavior in tests — close with module-stem + symbol greps plus a full barrel read before declaring internal-only.
- `packages/sdd`/`packages/telegram` symbols appearing in domain-glossary ratchets or as construction sites inside the plugin-entry barrel (`new PollLock(...)` in `src/index.ts`) are not module consumers; check the barrel's re-export form before "public API" language.
- Core `atomic-write.ts` is a thin adapter (`createLockTimeoutError` over `FsError`) on `packages/persistence` primitives, shared with `packages/kanban/src/utils/atomic-write.ts`; `packages/persistence/tests/adapter-conformance.test.ts` ratchets both adapters.
- `packages/providers/src/error-parse.ts` is widely imported, but individual exports (`retryAfterMsFromBody`) may have zero production callers — verify per symbol.
- Close `packages/cli/src/subcommands/` handlers through the lazy-import registry in `subcommands/index.ts` plus filename and symbol searches. Verify slash-command test `vi.mock('../src/.../<module>.js')` paths against live imports; stale mocks intercept nothing.
- WebUI route views register in `packages/webui/src/components/view-registry.ts`; HQ views in `packages/webui-hq/src/components/hq/view-router.tsx`. Keep `@xyflow/react` inside HQ lazy chunks; check `packages/webui-hq/tests/components/views-smoke.test.tsx`.
- `packages/kanban/src/types.ts`: external access is via the `@wrongstack/kanban` barrel, not a `./types` subpath — use quote-anchored relative-specifier searches.

_(truncated at 8192 bytes — the next optimization pass must shorten it)_
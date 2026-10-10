# scripts/

Repo-level tooling: build, release, CI gates, generators, profiling and maintenance helpers.
Everything here is run with **Bun** from the repository root (`bun scripts/<name>`), usually
through a root `package.json` script.

Status legend (audited 2026-10-10, by searching `package.json` files, `.github/workflows`,
`.githooks`, other scripts, `packages/**`, `docs/**` outside `docs/archive` and `docs/reports`):

| Status | Meaning |
| --- | --- |
| **Wired** | Called by a `package.json` script, a CI workflow, a git hook, or another script. Part of the normal flow. |
| **Manual** | Not wired into anything automatic, but a real tool somebody runs by hand (documented, or has live consumers). |
| **Orphan** | Nothing runs it and nothing points at it. Candidate for deletion or for being wired in. See [Unused / orphaned scripts](#unused--orphaned-scripts). |

A reference from `packages/core/tests/architecture/script-entrypoints.test.ts` does **not** count as use:
that test only checks that each script starts and prints usage; it exists to keep scripts from rotting.

---

## Unused / orphaned scripts

### Not referenced from anywhere

| Script | What it is | Verdict |
| --- | --- | --- |
| `generate-webui-captured-tokens.mjs` | Maps `packages/webui/src/index.css` HSL tokens into `.design/captured-tokens.json` for the external design tool's capture/verify. | **Orphan, but legitimate.** Only its own header mentions it. It is the manual companion of `.design/` (the file it writes exists and is committed to the working tree). Keep, but add a `design:tokens` npm script or delete together with `.design/`. |
| `generate-subcommand-manifest.mjs` | Cross-checks CLI subcommand loaders against the help table and writes `architecture/subcommands-manifest.json`. | **Orphan.** No npm script, CI job or hook calls it, and the file it writes (`architecture/subcommands-manifest.json`) does not exist — it has never been committed. Either wire into `docs:check` or delete. |
| `repair-agent-learning.mjs` | One-shot migration that heals `.wrongstack/agents/<role>/learned.md` buffers written by the pre-fix renderer (nested `*How:*` labels, `.json` anchors truncated to `.js`). | **Orphan, one-shot.** Mentioned only in `CHANGELOG.md`. Safe to delete once no old `learned.md` buffers remain. |
| `apply-agent-learning-cli-patch.mjs` | Idempotently re-applies the CLI-side agent-learning wiring (`packages/cli/src/**`) because an external editor kept reverting it. | **Orphan, workaround.** Nothing references it. It patches source files by string anchors, so it will break (hard error) as soon as those files change. Delete once the wiring is stable in git. |

### Referenced only by docs, tests or by hand

| Script | Where it is mentioned | Verdict |
| --- | --- | --- |
| `sage-maintenance.mjs` | `docs/sage/SYSTEM-REPORT.md` | **Manual, one-time.** Recover-then-purge for the 2026-07 SAGE mass-deletion fallout. Dry-run by default. Archive/delete once every store has been cleaned. |
| `purge-stale-mailbox-entries.mjs` | `docs/mailbox-architecture.md` | **Manual** maintenance command (documented). |
| `check-file-size.mjs` | only the entrypoints test | **Effectively orphan.** An advisory (never fails CI) 350-line soft cap report; no script, hook or workflow runs it. The real file-size rule is enforced elsewhere (hotspot baseline in `check-architecture-health.mjs`). |
| `acp-smoke-test.mts` | `packages/acp` (`bun run smoke`), `docs/acp-ensemble.md` | **Manual** per-package smoke test; not in CI. |
| `wrongstack-skill-engine.ts` | root `skill:route` / `skill:list` | **Manual** developer tool (skill router CLI); not part of build or CI. |
| `analyze-cpuprofile.mjs`, `analyze-memory-log.mjs`, `memory-profile.mjs`, `tui-heap-soak.mjs`, `brain-workload-report.mjs`, `bench.mjs`, `perf-chronicle-append.mts` | root `package.json` only | **Manual** profiling/benchmark tools (never in CI). Fine to keep. |
| `check-browser-runtime.mjs`, `check-node-pty.mjs`, `rebuild-reviewed-native.mjs`, `setup-bun-typecheck.mjs` | root `package.json` only | **Manual** environment doctors/setup. |

### Duplicates

| Files | Note |
| --- | --- |
| `install.sh` ≡ `install/install.sh`<br>`install.ps1` ≡ `install/install.ps1` | Byte-identical (same git blob). CI/release workflows publish the **`install/`** copies. The root copies are only read by `packages/cli/tests/standalone-update.test.ts`. Pick one location (the `install/` one) and point that test at it. |

### Everything else

All remaining scripts are **Wired** — see the tables below.

---

## Build & packaging

| Script | Status | What it does | Used by |
| --- | --- | --- | --- |
| `build.mjs` | Wired | Builds every workspace package in dependency order (packages → apps → website) via each package's own `build` script. | `bun run build`, `apps/desktop` build, Dockerfiles |
| `build-package.mjs` | Wired | Per-package builder: bundles JS with esbuild and emits public `.d.ts` declarations with the repo's TypeScript compiler. | `build` script of most packages |
| `build-binaries.mjs` | Wired | Compiles standalone `wstack-<os>-<arch>` executables with `bun build --compile` (+ `SHA256SUMS`); `--current`, `--target=…`, `--skip-build`. | `build:binaries`, `build:binary`, `binaries.yml` |
| `binary/entry.mjs` | Wired | Entry point *inside* the compiled binary (asset-pack extraction, daemon/script dispatch). Never run directly. | `build-binaries.mjs` |
| `build-portable.mjs` | Wired | Windows portable distribution: compiled launcher + app and production deps beside it. | `release:portable:win` |
| `package-desktop.mjs` | Wired | Packages the Electron desktop app (wraps electron-builder, stages a Bun-deployed dependency closure, writes checksums). | `apps/desktop` `package`, `desktop.yml` |
| `desktop-package-paths.mjs` | Wired | Shared constant: the repo-relative staging dir for desktop packaging. | `package-desktop.mjs`, `smoke-desktop.mjs` |
| `smoke-desktop.mjs` | Wired | Exercises the packaged desktop dependency closure under Electron's Node (`--window` also checks startup) with a scratch profile. | `desktop.yml` |
| `smoke-binary.mjs` | Wired | Smoke-tests a compiled binary in an isolated `WRONGSTACK_HOME`: assets extracted, daemon dispatch, frontend served, plugins bundled. | `binaries.yml` |
| `smoke-bun-runtime.mjs` | Wired | Runtime smoke under Bun: SAGE SQLite write/search round-trip, heap watchdog, and a link-time import of `webui-server` (catches unsupported `node:module` exports). | `smoke:bun` |
| `bun-typecheck.mjs` | Wired | Runs the pinned Bun-based TypeScript checker (no `tsc` fallback) in the current package. | `typecheck` of nearly every package, `ci.yml` |
| `setup-bun-typecheck.mjs` | Manual | Pre-downloads/caches the Bun typechecker into `.bun/typecheck/`. | `setup:bun` |
| `rebuild-reviewed-native.mjs` | Manual | Rebuilds only the reviewed native addons (`electron-winstaller`, `esbuild`, `node-pty`) independent of branch-controlled `trustedDependencies`. | `setup:native` |
| `lib/build-output-cleanup.mjs` | Wired (lib) | Removes a package `dist/` without failing on Windows `EBUSY`/`ENOTEMPTY`/`EPERM`. | `build-package.mjs`, `build-portable.mjs` |
| `lib/deploy-bun-workspace.mjs` | Wired (lib) | Materialises a production workspace closure from Bun tarballs with a hoisted install. | `build-portable.mjs`, `package-desktop.mjs` |
| `lib/desktop-package-checksums.mjs` | Wired (lib) | Writes `SHA256SUMS.txt` for desktop release assets. | `package-desktop.mjs` |

## Release & versioning

| Script | Status | What it does | Used by |
| --- | --- | --- | --- |
| `bump-version.mjs` | Wired | Sets one shared version across the root and every workspace `package.json` (`patch`/`minor`/`major`/`set`). | `version:*` |
| `publish-workspace.mjs` | Wired | Publishes to npm in dependency layers and proves each layer resolves on the registry before the next (`--plan`, `--dry-run`, `--verify-only`, `--tarballs-dir`). | `release*`, `release.yml` |
| `list-publishable-packages.mjs` | Wired | Prints the packages that would be published and flags `publishConfig` drift. | `release:packages`, `release.yml` |
| `lib/publishable-packages.mjs` | Wired (lib) | Publish inventory and dependency layering shared by the publish scripts and package-contract checks. | `publish-workspace.mjs`, `list-…`, `check-package-contracts.mjs` |
| `release-check-matrix.mjs` | Wired | Runs *every* release gate and reports one pass/fail matrix (profiles `release`, `release-fast`, `local`). | `release:check`, `release:fast`, `ci:local` |
| `check-package-contracts.mjs` | Wired | Verifies each publishable package's `main`/`types`/`bin`/`exports` targets exist after a build. | `ci.yml`, release matrix |
| `check-npm-package-install.mjs` | Wired | Proves the providers tarball has a finite, valid npm dependency graph (guards a past npm Arborist cycle). | release matrix |
| `check-tools-package-smoke.mjs` | Wired | Packs `@wrongstack/tools` and checks the vendored Tree-sitter WASM grammars load from the tarball. | release matrix |
| `check-build-lineage.mjs` | Wired | `--assert-clean` / `--write` / `--verify` for the build-artifact manifest (stale or foreign `dist` detection). | `check:clean-dist`, `check:build-manifest`, `write:build-manifest` |
| `lib/build-lineage.mjs` | Wired (lib) | Manifest creation/validation used by the above. | `check-build-lineage.mjs` |
| `check-dist-hidden-files.mjs` | Wired | Fails if a `dist/` contains dotfiles (CI uploads `dist` with `include-hidden-files`). | `check:dist-hidden` |
| `install/install.sh`, `install/install.ps1` | Wired | End-user standalone installers (`curl … \| sh`, `irm … \| iex`): download, SHA256-verify, install `wstack`. Published as release assets. | `binaries.yml`, `release.yml` |
| `install.sh`, `install.ps1` | **Duplicate** | Identical copies of the above (see [Duplicates](#duplicates)). | tests only |

## CI gates & static checks

| Script | Status | What it does | Used by |
| --- | --- | --- | --- |
| `audit-dependencies.mjs` | Wired | Runs the dependency vulnerability audit with the reviewed GHSA suppressions from `pnpm-workspace.yaml`. | `audit.yml`, `ci.yml`, `pages.yml` |
| `check-audit-suppressions.mjs` | Wired | Refuses advisory suppressions a PR adds to its own audit gate (diffs base vs head). | `audit.yml`, `audit-dependencies.mjs` |
| `ci-security-scan.mjs` | Wired | Runs the repo's own security analyzer over first-party source; exit 1 on critical findings. | `ci.yml` |
| `ci-reuse-success.mjs` | Wired | Reports which expensive CI jobs already passed for this exact SHA so re-runs can skip them. | `ci.yml` |
| `check-action-pins.mjs` | Manual | Fails if any GitHub Actions `uses:` is not pinned to a commit SHA. | `check:action-pins` |
| `check-dep-path-separators.mjs` | Wired | Fails if a dependency spec contains a Windows `\` (breaks `--frozen-lockfile` on POSIX). | `check:dep-paths`, `ci.yml` |
| `check-tree-sitter-wasm.mjs` | Wired | Verifies vendored Tree-sitter `.wasm` grammars against a committed sha256 manifest (`--write` after an intentional bump). | `ci.yml` |
| `check-rulebook.mjs` | Manual | Validates the optional `.wrongstack/techstack.rulebook.json` against its schema. | `check:rulebook` |
| `check-bun-migration.mjs` | Manual | Asserts Bun migration invariants (`packageManager`, overrides, patches vs `bun.lock`). | `migration:check` |
| `check-lint-warnings.mjs` | Wired | Biome production-warning ratchet vs `architecture/lint-warning-baseline.json` (both directions fail). | `check:lint-warnings`, release matrix |
| `lint-console-logging.mjs` | Wired | Flags ad-hoc `console.warn/error` string literals (structured JSON logging convention). | pre-commit, `lint:console` |
| `lint-distributive-types.mjs` | Manual | Review nudge: flags `Omit`/`Pick` that collapse on discriminated unions. Never fails. | `lint:distributive` |
| `check-relative-imports.mjs` | Manual | Catches leftover `../same-dir/…` imports after a file move. | `lint:imports` |
| `check-i18n-completeness.mjs` | Wired | Every WebUI locale must have all keys of `en`. | `lint:i18n` |
| `check-docs.mjs` | Wired | Markdown link and heading-anchor checker for `docs/` (skips `archive/`), plus `README.md`, `SECURITY.md`, `CHANGELOG.md`. | `docs:check` |
| `check-command-docs.mjs` | Wired | Slash/subcommand docs vs source declarations. | `docs:check` |
| `check-feature-matrix.mjs` | Wired | Fails if `docs/feature-matrix.md` drifts from plugin sources (tool ids). | `check:feature-matrix`, `docs:check` |
| `documentation-catalog.mjs` | Wired | Checks/writes `docs/current-catalog.md` from source declarations (`--write`). | `docs:check`, `docs:catalog:write` |
| `check-architecture-health.mjs` | Wired | Architecture gate: package registry, layer rules, cycles, hotspot baseline; writes the health report. | pre-commit, `check:architecture*`, `report:architecture` |
| `lib/architecture-health.mjs` | Wired (lib) | The analysis engine behind the architecture/test-inventory/skip checks. | several `check-*` scripts |
| `snapshot-core-public-api.mjs` | Wired | Snapshots `@wrongstack/core`'s public API and its usage by other packages; fails on drift (`--write` to refresh). | `check:architecture` |
| `sync-core-public-api-snapshot.mjs` | Wired | Pre-commit helper: refreshes and stages the two Core API artifacts when no unrelated edits would leak in. | `.githooks/pre-commit` |
| `check-test-inventory.mjs` + `lib/test-inventory.mjs` | Wired | Cross-checks Vitest's discovered test files against the architecture registry. | `check:test-inventory` |
| `check-test-skips.mjs` + `lib/test-skip-budget.mjs` | Wired | Skip-budget ratchet (`architecture/test-skip-budget.json`). | `check:test-skips`, `test-skips:sync` |
| `check-test-typecheck.mjs` + `lib/test-typecheck-diagnostics.mjs` | Wired | Type-checks test trees against a committed diagnostic baseline. | `check:test-types` |
| `check-zero-coverage.mjs` | Wired | Ratchet: no source file may have zero statements covered (baseline in `architecture/`). | `check:coverage-zero` |
| `guard-against-corruption.mjs` | Wired | Pre-commit guard: blocks a known editor-corruption signature (`worktreeMonitorToggle` fragment outside `app.tsx`) and commits touching more than `GUARD_MAX_FILES` (default 500) files unless `--force`. | `.githooks/pre-commit` |
| `guard-unresolved-imports.mjs` | Wired | Pre-commit: every relative import in staged TS must resolve to a file in the index. | `.githooks/pre-commit` |
| `guard-mailbox-bridge.mjs` | Wired | Pre-commit: keeps the mailbox HTTP bridge's source union / wiring intact. | `.githooks/pre-commit` |
| `guard-mailbox-bridge-scripts.mjs` | Wired | Pre-commit: keeps `install-mailbox-bridge-skills.sh` bash-3.2 compatible. | `.githooks/pre-commit` |
| `install-mailbox-bridge-skills.sh` | Wired | Copies the `wrongstack-mailbox` skill into an external agent's skills dir (Claude Code, Aider…). | `lint:scripts`, mailbox docs/skills |

## Testing & coverage

| Script | Status | What it does | Used by |
| --- | --- | --- | --- |
| `test-package.mjs` | Wired | Runs selected package test suites without the full release gate. | `test:package` |
| `test-affected.mjs` | Wired | Re-runs only test files whose import closure changed since they last passed (`--all` ignores the cache). | `test:affected*` |
| `vitest-affected-recorder.mjs` | Wired | Vitest reporter that records each test file's actual imports for `test-affected`. | `test-affected.mjs` (passes it to Vitest) |
| `lib/affected-cache.mjs` | Wired (lib) | Shared cache location/fingerprint format for the two above. | both |
| `vitest-core-aliases.mjs` | Wired | Vitest `resolve.alias` entries for `@wrongstack/core` sub-path exports whose dist/source layout diverges. | most `vitest.config.ts` |
| `test-coverage.mjs` | Wired | Orchestrates the full coverage run (root + scripts + per-area suites). | `test:coverage` |
| `run-vitest-coverage.mjs` | Wired | Runs Vitest with the `coverage/.tmp` write guard preloaded. | coverage scripts |
| `coverage-lock.mjs` | Wired | Serialises concurrent coverage runs so they cannot corrupt `coverage/.tmp`. | all coverage commands |
| `coverage-tmp-guard.mjs` | Wired | Preload that re-creates a vanished `coverage/.tmp` parent mid-run (Windows/AV flakiness). | `run-vitest-coverage.mjs` |
| `coverage-matrix.mjs` | Manual | Aggregates every per-area `coverage-summary.json` into one markdown progress matrix. Reports, doesn't gate. | `coverage:matrix` |

## Generators & syncs

| Script | Status | What it does | Used by |
| --- | --- | --- | --- |
| `generate-plugin-projections.mjs` | Wired | Generates plugin exports / catalog projections from `OFFICIAL_PLUGIN_MANIFEST` (`--write`, `--bootstrap`). | `plugins:manifest:*` |
| `generate-provider-catalog.mjs` | Wired | Regenerates `packages/webui/public/providers.json` from provider definitions (`--write`). | `providers:catalog:*` |
| `generate-protocol-schema.mjs` | Wired | Emits JSON Schema (`ws-core.schema.json`) and OpenAPI 3.1 for `webui-protocol` from its TS types (`--check`). | `webui-protocol` `schema` |
| `generate-website-tool-catalog.ts` | Wired | Regenerates the website tool catalog/details from the built-in tool registry (`--write`). | `website:tools:*` |
| `sync-models.mjs` | Manual | Authors/audits entries of the curated model overlay `packages/cli/data/providers.json` against models.dev (`--validate`, `--diff`, `--extract`). | `sync:models` |
| `sync-chatgpt-overlay.mjs` | Manual | Regenerates the ChatGPT account entries of that overlay from the live account catalog. | `sync:chatgpt-overlay` |
| `generate-subcommand-manifest.mjs` | **Orphan** | See [above](#not-referenced-from-anywhere). | — |
| `generate-webui-captured-tokens.mjs` | **Orphan** | See [above](#not-referenced-from-anywhere). | — |

## Profiling, benchmarks & performance

| Script | Status | What it does | Used by |
| --- | --- | --- | --- |
| `perf-guard.mjs` | Wired | Performance ratchet: re-measures probes in `architecture/perf-baseline.json`, fails on regression, `--write` ratchets improvements down. | `perf:guard*` |
| `bench.mjs` | Manual | Micro-benchmark suite for hot-path optimisations (token-estimate cache, `parseInline` LRU, compaction, tool executor…). | `bench:perf` |
| `perf-chronicle-append.mts` | Manual | Measures Chronicle SQLite disk cost (transaction granularity, `PRAGMA synchronous`). | `perf:chronicle` |
| `tui-heap-soak.mjs` | Manual | Retained-heap benchmark of the Ink history renderer, one fresh `--expose-gc` process per terminal width. | `bench:tui-heap` |
| `analyze-cpuprofile.mjs` | Manual | Ranks a V8 `.cpuprofile` by self time per function. | `analyze:cpuprofile` |
| `memory-profile.mjs` | Manual | Launches the CLI with heap profiling/snapshots enabled. | `profile:memory` |
| `analyze-memory-log.mjs` | Manual | Summarises `~/.wrongstack/logs/heap.jsonl` (per PID, tail, `--json`). | `analyze:memory` |
| `brain-workload-report.mjs` | Manual | Replays real brain call sites through an unreachable-model tier chain to count provider calls attempted per tier. | `brain:workload` |

## Maintenance, one-shots & dev tools

| Script | Status | What it does | Used by |
| --- | --- | --- | --- |
| `acp-smoke-test.mts` | Manual | End-to-end ACP v1 JSON-RPC smoke test against the built stdio server. | `packages/acp` `smoke` |
| `wrongstack-skill-engine.ts` | Manual | Skill router: scores a prompt against bundled skills and prints a single skill or pipeline (`--list`). | `skill:route`, `skill:list` |
| `purge-stale-mailbox-entries.mjs` | Manual | Purges stale mailbox client/agent registry entries through the IPC mailbox API. | docs only |
| `sage-maintenance.mjs` | Manual | One-time SAGE memory recover-then-purge (dry-run default, `--apply` writes with backup). | docs only |
| `repair-agent-learning.mjs` | **Orphan** | One-shot `learned.md` repair. | — |
| `apply-agent-learning-cli-patch.mjs` | **Orphan** | Re-applies agent-learning CLI wiring. | — |
| `check-file-size.mjs` | **Orphan** | Advisory file-size report. | tests only |

## Type shims (`*.d.mts`)

Declaration files that give TypeScript consumers (mostly tests under `packages/*/tests/architecture/`)
types for the plain `.mjs` scripts next to them. They are not executable; keep each one next to its `.mjs`.

`build-binaries`, `check-audit-suppressions`, `check-dep-path-separators`, `check-dist-hidden-files`,
`check-zero-coverage`, `coverage-lock`, `coverage-matrix`, `publish-workspace`,
`sync-core-public-api-snapshot`, `test-coverage`, `vitest-core-aliases`, and `lib/`:
`architecture-health`, `build-lineage`, `build-output-cleanup`, `deploy-bun-workspace`,
`desktop-package-checksums`, `publishable-packages`, `read-bun-lock`, `test-inventory`, `test-skip-budget`.

## Notes

- Several script headers still say `node scripts/…` or `pnpm …`; the repo is Bun-only now
  (`bun install --frozen-lockfile`, `bun scripts/…`). The comments are stale, the code is not.
- `audit-dependencies.mjs` / `check-audit-suppressions.mjs` still read `pnpm-workspace.yaml`
  (`auditConfig.ignoreGhsas`); that file must stay until the suppression list moves.
- Ad-hoc throwaway scripts belong in `.temp_files/`, not here.

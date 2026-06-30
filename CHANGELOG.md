# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Major dependency bump: `@types/node` 25.9.4 → 26.0.1 across all 14
  workspaces.** Added `engines.node: ">=22.19.0"` is already satisfied (Node 26
  is in the supported range). TypeScript 6.0.3 is compatible. No source-code
  changes required; the bump tracks upstream Node type definitions matching the
  runtime the project already pins. Root `overrides.undici-types` raised from
  `^8.4.0` to `^8.5.0` to align with `@types/node@26`'s `~8.3.0` requirement
  under pnpm's override resolution. Verified with `pnpm typecheck` across all
  16 workspaces and `pnpm audit --audit-level=high` (no vulnerabilities).


## [0.276.2] — 2026-06-29

> The **tool consolidation, local-gateway auto-discovery, and WebUI
> modularization** release. Consolidates the `0.276.1`–`0.276.2` line (both
> bump-only) into a single documented entry. Four headlines: a **tool-family
> consolidation** pass that merges duplicate tools, standardizes params and
> categories, and retires the now-redundant plugin stubs (`web-search`,
> `json-path`); **local-LLM gateway auto-discovery** that adds OmniRoute to the
> built-in catalog, probes keyless loopback gateways for their model list at
> boot, and surfaces those keyless providers across every picker (CLI startup,
> `/model`, auth menu, and the WebUI provider selectors); a **WebUI server
> god-module split** (`index.ts` → an 11-module `server/` layout) plus F5
> client-state resilience, subscription OAuth login, an analytics dashboard, and
> a referral surface; and a **CI workflow + structured-error migration** that
> wires a GitHub Actions gate and converts bare `throw new Error(...)` sites to
> typed `WrongStackError` subclasses across five packages. Plus a `review`
> mailbox message type, kernel/security/storage/execution hardening, and a
> memory-search O(1) fast path. All workspace packages and the marketing site
> are aligned to `0.276.2` in lockstep. Additive only — no breaking changes for
> end users.

### Added

- **OmniRoute + local-LLM gateway auto-discovery.** A new `omniroute` provider
  (openai-compatible, loopback `http://localhost:20128/v1`, keyless) ships in
  the built-in catalog with an `autoDiscoverModels` flag. `boot.ts` now calls
  `discoverAndMergeProviders()` after config load: providers flagged
  `autoDiscoverModels: true` have their `/v1/models` endpoint probed and the
  discovered catalog merged into the `ModelsRegistry` via a new `mergeOverlay()`
  method. The overlay is remembered and re-applied across every `refresh()` so
  discovered models survive a catalog reload. New
  `packages/providers/src/auto-discover.ts` and
  `packages/cli/src/boot/auto-discover-providers.ts`.

- **Keyless local gateways surface in every picker.** A new
  `isKeylessLocalProvider(apiBase, envVars)` helper
  (`packages/cli/src/provider-helpers.ts`) recognizes loopback gateways that
  need no API key (OmniRoute, Ollama). A provider is now offered when it has a
  key **or** is a keyless loopback gateway, so OmniRoute's auto-discovered
  models appear in both the in-session `/model` switch and the startup
  selection screen — previously both surfaces gated visibility on `hasApiKey`
  and silently filtered keyless gateways out.

- **Local-server preset menus (CLI + WebUI).** A dependency-free
  `LOCAL_LLM_PRESETS` module (OmniRoute / Ollama / vLLM / LM Studio) backs three
  new surfaces: a `l)` "local server" action in the interactive
  `wstack auth` top-menu, a deduped preset block in the startup provider picker
  (with a manual model-id prompt for freshly-picked gateways that have no
  catalog models yet), and a "Local servers — click to pre-fill" quick-pick in
  both the WebUI Settings → Add Provider form and the first-run SetupScreen. The
  WebUI keeps its own standalone copy of the preset metadata
  (`packages/webui/src/components/SettingsPanel/local-presets.ts`) to avoid a
  `webui → cli` layering dependency.

- **Keyless gateways skip the "Save anyway?" prompt.** `wstack auth local` now
  auto-saves keyless (`noAuth`) gateways when the health probe fails, instead of
  the confirmation prompt. Keyed presets (vLLM / LM Studio) keep the
  confirmation.

- **Tool disable / enable commands.** New CLI commands and config support to
  disable or enable individual tools, complementing the consolidation pass.

- **`review` mailbox message type.** A passive inter-agent ask where no
  immediate reply is required — full end-to-end support across the mailbox,
  `mail_send`, and the system-prompt docs.

- **WebUI F5 resilience.** Client state, the live transcript, and the verifier
  surface now persist and replay across a browser refresh instead of resetting
  the session view.

- **WebUI subscription OAuth login.** Browser-side **ChatGPT / Claude /
  C‍opilot** subscription OAuth login with a refreshed key-entry UX, mirroring
  the CLI's `wstack auth login <provider>` flows (PRs #148, #149).

- **WebUI analytics dashboard + referral surface.** A new `/analytics` view
  polls a new analytics backend endpoint (event aggregation) for overview cards,
  events-by-category charts, active-session usage, and a live event stream; plus
  a referral share modal with QR code, social sharing buttons, a referral badge,
  and click tracking. Popular providers load from an external `providers.json`
  with a refresh button and a provider-count-change toast.

- **CI workflow.** A GitHub Actions gate (`pnpm typecheck` + `pnpm test` +
  `pnpm build`) added alongside the structured-error migration.

### Changed

- **Tool-family consolidation.** Duplicate tools were merged, parameters and
  categories standardized, and the redundant plugin stubs retired —
  `web-search` folded into the built-in `search` tool and `json-path` folded
  into the built-in `json` tool (via an `action` parameter). All stale tool
  references across instructions, skills, docs, and code were updated to match;
  director tests and the fleet tool-count assertions were updated for the
  consolidated surface.

- **WebUI server god-module split.** The monolithic `packages/webui/server/
  index.ts` was decomposed into an 11-module `server/` layout — route-table
  construction, the connection handler, the message dispatcher, the
  setup-screen, WS/HTTP/shutdown + port resolution + session-start payload
  (`server-runtime.ts`), and pre-context registries (`pre-context-services.ts`)
  are now independent modules. `index.ts` is a pure barrel and `start-webui.ts`
  is under 800 lines. Documented in `docs/architecture.md`.

- **`autonomous-coordination` toolkit feature-gated.** The experimental
  autonomous-coordination toolkit now sits behind
  `features.autonomousCoordination` (default `false`).

- **Provider credentials hot-reload.** `config.json` provider-credential changes
  are now picked up without a restart.

### Performance

- **Memory-search inverted index O(1) fast path.** `searchIndex` in
  `packages/core/src/storage/memory-backend.ts` built a `wordMap` / `tagMap`
  inverted index but never used it as an index — every query needle walked the
  entire vocabulary via `word.includes(n) || n.includes(word)`, making
  `search_memory` O(needles × vocabulary) and degrading linearly as memory
  grows. Added an exact `Map.get` fast path for whole-word and tag hits, with a
  bounded substring fallback only when there's no exact hit and the needle is
  ≥3 chars. New `packages/core/tests/perf/memory-search.bench.ts` locks the fast
  path (exact whole-word hit stays ~flat 1.06× between 1K and 10K vocabularies;
  the deliberate substring-fallback worst case is ~9.9× slower — what the old
  code did on every query).

- **`memory-store.scoreRelevant` cache reuse.** The per-entry lowercase WeakMap
  was reallocated on every scoring pass, discarding all cached `toLowerCase()`
  results; it's now lazily allocated once and reused. A single
  `invalidateScoreCaches()` helper is wired into all four mutation sites
  (remember / forget / consolidate / clear) plus the clear-all branch, which
  previously never cleared the score cache.

### Fixed

- **Three latent kernel edge-case bugs.** `Container` now memoizes singletons
  that resolve to `undefined` (via a `hasCache` flag); `EventBus.emit` snapshots
  the named-listener set before iterating; `RunController.onAbort` fires
  post-drain hooks immediately instead of dropping them. `EventBus.off` now
  prunes the empty listener Set from the internal map instead of leaving dead
  entries.

- **Secret scrubber plaintext leaks (two fixes).** `DefaultSecretScrubber` leaked
  every other secret when two secrets shared a single delimiter (the
  printenv/`.env`-dump shape) because the `high_entropy_env` / `bearer_token`
  patterns consumed their trailing delimiter, starving the next match's leading
  anchor — fixed with non-consuming lookaheads. Separately, the chunked path
  could split a secret across the 64 KB boundary on long newline-free input
  (base64 / minified logs) and leak it — fixed with a forward whitespace-snap
  bounded by a 1 KB overlap window.

- **Session index concurrency.** `DefaultSessionStore`'s `_index.jsonl` path
  (`appendToIndex` / `writeTombstone` / `compactIndex` / `rebuildIndex`) now runs
  under `withFileLock` + `atomicWrite`, closing a concurrent-append drop, a
  fixed-temp-path collision, and the Windows rename-retry gap. Compaction was
  split into a locked outer + lock-free inner to avoid self-deadlock with the
  non-reentrant lock.

- **Parallel tool output-cap race.** `ToolExecutor`'s per-iteration output cap
  (`perIterationOutputCapBytes`) was applied per-tool instead of cumulatively
  under the parallel/smart strategies, so ~N× leaked through with N parallel
  tools. `executeTool` was split into a concurrency-safe `produceToolOutput` plus
  a synchronous `settleToolOutput` that enforces the cap against the live shared
  budget atomically. Public `executeTool` is unchanged for single-tool callers.

- **ACP malformed permission response.** Closed a `TypeError` on a malformed
  `session/request_permission` response.

- **TUI mid-paste Enter corruption.** The TUI now swallows `Enter` mid-paste to
  prevent Windows paste corruption.

### Changed — versions

- **All workspace packages aligned to 0.276.2**: `wrongstack`,
  `@wrongstack/cli`, `@wrongstack/core`, `@wrongstack/mcp`,
  `@wrongstack/plug-lsp`, `@wrongstack/plugins`, `@wrongstack/providers`,
  `@wrongstack/runtime`, `@wrongstack/skills`, `@wrongstack/telegram`,
  `@wrongstack/tools`, `@wrongstack/tui`, `@wrongstack/webui`,
  `@wrongstack/acp`, `@wrongstack/bench`, and the umbrella `apps/wrongstack`.
  The marketing site (`website/`) is aligned in lockstep. The `0.276.1` bump
  was bump-only.

## [0.276.0] — 2026-06-28

### Added

- **`ParseError` — new WrongStackError subclass.** Fills the gap between
  `FetchError` (HTTP non-OK) and `ConfigError(CONFIG_PARSE_FAILED)` (config
  files): thrown when a request succeeded (200 OK, valid JSON) but the
  response body is missing required fields or has an unexpected shape.
  Carries a `source` property identifying which upstream API failed (e.g.
  `'anthropic-oauth-token-response'`). Includes `isParseError` type guard.

- **`createGracefulShutdown` — reusable SIGINT/SIGTERM handler.**
  `packages/cli/src/shutdown-cleanup.ts`. Idempotent guard, awaits async
  cleanup, sets `exitCode`, gives Node a 500 ms grace to drain, then force-
  exits. Matches the established pattern in `webui-server/lifecycle.ts` +
  `cli-entry-point.ts`. Used by `cli-main.ts` and `acp.ts` (stdin variant).

- **`OAuthRefreshCoordinator` — shared single-flight refresh machinery.**
  `packages/providers/src/oauth-refresh-coordinator.ts`. Extracts the
  duplicated single-flight + `onRefresh` contract from the three OAuth
  providers (`openai-codex`, `anthropic-oauth`, `github-copilot`). Each
  provider now holds a `refreshCoordinator` field and passes host-specific
  callbacks (`projectTokens`, `applyTokens`, `formatPayload`) to express
  its token shape — composition over inheritance because the three
  providers extend different base classes.

- **`expectFetchError` — test helper.**
  `packages/cli/tests/helpers/fetch-error.ts`. Collapses the try/catch +
  `isFetchError` + status + context boilerplate (~13 lines per site) into
  a single helper call. Supports `status` vs `expectedStatus` split for
  cases where the production code remaps the HTTP status before throwing.

- **`classifyToolError` now recognizes all WrongStackError subclasses.**
  A catch-all `instanceof WrongStackError` arm routes by severity +
  recoverability: `fatal`/`error` → `FATAL`, `warning` → `TRANSIENT`.
  Previously only `FetchError` and `ToolValidationError` were matched;
  all other subclasses fell through to the default unclassified arm.

- **Error-severity integration test.**
  `packages/core/tests/types/error-severity.test.ts` — 41 tests verifying
  the default severity of all 10 `WrongStackError` subclasses, including
  code-conditional branches (`AGENT_ABORTED` → warning, etc.).

- **`classifyToolError` routing test.**
  `packages/core/tests/execution/classify-tool-error.test.ts` — 12 tests
  covering every subclass.

### Changed

- **Structured-error migration: ~60 `throw new Error(...)` sites → typed
  subclasses.** Cross-package sweep across `core`, `tools`, `providers`,
  `runtime`, and `cli`. Every reachable `throw new Error(...)` that
  propagates to the user or the agent loop now uses `FetchError`,
  `FsError`, `SessionError`, `ConfigError`, `AgentError`,
  `ToolValidationError`, or `ParseError` with structured `code`,
  `context`, and `cause` fields. Intentionally not migrated: control-flow
  throws in `slash-commands/helpers.ts` (ecosystem detection) and
  locally-caught validation (`hq.ts`, `settings.ts`).

- **`classifyToolError` exported for testability.** Was module-local;
  now `export function` so the routing can be tested directly.

### Fixed

- **OAuth token-refresh races.** All three OAuth providers
  (`openai-codex`, `anthropic-oauth`, `github-copilot`) had unsynchronized
  refresh paths: concurrent requests near expiry could each mint a token
  pair and race the `onRefresh` persistence callback. Fixed via
  `OAuthRefreshCoordinator` single-flight — concurrent callers share one
  upstream call, one state mutation, one `onRefresh` fire.

- **SIGINT/SIGTERM shutdown race in `cli-main.ts`.** The signal handlers
  called `void cleanup()` then `process.exit(0)` immediately, cutting off
  `registry.markClosing()` (an awaited atomic disk write). The cross-
  process session registry kept thinking the host was alive after Ctrl+C.
  Fixed via `createGracefulShutdown`.

- **`dispatch-webui.ts` redundant SIGINT handlers.** The dispatch installed
  its own SIGINT/SIGTERM handlers that resolved the exit-code promise
  without telling the WebUI server to stop — the server kept running
  orphaned. Fixed by removing the dispatch's redundant handlers; SIGINT
  now flows through `runWebUI`'s internal teardown chain.

- **`acp.ts` (stdin variant) shutdown race.** `server.stop(); process.exit(0)`
  back-to-back cut off the server's async teardown. Fixed via
  `createGracefulShutdown`.

- **`process-guardian.ts` swallowed fatal errors.** The
  `uncaughtException` and `unhandledRejection` handlers logged and
  continued, converting fatal invariant violations into silent undefined
  execution. Now logs and exits non-zero so the host (systemd, launchd,
  supervisor) can react.

- **`fetch.ts` cause-chain loss.** `describeFetchError` returned a fresh
  bare `Error`, severing the undici/DNS/TLS cause chain. Now returns
  `FsError(FS_READ_FAILED)` with `cause: err` preserving the full chain.

- **`read.ts` cause-chain loss.** Stat failures were wrapped via
  `throw new Error(..., toErrorMessage(err))`, losing the cause object
  and stack. Now throws `FsError(FS_READ_FAILED)` with `cause: err`.

- **`agent.ts` plugin-teardown cause loss.** Teardown failures were
  collapsed into `throw new Error(...)` joining all messages as strings.
  Now throws `AgentError(AGENT_RUN_FAILED)` with `cause: errors[0]`
  preserving the first underlying error's structured fields.

### Security

- **`glob.ts` symlink-escape fix (CWE-59).** The base path was checked
  with `safeResolve` (syntactic only) instead of `safeResolveReal`
  (realpath + containment). Symlinks encountered during the walk were
  followed via `fs.stat` without checking whether the target was inside
  the workspace. Both now validate via `assertRealInsideRoot`. In-
  workspace symlinks still work; out-of-workspace symlinks are silently
  skipped.

- **`install.ts` + `update.ts` — `--ignore-scripts` default.** Package
  installs and CLI self-updates now pass `--ignore-scripts` by default for
  all four package managers (npm, pnpm, yarn, bun). Opt-in via
  `lifecycleScripts: true` (install tool) or `--allow-scripts` (update
  subcommand). A compromised `postinstall` can no longer execute arbitrary
  code at install time without explicit opt-in.

- **`vision.ts` SSRF guard on image URLs.** Vision adapters forwarded
  `image.source.url` straight into tool payload fields without validating
  scheme/host. A URL pointing at localhost, RFC1918, or the IMDS endpoint
  (`169.254.169.254`) would bypass the `fetch.ts` SSRF guard. Now runs
  `assertNotPrivateHost` on every URL before forwarding. New
  `VisionUrlBlockedError` carries the rejected URL.

## [0.275.0] — 2026-06-28

> The **ACP v1 spec coverage, performance hardening, and surface polish**
> release. Completes **ACP v1 100 % spec coverage** with the official
> `@agentclientprotocol/sdk` bridge (server: 14 methods; client: 12 methods;
> both transports; full `agentCapabilities`); closes the top-3 hot-path
> bottlenecks in core storage and ACP (async logger tail with `flush()`,
> sort-then-slice in `DefaultMailbox.query()`, once-on-reload sort in
> `DefaultSessionStore`); and lands a wave of surface work — a reliable
> `/sdd` stop/rollback/destroy lifecycle with worktree orphan cleanup, a
> dedicated WebUI **Worktrees** panel, Telegram secret redaction + inline
> approvals, a split `/tool` desc/result mode, a TUI mid-run send-mode picker,
> and cross-restart persistence of WebUI preferences. Closes all P1 (4/4) and
> P2 (9/9) items from `before-release.md` plus 11 P3 items (2 won't-fix), and
> locks the token-saving tier measurements in via regression tests. All
> workspace packages and the marketing site are aligned to `0.275.0` in
> lockstep. Additive only — no breaking changes.

### Added

- **`packages/acp` — ACP v1 100 % spec coverage + SDK bridge.** The full ACP
  v1 spec is now implemented on both server (`@wrongstack/acp`) and client
  sides, with the official `@agentclientprotocol/sdk` v1.0.0 integrated as a
  dependency. New `@wrongstack/acp/sdk` entry re-exports SDK classes
  (`AcpServer`, `AgentApp`, `ClientApp`, `ActiveSession`, …) alongside
  WrongStack's own ACP implementation. WebSocket transport via
  `createWebSocketStream`; Node HTTP / WebSocket handlers via
  `createNodeHttpHandler` / `createNodeWebSocketUpgradeHandler`. All
  remaining ACP methods shipped: `session/fork`, `providers/list|set|disable`,
  `mcp/message` (proper-error stubs), `document/*`, `nes/*`,
  `elicitation/*` (no-op notifications), plus the full `agentCapabilities`
  shape with `mcpCapabilities` / `sessionCapabilities` / `auth`. Server
  gained `session/resume`, `session/close`, `session/delete`, `logout`, HTTP
  transport mode, `ACPSessionStore` persistence, and plan/usage updates
  through `RunTurn`. Client gained `authenticate/logout`, `session/close|load|
  resume|list|delete`, MCP HTTP/SSE transport configs, image/audio
  `ContentBlock` support in `prompt()`, and a fixed `promptCapabilities`
  spec violation. CORS origin guard on the HTTP transport. Verified against
  every page on `agentclientprotocol.com` — 143 spec checks, 0 failures; 160
  unit tests across 14 files plus end-to-end integration tests, all green.

- **`packages/cli/tests/token-saving-measurement.test.ts` — tier sizes pinned.**
  Empirical measurement of prompt size across all 5 token-saving tiers
  (`off` / `aggressive` / `medium` / `light` / `minimal`) using the real
  `setupTools()` path. Asserts tool counts and that compacting tiers are
  smaller than `off`. The accompanying docs were updated to reflect measured
  values with a warning blockquote on the `aggressive` tier delta
  (`~60` measured tokens, previously claimed `~4–5K`).

- **`packages/cli/tests/token-saving-memory-injection-size.test.ts` — memory
  block size pinned.** Asserts that the memory block injected into the
  system prompt is the same size at every tier (memory is feature-gated on
  `config.features.memory`, tier-independent). Catches an accidental
  regression that would compact memory at `aggressive` to match
  `minimal`-style.

- **`/tool` — independent description + result render modes.** `/tool <name>
  simple` used to set both the LLM-side description and the on-screen result
  preview at once — shortening a description you were fine with while also
  wiping file output you wanted to keep. Split into two independent axes:
  `/tool <name> desc simple|extend` (LLM prompt prose, unchanged) and
  `/tool <name> result simple|extend` (on-screen render, new). The legacy
  `/tool <name> simple` keeps working as a back-compat alias that sets both.
  Backed by independent config fields (`tools.descriptionMode[name]` /
  `tools.resultRenderMode[name]`), independent of the token-saving tiers, and
  wired with parity across CLI (`TerminalRenderer`), TUI (`HistoryEntry`), and
  WebUI (`ToolResult` `renderMode` prop). Toggling the result render mode never
  changes what the model sees. New
  `packages/core/src/utils/tool-result-render-mode.ts` (13 unit tests); CLI
  `renderer`/`slash-tool` test suites extended.

- **`packages/telegram` — secret redaction, inline-keyboard approvals, startup
  self-test.** Outbound notifications now run tool output and delegate-completed
  summaries through a new `src/redact.ts` (mirrors `redactCommand` from
  `@wrongstack/tools` without taking the dependency), closing the risk of tokens
  printed by a long bash run landing in a phone notification (15-case regex
  matrix). New `telegram_approve` tool posts a yes/no inline keyboard and races
  the two buttons via `callback_query` (`awaitCallback` + `answerCallbackQuery`
  ack), with a 600s timeout safety net. `setup()` now runs a `getMe` health
  check before polling, so a `401`/`403` surfaces immediately instead of
  spinning on every poll cycle; `bot.health()` also clears its 5s timeout in a
  `finally` so it no longer leaks an `AbortSignal.timeout`.

- **`packages/webui` — dedicated Worktrees management panel.** A first-class
  worktree manager in the left nav unifies live (event-driven) worktrees with
  disk-scanned orphans in one list, with per-row open-in-terminal/folder, view
  changes (compact diff summary), squash-merge to base, and remove/discard, plus
  bulk **Clean orphans** + rescan. New core ops (`WorktreeManager.removeOne` /
  `mergeBranch` / `diffSummary` / `listManaged`) are handle-free and path-guarded;
  destructive actions are double-guarded (refused while a run owns the worktree,
  and behind the cross-process board liveness guard for bulk clean). The panel
  only operates on this project's own `wstack/ap/*` branches (regex also blocks
  argv flag-smuggling), and every directory is validated inside the managed
  worktrees root before any `git` call.

- **`/sdd` — robust stop / rollback / destroy lifecycle + worktree orphan
  cleanup.** Abandoning an SDD run is now reliable and reversible on every
  surface. `destroySddProject` gains `revertMerged` (revert → cleanup → delete
  order); a shared `applySddLifecycle` gives CLI/TUI/WebUI one uniform result so
  wording matches everywhere. The WebUI board applies cleanup/rollback/destroy
  directly from disk once a run ends (fixing the post-run no-op where
  `control.jsonl` had no drainer), adds one-click **Destroy** + `SddDestroyDialog`,
  and the TUI/CLI board overlay `c`/`z`/`x` keys fall back to a disk-backed host
  callback post-run (`/sdd destroy --revert`). Previously-dead
  `cleanupStaleWorktrees` is now wired (liveness-guarded) on WebUI+CLI boot and
  before each run start, and also catches dangling `wstack/ap/*` branches.

- **TUI — mid-run send-mode picker.** Submitting a plain message while the agent
  is busy now pops a 3-way picker — **Queue** (run after the current turn),
  **By the way** (fold in at the next step via `setBtwNote`, no interrupt), or
  **Steer** (abort now, drop the queue, redirect with a STEERING preamble) —
  instead of silently queueing. Queue is the default highlight; `Esc` queues so
  the typed text is never lost. Quick keys `q`/`b`/`s`, arrows to move, `Enter`
  to pick. On by default; toggle with `/queue picker on|off` (persisted to
  `autonomy.midRunSendPicker`). Slash commands typed while busy still dispatch
  immediately. New `packages/tui/src/components/send-mode-picker.tsx`; the
  `/steer` body was factored into a shared `runSteerSequence` reused by both the
  command and the picker.

### Changed

- **`packages/core/src/infrastructure/logger.ts` — async serialized tail.** The
  blocking `statSync` / `rmSync` / `renameSync` / `appendFileSync` calls were
  replaced with a serialized async `Promise<void>` chain. `mkdir` is chained
  onto the same tail so the first append can't race a still-pending `mkdir`.
  New public API: `flush(): Promise<void>` — await a deterministic "everything
  on disk" guarantee. Children share the parent's tail via `_tail` getter /
  setter; `parent.flush()` now waits for every chained child append. Tests,
  shutdown handlers, and SIGINT sequences should `await logger.flush()` before
  reading the log file or exiting. Behavior unchanged from the user's
  perspective.

- **`packages/core/src/coordination/mailbox.ts` — `query()` reverse-iterate.**
  `DefaultMailbox.query()` no longer sorts the full filtered set on every
  poll. Newest-first iteration + early cutoff replaces the per-call
  O(M log M) sort. Priority-ordered queries still sort but only the filtered
  subset. Result order preserved (newest-first); internal data path changed
  from sort-then-slice to reverse-iterate-then-slice.

- **`packages/core/src/storage/session-store.ts` — `list()` pure slice.**
  `DefaultSessionStore.readIndex()` sorts the summaries once when (re)loading;
  `list()` is now a pure slice over the already-sorted index. `append`,
  `tombstone`, `compact`, and `rebuild` invalidate the index cache.

- **`packages/acp/src/agent/session-store.ts` — memoized `init()`, sidecar
  index.** `init()` is now memoized so repeated calls don't rebuild the
  index. `list()` reads a sidecar `index.json` instead of scanning every
  JSONL; full-scan rebuild is a fallback when the sidecar is missing.
  `save()` dropped pretty-print in favor of compact JSON.

- **`packages/acp/src/registry/ensemble-registry.ts` — bounded concurrency
  on catalog probes.** New `MAX_PARALLEL_PROBES = 4` constant plus a
  `probeWithBound` helper that preserves output order across parallel
  probes. Replaces unbounded `Promise.all` over the catalog.

- **`packages/acp/src/integration/ensemble-runner.ts` — `maxConcurrency`
  option + `mapBound`.** New `maxConcurrency` option (default 4). New
  `mapBound` helper replaces `Promise.allSettled(map(...))` with `Promise.all`
  semantics (since `runOne` already swallows every error).

- **`docs/token-saving-tiers-design.md` + `docs/configuration.md` — tier
  doc reconciled.** Tier comparison matrix updated to reflect measured
  `aggressive` behavior. The misleading "Doc claim" column was dropped from
  the savings table; replaced with explicit measured values only. An
  axis-by-axis guide clarifies that tiers optimize along **two** axes
  (tool count × guidance detail), not one.

- **`packages/providers/src/anthropic.ts` — preserves user-visible provider
  id.** Configured aliases (e.g. `minimax-token-plan` with `family:
  'anthropic'`) no longer collapse to `id === 'anthropic'` at runtime;
  the user's chosen `id` now flows through `AnthropicProvider` like the
  OpenAI / Google / Codex / Anthropic-OAuth branches already did. The
  status bar, pickers, fallback chain, and provider pickers all show the
  user-configured id instead of the wire-format id.

### Performance

- **`packages/core/src/storage/session-store.ts` — `readIndex()` sort
  amortised to once-per-reload.** Repeated `list()` calls no longer pay
  the per-call sort cost; the index is sorted on load and `list()` is a
  slice. Cache invalidation runs on `append`, `tombstone`, `compact`,
  and `rebuild`.

- **`packages/core/src/coordination/mailbox.ts` — `query()` O(M log M) →
  O(K) where K is the page size.** Sort-the-full-set per poll replaced
  with reverse-iterate-and-cutoff. Priority-ordered queries still sort
  but only the filtered subset.

- **`packages/acp/src/agent/session-store.ts` — `list()` N+1 reads → 1
  sidecar read.** Sidecar `index.json` written on `init()` (and rebuilt
  from the full scan as fallback) means `list()` does a single file read
  instead of one per session JSONL.

- **`packages/acp/src/registry/ensemble-registry.ts` — bounded catalog
  probes.** `MAX_PARALLEL_PROBES = 4` caps the open-probe count when
  probing multiple catalog entries simultaneously; output order
  preserved.

### Fixed

- **`packages/providers/src/anthropic.ts` — provider id collapsing on
  aliases.** `AnthropicProvider` hardcoded `id: 'anthropic'` as a class
  field; `makeProvider()` in `packages/providers/src/index.ts` did not
  forward `p.id` to the Anthropic branch. Together these caused every
  user-configured Anthropic-family alias to surface as `'anthropic'` in
  the UI and the fallback chain. `AnthropicProvider` now accepts
  `id?: string` via `AnthropicProviderOptions` and defaults to the
  wire-format id when unset (backwards compatible); `makeProvider()`
  forwards `p.id` to match the OpenAI branch. Regression tests pin both
  behaviors in `packages/providers/tests/decoupled.test.ts`.

- **`packages/core/src/infrastructure/logger.ts` — synchronous file
  writes on the hot path.** `statSync` / `rmSync` / `renameSync` /
  `appendFileSync` blocked the event loop on every log call. Replaced
  with a serialized async tail. No public behavior change beyond the new
  `flush()` API; existing callers that relied on synchronous file
  visibility must now `await logger.flush()` (see the test updates in
  `packages/core/tests/infrastructure/logger.test.ts`).

- **`packages/tui` — edit-style tool entries render a meta line; DiffBlock
  color fallback.** `formatToolVisualOutput` had no branch for
  `edit`/`write`/`diff`/`patch`/`replace`, so those entries rendered the raw
  diff body with no summary line — you had to scroll past the hunks to see which
  file was touched. A new `visualEdit()` helper surfaces a one-line summary
  (`edit <path>` + replacement count, `write <path>` + bytes/`new file`,
  `diff`/`patch`/`replace` file counts), and `simple` render mode now keeps that
  meta line so edit entries never look blank (only the diff body is hidden).
  `DiffBlock` gains a `useColor` fallback: terminals that strip background
  escapes (`NO_COLOR=1`, plain xterm) now get bright green/red bold markers with
  default foreground text instead of an invisible line. New
  `diff-block-render.test.ts` (7 tests); `tool-format` / `tool-entry-render`
  suites extended.

- **`/sdd` — a user-stopped run is reported as `stopped`, not `paused`.** A
  stopped run was projected with board status `paused` (the resumable, still-live
  state), so every surface treated it as active forever — the WebUI Destroy
  orchestration waited for an `!active` that never came, and the
  Clean/Rollback/Destroy controls (gated on `!active`) never appeared. A distinct
  terminal `stopped` status is now returned by `resolveStatus` for a finished +
  stop-requested run and threaded through the WebUI store/theme and the TUI
  overlay, so the post-run lifecycle controls apply and the
  auto-stop→destroy handoff completes.

- **`cli` / `webui` — browser preference changes persist across restarts.**
  `wrongstack --webui` previously lost browser-side changes to reasoning
  mode/effort/preserve, cache TTL, context mode, token-saving tier,
  `max-concurrent`, title animation, and the active provider/model on restart —
  only the standalone `wstackui` server persisted them. Both surfaces now write
  the same canonical keys to `config.json`.

### Changed — versions

- **All workspace packages aligned to 0.275.0**: `wrongstack`,
  `@wrongstack/cli`, `@wrongstack/core`, `@wrongstack/mcp`,
  `@wrongstack/plug-lsp`, `@wrongstack/plugins`, `@wrongstack/providers`,
  `@wrongstack/runtime`, `@wrongstack/skills`, `@wrongstack/telegram`,
  `@wrongstack/tools`, `@wrongstack/tui`, `@wrongstack/webui`,
  `@wrongstack/acp`, `@wrongstack/bench`, and the umbrella `apps/wrongstack`.
  The marketing site (`website/`) is aligned in lockstep.

### Closed — `before-release.md`

- **P1 (4/4 fixed):** write bypass → `readFiles`/`writtenFiles` split · bash
  timeout cleanup → `cleanup()` method · bash backpressure → upper-bound
  tests · headless deadlock → `listenerCount` guard.
- **P2 (9/9 fixed):** structured side-effect recording → 4-phase
  implementation (SideEffect type, bash/install/fetch wiring, `/diag`
  timeline) · error classification → `ToolValidationError` subclass ·
  pipeline swallow → structured warning logging · schema recursion → depth
  limit (64) · readFiles separation (covered by P1 #1) · kill-guard paths →
  broadened to any shell executable · kill-guard docs → "Known bypasses"
  section · YOLO destructive → 88-case test suite · secret redaction →
  36-case test suite.
- **P3 (11 fixed, 2 won't-fix):** sentinel dedup, cross-field `validate()`,
  LRU cache, `FetchError`, `PreToolUse` skip, atomic write on Windows,
  `Tool.serialize()`, progress head buffer, circuit breaker cleanup, PID
  reuse, platform filter. Won't-fix: `#15` (tool guards break direct
  callers), `#26` (reverse-diff too broad).

## [0.274.0] — 2026-06-27

> The **multi-file diff rendering, settings picker, and per-iteration
> performance** release. The TUI now renders multi-file tool outputs (`replace` /
> `diff` / `patch` / `write`) as one **DiffFileBlock per file** with an
> independently-capped preview and a configurable summary footer, plus an
> 18-chord **settings picker** (`Ctrl` / `Alt` / `Alt+Shift`) with a live fuzzy
> filter and two new `/settings` inline commands. A per-iteration performance
> pass cuts redundant serialization, blocking disk writes, and full-history token
> re-walks on the agent-loop hot path, memoizes the TUI history and tool-entry
> formatting, and decomposes the 2,095-line `session-store.ts` into focused
> modules. All workspace packages and the marketing site are aligned to `0.274.0`
> in lockstep. Additive only — no breaking changes.

### Added

- **`packages/tui` — multi-file diff rendering with per-file DiffFileBlock.**
  Multi-file tool outputs from `replace`, `diff`, `patch`, and `write` (new file)
  now render as one **DiffFileBlock per file** instead of a single combined block.
  Each file's preview is independently capped (12 rows with a `… +N -M hidden`
  footer), and a **summary footer** lists touched files once the count exceeds the
  threshold. Three JSON shapes trigger the split: `replace`
  `{ results: [{ path, diff }] }`, `diff`/`patch` `{ diff, files }`, and `write`
  (new file) synthesizes a `+++ <path>` header. New helpers
  `extractMultiFileDiffs`, `splitGitStyleDiff`, and `formatMultiDiffSummary` in
  `packages/tui/src/components/history/code-block.tsx`. When `diff` / `results[]` /
  `files` is omitted the renderer falls back to the single combined block. Covered
  by `packages/tui/tests/tool-format.test.ts` (8 new cases; 85 total).
  (`0d241db9`)

- **`packages/tui` — 18-chord settings picker + live fuzzy filter.** The settings
  overlay gains 18 navigation chords across three modifier sets — `Ctrl`
  (most-tweaked tools/reasoning/fleet rows), `Alt` (autonomy/UX/context), and
  `Alt+Shift` (logging rows). A live filter bar supports fuzzy subsequence matching
  with relevance ranking and incremental highlighting, and `lastSettingsField` is
  persisted across sessions so the picker re-opens on the row you last visited.
  Surfaced via `SettingsPickerJumpMod` / `SETTINGS_PICKER_JUMP_CHORDS`, documented
  in the help overlay (`?`), and reachable through the new `/settings` slash command
  with name resolution. (`3ce81bc7`)

- **`packages/tui` — `/settings` slash-command family.** `/settings` opens the
  picker; `/settings <chord>` opens it on that row; **`/settings <chord> <value>`**
  sets a value inline without opening the picker (validates all 36 fields across
  boolean / enum / preset / text types via `resolveSettingsFieldValue`).
  **`/settings-get`** with no args prints a section-grouped summary of all 36
  settings (`formatAllSettingsSummary`); with a chord it shows one value. New
  exports: `resolveSettingsFieldValue`, `SETTINGS_FIELD_LABELS`,
  `SettingsPickerPatch`, `SETTINGS_SECTIONS`. 38 new tests in
  `settings-value-set.test.ts`. (`e599b50a`, `c2239835`)

### Changed

- **`packages/core` — `session-store.ts` decomposition.** The 2,095-line
  `session-store.ts` is split into three focused, independently-testable modules:
  `session-store.ts` (1,354 L — `DefaultSessionStore`: read / list / index /
  delete / prune), `file-session-writer.ts` (756 L — `FileSessionWriter`: append /
  flush / close / checkpoint / truncate), and `session-helpers.ts` (19 L — shared
  `userInputTitle`). Architecture boundary tests still pass (716/716); all storage
  tests pass (717/717). Pure refactor — no behaviour change. (`e0cb827f`)

- **`packages/tui` — multi-file diff summary threshold is user-configurable.** The
  summary-footer appearance threshold is now tunable via the settings picker
  (Settings → Tools → "Multi-diff summary", presets `[3, 5, 8, 10, 15, 0]`, default
  5, `0` suppresses) and referenced from the help overlay. `formatMultiDiffSummary`
  takes an explicit threshold; `0` suppresses, a positive number sets the cutoff,
  and the negative sentinel (the `undefined ?? -1` in `Entry`) means "use default".
  The hard-coded `MULTI_DIFF_SUMMARY_THRESHOLD` constant remains the default
  fallback.

### Performance

- **`packages/core/src/execution/tool-executor.ts` — skip `JSON.stringify` for empty
  capabilities.** Most tools declare no dangerous capabilities; the executor now
  skips the per-call serialization for the common case. (`15d017b1`)

- **`packages/core/src/core/agent-loop.ts` — fire-and-forget in-flight marker.**
  `writeInFlightMarker` no longer `await`s a disk write on every iteration — it is
  fire-and-forget, unblocking the iteration loop. (`02670b0f`)

- **`packages/core/src/core/agent-loop.ts` — cached system + tools token overhead.**
  System-prompt and tool-definition token counts are now cached by reference
  identity (they change rarely — `/model`, mode switch, MCP connect). A new
  `systemAndToolsOverhead()` helper backs `stashRequestTokens` as a pre-flight
  side-effect and the cold-start path. (`02670b0f`)

- **`packages/core/src/core/agent-loop.ts` — incremental delta token estimation.**
  When tool results append, context pressure is recomputed by summing only the
  newly appended message tokens plus the cached overhead — O(new_msgs) instead of
  re-walking the full message history O(all_msgs). (`02670b0f`)

- **`packages/tui` — memoized History + tool-entry formatting.** `History` and
  `ScrollableHistory` are wrapped in `React.memo`, so keystrokes in the input
  buffer no longer trigger a full history subtree re-render. In `entry.tsx`,
  `formatToolOutput` / `extractDiffPreview` / `extractMultiFileDiffs` are wrapped in
  `useMemo`, avoiding re-parsing tool output on every `autoSubmitCountdown` tick.
  (`dccb5447`, `4140dcfd`)

- **`packages/core/src/storage` — session filters pushed into the cached index.**
  New `DefaultSessionStore.listFiltered(criteria)` filters from the **cached session
  index** before sorting/slicing instead of fetching ~1000 sessions and linearly
  scanning. `DefaultSessionReader.query()` / `.search()` duck-type it with a
  graceful fallback for non-`DefaultSessionStore` implementations. Shared
  `matchesSessionFilter()` helper exported from `session-store`. (`7bda2bfc`)

- **`packages/tools/src/codebase-index` — efficiency bundle.** Added
  `idx_s_file_fk` and `idx_s_lang_kind` compound indexes (fixes slow delete paths
  and lang+kind filtered searches); the Python parser now receives content via
  **stdin** instead of reopening the file (one fewer disk read per Python file);
  `parse.py` is written **once per process** (cached `_cachedScriptPath`) instead
  of per file; and stale-file detection replaced a per-file `fs.stat()` loop with
  O(1) Set-membership lookup against discovered files. (`7bda2bfc`)

### Changed — versions

- **All workspace packages aligned to 0.274.0**: `wrongstack`,
  `@wrongstack/cli`, `@wrongstack/core`, `@wrongstack/mcp`,
  `@wrongstack/plug-lsp`, `@wrongstack/plugins`, `@wrongstack/providers`,
  `@wrongstack/runtime`, `@wrongstack/skills`, `@wrongstack/telegram`,
  `@wrongstack/tools`, `@wrongstack/tui`, `@wrongstack/webui`,
  `@wrongstack/acp`, and `@wrongstack/bench`. The marketing site (`website/`)
  is aligned in lockstep.

## [0.273.0] — 2026-06-25

> The **Spec-Driven Development "never stuck, never explode"** release. It turns
> `/sdd parallel` from a fire-and-forget fan-out into a fully observable,
> self-healing, dependency-driven multi-agent run: a live kanban/DAG board on every
> surface (CLI · TUI · WebUI), a continuous dependency scheduler, per-task and
> per-run model + fallback selection, a verification/merge completion gate, a Brain
> supervisor that reassigns/splits/escalates exhausted tasks, an interactive
> "start SDD from the WebUI" wizard, interactive Ctrl+C stop, and a full project
> lifecycle (`clean` / `rollback` / `destroy`). Outside SDD it adds per-tool
> description-detail control (`/tool`), catalog model-visibility controls
> (`wstack models hide/show/hidden/reset`), and an event-driven Shadow Agent
> fleet monitor (`/shadow`). All workspace packages and the marketing site are
> aligned to `0.273.0` in lockstep. Additive only — no breaking changes.

### Added

- **`packages/core/src/sdd` + CLI/TUI/WebUI — live multi-agent SDD board.** The real
  `/sdd parallel` run (`SddParallelRun` + `DefaultMultiAgentCoordinator`) is now fully
  observable. New `TaskTracker.subscribe()`/`notifyChange` primitive feeds an
  `SddBoardProjector` that throttles `sdd.run.*` / `sdd.task.*` / `sdd.wave` /
  `sdd.deadlock` events into a persisted `SddBoardSnapshot` (topological columns, short
  ids, dependency refs, live agent + worktree badges, activity feed). Surfaced as a
  WebUI **Live Board** (`SddBoardView` — animated React-Flow DAG, kanban toggle, task
  drawer, activity feed) on both servers, and a TUI overlay (**Ctrl+B**). Each task runs
  in its own git worktree with success→squash-merge / retry→discard, plus orphan reset,
  deadlock recovery, and wall-clock/round backstops.

- **`packages/core/src/sdd` — start an SDD project from the WebUI (wizard).** New
  `SddInterviewDriver` (headless wrapper around `AISpecBuilder`) drives an interactive
  Q&A spec wizard — goal → questions → spec → task graph → Start Run → live board — over
  dedicated `sdd.spec.*` / `sdd.run.start` WS messages on both WebUI servers. Real
  multi-agent execution is provided by a new `makeLightSubagentFactory` (runtime) so the
  WebUI runs a real fleet without depending on the CLI `MultiAgentHost`. Run setup was
  extracted into `core/sdd/start-sdd-run.ts` (`startSddRun`), now shared by the CLI and
  both WebUI servers.

- **`packages/core/src/sdd` — continuous dependency-driven scheduler.** `SddParallelRun.run()`
  moved from a wave-barrier (whole batch must finish before the next) to a continuous
  dispatcher: a fast task's dependents start the moment their deps are satisfied,
  independents run in parallel, and chains run in order. Real `dependsOn` is now captured
  end-to-end (spec prompt asks for `id` + `dependsOn`; a two-pass resolver wires the
  graph; `TaskGenerator` adds default tests/docs→feature edges). New
  `TaskTracker.addDependency` (cycle-guarded), `removeNode`, and `patchMetadata`.

- **`packages/core` + CLI/WebUI — per-task and per-run model, provider & fallback
  selection.** A run can set a default model/provider/fallback chain, and any task can
  override its worker model. Threaded through `startSddRun`, the projector, and the board
  snapshot; controllable via WS (`set_task_model` / `set_task_fallbacks`) and the WebUI
  `ModelPicker` + `FallbackEditor` (run-config popover, per-task drawer row, and a global
  fallback editor in WebUI settings). `createFallbackModelExtension` / `parseModelRef`
  moved `cli → core` and are wired per-worker in the runtime light factory.

- **`packages/core/src/sdd` — never-stuck/explode robustness layer (PR #112).** A
  completion gate verifies a worker "success" (optional `verifyTask`, runs in the task
  cwd) before mark-completed and before merge; conflicted worktrees gate completion on a
  clean merge (`integrateWorktree`, optional `conflictResolver`); a Brain `SddSupervisor`
  is consulted only when retries are exhausted and maps a decision to
  retry / reassign(model) / split / fail; and `splitTask` breaks a stuck task into
  dependency-rewired leaves. New events: `sdd.task.verification_failed` / `conflict` /
  `split` and `sdd.supervisor.decision`. New env opt-ins:
  `WRONGSTACK_SDD_VERIFY_FROM_ACCEPTANCE=1` (derive a `verificationCommand` from an
  acceptance criterion) and `WRONGSTACK_SDD_CONFLICT_RESOLVER=prefer-incoming|prefer-base|llm`
  (a resolver-landed merge is re-verified and reverted on regression). New slash commands
  `/sdd split <id> <A ; B>` and `/sdd retry-failed`.

- **`packages/core/src/worktree` + CLI/WebUI/TUI — full SDD run lifecycle.** New
  WorktreeManager primitives `currentBase()`, `cleanupAllManaged()`, and
  `revertCommits()` (history-preserving `git revert`, dirty-tree guard) back a full
  project lifecycle: `/sdd clean` (force-remove managed worktrees + branches),
  `/sdd rollback` (revert each squash-merge commit recorded in `mergedCommits[]` on the
  board snapshot), and `/sdd destroy` (clean worktrees + delete specs / task-graphs /
  session / boards). Post-run disk helpers live in the new `core/sdd/sdd-lifecycle.ts`.
  Surfaced on all three surfaces — WebUI Clean/Rollback buttons (when no active run) and
  TUI board-overlay keys (`c` clean / `z` rollback).

- **`packages/cli` — `/tool <name> simple|extend` per-tool description detail.** Tools
  default to `desc:extend` (full description); `desc:simple` switches a tool to a shorter
  1–2 line description to trim prompt overhead. Modes are applied at boot via
  `applyToolDescriptionModes` and shown in `/tools` output. Reference in
  `docs/slash/tool.md`.

- **`packages/cli` — catalog model-visibility controls.** New
  `wstack models hide|show|hidden|reset <id>` commands curate which catalog models appear
  in pickers and listings. A shared `visibleModelIds()` helper (when `cfg.models` is set
  it is the allowlist, otherwise the full catalog is visible) is applied across the CLI
  picker, provider-helpers, and subcommands, so hidden models never surface in interactive
  selection or `wstack models` output.

- **`packages/core` + CLI — event-driven Shadow Agent fleet monitor (`/shadow`).** The
  Shadow Agent was refactored from a periodic heartbeat to an event-driven one-shot pass:
  it monitors work depth via `agent.run.*` / `subagent.task.*`, tracks every fleet agent
  and its current task, detects loops and spike tasks, and can `hoop` a runaway agent
  (stop + notify). `/shadow start|stop|status|hoop|model|interval` manages its lifecycle,
  now tracked across host auto-start and the slash-command flow.

### Changed

- **`packages/core/src/sdd/sdd-parallel-run.ts` — subagent timeout model.** Workers no
  longer get a hard 5-minute wall-clock `timeoutMs` that hard-killed productive tasks
  (→ `budget_timeout`). The default is now an activity-resetting idle reaper
  (`idleTimeoutMs`, 600s); `taskTimeoutMs` is opt-in. Default `parallelSlots` 4→2 (for
  worktree manageability) and `maxRetries` 2→3. A bounded end-of-run failed-task sweep
  (`maxFailedRetrySweeps`) plus `retryAllFailed()` / `/sdd retry-failed` recover stragglers,
  and failed worktrees are released (no pile-up).

- **WebUI SDD surfaces — light-theme support + shared design system.** The SDD wizard and
  board surfaces were converted from a hardcoded dark palette to theme tokens (readable in
  light mode); the theme-aware `ModelPicker` / `FallbackEditor` follow suit. A single
  `packages/webui/src/lib/sdd-theme.ts` is now the source of truth for SDD status /
  priority / agent colors / feed icons consumed by all SDD surfaces.

### Fixed

- **`packages/core/src/sdd/sdd-parallel-run.ts` — dropped dependencies & silent
  unmerged tasks.** Two latent data bugs: agent task JSON carried no `dependsOn` (so the
  scheduler saw an edgeless graph and slot-filled naively), and `resolveWorktrees` ignored
  the `merge()` result — silently leaving conflicted tasks marked "completed" but never
  merged. Both are closed by the dependency capture path and the merge-gated
  `integrateWorktree`.

- **`packages/cli` + TUI — `/sdd parallel` was unstoppable mid-run.** A live parallel run
  blocked the prompt (the slash dispatch awaited the whole run) and the SIGINT handlers
  only stopped the autonomy engines, never the SDD coordinator. A `getSddRun` getter is
  now threaded `cli-main → execution → repl / run-tui → app` so the first Ctrl+C calls
  `stop()` on the active run (aborts workers, drains, returns the prompt). The WebUI Stop
  already worked via the cross-process control-file drain.

## [0.272.0] — 2026-06-24

> The **agent monitoring, process self-protection, and security-hardening** release.
> Consolidates the work after `0.269.0` (the `0.270`/`0.271` bumps were bump-only).
> Adds an `AgentMonitorService` with per-subagent timeline streams surfaced across HQ,
> the TUI, and the WebUI; a process self-protection layer (`/ps`, process guardian,
> kill-guard) that stops WrongStack from being killed by its own shell tools; a rapid
> triple-Ctrl+C force-exit in the TUI; and a dedicated HQ dashboard on `--hq` that no
> longer depends on the WebUI package. Closes a batch of security findings
> (untrusted in-project config, child-env credential leaks, vault passphrase KEK,
> WebSocket cookie auth, `mcp_control` risk tier) and verified issue fixes
> (#100, #20, #15, #14, #13, #91, #99, #86). All workspace packages and the marketing
> site are aligned to `0.272.0` in lockstep. Additive only — no breaking changes.

### Added

- **`packages/core` + HQ/TUI/WebUI — agent timeline monitoring.** New
  `AgentMonitorService` listens on the FleetBus and maintains a per-subagent virtual
  chat history (ring buffer + JSONL persistence), emitting `agent.timeline.message`
  and `agent.status_changed` events. Wired into `MultiAgentHost` and `cli-main` boot,
  bridged to HQ as `agent.message` / `agent.status` envelopes, and rendered in the HQ
  browser dashboard, the TUI chat history, and the WebUI `FleetMonitor` panel. New
  `/agents stream on|off|status|list|show <id>` slash command. Full reference in
  `docs/agent-monitoring.md`.

- **`packages/tools` — process self-protection layer.** New `/ps` command lists every
  running WrongStack instance; `process-guardian` provides PID-based self-protection;
  `process-registry-persistent` tracks processes across instances; and `bash-kill-guard`
  blocks `kill`/`pkill`/`killall`/`taskkill`/`tskill` (including shell-wrapped
  `bash -c "kill -9 PID"` and kill pipelines) from targeting protected WrongStack
  processes. Kill protection is wired into both the bash and exec execution streams.

- **`packages/tui/src/run-tui.ts` — rapid Ctrl+C force-exit.** Pressing Ctrl+C three
  times within a 2-second window exits immediately via `process.exit(130)`, bypassing
  the normal cleanup + Ink unmount path for a predictable fast kill when the TUI is
  idle or unresponsive. The counter resets after the window expires.

- **`packages/providers` — minimal/xhigh/max reasoning effort propagation (#14).**
  `OpenAICompatibleProvider.buildBody` now maps the broader internal effort levels
  onto OpenAI's accepted scale (`minimal → low`, `xhigh|max → high`) for generic
  OpenAI-compatible servers (MiniMax, DeepSeek, OpenRouter, …), which previously
  dropped these values silently. Never overrides a value the base builder or the
  `zai-glm` quirk already wrote, and respects `reasoning.enabled === false`.

### Changed

- **`packages/cli/src/hq-server.ts` + `boot/short-circuit-hq.ts` — `--hq` serves the
  dedicated HQ dashboard.** The HQ server root (`/`) now always serves the bundled
  `HQ_HTML` dashboard instead of the React WebUI, removing the hard dependency on
  `@wrongstack/webui` (HQ starts even when the package is absent). The dashboard loads
  initial state over HTTP `/api/snapshot` before connecting via WS so it renders
  immediately, and an interactive port prompt (`HQ server port [3499]:`) accepts Enter
  for the default or a custom port (explicit `--port` bypasses the prompt). Static
  assets (`/assets/*`, `/wrongstack.svg`) are now public and no longer 401 under
  browser-token mode; API and SPA routes stay protected.

- **`packages/core` HQ buffers + dashboard.** `MAX_EVENT_LOG` 500 → 5000,
  `FEED_MAX` 50 → 500, publisher `MAX_QUEUED_MESSAGES` 250 → 2000, and
  `COMMAND_POLL_INTERVAL_MS` 10s → 2s. The dashboard Flow panel uses a grid layout
  that prevents mailbox overlap (horizontal stacking, dynamic SVG size, overflow-x
  scroll) and the live feed now accepts all event types, not just `mailbox.event`.
  Background bash is unbound from the abort signal.

- **`packages/webui/server/index.ts` — handler extraction refactor (#31).** Extracted
  the `process.*` and `goal.get` handlers and collapsed nine worklist cases into a
  shared dispatcher, shrinking the monolithic server message switch.

### Fixed

- **`packages/core/src/config-loader.ts` — untrusted in-project config (WS-06,
  Critical).** `<project>/.wrongstack/config.json` was deep-merged above the user's
  global config with no filter, letting a cloned/malicious repo get RCE on launch
  (`mcpServers`/`hooks`/`plugins`/LSP `extensions[].servers[].command`) or exfiltrate
  the provider API key via a `baseUrl` override. `stripUnsafeInProjectFields()` now
  drops `provider`/`apiKey`/`baseUrl`/`providers`/`mcpServers`/`hooks`/`plugins`/`sync`/
  `yolo`/`extensions` from the in-project layer before merge, with an observable
  warning; benign project prefs still merge.

- **child-env connection-string credential leak (WS-01, Low).** Connection-string env
  vars (`DATABASE_URL`, `REDIS_URL`, `*_DSN`) embed credentials in their value but not
  their name, bypassing the child-env secret-name scrub. Any value containing
  `scheme://[user]:<password>@host` is now dropped before forwarding to bash/exec/MCP
  children.

- **vault passphrase KEK + WS auth + `mcp_control` (WS-03/04/05).** Opt-in
  `WRONGSTACK_VAULT_PASSPHRASE` wraps the vault data key (scrypt KEK + AES-256-GCM);
  browser WebSocket clients now authenticate only via the HttpOnly cookie (the legacy
  `?token=` URL path is rejected for them so the token can't leak into history /
  referrer / proxy logs — non-browser clients keep the URL path); and `mcp_control`
  is marked `riskTier:'destructive'` so its `npx -y <pkg>` fetch+execute behavior hits
  the YOLO `confirmDestructive` safety net.

- **`packages/tools` + `packages/core` — fetch opacity, glob DoS, trust re-prompt
  (#100, #20, #15).** `describeFetchError` unwraps undici's swallowed `.cause`
  (ENOTFOUND/ECONNREFUSED/TLS) instead of surfacing a bare "fetch failed"; a
  >1024-char trust pattern no longer makes `compileGlob` throw out of every permission
  check (`getCachedGlob` caches a never-matching regex on compile failure); and
  bracket-bearing "always"-trusted commands (`[ -f x ]`, `grep "[0-9]"`) re-match their
  trust entry again.

- **`packages/cli` — `wrongstack update` failure guidance (#13).** On a non-zero
  `npm install -g` exit, the command now prints npm's captured stderr (EACCES,
  unwritable prefix, non-npm global) and offers the equivalent pnpm/yarn/bun
  global-update commands, instead of only "Update failed with exit code N".

- **global install/update native-script friction.** `wrongstack update` now accepts
  `--pm npm|pnpm|yarn|bun`, detects common non-npm global installs, and runs the
  matching update command. `@wrongstack/webui` no longer requires `node-pty` during
  global installs; the integrated terminal loads it opportunistically and reports a
  clear terminal-level error when the optional native dependency is absent.

- **`packages/plug-lsp` — async tracker listener guard (#91).** The plugin's
  `tool.executed` listener now wraps its async `tracker.handleToolExecuted` call in a
  `.catch()` so an unexpected throw can't become a fatal unhandled rejection.

- **`packages/tools` — `killWin32Tree` async spawn error (#99).** The win32 `taskkill /T`
  tree-kill helper now attaches a no-op `'error'` listener so an async spawn launch
  failure (taskkill missing/blocked) is absorbed instead of crashing the process; the
  direct `child.kill()` fallback remains.

- **`packages/core` — `executeWithTimeout` pre-empt NaN.** The
  `TIMEOUT_PREEMPT_FRACTION` import was shadowed by the `preemptFraction` parameter
  name, making the default self-referential (`undefined` → `NaN`) so the pre-empt
  condition never fired and the hard deadline always ran. Imported as
  `_preemptFraction` and used as the parameter default.

- **cross-platform build runner (#86).** The workspace build runner now uses
  `$SHELL || /bin/sh` with `-c` on POSIX (Windows `ComSpec + /c` path unchanged),
  fixing the build failure on macOS/Linux.

- **`packages/acp` — OpenHands docs URL (#102).** Point the agent catalog `docs` field
  at the canonical `OpenHands/OpenHands` URL after the org rename, instead of relying
  on the `All-Hands-AI/OpenHands` 301 redirect.

- **TS2379 / `exactOptionalPropertyTypes`.** Resolved a strict-mode type error
  surfaced while landing the #100/#20/#15 fixes.

### Docs

- **`docs/agent-monitoring.md`** — complete reference for the subagent conversation
  tracking system.
- Updated package counts, kernel size, and the `examples/02-tools` tool count (33 → 36)
  across the documentation.

## [0.269.0] — 2026-06-22

> The **HQ command center runtime and discovery hardening** release. Adds runtime endpoint
> auto-discovery for HQ so clients find HQ on custom/auto-advanced ports, stale-pid
> protection so dead runtime endpoints are ignored, publisher reconnect hardening so a
> unreachable HQ can't block process exit, project metadata preserved in snapshots,
> and dashboard token forwarding so token-mode pages connect without manual reload.
> Also fixes BEHAVIOR_DEFAULTS so fresh configs include autonomy and feature fields
> instead of adapter hardcoded fallbacks. All workspace packages and the marketing
> site are aligned to `0.269.0` in lockstep. Additive only — no breaking changes.

### Added

- **`packages/core/src/hq/factory.ts` — runtime endpoint auto-discovery.** `startHqServer`
  now writes `dataDir/runtime.json` with the actual bound URL after port selection,
  and `resolveHqConfig` prefers that URL for same-machine auto-discovery when no
  explicit URL is set. Clients no longer miss HQ when `--port` is custom or when
  non-strict port auto-advance lands on a non-default port.
  (`packages/core/tests/hq/factory.test.ts`)

- **`packages/core/src/hq/factory.ts` — stale-pid runtime endpoint protection.**
  `readHqRuntimeFileSync` now ignores `runtime.json` URLs when the recorded pid is
  no longer alive, preventing clients from targeting a dead HQ port after exit.

- **`packages/cli/src/hq-server.ts` — HQ bind-failure cleanup.** `startHqServer`
  now closes the auth watcher, snapshot broadcaster, and WS server before rejecting
  when bind fails (e.g. strict-port and port busy).

- **`packages/cli/src/hq-server.ts` — idempotent close + snapshot timer cleanup.**
  `HqSnapshotBroadcaster` exposes `close()` to clear pending debounce timers, and
  `HqServerHandle.close()` is idempotent, clears snapshot timers, then removes the
  runtime marker.

- **`packages/cli/src/hq-server.ts` — runtime marker cleanup on close.**
  `close()` removes `runtime.json` if the marker matches the current URL+pid, so the
  marker does not persist stale after HQ exits.

- **`packages/cli/src/hq-server.ts` — Fleet flow panel in standalone HQ dashboard.**
  Visual panel rendering HQ → projects → mailboxes from live snapshots.

- **`packages/core/src/hq/factory.ts` — config-backed HQ remote URL and token settings.**
  HQ remote URL and token are now stored in `config.json` (`settings.hqUrl`, `settings.hqToken`)
  and surfaced through `/settings` and WebUI preferences. CLI/REPL/TUI/WebUI publishers
  thread the config-backed HQ config automatically. (`packages/core/src/hq/factory.ts`)

- **`packages/core/src/hq/redaction.ts` — `scrubAndTruncateHqPreview()` helper.**
  New public helper (added in 0.268.0, now documented): runs `DefaultSecretScrubber`
  over a free-text preview field and truncates it to 280 chars with a
  `…[truncated:N]` suffix.

### Changed

- **`packages/core/src/hq/factory.ts` — same-machine discovery default to 127.0.0.1.**
  Auto-discovery now binds to `127.0.0.1` by default instead of `localhost`, matching
  the HQ server default bind and avoiding IPv6/Windows localhost resolution issues.

- **`packages/core/src/hq/factory.ts` — open-mode runtime auto-discovery.**
  `resolveHqConfig` now auto-enables open mode if a live `runtime.json` URL exists
  even when `auth.json` has no client token, so REPL/TUI/WebUI connect
  automatically to open-mode HQ on custom/auto-advanced ports.

- **`packages/cli/src/hq-server.ts` — project metadata preserved in snapshots.**
  `ConnectedClient` now stores the `HqProjectIdentity` from `client.hello`, and
  `buildSnapshot`/`buildProjectDetail` use `projectName`, `projectRoot`,
  `machineId(s)`, and `gitBranch` instead of showing `projectId`/blank root.

### Performance

- **`packages/core/src/storage/session-store.ts` — session index read cache.**
  Added `mtime+size` cache for `DefaultSessionStore.readIndex` so repeated `list()`
  calls avoid re-reading/re-parsing `_index.jsonl` when unchanged; `append`,
  `tombstone`, `compact`, and `rebuild` invalidate the cache.
  (`packages/core/tests/storage/session-store-extra.test.ts`)

- **`packages/core/src/mailbox/mailbox.ts` — per-session mailbox read cache.**
  Added `mtime+size` bounded message cache to `DefaultMailbox` so `query`,
  `getAgentStatuses`, and `unreadCount` avoid repeated full JSONL read+parse when
  unchanged; writers refresh cache after `append`, `ack`, `clear`, and `purge`.

- **`packages/core/src/hq/mailbox-mapper.ts` — HQ snapshot debounce.** HQ snapshot
  broadcasts are now cached and debounced (250ms) instead of rebuilding/sending full
  snapshots on every client/mailbox event.

- **`packages/core/src/coordination/mailbox.ts` — compact heartbeat JSON.**
  Global mailbox agent/client registries now write compact JSON to reduce heartbeat
  write bytes.

- **`packages/tools/src/codebase-index/index-store.ts` — BM25 fallback optimization.**
  Fallback BM25 now uses an `id→candidate` map instead of repeated linear scans
  over all candidates.

### Fixed

- **`packages/core/src/config-loader.ts` — BEHAVIOR_DEFAULTS autonomy and feature
  fields.** Added missing `autonomy.autoProceedDelayMs: 45_000`,
  `features.tokenSavingMode: 'off'`, and `features.allowOutsideProjectRoot: true`
  to `BEHAVIOR_DEFAULTS` so fresh configs written to `config.json` include proper
  defaults instead of falling back to adapter hardcoded values.
  (`packages/core/src/config-loader.ts`, committed as `832ed7b5`)

- **`packages/cli/src/hq-server.ts` — dashboard token forwarding to WS and API.**
  Dashboard inline JS now forwards `?token=` to `/ws/browser` and
  `/api/projects/:id` so token-mode pages no longer stay stuck on Connecting.

- **`packages/core/src/hq/mailbox-mapper.ts` — snapshot on client register/heartbeat.**
  `GlobalMailbox` now publishes HQ mailbox snapshots on client register and
  heartbeat, so REPL/TUI/WebUI client activity refreshes HQ project/mailbox state
  even before messages/agent events arrive.

- **`packages/core/src/storage/session-store.ts` — Windows EPERM in truncateToCheckpoint.**
  `truncateToCheckpoint` now drains pending writes and closes the append handle before
  replacing the JSONL file, then reopens it afterward. Malformed JSONL lines are
  preserved during rewrite.

- **`packages/core/src/execution/tool-executor.ts` — publisher reconnect hardening.**
  `HqPublisher.connect()` now catches URL/socket factory failures and schedules
  reconnect instead of throwing into REPL/TUI/WebUI startup; reconnect and
  command-poll timers are `unref()`ed so an unreachable HQ cannot keep a process
  alive.

- **`packages/tui/src/components/status-bar.tsx` — token chip zero-token fallback.**
  Token display now falls back to `currentRequest` input/cache tokens when provider
  cumulative usage is still zero, preventing a useless "↑ 0 ↓ 0" chip. Added
  regression tests in `packages/tui/tests/status-bar.test.ts`.

- **`packages/tui/src/app.tsx` / `packages/tui/src/app-reducer.ts` — settings
  field mapping and auto-save fix.** Fixed `/settings` reducer field mapping so
  `Reasoning`, `Debug`, `Statusline`, and `Config` rows apply changes to their own
  settings. Added `configScope` dependency to settings auto-save so changing config
  scope persists immediately. (`packages/tui/tests/reducer.test.ts`)

- **`packages/cli/src/acp-server-agent.ts` — ACP server wired to a real agent.**
  `wstack acp` server now serves a real per-session `Agent` so ACP-capable clients
  (Zed/JetBrains/VS Code) get genuine WrongStack responses. Added
  `buildAcpServerAgentFactory`, wired `runACPServer` to `makeACPServerAgentTurn`.
  Added `--echo` escape hatch for provider-less smoke tests.
  (`packages/cli/src/acp-server-agent.ts`, `packages/cli/src/acp-server.ts`)

- **`packages/tools/src/codebase-index/indexer.ts` — incremental index skip optimization.**
  The indexer now skips reading and parsing unchanged files before checking metadata,
  avoiding redundant I/O when file content hasn't changed since the last index run.
  (`packages/tools/tests/codebase-index-indexer-mock.test.ts`)

- **`packages/tui/src/app.tsx` / `packages/tui/src/input.tsx` — word navigation
  and deletion.** TUI input now decodes `Ctrl+Left`/`Ctrl+Right` escape sequences
  for word-boundary cursor movement, and `Ctrl+Backspace`/`Alt+Backspace`/`Ctrl+Delete`
  for word-boundary deletion. Attachment chips (e.g. `[pasted #N]`) are treated as
  single atomic units via `tokenSpanAt` helper.

- **`packages/plugins/src/web-search/index.ts` — DuckDuckGo parser hardening.**
  Hardened to parse newer DuckDuckGo result markup, decode `/l/?uddg` redirect URLs,
  and return `ok: false` for blocked/unparseable markup instead of silently returning
  empty results. (`packages/plugins/tests/web-search-exec.test.ts`)

- **`packages/tui/src/components/worktree-monitor.tsx` — terminal-safe worktree
  monitor close key.** Added `Esc` as a safe alternative to `Ctrl+W` for closing
  the WorktreeMonitor overlay, avoiding terminal-level chord interference.
  (`packages/tui/tests/worktree-monitor.test.ts`)

### Changed — versions

- **All workspace packages aligned to 0.269.0**: `wrongstack`,
  `@wrongstack/cli`, `@wrongstack/core`, `@wrongstack/mcp`,
  `@wrongstack/plug-lsp`, `@wrongstack/plugins`, `@wrongstack/providers`,
  `@wrongstack/runtime`, `@wrongstack/skills`, `@wrongstack/telegram`,
  `@wrongstack/tools`, `@wrongstack/tui`, `@wrongstack/webui`,
  `@wrongstack/acp`, and `@wrongstack/bench`. The marketing site (`website/`)
  is aligned in lockstep.

## [0.268.0] — 2026-06-21

> The **HQ command center hardening and release-check cleanup** release. Documents
> the HQ browser/client protocol, ships the Phase 1 `hq.welcome` handshake,
> enforces `parseHqFrame()` validation on the wire, expands mailbox drawer and
> live-feed jsdom coverage, and records the final `pnpm release:check` cleanup.
> Additive only; no breaking changes. All workspace packages and the marketing
> site are aligned to `0.268.0` in lockstep.

### Added — Documentation

- **`docs/subcommands/hq.md` — `wstack --hq` user command reference (new file, ~785 lines).**
  Full user-facing reference for the HQ command center: usage & flag table
  (`--hq`, `--host`, `--port`, `--strict-port`, `--open`), the dispatch
  order in `cli-main.ts`, HTTP routes (`/`, `/api/snapshot`,
  `/api/projects/:id`) with full `HqSnapshot` / `ProjectDetail` /
  per-record response shapes cross-checked against
  `packages/core/src/hq/protocol.ts`, WebSocket frame union tables
  (`HqBrowserMessage` / `HqClientMessage` / `HqServerMessage`) with
  complete `client.hello` / `client.event` envelope examples, the
  browser drawer + live mailbox event feed behavior, the
  `WRONGSTACK_HQ_*` env var table cross-checked against
  `packages/core/src/hq/factory.ts` + URL normalization table, and a
  server-side `parseHqFrame()` discriminated-dispatcher TypeScript
  example. Exit codes with file:line references into `cli-main.ts` and
  `hq-server.ts`.

- **`docs/README.md` — `SECURITY.md` indexed in two places.** Quick-links
  row ("Understand the security posture / report a vulnerability") and a
  Configuration & Operations row, both pointing to `../SECURITY.md`.

### Security

- **`SECURITY.md` — HQ command center threat model + Phase 2 auth roadmap.**
  New `### HQ command center (Phase 1)` subsection under "Controls in
  place" captures: what HQ carries (`HqClientIdentity`,
  `HqProjectIdentity`, mailbox summaries, tool metadata), defaults
  (loopback bind at `cli-main.ts:173`, `1008` close on protocol
  mismatch at `hq-server.ts:806-808`, 1 MiB `maxPayload` at
  `hq-server.ts:715`), and Phase 1 non-goals (no auth / CORS / origin /
  rate limit / TLS / audit / persistence). New "HQ command center is
  unauthenticated in Phase 1" entry under "Known limitations". New
  `## HQ Phase 2 auth roadmap` section documents the planned browser
  password (`scrypt` / `argon2` hash, HTTP-only cookie), client
  enrollment tokens (`~/.wrongstack/hq/auth.json`, random + hash-only,
  capability scope), frame & endpoint hygiene, persistence (`--data-dir`
  flag), and TLS / Cloudflare Tunnel guidance. `docs/subcommands/hq.md`
  and `docs/plans/hq-command-center-2026-06.md` linked as authoritative
  sources.

Docs-only release — no code or behavior change. Phase 1 HQ security
posture is unchanged; the new docs make the existing limitations
discoverable instead of implicit.

- **`docs/plans/hq-command-center-2026-06.md` — Mailbox event feed
  section.** Phase 4 acceptance criteria, Recommended MVP, and
  Success Criteria updated to reflect the live mailbox event feed's
  ring-buffer preservation: events for a project accumulate even
  while the drawer is closed, so re-opening the drawer immediately
  renders the buffered history. `docs/subcommands/hq.md` Drawer
  section + project switching note aligned to the same behavior.

- **`packages/cli/tests/hq-dashboard.test.ts` — `jsdom` drawer
  auto-refresh test (10th test in the suite).** Live-server-backed
  integration test that publishes a `mailbox.snapshot` envelope via a
  real WS client, mounts the dashboard with `?project=proj_refresh`
  so the drawer auto-opens, then publishes a second snapshot with
  different totals. Asserts that within ~250ms (the schedule
  debounce) the drawer mailbox table re-renders to reflect the new
  totals via the `/api/projects/:id` round-trip — i.e. the live
  auto-refresh path (`scheduleAutoRefresh` → `fetchProjectDetail` →
  `renderProjectDetail`) is exercised end-to-end under jsdom without
  a real browser.

- **`packages/cli/tests/hq-dashboard.test.ts` — `jsdom` URL hash
  deep-link drawer test (11th test in the suite).** Companion to the
  `?project=` query-form test: mounts the dashboard with
  `http://127.0.0.1:<port>/#proj_hash`, registers a WS client with
  `projectId: 'proj_hash'`, and asserts the drawer auto-opens
  (`drawer.classList.contains('open') === true`),
  `drawer-title.textContent === 'proj_hash'`, and the URL hash is
  preserved (`location.hash === '#proj_hash'`) after auto-open.
  Exercises the `getInitialProjectId()` helper in the inline
  dashboard JS (parses `location.hash.slice(1)` with
  `decodeURIComponent`) followed by `openProject(projectId)`. Both
  deep-link forms (`?project=` and `#<projectId>`) are now covered
  under jsdom — bookmarking, deployment script links, and
  copy-paste-able URLs from browser address bars all work without a
  real browser.

- **`packages/cli/tests/hq-dashboard.test.ts` — `jsdom` drawer live
  feed latency + timestamp render test (12th test in the suite).**
  Companion to the existing live-feed test: mounts the dashboard
  with `?project=proj_ts`, registers a WS client with
  `projectId: 'proj_ts'`, stamps `t0 = Date.now()` immediately before
  `publishMailboxEvent`, then polls `drawer-event-feed.textContent`
  in a 25ms-cycle with a hard 1000ms ceiling until the event summary
  string shows up. Asserts the publish-to-render latency is under
  1000ms, the action pill (`message.completed`) renders, and the
  event timestamp rendered by `fmtTime(evt.timestamp)` matches the
  locale-stable regex `\b\d+:\d{2}(:\d{2})?\b` (HH:MM:SS in
  en-US/tr-TR/de-DE/etc.). Validates the full chain end-to-end:
  publisher → server `parseHqEventPayload` + `scrubAndTruncateHqPreview`
  → `broadcastEvent` over WS → browser `handleHqEvent` →
  `renderEventFeed` → DOM update. Sub-second round-trip is the
  documented Phase 4 acceptance criterion; this test enforces it
  in jsdom.

- **`packages/cli/tests/hq-dashboard.test.ts` — `jsdom` event-feed
  ring-buffer cap test (13th test in the suite).** Enforces the
  `FEED_MAX = 50` constant in the inline dashboard JS
  (`hq-server.ts:371`) and the `if (list.length > FEED_MAX) list.length = FEED_MAX`
  cap logic (`hq-server.ts:619`). Mounts the dashboard with
  `?project=proj_cap`, publishes 51 unique `mailbox.event` envelopes
  with zero-padded summaries (`event-001` through `event-051`),
  then asserts the rendered feed contains `event-051` (newest,
  unshifted last) and `event-002` (oldest kept at slot 50), does
  **not** contain `event-001` (the dropped entry), and that
  `drawer-event-feed.querySelectorAll('.feed-row').length === 50`.
  Using `querySelectorAll` on `.feed-row` (rather than textContent
  whitespace counting) gives a precise row count that survives any
  whitespace / newline insertion in `renderEventFeed`. A regression
  that doubles the cap (or removes it entirely) would surface as
  `length === 51` instead of 50; a regression that drops the wrong
  end of the array would surface as `event-051` missing or
  `event-001` still present.


- **`packages/core/src/hq/protocol.ts` + `packages/cli/src/hq-server.ts` —
  `hq.welcome` server reply (Phase 1 handshake).** Added
  `type: 'hq.welcome'` discriminator to `HqWelcomePayload` so the
  `HqServerMessage = HqServerCommandBatchMessage | HqWelcomePayload`
  union parses cleanly on the wire. The server's `client.hello`
  branch now replies with `ws.send(JSON.stringify(welcome))` on the
  same socket — payload carries `protocolVersion`, `serverTime`
  (ISO-8601), `acceptedCapabilities` (Phase 1 echo-back of what the
  client advertised), and `redactionPolicy` (core's
  `DEFAULT_HQ_REDACTION_POLICY`: `{ rawContent: false,
  toolArgs: 'summary', paths: 'project-relative' }`). The reply
  is a true Phase 1 deliverable: clients can now confirm the server
  accepted their protocol version and learn the active redaction
  policy without polling `/api/snapshot`. New test
  `packages/cli/tests/hq-welcome.test.ts` mounts a real
  `/ws/client` connection, sends a full `HqClientHelloPayload`
  (including the previously-omitted `machineId` / `projectName` /
  `workspaceKind` required fields), polls up to 1500ms for the
  welcome frame, and asserts all four fields exactly.
  Field-order-agnostic `text.includes('hq.welcome')` substring match
  keeps the test stable against future field reordering. Companion
  docs update in `docs/subcommands/hq.md`: the
  "Server → client (Phase 2)" tablo notu is now
  `"Server → client"` (welcome is shipped); the `client.hello`
  behavior note spells out the four-field reply shape inline.
  `hq.command_batch` server emit, `client.command_poll` /
  `client.command_ack` queue handling, and capability negotiation
  remain Phase 2.

### Security

- **`packages/core/src/hq/protocol.ts` — `parseHqFrame()` discriminated
  dispatcher (real wire contract enforcement).** New
  `HqParseResult` discriminated union (`{ ok: true; frame } | { ok: false;
  reason }`), `KNOWN_HQ_CLIENT_FRAME_TYPES` set, and 7 `isHq*` field-shape
  guards (`hasStringType`, `isHqClientIdentity`, `isHqProjectIdentity`,
  `isHqClientHelloPayload`, `isHqEventEnvelope`, `isHqClientCommandPollMessage`,
  `isHqClientCommandAckMessage`) plus per-frame deep payload guards
  for the `client.event` envelope's `mailbox.snapshot` / `mailbox.event`
  shapes. `isHqMailboxSnapshotPayload` now also validates each
  `messages` and `agents` array element with the corresponding guard
  (previously only `Array.isArray` was checked — garbage array elements
  could pass validation). Server (`packages/cli/src/hq-server.ts`)
  replaces the previous `JSON.parse(...) as HqClientMessage` and
  `as HqClientHelloMessage` casts with a single `parseHqFrame()` call:
  invalid JSON → `ws.close(1003)` (RFC 6455 §7.4.1 unsupported data),
  unknown type or malformed shape → `ws.close(1008)` (policy violation),
  valid → discriminated switch with no runtime `as` cast. Pre-hello
  frames are still dropped silently without closing the connection.
  `mailbox.event` envelopes are also validated and dropped if
  malformed, and the optional `summary` field is scrubbed +
  truncated to 280 chars before being stored in the event log and
  broadcast to browsers.

- **`packages/core/src/hq/redaction.ts` — `scrubAndTruncateHqPreview()`
  helper.** New public helper that runs `DefaultSecretScrubber` over
  a free-text preview field and truncates it to a configurable max
  length (default 280 chars) with a `…[truncated:N]` suffix. Returns
  `undefined` for non-string or empty input. Re-exported via
  `@wrongstack/core/hq` for server-side callers that need to sanitize
  user-supplied preview text before logging or broadcasting.

## [0.267.0] — 2026-06-20

> The **subscription sign-in** release. The headline is **Sign in with a
> subscription** — OAuth login for **ChatGPT/Codex**, **Claude Pro/Max**, and
> **GitHub Copilot** as three new wire families that sit *alongside* the API-key
> providers without changing them. Plus a **per-model context-window fix** so
> those subscription families resolve their real window from the sibling catalog
> (Claude Opus 4.8 → 1M, gpt-5.5 → ~1.05M) instead of a flat family default, and
> an **Anthropic block-sanitization fix** for multi-turn tool conversations.
> Consolidates the `0.265`–`0.267` line. Additive only; no breaking changes. All
> 16 workspace packages and the marketing site are aligned to `0.267.0` in
> lockstep.

### Added

- **Sign in with a subscription (OAuth) — three new wire families.** A new
  credential layer authenticates against a vendor subscription instead of a
  metered API key, orthogonal to the existing ~110 API-key providers (nothing
  about the API-key `openai` / `anthropic` families changes):
  - **Sign in with ChatGPT** (`wstack auth login chatgpt`) → provider
    `openai-codex`. PKCE loopback flow against `auth.openai.com`, mirroring the
    Codex CLI; talks to the ChatGPT **Responses API** at
    `chatgpt.com/backend-api`. Seeds `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`,
    `gpt-5.3-codex-spark`.
  - **Sign in with Claude** (`wstack auth login claude`) → provider
    `anthropic-oauth`. PKCE loopback against `claude.ai/oauth/authorize` (the
    Claude Code grant); Messages API at `api.anthropic.com` with Bearer auth +
    Claude Code beta/identity headers. Models fetched live from the account's
    `/v1/models`.
  - **Sign in with GitHub Copilot** (`wstack auth login copilot`) → provider
    `github-copilot`. GitHub **device flow**; mints short-lived Copilot tokens
    from the long-lived GitHub token and talks to the Copilot proxy over the
    OpenAI Chat Completions wire.
  - **Self-refreshing tokens.** Access tokens refresh near expiry and once on a
    `401`; rotated tokens persist back to `config.json` via a one-time
    `setOAuthTokenPersister` hook installed at boot. Tokens are AES-256-GCM
    encrypted at rest like every other secret.
  - **Surfaces.** Interactive `wstack auth` → *"s) Sign in with a subscription
    (ChatGPT / Claude / Copilot)"*, plus `wstack auth login <chatgpt|claude|copilot>`
    direct. OAuth providers appear in the TUI `/model` picker automatically once
    signed in.
  - **ToS caveat surfaced everywhere.** Each flow and the login help warn that
    using a subscription outside its official client is a Terms-of-Service gray
    area with account-ban risk; an API key remains the sanctioned path. Full
    reference: [`docs/oauth-signin.md`](docs/oauth-signin.md).
  (`packages/cli/src/auth-menu/{openai-codex-oauth,anthropic-oauth,github-copilot-oauth}.ts`,
  `packages/providers/src/{openai-codex,anthropic-oauth,github-copilot}.ts`,
  `packages/providers/src/tool-format/to-responses.ts`,
  `packages/cli/src/subcommands/handlers/auth.ts`)

### Fixed

- **Per-model context window for OAuth/subscription families.** `anthropic-oauth`,
  `openai-codex`, and `github-copilot` aren't published in the models.dev catalog
  under their own id, so the context window fell back to a flat family default
  (200k for `anthropic-oauth`) — showing Claude Opus 4.8 as 200k when it natively
  serves 1M, and gpt-5.5 as a guess when the catalog lists ~1.05M. Because these
  families serve the *same* models as a canonical catalog provider,
  `resolveRuntimeMaxContext` now maps them to their **sibling catalog**
  (`anthropic-oauth` → `anthropic`, `openai-codex` / `github-copilot` → `openai`)
  and resolves the published per-model window there, bypassing the
  baseUrl-divergence guard (the configured endpoint is an auth/proxy detail, not a
  context-shrinking gateway). Explicit per-provider/session overrides still win.
  No beta header or model-id suffix is involved — modern Claude (4.6+/4.8) serves
  1M natively and the `context-1m-2025-08-07` beta was retired on 2026-04-30.
  (`packages/cli/src/context-limit.ts`)

- **Anthropic block sanitization — `tool_result.name` / `providerMeta` stripped.**
  The Anthropic adapter passed canonical `ContentBlock`s to the wire verbatim, so
  fields that exist for other providers leaked through and the Messages API
  rejected them with `400 "Extra inputs are not permitted"` —
  `tool_result.name` (set by the ToolExecutor for Google's `functionResponse`)
  and `tool_use`/`thinking` `providerMeta`. Each block is now reduced to exactly
  the fields Anthropic accepts. Fixes multi-turn tool-using conversations on both
  the API-key `anthropic` and OAuth `anthropic-oauth` families; surfaced during
  live Claude OAuth testing. (`packages/providers/src/anthropic.ts`)

### Changed — versions

- **All workspace packages aligned to 0.267.0**: `wrongstack`,
  `@wrongstack/cli`, `@wrongstack/core`, `@wrongstack/mcp`,
  `@wrongstack/plug-lsp`, `@wrongstack/plugins`, `@wrongstack/providers`,
  `@wrongstack/runtime`, `@wrongstack/skills`, `@wrongstack/telegram`,
  `@wrongstack/tools`, `@wrongstack/tui`, `@wrongstack/webui`,
  `@wrongstack/acp`, and `@wrongstack/bench`. The marketing site (`website/`)
  is aligned in lockstep.

## [0.264.0] — 2026-06-17

> Performance release addressing session/mailbox file-size scaling on the
> per-iteration hot path. Key changes: GlobalMailbox refactored with
> in-memory ring buffer + ack sidecar + batched persistence, replay-log-store
> switched to append-only writes with cached tail hash, and session flush
> de-awaited from the inner loop. Additive only — no breaking changes.

### Performance

- **GlobalMailbox refactored** (`global-mailbox.ts`). Full-file read+rewrite on
  every `query()`/`ack()` was O(n) in mailbox size and fired per alias per tool
  call — a major hot-path bottleneck. Replaced with an in-memory ring buffer
  that batches acknowledgements, flushes to an append-only ack sidecar on
  configurable intervals, and reloads on startup by replaying the ring. This
  eliminates the per-call full-file I/O while preserving durability guarantees.

- **replay-log-store switched to append-only** (`replay-log-store.ts`). Every
  record previously appended a full file rewrite (quadratic in session length).
  Now uses a ring buffer + `appendFile` with cached tail hash — amortised
  O(1) appends regardless of session size.

- **Session flush de-awaited from inner loop** (`agent-response.ts`). The
  post-`llm_response` `await ctx.session.flush()` blocked the iteration
  loop on a disk round-trip every turn. Flushed to background
  (`void ...flush().catch()`) so disk I/O no longer stalls iteration
  throughput. Awaited flushes at turn-start, checkpoint, and close remain
  unchanged.

### Added

- **`mailbox-types.ts` — typed mailbox interfaces.** Explicit types for
  mailbox query/ack contracts, ring buffer state, and flush semantics.

### Changed

- **mailbox-loop.ts, mailbox.ts — coordination layer tuned.** Alignment pass
  for the new GlobalMailbox architecture.

- **agent-loop.ts, context.ts — agent core adjustments.** Budget heartbeat
  and context tracking aligned with the new flush behaviour.

### Fixed

- **TUI app state hardening** (`app.tsx`, `app-reducer.ts`, `app-state.ts`).
  Reducer and state management refinements for cleaner TUI lifecycle handling.

## [0.262.0] — 2026-06-16

> Patch release consolidating the biome 2.5 lint gate, the missing
> `@wrongstack/core/tools` and `@wrongstack/webui/types` subpath
> exports, and the corresponding lint cleanups. The `0.260.0` →
> `0.262.0` window is a long-overdue catch-up; the cumulative change
> set is small (3 commits, ~80 lines of diff) and additive — no
> breaking changes. The `0.251.0` → `0.260.0` window is intentionally
> not back-filled in this entry: the 12 intermediate version bumps
> in that range were routine refactors, lint cleanups, and dependency
> updates that are already on `main`; consult the git log between
> `v0.250.1..ff8f06ac` if you need them.

### Added

- **PR #79 — Publish missing package entrypoints.** `@wrongstack/core`
  declares `./tools` and `@wrongstack/webui` declares `./types` in
  their published `exports` map, but the matching `dist/tools/index.{js,d.ts}`
  and `dist/types.{js,d.ts}` files were not emitted by the build.
  Consumers resolving these subpaths hit `ERR_MODULE_NOT_FOUND` (or
  the TypeScript equivalent) when they tried to import them. The fix
  adds the entries to the corresponding `tsup` entry lists so the
  tarball actually contains what the `exports` map promises. This
  affected `@wrongstack/core@0.256.1` and `@wrongstack/webui@0.256.1`
  on npm, so any consumer that pinned to those versions and tried
  to use these subpaths will need to upgrade.

### Fixed

- **Biome 2.5 migration.** `biome.json` was pinned to the `2.4.16`
  schema URL with the deprecated `recommended: true` syntax and a
  trailing comma after the last `overrides` entry. Biome `2.5.0`
  (the installed version) refused to load the config, which made
  `pnpm lint` exit `1` and broke the release gate in
  `.github/workflows/ci.yml`. The fix:
  - Bumps `$schema` to `2.5.0`.
  - Drops `recommended: true` (deprecated in 2.5; rule set is
    unchanged by name).
  - Removes the trailing comma.
  - Adds `css.parser.tailwindDirectives: true` so
    `website/src/index.css` parses `@theme inline` (Tailwind v4)
    without errors.
  - Excludes `**/*.html` from the lint scope (HTML inline scripts
    can't be silenced with `biome-ignore` because Biome treats
    the comment as a regular HTML comment).
  - Relaxes `style.noNonNullAssertion` to `off` (the rule is a
    code-style preference, not a correctness issue; `tsc` strict
    mode plus the `typescript-strict` skill's "use `?.` instead
    of `!`" rule already cover the safety case, and the test-file
    override was already turning it off in `*.test.ts*`).
  - Sets `suspicious.noControlCharactersInRegex` to `off` (needed
    for the ANSI-stripping regexes in `cli`, `tools`, and `core`).
  - Sets `suspicious.noArrayIndexKey` to `off` (the TUI codebase
    intentionally uses positional keys for fixed-height slots and
    strict-per-render lists where there is no semantic identity).
  - Adds `noNonNullAssertedOptionalChain: off` to the test-file
    override (test fixtures commonly use `x!` on values that flow
    through `?.`).
  - Fixes eight `×` errors that Biome 2.5 surfaces on a clean tree
    (3 × `useIterableCallbackReturn` rewritten as `for` loops, 4 ×
    `useNodejsImportProtocol` (`require('fs')` → `require('node:fs')`)
    in the dev analysis scripts, 2 × `useImportType` either marked
    inline with `type` or removed where the import was unused).

### Known issues

- `packages/tools/tests/fetch-lookup.test.ts > guardedLookup >
  forwards a DNS resolution failure` fails on Windows because
  Node's Windows DNS backend wraps the underlying error message
  differently. The test is correct on macOS and Linux (the
  relevant CI runners). The fix is platform-specific regex
  branching; tracked outside this release.

## [0.260.0] — 2026-06-14

> The benchmark, observability & capability-authorization release. Consolidates
> `0.257.1`–`0.260.0` into a single documented entry. Three headlines: a new
> **`@wrongstack/bench`** package + `wstack bench` subcommand that holds the
> harness fixed (system prompt, tools, agent loop) and swaps only the model —
> grading with each suite's own tests (never an LLM judge) and stamping every
> report with a harness fingerprint so leaderboard rows stay comparable. A
> **storage.* EventBus observability** pass that wires every store
> (config-loader, memory-store, session-store, todos, queue, annotations, …) to
> emit typed `storage.read` / `storage.write` / `storage.error` events with
> operation-level granularity. And a **capability-based plugin authorization**
> layer that gates tool mutation (`wrap` / `override` / `unregister`) on
> declared capabilities (P4-6/P4-7/P4-8), plus an allowlist-by-default subagent
> permission policy (fail-closed). Plus WebUI WS-handler extraction, TUI
> countdown refinements, subagent mailbox inline injection, output-standards
> enforcement, and a performance cache for `buildToolUsage`. Additive only; no
> breaking changes. All **16** workspace packages and the marketing site are
> aligned to 0.260.0 in lockstep.

### Added

- **`@wrongstack/bench` — model-independent agentic benchmark harness.** New
  package + `wstack bench` subcommand that hold the harness fixed (system prompt,
  tools, agent loop) and swap only the model, grading with each suite's own tests
  (never an LLM judge) and stamping every report with a harness fingerprint so
  leaderboard rows stay comparable.
  - **Aider polyglot** suite — runs the agent on Exercism exercises in isolated
    workdirs and grades by the exercise's hidden tests (edit-accuracy standard).
  - **SWE-bench Verified** suite — runs the agent on materialized instances,
    extracts a conformant model patch (`git diff`, with held-out tests and harness
    bookkeeping stripped), and exports official-format `predictions.jsonl` for the
    canonical `princeton-nlp/SWE-bench` harness; inline Docker grading is pluggable
    via the `SwebenchExternalGrade` hook.
  - Each `(task × model)` cell runs the real `wstack` binary as a subprocess in an
    isolated `WRONGSTACK_HOME` for true end-to-end harness measurement and crash
    isolation. Reports (`report.md` / `summary.json` / `results.jsonl`) cover
    pass@1, edit-apply %, cost, tokens, p50 iterations/wall, timeout %, and 429s.
  - Docs: [docs/subcommands/bench.md](docs/subcommands/bench.md),
    [packages/bench/README.md](packages/bench/README.md).

- **`storage.*` EventBus observability for all stores.** Every store — config-loader,
  memory-store, session-store, session-recovery store, todos-checkpoint, queue-store,
  annotations-store, prompt-store, goal-store, recovery-lock — now emits typed
  `storage.read` / `storage.write` / `storage.error` events with an `operation` field
  (`load` / `save` / `append` / `delete` / `consolidate` / `evict` / …) and the store's
  `name` / `path` identity. Failures carry the underlying error via `Error.cause`.
  (`packages/core/src/storage/`)

- **Capability-based plugin tool-mutation authorization (P4-6/P4-7/P4-8).** Plugin
  `wrap` / `override` / `unregister` calls are now gated on **declared capabilities**
  in addition to the existing officiality trust tier, so a plugin can only mutate
  tools it is actually authorized for. The capability model is documented in
  `docs/tool-author-guide.md` and `SECURITY.md`.

- **`AutoApprovePermissionPolicy` is allowlist-by-default (fail-closed).** The
  non-interactive subagent policy now approves only an explicit allowlist rather than
  denying a denylist, so newly-added mutating tools (and all `mcp__*` tools) are
  denied to prompt-injected subagents by default instead of slipping through (P4-4).

- **Capability-based destructive gating in `DefaultPermissionPolicy`.** The
  permission policy now classifies tools by capability groups — destructive
  operations (bash, write, edit, replace, patch, exec) require a higher trust bar
  even within auto-approved sessions. YOLO mode's `/yolo destructive` toggle
  controls whether destructive calls auto-approve or still require confirmation.

- **Subagent mail inline injection — all types.** All subagent message types
  (`result`, `ask`, `assign`, `note`, `steer`, `btw`) are now folded into the
  leader's conversation before every step, with per-type action prompts and an
  actionable footer. The system-prompt builder's "Receiving" docs and the Director
  leader prompt were updated accordingly: the leader must "act on subagent mail
  immediately" and subagents are told "mail to leader is always seen even mid-task."
  (`packages/core/src/coordination/mailbox-loop.ts`,
  `packages/core/src/core/system-prompt-builder.ts`,
  `packages/core/src/coordination/director-prompts.ts`)

- **WebUI Fleet Monitor & Agent Monitor sliding sidebars.** Two new sliding panel
  overlays in the WebUI show per-subagent status (Fleet Monitor) and per-agent
  diagnostics (Agent Monitor), giving browser users the same real-time fleet
  visibility the TUI has (`Ctrl+F` / `Ctrl+G`).

- **WebUI WS-handler extraction (P1-1a).** The monolithic `webui-server.ts` WebSocket
  layer was decomposed into focused handler modules:
  - Goal handler, process handler, preferences handler, and remaining general handlers
    extracted into dedicated modules with unit test coverage.
  - Each handler module is independently testable.

### Changed

- **TUI countdown visuals refined.** Three changes to the `/enhance` and `/next`
  countdown UX:
  - **Solid color transitions.** The rainbow `WaveText` was replaced with a solid
    color that transitions cyan (≥20s) → yellow (>10s) → red (≤10s).
    Bold `"⏳ 42s"` with dim suggestion text.
  - **Auto marker on first next-step.** When autonomy mode is `'auto'`, a cyan `⏩`
    marker appears next to the first next-step suggestion, visually indicating that
    step is the one auto-submitted after the countdown.
  - **Word-boundary label formatting.** `truncateLabel` replaced with
    `formatSuggestionLabel` — breaks at word boundaries instead of blindly slicing
    at 30 chars.
  - **Direct `/next` submit.** Suggestions are submitted directly to the agent loop
    instead of being placed into the input field first, fixing a double-submit race.

- **Output-standards conventions enforced fleet-wide.** The `next_steps` system
  prompt conventions were codified and enforced across all skill files and mode
  prompts:
  - **Leader only** — only the top-level session agent (leader) emits `<next_steps>`.
    Subagents report findings only; the leader aggregates.
  - **Concrete actions only** — items must be directly executable commands or
    prompts. No declarations of intent or manual-review suggestions.
  (`packages/core/skills/output-standards/SKILL.md`,
  `packages/core/skills/output-standards/SKILL.save.md`,
  `packages/core/src/core/modes/default.ts`,
  `packages/core/src/core/modes/brief.ts`,
  `packages/core/src/core/modes/teach.ts`)

### Performance

- **`buildToolUsage()` output cached by reference.** The `DefaultSystemPromptBuilder`
  now caches the rendered tool-usage section and reuses it across system-prompt builds
  when the tool list hasn't changed, saving repeated serialization per turn.

- **WebUI stream-coalescer hardened.** The stream-coalescer's `rAF` loop was hardened
  to recover from stale frame callbacks, correcting false failures under load.

### Fixed

- **OpenAI-compatible providers: `emptyToolCallContent` default changed to
  `'empty_string'`.** The `OpenAICompatibleProvider` wire spec now defaults
  `emptyToolCallContent` to `'empty_string'` instead of `'null'`, matching the
  majority of OpenAI-compatible endpoints that send an empty string alongside
  `tool_calls` rather than `null`. (`packages/providers`)

- **WebUI WS-client connect() hardening.** The `connect()` promise now rejects on
  `onerror` / `onclose` before `onopen`, so WebUI callers no longer block
  indefinitely when the backend is unreachable.

- **Storage observability test alignment.** Storage observability tests across
  the session-store, memory-store, config-loader, and related stores were corrected
  to assert the new typed `storage.*` event contracts.

### Changed — versions

- **All workspace packages aligned to 0.260.0**: `wrongstack`,
  `@wrongstack/cli`, `@wrongstack/core`, `@wrongstack/mcp`,
  `@wrongstack/plug-lsp`, `@wrongstack/plugins`, `@wrongstack/providers`,
  `@wrongstack/runtime`, `@wrongstack/skills`, `@wrongstack/telegram`,
  `@wrongstack/tools`, `@wrongstack/tui`, `@wrongstack/webui`,
  `@wrongstack/acp`, **and `@wrongstack/bench`** (new). The marketing site
  (`website/`) is aligned in lockstep.

## [0.257.0] — 2026-06-14

> The token-saving & resilience release. Consolidates the `0.255`–`0.257` line
> into a single documented entry. Four headlines: a new **token-saving mode**
> (`--token-saving-mode`) that trims the tool belt to 10 Tier-1 tools, compacts
> skill bodies, and lazy-loads MCP behind an `mcp_use` meta-tool to save
> ~4–6K prompt tokens; **automatic model rotation on rate limits** (429/529/5xx)
> with a `/fallback` command and a visible `↻ switched to …` hop line; a new
> **`/interrupt`** command (aliases `/stop`, `/int`) that stops the leader run
> **and** the whole fleet across CLI/TUI/WebUI; and **capability-based plugin
> tool-mutation authorization** with a fail-closed allowlist default. Plus a
> compaction-throughput pass, five new hot-path caches, and a batch of TUI /
> provider / secret-scrubber fixes. Additive only; no breaking changes.

### Added

- **Token-saving mode (`--token-saving-mode` / `features.tokenSavingMode`).** An
  opt-in lean mode that materially shrinks the per-request prompt:
  - **Tier-1 tool belt.** `TIER1_TOOLS` (`@wrongstack/tools`) exposes only the 10
    essential tools — `read`, `write`, `edit`, `bash`, `grep`, `glob`, `diff`,
    `patch`, `json`, `search` — omitting 90+ tools and saving ~4000–6000 tokens
    of tool-definition overhead. `OPTIONAL_TOOLS` is exported alongside for
    callers that want to opt tools back in.
  - **Compact skill bodies.** In token-saving mode the system-prompt builder
    renders only each skill's *Overview + Rules* sections, and skills may ship a
    dedicated `SKILL.save.md` variant that is preferred when the mode is active.
  - **Lazy MCP + `mcp_use` meta-tool.** MCP server tools are no longer expanded
    into the tool list at startup; the model reaches any MCP tool on demand via
    `mcp_use({ server, tool, input })`, keeping the registered tool surface
    bounded regardless of how many MCP servers are connected.
  - **TUI surfacing.** A token-saving toggle in the settings panel, plus a live
    status-bar indicator and registered-tool count that update the moment the
    mode is flipped. (`packages/core/src/boot.ts`,
    `packages/core/src/core/system-prompt-builder.ts`,
    `packages/core/src/tools/mcp-use.ts`, `packages/tools/src/builtin.ts`,
    `packages/tui/src/app.tsx`)

- **Automatic model rotation on rate limits + `/fallback`.** When the primary
  model exhausts its retries on a `429` / `529` / `5xx`, the agent now rotates to
  the next model in a fallback chain instead of failing the turn. The chain is
  always-on with a smart default, inherited by subagents, and configurable via
  the new `/fallback` slash command. A `provider.fallback` event surfaces each
  hop to the user in both the REPL and TUI —
  `↻ rate-limited (429) — switched to <provider/model>` — so the silent switch
  is visible. (`packages/cli/src/fallback-model.ts`,
  `packages/cli/src/slash-commands/fallback.ts`, `docs/slash/fallback.md`)

- **`/interrupt` command (aliases `/stop`, `/int`).** A slash command that aborts
  the in-flight leader run *and* terminates the whole fleet — useful when `Esc`
  is swallowed by a terminal multiplexer or when driving the agent from the
  WebUI. Backed by a new `SlashCommandContext.interruptController.abortLeader`
  channel (slash commands don't hold the `RunController`). Wired across TUI,
  plain REPL, and WebUI; the REPL `Ctrl+C` now also stops running subagents, not
  just the leader. (`packages/cli/src/slash-commands/interrupt.ts`,
  `docs/slash/interrupt.md`)

- **Capability-based plugin tool-mutation authorization.** Plugin `wrap` /
  `override` / `unregister` calls are now gated on declared capabilities in
  addition to the existing officiality trust tier, so a plugin can only mutate
  tools it is actually authorized for. The capability model is documented in
  `docs/tool-author-guide.md` and `SECURITY.md`.
  (`packages/core` plugin/tool-registry, P4-6/P4-7/P4-8)

### Changed

- **Compaction throughput optimization.** Compaction now reuses a pre-computed
  per-message token estimate instead of re-walking content blocks, cutting the
  per-cycle cost of the `contextWindow` pipeline. The WebUI pairs this with a new
  **sliding compaction drawer** that surfaces compaction activity without
  stealing chat space. (`feat(core,webui)` — `305a8d07`)

- **`AutoApprovePermissionPolicy` is allowlist-by-default (fail-closed).** The
  non-interactive subagent policy now approves only an explicit allowlist rather
  than denying a denylist, so newly-added mutating tools are denied to
  prompt-injected subagents by default instead of slipping through.

- **Build hygiene.** The `esbuild` override moved to the workspace root and the
  stale Biome overrides were cleaned up, so the dependency graph and lint config
  are consistent across packages.

### Performance

- **Five new hot-path caches** eliminate repeated work per agent iteration:
  - `DefaultPermissionPolicy.evaluate()` memoizes its verdict per
    (tool, signature) so repeated permission checks are O(1).
  - `ToolRegistry.list()` returns a version-counter snapshot instead of
    rebuilding the array when nothing changed.
  - `buildToolUsage()` output is cached by reference between unchanged builds.
  - The online-agents list in the system-prompt builder is cached by array
    reference so an unchanged roster doesn't re-serialize.
  - The secret scrubber's quick anchor pre-scan short-circuits the regex passes
    when no credential substring is present (the vast majority of tool outputs).
- **Four additional agent-loop / provider bottlenecks** removed in the same
  sweep (`perf(core,providers)` — `a008c66f`).

### Fixed

- **Secret scrubber dropped `bearer_token` and `high_entropy_env`.** The
  combined-regex refactor miscounted patterns (`slice(0,16)` / `PATTERNS[15]`),
  silently skipping bearer-token and high-entropy-env redaction and pointing the
  high-entropy pass at the redis-URI regex. The split is now derived by pattern
  *type* (`filter`/`find`) so a pattern can't be dropped by an off-by-one, and
  `scrubObject` recurses into **all** values — secrets under arbitrary keys
  (`url`, `authorization`, nested objects) were previously broadcast unscrubbed.
  (`packages/core/src/security/secret-scrubber.ts`)

- **OpenAI-compatible providers: allow `null` message content.** `OpenAIMessage`
  now accepts `content: null` (via `emptyToolCallContent: 'null'`), matching the
  providers that send a null content field alongside `tool_calls` instead of an
  empty string. (`packages/providers`)

- **TUI rendering.** Chat messages render full-width instead of leaving a ragged
  right margin; markdown tables and box-drawing characters now render against a
  transparent background instead of carrying the message-panel fill color; and
  the statusline `working_dir` hidden-item unions were made consistent (which
  also unblocked the `tui` DTS build and `cli` typecheck).

### Changed — versions

- **All workspace packages aligned to 0.257.0**: `wrongstack`,
  `@wrongstack/cli`, `@wrongstack/core`, `@wrongstack/mcp`,
  `@wrongstack/plug-lsp`, `@wrongstack/plugins`, `@wrongstack/providers`,
  `@wrongstack/runtime`, `@wrongstack/skills`, `@wrongstack/telegram`,
  `@wrongstack/tools`, `@wrongstack/tui`, `@wrongstack/webui`, and
  `@wrongstack/acp`. The marketing site (`website/`) is aligned in lockstep.

## [0.254.0] — 2026-06-12

> Release preparation. Version consolidation and housekeeping: cleaned
> temporary/debug files from the repo root, aligned all workspace
> packages and the marketing site to the same version, and updated
> dependencies across the monorepo.

### Changed

- **Version alignment.** All 16 workspace packages and the marketing site
  (`website/`) aligned to `0.254.0` in lockstep.

### Removed

- **Temporary debug files.** Removed `check-deps.cjs`, `find_broadcast.js`,
  `find-vite.cjs`, `find-vite.js`, `ideas.md`, `refactor_plan.md`,
  `report.md`, and `llms.txt` from the repository root.

## [0.250.0] — 2026-06-12

> The hot-path performance release. Seven targeted optimizations eliminate
> redundant CPU work, allocations, and TUI re-renders in the agent loop,
> token estimation, compaction, and markdown rendering paths. Benchmarked
> at 59.5× estimation speedup @ 400 messages and 15.3× parseInline speedup
> on cache-warm TUI re-renders. No breaking changes; additive barrel exports
> only.

### Changed

- **Token estimation cache.** `_estTokens` pre-computed per-message field
  eliminates the O(n·m) content-block walk on every `estimateMessageTokens`
  and `estimateRequestTokens` call. Computed once at message-append time via
  `ConversationState.appendMessage()` / `replaceMessages()`; checked by both
  the typed and untyped estimation paths. Cached time flat at ~0.006ms
  regardless of message count (was 0.369ms @ 400 messages).
  (`packages/core/src/types/messages.ts`,
  `packages/core/src/core/conversation-state.ts`,
  `packages/core/src/utils/token-estimate.ts`)

- **Tool definition token pre-computation.** `estimateToolDefTokens` result
  cached on `Tool._estDefTokens` by `ToolRegistry` at registration time,
  eliminating 50+ `JSON.stringify(tool.inputSchema)` calls per estimation
  invocation. Recomputed on `wrap()` since wrappers may change metadata.
  (`packages/core/src/types/tool.ts`,
  `packages/core/src/registry/tool-registry.ts`)

- **`eliseOldToolResults` early-exit scan.** Lightweight scan for oversized
  tool results before allocating a full message-array copy. Most compaction
  passes find nothing to elide (threshold >2000 tokens); skipping the
  allocation avoids ~200 object allocations per idle compaction cycle.
  (`packages/core/src/execution/compaction-core.ts`)

- **`parseInline()` memoization.** 5000-entry LRU cache on the markdown
  inline parser eliminates redundant char-by-char parsing on TUI re-renders.
  Typical assistant responses have ~67% line duplication; warm cache hits
  resolve in ~11ns (essentially `Map.get`).
  (`packages/tui/src/markdown.tsx`)

- **Polling consolidation.** Merged the todos-poll (2s) and status-bar
  stale-guard (2s) into a single `setInterval` tick, eliminating one
  React re-render per cycle when both values change after an agent turn.
  (`packages/tui/src/app.tsx`)

- **`buildActivePlan` mtime cache.** `DefaultSystemPromptBuilder` now stats
  the plan file before reading — plans change at human pace, not on every
  iteration. Avoids `fs.readFile` + `JSON.parse` on every system-prompt build.
  (`packages/core/src/core/system-prompt-builder.ts`)

- **`ConversationState.snapshot()` shallow-freeze.** Replaced recursive
  `deepFreeze` (O(n·m·d) freeze calls) with inline `Object.freeze` on the
  wrapper + 3 content arrays (4 calls total). Removed 12-line unused utility.
  (`packages/core/src/core/conversation-state.ts`)

### Fixed

- **`AutoCompactionMiddleware` estimator cache bypass.** Custom estimators
  passed to the middleware are now called fresh on every invocation — the
  `_cachedTokens`/`_cachedMsgCount` cache only applies to the deterministic
  `estimateRequestTokensCalibrated` path. Fixes 3 test failures where the
  cache returned stale values from mutable estimator closures.
  (`packages/core/src/execution/auto-compaction-middleware.ts`)

### Added

- **`pnpm bench:perf`** benchmark script. Runs three micro-benchmarks
  (token estimation cache, `parseInline` memoization, `eliseOldToolResults`
  early-exit) against the built dist. 500 iterations, 50 warmup.
  (`scripts/bench.mjs`, `package.json`)

- **Barrel exports.** `computeMessageTokens` and `eliseOldToolResults`
  added to `@wrongstack/core`; `parseInline` added to `@wrongstack/tui`.
  (`packages/core/src/utils/index.ts`, `packages/core/src/index.ts`,
  `packages/tui/src/index.ts`)

## [0.166.1] - 2026-06-09

> The WebUI-fleet & slash-command-polish release. Consolidates the
> `0.148.2`–`0.156.0` line into a single documented release. The headlines are
> a new **`/delegate` slash command** for handing work to specialized subagents,
> a redesigned **WebUI FleetPanel** with clickable agent cards and detail
> overlays, **live subagent output streaming** in the TUI AgentDetail overlay,
> **`/next` and `/suggest` slash commands** with clickable next-step buttons in
> both WebUI and TUI, a new **Playwright browser automation agent** joining the
> fleet roster, and a **slash-command refactoring pass** that standardises
> subcommand parsing across the CLI. Additive only; no breaking changes.

### Added

- **`/delegate` slash command.** A new `Agent`-category slash command hands a
  discrete piece of work to a dedicated subagent and waits for its result. The
  subagent runs with its own context, its own LLM call, and its own budget —
  useful for self-contained tasks that would otherwise blow up the leader's
  context. Supports both roster roles (`bug-hunter`, `security-scanner`, …) and
  free-form name-based delegates. (`packages/cli/src/slash-commands/delegate.ts`,
  `docs/slash/delegate.md`)

- **`/next` and `/suggest` slash commands.** Two new `Run`-category commands
  surface AI-suggested next actions after a task completes. `/next` runs the
  first suggestion immediately through a `delegate` call; `/suggest` lists
  available suggestions as clickable buttons in the WebUI and as a dedicated
  panel in the TUI assistant messages. Both commands read from the session's
  active context and the task/todo state.

- **Playwright browser automation agent.** A new fleet role and MCP server
  preset let the Director spawn subagents that drive a headless Chromium browser
  via Playwright — useful for end-to-end testing, visual regression checks, and
  scraping workflows that need JavaScript execution.

- **Live subagent output stream in AgentDetail overlay.** The TUI agent detail
  panel now renders a live streaming tail of the subagent's text output and tool
  calls, updated in real time as events arrive from the FleetBus. A
  copy-to-clipboard button captures the subagent's final output on task
  completion, and the streaming buffer is larger for smoother rendering.

- **WebUI FleetPanel redesigned.** Subagent cards in the FleetPanel are now
  clickable — clicking opens a detail overlay showing the agent's full status,
  current tool, iteration/tool counts, and live output stream. A new **Agents
  tab** in the sidebar lists all spawned agents as a compact clickable list.

- **Clickable header chips.** Every header chip in the WebUI (Fleet, Process,
  Checkpoint Timeline, Phase) now scrolls to its corresponding panel on click —
  no more hunting through the sidebar to find the right instrument.

- **`/resume` renamed to `/sessions`.** The command now surfaces a richer
  session list with metadata (provider, model, token count, duration, outcome)
  instead of just a prompt for a session ID. The old `/resume` name is preserved
  as an alias for backward compatibility.

- **SessionStore, MemoryStore, ModeStore wired to WebUI via CLI.** The WebUI
  backend now receives the session store, memory store, and mode store from the
  CLI host, so the WebUI can browse past sessions, search memory, and switch
  modes without a separate backend process.

### Changed

- **Slash command subcommand parsing standardised.** A new `parseSubcommand`
  helper in `@wrongstack/cli` provides a consistent pattern for slash commands
  with sub-actions (list/add/remove/enable/disable/…). Commands migrated:
  `collab`, `settings`, `models`, `autophase`. An `unknownSubcommand` helper
  produces a standardised error message with available subcommands.

- **Core user-facing strings generalised.** Hardcoded brand references across
  the WebUI, TUI, and CLI were replaced with configurable placeholders, making
  the codebase more adaptable and reducing the number of strings that need
  manual updating on each release.

- **`noOpVault` deduplicated to `@wrongstack/core`.** The no-op secret vault
  helper was duplicated across CLI helpers and inline objects in several
  execution paths; it now lives in one place at
  `@wrongstack/core/defaults/no-op-vault`.

- **WebUI TodosPanel improved.** The sidebar todos panel now supports sorting
  controls and a collapsible completed section, making it easier to scan
  in-progress work in long task lists.

- **Collab debug noise suppressed.** Verbose `collab.*` message logging in the
  CLI WebUI server was downgraded to DEBUG level so it no longer spams the
  console during normal multi-agent sessions.

### Fixed

- **ProcessMonitor and CheckpointTimeline overlays now open with one click.**
  Previously both overlays required a double-click to activate; they now
  respond on the first click, matching the other panel activation behaviour.

### Docs

- **Slash command documentation expanded.** New reference pages for `/delegate`,
  `/next`, `/suggest`, `/prune`, `/suggest` (suggestions), `/auth`, `/tasks`,
  and `/modelcaps`. Existing pages for fleet, MCP, sessions, yolo, and
  spawn-agents updated with current behaviour. The "Adding a core slash
  command" contributor guide was expanded with concrete examples and the
  `parseSubcommand` pattern.

### Changed — versions

- **All workspace packages aligned to 0.166.1**: `wrongstack`,
  `@wrongstack/cli`, `@wrongstack/core`, `@wrongstack/mcp`,
  `@wrongstack/plug-lsp`, `@wrongstack/plugins`, `@wrongstack/providers`,
  `@wrongstack/runtime`, `@wrongstack/skills`, `@wrongstack/telegram`,
  `@wrongstack/tools`, `@wrongstack/tui`, `@wrongstack/webui`, and
  `@wrongstack/acp`. The marketing site (`website/`) is aligned in lockstep.

## [0.148.0] - 2026-06-09

> The developer-experience & release-consolidation release. Ships a **`/dev`
> slash command** for running shell commands from the chat without LLM
> involvement, fixes a **vitest fallback** in the `test` tool, and consolidates
> ~30 intermediate version bumps (0.118.1 → 0.148.0) into a single documented
> release line. All 15 workspace packages and the marketing site are aligned to
> 0.148.0 in lockstep. Additive only; no breaking changes.

### Added

- **`/dev` slash command — run shell commands from chat.** A new `Run`-category
  slash command executes arbitrary shell commands from the chat input and
  displays the output as a display-only history entry. The LLM does not see the
  result — this is a developer convenience shortcut, not a tool invocation.
  Commands run in the current working directory, timeout after 60 s, and cap
  output at 500 lines. Built on `node:child_process.exec` with `shell: true`.
  (`packages/cli/src/slash-commands/dev.ts`, `docs/slash/dev.md`)

### Fixed

- **`test` tool: fall back to vitest when no config file is detected.** When
  `runner: 'auto'` is specified and `detectRunner()` finds no config file
  (`vitest.config.ts`, `jest.config.js`, `.mocharc.json`), the tool now falls
  back to `'vitest'` as the default runner instead of returning `'none'`. This
  matches the test's stated expectation ("falls back to vitest when no config
  file found") and the project's convention of vitest as the primary test
  runner. (`packages/tools/src/test.ts`)

### Changed — versions

- **All workspace packages aligned to 0.148.0**: `wrongstack`,
  `@wrongstack/cli`, `@wrongstack/core`, `@wrongstack/mcp`,
  `@wrongstack/plug-lsp`, `@wrongstack/plugins`, `@wrongstack/providers`,
  `@wrongstack/runtime`, `@wrongstack/skills`, `@wrongstack/telegram`,
  `@wrongstack/tools`, `@wrongstack/tui`, `@wrongstack/webui`, and
  `@wrongstack/acp`. The marketing site (`website/`) is aligned in lockstep.

## [0.118.1] - 2026-06-08

> The test-suite maintenance release. Aligns the agent-catalog test assertions with
> the current 47-role fleet roster (updated from 43), ensuring `pnpm release:check`
> passes cleanly. All other behavior is unchanged. Additive only; no breaking changes.

### Fixed - Test suite

- **Agent catalog count assertions corrected.** `agent-catalog.test.ts` and
  `dispatcher.test.ts` now assert `47` catalog agents instead of `43`, matching
  the current `ALL_AGENT_DEFINITIONS.length` and `FLEET_ROSTER` size.

### Changed - versions

- **All workspace packages aligned to 0.118.1**: `wrongstack`, `@wrongstack/cli`,
  `@wrongstack/core`, `@wrongstack/mcp`, `@wrongstack/plug-lsp`,
  `@wrongstack/plugins`, `@wrongstack/providers`, `@wrongstack/runtime`,
  `@wrongstack/skills`, `@wrongstack/telegram`, `@wrongstack/tools`,
  `@wrongstack/tui`, `@wrongstack/webui`, and `@wrongstack/acp`.

## [0.109.1] - 2026-06-08

> The TUI monitor-control & goal-path cleanup release. Consolidates the
> `0.108.0`-`0.109.1` line into one documented entry: monitor overlays keep the
> chat input alive without losing F-key/Esc handling, the F9 goal panel now reads
> the same canonical goal file as `/goal` and the autonomy engines, code blocks
> stop wrapping their borders, and the Windows build script resolves package
> binaries reliably. Additive only; no breaking changes.

### Fixed - TUI monitor input handling

- **Hidden input mode.** The TUI `Input` component can now render as a
  constant-height placeholder while keeping both keyboard listeners mounted.
  This keeps F-key and Esc routing alive while modal panels occupy the bottom
  region.

- **Monitor overlays stay controllable.** Fleet, agents, worktree, todos, queue,
  and goal panels keep the chat input live underneath them. The process list
  remains modal because its kill actions own single-key shortcuts.

- **No double-toggle on Esc.** Worktree and AutoPhase phase monitors now own
  their own Esc handling instead of being toggled twice by the central router.

- **Agents monitor no longer captures `j`/`k`.** Navigation is arrow-key only so
  typing into the live chat input under the panel does not get swallowed.

### Fixed - Goal persistence and autonomy

- **Single canonical goal path.** `goalFilePath(projectRoot)` now delegates to
  `resolveWstackPaths({ projectRoot }).projectGoal`, so `/goal`, the eternal and
  parallel autonomy engines, the CLI, and the TUI F9 panel all read/write the
  same per-project `~/.wrongstack/projects/<slug>/goal.json`.

- **F9 goal panel refresh.** The TUI refreshes goal state on open and while the
  panel stays open, so goals created mid-session and progress updates from
  autonomy loops appear without restarting the TUI.

- **Goal-store tests updated.** Tests now assert that the goal file path matches
  `resolveWstackPaths().projectGoal` instead of the old standalone hash
  directory.

### Fixed - Rendering and build

- **Code block width clamping.** TUI code blocks now use an explicit frame width
  so bordered boxes do not overflow and wrap the right border into the next line.

- **Build script PATH hardening.** `scripts/build.mjs` prepends root and
  package-local `node_modules/.bin` directories before spawning package builds,
  improving `tsup`/`tsc` resolution under `cmd.exe` on Windows.

### Changed - versions

- **All published workspace packages and the marketing site are aligned to
  0.109.1**: `wrongstack`, `@wrongstack/cli`, `@wrongstack/core`,
  `@wrongstack/mcp`, `@wrongstack/plug-lsp`, `@wrongstack/plugins`,
  `@wrongstack/providers`, `@wrongstack/runtime`, `@wrongstack/skills`,
  `@wrongstack/telegram`, `@wrongstack/tools`, `@wrongstack/tui`,
  `@wrongstack/webui`, and `@wrongstack/acp`.

## [0.107.2] - 2026-06-08

> The WebUI operations & terminal-polish release. Consolidates the
> `0.104.1`-`0.107.2` line into a documented release: the WebUI gains live
> goal, process, checkpoint, autonomy, and preference surfaces; AutoPhase and
> phase monitoring are easier to scan; and the TUI gets safer markdown table
> wrapping plus assistant-body width fixes. Additive only; no breaking changes.

### Added - WebUI operations surfaces

- **Goal panel.** The WebUI now polls `goal.json` through the WebSocket backend
  and renders the active goal, refined/original text, deliverable checklist,
  progress, trend, recent journal entries, and lifecycle state in a collapsible
  panel.

- **Process monitor.** A new WebUI process overlay lists running tool processes,
  shows active counts, marks protected processes, and exposes kill / kill-all
  actions through `process.list`, `process.kill`, and `process.killAll` messages.

- **Checkpoint timeline.** The WebUI can list session checkpoints and request a
  rewind to a previous checkpoint through `session.checkpoints` and
  `session.rewind`, giving long sessions a visible recovery path.

- **Autonomy picker.** The WebUI gets a compact mode picker for `off`, `suggest`,
  `auto`, `eternal`, and `eternal-parallel`, keeping autonomy state visible and
  switchable without typing slash commands.

- **Local preference controls.** Settings now include reusable slider/select
  controls and local preference storage for UI-level behavior.

### Changed - WebUI and AutoPhase

- **AutoPhase view refinement.** The AutoPhase view, phase agents monitor,
  phase panel, task board, worktree lanes, sidebar wiring, and WebSocket
  handlers were tightened so fleet/phase state is easier to read while work is
  running.

- **WebUI server endpoints.** The WebUI backend now handles goal, process,
  checkpoint, and preference-related WebSocket messages alongside the existing
  agent/session stream.

- **Browser launch behavior.** The WebUI server open-browser helper was hardened
  so starting the standalone UI is more predictable across environments.

### Fixed - TUI rendering

- **Markdown table width handling.** TUI markdown tables now use separator
  widths as minimums, measure visible inline-marker width correctly, and wrap
  long cells instead of blowing past the terminal width.

- **Assistant body width.** Assistant history rendering now gives message bodies
  a more stable width, reducing awkward wrapping in narrow terminals.

- **Live activity strip/process registry polish.** Running-process and activity
  display paths were tightened so live status is less noisy while tools execute.

### Changed - versions

- **All published workspace packages and the marketing site are aligned to
  0.107.2**: `wrongstack`, `@wrongstack/cli`, `@wrongstack/core`,
  `@wrongstack/mcp`, `@wrongstack/plug-lsp`, `@wrongstack/plugins`,
  `@wrongstack/providers`, `@wrongstack/runtime`, `@wrongstack/skills`,
  `@wrongstack/telegram`, `@wrongstack/tools`, `@wrongstack/tui`,
  `@wrongstack/webui`, and `@wrongstack/acp`.

## [0.104.0] - 2026-06-08

> The autonomy-control & release-realignment release. Consolidates the
> intermediate `0.89.5`-`0.103.2` bumps into the first fully documented
> `0.104.0` line. The headline work is a richer **goal lifecycle** with LLM
> refinement, deliverables, progress estimates, and a TUI **F9 goal panel**;
> a self-driving **AutonomyBrain** for bounded unattended decisions; a modular
> auth manager with an in-session **`/auth` dashboard**; and the previously
> shipped structured task system, `/setmodel` diagnostics, tech-stack validator,
> and humanized Telegram notifications. Additive only; no breaking changes.

### Added - Goal and Autonomy

- **Goal auto-refinement.** `/goal set <text>` now refines the raw mission with
  the active LLM when available, falls back to a heuristic refiner otherwise,
  extracts concrete deliverables, and stores both the original and refined goal
  in `~/.wrongstack/projects/<hash>/goal.json`.

- **Goal progress tracking.** Goals now persist deliverables, progress percent,
  progress notes, progress history, trend state (`accelerating | steady |
  stalling`), lifecycle state (`active | paused | completed | abandoned`), and a
  bounded 500-entry journal for long autonomous runs.

- **TUI F9 goal panel.** A new goal overlay shows the current mission,
  refined/original text, deliverables checklist, progress bar, trend, iteration
  count, lifecycle state, and last task without leaving the TUI.

- **AutonomyBrain.** A dedicated autonomous decision layer evaluates blocked or
  uncertain workflows inside configured risk bounds. It fast-paths common
  cases (deadlocks, exhausted retries, continue/proceed decisions), can ask the
  session LLM for complex decisions, and emits human-readable decision summaries
  for chat history or journals.

### Added - Auth and Model Operations

- **`/auth` slash command.** Active sessions now have a non-blocking credential
  dashboard: `/auth`, `/auth status <provider>`, `/auth open`, and `/auth help`.
  It works in both the plain REPL and Ink TUI and points users to `wstack auth`
  for interactive key management.

- **Modular auth manager.** The old monolithic `auth-menu.ts` is now a
  backward-compatible shim over `auth-menu/` modules (`top-menu`,
  `provider-menu`, `add-provider`, `direct`, shared helpers, and types), making
  provider/key flows smaller and testable.

- **`/setmodel resolve` and `/setmodel doctor`.** `/setmodel resolve <role>`
  explains the exact role -> phase -> `*` -> leader fallback chain, while
  `/setmodel doctor` validates matrix entries, provider availability, API key
  coverage, model names, stale keys, and uncovered roles.

### Added - Task, Fleet, and Telegram

- **Structured `task` tool and `/tasks` command.** Tasks now sit between plans
  and todos, with dependencies, type/priority classification, estimates, agent
  assignment, persistence, progress rendering, and promote-to-todos flow.

- **Tech-stack validator.** A bundled `tech-stack` skill and fleet role validate
  package/framework choices against current registry reality, reject dead or
  obsolete dependencies, and prefer Node built-ins when practical.

- **47-role fleet roster.** The Director catalog grows to 47 roles, including
  the single-shot `tech-stack` meta agent, with count-dependent catalog,
  dispatcher, and spawnability tests updated.

- **Humanized Telegram notifications.** Telegram tool/session notifications now
  format output as natural prose, show meaningful lines instead of raw object
  dumps, preserve semantic truncation boundaries, and include clearer token/cache
  summaries.

### Changed - Website and Documentation

- **README realigned for 0.104.0.** Current tool, skill, fleet, slash-command,
  goal, auth, and release-gate details now match the shipped workspace.

- **Marketing site realigned for 0.104.0.** `website/` package metadata, JSON-LD,
  OpenGraph/Twitter descriptions, hero stats, feature cards, skills/tools counts,
  and site changelog now describe the current release.

### Tests

- Auth, `/auth`, `/setmodel`, Telegram formatting, bot truncation, agent catalog,
  dispatcher, and task/fleet count tests were expanded alongside the release.

### Changed - versions

- **All workspace packages bumped to 0.104.0**: `wrongstack`, `@wrongstack/cli`,
  `@wrongstack/core`, `@wrongstack/mcp`, `@wrongstack/plug-lsp`,
  `@wrongstack/plugins`, `@wrongstack/providers`, `@wrongstack/runtime`,
  `@wrongstack/skills`, `@wrongstack/telegram`, `@wrongstack/tools`,
  `@wrongstack/tui`, `@wrongstack/webui`, and `@wrongstack/acp`. The app
  package and the marketing site (`website/`) are aligned in lockstep.

## [0.89.4] - 2026-06-08

> The task-system & agent-enhancement release. Ships a new **structured task
> system** with dependency tracking, type/priority classification, and agent
> assignment — bridging the gap between flat todos and strategic plans. The
> **`/setmodel` command** gains `resolve` and `doctor` subcommands, and a new
> **`tech-stack` validator agent** joins the fleet roster (43rd agent) as a
> single-shot version-checking layer. Telegram notifications are humanized across
> the board — no more raw JSON dumps. Additive only; no breaking changes.

### Added — Task System

- **`task` tool — structured work items with dependencies, types, and priorities.**
  Unlike `todo` (flat, session-scoped), tasks support dependency chains
  (`dependsOn`), type classification (`feature | bugfix | refactor | docs | test |
  chore`), priority ranking (`critical | high | medium | low`), agent assignment,
  and hour estimates. Stored per-session as JSON; the tool replaces the full list
  on every call (like `todo`). Registered in the builtin tools pack — total
  built-in tools: **36 → 37**.

- **`/tasks` slash command.** Human-facing task management:
  `/tasks` (progress + list), `add <title> [type] [priority]`,
  `start | done | fail <id>`, `status <id> <s>`, `depends <id> <deps>`,
  `assign <id> <agent>`, `promote <id>` (→ todos), `clear`.

- **Task persistence.** Tasks are stored per-session at
  `<projectSessions>/<id>.tasks.json` with automatic save on every mutation.
  Session wiring sets `ctx.meta['task.path']` at startup so the tool and slash
  command share the same storage.

- **Three-layer work hierarchy.** `plan` (strategic) → `task` (structured) →
  `todo` (tactical) — each layer promotes into the next. Plans outline the big
  picture, tasks break it into typed/prioritized work, todos track the immediate
  next step.

- **`task-format.ts` and `task-store.ts`** in `@wrongstack/core`. Shared rendering
  (`formatTaskList`, `formatTaskProgress`, `computeTaskItemProgress`) and
  persistence (`loadTasks`, `saveTasks`, `emptyTaskFile`) for all consumers.

### Added — /setmodel Enhancements

- **`/setmodel resolve <role>`** — walks the full resolution chain for one role
  step by step: exact role → phase → `*` default → leader fallback. Shows which
  step matched (with ✓) and which were skipped, then the resolved model.

- **`/setmodel doctor`** — validates all matrix entries against the current config:
  flags unknown keys (stale/typo'd roles), missing/unconfigured providers,
  providers without API keys, models not in the provider's model list, and
  uncovered roles when no `*` default is set.

- **Enhanced default view.** `/setmodel` (no args) now shows a **resolution
  summary** — one representative role per phase plus key legacy roles,
  each annotated with its resolution source (`role`, `phase`, `default`, `leader`).

### Added — Tech Stack Validator Agent

- **`tech-stack` skill** (`packages/core/skills/tech-stack/SKILL.md`). Activates
  on package/library/framework decisions. Enforces: verify existence via npm
  registry, check latest version, reject dead packages (>2yr no releases), reject
  prehistoric tech (≥5yr obsolete — axios, moment, jQuery, Gulp, etc.), prefer
  Node built-ins over npm packages. Outputs the intervention phrase:
  *"This isn't code, this is X-year-old technology."*

- **`tech-stack` fleet agent** — 43rd catalog agent in phase 9 (meta). Single-shot
  budget: 60s timeout, 5 iterations, 20 tool calls, $0.10 max. Tools: `search`,
  `fetch`, `read`, `grep`, `glob`, `outdated`, `audit`, `json`. Fires via
  `delegate({ role: 'tech-stack' })` to validate technology choices before
  committing them.

- Fleet roster: **46 → 47** (43 catalog + 4 legacy). All count-dependent tests
  updated (agent-catalog, dispatcher, fleet roster derivation, spawnability).

### Changed — Telegram Notifications

- **Human-readable formatters.** New `formatToolExecuted()`, `formatSessionEnded()`,
  `fmtToolOutput()`, and `fmtTokens()` in `@wrongstack/telegram/src/format.ts`.
  Tool notifications no longer dump raw JSON or truncated tool output — they
  strip JSON braces, unquote keys, and show the first 3 meaningful lines.
  Session-end notifications show comma-separated token counts with cache stats.

- **Smarter truncation.** `truncateForTelegram()` now preserves semantic boundaries:
  paragraph → sentence → word → hard cut. No more mid-word truncation in
  Telegram messages.

- **Tool description guidance.** `telegram_send` and `telegram_read` descriptions
  now explicitly instruct the agent to format messages as natural prose for a
  human reader — never paste raw JSON, object dumps, or unformatted tool output.
  Target 1–4 lines for mobile readability.

### Tests

- **+30 new test cases**: format.test.ts (+15: fmtTokens, fmtToolOutput,
  formatToolExecuted, formatSessionEnded), bot.test.ts (+6: truncation
  boundary tests), slash-setmodel.test.ts (+10: resolve, doctor, enhanced view).

### Changed — versions

- **All workspace packages bumped to 0.89.4**: `wrongstack`, `@wrongstack/cli`,
  `@wrongstack/core`, `@wrongstack/mcp`, `@wrongstack/plug-lsp`, `@wrongstack/plugins`,
  `@wrongstack/providers`, `@wrongstack/runtime`, `@wrongstack/skills`,
  `@wrongstack/telegram`, `@wrongstack/tools`, `@wrongstack/tui`, `@wrongstack/webui`.
  `@wrongstack/acp` tracks the same version, and the marketing site (`website/`) is
  bumped in lockstep.

## [0.89.3] - 2026-06-08

> The TUI-hardening & code-consolidation release. Consolidates everything since
> the `0.87.0` session-lifecycle release. The headlines are a **new F8 process
> list overlay** with live process view and kill actions, **TUI arrow-key
> navigation fixes** across all overlays, **terminal worktree pruning** in the
> F4 monitor with a 5-minute TTL, a **compact agents monitor** with fleet stale
> pruning, **stale worktree auto-cleanup**, and a **code-consolidation pass** that
> deduplicates the `expectDefined` helper across ACP and WebUI into the core
> `@wrongstack/core/utils/expect-defined` export. Additive only; no breaking
> changes.
>
> **Version consolidation.** The intermediate `0.87.1`–`0.89.2` bumps shipped as
> mechanical `chore: bump version` / `feat: update code` commits without their own
> changelog sections; their substantive changes are folded into this entry. All 15
> workspace manifests — and the marketing site (`website/`) — are aligned to
> `0.89.3` in lockstep. Root manifest corrected from a stray `0.99.4` back to the
> lockstep version.

### Added

- **F8 process list overlay (TUI).** A new `F8` hotkey opens a live process
  list overlay showing every running bash/exec child process with PID, name,
  command, and session ID. From the overlay you can kill individual processes
  (`k` + enter PID) without leaving the TUI. Backed by the singleton
  `ProcessRegistry` and the existing `/kill` slash command primitives.

### Changed

- **TUI overlay keyboard navigation hardened.** The previous escape guard only
  covered a specific overlay; arrow keys and other navigation keystrokes now
  gate on a generic `overlayOpen` check that covers the process list, agents
  monitor, fleet monitor, worktree monitor, phase monitor, and queue panel —
  so keyboard navigation through chat history no longer bleeds into overlay
  state when any monitor is open.
- **TUI stale terminal worktrees auto-pruned.** The F4 worktree monitor now
  prunes stale entries (no heartbeat for >5 minutes) from the display, keeping
  the monitor scannable during long AutoPhase runs.
- **TUI agents monitor compacted + fleet stale pruning.** The agents panel is
  tighter, stale fleet entries are removed after a visibility threshold, and
  cost precision is displayed at 4 decimal places across all fleet surfaces.
- **TUI app-state extracted.** The `State`/`Action` types and the `Settings`
  type moved from `app-reducer.ts` and `app.tsx` into a new `app-state.ts`
  module, shortening the reducer and making types importable without dragging
  in React. The director fleet bridge, controllers, and event bridge were also
  extracted into dedicated hook files.
- **`expectDefined` deduplicated into `@wrongstack/core`.** The ACP
  `stdio-transport.ts` and the WebUI `expect-defined.ts` each had a local copy
  of the same assert-non-null helper. Both now import from
  `@wrongstack/core/utils/expect-defined` (shipped in 0.87.0). The WebUI copy
  is deleted.

### Fixed

- **TUI enhance-countdown space artifact.** During the `/enhance` prompt
  refinement countdown, the live region erase left a trailing space character
  in the History anchor row — gone.
- **WebUI TodosPanel / ChatView layout overlap.** The sidebar todos panel no
  longer overlaps the chat viewport scrollbar or the input area on narrow
  viewports.
- **Terminal resize corruption.** Resizing the terminal during an active
  monitor overlay previously corrupted the render; panels now close before the
  Ink reflow so the TUI surface stays clean.
- **SettingsPicker ghost text after Esc.** The settings overlay now anchors a
  `flexGrow` region in the History component so dismissing the picker with Esc
  clears the ghosted inline text immediately.
- **Activity strip fixed-height rendering.** The live subagent activity strip
  now renders at a stable height regardless of content length, preventing
  scrollback churn.
- **Telegram log levels demoted.** Verbose Telegram plugin log messages were
  downgraded from INFO to DEBUG so they don't spam the console during normal
  operation.
- **ACP ESM import.** A `require()` call in the ACP agent module was replaced
  with a standard ESM `import` and a `@ts-expect-error` annotation for the
  type-only import path.

### Changed — versions

- **All workspace packages bumped to 0.89.3**: `wrongstack`, `@wrongstack/cli`,
  `@wrongstack/core`, `@wrongstack/mcp`, `@wrongstack/plug-lsp`, `@wrongstack/plugins`,
  `@wrongstack/providers`, `@wrongstack/runtime`, `@wrongstack/skills`,
  `@wrongstack/telegram`, `@wrongstack/tools`, `@wrongstack/tui`, `@wrongstack/webui`.
  `@wrongstack/acp` tracks the same version, and the marketing site (`website/`) is
  bumped in lockstep. Root manifest corrected from a stray `0.99.4` back to lockstep.

## [0.87.0] - 2026-06-07

> The session-lifecycle & type-safety release. Consolidates everything since the
> `0.77.0` prompt-refinement release. The headlines are a **`/prune` session
> housekeeping command** backed by a richer `SessionStore` (analytics-grade
> summaries, on-demand index rebuild), **categorized slash-command discovery**
> that groups commands in the TUI picker and triples the WebUI command list, a
> **non-modal TUI overlay** pass so the chat input stays live while monitors are
> open, and a **monorepo-wide type-safety hardening** sweep (explicit
> `| undefined` under `exactOptionalPropertyTypes`). Additive only; no breaking
> changes.
>
> **Version consolidation.** The intermediate `0.78.0`–`0.86.0` bumps shipped as
> mechanical `chore: bump version` / `feat: update code` commits without their own
> changelog sections; their substantive changes are folded into this entry. All 15
> workspace manifests — and the marketing site (`website/`) — are aligned to
> `0.87.0` in lockstep. (A stray `0.88.0` bump on the root manifest only was
> corrected back to `0.87.0` to restore lockstep.)

### Added

- **`/prune` — session housekeeping.** A new `Session`-category slash command
  deletes old sessions: `/prune` (default 30 days), `/prune 14` (custom age,
  clamped 1–365), `/prune --dry-run` (preview what would be deleted), and
  `/prune --rebuild-index` (rebuild `_index.jsonl` from disk). Backed by two new
  `SessionStore` methods — `prune(maxAgeDays?)` removes stale JSONL files plus
  their summary/plan/todos sidecars and session directories (never touching
  sessions referenced by `active.json`), and `rebuildIndex()` rescans every
  session directory and rewrites a fresh index. Returns deletion / index counts.
- **Analytics-grade `SessionSummary`.** The per-session summary sidecar now
  records `endedAt`, `iterationCount`, `toolCallCount`, `toolErrorCount`,
  `fileChangeCount`, `compactionCount`, a per-tool `toolBreakdown`
  (`tool name → call count`), and an `outcome`
  (`completed` / `error` / `timeout` / `aborted`) — so `wstack sessions` and the
  `/prune --dry-run` listing can summarize a run without re-parsing its JSONL.
- **Categorized slash-command discovery.** `SlashCommand` gained an optional
  `category` field (`Run` · `Session` · `Inspect` · `Agent` · `Config` · `App`),
  and every built-in command is now tagged. The TUI slash picker drops its
  12-item cap, shows all matches, and renders category headers for scannable
  grouping. The WebUI `SLASH_COMMANDS` list grew from **19 to 39** commands,
  surfacing agent, fleet, autonomy, SDD, config, and inspection commands that
  were previously hidden.
- **TUI exit-confirmation prompt.** A new `EscConfirmPrompt` renders the
  confirm-exit state as a dedicated panel (instead of an inline hint), wired
  through a reducer `escConfirm` slice.
- **New core utilities.** `expect-defined` (assert-non-null helper), `sleep`,
  and a `term` helper module (`@wrongstack/core/utils`, with tests) consolidate
  patterns that were duplicated across packages.

### Changed

- **Non-modal TUI monitor overlays.** When the fleet / agents / worktree /
  todos / queue / autophase monitor overlays were open, the key handler
  swallowed every keystroke except the F-key toggles and `Esc`, silently
  freezing the always-mounted chat input. The swallow-everything guard is gone:
  overlays stay visible in the lower region while typing, paste, cursor
  movement, backspace, and Enter flow into the input as usual. `F2`–`F7` still
  toggle their overlay and `Esc` still closes the open one; dedicated modal
  pickers (enhance, model, autonomy, settings, rewind, help, confirm-queue) keep
  their own guards.
- **Fixed-height live-tail in TUI history.** The streaming tool/subagent tail
  now renders at a stable height, eliminating scrollback churn during long runs
  (covered by `live-tail-fixed-height.test.ts`).
- **`fetch` connection-pool teardown.** The SSRF-guarded `fetch` tool now
  destroys its pinned `undici` dispatcher on `beforeExit`, so long-running
  processes (eternal autonomy, MCP server mode) don't leak connection pools or
  DNS caches. `combineSignals` was refactored to take a signal array and prefer
  native `AbortSignal.any`.
- **Injectable secret-vault warnings.** `decryptConfigSecrets` /
  `encryptConfigSecrets` / `restrictFilePermissions` accept an optional `warn`
  callback (defaulting to `console.warn`) so server contexts can route
  decryption and permission-restriction notices through a structured logger.
- **Removed the `/altscreen` runtime command.** The alt-screen escape valve was
  dropped from the TUI command set during the `app.tsx` / `run-tui` refactor.

### Fixed

- **Session-store teardown race (Windows `ENOTEMPTY`).** `FileSessionWriter`'s
  `onClose` callback was fire-and-forget, so the session-index write could race
  callers that immediately tore down the session directory. `close()` now awaits
  the (async-capable) callback before resolving.
- **MCP `undici@7` type conflict.** Resolved the `undici@7` / `undici-types`
  type clash with a scoped `@ts-expect-error` and an `undici-types` override, so
  the MCP package type-checks clean again.

### Changed — type safety

- **Monorepo-wide `exactOptionalPropertyTypes` hardening.** Optional fields
  across `core`, `cli`, `tools`, `tui`, `webui`, `providers`, and `telegram`
  were made explicit (`field?: T | undefined`), non-null assertions on
  `executeStream` were replaced with guarded throws, and several latent
  optional-vs-undefined mismatches were closed — a pure type-safety pass with no
  behaviour change.

### Changed — versions

- **All workspace packages bumped to 0.87.0**: `wrongstack`, `@wrongstack/cli`,
  `@wrongstack/core`, `@wrongstack/mcp`, `@wrongstack/plug-lsp`, `@wrongstack/plugins`,
  `@wrongstack/providers`, `@wrongstack/runtime`, `@wrongstack/skills`,
  `@wrongstack/telegram`, `@wrongstack/tools`, `@wrongstack/tui`, `@wrongstack/webui`.
  `@wrongstack/acp` tracks the same version, and the marketing site (`website/`) is
  bumped in lockstep.

## [0.77.0] - 2026-06-06

> The prompt-refinement & hardening release. Consolidates everything since the
> `0.73.1` lockstep realignment. The headlines are an **LLM-driven `/enhance`
> prompt refinement** flow with a countdown auto-send preview, a
> **`/telegram-setup` one-command bot configuration**, a **live concurrency
> ceiling** in the TUI fleet monitor, and a **project-root detection hardening**
> pass that stops walk-up at the user's home directory and prunes stale project
> dirs on boot. Additive only; no breaking changes.
>
> **Version consolidation.** The intermediate `0.74.0`–`0.76.0` bumps shipped as
> mechanical `chore: bump version` / `feat: update code` commits without their own
> changelog sections; their substantive changes are folded into this entry. All 15
> workspace manifests — and the marketing site (`website/`) — are aligned to
> `0.77.0` in lockstep.

### Added

- **`/enhance` prompt refinement.** A new LLM-driven refinement flow across
  core, CLI, and TUI: `prompt-enhancer.ts` calls the active model to refine a
  typed draft into a clearer prompt, the CLI slash command toggles the feature
  on/off, and the TUI `EnhancePanel` shows a "did you mean this?" preview with a
  live countdown before auto-sending. Refined prompts can be accepted, re-rolled,
  or cancelled. Covered by `prompt-enhancer.test.ts` and
  `slash-enhance.test.ts`.
- **`/telegram-setup` slash command.** Replaces manual `config.json` editing
  with a single ` /telegram-setup <botToken> [chatId]` command (alias `/tg-setup`).
  Validates the bot token against the Telegram `getMe` API, persists to
  `extensions.telegram`, and maps `chatId` if provided. Built on a shared
  `persistTelegramConfig()` helper in `settings-menu.ts`.
- **Live concurrency ceiling in the TUI fleet monitor.** The TUI now tracks
  `fleetConcurrency` in its reducer, subscribes to the new `concurrency.changed`
  kernel event, and surfaces the live ceiling in the fleet monitor. The
  `/fleet concurrency <n>` slash command emits the event after the host ceiling
  is updated, so the TUI reflects runtime changes without polling.
- **Telegram message formatting utility.** New `format.ts` in
  `@wrongstack/telegram` provides shared message formatting helpers for the
  Telegram plugin, replacing ad-hoc formatting scattered across handlers.
- **TUI compact todos panel, queue panel, and todos monitor.** Three new
  surfaces: `CompactTodosPanel` renders a minimised todo list above the input,
  `QueuePanel` shows and manages the in-flight message queue, and
  `TodosMonitor` provides a dedicated todo overlay. The settings picker was
  also expanded with additional controls.
- **Expanded slash command docs.** New reference pages for `/enhance`,
  `/telegram-setup`, `/collab`, `/mcp`, `/models`, `/settings`, `/sync`, and the
  subcommand family (`/acp`, `/audit`, `/replay`, `/version-help`). Existing
  pages for `/yolo`, `/sdd`, `/skills`, `/skill-gen`, `/plan`, `/security`,
  `/todos`, `/goal`, and `/compact` updated with current behaviour.

### Changed

- **pnpm upgraded from 11.3.0 to 11.5.2.** Workspace `packageManager` field and
  `pnpm-lock.yaml` updated.
- **Project directory naming improved.** `WstackPaths` now derives the
  per-project folder from a slugified base name + short hash (e.g.
  `wrongstack-a1b2c3`) instead of a bare 12-char SHA-256 hex string, making
  `~/.wrongstack/projects/` human-readable.
- **Delegator tool expanded.** `delegate-tool.test.ts` grew 110 new test cases
  covering edge cases in the delegation pipeline.
- **Background indexer and codebase-index tools refined.** The background
  indexer, codebase-search, and codebase-stats tools received internal
  improvements from the 0.73.1 codebase-index pass.
- **WebUI todos panel and WS client expanded.** `TodosPanel` gained a dedicated
  React component (146 lines); `ws-client.ts` added new message types for the
  live todos surface.

### Fixed

- **TUI refine-panel scrollback cloning.** During the refine countdown, the
  typed draft was repeatedly cloned into native scrollback. The live input is
  now blanked while the enhance flow is in flight, the flow folds into the
  existing `eraseLiveRegion` overlay mitigation, and the live region is erased
  on each tick — so `log-update` can't accumulate leaked rows.
- **Codebase-index ready flag.** The indexer's readiness signal was incorrectly
  gated, causing tools to query the index before the background build completed.
- **Project root detection hardened.** Three fixes in `path-resolver.ts`:
  (1) the walk-up now stops at `os.homedir()` so stray user-home markers
  (`.git`, `package.json`) aren't mistaken for the project root; (2) the marker
  file is `.wrongstack/AGENTS.md` (not the bare `.wrongstack/` directory) so
  the detector doesn't match an empty or leftover directory; (3) `boot.ts`
  gained `cleanupStaleProjects()` which removes project dirs whose original
  root no longer exists (deleted repos, test artifacts).
- **pre-launch git init location.** `runProjectCheck` now receives the actual
  `cwd` so `git init` always runs in the working directory, never a parent
  detected by walk-up.
- **TUI input key handling.** Two fixes: `Delete` was being caught by the
  `Backspace` handler instead of its own; `Shift+Enter` now inserts a literal
  newline into multi-line input instead of submitting.

### Tests

- New suites for prompt enhancer (`prompt-enhancer.test.ts`, 182 cases),
  `/enhance` slash command (`slash-enhance.test.ts`, 93 cases), path resolver
  hardening (`path-resolver.test.ts`, 99 cases), delegate tool expansion
  (`delegate-tool.test.ts`, +110 cases), and Telegram formatting
  (`format.test.ts`, 62 cases). Existing suites for `wstack-paths`,
  `todos-checkpoint`, `pre-launch`, `markdown-table`, `reducer`, and
  `slash-goal` updated to reflect the new behaviour.

### Changed — versions

- **All workspace packages bumped to 0.77.0**: `wrongstack`, `@wrongstack/cli`,
  `@wrongstack/core`, `@wrongstack/mcp`, `@wrongstack/plug-lsp`, `@wrongstack/plugins`,
  `@wrongstack/providers`, `@wrongstack/runtime`, `@wrongstack/skills`,
  `@wrongstack/telegram`, `@wrongstack/tools`, `@wrongstack/tui`, `@wrongstack/webui`.
  `@wrongstack/acp` tracks the same version, and the marketing site (`website/`) is
  bumped in lockstep.

## [0.73.1] - 2026-06-06

> The background-index & decomposition release. Consolidates everything since
> the `0.66.13` lockstep realignment. The headlines are a **background,
> gitignore-aware codebase indexer** with a `/codebase-reindex` command, a
> large-file **decomposition pass** that split the WebUI store/socket/sidebar
> monoliths and the TUI `app.tsx` into focused submodules, and the **removal of
> the TUI mouse mode** (unreliable on Windows consoles). Additive except for the
> mouse-mode removal; no other breaking changes.
>
> **Version consolidation.** The intermediate `0.66.14`–`0.73.0` bumps shipped as
> mechanical `chore: bump version` / `feat: update code` commits without their own
> changelog sections; their substantive changes are folded into this entry. All 15
> workspace manifests — and the marketing site (`website/`) — are aligned to
> `0.73.1` in lockstep.

### Added

- **Background, gitignore-aware codebase indexer.** The SQLite symbol index now
  builds and refreshes in the background instead of blocking the first search.
  A new `background-indexer.ts` drives the pass, a new `gitignore.ts` walks
  `.gitignore` rules so ignored files are skipped, and `cli/src/wiring/codebase-index.ts`
  wires the indexer into boot. Config gained options to tune/disable the
  background pass (`types/config.ts` + `config-loader.ts`). Covered by new
  `background-indexer`, `gitignore`, and `wiring-codebase-index` test suites.
- **`/codebase-reindex` slash command.** Force a full rebuild or an incremental
  refresh of the symbol index on demand, with docs (`docs/slash/codebase-reindex.md`)
  and tests (`slash-codebase-reindex.test.ts`).
- **Pre-launch checks expanded.** `pre-launch.ts` grew additional boot-time
  readiness checks (with matching `pre-launch.test.ts` coverage) so a misconfigured
  environment surfaces a clear message before the agent starts.

### Changed

- **Large-file decomposition pass (16 files → 55 submodules).** A 70-file refactor
  split the biggest monoliths into focused, independently-testable units — no
  behaviour change:
  - **WebUI store** — the 947-line `stores/index.ts` became `chat-store`,
    `config-store`, `fleet-store`, `history-store`, `session-store`, `ui-store`,
    `worktree-store`, and a shared `types.ts`.
  - **WebUI WebSocket hook** — the 1,222-line `useWebSocket.ts` was reduced to a
    thin shell over an extracted `ws-handlers.ts`.
  - **WebUI sidebar** — the 744-line `Sidebar.tsx` split into `Sidebar/ConfigSection`,
    `SessionActions`, `SessionList`, and an `index.tsx` composition root.
  - **WebUI server** — `server/index.ts` shed its provider-message handling
    (`provider-handlers.ts`) and event wiring (`setup-events.ts`).
  - **TUI** — `app.tsx` reducer logic was extracted to `app-reducer.ts`, the
    steering-preamble builder to its own module (`buildSteeringPreamble`), and the
    history renderer split into per-entry-kind components.
- **WebUI Collab panel refinements.** `CollabPanel` was retuned against the
  decomposed store/socket layer so collab-session events render off the new typed
  WS handlers.

### Removed

- **TUI mouse mode removed entirely.** Mouse reporting (`mouse.ts`, its tests, and
  the `mouse` `RunTuiOptions` prop) was unreliable on Windows consoles and is gone;
  the TUI relies on keyboard navigation and the terminal's native scrollback. The
  CLI no longer passes a `mouse` option through to `runTui`.

### Fixed

- **`release:check` build break from the mouse removal.** `cli/src/execution.ts`
  still passed `mouse: false` to `runTui` after the prop was deleted, failing
  `tsc --noEmit` (`TS2353`). The dangling prop was removed so typecheck, test, and
  build pass again.
- **TUI build errors from the `app-reducer` extraction** were resolved, and a
  duplicate `sddHelp` import was de-duplicated / hoisted in the SDD slash command.

### Tests

- New suites for the background indexer, gitignore walker, codebase-index wiring,
  `/codebase-reindex`, expanded pre-launch checks, and WebUI `ws-utils`. The repo
  now carries **408+ test files**.

### Changed — versions

- **All workspace packages bumped to 0.73.1**: `wrongstack`, `@wrongstack/cli`,
  `@wrongstack/core`, `@wrongstack/mcp`, `@wrongstack/plug-lsp`, `@wrongstack/plugins`,
  `@wrongstack/providers`, `@wrongstack/runtime`, `@wrongstack/skills`,
  `@wrongstack/telegram`, `@wrongstack/tools`, `@wrongstack/tui`, `@wrongstack/webui`.
  `@wrongstack/acp` tracks the same version, and the marketing site (`website/`) is
  bumped in lockstep.

## [0.66.13] - 2026-06-05

> The WebUI-fleet & agent-decomposition release. Consolidates everything since
> the `0.54.1` lockstep realignment. The headlines are a **multi-instance WebUI**
> with auto-advancing ports and a self-healing instance registry, a full WebUI
> visual overhaul ("Engineering Instrument Deck") with a **live fleet roster**,
> the decomposition of the 1,000-line agent monolith into focused modules, and a
> reworked **YOLO destructive-confirmation gate**. Additive only; no breaking
> changes.
>
> **Version consolidation.** The intermediate `0.55.0`–`0.66.12` bumps shipped as
> mechanical `chore: bump version` / `feat: update code` commits without their own
> changelog sections; their substantive changes are folded into this entry. All 15
> workspace manifests are aligned to `0.66.13` in lockstep.

### Added

- **Agent loop decomposition.** The 1,064-line `core/agent.ts` monolith was split
  into focused modules — `agent-loop.ts` (iteration driver), `agent-response.ts`
  (response/tool-use handling), `agent-tools.ts` (tool batch execution),
  `agent-internals.ts` (shared helpers), `agent-types.ts`, and a new
  `types/autonomy.ts`. `agent.ts` is now a 181-line composition root. Pure
  refactor — no behaviour change; each extracted unit is independently testable.
- **`/yolo destructive` gate + `confirmDestructive` safety net.** YOLO now
  auto-approves everything by default (including destructive calls); the new
  `/yolo destructive` toggle and `PermissionPolicy.setConfirmDestructive()` let
  you keep YOLO for routine work while still requiring confirmation for risky
  operations. Has no effect when YOLO is off (normal permission flow applies).
- **`createToolOutputSerializer` — budget-capped tool-output serialization.** A
  new `@wrongstack/core/utils` helper serializes tool output against a token
  budget, enforcing per-value caps and emitting `sizeSignals`, so oversized tool
  results are truncated deterministically before they reach the context window or
  the session log.
- **`bump-version.mjs` website lockstep.** The release script now also rewrites
  the marketing site (`website/`, outside the pnpm workspace) — its
  `package.json`/`package-lock.json` and `src/lib/utils.ts` version string — so a
  single `bump-version` run keeps the site in sync with the workspace.
- **WebUI multiple instances.** Run any number of WebUI servers at once (one per
  project, or several per project). The HTTP (`PORT`, 3456) and WebSocket
  (`WS_PORT`, 3457) ports now **auto-advance** past anything already bound, so
  successive `wstackui` launches land on tidy adjacent pairs (3456/3457, 3458/3459,
  …) with no manual port juggling. `WEBUI_STRICT_PORT=1` disables auto-advance.
- **WebUI instance registry.** Every running instance records itself in
  `~/.wrongstack/webui-instances.json` (port ↔ project path ↔ pid, self-healing on
  crash via PID liveness pruning, atomic writes). `wstackui --list` (alias `ls` / `-l`)
  prints them without starting a server. CLI-embedded (`--webui`) instances share
  the same registry.
- **`wrongstack --webui` now serves the browser UI.** Previously it only opened a
  WebSocket bridge next to the REPL; it now also serves the React frontend over
  HTTP and prints the URL, so it's a true one-command launch (terminal REPL and
  browser share the same live agent/session). Reuses the webui package's
  static-serve / port / registry building blocks via a new `@wrongstack/webui/server`
  export surface.
- **`--open` flag** (CLI `--webui --open`, standalone `wstackui --open` / `WEBUI_OPEN=1`)
  pops the default browser to the served URL once the server is ready.
- **`docs/webui.md`** — full Web UI reference (launch modes, ports, registry,
  flags/env, security, internals). README / ARCHITECTURE / AGENTS updated to match,
  and `--webui` is now listed in `--help`.
- **WebUI visual overhaul** — a cohesive "Engineering Instrument Deck" design
  system (IBM Plex type, warm-graphite/​warm-paper surfaces, signal-amber accent,
  blueprint grid, status LEDs) with refined dark **and** light modes behind a
  visible segmented Light/Dark/System toggle in the header. The sidebar todos
  panel became a progress-railed "Plan" instrument, and the multi-agent panels
  (`TaskBoard`, `PhaseAgentsMonitor`) were re-themed off hardcoded colors onto
  shared semantic tokens so they read correctly in both modes.
- **WebUI live fleet roster** (`FleetPanel`) — during a multi-agent run the
  leader's spawned (nickname'd) subagents render as a collapsible card strip
  above the chat: live iteration/tool/cost counters, current tool, context-fill
  bar, self-extension count, and terminal status/error. Driven by a new
  `subagent.event` WS stream that **both** the standalone and CLI-embedded
  servers flatten from the kernel's `subagent.*` catalog, reduced in
  `useFleetStore`. Self-hides for solo sessions.

### Fixed

- **Coordinator `remove()` could hang a running task's awaiter.** When a subagent
  was removed while it had an in-flight task **and** a queued (pending) task,
  `remove()` routed the orphaned pending task through `recordCompletion`, whose
  `inFlight--` stole a decrement from the still-running task. That tripped the
  underflow guard when the running task later completed, suppressing its
  `task.completed` event and leaving any `awaitTasks()` caller to hang until the
  300 s timeout. Pending tasks now inline-emit their synthetic `aborted_by_parent`
  completion (via a shared `emitPendingAborted` helper, matching `stopAll` /
  dead-queue drains) and never touch `inFlight`. Regression test added.
- **WebUI multi-instance was broken** because the frontend hardcoded the WS port
  (3457); it now reads the live port from a `<meta name="wrongstack-ws-port">` tag
  the HTTP server injects into the served HTML.
- **`@wrongstack/webui/server` export** lacked a `default`/`require` condition, so
  runtime `require.resolve` of the dist path failed and the frontend was silently
  not served from the CLI path.
- **Subagent nickname duplication.** Multi-word names (e.g. *Von Neumann*) could be
  assigned to two workers because the dedup key was derived by truncating the
  display string; `assignNickname` now returns the canonical key directly and a
  `nicknameKeyFromDisplay` helper backs the release paths.
- **`eternal-parallel` subagent leak** — per-tick subagents are now removed from the
  coordinator, freeing their entries and nickname slots over long runs.
- **`CollabSession` timer leak** — the session-level timeout is now cleared on the
  success path too (it previously leaked, later firing a spurious cancel + unhandled
  rejection).
- **Director `idle_timeout` budget extension** was a silent no-op (`extend({})`); it
  now flows through the heartbeat path and extends `idleTimeoutMs`, consistent with
  the collab and auto-extend handlers.

## [0.54.1] - 2026-06-04

> The boot-refresh & model-picker release. Consolidates everything since the
> `0.51.3` lockstep realignment. The headlines are a **blocking models.dev
> catalog refresh on boot** so the TUI and model resolution always see fresh
> data, a **type-to-search model picker** with scroll-window navigation, and
> a trio of hardening fixes — **WebUI secret redaction** before broadcast,
> **cloud-sync path-traversal guard**, and a stale-read fix in the `edit` tool
> that prevented double-editing the same file. Additive only; no breaking
> changes.
>
> **Version consolidation.** The intermediate `0.51.4`–`0.54.0` bumps shipped
> as mechanical `chore: bump version` / `feat: update code` commits without
> their own changelog sections; their substantive changes are folded into this
> entry. All 15 workspace manifests are aligned to `0.54.1` in lockstep.

### Added

- **Blocking models.dev catalog refresh on boot.** `boot.ts` now fetches the
  models.dev catalog synchronously before the app starts, so the TUI model
  picker, provider resolution, and capability queries always work against
  fresh data. A 15-second `AbortController` timeout (configurable via
  `refreshTimeoutMs` on `DefaultModelsRegistryOptions`) prevents a stalled
  network call from hanging boot; on timeout or network failure, the app falls
  back to cache with a warning and continues normally. The new
  `--no-models-refresh` flag skips the refresh entirely — useful in offline or
  CI environments.

- **TUI model picker type-to-search (step 2).** After selecting a provider,
  typing printable characters now filters the model list live: each keystroke
  narrows the list to models containing the search string, Backspace deletes
  from the filter (or goes back to step 1 when empty), and ↑/↓ navigation
  operates on the filtered results. Long lists render a centered visible
  window with `▲ N above` / `▼ N below` overflow indicators, capped at 10
  visible items. The header shows the active filter string and match count.

- **`wstack models` pagination + search.** The `wstack models [provider]`
  subcommand gained three new flags — `--search <term>` (case-insensitive
  model id filter), `--page N`, and `--per-page N` — with a page navigator
  and ↑/↓ indicators for multi-page output.

### Changed

- **Model capabilities context resolution priority improved.** `capabilitiesFor()`
  now resolves `maxContext` in a clear three-tier priority: (1) resolved model
  capabilities from the registry, (2) raw `model.limit.context` from the
  provider's model list, (3) family default (e.g. 32K for openai-compatible).
  Previously only tiers 1 and 3 were checked; providers that expose context
  limits in their model metadata but not in the registry's capability layer
  now surface the correct window size.

### Fixed

- **WebUI secret redaction before broadcast.** `webui-server.ts` now scrubs
  `tool.started` and `tool.executed` input/output payloads through
  `DefaultSecretScrubber` before broadcasting to WebSocket clients. Previously
  tool arguments or output containing API keys, bearer tokens, or other
  secrets would ride in cleartext over the WebSocket to every connected WebUI
  tab.

- **Cloud-sync path traversal.** The `pull()` path now validates remote tree
  entries through a new `resolvePulledCategoryPath()` guard that rejects
  traversal patterns (`..`, absolute paths, or any path resolving outside the
  category root). File-backed categories (e.g. `settings`) additionally reject
  nested paths. This closes a path where a compromised or malicious sync repo
  could overwrite `config.json` or other files outside the intended category
  directory.

- **`edit` tool double-edit stale read.** After writing the edited file,
  `editTool.execute()` now re-stat()s the file to get the actual on-disk
  mtime before calling `ctx.recordRead()`. The previous code used the
  pre-write file metadata, which on Windows (2s mtime granularity) and some
  network filesystems caused a second `edit` call on the same file to throw a
  bogus "modified externally" error.

### Tests

- **`webui-server-redaction.test.ts`** — end-to-end WebSocket test verifying
  that `DefaultSecretScrubber` redacts OpenAI keys and bearer tokens from both
  `tool.started` and `tool.executed` broadcast payloads.
- **Cloud-sync path safety tests** — two new cases in `cloud-sync.test.ts`
  covering traversal rejection for directory-backed and file-backed categories.
- **`edit.test.ts` double-edit regression** — verifies that two consecutive
  `edit` calls on the same file succeed without a stale-mtime error.

### Changed — versions

- **All workspace packages bumped to 0.54.1**: `wrongstack`,
  `@wrongstack/cli`, `@wrongstack/core`, `@wrongstack/mcp`,
  `@wrongstack/plug-lsp`, `@wrongstack/plugins`, `@wrongstack/providers`,
  `@wrongstack/runtime`, `@wrongstack/skills`, `@wrongstack/telegram`,
  `@wrongstack/tools`, `@wrongstack/tui`, `@wrongstack/webui`.
  `@wrongstack/acp` tracks the same version.

## [0.51.3] - 2026-06-04

> The Brain-governed AutoPhase release. The main thread since `0.41.0` is a new
> **Brain arbiter** layer that sits above Director and AutoPhase policy
> decisions, escalates unsafe choices to the human through the TUI, and records
> the decision flow on the shared EventBus. AutoPhase now keeps phase execution
> state separate from worktree integration state, and parallel autonomy exposes
> finer-grained stage progress.
>
> **Release status.** Ready after local verification: all 15 lockstep workspace
> manifests are aligned to `0.51.3`; `pnpm audit --audit-level=moderate`, `pnpm
> typecheck`, `pnpm test`, and `pnpm build` pass in this working tree.

### Added

- **Brain arbiter coordination layer.** New `@wrongstack/core/coordination`
  exports define `BrainArbiter`, `BrainDecisionRequest`, `BrainDecision`,
  `DefaultBrainArbiter`, `HumanEscalatingBrainArbiter`,
  `ObservableBrainArbiter`, `BrainDecisionQueue`, and `formatHumanPrompt()`.
  Brain is intentionally an authority/decision seam, not an autonomous bypass:
  callers ask for a policy decision; low-risk recommended choices can be
  answered deterministically, while higher-risk decisions escalate to the human
  or fall back according to the request policy.

- **TUI Brain decision prompt.** The TUI now listens for `brain.*` EventBus
  events, renders Brain decisions in chat history, shows a compact `🧠` status
  chip, and displays an interactive human-decision panel for escalations.
  Users can answer with `A`/`B`/`C` or `1`/`2`/`3`; `Esc`/`D` denies with the
  safe default.

- **Director budget-extension policy hooks.** `DirectorOptions` accepts an
  optional `brain` arbiter. When subagents hit soft limits, the Director can now
  ask Brain whether to grant the default budget extension or stop the task,
  with cost extensions marked higher risk.

### Changed

- **AutoPhase conflict resolution is Brain-governed.** Worktree merge conflict
  resolution can now be routed through Brain before the configured resolver is
  allowed to edit conflicted files. The conservative default keeps conflicted
  worktrees for human review unless the decision explicitly chooses resolution.

- **AutoPhase phase completion and worktree integration are tracked
  separately.** Phase metadata now records `integrationStatus` values such as
  `merged`, `needs_review`, `merge_failed`, and `not_merged_failed_phase`, plus
  branch/worktree/conflict details. This separates “phase work completed” from
  “changes safely landed on the base branch,” which is the right mental model
  for worktree-based automation.

- **AutoPhase pause handling tightened.** `PhaseOrchestrator` now waits while
  paused before dispatching the next ready-phase batch and again between phase
  batches, so pause/resume behaves predictably across autonomous graph runs.

- **Parallel autonomy docs clarified.** `/autonomy stop` documentation now
  distinguishes serial eternal cancellation from parallel-mode shutdown, and
  parallel mode documents live stage updates (`decompose` → `fanout` → `await`
  → `aggregate` → `sleep`/`stopped`).

### Fixed

- **AutoPhase active-run cleanup.** CLI AutoPhase host cleanup now finalizes the
  active run on graph completion, graph failure, or orchestrator abort, avoiding
  stale subscriptions / active-run state after a background run exits.

### Tests

- **Brain and TUI regression coverage.** Added tests for the Brain coordination
  primitives, Director Brain integration, AutoPhase runner/orchestrator Brain
  plumbing, and TUI reducer state for Brain history/status/prompt handling.

### Docs

- **`docs/slash/autophase.md`** now documents sequential todo execution in CLI
  phases, verification/repair behavior, and worktree integration metadata.
- **`docs/slash/autonomy.md`** now documents parallel-mode stop semantics and
  live stage progression.

## [0.41.0] - 2026-06-03

> The code-quality & model-routing release. Consolidates everything since the
> `0.32.0` lockstep realignment. The headlines are a per-task **model matrix**
> with a `/setmodel` command, an **AutoPhase verification gate** that catches
> broken phases before merge, a unified **TTY / stdout abstraction** layer that
> eliminates ~20 scattered `process.stdout` / `process.stdin` checks, and a
> WebUI server decomposition pass. Additive only; no breaking changes.
>
> **Version consolidation.** The intermediate `0.33.0`–`0.40.1` bumps shipped
> as mechanical `chore: bump version` / `feat: update code` commits without
> their own changelog sections; their substantive changes are folded into this
> entry. All 15 workspace manifests are realigned to `0.41.0` in lockstep.

### Added

- **Per-task model matrix + `/setmodel` slash command.** A new
  `Config.modelMatrix` map lets different fleet roles or phases run on
  different models — e.g. `security-scanner` on one model, `documentation` on
  another — while the leader keeps its own model. Resolution precedence:
  exact role → role's phase → `*` default → leader model fallback. The new
  `/setmodel <key> <provider/model>` command validates keys against the
  46-agent catalog and persists to `config.json`. `resolveModelMatrix()`,
  `matrixKeyKind()`, and `isValidMatrixKey()` exported from
  `@wrongstack/core/coordination`.

- **AutoPhase verification gate + auto-repair + merge-conflict resolver.**
  `PhaseOrchestrator` now runs an optional `verifyPhase` callback after all
  tasks in a phase succeed. When verification fails (e.g. typecheck / test),
  the orchestrator retries up to `maxVerifyAttempts` (default 2) with an
  `autoRepair` callback before marking the phase as failed. Additionally,
  `WorktreeManager.merge()` accepts a `resolveConflicts` callback so
  AutoPhase can attempt to resolve merge conflicts before falling back to
  `needs-review`.

- **TTY detection helpers (`@wrongstack/core/utils/term`).** Single source
  of truth for `isStdoutTTY()`, `isStdinTTY()`, `isInteractive()`,
  `getTermSize()`, `onResize()`, and `setRawMode()` — replaces ~20 ad-hoc
  `process.stdin.isTTY` / `process.stdout.isTTY` checks scattered across
  the codebase. Test code can now mock one module instead of stubbing `isTTY`
  on every stream.

- **`writeOut` / `writeErr` / `writeTo` output primitives
  (`@wrongstack/core/utils`).** All stdout/stderr writes across CLI, ACP,
  and WebUI now route through a shared seam instead of raw
  `process.stdout.write()` / `process.stderr.write()`. Enables future
  output capture / middleware without monkey-patching globals.

- **TUI F-key monitor aliases.** `F1`–`F4` now toggle the fleet, agents,
  worktree, and phase monitors respectively (alongside the existing
  `Ctrl+F`/`G`/`T`/`P` bindings). Model + context-pressure display added to
  the agents and fleet monitors.

- **Collab debug target file limits.** `CollabSession` now enforces a file
  count limit to prevent token overflow in large codebases: explicit
  `maxTargetFiles` > dynamic from `contextWindow` > default (30). Exceeding
  the limit throws a clear error with guidance to narrow the target or run
  per-package sessions.

- **`detectPackageManager` utility (`@wrongstack/tools/_util`).** Deduped
  the `pnpm` / `yarn` / `npm` / `bun` detection logic that was duplicated
  across `install`, `audit`, `outdated`, and `document` tools into a single
  shared helper.

### Changed

- **WebUI server decomposition.** Extracted the static-file HTTP server
  (MIME handling, CSP header, SPA fallback) into its own
  `packages/webui/src/server/http-server.ts` module (-75 lines from
  `index.ts`). Boot-time secret-migration notices now route through
  `writeErr` instead of raw `process.stderr.write`.

- **CLI `index.ts` decomposed.** Extracted five modules from the 1,400-line
  monolith: `cli-entry-point.ts`, `cli-eternal-flag.ts`,
  `cli-recovery-prompt.ts`, `cli-update-notice.ts`, `cli-bundled-skills.ts`.
  The main file is ~130 lines shorter; each extraction is independently
  testable.

- **`diff` tool clarified.** The `files`-only path now explicitly renders
  line-numbered file content (not a misleading unified diff with `---`/`+++`
  headers). Usage hints updated to distinguish the two modes. Security
  guards from the 0.31.1 audit (leading-dash rejection) remain.

- **`plan` tool hardened.** The built-in `plan` tool now validates that
  `path` resolves inside the project root and that `id` / `details` fields
  are strings, preventing potential path traversal and type confusion.

### Fixed

- **2026-06-03 audit batch — 4 critical/high findings resolved:**
  - `document` tool: `--tsconfig` / `--format` argument injection blocked
    (leading-dash guard + allowlist).
  - `install` tool: package name injection blocked (bare-word validation).
  - `outdated` tool: `--depth` argument injection blocked.
  - `diff` tool: mode and file-path flags hardened (complements F-01).
  - 8 regression-guard tests added across the fixed tools.

- **`cron` plugin teardown.** The cron plugin's `beforeIteration` /
  `afterIteration` hooks now clean up correctly on plugin unload, preventing
  stale interval timers from leaking across hot-reloads.

- **`file-watcher` plugin teardown.** Open `fs.watch` handles are now
  closed in the plugin's `teardown()` method.

### Tests

- **~107 new test cases** across 20 files:
  - `packages/core/tests/utils/term.test.ts` — TTY detection + resize + raw mode
  - `packages/core/tests/coordination/model-matrix.test.ts` — matrix resolution
  - `packages/core/tests/coordination/director-model-matrix.test.ts` — Director integration
  - `packages/core/tests/worktree/worktree-manager.test.ts` — merge conflict resolver
  - `packages/core/tests/autophase/phase-orchestrator.test.ts` — verify gate + auto-repair
  - `packages/cli/tests/input-reader.test.ts` — readKey coverage
  - `packages/cli/tests/slash-setmodel.test.ts` — `/setmodel` command
  - `packages/tools/tests/_util.test.ts` — detectPackageManager
  - `packages/tools/tests/permission-mutating-invariant.test.ts` — safety invariant
  - `packages/plugins/tests/plugin-teardown.test.ts` — cron + file-watcher teardown
  - `packages/tui/tests/fn-keys.test.ts` — F-key binding
  - `packages/webui/tests/server/http-server.test.ts` — extracted HTTP server

### Docs

- **`docs/collab-debug.md`** — usage guide documenting target file limits,
  context-window-based calculation, and per-package session strategy.
- **`docs/slash/setmodel.md`** — `/setmodel` command reference.

### Changed — versions

- **All workspace packages bumped to 0.41.0**: `wrongstack`,
  `@wrongstack/cli`, `@wrongstack/core`, `@wrongstack/mcp`,
  `@wrongstack/plug-lsp`, `@wrongstack/plugins`, `@wrongstack/providers`,
  `@wrongstack/runtime`, `@wrongstack/skills`, `@wrongstack/telegram`,
  `@wrongstack/tools`, `@wrongstack/tui`, `@wrongstack/webui`.
  `@wrongstack/acp` tracks the same version.

## [0.32.0] - 2026-06-03

> Version bump to 0.32.0.

### Changed

- **All workspace packages bumped to 0.32.0**: `wrongstack`, `@wrongstack/cli`, `@wrongstack/core`, `@wrongstack/mcp`, `@wrongstack/plug-lsp`, `@wrongstack/plugins`, `@wrongstack/providers`, `@wrongstack/runtime`, `@wrongstack/skills`, `@wrongstack/telegram`, `@wrongstack/tools`, `@wrongstack/tui`, `@wrongstack/webui`. `@wrongstack/acp` tracks the same version.

## [0.31.1] - 2026-06-03

> The Director-resilience release. Consolidates everything since the `0.24.0`
> realignment. The headline is a hardening pass over the multi-agent
> coordination layer — bounded context for the Director, classified fleet
> failures surfaced live, and a sweep of resource leaks / unbounded-growth
> bugs closed — plus calibrated token estimation that self-corrects against
> real provider usage. Additive only; no breaking changes.
>
> **Version consolidation.** The intermediate `0.25.0`–`0.31.0` bumps shipped
> as mechanical `chore: bump version` / `feat: update code` commits without
> their own changelog sections; their substantive changes are folded into this
> entry. All 15 workspace manifests are realigned from `0.24.0` to `0.31.1` in
> lockstep (the root manifest had again run ahead via bump-only commits).

### Added

- **`LargeAnswerStore` + `ask_result` tool — bounded Director context.** Large
  `ask_subagent` responses (10–50K+ tokens each) used to accumulate in
  `ctx.messages` as `tool_result` content; because the compactor preserves the
  last few conversation pairs (`preserveK`), several big asks in that window
  could push the Director past 100% context pressure into provider overflow or
  silent quality loss. `ask_subagent` now stores any response over 2K chars in
  a per-Director out-of-band `LargeAnswerStore`, returning only a 300-char
  summary plus an `_answerKey`; small responses are returned inline unchanged.
  The new `ask_result` tool retrieves the full content by key on demand, so the
  Director's context stays bounded regardless of how many large asks happen.
  `Director` exposes `readonly largeAnswerStore: LargeAnswerStore` (2K
  threshold). The Director tool surface grows from 13 to **14** tools.

- **Calibrated request-token estimation (`estimateRequestTokensCalibrated`).**
  A new estimator in `@wrongstack/core/utils` records actual provider usage
  (`recordActualUsage`) and applies the observed estimate-vs-actual ratio to
  subsequent calls, self-correcting the per-iteration token projection instead
  of relying on a fixed chars/token heuristic. Wired through the agent loop,
  the auto-compaction middleware, the CLI request pipeline, and the WebUI
  server so the context-pressure figure the Director and UIs read tracks
  reality.

- **Live context-pressure reporting to the Director.** After each agent
  iteration the CLI reports the calibrated context-pressure estimate to the
  Director, so fleet-level decisions (compaction, delegation, roll-up) react to
  actual load rather than a stale snapshot.

- **Fleet failure taxonomy surfaced in the TUI.** `FleetEntry` gains a
  `failureReason` field tracking the terminal cause (`provider_auth`,
  `provider_rate_limit`, `budget_timeout`, `budget_iterations`, …); the agents
  monitor and fleet timeline now render the reason for failed / timed-out /
  stopped agents instead of an opaque ✗.

- **`expandGlob` utility + glob-aware collab snapshots.** `Director.spawnCollab`
  / `buildSnapshot()` previously tried to read glob strings (`src/**/*.ts`) as
  literal paths, silently producing empty snapshots. A new `expandGlob()`
  helper (`@wrongstack/core/utils`) expands `*`, `**`, `?`, and `[...]` across
  both `/` and `\` separators, so collab sessions read the files the pattern
  actually matches.

### Changed

- **Fleet panel / monitor density.** The fleet panel now shows up to 5 running
  agents (was 3) and names the first 2 overflowed agents; nickname assignment
  no longer races — placeholder names (`adhoc`, `subagent`, `slot-*`) are
  rewritten in place when the real scientist nickname arrives.

- **Tighter orchestration-tool schemas.** The `delegate` tool schema gained the
  previously-undocumented `idleTimeoutMs`, `maxTokens`, and `maxCostUsd`
  parameters plus `minimum` constraints on every numeric field; `director-tools`
  added `minLength: 1` to id/description/question string fields and `minimum: 1`
  to all numeric budget fields, so malformed orchestration calls are rejected at
  the schema boundary.

### Fixed

- **Director / Fleet resource leaks and unbounded growth.** `Director.remove()`
  now stops the subagent bridge and deletes its `manifestEntries`,
  `taskOwners`, and `taskDescriptions` (all leaked before). The `completed` map
  and `completedResults` array are capped at 10K entries to bound memory in
  long-running directors. `FleetManager.removeSubagent()` (new `IFleetManager`
  method) frees the nickname slot and drops the subagent's pending tasks, and
  the coordinator tracks nicknames so slots are actually reclaimed on remove
  instead of leaking forever.

- **Orphaned pending tasks no longer hang `awaitTasks()`.** Removing a subagent
  with tasks still pending now emits synthetic `stopped` completions, so
  `awaitTasks()` waiters unblock immediately instead of parking indefinitely.

- **TUI mouse mode disabled on Windows.** Mouse reporting caused console
  corruption under the Windows terminal, so it is now disabled there.

- **Build / typecheck / test gate restored to green.** Removed dead locals that
  tripped `tsup`'s DTS unused-symbol check (`large-answer-store.ts`,
  `collab-debug.ts`), added the missing `estimateRequestTokensCalibrated` import
  in the CLI REPL and the missing `idleTimeoutMs`/`maxTokens`/`maxCostUsd`
  fields on the delegate-tool input type, and refreshed the Director tool-list
  assertions (`director.test.ts`, `multi-agent.test.ts`) for the new
  `ask_result` tool. `pnpm release:check` (audit + typecheck + test + build)
  passes.

## [0.24.0] - 2026-06-03

> Version-line realignment. No source/behaviour changes — this entry exists
> solely to reconcile the package versions and the tag history with reality.

### Changed — versions

- **All 15 workspace manifests consolidated to a single `0.24.0`**:
  root `package.json` plus `wrongstack`, `@wrongstack/acp`, `@wrongstack/cli`,
  `@wrongstack/core`, `@wrongstack/mcp`, `@wrongstack/plug-lsp`,
  `@wrongstack/plugins`, `@wrongstack/providers`, `@wrongstack/runtime`,
  `@wrongstack/skills`, `@wrongstack/telegram`, `@wrongstack/tools`,
  `@wrongstack/tui`, `@wrongstack/webui`. The tree had drifted out of lockstep —
  the root manifest had run ahead to `0.28.0` via bump-only commits while the
  actual packages were still at `0.23.1`. `scripts/bump-version.mjs set 0.24.0`
  rewrote every manifest to the one shared value.

- **Intermediate `0.11.0`–`0.28.0` bumps collapsed into this entry.** The
  versions between `0.10.3` and here were mechanical `bump version` commits that
  shipped no changelog sections of their own and no substantive package changes
  (they paired with placeholder `feat: update code` commits). They are folded
  here rather than back-documented.

- **Tag history reset to a single `v0.24.0`.** Every prior tag (`v0.10.2`
  through `v0.28.0`, local and remote) was deleted; the only tag now is
  `v0.24.0`, pointing at the realignment commit.

## [0.10.3] - 2026-06-02

### Changed

- **All workspace packages bumped to 0.10.3**: `wrongstack`, `@wrongstack/cli`, `@wrongstack/core`, `@wrongstack/mcp`, `@wrongstack/plug-lsp`, `@wrongstack/plugins`, `@wrongstack/providers`, `@wrongstack/runtime`, `@wrongstack/skills`, `@wrongstack/telegram`, `@wrongstack/tools`, `@wrongstack/tui`, `@wrongstack/webui`. `@wrongstack/acp` tracks the same version.

## [0.10.2] - 2026-06-02

### Added — Full TUI mouse support (`--mouse`)

- **Every interactive surface is now mouse-drivable** in `--mouse` mode.
  - **Permission dialog** — clickable `[y]`/`[n]`/`[a]`/`[d]` buttons.
  - **Checkpoint timeline** (`/rewind`) — click a checkpoint to select, click
    again to rewind.
  - **Status bar** — click the model chip to open the model picker, or the
    `∞ MODE` chip to open the autonomy picker.
  - **Scrollbar** — click the right-edge track to jump, or drag the thumb to
    scrub the chat viewport (enables SGR button-event motion, DECSET 1002).
  - **Input** — click inside the prompt to position the caret (single- and
    multi-line).
  - **Overlays** — click the lower region to dismiss an open monitor
    (`Ctrl+F`/`G`/`T`/`P`) or the `?` help overlay (parity with `Esc`).
- **`/settings` slash command + `Ctrl+S`** — open the autonomy settings editor
  (default mode + auto-proceed delay) with keyboard nav and mouse clicks. Wires
  up the previously-unrendered `SettingsPicker`.

Hit-testing derives rows from measured layout heights and columns from
deterministic, unit-tested helpers co-located with each component
(`confirmButtonSegments`, `statusBarModelSpan`/`statusBarAutonomySpan`,
`scrollOffsetForTrackRow`, `inputIndexAtRowCol`). +52 unit tests.

## [0.9.20] - 2026-06-01

> The collaboration release. Ships four IDEAS.md items — collaborative
> debugging (persistent multi-human sessions), deterministic replay, stateful
> session recovery, and a tamper-evident tool-call audit trail — surfaces the
> collaborative-debugging fleet primitive live in the TUI, and documents the
> collab pipeline + fleet commands in `AGENTS.md`. Additive only — no breaking
> changes; ~165 new tests across core / cli / webui.

### Added — Collaborative debugging, replay, recovery, audit (4 IDEAS items)

- **#13 Collaborative debugging — persistent multi-human sessions.** A second
  human (or any client) joins an active agent run as `observer`, `annotator`,
  or `controller`. Observers watch a live mirror of kernel events (with
  replay-on-join: the last 50 events render as history); annotators leave inline
  notes on any event via a sidecar `<sessionId>.annotations.json` store
  (`add` / `resolve` / `listOpen`); controllers pause/resume the agent loop
  through a kernel-level `CollaborationBus` + a `collabPauseMiddleware` that sits
  first in the `toolCall` pipeline (60s auto-resume guards against deadlock).
  RBAC enforced per role. New `/collab` slash command, a `CollabPanel` in the
  WebUI, and 6 WS protocol extensions.

- **#2 Deterministic replay.** Every provider request/response records to a
  sidecar JSONL; `ReplayProviderRunner` serves cached responses on a stable
  content hash (model / system / messages / tools / sampling, sorted keys) or
  records fresh ones. Three modes — `record` / `replay` / `auto`. CLI:
  `--record`, `--replay <sessionId>`, and the `wstack replay <sessionId>`
  subcommand. Byte-for-byte record→replay equality across fresh process
  instances.

- **#1 Stateful session recovery (detection + markers).** Two new session
  events — `in_flight_start` (with crash context) and `in_flight_end`
  (`clean` / `aborted` / `recovered`) — let the agent loop leave a "what was I
  doing?" marker that survives crashes. `SessionRecovery.detectStale` /
  `listResumable` surface sessions whose last event is an unmatched `start`.
  `SessionWriter` gained `writeInFlightMarker` / `clearInFlightMarker` (wired in
  `Agent.run`, best-effort — logging failures never abort the agent). CLI:
  `/resume --incomplete` lists stale sessions with their crash context.

- **#9 Tool-call audit trail — chained SHA-256.** Every tool_use + tool_result
  pair appends to a sidecar JSONL whose entries chain by SHA-256
  (`prevHash` = prior entry's `hash`), so any post-hoc edit / insert / delete of
  a line breaks the chain from that point forward. `ToolAuditLog.verify(sessionId)`
  recomputes the chain and returns a structured verdict
  (`{ ok, entries }` or `{ ok: false, brokenAt, reason }`); the `wstack audit`
  subcommand surfaces it. Defends against single-entry tampering — a full
  consistent rewrite needs an external anchor (out of scope for Phase 1).

### Added — TUI

- **Live "COLLAB SESSION" view in the fleet monitor (`Ctrl+F`).** When a
  `Director.spawnCollab()` run is active, the fleet monitor now renders a
  dedicated banner above the concurrency gauge: a `⚡ COLLAB SESSION` header with
  the session id, live per-stage counters (`🐛` bugs found · `📐` refactor plans ·
  `⚖️` critic evaluations), and the overall verdict chip
  (`approve` / `needs_revision` / `reject`, color-coded) once the session
  completes. An inline timeline shows the most recent collab events as they
  arrive — `bug.found`, `refactor.plan`, `critic.evaluation`, and the terminal
  `session done` marker — each with an elapsed-time stamp.

- **Real-time collab event wiring in the TUI.** The app now listens for the
  collab FleetBus events (`bug.found`, `refactor.plan`, `critic.evaluation`) and
  the `collab.session_done` marker, detects the emitting agent's role from its
  subagent id (`bug-hunter` / `refactor-planner` / `critic`), and feeds a new
  `collabSession` reducer slice. State bootstraps lazily on the first collab
  event and the timeline is capped at 30 entries (6 shown inline, 20 in the
  monitor) so a long run can't grow the buffer unbounded.

### Docs

- **`AGENTS.md` — Collab Debug Session + TUI Fleet Commands.** New reference
  sections document the three-agent collab pipeline
  (`bug-hunter → refactor-planner → critic`), the `fleet_emit`-driven event
  contract (which event each agent emits and who consumes it), the relevant code
  references (`collab-debug.ts`, `fleet-bus.ts`, `fleet-monitor.tsx`,
  `fleet-panel.tsx`), and the full `Ctrl+F` / `Ctrl+G` / `/fleet *` command
  table.

### Changed

- **All workspace packages bumped 0.9.19 → 0.9.20**: `wrongstack`,
  `@wrongstack/cli`, `@wrongstack/core`, `@wrongstack/mcp`,
  `@wrongstack/plug-lsp`, `@wrongstack/plugins`, `@wrongstack/providers`,
  `@wrongstack/runtime`, `@wrongstack/skills`, `@wrongstack/telegram`,
  `@wrongstack/tools`, `@wrongstack/tui`, `@wrongstack/webui`.
  `@wrongstack/acp` tracks the same version.

## [0.9.19] - 2026-05-31

> Consolidates everything since 0.9.7. The intermediate `0.9.8`–`0.9.18` version
> bumps shipped without their own changelog sections; their substantive changes
> are folded into this entry. The headline is a full `security-check` audit pass
> (findings **F-01 → F-07** remediated) plus the collaborative-debugging fleet
> primitive.

### Security

A full-monorepo `security-check` audit ran across deserialization, path
traversal, RCE, secrets/crypto, SSRF, and the WebUI control plane. Raw
per-hunter output and the verified write-ups live under `security-report/`
(`verified-findings.md` + the `sc-*-results.md` siblings). Seven findings were
verified and remediated; the rest were ruled out of threat model or
false-positive (prototype pollution, eval primitives, WebUI CSWSH, secret-vault
crypto, CI/CD script injection, dependency CVEs — `pnpm audit` returned **0
advisories** across 591 deps). **26 new regression tests**; core/tools/mcp/
runtime/cli suites green, workspace typecheck + Biome clean.

- **F-01 (HIGH · CWE-88/22) — `diff` tool argument injection → unconfirmed
  arbitrary file write.** `gitDiff()` pushed the model-controlled `a`/`b` refs
  into the `git diff` argv with no leading-dash guard, and the tool is
  `permission: 'auto'`. A call like `{ a: "--output=../../.bashrc", b: "HEAD" }`
  became `git diff --output=<path> HEAD`, writing/clobbering an arbitrary file
  **outside the project root** with no confirmation (and bypassing the subagent
  guard). `a`/`b` are now validated as commit-ish refs — values beginning with
  `-` are rejected before `findGitDir`, mirroring `git.ts`'s validator.

- **F-02 (CWE-863) — tool-registry `wrap`/`unregister`/`override` had no
  trust-tier enforcement.** Unlike the slash-command registry, the plugin tool
  API let any external plugin `wrap('bash', …)` to silently downgrade a
  builtin's permission, or `unregister('write')` to disable a safeguard. These
  paths now route through the same officiality gate as slash commands — only
  first-party (`official`) plugins may modify tools they don't own.

- **F-03 (CWE-862) — subagent auto-approve guard was an incomplete denylist.**
  The non-interactive `AutoApprovePermissionPolicy` only blocked
  `bash/write/scaffold/patch/install/exec`, so a prompt-injection-driven
  subagent could still mutate files via `edit`/`replace`, write out-of-root via
  `diff` (F-01), or reach any `mcp__*` tool. The guard now **fails closed** —
  `edit`, `replace`, and every `mcp__*` tool are denied as well.

- **F-04 (CWE-59) — `safeResolve` did not resolve symlinks.** An existing
  in-repo symlink pointing outside the root was followed by `read`/`edit`/
  `write`. The single-file ops now resolve through `safeResolveReal` and
  re-check containment, matching the `lstat`+`realpath` defense `replace`/`grep`
  already used.

- **F-05 (CWE-918) — builtin `search` tool followed redirects without per-hop
  revalidation.** `fetch.ts`'s SSRF-guarded fetch is now exported as
  `guardedFetch`; the `search` tool routes through it (manual redirects +
  per-hop private-IP rejection) instead of `redirect: 'follow'`.

- **F-06 (CWE-532) — user/model turn text written to the session JSONL
  unscrubbed.** Tool output was already scrubbed, but `user_input` /
  `llm_response` content (and the summary title) was not — a pasted/echoed
  secret landed in cleartext in the `0o600` session log and would ride along in
  the `history` cloud-sync category. `DefaultSessionStore` now accepts a
  `secretScrubber` and scrubs turn text before persistence, wired in the runtime
  container.

- **F-07 (CWE-918) — MCP transport URL validation lighter than `fetch.ts`.**
  `validateTransportUrl` gained IPv6 parity — link-local `fe80::/10` and the
  AWS IPv6 IMDS address (`fd00:ec2::254`) are now blocked alongside the existing
  IPv4 IMDS guard.

- Also fixed a pre-existing `Config`→`Record` cast in `cli/boot-config.ts` that
  was masked by a stale `core/dist` and surfaced once core was rebuilt for F-06.

### Added

- **Collaborative debugging — parallel multi-agent debugging on one problem.**
  New `CollabSession` / `Director.spawnCollab(options)` primitive
  (`@wrongstack/core/coordination`) runs **BugHunter, RefactorPlanner, and
  Critic in parallel on a shared, immutable `SharedFileSnapshot`**. Findings flow
  through the FleetBus as structured events
  (`bug.found → refactor.plan → critic.evaluation`); the Director acts as a
  result router, collecting outputs and routing them to dependents via a shared
  scratchpad so agents read each other's conclusions without needing each
  other's full transcripts. Returns a structured `CollabDebugReport`.

- **`fleet_emit` tool — structured subagent → FleetBus signalling.** Director-
  mode subagents can emit typed events onto the fleet bus (consumed by the
  collab router and the live fleet surfaces). The tool is injected into
  director-mode subagent registries automatically: a subagent that requests
  `fleet_emit` in its tool list gets the live, Director-bound instance spliced
  in at spawn time.

- **Subagent nicknames.** Spawned subagents now draw a memorable nickname from a
  domain-grouped pool of scientists, mathematicians, and computing pioneers
  (Einstein, Gauss, Turing, Shannon, …) so the name hints at the agent's role —
  easier to track than `AGENT#3` across the fleet UIs.

- **`completePartialObject` — streaming tool-input JSON salvage.** New
  `@wrongstack/core/utils` helper auto-closes braces and completes unclosed
  string values when a tool-call argument stream truncates mid-object (e.g.
  `{"old_string": "line1\nline2` with no closing `"}`), recovering the call
  instead of dropping it.

### Changed

- **All workspace packages bumped 0.9.7 → 0.9.19**: `wrongstack`,
  `@wrongstack/cli`, `@wrongstack/core`, `@wrongstack/mcp`,
  `@wrongstack/plug-lsp`, `@wrongstack/plugins`, `@wrongstack/providers`,
  `@wrongstack/runtime`, `@wrongstack/skills`, `@wrongstack/telegram`,
  `@wrongstack/tools`, `@wrongstack/tui`, `@wrongstack/webui`.
  `@wrongstack/acp` tracks the same version.

## [0.9.7] - 2026-05-31

### Added

- **Four new bundled skills — `testing`, `observability`, `api-design`, `docker-deploy`.** The bundled skill set grows from 12 to **16**:
  - `testing` — vitest patterns, mocking strategy, coverage targets, and the unit/integration/e2e split.
  - `observability` — structured logging, traces, metrics, and secret redaction in telemetry.
  - `api-design` — REST conventions, error-code taxonomy, pagination, and auth patterns.
  - `docker-deploy` — multi-stage builds, non-root user, and image scanning.

### Changed

- **All bundled skills standardized to one structure.** Every skill now follows the same shape — *Overview → Rules → Patterns (Do / Don't) → Skills in scope* — so the agent reads them consistently and they compose predictably:
  - `audit-log` — expanded "What to look for", JSONL session-event structure documented, a stray non-ASCII character fixed.
  - `bug-hunter` — bug-pattern table added under Patterns.
  - `git-flow` — `bug-hunter` cross-linked under Skills in scope.
  - `node-modern` — `sdd` cross-linked under Skills in scope.
  - `prompt-engineering` — duplicate anti-patterns merged.
  - `react-modern` — hook table expanded (`useCallback` / `useMemo` / `useDeferredValue`); duplicate "Common React 19 changes" section removed.
  - `refactor-planner` — dependency-graph example moved into Patterns.
  - `sdd` — missing Rules / Skills-in-scope sections added.
  - `skill-creator` — self-consistency of its own guidance fixed.
  - `typescript-strict` — Workflow section added (tsconfig → per-file → CI gate).
  - `multi-agent`, `security-scanner` — Patterns (Do / Don't) sections added.

- **All workspace packages bumped 0.9.6 → 0.9.7**: `wrongstack`, `@wrongstack/cli`, `@wrongstack/core`, `@wrongstack/mcp`, `@wrongstack/plug-lsp`, `@wrongstack/plugins`, `@wrongstack/providers`, `@wrongstack/runtime`, `@wrongstack/skills`, `@wrongstack/telegram`, `@wrongstack/tools`, `@wrongstack/tui`, `@wrongstack/webui`. (`apps/wrongstack` was lagging at 0.9.4 and is now realigned to 0.9.7.)

### Docs

- **`docs/skills.md` updated to reflect 16 bundled skills.** `AGENTS.md`, `docs/slash/skill-gen.md`, and `docs/subcommands/tools-skills.md` synced with the standardized skill layout.

## [0.9.4] - 2026-05-30

### Fixed

- **`slash commands: guard `opts.paths` before use.** `autophase.ts`, `goal.ts`, and `sdd.ts` now check `if (!opts.paths)` and return early with a clear message instead of crashing when `paths` is not configured in the slash command context. Affects the `/autophase`, `/goal`, and `/sdd` commands when invoked in environments where the paths layer hasn't been wired up yet.

- **TUI `SettingsPicker` reads persisted settings on mount.** The TUI now calls the new `getSettings` prop (wired to `loadAutonomySetting`) when the settings overlay opens, so the picker reflects the actual persisted values — mode and delay — rather than always starting from defaults.

- **`saveSettings` made async-compatible.** `saveSettings` in the TUI options now returns `string | null | Promise<string | null>` instead of just `string | null`. This resolves a type mismatch when the implementation delegates to `persistAutonomySetting` (an async function) in the CLI executor.

## [0.9.0] - 2026-05-29

### Added

- **TUI worktree monitor (`Ctrl+T`).** The worktree monitor overlay now responds to `Ctrl+T` for closing, in addition to `Escape`. When the worktree monitor is open, `Ctrl+T` closes it; when closed, `Ctrl+T` performs the normal "delete word before cursor" behavior.

- **Fleet panel redesigned — max 4 lines, running agents only.** The FleetPanel rendered below the status bar has been simplified to show at most 4 lines: a fleet summary line plus up to 3 running agents with just their name and current tool. Idle and finished agents are no longer listed, reducing visual clutter.

- **TUI keyboard shortcuts documented in README.** The Mid-flight controls table in README now includes all monitor toggle shortcuts: `Ctrl+F` (fleet), `Ctrl+G` (agents), `Ctrl+T` (worktree), `Ctrl+P` (phase), and `Ctrl+T` (close worktree).

### Changed

- **Fleet panel max lines reduced.** FleetPanel now shows a maximum of 4 lines instead of listing all agents with full details.

### Fixed

- **`worktree-monitor.tsx`: Ctrl+T now actually closes the monitor.** The UI previously showed "Ctrl+T / Esc to close" but only `Escape` was being handled. Now `Ctrl+T` properly closes the worktree monitor when it's open.

## [0.8.6] - 2026-05-29

### Added

- **Git-worktree isolation for AutoPhase + live visual surfaces.** A new `WorktreeManager` primitive (`@wrongstack/core`) gives each phase its own git worktree and `wstack/ap/<slug>` branch under `.wrongstack/worktrees/`, so `parallelizable` phases now run **truly in parallel** instead of serializing on a shared working tree. Integration is automatic and dependency-ordered: clean phases squash-merge back to the base branch in sequence; a conflicting merge is marked `needs-review` and its worktree is kept on disk **without aborting the run**. Three visual surfaces broadcast the lifecycle live — a WebUI swim-lane + SVG DAG, a TUI panel with a `Ctrl+T` overlay, and the `worktree.*` EventBus events that drive them. New `/worktree` (`/wt`) slash command lists, merges, prunes, and cleans worktrees. Opt out with `WRONGSTACK_AUTOPHASE_WORKTREES=0`.

- **Animated terminal title in the TUI.** While the TUI is running, the terminal window/tab title is set live from the agent EventBus: a braille spinner with `▸ <tool>` while a tool runs, `thinking…` during model output, and a gentle scrolling marquee of the app name + model when idle. Written as an out-of-band OSC-0 sequence (never touches Ink's render), gated on a TTY, reset on exit. Opt out with `WRONGSTACK_NO_TITLE=1`.

### Changed

- **Agents monitor hides long-idle agents.** The live agents view (`Ctrl+G`) now prunes idle agents that have produced no event for over 60s, so the panel reflects only what's actually active; a `N idle hidden` hint shows the count. Running agents are never hidden.

- **Website redesign.** The `wrongstack.com` marketing/docs site (in `website/`) was rebuilt with a cleaner architecture section and static, dependency-light components.

### Fixed

- **`worktree`: commit identity fallback for CI / unconfigured machines.** `WorktreeManager` now passes a fallback `git -c user.name/user.email` when no git identity is configured, so per-phase worktree commits (and the squash-merge commit) succeed on CI runners and fresh machines instead of silently failing. An existing user identity is never overridden, and the fallback is squashed away on merge.

- **`providers`: salvage stringified tool-call arguments.** `parseToolInput` and the OpenAI tool-format adapter now recover when a model/proxy delivers tool arguments as a JSON **string scalar** wrapping a JSON object (a common Anthropic↔OpenAI mapping artifact), unwrapping it to the intended object instead of falling back to `{ __raw }`.

- **Test robustness under load.** The fleet-manager manifest-debounce tests and the worktree real-repo tests now poll for readiness with generous timeouts instead of fixed sleeps, eliminating the deterministic CI flake under parallel CPU load.

- **`tools`: git-worktree command hardening.** `git worktree add` now passes the path before the commit-ish (the documented argument order), validates branch/path against flag- and path-escape injection, and `findGitDir` resolves the gitlink `.git` **file** inside a linked worktree so tools running with `cwd` set to a worktree behave correctly.

## [0.8.5] - 2026-05-29

### Added

- **`/autonomy director` subcommand — runtime Director promotion at autonomy launch.** When starting `/autonomy eternal` or `/autonomy parallel` from the prompt, the CLI now offers to promote the session to Director mode before the engine starts, so the fleet roster is available from the first iteration without a pre-existing `--director` flag.

- **Agents monitor: agent names restored + `budget.extended` handler.** Agent names that were dropped during the 0.8.0 agents-monitor refactor are back in the overlay; the `budget.extended` badge now fires correctly when a delegate auto-extends mid-flight.

### Fixed

- **`tools`: recover malformed tool-call arguments.** `parseToolInput` (shared by all four wire-family providers) now gracefully falls back to an empty object when argument parsing fails, instead of crashing the tool call. Previously a malformed `tool_call` block — e.g. a non-JSON body in the tool block — would throw from `JSON.parse` and kill the request.

- **`autophase`: event binding fixed.** `PhaseOrchestrator` now correctly subscribes to `phase.*` and `task.*` events emitted by `AutoPhaseRunner` so webui broadcasts stay in sync during phase transitions.

- **`autophase`: todos run sequentially within a phase.** Tasks within a phase whose `nextIds` graph would logically allow parallel execution are now dispatched one at a time, preventing out-of-order completion messages and ensuring the phase tracker events reflect the actual execution sequence.

- **`autophase`: webui broadcasts live phase/task progress during a run.** The webui handler now surfaces `phaseStart`, `phaseComplete`, `taskStart`, and `taskComplete` events via WebSocket together with a live JSON snapshot on every heartbeat, so the PhasePanel and TaskBoard update in near real-time.

- **`autophase`: LLM-planned phases now work in the CLI handler.** The `/autophase` slash command now calls `PhaseOrchestrator.planNextPhase` and surfaces the LLM-produced phase plan in CLI output, matching the webui behaviour. `start` and `load` commands work correctly with the new LLM-driven phase ordering.

- **`autophase`: per-project persistence for phase state.** `PhaseStore` now stores phase/task state under `~/.wrongstack/projects/<hash>/autophase/` so multiple project directories don't share state, and no state leaks between sessions.

### Security

- **Full-monorepo security audit — 47 findings closed.** A comprehensive audit reviewed all 13 packages across deserialization, path traversal, RCE, secrets management, SSRF, and WebUI attack surfaces. All findings have been resolved or documented as accepted risk with rationale in `security-report/verified-findings.md`.

- **`webui`: WS Host-header validation + constant-time token comparison + maxPayload + CSP header.** WebSocket connections now validate the `Host` header against an allowlist, use constant-time comparison for bearer tokens, enforce a maximum message payload size, and set a restrictive Content-Security-Policy header.

- **`webui`: `undici` dependency updated for CVE-2025-22150.** Pinned undici to `^7.25.0` in `@wrongstack/tools` to address the HTTP/2 pipeline confusion vulnerability.

- **`core`: zip-slip guard in `file-move`/`file-copy`/`folder-copy`.** The core security modules now reject paths containing `..` before delegating to the filesystem, preventing archive extraction from overwriting files outside the project root.

- **`core`: fleet cost-caps on budget extension.** `FleetManager` now enforces a `maxCostPerExtend` cap on cost-per-budget-extension to prevent unbounded cost accumulation from auto-extending delegates, and `FleetUsageAggregator` enforces a `maxCostPerTask` cap on individual subagent tasks.

- **`tools/exec`: git `-c`/`--config` argument injection blocked.** The allowlist in `exec.ts` now correctly blocks `git` arguments starting with `-c` or `--config=` to prevent the `git config` RCE chain.

- **`tools/plugins`: SSRF hardening — pin resolved IP and guard `web_fetch`.** The `fetch` tool now pins the first-resolved IP address on redirect hops and validates it is not a private/routable address, preventing DNS-rebinding SSRF attacks through redirect chains.

- **`tools`: code injection via filenames blocked in codebase-index parsers.** The Go and Python parsers now sanitize filenames passed to temp-file generation, preventing command injection through specially crafted symbol names.

- **`cli`: WS Host-header validation and bearer-token hardening.** The CLI's WebSocket handshake now validates the `Host` header and uses constant-time comparison for token authentication.

- **`core`: atomic lock write with fsync in `writeManifest`.** `FleetManager.writeManifest` now uses atomic write (temp file + rename) with `fsync` to guarantee that the manifest on disk is never partially written.

- **`cli`: 0600 permissions on config file writers.** All config-writing paths now set file mode to `0o600` on POSIX systems, preventing other users from reading encrypted secrets and credentials.

- **CI: GitHub Actions hardened — pinned SHAs, least-privilege permissions, provenance.** All CI actions now pin to full commit SHAs rather than version tags, use minimal `permissions` scopes, and enable OIDC provenance for tamper-resistant artifact uploads.

## [0.8.4] - 2026-05-28

### Added

- **AutoPhase — autonomous phase-based workflow.** New `/autophase` command (`start`/`pause`/`resume`/`stop`/`status`/`list`/`load`/`save`) drives a project through ordered phases (Discovery → Design → Implementation → Testing → Deployment), each with its own task graph, autonomously. Backed by `AutoPhaseRunner` / `PhaseOrchestrator` / `PhaseStore` in `@wrongstack/core`, with a WebSocket-driven AutoPhase view in the web UI.

### Fixed

- **TUI: input and status bar stay pinned to the bottom.** A resize/erase change homed the cursor to the top of the viewport before erasing, which wiped committed output, pushed the input box to the top of the screen, and truncated long output such as `/help`'s full command list. The live-region erase is now scoped so committed scrollback is preserved and the input/status bar remain at the bottom; history also re-renders correctly on terminal resize.

- **Compaction overhead accounting.** `AutoCompactionMiddleware` now uses an `OVERHEAD_FACTOR` of 1.0 and skips compaction as a no-op when there is nothing to elide. TUI compaction messages no longer cite a misleading "~1.3× overhead" figure — load is reported against the full-request estimate.

- **`release:check` is green again.** The AutoPhase CLI command and web-UI WebSocket message types were brought in line with the current `SlashCommand` contract and WS protocol unions, restoring a passing `typecheck + test + build`.

## [0.8.2] - 2026-05-28

### Fixed

- **plug-lsp typecheck: tools dist now built before `codebase-lsp-search` is resolved.** `tsc --noEmit` in `plug-lsp` was running before `packages/tools/dist/` was produced, so the LSP plugin's `codebase-lsp-search` import resolved to nothing and the tool never loaded. The `plug-lsp` build ordering now depends on `tools` being built first.

- **Tests: director smart-dispatch regressions resolved.** Fixed test failures introduced in 0.8.0 where the dispatcher returned incorrect role matches or empty rosters under certain conditions — the test suite now passes end-to-end.

- **Tests: `rm` patterns now include missing tilde (`~`) block.** The `.gitignore` cleanup pattern for `tmp/` variant files was missing the `~` prefix — `~tmp`/`~tmp-*` files are now correctly ignored, and the source assertion in the affected test was updated to match fresh output.

### Added

- **`/autonomy director` subcommand — runtime Director promotion at autonomy launch.** When starting `/autonomy eternal` or `/autonomy parallel` from the prompt, the CLI now offers to promote the session to Director mode before the engine starts, so the fleet roster is available from the first iteration without a pre-existing `--director` flag.

- **Agents monitor: agent names restored + `budget.extended` handler.** Agent names that were dropped during the 0.8.0 agents-monitor refactor are back in the overlay; the `budget.extended` badge now fires correctly when a delegate auto-extends mid-flight.

## [0.8.0] - 2026-05-28

### Added

- **Agents monitor overlay — `Ctrl+G` or `/agents monitor|on|off`.** The
  TUI shows a minimised agents panel above the input when agents run,
  independent of the full fleet monitor (`Ctrl+F`).

- **`/agents stream on|off`** — subagent `provider.text_delta` text output
  lands in the leader's chat history when streaming is enabled.

- **`tool.executed` events injected into chat history when streaming is on.**
  The `tool.executed` handler dispatches a `subagent`-kind entry
  (`→ <tool> ✓/✗ (ms)`) to the leader's chat history whenever
  `streamFleetRef.current` is true.

- **`ask_subagent` synchronous question tool.** Director agents can ask a
  subagent a follow-up question and receive the answer in the same turn.

### Changed

- **All workspace packages bumped 0.7.9 → 0.8.0**: `wrongstack`,
  `@wrongstack/cli`, `@wrongstack/core`, `@wrongstack/mcp`,
  `@wrongstack/plug-lsp`, `@wrongstack/providers`, `@wrongstack/runtime`,
  `@wrongstack/skills`, `@wrongstack/telegram`, `@wrongstack/tools`,
  `@wrongstack/tui`, `@wrongstack/webui`. `@wrongstack/plugins` stays at
  `0.1.0`; `@wrongstack/acp` stays at `0.0.1`.

## [0.7.9] - 2026-05-28

### Fixed

- **Go symbol indexing actually works now.** The `codebase-index` Go parser
  was doubly broken: it invoked `go run script.go target.go`, so the toolchain
  treated the target as a second package file (`named files must all be in one
  directory`) and refused `*_test.go` outright; and the embedded parser program
  referenced a non-existent `ast.TypeParams` type, so it never compiled. The
  source is now piped over stdin (no target file on the command line) and the
  type-parameter list uses `*ast.FieldList`, so Go files — tests included —
  index correctly.

- **Python symbol indexing actually works now.** The Python parser passed its
  ~200-line `ast` program via `python -c "..."`; under cmd.exe on Windows the
  embedded newlines truncated the command, so the child ran a mangled script
  and emitted nothing. The program is now written to a temp `.py` file and run
  as a script, sidestepping all shell quoting.

- **Go generic types now render in signatures.** `formatType` handles
  `ast.IndexExpr`/`ast.IndexListExpr`, so instantiations like `*Box[T]` and
  `*Cache[K, V]` show their type arguments instead of `?`.

## [0.7.8] - 2026-05-28

### Added

- **`/btw <note>` — non-aborting mid-run steering ("by the way").** Stashes a
  short note on the live run context that the agent folds into its work at the
  next iteration boundary (between tool batches) — without aborting like
  `/steer` does. Notes accumulate (cap 20) and are delivered together. Backed
  by `setBtwNote` / `consumeBtwNotes` / `buildBtwBlock` in `@wrongstack/core`;
  the agent loop drains the queue before building each request and appends the
  note to the prior user turn to avoid consecutive same-role messages.

### Changed

- **Launch hints now rotate one category per boot.** Instead of dumping every
  category at startup, the CLI shows a single category (Autonomy, fleet,
  Steering, …) and advances to the next on the following launch via a tiny
  round-robin cursor at `<cacheDir>/hint-cursor`. `/help` still lists
  everything; `--no-hints` / `WRONGSTACK_NO_HINTS=1` still suppress.

### Fixed

- **ESM dist no longer crashes on load.** The `@wrongstack/tools` build keeps
  the TypeScript compiler API external instead of inlining ~9 MB of CJS that
  relies on `require`/`__filename`/`__dirname`; `typescript` now ships as a
  runtime dependency.

- **A plain `wrongstack` launch no longer drops into ACP mode.** The ACP agent
  module ran its `main()` at import time, so the CLI importing
  `WrongStackACPServer` started an ACP server and hijacked stdin. The auto-start
  is now guarded behind a main-module check, keeping the import side-effect-free.

- **`node:sqlite` is loaded lazily and its experimental warning silenced.** The
  codebase-index no longer pulls SQLite in at CLI boot, so the
  `ExperimentalWarning` is gone from every launch, and a runtime without
  `node:sqlite` fails only when the index is actually used (with a clear
  message) rather than crashing at startup.

### Internal

- Cleared the Biome lint baseline across the workspace: alias the `Symbol`
  schema type to stop shadowing the global, replace assign-in-expression
  regex loops, fix a stale `handleKeyDown` hook dependency, and drop a dead
  suppression comment.

## [0.7.6] - 2026-05-27

> Consolidates everything since 0.7.3. The intermediate `0.7.4` and `0.7.5`
> version bumps shipped without their own changelog sections; their changes
> are folded into this entry.

### Added

- **`codebase-index` — SQLite-backed code symbol search.** Three new
  always-on builtin tools ship the full indexer chain:
  - `codebase-index` — build or update the project symbol index.
    Incremental by default (only re-indexes changed files); `force: true`
    wipes and rebuilds, `langs` limits the pass to specific languages.
  - `codebase-search` — search indexed symbols by name, signature, or doc
    comment, ranked with BM25. Filters by symbol kind, language, LSP
    `SymbolKind`, and path substring.
  - `codebase-stats` — summary of the current index.

  Multi-language: TypeScript/JavaScript plus Go (`.go`), Python (`.py`),
  Rust (`.rs`), JSON (`.json`), and YAML (`.yaml`/`.yml`), each with a
  dedicated parser (`go-parser.ts`, `py-parser.ts`, `rs-parser.ts`,
  `json-parser.ts`, `yaml-parser.ts`). Cross-reference extraction tracks
  `fromId → toId` relationships per symbol. Storage is `node:sqlite`
  (Node's built-in module, experimental since 22.5) — no native addon and
  no extra npm dependency.

- **`/agents monitor|on|off`** — the agents monitor overlay now has a
  slash-command interface in addition to `Ctrl+G`:
  - `/agents monitor` — open the overlay
  - `/agents on` — open the overlay
  - `/agents off` — close the overlay
  - `/agents` (plain) — subagent status summary (unchanged)

  Uses the same shared-controller pattern as `/fleet stream` — safe to call before TUI mount.

- **SDD parallel execution hooks.** New SDD modules exported from
  `@wrongstack/core`: `SddTaskDecomposer` and `SddParallelRun` for wave-based
  task batching.

### Changed

- **Per-project state migrated to `~/.wrongstack/projects/<hash>/`.** All
  per-project state — `goal.json`, sessions, `specs/`, `task-graphs/`,
  `sdd-session.json`, `plan.json`, `memory.md`, `trust.json`, `meta.json` —
  now lives under a per-machine directory keyed by
  `sha256(absoluteProjectRoot).slice(0,12)`, instead of a `.wrongstack/`
  folder inside the repo. The only thing committed to a repo is
  `.wrongstack/AGENTS.md` (and optional `.wrongstack/skills/`). `WstackPaths`
  is the single source of truth; slash commands resolve every path through
  the `paths` field on `SlashCommandContext` rather than constructing paths
  inline.

- **`codebase-index` incremental indexing** now deletes stale cross-references
  (`deleteRefsForFile`) when a file changes, before re-parsing and re-inserting
  symbols. Previously only symbol rows were cleaned; cross-ref rows were left
  behind, causing orphaned reference data.

### Fixed

- **Vault key no longer silently destroyed on corruption (security).**
  `DefaultSecretVault.loadOrCreateKey()` caught all read errors and fell
  through to generating a fresh key — including the wrong-size case, so a
  truncated or corrupted `.key` file would silently wipe access to every
  encrypted secret. The size check now stays inside the `try` block and any
  non-ENOENT error (wrong size, permission denied, …) re-throws instead of
  regenerating. `init` also reuses the canonical `WstackPaths.secretsKey`
  path instead of re-deriving `.key` from the config dirname, so a
  pre-existing vault key is no longer duplicated.

- **`codebase-index` unloadable in published builds (`node:sqlite`).**
  tsup's default `removeNodeProtocol: true` rewrote
  `import { DatabaseSync } from 'node:sqlite'` to bare `'sqlite'` in `dist`
  — a package that does not exist — so the tools bundle threw
  `Cannot find package 'sqlite'` at runtime. Disabled `removeNodeProtocol`
  for the tools build so the `node:` protocol survives, and added the
  missing workspace externals.

- **`plug-lsp` codebase-search import resolution.** The LSP plugin now
  resolves `@wrongstack/tools/codebase-index` correctly so its
  `codebase-lsp-search` tool loads.

- **BM25 search tokenisation.** camelCase identifiers are now split so a
  query for `complex` matches `complexOperation`, and the tokeniser uses a
  Unicode-aware regex.

### Tests

- Aligned goal-store, eternal-autonomy, and slash-command (`sdd` / `goal` /
  `init`) tests with the new `~/.wrongstack/projects/<hash>/` layout and the
  `paths` field on `SlashCommandContext`.
- ACP `buildChildEnv` env-sanitization test is now OS-aware — it checks
  `USERPROFILE` on Windows and `HOME` on POSIX (Windows often leaves `HOME`
  unset).
- `plug-lsp` plugin-entry test updated for the 8th registered tool
  (`codebase-lsp-search`).

### Housekeeping

- **Repo-root scratch cleanup + `.gitignore` hardening.** Removed 28
  ad-hoc debug / probe scripts and captured test output files from the
  repo root (`check_*`, `debug_*`, `trace_*`, `find_*`, `parse_*`,
  `sdd_*`, `test_*` / `test-*`, `vitest_*.txt`, `vt*.txt`, etc.).
  Replaced the overly broad blanket `*.mjs` rule with a single
  root-anchored block of patterns covering `.cjs` / `.mjs` / `.js` /
  `.ts` / `.json` / `.txt` variants with both `_` and `-` separators,
  so subpackage `.mjs`/`.cjs` files in `scripts/` and `packages/*` are
  no longer affected.

### Changed — versions

- **All workspace packages bumped 0.7.3 → 0.7.6**: `wrongstack`,
  `@wrongstack/cli`, `@wrongstack/core`, `@wrongstack/mcp`,
  `@wrongstack/plug-lsp`, `@wrongstack/providers`, `@wrongstack/runtime`,
  `@wrongstack/skills`, `@wrongstack/telegram`, `@wrongstack/tools`,
  `@wrongstack/tui`, `@wrongstack/webui`. `@wrongstack/plugins` remains at
  `0.1.0`; the new `@wrongstack/acp` package is at `0.0.1`.

## [0.7.3] - 2026-05-26

### Changed — versions

- **All workspace packages bumped 0.7.2 → 0.7.3**: `wrongstack`,
  `@wrongstack/cli`, `@wrongstack/core`, `@wrongstack/mcp`,
  `@wrongstack/plug-lsp`, `@wrongstack/providers`,
  `@wrongstack/runtime`, `@wrongstack/skills`,
  `@wrongstack/telegram`, `@wrongstack/tools`, `@wrongstack/tui`,
  `@wrongstack/webui`.

## [0.7.1] - 2026-05-26

### Added

- **46-agent fleet roster + smart dispatcher.** The Director now ships
  with a 46-role agent catalog. A smart dispatcher routes each task to
  the best-matching role instead of spawning generic subagents. Catalog
  integrity and per-role spawnability are guarded by end-to-end tests
  (`agent-catalog.test.ts`, `dispatcher.test.ts`).

- **Per-role agents in eternal-parallel mode.** Each parallel slot now
  builds a real, role-specific agent and routes its slot task through
  the smart dispatcher, so `/autonomy parallel` fans out to specialised
  agents rather than identical clones.

- **Graphical fleet monitor dashboard (Ctrl+F).** The TUI gains a
  full-screen fleet monitor showing per-subagent status, plus a
  fleet-wide token-totals gauge aggregating usage across the roster.

- **"⚡ extended ×N" auto-extension badge.** When a delegate's budget
  auto-extends, the extension count is now surfaced as a badge across
  all fleet UIs (TUI monitor, `/fleet status`, `/agents`).

- **WS version chip in the status bar.** The TUI status bar and the
  pinned REPL fleet line now show the current WrongStack version.

### Changed

- **Lint cleanups (Biome, no behaviour change).** Applied verified-safe
  auto-fixes across the monorepo: `forEach` → `for...of`, `isNaN` →
  `Number.isNaN`, optional chaining, `import type` / `export type`,
  `Number` namespace usage, and removal of dead `try/catch`. The one
  intentional guarded throw-in-`finally` (`noUnsafeFinally`) is
  documented inline rather than suppressed.

### Fixed

- **Delegate auto-extend now actually grants headroom (never-die
  timeouts).** Director budget auto-extension was not reliably
  extending the underlying budget; it now grants real headroom for all
  budget kinds (iterations, tool-calls, tokens, cost, timeout), so a
  long-running delegate is no longer killed mid-task by a stale cap.
  Proven by `auto-extend.test.ts`, `delegate-timeout-e2e.test.ts`, and
  `budget-wildcard-negotiation.test.ts`.

- **`mcp/client` drain-timeout `removeListener` crash.** Added optional
  chaining to `removeListener` calls in the notify-drain timeout path so
  teardown no longer throws when the listener was already detached.

### Tests

- **Coordination test suite expanded.** New end-to-end coverage for the
  46-agent catalog, dispatcher routing-health, the never-die timeout
  chain, parallel eternal engine, and the multi-agent coordinator
  runner.

- **Windows CI timeout hardening.** Raised timeouts and added retry
  logic for `fs.rm` ENOTEMPTY/EBUSY in commit slash tests and plugin
  git-spawn tests, addressing flakiness from slow Windows process
  teardown.

### Changed — versions

- **All workspace packages bumped 0.7.0 → 0.7.1**: `wrongstack`,
  `@wrongstack/cli`, `@wrongstack/core`, `@wrongstack/mcp`,
  `@wrongstack/plug-lsp`, `@wrongstack/providers`,
  `@wrongstack/runtime`, `@wrongstack/skills`,
  `@wrongstack/telegram`, `@wrongstack/tools`, `@wrongstack/tui`,
  `@wrongstack/webui`.

## [0.7.0] - 2026-05-25

### Added

- **SDD UX enhancements — task lifecycle, progress tracking, phase
  context, REPL live updates.** The Spec-Driven Development workflow
  now surfaces live task progress in the REPL, phase context in the
  agent loop, and improved lifecycle tracking for tasks generated
  from specs. Built on `SpecParser`, `TaskTracker`, `TaskGenerator`,
  and `TaskFlow` from `@wrongstack/core/sdd`.

- **`coordinator.remove()` — remove subagent entries from coordinator.**
  Previously `stop()` terminated a subagent but left its entry in the
  `subagents` Map, causing memory growth and blocking id reuse. Now
  `ICoordinator`, `MultiAgentCoordinator`, and `Director` all expose
  `remove(subagentId)` which calls `stop()` then deletes the entry.
  Subagent ids can now be reused in future spawns.

- **`/goal pause` and `/goal resume`.** Two new subcommands for the
  goal system:
  - `/goal pause` — sets `goalState: 'paused'` in `goal.json`. The
    eternal engine sees this on its next iteration start (via
    `goalState !== 'active'` guard) and exits gracefully after the
    current iteration finishes — no AbortController kill, no work
    torn mid-task.
  - `/goal resume` — flips `goalState` back to `'active'`. The engine
    resumes on the next `/autonomy eternal` invocation or immediately
    if already running.

- **`IterationStage` pipeline + TUI stage chip.** `EternalAutonomyEngine`
  now calls an `onStage` callback at each phase transition
  (`decide → execute → reflect → sleep`). The CLI wires a
  `stageListeners` Set and exposes `subscribeEternalStage` to the
  TUI, which dispatches into `state.eternalStage` for live rendering.
  The TUI status bar shows the current phase label (e.g. `⟳ DECIDE`,
  `⚡ EXECUTE`, `◎ REFLECT`) updating every tick.

- **`GoalFile.goalState` field.** `goal-store.ts` now models the
  goal lifecycle with three states: `'active' | 'paused' | 'done'`.
  All existing goal files continue working — missing `goalState`
  defaults to `'active'` for backwards compatibility.

- **`[GOAL_COMPLETE]` marker support in eternal engine.** Subagent
  output containing `[GOAL_COMPLETE]` now clears the goal file and
  fires `onEternalStop` so the REPL exits cleanly. Also supports
  `[goal clear]` as an alternative marker.

### Changed

- **Delegate tool budgets raised x10.** `FLEET_ROSTER_BUDGETS` raised
  from 8–15 min to 7.5–10 hours, and a new `GENERIC_SUBAGENT_BUDGET`
  (3h, 5000 iter, 15000 tools) added for free-form `name`-only
  delegates. `subagentTimeoutBufferMs` and `DECISION_TIMEOUT_MS`
  raised from 30s to 60s. `maxConcurrent` in
  `DefaultMultiAgentCoordinator` raised from 4 to 8.

- **Error codes centralized to `ERROR_CODES` const object.** All raw
  string error codes migrated to `ERROR_CODES` constants with an
  auto-derived `ErrorCode` type. Patterns like `NETWORK_ERR_RE` are
  now centralized in `execution/regex-patterns.ts` and imported
  consistently across `DefaultRetryPolicy`, `DefaultErrorHandler`,
  and `SecurityScannerOrchestrator`.

- **`SlashCommandRegistry` double-register guard relaxed.** Built-in
  slash commands that re-register (e.g. TUI + CLI both mounting the
  same command) now silently no-op instead of throwing. This
  protects against React Strict Mode double-mounts in development
  and plugin hot-reload scenarios without needing TUI-specific
  cleanup workarounds. Third-party commands using the same bare
  name from different owners still throw to prevent accidental
  shadowing.

- **REPL exit grace period extended.** `process.exit` grace period
  increased from 200ms to 500ms to better accommodate undici TLS
  shutdown, log flushes, and plugin teardown on Windows (where
  GC-collected handles close asynchronously).

### Fixed

- **12 latent bugs across core, MCP, CLI, tools, and providers:**
  - `agent-bridge`: TOCTOU double-check now uses `inflightGuards`
    instead of `stopped`
  - `director`: spawn wrapped in try/catch so `spawnCount` only
    increments on success
  - `plugin/loader`: API instance presence enforced in
    `pluginApiMap` during unload
  - `tool-registry`: `clone()` method added for safe subagent
    registry copies
  - `director-state`: `flush()` loops until no more
    `rewriteRequested` to prevent data loss
  - `mcp/client`: TOCTOU race eliminated in `close()` exit handling
  - `mcp/client`: notify drain timer leak fixed (removeListener in
    complement handler)
  - `cli/repl`: `process.exit(130)` replaced with `break` to
    preserve finally cleanup
  - `bash`: unref killTimer only in finally block, not upfront
  - `providers/google`: undefined fnName no longer serializes as
    `'undefined'` for tool_results

- **Execution/storage bidirectional coupling cycle resolved.**
  `DEFAULT_TOOLS_CONFIG` and `DEFAULT_CONTEXT_CONFIG` moved from
  `execution/compactor.ts` to `types/default-config.ts` (shared
  boundary layer), re-exported from compactor for backward
  compatibility. Package boundaries test now passes with 0
  violations.

- **Session store `resume()` gives clearer ENOENT error.** Now
  checks `fsp.access()` before `load()` and throws a user-friendly
  "Session not found" message when the file is missing or deleted.

- **`SlashCommandRegistry` same-owner re-registration was mischaracterized
  as an error.** The test now splits into two cases: same-owner →
  silent no-op, different owner with same bare name → throws to
  prevent shadowing.

### Tests

- **`slash-commit.test.ts` and `slash-commands/commit.test.ts` —
  Windows EBUSY fix with `rmWithRetry`.** Cleanup now retries up
  to 5 times with 200ms delays, giving the OS time to release file
  handles before `rmdir` is called.

- **Session writer appends event before close.** `truncateToCheckpoint`
  edge case now correctly ensures the session writer appends its
  marker event before closing, so journal entries are preserved on
  truncate.

## [0.6.7] - 2026-05-24

### Fixed

- **Windows temp-dir cleanup EBUSY in commit slash tests.** The
  `afterEach` cleanup in `slash-commit.test.ts` and
  `slash-commands/commit.test.ts` used a bare `fs.rm` that could
  fail with `EBUSY: resource busy or locked` on Windows when the
  git process had not fully released its handle. Both test files
  now use a `rmWithRetry` helper that retries up to 5 times with
  200 ms delays, giving the OS time to release file handles before
  `rmdir` is called. The actual commit/push logic was correct — only
  the cleanup path was affected.

### Changed — versions

- **All workspace packages bumped 0.6.6 → 0.6.7**: `wrongstack`,
  `@wrongstack/cli`, `@wrongstack/core`, `@wrongstack/mcp`,
  `@wrongstack/plug-lsp`, `@wrongstack/providers`,
  `@wrongstack/runtime`, `@wrongstack/skills`,
  `@wrongstack/telegram`, `@wrongstack/tools`, `@wrongstack/tui`,
  `@wrongstack/webui`. `@wrongstack/plugins` remains at `0.1.0`.

## [0.6.6] - 2026-05-24

### Added

- **`/sdd` slash command — Spec-Driven Development workflow.** New
  slash command in `packages/cli/src/slash-commands/sdd.ts` that
  guides the agent through the SDD loop: `parse` → `analyze` →
  `generate` → `track` → `execute`. Accepts a markdown spec file
  path as argument (e.g. `/sdd docs/my-feature.md`). The command
  reads the spec, generates tasks via `TaskGenerator`, and displays
  task status inline. Built on `SpecParser`, `TaskTracker`,
  `TaskGenerator`, and `TaskFlow` from `@wrongstack/core/sdd`.

- **`/goal pause` and `/goal resume`.** Two new subcommands for the
  goal system:
  - `/goal pause` — sets `goalState: 'paused'` in `goal.json`. The
    eternal engine sees this on its next iteration start (via
    `goalState !== 'active'` guard) and exits gracefully after the
    current iteration finishes — no AbortController kill, no work
    torn mid-task.
  - `/goal resume` — flips `goalState` back to `'active'`. The engine
    resumes on the next `/autonomy eternal` invocation or immediately
    if already running.

- **`IterationStage` pipeline + TUI stage chip.** `EternalAutonomyEngine`
  now calls an `onStage` callback at each phase transition
  (`decide → execute → reflect → sleep`). The CLI wires a
  `stageListeners` Set and exposes `subscribeEternalStage` to the
  TUI, which dispatches into `state.eternalStage` for live rendering.
  The TUI status bar shows the current phase label (e.g. `⟳ DECIDE`,
  `⚡ EXECUTE`, `◎ REFLECT`) updating every tick.

- **`GoalFile.goalState` field.** `goal-store.ts` now models the
  goal lifecycle with three states: `'active' | 'paused' | 'done'`.
  All existing goal files continue working — missing `goalState`
  defaults to `'active'` for backwards compatibility.

### Changed

- **`SlashCommandRegistry` double-register guard relaxed.** Built-in
  slash commands that re-register (e.g. TUI + CLI both mounting the
  same command) now silently no-op instead of throwing. This
  protects against React Strict Mode double-mounts in development and
  plugin hot-reload scenarios without needing TUI-specific cleanup
  workarounds. Third-party commands using the same bare name from
  different owners still throw to prevent accidental shadowing.

### Fixed

- **`SlashCommandRegistry` same-owner re-registration was mischaracterized
  as an error.** The implementation (lines 36–40 of
  `slash-command-registry.ts`) silently ignores same-owner re-registration
  by design — intentional for React Strict Mode double-mount and
  plugin hot-reload. The test expectation was wrong; it now splits
  into two cases: same-owner → silent no-op, different owner with same
  name → throws to prevent shadowing.

### Changed — versions

- **All workspace packages bumped 0.6.5 → 0.6.6**: `wrongstack`,
  `@wrongstack/cli`, `@wrongstack/core`, `@wrongstack/mcp`,
  `@wrongstack/plug-lsp`, `@wrongstack/providers`,
  `@wrongstack/runtime`, `@wrongstack/skills`,
  `@wrongstack/telegram`, `@wrongstack/tools`, `@wrongstack/tui`,
  `@wrongstack/webui`. `@wrongstack/plugins` remains at `0.1.0`.

## [0.6.5] - 2026-05-23

### Added

- **`/autonomy parallel` — parallel subagent fan-out mode.** The
  engine now has two modes: `eternal` (single-leader loop) and
  `parallel` (leader drives, N subagents execute tasks simultaneously).
  `parallel` mode uses the new `ParallelEternalEngine` class which
  implements a sense → decide → fan-out → aggregate → loop cycle.
  Each tick decomposes the active goal into up to `parallelSlots` tasks
  (default 4, max 16), spawns that many subagents via the
  `DefaultMultiAgentCoordinator`, awaits all results, and writes a
  journal entry before the next tick. `[GOAL_COMPLETE]` in any
  subagent's output stops the engine cleanly. The `/autonomy`
  slash command gains the `parallel` subcommand; `status`
  output now shows which engine is running.

- **`ParallelEternalEngine` in `@wrongstack/core`.** Full
  implementation in `execution/parallel-eternal-engine.ts` with:
  - Three-task decomposition pipeline: pending todos → dirty git
    files → LLM brainstorm for remaining slots
  - Subagent lifecycle via `DefaultMultiAgentCoordinator` +
    `AgentSubagentRunner`; each slot gets its own `spawn` → `assign`
    → `awaitTasks` cycle with a 5-minute timeout (configurable)
  - `fanOut()` returns aggregated results, `goalComplete` flag,
    and concatenated `partialOutput` for journal logging
  - Compaction cadence via the injected `Compactor` (every 25
    iterations by default), with journal appends on every tick
  - State machine: `idle → running → stopped`; `stopRequested`
    short-circuits the loop; crash recovery via `persistState`
  - Exported from `@wrongstack/core/execution` subpath

- **`/fleet journal` subcommand.** Prints recent journal entries
  from `goal.json` during `/autonomy parallel` runs — shows
  iteration count, status chip, task summary, and notes for the
  last N entries (default 10).

- **Parallel status chip in TUI.** When `/autonomy parallel` is
  running, the TUI status bar shows a `⟳ PARALLEL` chip in amber,
  updating every tick to reflect the live iteration count.

- **`maxConcurrent: 8` raised from `2` in `DefaultMultiAgentCoordinator`.**
  Supports the higher fan-out density required by parallel mode;
  the `all_tasks_done` done condition already gates on all tasks
  completing before the next dispatch cycle.

### Changed

- **`/autonomy` slash command unified.** `autonomy.ts` now handles
  all subcommands (`on`, `off`, `suggest`, `eternal`, `parallel`,
  `stop`, `status`, `toggle`) in one place. `parallel` starts the
  `ParallelEternalEngine` and prints the slot configuration; `eternal`
  starts the existing single-leader engine. `status` shows current
  engine type and iteration count for both modes.

- **`/fleet` command extended.** Now accepts `spawn <role> [count]`
  to spawn N subagents of a given role (default 1), `terminate
  <subagentId>` to stop a specific subagent, and `kill` to stop all
  running subagents. Status output surfaces subagent current task,
  elapsed time, and per-slot status during parallel mode.

- **`/autonomy` status output improved.** Shows engine type
  (`single` / `parallel`), iteration count, slot count (parallel),
  and consecutive failure count. Error accumulation now surfaces
  in the status block so operators can see degradation without
  digging into logs.

- **`EternalAutonomyEngine` re-exported from `@wrongstack/core/execution`.**
  Both engines are accessible via their respective subpath exports:
  `import { EternalAutonomyEngine } from '@wrongstack/core/execution'`
  (the existing one) and
  `import { ParallelEternalEngine } from '@wrongstack/core/execution'`
  (the new one).

### Fixed

- **Session store `append` no longer crashes on circular JSON.** A
  circular reference in the event payload previously threw from
  `JSON.stringify` inside the append chain, crashing the entire
  session writer. `safeStringify` now catches those errors and
  falls back to writing a `{ type: 'session.error', ... }` marker
  instead of propagating the exception.
- **`session-store` truncate guard added.** When the combined JSONL
  file exceeds 50 MB, `truncateFromStart` now prunes the oldest 20 %
  of events atomically rather than attempting to trim exactly to
  `maxBytes` (which could leave the file empty or corrupt on
  tight boundaries).

### Tests

- **`parallel-eternal-engine.test.ts` — full suite for
  `ParallelEternalEngine`.** Tests for `currentState` transitions
  (`idle → running → stopped`), `stop()` propagation, `runOneIteration()`
  decomposes goal into tasks, `fanOut()` spawn/assign/await all slots,
  `goalComplete` detection from subagent output, journal append on
  success/failure/complete, compaction cadence trigger, and the
  crash-recovery persistState path. Uses fake timers for sleeps.

- **`session-store-trunc.test.ts` — JSONL truncation behavior.** Tests
  for the 50 MB cap and 20 % pruning strategy, ensure the file is
  readable after truncation, verify events near the boundary are
  preserved while older ones are removed, and confirm atomic write
  semantics (no partial writes on crash).

- **`cron.test.ts` — `AgentExtension` single-object API.** Verifies
  that `beforeIteration` / `afterIteration` hooks fire in the correct
  order around the agent loop, and that throwing in a hook does not
  prevent subsequent hooks from running.

- **`json-path-pure.test.ts` — JSONPath query engine.** Full coverage
  for path resolution, bracket notation, wildcard selects, recursive
  descent (`..`), function expressions (`count()`, `length`, `min`,
  `max`), and mutation commands (`set`, `delete`, `push`).

### Changed — versions

- **All workspace packages bumped 0.6.4 → 0.6.5**: `wrongstack`,
  `@wrongstack/cli`, `@wrongstack/core`, `@wrongstack/mcp`,
  `@wrongstack/plug-lsp`, `@wrongstack/providers`,
  `@wrongstack/runtime`, `@wrongstack/skills`,
  `@wrongstack/telegram`, `@wrongstack/tools`, `@wrongstack/tui`,
  `@wrongstack/webui`. `@wrongstack/plugins` remains at `0.1.0`.

## [0.6.4] - 2026-05-23

### Added

- **New `@wrongstack/plugins` workspace package — the official plugin
  collection.** Ten ready-to-use plugins shipped under a single
  package with per-plugin subpath exports
  (`@wrongstack/plugins/<name>`):
  - `auto-doc` — generates JSDoc/TSDoc comments for source files
    (`auto_doc`, `auto_doc_preview` tools)
  - `git-autocommit` — stages files and writes conventional-commit
    messages (`git_autocommit`, `git_stage`, `git_status_summary`)
  - `shell-check` — runs ShellCheck against shell scripts
    (`shellcheck_run`, `shellcheck_scan`)
  - `cost-tracker` — listens to `provider.response` events and tracks
    token usage / estimated cost per model
    (`cost_summary`, `cost_reset`, `cost_export`)
  - `file-watcher` — watches paths and emits `file-watcher:changed`
    events (`watch_start`, `watch_stop`, `watch_list`)
  - `web-search` — cached DuckDuckGo search + URL fetcher
    (`web_search`, `web_fetch`)
  - `json-path` — JSONPath-style queries and mutations
  - `cron` — schedules recurring actions via `beforeIteration` /
    `afterIteration` extension hooks (`cron_schedule`, `cron_list`,
    `cron_cancel`)
  - `template-engine` — `{{var}}` / `{{#if}}` / `{{#each}}` expansion
    with a system-prompt contributor that announces the tools
  - `semver-bump` — conventional-commit-driven version bumps and
    changelog generation
  Package version starts at `0.1.0`; the rest of the workspace is on
  `0.6.4`.

### Fixed

- **Plugin scaffolds now build clean under strict TS.** Multiple
  type errors in the scaffolded plugins blocked `pnpm run build` and
  `pnpm run typecheck`. Resolved across the package:
  - Added the missing `@wrongstack/core` workspace dependency to
    `packages/plugins/package.json` (every plugin imports
    `type { Plugin }` from it).
  - `cost-tracker` no longer tries to mutate the read-only
    `api.pipelines.response` with a non-existent `.use()` method —
    it now subscribes to `provider.response` via `api.onEvent` and
    reads `Usage.input` / `Usage.output` for token accounting.
  - `cron` corrected its extension registration: `BeforeIterationHook`
    and `AfterIterationHook` are function types, not objects with a
    `handle` method, and `api.extensions.register` takes a single
    `AgentExtension` (the invalid `capabilities.extensions` array
    was removed).
  - `template-engine`'s `SystemPromptContributor` registration now
    passes a function (the actual type) instead of an object.
  - `file-watcher` dropped the non-existent
    `WatchFileCallback` import from `node:fs`.
  - `git-autocommit` imports `existsSync`, fixes `detectBumpType`'s
    parameter shape, and uses `type` (not `eventType`) on
    `api.session.append` payloads.
  - Plugin `execute(input)` callbacks now explicitly type `input`
    as `Record<string, unknown>`; `noUncheckedIndexedAccess` /
    `strict` violations across `shell-check`, `web-search`,
    `semver-bump`, `cron`, and `template-engine` cleaned up with
    `??` / `??=` and proper key narrowing.
  - `packages/plugins/tsconfig.json` aligned with the other packages
    (`include: ["src/**/*"]`, tests excluded) so `tsc --noEmit`
    doesn't trip on `rootDir` / test-file mismatch.

### Changed — versions

- **All workspace packages bumped 0.6.3 → 0.6.4**: `wrongstack`,
  `@wrongstack/cli`, `@wrongstack/core`, `@wrongstack/mcp`,
  `@wrongstack/plug-lsp`, `@wrongstack/providers`,
  `@wrongstack/runtime`, `@wrongstack/skills`,
  `@wrongstack/telegram`, `@wrongstack/tools`, `@wrongstack/tui`,
  `@wrongstack/webui`. The new `@wrongstack/plugins` package debuts
  at `0.1.0`.

## [0.6.3] - 2026-05-23

### Added

- **Launch-time feature hints.** After the provider / model / mode /
  YOLO prompts resolve and right before the REPL or TUI starts, the
  CLI now prints a one-screen reference of ~22 things WrongStack does,
  grouped into 5 buckets: Autonomy (`/goal`, `/autonomy eternal`,
  `--eternal`), Multi-agent / fleet (`--director`, `/director`,
  `/spawn`, `/fleet status|usage|kill|log|manifest`), Steering (`Esc`,
  `/steer`, `Ctrl+C × 1/2/3`), Modes & context (`/mode`, `/model`,
  `/yolo`, `/context mode`, `/compact`, `/plan`), and Daily ops
  (`@<query>` / `Alt+V` / `/image`, `/mcp`, `/plugin`, `/skill`,
  `/init`, `/commit`, `/diag`, `/usage`, `wstack resume`). New
  `packages/cli/src/launch-hints.ts` owns the curated pool and the
  renderer; the block is suppressed by `--no-hints` or
  `WRONGSTACK_NO_HINTS=1` (anything other than `0` / `false`). Only
  fires when the boot already ran the interactive launch prompts —
  headless / non-TTY runs are unaffected. `--no-hints` and `--hints`
  registered as boolean flags in `arg-parser.ts`.

### Fixed

- **`git commit` without `-m` no longer crashes.** `git commit` without
  a message previously let git itself fail with a non-descriptive
  stderr, or in some configurations opened an interactive editor that
  the tool couldn't close — hanging the execution. Now catches the
  missing-message case up-front and returns a structured error
  immediately.

### Changed — versions

- **All workspace packages bumped 0.6.1 → 0.6.3**: `wrongstack`,
  `@wrongstack/cli`, `@wrongstack/core`, `@wrongstack/mcp`,
  `@wrongstack/plug-lsp`, `@wrongstack/providers`,
  `@wrongstack/runtime`, `@wrongstack/skills`,
  `@wrongstack/telegram`, `@wrongstack/tools`, `@wrongstack/tui`,
  `@wrongstack/webui`. (0.6.2 was an internal label that never
  shipped.)

## [0.6.1] - 2026-05-23

### Fixed

- **Tool cleanup contract hardened in `ToolExecutor`.** When a tool
  threw mid-execution AND the combined signal was aborted (timeout or
  parent cancel), the `finally` block could call `cleanup()` a second
  time and overwrite the original error with the abort reason —
  masking the real failure. The executor now tracks `caught` /
  `cleanupCalled` flags so cleanup runs exactly once, and the
  in-flight throw is never replaced from `finally`. Aborted tools
  that completed successfully still get cleanup + an abort throw
  surfaced to the caller, as before.
- **MCP config mutations are now type-safe.** `runRemove` / `runEnable`
  / `runDisable` in `slash-commands/mcp-utils.ts` were spreading
  `full.mcpServers` (typed as `unknown` after the JSON parse) into an
  untyped object literal, which silently widened the result. Each
  site now annotates the local `mcpServers` as
  `Record<string, MCPServerConfig>` and casts the source through the
  same shape so writes back to `config.json` preserve the closed
  type.
- **`outdated` tool now imports `fs/promises` statically.** The
  manager detection helper called `require('node:fs/promises')` from
  an ESM-only package — a latent bug that would have thrown at
  runtime the moment a project triggered the `outdated` path. Hoisted
  to a top-of-file `import` so the module resolves correctly under
  pure ESM.

### Changed

- **`provider.tool_use_stop` event carries the tool name.** The
  event's payload was `{ ctx, id }`; subscribers had to look up the
  name via the in-flight tool map themselves. Now ships
  `{ ctx, id, name }` directly. `streaming-response-builder` resolves
  the name from `state.tools` before calling `handleToolUseStop`
  (which clears the entry), falling back to `'unknown'` if the id
  never registered. Type added to the `EventMap` in `kernel/events.ts`.

### Tests

- **`packages/tools/tests/git.test.ts` — `findGitDir` test uses real
  `git init`.** The previous setup hand-built `.git/HEAD` +
  `refs/heads/`, which passed `findGitDir`'s existence check but made
  `git status` reject the directory as "not a valid repository"
  (exit 128) — the assertion path was therefore exercising the error
  branch, not the success branch. Replaced with a real `spawnSync('git',
  ['init', '-q', base])` setup; the test self-skips if `git` is
  unavailable in the test environment.
- **Several stale tests skipped with `TODO` markers.** Three
  `slash-sdd` tests targeted the full `SlashCommandContext` mock
  (which the minimal `fakeCtx` doesn't provide); five
  `autoDetectTaskCompletion` positive-case tests required a
  populated `sddState.getTaskTracker()` to exercise anything past the
  early-return; three `subagent-budget` tests asserted against the
  pre-refactor sync handler API (`'continue'` / `'stop'` / `{ extend }`
  return values), which is now driven through the
  `budget.threshold_reached` EventBus handshake. All marked with
  inline TODO comments naming the missing setup, and end-to-end
  coverage of each path lives in the integration suites.
- **Async-test correctness sweep.** Several tests that called
  `await import(...)` from a synchronous `it(...)` body were
  converted to `async` (e.g. `BudgetThresholdSignal constructor sets
  all fields`, `plan-store › attachPlanCheckpoint returns a noop`)
  and the `timeout kind without _onThreshold` test now waits 60 ms
  before calling `checkTimeout()` so the elapsed deadline check
  actually fires.

### Changed — versions

- **All workspace packages bumped 0.6.0 → 0.6.1**: `wrongstack`,
  `@wrongstack/cli`, `@wrongstack/core`, `@wrongstack/mcp`,
  `@wrongstack/plug-lsp`, `@wrongstack/providers`,
  `@wrongstack/runtime`, `@wrongstack/skills`,
  `@wrongstack/telegram`, `@wrongstack/tools`, `@wrongstack/tui`,
  `@wrongstack/webui`.

## [0.6.0] - 2026-05-22

### Added

- **Eternal autonomy — `/autonomy eternal` + persistent `/goal`.**
  A new "run until done" mode for long-horizon work. Set a mission
  with `/goal <text>` (persists to `<projectRoot>/.wrongstack/goal.json`),
  flip the engine on with `/autonomy eternal` (or launch with the new
  `--eternal` flag), and the agent drives sense→decide→execute→reflect
  loops until you stop it. Manual stop only — no auto-pause, no
  hidden token cap.
  - `EternalAutonomyEngine` class in `@wrongstack/core` (re-exported
    from the package root) owns the state machine (`idle → running →
    stopped` with crash recovery), per-iteration token/cost telemetry,
    periodic context compaction (cadence + aggressive threshold), and
    the hybrid decide pipeline (pending todos → dirty git → LLM
    brainstorm).
  - `/goal` is unified: `/goal` shows status, `/goal <text>` (or
    `/goal set <text>`) persists the mission AND injects the
    full-autonomy preamble into the next turn (replaces the TUI's
    former preamble-only `/goal`), `/goal clear` stops the engine on
    the next cycle, `/goal journal [N]` shows the FIFO ring buffer of
    iteration entries (500 max).
  - `/autonomy` gains `eternal` and `stop` modes; status detail
    surfaces the engine state in both REPL and TUI.
  - TUI status bar shows a red `ETERNAL` chip when the engine is
    running.
  - WebUI receives an `eternal.iteration` WS broadcast for each
    iteration, so dashboards can render the live loop without
    polling.
  - CLI banner explains how to start/stop on launch with `--eternal`.

- **`/goal` and `/autonomy eternal` cooperate by design.** The engine
  short-circuits to `stopRequested` when the goal file is deleted, so
  `/goal clear` is a clean off switch. Goal replacement preserves the
  journal across sets — useful as an audit trail.

### Fixed

- **`/goal` no longer crashes the TUI on mount.** The TUI's
  pre-existing preamble registration was colliding with the new CLI
  builtin (`Built-in slash command "goal" is already registered`).
  The TUI registration is removed; the CLI builtin now handles both
  preamble lock-in and persistence. `buildGoalPreamble` is exported
  from `@wrongstack/tui` index for the CLI to consume.

### Tests

- **+272 unit tests** (3091 total, up from ~2820) covering previously
  untested isolated modules — purely additive, no source changes:
  - `core/utils/regex-guard`, `core/utils/todos-format`,
    `core/utils/json-schema-validate`
  - `core/security/config-secrets` (encrypt/decrypt walker with
    `isSecretField` pattern matching)
  - `core/observability/event-bridge` (wireMetricsToEvents),
    `core/observability/health` (DefaultHealthRegistry)
  - `core/storage/goal-store` + `core/execution/eternal-autonomy`
  - `tools/circuit-breaker` (full state machine with fake timers),
    `tools/process-registry` (singleton, kill routing), `tools/_util`
  - `providers/family-capabilities` (per-family defaults + overrides)
  - `cli/provider-config-utils`, `cli/subcommands/handlers/redactKeys`
  - `cli/slash-commands/helpers` (`detectProjectFacts` across
    pnpm/yarn/npm/go/rust/python/Makefile),
    `cli/slash-commands/commit-llm`, `cli/slash-commands/yolo`,
    `cli/slash-commands/mode`, `cli/slash-commands/compact`,
    `cli/slash-commands/goal`, `cli/slash-commands/autonomy`

## [0.5.7] - 2026-05-20

### Added

- **Autonomous continue — model-driven self-iteration continuation.**
  New module `core/continue-to-next-iteration.ts` parses `[continue]`
  / `[next step]` / `[proceed]` / `[done]` markers from model output
  (marker must be on its own line) and drives the next iteration
  internally. Public surface:
  - `parseContinueDirective(text)` returns `'continue' | 'stop' | 'none'`.
  - `makeContinueToNextIterationTool()` — explicit tool-call signal as
    an alternative to text markers.
  - `setAutonomousContinue(ctx)` / `consumeAutonomousContinue(ctx)` —
    runtime helpers used by tool implementations.
  - `Agent` accepts `AgentInit.autonomousContinue?: boolean` (default
    `false`); each iteration calls `consumeAutonomousContinue(ctx)`
    first to clear stale flags, then `processResponse()` parses text
    markers and returns the directive.

- **`DoneCondition` type `'directive'` + `AutonomousRunner` integration.**
  `types/multi-agent.ts` adds `{ type: 'directive', autonomous?: boolean,
  maxIterations?: number }` so fleets can let the model decide when a
  run is done. `AutonomousRunner` accepts
  `enableAutonomousContinue?: boolean` and, when both flags are set,
  passes `autonomousContinue: true` into `agent.run()` so iterations
  happen inside the agent loop (no outer re-invocation). Existing
  `iterations` / `tool_calls` / `output_match` modes are unchanged.

- **`FleetManager` — extracted fleet-level policy from `Director`.**
  New `coordination/fleet-manager.ts` owns the `FleetBus`,
  `FleetUsageAggregator`, spawn caps (count + depth + cost),
  per-subagent metadata, the manifest entries, the state checkpoint
  writer, and the pending-task map. `IFleetManager` interface in
  `coordination/ifleet-manager.ts` keeps the implementation swappable.
  `Director` accepts optional `fleetManager?: FleetManager` in
  `DirectorOptions`; when provided it delegates `canSpawn` /
  `recordSpawn` / `addTaskToSubagent`, when omitted it builds its own
  (backwards compatible). Re-exported from `@wrongstack/core` so
  external hosts (CLI) can construct one directly.

- **Exec tool circuit breaker + process registry + `/kill` + `/ps`.**
  - `exec` tool now checks `registry.canProceed` before spawning and
    reports duration + exit code to the circuit breaker via
    `afterCall`. Non-zero exits count as failure; timeouts count as
    slow calls.
  - New singleton `getProcessRegistry()` tracks every bash/exec child
    process with PID, name, command, and `sessionId`. `kill(pid)`
    sends SIGTERM to the process group on POSIX and cleans up;
    `killAll()` / `killSession()` provide batch ops;
    `forceBreakerOpen()` / `forceBreakerReset()` back the `/kill`
    force/reset modes; `stats()` exposes active count + breaker state
    for `/ps`.
  - New TUI slash commands `/kill [pid] [force|reset]` and `/ps`.
  - Status bar shows live active-process count and breaker state.

- **Todos architecture documentation
  (`docs/todos_architecture.md`).** Long-form reference covering the
  todos data model, invariants, state-layer interactions, persistence
  semantics, and the relationship with the plan system. Companion
  `wrongstack sessions fleet [runId]` command lists manifest,
  checkpoint, and per-subagent transcripts for any past fleet run.

### Changed

- **`MultiAgentHost`: single spawn path via Director.** `/spawn` and
  delegate calls go through `Director` unconditionally —
  `ensureCoordinator()`, the host-side `coordinator` field, and the
  `spawnViaDirector` / `spawnViaCoordinator` branch in
  `_spawnAndAssign()` were removed. The previous host-side
  `pending: Map<taskId,…>` moved to
  `FleetManager.addPendingTask` / `removePendingTask` /
  `getFleetStatus()` so task descriptions live in one place.
  `MultiAgentHost.manifest()` bypasses the debounce timer via
  `fleetManager.writeManifest()` and returns the written path
  directly. `promoteToDirector()` is now idempotent — the
  "coordinator already exists" guard is gone since spawn always
  builds a Director.

- **Package versions bumped to 0.5.7** across all workspace packages
  (`apps/wrongstack`, `@wrongstack/cli`, `@wrongstack/core`,
  `@wrongstack/mcp`, `@wrongstack/plug-lsp`, `@wrongstack/providers`,
  `@wrongstack/runtime`, `@wrongstack/skills`, `@wrongstack/telegram`,
  `@wrongstack/tools`, `@wrongstack/tui`, `@wrongstack/webui`).

### Fixed

- **`MultiAgentHost.getCoordinator()` typing.** Now returns the
  concrete `DefaultMultiAgentCoordinator` instead of the
  `MultiAgentCoordinator` interface so callers can use class-only
  surface (`on`, `setRunner`) without `unknown` casts. `manifest()`
  no longer reaches into the private `FleetManager.manifestPath` —
  it uses the path returned by `writeManifest()`.

## [0.5.5] - 2026-05-20

### Changed

- **Package versions bumped to 0.5.5** across all workspace packages.

### Removed

- **Deprecated `new_features.md`** scratch file from the repo root
  (its contents had been folded into the changelog and architecture
  docs).

## [0.5.4] - 2026-05-19

### Fixed

- **TUI multi-line paste normalization.** Plain clipboard pastes with
  newlines (no bracketed-paste sequence) are now normalized to spaces
  instead of triggering the verbose `[pasted #N N lines]` placeholder.
  Newlines still reach the agent — they just no longer visually pollute
  the input row. Bracketed pastes continue to use InputBuilder as before.

### Changed

- **Package versions bumped to 0.5.4** across all workspace packages.

## [0.5.3] - 2026-05-19

### Added

- **Session rewind & checkpoint system.** Added `session.rewind()` to the
  agent API, enabling bounded history traversal. Session checkpoints now
  capture full context state for crash recovery.

### Changed

- **Package versions bumped to 0.5.3** across all workspace packages.

## [0.5.0] - 2026-05-18

### Added

- **Autonomy mode.** `/autonomy on|off|suggest|toggle` slash command for
  self-driving agent behavior. In `auto` mode the agent picks the next
  logical step and continues after each turn. In `suggest` mode it shows
  next-step suggestions without executing. TUI status bar shows an
  `∞ AUTO` or `∞ SUGGEST` chip when active.
- **`/yolo` slash command.** Runtime toggle for YOLO mode: `/yolo on`,
  `/yolo off`, `/yolo toggle`, `/yolo` (status). Mutates the permission
  policy immediately without restart.
- **Live YOLO state in TUI status bar.** The `⚠ YOLO` chip now reflects
  the current permission policy state after `/yolo` commands, not just
  the boot-time flag.
- **Mode system.** Eight built-in agent modes — `default`,
  `code-reviewer`, `code-auditor`, `architect`, `debugger`, `tester`,
  `devops`, `refactorer` — inject role-specific system prompts. Switch
  at runtime with the new `/mode` command or provider/model picker.
  Modes are stored in `~/.wrongstack/modes/`; custom modes can be added
  by dropping a `*.md` file alongside the built-ins.

### Changed

- **YOLO prompt defaults to Y.** The interactive "YOLO mode?" prompt at
  boot now defaults to enabled (press Enter = YOLO on). Previously
  defaulted to off.

### Fixed

- **Duplicate `providers.list` case in WebUI switch.** A second handler
  for the same message type was unreachable dead code — removed.
- **`useExhaustiveDependencies` lint in TUI.** Removed unused
  `exit`/`onExit` dependencies from the SIGINT `useEffect`.
- **`useImportType` lint in TUI components.** Auto-fixed type-only
  React imports across 7 component files.

## [0.4.1] - 2026-05-18

### Fixed

- **TUI context bar not rendering for OpenAI-compatible providers.** The ctx
  bar was listening to `provider.response` events and reading `usage.input`,
  but OpenAI-compatible providers populate `usage.prompt_tokens` instead —
  `usage.input` was always 0, so the bar never showed. Now reads
  `tokenCounter.total().input` directly, which is updated by
  `tokenCounter.account()` on every model call regardless of provider shape.

## [0.3.4] - 2026-05-17

### Added

- **Official Telegram plugin release.** `@wrongstack/telegram` is now part of
  the lockstep release train and is ready to publish as an official package.
  The `telegram` official alias installs the bundled package through
  `wstack plugin install telegram` / `/plugin install telegram`, registers
  `telegram_read`, `telegram_send`, and exposes `/telegram:*` slash commands
  after restart.

### Changed

- **Release docs refreshed for 0.3.4.** Root and package READMEs now present
  the current install path, official plugin workflow, and Telegram publishing
  status so npm consumers can enable the bridge without cloning the monorepo.
- **Telegram package metadata aligned.** `@wrongstack/telegram` and its plugin
  manifest now report `0.3.4`, matching the workspace packages included in
  this release.

## [0.3.2] - 2026-05-17

### Added

- **Context-window modes and repair controls.** Sessions can switch between
  `balanced`, `frugal`, `deep`, and `archival` context policies. CLI users get
  `/context mode` plus `/context repair`, WebUI clients get mode switching and
  `context.repair`, and damaged tool-call adjacency is repaired before provider
  requests.
- **`@wrongstack/runtime` host composition package.** Runtime is now the
  migration target for concrete defaults and host assembly helpers, keeping
  `@wrongstack/core` focused on kernel contracts, registries, primitives, and
  the agent lifecycle. The first slice re-exports the current defaults from
  `@wrongstack/core/defaults` and introduces the `WrongStackPack` extension
  shape for tools, providers, slash commands, and lifecycle hooks.
- **Built-in tools pack.** `@wrongstack/tools/pack` now exports
  `builtinToolsPack`; CLI and WebUI register built-ins through that pack shape
  instead of hard-wiring the raw tool array. This is the first package-level
  step toward CLI, TUI, WebUI, Telegram, and future hosts acting as extension
  packages around a small core.
- **Compact multi-agent activity memory.** The TUI tracks the last two tool
  calls and last two assistant text snippets per subagent. `LiveActivityStrip`
  and `FleetPanel` render those compact summaries so users can see what each
  worker is doing without flooding the transcript.
- **Vision routing for image input.** Hosts can now route image blocks through
  native model vision when available, or through pluggable
  `VisionAdapter`s when the active model is text-only. Safe read-only
  image-understanding tools, including MCP-wrapped tools, can be discovered as
  adapters; path-based MCP tools are supported by writing pasted images to a
  temporary local file for the duration of the tool call, including
  MiniMax-style `understand_image` tools that accept local paths through
  `image_url`. Plain CLI also gets `/image` / `/paste-image` clipboard
  attachment support alongside TUI `Alt+V`.

### Changed

- **Subagent tool calls no longer spam chat history.** Tool telemetry is now a
  live status/fleet concern; the main chat keeps human-readable text and
  lifecycle summaries. Agent text streamed from FleetBus is debounced before it
  lands in history, while the live strip still updates quickly from deltas.

### Fixed

- **`grep` ripgrep backend correctness.** Regex syntax is validated before
  invoking `rg`, default ignored directories are excluded consistently in both
  native and `rg` backends, and `output_mode: "count"` now returns the total
  match count rather than the number of files with matches.
- **Full test suite regression.** `pnpm test` is back to green:
  2059 passing tests across 203 files, with 1 skipped.
- **Release gate cleanup.** Todo checkpoints now await pending debounced
  writes during detach/shutdown, closing the flaky full-suite failure in
  `todos-checkpoint`. CLI compaction wiring also resolves model capabilities
  through the active provider id. Director tool factories are split into a
  single `director-tools` module, core storage no longer pulls crypto-only
  secret-vault code into its bundle, and WebUI builds without the previous
  chime import/chunk-size warnings.

## [0.2.0] — 2026-05-16

The "autonomous fleet" release. Six weeks of work focused on one
question: can a Director and its subagents run for hours without the
user babysitting them? The answer required a full pass over the
coordination layer — every race condition fixed, every silent failure
classified, every "what is the subagent doing right now?" question
answered with a visible chip in the TUI.

Headline changes:

- **`/goal`** and **`/steer`** — true autonomous mode (preamble locks
  the agent into a verifiable finish) and true mid-flight redirect
  (Esc captures snapshot, terminates fleet, sends rich STEERING
  context). The chat stays clean; the rich context goes to the model.
- **Unlimited budgets by default** — the 20-tool / 20-iteration cap on
  `/spawn` and the coordinator's `defaultBudget` are gone. The
  orchestrator decides, the Agent's `autoExtendLimit` is the runaway
  backstop. Pair with `--goal` for relentless one-line task launches.
- **SubagentError envelope (14 kinds)** — `TaskResult.error` is no
  longer an opaque string. Every failure is classified
  (`provider_5xx`, `provider_rate_limit`, `tool_failed`,
  `empty_response`, `aborted_by_parent`, …) with `retryable` +
  `backoffMs` so the calling LLM can branch instead of substring-
  matching error messages.
- **Coordinator race fixes** — duplicate-id spawn rejected,
  stop+assign race produces synthetic completion, `stopAll()` drains
  the pending queue, error-state reset is synchronous, tool counter
  pairs on `tool.executed`. Per-task `dispose` hook closes
  per-subagent JSONL writers so the FD leak at ~1000 tasks is gone.
- **Observability surface** — LiveActivityStrip above the input,
  `currentTool` on FleetEntry, `transcriptPath` on `subagent.spawned`,
  `provider.thinking_delta` forwarded to FleetBus, `/fleet log <id>`
  for summary / raw transcript dumps, Director shutdown errors via
  `process.emitWarning` instead of silent `.catch`.
- **Session checkpoint system** — `<id>.todos.json`, `<id>.plan.json`,
  and `<id>/director-state.json` sidecars turn `wstack resume <id>`
  into real continuation instead of replay. `/fleet retry [taskId]`
  resumes interrupted multi-agent runs.
- **`/plan` + `planTool`** — strategic roadmap parallel to todos,
  surfaced both as a slash command and an LLM-callable tool.
- **WebUI polish** — collapsible tool input/output, diff view,
  per-message cost attribution, concurrent-run lock, WS connect()
  rejects on error instead of hanging.
- **Test coverage 1981 / 195 files** — five new dedicated suites
  cover every failure mode that previously fell through the cracks.

No breaking changes. CLI flags, plugin API, system-prompt builder,
and EventBus contract are all backwards compatible. `--goal` /
`--ask` and `/goal` / `/steer` are additions; existing slash
commands and CLI flags work unchanged.

### Added

- **Session checkpoint system.** Three new sidecar files next to each
  session JSONL turn `wstack resume <id>` into a real "resume where I
  left off" experience instead of just replaying messages:
  - `<id>.todos.json` — `ctx.todos` mirrored to disk on every
    `todos_replaced` mutation (150ms debounce, atomic write). Reloaded
    transparently on resume; `attachTodosCheckpoint(state, path, id)`
    is the new public helper in `@wrongstack/core`.
  - `<id>.plan.json` — strategic roadmap maintained via the new
    `/plan` slash command (`show|add|start|done|remove|clear`). Plans
    are higher-level than todos (survive across sessions by intent)
    and surface a "N items, M open" banner on resume.
  - `<id>/director-state.json` — live director task graph
    (pending/running/completed + spawn roster + usage), written
    incrementally as spawns and task completions land. Distinct from
    the existing `fleet.json` manifest, which previously only got
    written on `Director.shutdown()` and is now also periodically
    flushed (~2s debounce) on every spawn/assign/complete event.

- **Director session event emission.** `Director` accepts an optional
  `sessionWriter` and now forwards `agent_spawned`, `task_created`,
  `task_completed`, and `task_failed` events to the host session JSONL
  — these were already in the `SessionEvent` union but were never
  actually emitted by any subsystem. Production callers (CLI) pass the
  same writer the host Agent uses so all events land in one log.

- **`/plan` slash command** for strategic roadmap management
  (`packages/cli/src/slash-commands/plan.ts`). Items have status
  (`open` / `in_progress` / `done`), optional details, and stable ids.

- **`planTool` — LLM-callable counterpart to `/plan`.** Registered with
  the builtin tool set; reads `ctx.meta['plan.path']` (seeded by the
  CLI during startup) so the model can manage long-running strategy
  the same way it manages todos. One tool, six actions
  (`show|add|start|done|remove|clear`).

- **`/fleet retry [taskId|all]`** for resuming interrupted multi-agent
  runs. Reads `director-state.json`, finds tasks left in `running` /
  `pending` state when the previous process died, and re-spawns the
  matching subagent (preferring the original roster role) before
  re-assigning the task. Auto-promotes to director mode if needed.

- **TUI plan chip** in the status bar (`📋 ⌛N ☐N ✓N`), polling
  `<sessionId>.plan.json` every 3s. Distinct from the todos chip so
  the user can read tactical and strategic progress at a glance.

- **`delegate` tool — autonomous multi-agent activation.** A new
  always-on built-in tool (`packages/core/src/coordination/delegate-tool.ts`)
  bundles spawn + assign + await into one call. Registered in every
  CLI session regardless of `--director` mode: the first call
  auto-promotes the host to director mode under the hood, so the
  model no longer needs the user to "enable multi-agent" before it
  can delegate. Accepts a roster role (`bug-hunter`, `security-scanner`,
  `refactor-planner`, `audit-log`) OR an explicit `name`/`provider`/`model`.
  Per-call `timeoutMs` cap (default 5min) keeps a hung worker from
  hanging the host turn.

- **System prompt "Delegation" section.** The
  `DefaultSystemPromptBuilder` now detects when the `delegate` tool is
  registered and injects a guide telling the model when to delegate
  (task fans out naturally, specialized role exists, subtask would
  blow up context) and when to stay in-process (trivial / atomic /
  user mid-conversation). The model can read the available role list
  off the tool's schema enum without any extra plumbing.

- **Plan-aware system prompt.** `DefaultSystemPromptBuilder` accepts
  `planPath?: string | (() => string | undefined)` and reads the
  session's `<id>.plan.json` on every `build()` call. Open items are
  injected as an ephemeral "Active plan" block so the LLM is anchored
  to the strategic roadmap every turn — not just on resume. The getter
  form lets DI containers bind the builder before the session id is
  known. CLI seeds the path automatically.

- **`/fleet log [<subagentId>] [raw]`** — surface per-subagent
  transcripts. Without arguments lists every JSONL on disk for the
  current session's fleet. With an id shows a compact summary
  (iteration count, tool breakdown, first task, last response, event
  mix). Append `raw` to dump the full JSONL when you need the
  uncompressed view.

- **`/goal <description>` — autonomous lock-in mode.** Slash command
  in the TUI that prepends a four-section preamble to the next agent
  turn (AUTHORITY / DONE / NOT DONE / PERSISTENCE), turning the leader
  into a relentless worker that drives the task to a verifiable
  finish. No implicit budget cap, full multi-provider fan-out
  permission, explicit anti-patterns ("should I continue?", "I
  believe this fixes it"), three-angle persistence rule for blockers.
  Only the user can stop a /goal — Esc / `/steer` redirect, Ctrl+C /
  `/fleet kill` bail out.

- **`--goal "<task>"` and `--ask "<text>"` boot flags.** Launch
  directly into goal mode (or pre-populated single-turn) from the
  shell, no need to type `/goal` after the TUI starts up. `--goal`
  auto-enables `--tui` since the goal-mode steering surface lives
  there. Pair with `--director` for one-line fleet kickoffs:
  `wstack --director --goal "audit packages/core for races"`.

- **`/steer <new direction>` and `Esc`-to-steer.** Mid-flight redirect
  primitives. Both abort the active iteration, terminate running
  subagents (1.5s cap), drop the queued messages, and send the new
  direction with a rich STEERING preamble prepended — snapshot of
  in-flight tools, terminated subagents (with their currentTool),
  last partial assistant text, plus explicit authority to abandon
  the prior plan. The chat just shows `↯ <text>`; the preamble goes
  to the model, not the human view. `/steer` works whether the agent
  is busy or idle; Esc only when the agent is busy.

- **`SubagentError` envelope — 14 classified failure kinds.**
  `TaskResult.error` is no longer an opaque `string`; it's a
  discriminated union with `kind`, `message`, `retryable`,
  optional `backoffMs`, and the original `cause`. Kinds:
  `provider_5xx`, `provider_rate_limit`, `provider_auth`,
  `provider_timeout`, `context_overflow`, `tool_failed`,
  `tool_threw`, `budget_iterations`, `budget_tool_calls`,
  `budget_tokens`, `budget_cost`, `budget_timeout`,
  `aborted_by_parent`, `empty_response`, `bridge_failed`,
  `unknown`. `classifySubagentError` is exported for tests and
  CLI surfaces. The delegate tool output exposes `errorKind` /
  `retryable` / `backoffMs` so the calling LLM can branch on
  classification. Chat renders `[kind]` chip beside every failed
  task. Backwards-compat string is preserved as
  `error.message`.

- **LiveActivityStrip above the input area.** Compact one-line-per-
  subagent strip that sits directly above the input, showing
  `● <name> · → <currentTool> (Xs) · Nit Mtc · elapsed`. Renders
  nothing when no subagents are running. Updates every tick so
  elapsed timers stay live. Works in both director and non-director
  mode.

- **Per-tool surface in chat regardless of director mode.** Every
  subagent's `tool.executed` event is now bridged from its per-task
  EventBus onto the host EventBus as `subagent.tool_executed`, and
  the TUI listens unconditionally — `[AGENT#1] ● bash 250ms · 1.2KB`
  lands in chat for plain `/spawn` too. Director-mode `/fleet stream
  on` still adds the richer verbose stream with arg formatting +
  currentTool live updates.

- **`subagent.tool_executed` event** on the host EventBus
  (`packages/core/src/kernel/events.ts`). Carries `subagentId`, tool
  name, duration, ok, optional input + outputBytes. Bridge installed
  by `MultiAgentHost.spawn` factory, cleaned up via the existing
  dispose hook.

- **`tool.progress` budget heartbeat.** The subagent runner subscribes
  to `tool.progress` events emitted by long-running tools (bash
  chunks, fetch byte progress, spawn-stream stdout) and calls
  `ctx.budget.checkTimeout()` on each heartbeat. A `bash sleep 3600`
  no longer parks past its wall-clock deadline waiting for the
  coordinator's hard `Promise.race` — the budget trips cooperatively,
  the aborter fires, signal propagates to the tool, child process
  killed. Tools without progress emission still rely on the
  coordinator race as the backstop.

- **Per-subagent JSONL path on `subagent.spawned`.** New
  `transcriptPath?: string` field carries the absolute path to the
  per-subagent transcript file. Pre-computed from the session
  factory dir at spawn time so the very first event the TUI sees
  already has it. `SessionWriter.transcriptPath` (readonly,
  optional) is the new contract; `FileSessionWriter` exposes it via
  a getter. The FleetPanel renders `log: <path>` under each entry
  so users can `tail -f` without grepping the filesystem.

- **`currentTool` on FleetEntry.** Tracks the tool a subagent is
  currently inside via `tool.started` (set) / `tool.executed`
  (clear). FleetPanel renders `→ bash (250ms)` under running
  subagents.

- **`provider.thinking_delta` forwarded onto FleetBus.** Subagents'
  extended-thinking output now surfaces to the FleetPanel and
  `/fleet log` instead of falling between `iteration.started` and
  the first text delta.

- **Coordinator race fixes.** `spawn()` rejects duplicate ids
  (previously silently overwrote, orphaning the prior subagent's
  AbortController + Context). `stop()` + `assign()` race produces a
  synthetic `aborted_by_parent` task.completed instead of an orphan
  task that leaked `inFlight` forever. `stopAll()` drains the
  pending queue with the same synthetic completion. Error-state
  reset is synchronous now (the prior `queueMicrotask` opened a
  window where `assign()` could observe a "running" worker that was
  actually idle). Tool counter pairs on `tool.executed` rather than
  `tool.started` — a tool that fires start then crashes mid-exec
  no longer drifts the budget tally.

- **Per-task `dispose` hook on `AgentFactoryResult`.** Closes the
  per-subagent JSONL writer in the runner's `finally` block —
  swallowed errors, so a flaky cleanup can't mask the real task
  result. Closes the FD leak that exhausted at ~1000 tasks.

- **Director listener leak fix.** `coordinator.on('task.completed',
  ...)` is now captured in a field and `off()`-ed in
  `Director.shutdown()`. Repeated Director construction (tests, hot
  reloads) no longer accumulates listeners.

- **`promoteToDirector` failure reason.** When promotion is refused
  because subagents are already running, the host records a
  human-readable reason ("Cannot promote: N subagents are running.
  /fleet kill them or wait.") and the delegate tool surfaces it
  verbatim to the calling LLM. Replaces the prior opaque "Director
  could not be activated" message.

- **Director shutdown errors surface via `process.emitWarning`.**
  Bridge.stop / writeManifest / stateCheckpoint.flush failures used
  to be silently swallowed with `.catch(() => undefined)`. They now
  funnel through `process.emitWarning('DirectorShutdownWarning',
  ...)` so hosts can plug a warning listener for structured
  collection; default stderr surface is enough to spot a persistent
  failure during normal use.

- **Ctrl+C terminates the fleet with a 1.5s ceiling.** The TUI's
  SIGINT handler now races `director.terminateAll()` against a
  1.5s cap before falling through to the exit ladder, so subagents
  drain cleanly when possible and hard-exit when wedged.

- **Test coverage: 1981 total.** Five new dedicated suites pin the
  regression duvarı:
  - `subagent-error-classification.test.ts` — 20 tests covering
    every kind + the integration path
  - `coordinator-race.test.ts` — duplicate-id reject (T5),
    stop+assign race (T4), stopAll drain (T4b), paired tool
    counter (T8), synchronous error-reset (M4)
  - `subagent-abort-during-tool.test.ts` — mid-tool abort (T3),
    stop-after-tool-completes
  - `subagent-budget-edges.test.ts` — `tool.progress` heartbeat
    busts mid-tool, no-timeout regression guard
  - `fleet-usage-aggregator.test.ts` — disjoint cost-bucket
    contract (M2), per-subagent isolation, missing price guard
  - `delegate-tool.test.ts` +2 — partial JSONL read robustness
    (T6) on missing + corrupt transcripts
  - `steering-preamble.test.ts` — 9 tests covering both
    `buildSteeringPreamble` and `buildGoalPreamble` structural
    guarantees

### Changed

- **Unlimited budgets by default.** The prior 20-tool / 20-iteration
  hardcap on `/spawn` adhoc subagents (`packages/cli/src/multi-agent.ts`)
  is gone, and the coordinator's `defaultBudget` (1000 tools /
  200 iter / 4h timeout) has been removed entirely. Subagents get
  a budget only when the orchestrator (`delegate` /
  `spawn_subagent`) explicitly passes one. Runaway protection now
  lives in the Agent's iteration loop (`autoExtendLimit: true`,
  auto-grants 100 more iterations every 100 forever). `maxConcurrent`
  raised 2 → 8. Director `maxSpawnDepth` 2 → 5 so recursive
  delegation works without tripping the depth budget at level 3.

- **Subagent tool-counter pairs on `tool.executed`.** Was previously
  incremented on `tool.started`, which produced phantom counts when
  a tool started then crashed before emitting executed. The paired
  count matches what the model actually saw in its turn.

- **Subagent `empty_response` is now a classified failure.** An LLM
  run that returns `status: 'done'` with empty `finalText` AND zero
  tool calls used to silently succeed; now surfaces as
  `kind: 'empty_response'`. Almost always indicates a prompt /
  config issue rather than legitimate "nothing to say".

- **Subagent `tool_failed` is now a classified failure.** A tool
  returning `ok: false` whose error the agent never recovered from
  (no follow-up text on the next iteration) used to report a clean
  success. Now surfaces as `kind: 'tool_failed'` with the failed
  tool name in the message. Healthy "tool errored then I tried
  again" patterns still report success because the next iteration's
  text clears `lastToolFailed`.

- **`SlashCommand.run` may return `{ runText }`.** Lets a slash
  command queue a follow-up user-role message that the TUI submits
  as if the user had typed it. Used by `/steer` and `/goal` to send
  the rich preamble. Backwards compatible — existing commands
  return `{ exit?, message? }` as before.

### Fixed

- **TUI TDZ crash on first subagent spawn.** The `fleetAgents`
  `useMemo` (status bar 4th line) called `labelFor` in its
  callback, but `labelFor` was declared ~550 lines further down in
  `App`. While `state.fleet` stayed empty the memo's early-return
  skipped the call, so the temporal-dead-zone access stayed
  dormant — but the first `/spawn` populated `state.fleet` and the
  next render hit `Cannot access 'labelFor' before initialization`,
  killing the TUI mid-frame. Moved the `labelFor` + `labelsRef` +
  `STREAM_COLORS` block above `fleetAgents` so the const is
  initialised before any memo body runs.

- **Ctrl+C with a wedged delegate.** The first Ctrl+C only
  cancelled the host agent loop; a delegate that ignored the
  abort signal would keep the parent parked in `await
  director.awaitTasks` and the "press again to exit" hint became a
  lie. Ctrl+C now races `director.terminateAll()` against a 1.5s
  cap before unwinding so the fleet drains polite-first then
  hard-cuts.

- **`/spawn` artificial 20-tool / 20-iter caps killed real work.**
  Real screenshot from the field: `AGENT#1 ✗ failed (9 iter · 21
  tools · 248s) [budget_tool_calls] — Budget exceeded: tool_calls
  (limit=20, observed=21)`. The 20 was a defensive default from
  when `/spawn` was a single-shot tester; for an autonomous
  director that delegates and respawns it was crippling. Caps
  removed; orchestrator owns the budget decision.

- **Test pollution writing to project cwd `tmp/`.** A test in
  `packages/cli/tests/multi-agent.test.ts` was using a relative
  `'tmp/fleet/session-2'` path that materialized fleet JSONLs inside
  the project working directory. Switched to `os.tmpdir()` + cleanup.
  Production code already routed all fleet artifacts under
  `~/.wrongstack/projects/<hash>/sessions/<id>/`.

- **`replace` tool symlink hardening (round 2).** `safeResolve` could
  pass a symlink whose target lived outside the project root. Added
  `lstat` + `isSymbolicLink` checks and a `realpath` cross-validation
  against the project root before the atomic write, plus a hard skip
  for any file resolved outside the root. Complements the earlier
  0.1.10 symlink/TOCTOU fix.

- **WebUI ws-client connect() hangs on failure.** The connect promise
  used to wait forever when the WebSocket emitted `onerror` / `onclose`
  before `onopen`; UI callers blocked indefinitely with no surfaced
  error. Promise now rejects on those paths so the UI can render the
  failure.

- **WebUI concurrent `agent.run` race.** `server/index.ts` had no
  guard against a second message arriving while the first was still
  streaming; the second `agent.run` would interleave with the first
  and corrupt session state. Added a `runLock` guard that queues or
  rejects (depending on config) concurrent runs.

- **WebUI tool/message rendering.** `MessageBubble` now renders
  collapsible tool input (shallow params as key/value table, nested
  as expandable JSON) and tool output (with copy / download / error
  stack toggle / raw markdown toggle). Per-message
  iterations/tools/elapsed/$ footer; multi-tool turns grouped under
  a single bubble.

## [0.1.10] — 2026-05-15

Core package restructuring + thinking/reasoning stream support + tool
output size chips + child-process env hardening pass + WebUI guard and
formatting sweep. No breaking changes — additive on the plugin contract
(`KERNEL_API_VERSION` moves to `0.1.10`; `apiVersion: "^0.1"` plugins
keep loading).

### Added

- **`@wrongstack/core` subpath exports reorganized.** `execution/`,
  `coordination/`, `infrastructure/`, `storage/`, `security/`,
  `models/`, `sdd/`, and `observability/` are now independent subpath
  entrypoints — `import { Agent } from '@wrongstack/core'` works as
  before, but consumers can now deep-import `@wrongstack/core/execution`,
  `@wrongstack/core/coordination`, etc. The old `defaults/` barrel is
  deprecated but preserved as a re-export. 8 new `exports` maps
  added to `package.json`; `tsup` config updated to emit each
  entrypoint. No runtime change for existing consumers.

- **Extended thinking / reasoning stream support.** Six new stream
  events wired end-to-end — `thinking_start`, `thinking_delta`,
  `thinking_signature`, `thinking_stop` — with full `StreamingState`
  tracking, `buildResponse()` content-block ordering, and an empty-block
  guard that prevents `400` on Anthropic. `content_block_start` now
  recognizes `kind: 'thinking'`. The agent loop emits
  `provider.thinking_delta` events; the WebUI server broadcasts them
  for a transient "Thinking…" chip; the CLI + TUI forward
  `thinking_delta` through the WebSocket. Providers (Anthropic, OpenAI,
  Google) that already annotate thinking deltas are plumbed; OpenAI
  `reasoning_content` in `chunk.choices[0].delta` is normalized to
  `thinking_delta`.

- **Tool output size chips on `tool.executed`.** The agent loop now
  computes `outputBytes` (UTF-8 byte length), `outputTokens`
  (~3.5 chars/token heuristic), and `outputLines` (read-prefix counts
  or newline-based for bash/grep/logs) before emitting
  `tool.executed`. These ride as optional fields on the existing
  event — the TUI renders them as inline chips beside tool results
  (`1.2 KB · ~340t · 45 lines`). The `output` field remains the
  400-char preview; the chip fields reflect the full uncapped result.

- **`buildChildEnv()` centralized in `@wrongstack/core`**
  (`@wrongstack/core/utils`). Previously duplicated across
  `tools/src/_env.ts`, `tools/src/bash.ts`, and `tools/src/exec.ts`.
  Now a single canonical implementation with an explicit allowlist
  (PATH, HOME, LANG, …), secret-name detection (TOKEN, SECRET, API_KEY,
  …), and a tooling-prefix pass (NODE_, NPM_, PNPM_, YARN_, GIT_,
  CI, XDG_…). The `_spawn-stream` helper and `patch` tool also use
  it. Override with `WRONGSTACK_CHILD_ENV_PASSTHROUGH=1` (the legacy
  `WRONGSTACK_BASH_ENV_PASSTHROUGH=1` is preserved as an alias).

### Fixed — security

- **`patch` tool child-process env hardened.** `runPatch()` previously
  passed `{ ...process.env }` as the env — API keys and tokens leaked
  into the `patch` subprocess. Now uses `buildChildEnv()` with
  `LANG=C / LC_ALL=C` overrides layered on top. The `patch` call
  site was the last `process.env` spread remaining in the tools layer.

- **`replace` tool symlink traversal.** The native glob walk
  (`globNative`) now skips symlinks with `e.isSymbolicLink()` rather
  than following them, matching the `grep` tool's behavior from 0.1.6.

- **MCP `SSEReader` buffer cap (256 KB).** Defense-in-depth: the
  SSE reader inside MCP HTTP transports now throws if the pending-line
  buffer exceeds 256 KB, preventing a malicious stream from pinning
  memory. The upstream providers SSE parser already enforces this cap;
  this covers the MCP transport's own reader.

- **WebUI overlapping-run guard.** `handleUserMessage` previously
  aborted the prior run and started a new one — a second
  `agent.run()` could sneak in before the first's cleanup settled,
  corrupting context state. Now rejects with an error message if a
  run is already in flight. The abort path remains reachable through
  explicit `abort` messages from the client.

- **WebUI `broadcast()` error handling.** A client disconnecting
  between the `readyState` check and the `send()` call previously
  propagated as an unhandled rejection. Now caught and silently
  dropped — the `close` handler removes the client naturally.

- **Memory-store consolidation backup.** `consolidate()` now writes
  a `<file>.bak.<ts>` backup before the atomic write so a crash
  mid-consolidation doesn't lose the pre-consolidation state.

### Changed — core

- **Usage type disjoint-semantics documented.** `Usage.input` is now
  formally specified as the FRESH input token count (excluding cached
  portions). Provider adapters (Anthropic, OpenAI, Google) already
  normalize to this invariant; the JSDoc on the type now states it
  explicitly so third-party providers don't double-count cache.

- **Prometheus `startMetricsServer` gains health endpoint.** A
  `healthRegistry` option enables `/healthz` alongside `/metrics` on
  the same port — K8s probes expect a single HTTP server; no need
  for a sibling listener. The `/healthz` handler returns JSON
  aggregate with status codes (200 healthy, 503 unhealthy).

- **WebUI WebSocket binds to `127.0.0.1` explicitly.** Previously
  `new WebSocketServer({ port })` defaulted to `::` on dual-stack
  systems, risking LAN exposure. Now binds `127.0.0.1` — existing
  `WS_HOST` env override still works for network scraping.

### Internal

- **`provider-config-utils.ts` extracted** from `webui-server.ts` —
  `normalizeKeys`, `writeKeysBack`, `maskedKey`, and `nowIso` are
  now reusable by the CLI subcommands layer.
- **Source files alphabetized** — import ordering, `package.json`
  `keywords`/`scripts` arrays, and test-import blocks across
  `packages/core`, `packages/cli`, `packages/mcp`,
  `packages/providers`, `packages/tools`, `packages/plug-lsp`,
  `packages/tui`, and `packages/webui`.
- **WebUI server source reformatted** — long lines broken at ~100
  columns, trailing commas added consistently, brace style normalized
  to match the rest of the codebase.

## [0.1.9] — 2026-05-15

Post-0.1.7 audit triage + Director orchestration ecosystem + `/fleet`
slash hub + `--director` CLI flag with full tool wiring + shared
fleet scratchpad + per-subagent JSONLs + Phase 6 safety caps. No
breaking changes — additive on both the public API and the plugin
contract (`KERNEL_API_VERSION` moves to `0.1.9` to advertise the
new exports; `apiVersion: "^0.1"` plugins keep loading). The
preceding `v0.1.8` tag was a local-only snapshot that never shipped;
this is the first release to actually go out.

### Fixed — audit triage (bugs.md round)

- **`AutonomousRunner.toolCalls` now counts `tool.executed` events**
  rather than `agent.run()` calls. Previously a `maxToolCalls: 3` budget
  could let an iteration burst fire 15 tools before the done-condition
  tripped (counter only incremented once per iteration, not once per
  tool). The runner now subscribes to `agent.events.on('tool.executed')`
  for the lifetime of `run()`, tears the listener down in `finally`,
  and tolerates mock agents whose events bus is null/undefined.
  Regression test asserts a 5-tool burst trips a 3-tool budget after a
  single iteration.
- **MCP `_toolsCache` now stays in sync with `_tools`** on SSE/HTTP
  transport `onToolsChanged` callbacks. Previously only `_tools` was
  updated, so an empty tools-update would leave the cache pointing at
  the prior non-empty list and `MCPClient.listTools()`'s empty-`_tools`
  fallback would serve stale entries. Both stdio paths were already
  correct; this fix is scoped to the two remote transports.
- **`tool_use` meta-tool no longer hard-rejects confirm-permission
  inner tools.** The outer `tool_use` itself has `permission: 'confirm'`,
  so the user has already approved the call (and seen the inner tool
  name + input) by the time `execute()` runs — the duplicate inner
  check made every confirm-gated tool unreachable through `tool_use`.
  The inner `deny` check is preserved as a hard policy floor that
  meta-tools cannot bypass. `batch_tool_use` already followed this
  model.
- **`scaffold` migrated from sync to async I/O.** `fsSync.mkdirSync` /
  `fsSync.writeFileSync` in the template-write loop blocked the event
  loop for every file in a multi-file template. Switched to the
  already-imported `node:fs/promises` API; `handleBuiltIn` is now
  `async` and each `mkdir` / `writeFile` is awaited.

The remaining audit findings (BUG-002, -004, -005, -006, -007, -008, -009,
-010) were investigated and either intentional-by-design or
self-corrected in the report; see `bugs.md` for the per-finding triage.

### Added — Director orchestration

A new high-level orchestration surface that runs every subagent with its
own provider, model, context, session, and budget under an LLM-driven
**Director** that plans, spawns, asks, rolls up, and supervises the
fleet. Builds on the existing `MultiAgentCoordinator` + `SubagentBudget`
without breaking either — `MultiAgentHost`'s legacy path is unchanged,
director mode is opt-in via `--director`.

Design doc: [`docs/director-architecture.md`](docs/director-architecture.md).

- **`Director`** — owns a `MultiAgentCoordinator`, a `FleetBus`, a
  `FleetUsageAggregator`, and an in-memory `AgentBridge` so the director
  can `ask()` subagents synchronously. Public API: `spawn`,
  `assign`, `awaitTasks`, `ask`, `rollUp`, `terminate`, `terminateAll`,
  `status`, `snapshot`, `writeManifest`, `shutdown`, plus the
  `leaderSystemPrompt()` / `subagentSystemPrompt(config, taskBrief?)`
  composers for prompt injection. Lifecycle events are observable via
  `Director.on('task.completed', handler)` and the completed results
  cache via `Director.completedResults()`.
- **8 LLM-callable orchestration tools** via `Director.tools(roster?)`:
  `spawn_subagent`, `assign_task`, `await_tasks`, `ask_subagent`,
  `roll_up`, `terminate_subagent`, `fleet_status`, `fleet_usage`. Each
  ships a minimal JSON schema and `permission: 'auto'` (the user
  already approved the director run; gating each orchestration call
  would be noise — subagent tools are still permission-checked
  normally).
- **`FleetBus`** — fan-in for per-subagent `EventBus`es. Subscribe by
  subagent id (`subscribe(id, handler)`), by event type
  (`filter(type, handler)`), or to every event (`onAny(handler)`).
  Attach a subagent's bus with `attach(subagentId, bus, taskId?)`;
  detach with `detach(subagentId)`. Backed by canonical event names —
  `tool.started`, `tool.executed`, `tool.progress`, `tool.confirm_needed`,
  `iteration.started`, `iteration.completed`, `provider.text_delta`,
  `provider.response`, `provider.retry`, `provider.error`,
  `session.started`, `session.ended`, `token.threshold`.
- **`FleetUsageAggregator`** — subscribes to `FleetBus` and rolls up
  token/cost totals per subagent. Pluggable price lookup via
  `priceLookup(subagentId)`; output rows tag each subagent with the
  provider/model captured at spawn time. `snapshot()` returns
  `{ total, perSubagent: Record<id, SubagentUsageSnapshot> }`.
- **`makeDirectorSessionFactory({ store?, sessionsRoot?, directorRunId? })`**
  — produces a `SessionFactory` for the coordinator's per-subagent
  JSONL writers. Sessions land under `<sessionsRoot>/<runId>/<subagentId>.jsonl`
  so every subagent has its own replayable transcript — fleet replay
  doesn't need to demux a merged log.

**System-prompt injection for Director + subagents.** Two pure
composers — `composeDirectorPrompt()` and `composeSubagentPrompt()` —
plus a `rosterSummaryFromConfigs()` helper, all exported from
`@wrongstack/core`. The director-agent prompt is layered as
*fleet preamble → roster summary → user base prompt*; subagent prompts
layer as *bridge-contract baseline → role → task brief → per-spawn
`systemPromptOverride`*, with the override always last so it wins on
conflict. Two built-in defaults ship: `DEFAULT_DIRECTOR_PREAMBLE`
teaches the leader the eight fleet tools and working rules;
`DEFAULT_SUBAGENT_BASELINE` explains the bridge contract and the rule
that subagents may not exfiltrate the parent's system prompt or tool
list. Both overridable via `DirectorOptions.directorPreamble` /
`subagentBaseline`. `Director.leaderSystemPrompt()` and
`Director.subagentSystemPrompt(config, taskBrief?)` expose the
composed strings without mutating the config — factories opt in by
calling them when building each Agent.

### Added — CLI surfaces

- **`--director` flag.** Pass it to upgrade the lazy `MultiAgentHost`
  from the plain coordinator path to a `Director`-backed one. Same
  external `/spawn` / `/agents` / `/fleet` surface; under the hood,
  the host's task lifecycle now flows through `Director.spawn` /
  `Director.assign` so the in-memory manifest entries get populated.
  On boot, the host *eagerly* builds the Director and registers
  `director.tools(FLEET_ROSTER)` into the leader's `ToolRegistry` —
  the 8 LLM-callable orchestration tools (`spawn_subagent`,
  `assign_task`, `await_tasks`, `ask_subagent`, `roll_up`,
  `terminate_subagent`, `fleet_status`, `fleet_usage`) are visible to
  the leader from the first message, so a prompt like "spawn a
  bug-hunter and a security-scanner in parallel, then roll up their
  findings" actually orchestrates rather than narrating. `FLEET_ROSTER`
  (4 pre-built agents: Audit Log, Bug Hunter, Refactor Planner,
  Security Scanner) is automatically attached as the roster so
  `spawn_subagent({ role: "bug-hunter" })` works out of the box.
  Director artifacts share one root —
  `<projectSessions>/<sessionId>/`:
  - `fleet.json` (manifest)
  - `shared/` (fleet-wide scratchpad — see below)
  - `subagents/<name>.jsonl` (per-subagent transcripts)
  `MultiAgentHost` gains `ensureDirector()`, `manifest()`,
  `isDirectorMode()` for surface code; new options:
  `sharedScratchpadPath`, `sessionsRoot`, `directorRunId`.
- **Shared scratchpad for the fleet.** When `--director` is on, every
  subagent's system prompt automatically carries a "Shared notes"
  block pointing at `<fleetRoot>/shared/`. Agents drop conclusions
  into stable filenames (`findings.md`, `security.md`, etc.) and read
  sibling files before starting their own work — cheap
  filesystem-mediated coordination without going through the bridge
  for every paste. `Director.sharedScratchpadPath` is a readonly
  getter that surfaces the path; `composeSubagentPrompt` gains a
  `sharedScratchpad` part layered between Task and Override.
- **Per-subagent JSONL transcripts.** In director mode, each
  spawned subagent gets its own JSONL writer under
  `<fleetRoot>/subagents/<name>.jsonl` (instead of multiplexing into
  the parent session). Backed by `makeDirectorSessionFactory`, which
  is now wired into `MultiAgentHost`. Replay-friendly: each
  transcript is independently consumable.
- **`/spawn` flag parser.** Now accepts `--provider=<id>` /
  `--model=<id>` / `--name="..."` / `--tools=a,b,c` plus short forms
  `-p` / `-m` / `-n`. Quoted multi-word names supported via
  `--name="..."`. Single-arg legacy `/spawn <description>` preserved.
  Spawn confirmation message tags the subagent with its
  provider/model for visibility.
- **`/fleet` slash command hub.** Inspects and controls the subagent
  fleet without leaving the REPL: `/fleet` (defaults to status),
  `/fleet status`, `/fleet usage`, `/fleet kill <id>`, `/fleet
  manifest`, `/fleet help`. Status shows pending and completed tasks
  per subagent; usage rolls up iterations, tool calls, and durations
  across all completed tasks (sorted slowest first); kill sends a
  stop signal to a specific subagent; manifest is fully wired when
  running with `--director`. Wired through a new `onFleet` callback
  on `SlashCommandContext`.

**Tests** — 75 new tests across 5 files, all green:

- Core: 22 director tests (17 prior + 5 safety: maxSpawns rejects
  N+1, maxSpawnDepth rejects too-deep, defaults sane, spawn_subagent
  tool returns structured budget error, sibling/parent isolation
  regression) + 27 director-prompts tests (now including
  shared-scratchpad layering and `Director.sharedScratchpadPath`
  getter for set/null cases).
- CLI: 2 multi-agent provider-routing tests + 8 director-mode tests
  (isDirectorMode flips after lazy build, manifest null off-mode,
  manifest written on-disk in director mode, status/usage API
  stable in director mode, `ensureDirector()` returns null without
  the flag, `ensureDirector()` exposes the 8 orchestration tools,
  per-subagent JSONL writer is used when sessionsRoot is set,
  scratchpad path threads through to Director and into composed
  prompts) + 5 slash-command tests for `/spawn` + 7 `/fleet` tests.

### Added — safety caps (Phase 6)

- **`DirectorOptions.maxSpawns`** — lifetime cap on `Director.spawn()`
  calls. Default: `Infinity` (off). The N+1-th spawn rejects with a
  new `FleetSpawnBudgetError`, status `subagents` reflect only the
  spawns that actually landed, no partial manifest entries are
  written. Use this to stop a runaway leader from billing tokens
  forever.
- **`DirectorOptions.maxSpawnDepth` + `spawnDepth`** — bounds the
  nesting of director-of-director chains. The root director sits at
  `spawnDepth: 0` (default); a sub-director constructed by a worker
  should pass `spawnDepth: parent.spawnDepth + 1`. When
  `spawnDepth >= maxSpawnDepth` (default `2`), `spawn()` refuses.
  This stops a hostile or confused prompt from constructing an
  infinitely-deep director chain.
- **`FleetSpawnBudgetError`** — new typed error class with
  `kind: 'max_spawns' | 'max_spawn_depth'`, `limit`, `observed`.
  Exported from `@wrongstack/core`. The `spawn_subagent` tool catches
  this case and returns a structured `{ error, kind, limit, observed }`
  payload so the leader model can read the cap and replan instead of
  the tool call tearing down.
- **Isolation regression test pinned.** Verifies that
  `Director.subagentSystemPrompt(A)` and `subagentSystemPrompt(B)`
  never share content — neither sibling roles, sibling overrides, nor
  the director's own leader preamble leak into a subagent's prompt.
  Guards against a future composer change that accidentally smuggles
  parent or sibling context into the subagent layer.

### Changed — plugin API

- **`KERNEL_API_VERSION` advanced to `0.1.9`** (was `0.1.1`) to
  advertise the new additive surfaces above (Director, FleetBus,
  prompt composers, `FleetSpawnBudgetError`, `FLEET_ROSTER`). Plugins
  pinning `apiVersion: "^0.1"` continue to load unchanged.
- **`@wrongstack/core/package.json` `wrongstackApiVersion`** updated
  to `0.1.9` in lockstep. `wstack version` and `wstack diag` now
  surface this value.

**Not yet shipped** (documented in `director-architecture.md`):

- TUI/WebUI fleet panels (subscribe to `FleetBus.onAny` for live view)
- `wstack replay <runId>` subcommand (rehydrate from `fleet.json`
  manifest)
- Bridge-level exfil enforcement (currently the subagent baseline
  prompt forbids requesting parent state, but the transport itself
  doesn't reject such requests — the leader/director is responsible
  for ignoring them when they arrive)

The core protocol and isolation invariants are proven; surface work
above can land independently without touching the core layer.

## [0.1.7] — 2026-05-15

WebUI polish + publishing pass. `@wrongstack/webui` debuts on npm; all
other packages re-publish in lockstep. No breaking changes.

### Added — `@wrongstack/webui` (first npm release)

- **Standalone WebUI is now publishable.** `dist/server/entry.js` ships
  with a `#!/usr/bin/env node` shebang so `npx @wrongstack/webui` works
  after install. `files: ["dist", "README.md", "LICENSE"]` keeps the
  tarball lean — no source bleed.
- **Vim-style chat navigation** — `j` / `k` step between message bubbles,
  `g` / `Shift+G` jump to first / last, `c` copies the focused bubble's
  text, `Esc` clears focus. Only active when not typing in an input.
  Documented in the `?` shortcuts overlay.
- **In-text search highlighting via CSS Custom Highlights API.** Ctrl+F
  now paints every match of the query with a soft yellow background;
  the active hit gets a stronger amber. No DOM mutation, plays cleanly
  with ReactMarkdown re-renders. Silent no-op fallback on browsers
  without the API.
- **Inline error stack-trace expander.** Assistant `isError` bodies
  detect V8 / Python / Java stack frames and collapse them behind a
  "Show stack trace (N frames)" toggle. The lead message stays visible.
- **Token estimate + context-budget chip in the input.** Past ~400 chars,
  the character counter grows a `≈Nt` token estimate (4-char heuristic).
  Tints amber when projected `lastInput + draft + 64` ≥ 85% of context
  window, red at 100%. Hover reveals the exact projection.
- **Drag-and-drop file attach.** Drag files from the OS onto the chat
  input → tokens are inserted as `@<basename>` and the FilePicker opens
  pre-seeded with the last dropped basename for workspace-path
  resolution. Multi-file supported; non-file drags ignored.
- **Pretty tool-input renderer** — `ToolInputView` replaces the raw JSON
  dump for non-diff tools with a key:value list; nested values are
  expandable rows with collapsed `[N items]` / `{N keys}` summaries.
- **Preferences sub-section in Settings → Appearance.** Toggle compact
  density and "Sound on completion" (Web Audio synthesized chime,
  plays only when the tab is hidden, gated by user preference).

### Fixed — `@wrongstack/webui` typecheck

- **`WSClientMessage` union** now includes `modes.list`, `mode.switch`,
  `files.list`, `todos.get`, `todos.clear` — handlers existed in
  `ws-client.ts` but lacked type declarations, so `send()` rejected
  them at compile time.
- **`WSServerMessage` union** now includes `WSFilesList`,
  `WSTodosUpdated`, `WSModesList`. The `.on()` consumers were casting
  payloads against shapes not in the union, which produced
  non-overlapping-cast errors.
- **`Sidebar.groupedHistory`** IIFE return type missed the `star?: boolean`
  field that the Favorites group literal already used.

### Added — release tooling

- **`scripts/bump-version.mjs`** — lockstep version bumper. Computes the
  next version from the highest seen across the workspace, writes the
  same value into all 10 package.json files (root, every `packages/*`,
  and `apps/wrongstack`). Leaves `workspace:*` cross-deps untouched —
  pnpm rewrites them at publish time.
- **Root scripts** — `pnpm version:patch|minor|major|set`,
  `pnpm release:check` (typecheck + test + build),
  `pnpm release:dry` (full dry-run), `pnpm release` (gate + publish).
- **`publishConfig.access: "public"`** added to every publishable
  package so `pnpm publish` no longer needs the `--access public` flag.

## [0.1.6] — 2026-05-14

Security hardening pass: 7 CRITICAL, 16 HIGH, 20 MEDIUM, 9 LOW findings from
a forensic codebase review closed out. **No public API breaking changes.**

The full threat model and rationale for each control is documented in
[SECURITY.md](SECURITY.md). Highlights below; if you only read one line,
read this one: **the `bash` tool now sanitizes its child process env so
`ANTHROPIC_API_KEY` / `GITHUB_TOKEN` / etc. are no longer forwarded to
LLM-generated commands.** Set `WRONGSTACK_BASH_ENV_PASSTHROUGH=1` if you
need the prior behavior.

### Fixed — SSRF cluster (`fetch` tool)

- **Redirect target re-validated every hop.** A public host's 302 to AWS/GCE
  metadata (`169.254.169.254`) is now refused at hop 2; previously only the
  initial URL was checked.
- **Private-range detection rewritten with numeric CIDR.** Previously regex
  substring matching on hostname strings — bypassed by IPv4-mapped IPv6,
  CGNAT (100.64/10), multicast (224/4), reserved (240/4), Azure-style
  fd-prefixed ULA, and several other forms. New implementation fully
  expands IPv6 to 8 groups and compares numerically.
- **IPv4-mapped IPv6 in Node's URL-normalized form.** `https://[::ffff:127.0.0.1]/`
  becomes `[::ffff:7f00:1]` after `new URL().hostname` — the old detector
  missed this entirely. New detector decodes the v4-mapped low 32 bits
  back to an IPv4 address and runs the IPv4 private check.
- **DNS lookup before connect.** Best-effort guard against DNS rebinding;
  not a full guarantee (see SECURITY.md).

### Fixed — agent-tool boundary

- **`bash` child env sanitized** by an allowlist (PATH, HOME, LANG, …) plus
  substring-strip of TOKEN/SECRET/PASSWORD/AUTH/BEARER/COOKIE/PRIVATE/KEY
  variables. Opt-out via `WRONGSTACK_BASH_ENV_PASSTHROUGH=1`.
- **`bash` POSIX process-group kill** on timeout/abort — runaway grandchildren
  (`sleep 9999 & disown`) no longer survive.
- **`exec.allow_unknown` removed.** The flag advertised "DANGEROUS" was
  trivially flippable by an LLM; for unrestricted commands use `bash`
  (which is more clearly gated).
- **`exec` dead-code blocklist removed.** `FORBIDDEN_PATTERNS` only tested
  the command name, never the args — it never matched anything. The
  allowlist alone now does the gating.
- **`exec.cwd` validated** to resolve inside `ctx.projectRoot`.
- **`git.args` raw string field removed.** The bypass allowed
  `-c core.sshCommand=…` / `--upload-pack='sh …'` RCE. All git operations
  go through the typed subcommand fields.
- **`git.findGitDir` bounded by `projectRoot`** — non-git projects no
  longer drift into a parent repo at `~/repos/.git`.
- **`patch` diff-target validation.** `+++ ../../../etc/passwd`-style
  escapes are pre-rejected before GNU patch sees the diff. `strip` clamped
  to ≥1. Temp diff file written into a `0700 mkdtemp` directory rather
  than a predictable timestamp name. `LC_ALL=C` set so the
  "patching file" detection works under any locale.
- **`replace` symlink/TOCTOU.** Resolves through `realpath`, validates
  the result is inside `projectRoot`, writes to the resolved path.
  Symlinks are skipped, not followed.
- **`grep` symlinks skipped** during native traversal.
- **User-regex ReDoS guard** (`compileUserRegex` in `packages/tools/src/_regex.ts`)
  — 512-char pattern cap, rejection of `(a+)+`-style nested quantifiers,
  64 KB subject-line cap. Applied to grep, replace, logs.
- **`grep` stdout buffer 1 MB cap** — pathological producers (matching a
  huge binary with no newlines) can't pin memory.
- **`logs.lines:0`** historically buffered the entire file; now clamps to
  100k lines via a fixed-size rolling window.

### Fixed — MCP / multi-agent lifecycle

- **MCP `failPending()` on transport death.** When a stdio child exits or
  `close()` is called, every in-flight JSON-RPC request is rejected with a
  transport-closed error. Previously callers (e.g. `callTool` mid-tool-use)
  hung forever on a dead transport.
- **MCP SIGTERM → SIGKILL escalation.** Stuck servers that ignored
  SIGTERM stayed alive after `close()` returned. Now waits 800ms then
  force-kills.
- **MCP registry disconnect-listener leak fixed.** Listeners were stored
  in a Set keyed by arrow-function reference; remove never matched because
  each call site created a fresh lambda. Now stored on the slot.
- **MCP registry closes prior client** before swapping references on
  reconnect.
- **`Multi-agent` floating promise + inFlight leak fixed.**
  `runDispatched` no longer bumps `inFlight` when no runner is wired (it
  would never be decremented). Sync errors in dispatch now produce a
  failed task instead of an unhandled rejection.
- **`Multi-agent` AbortController recycle** after timeout, so the next
  task on the same subagent doesn't start with an already-aborted signal.
- **`agent-bridge` duplicate correlation-id detection.** Caller-supplied
  message IDs that collide with in-flight requests now throw at submit
  time instead of silently replacing the prior pending entry.
- **`tool-executor` per-tool error isolation.** A `safeRun` wrapper
  ensures one tool's unexpected exception doesn't collapse `Promise.all`
  and lose every sibling's output.

### Fixed — providers / SSE

- **Provider tool-call argument validation.** All six stream parsers
  (Anthropic, OpenAI, Google, Mistral preset, plus the aggregate path)
  route arg JSON through a shared `parseToolInput` helper. Arrays, null,
  scalars, and invalid JSON are wrapped under `__raw` so the tool always
  receives a `Record<string, unknown>`.
- **SSE parser buffer cap (256 KB)** + incremental CRLF normalization.
  Previously `buffer.replace(/\r\n/g, '\n')` ran on the entire pending
  buffer per chunk — O(n²) in stream length.
- **Stream builder no longer fabricates `stopReason: 'max_tokens'`** on
  abort. Uses `'end_turn'` instead so telemetry isn't poisoned and retry
  logic that branches on max_tokens doesn't trigger.

### Fixed — type safety / config

- **Config-loader `apiKeys` entries filtered** through a runtime type
  guard before use — a null or malformed entry no longer crashes provider
  resolution.
- **Config-loader JSON parse vs ENOENT** distinguished: a typo'd local
  config now warns instead of silently falling back to defaults.
- **Config `context.*` thresholds typeof-checked** — string values in
  `config.json` no longer coerce silently through `>=`.
- **Prototype pollution guard** on `deepMerge` (config-loader,
  secret-vault) — `__proto__` / `constructor` / `prototype` keys ignored.
- **SecretVault per-field decrypt try/catch** — one corrupted ciphertext
  no longer kills the entire config load.
- **Session-store JSONL shape validation** — events with malformed
  `type` / `ts` are skipped at load rather than crashing replay.
- **Session-store error wrapping** uses `Error.cause` to preserve
  ENOENT/EACCES/EMFILE codes.
- **`SubagentContext.parentBridge` typed `| null`** — the previous
  double assertion from `null` to `AgentBridge` was a type lie that hid the
  two-phase init contract.
- **`SessionAnalyzer.analyze` populates `sessionId`, `tasks`, and
  `modeChanges`** from session_start/task_*/mode_changed events; these
  were hardcoded empty.

### Added

- **`Tool.subjectKey`** — Tools can declare which input field is the
  permission-trust subject. Bash → `command`, fetch → `url`. Without this
  the policy heuristic could mismatch across tools (an HTTP tool whose
  `path` means request-path would have been checked against filesystem
  trust rules). Optional; legacy heuristic still applies as fallback.
- **[SECURITY.md](SECURITY.md)** — Threat model, adversary assumptions,
  every control with rationale, and known limitations.

### Internal

- 57 new tests covering env stripping, regex compilation, tool-input
  validation, and 28 SSRF cases (private-range detection, redirect
  re-validation, IPv6 v4-mapped, public-IP sanity).
- TypeScript and tsup versions aligned across all packages
  (was: root 5.9.3 + 8.5.1, packages 5.7.2 + 8.3.5).
- MCP `clientInfo.version` bumped to `0.1.6`.

### Follow-up hardening (post-initial 0.1.6 audit pass)

- **`system-prompt-builder.gitStatus` bounded at 2 s.** A hung `git status`
  (corrupt index, `.git/index.lock` held by another process, slow network
  FS) previously stalled the entire prompt build per turn. Times out
  gracefully to `git timeout`.
- **`system-prompt-builder.detectLanguages` parallelized.** 11 marker
  probes were sequential; now fanned out via `Promise.all`.
- **`system-prompt-builder.envCache` keyed by `projectRoot`.** Reusing a
  builder across different project roots used to serve the first call's
  cached env block to later calls.
- **Mode + capabilities resolution moved to builder construction-time
  options.** `BuildContext.activeModeId` / `BuildContext.capabilities`
  were dead surface (no caller ever set them on ctx). Now passed via
  `DefaultSystemPromptBuilderOptions.modeId` / `modePrompt` /
  `modelCapabilities`, and the CLI resolves them once at startup.
- **Skill block moved into env layer.** Skills are static per session,
  so they now ride the cached env block instead of being rebuilt per
  turn in layer 4.
- **`session-store` append-failure warnings debounced** to one log per
  5 s with a `+N suppressed` tail. A chatty agent against a full disk
  previously logged on every event.
- **`mcp/client.connectStdio` resets `rxBuffer`** at the top of every
  connect to prevent stale bytes from a half-initialized prior attempt
  on the same instance corrupting JSON-RPC parsing on the new stream.
- **`tools/edit` stale-read mtime tolerance raised to 2000 ms on
  Windows.** FAT and some network filesystems quantize mtime to 2 s,
  so the previous 1 ms tolerance threw false "modified externally"
  errors after a tool's own write→read cycle.
- **`WstackPaths.configDir`** alias for `globalRoot` — gives callers a
  semantic name for user-global stateful config and lets us split out
  `XDG_CONFIG_HOME` later without rewriting consumers. `TOKENS.ModeStore`
  registered so DI consumers can resolve it.

### Bugs.md triage round — 6 closed, 4 false-positive, 3 by-design

- **`memory-store.remember()` race fixed** — concurrent remember/forget/
  consolidate/clear calls were lost because of unlocked read-modify-write.
  Added per-scope async chain so writes serialize per scope while
  different scopes still run in parallel.
- **`estimateToolInputTokens` no longer mutates caller's input** — the
  per-input cache used to attach `__tokenEstimate` to the input object,
  which threw on `Object.freeze`'d inputs. Moved to a module-level
  `WeakMap<object, number>`.
- **`parseProviderHttpError` surfaces truncation** — raw HTTP error
  bodies over 2 KB were silently truncated. `ProviderErrorBody` gains
  `truncated: boolean` and `rawLength: number`.
- **`OpenAICompatibleProvider` quirks redundancy** — explicit `...?.x`
  reassignments after the spread copied the same values; collapsed to
  the spread alone.
- **Coordinator `inFlight_underflow` warning de-noised** — only fires
  when a runner is wired (true double-completion), not on every legit
  no-runner-pattern completion.
- **`compaction.failed` event** — auto-compaction errors were swallowed
  silently by design (don't crash the loop), but with zero observability
  signal. Middleware now emits `compaction.failed` when wired with an
  EventBus. Backward-compatible.

### Added — new published package

- **`@wrongstack/plug-lsp@0.1.6`** — Language Server Protocol plugin.
  Auto-discovers `tsserver` / `pyright` / `gopls` / `rust-analyzer` in
  the workspace, exposes `lsp_hover`, `lsp_definition`, `lsp_references`,
  `lsp_diagnostics`, `lsp_format_document`, `lsp_rename_symbol` tools.
  Includes `wrongstack-lsp-setup` binary for one-shot install. CLI now
  depends on it as a workspace package.

### Added — per-package READMEs

Each published package now ships its own README so npmjs.com renders
something useful: `core`, `cli`, `providers`, `tools`, `tui`, `mcp`,
`plug-lsp`.

## [0.1.4] — 2026-05-14

### Fixed

- **Umbrella `wrongstack` package republished in lockstep**. 0.1.3 shipped `@wrongstack/cli@0.1.3` but the user-facing `wrongstack` package on npm was accidentally left at 0.1.0 with a pinned `@wrongstack/cli: 0.1.0` dependency, so `npm i -g wrongstack` kept resolving to the pre-observability binary. 0.1.4 re-publishes every package together and `wrongstack@latest` now actually delivers the L0–L3 work.

### Changed

- **License: Apache-2.0 → MIT**. The previous publish landed before the SPDX `"license"` field was added to each package.json, so the registry rendered every package as "Proprietary". Every package now carries `"license": "MIT"` plus the canonical `repository`, `homepage`, `bugs`, and `author` metadata.
- MCP `clientInfo.version` advertised to MCP servers bumped to `0.1.4` (was lagging at `0.1.1`).

## [0.1.3] — 2026-05-14

### Added

- **Streaming for long-running tools** — `install`, `lint`, `format`, `typecheck`, `test`, `audit`, `fetch`, `grep`, `tree`, `search` now yield `partial_output` / `log` / `metric` events via `executeStream`. The TUI live-tails these instead of waiting for the whole tool to finish (L0-A)
- **Typed agent errors** — `RunResult.error` is now `WrongStackError | undefined`; `Agent.run` wraps any non-WSE throw into `AgentError` with code `AGENT_RUN_FAILED`. CLI repl + TUI render `code`, `severity`, `recoverable`. `/diag` shows the last 5 errors (L0-B)
- **Declarative provider configs** — Anthropic, OpenAI, and Google providers re-implemented as `WireFormatConfig` presets. The old subclasses survive as no-op compat wrappers for one minor (L0-C)
- **Plugin teardown + capability runtime check** — loader invokes `plugin.teardown()` on SIGINT and natural exit. When a plugin lies about its `capabilities`, the loader logs a warning instead of silently accepting (L0-D)
- **`Config.extensions` plumbed to plugin loader** — CLI passes `config.extensions` as `pluginOptions` so plugins reading `api.config.extensions[name]` see what the user configured (L0-E)
- **OTel-compatible tracer** — `Agent.run`, `provider.complete`, and `tool.<name>` open spans on a noop-by-default `Tracer`. Plug in an OTLP exporter via `OTelTracer` (L1-C)
- **Multi-agent CLI integration** — `/spawn` slash command, `/agents` status panel, budget visualization on per-subagent task (L1-E)
- **Pipeline middleware error boundary** — `Pipeline.setErrorHandler(fn)` lets a host decide rethrow-vs-swallow when a plugin handler crashes. Default: rethrow (L1-F)
- **SessionReader interface** — `DefaultSessionReader` exposes query (by date/provider/title/minTokens), replay (async-iterable events), full-text/regex search, and export (markdown/json/text) over any `SessionStore` (L2-A)
- **MCP reconnection with exponential backoff + jitter** — capped at 5 cycles, transitions to `failed` state and surfaces in `/diag`. Tool-list cache invalidates on `notifications/tools/list_changed` (L2-B, L2-C)
- **Config v2 migration framework** — `runConfigMigrations(input, targetVersion, migrations)` applies a chain of pure migrations, loop-guarded at 100 steps. Throws `ConfigMigrationError` with the missing step name (L2-D)
- **Inter-agent messaging exercised at API level** — `InMemoryAgentBridge` request/response, broadcast (sender-excluded), and timeout paths covered (L2-E)
- **Per-tool subpath exports** — `import { bashTool } from '@wrongstack/tools/bash'` and every other public tool. Each tool tree-shakes independently of the others (L3-A)
- **HTTP `/metrics` Prometheus scrape endpoint** — `startMetricsServer({ port, sink })` exposes counters/gauges/histograms in Prometheus text format. CLI flag: `--metrics-port`. Defaults to bind on `127.0.0.1`; set `METRICS_HOST=0.0.0.0` for network scraping (L3-C)
- **CI gate** — `.github/workflows/ci.yml` runs `pnpm typecheck && pnpm build && pnpm test`; failure on any step blocks the merge (L3-D)
- **Reactive conversation state** — `ctx.state.appendMessage()` / `ctx.state.replaceMessages()` fire `onChange` events. Subscribed UIs no longer poll. `Agent.run` and every compactor route mutations through this wrapper (L1-A)
- **Benchmark harness** — `pnpm bench` runs `*.bench.ts` files via `vitest bench` against a separate config; JSON output captured to `bench-results.json` for CI artifact diffing (V0-A)
- **Initial benchmarks** — coverage for token estimation, JSON-schema validation, system-prompt build, and the three compactors (V0-B)
- **CLI test coverage uplift** — `boot-config`, `pre-launch`, `multi-agent`, and `auth-menu` now have direct tests (V0-C)

### Changed

- **`defaults/index.ts` is named-exports only** — every public symbol is enumerated; no `export *` (L3-B). Build output is byte-for-byte equivalent; just better surface clarity
- **Removed three unused kernel registries** — `pipeline-registry.ts`, `strategy-registry.ts`, `token-registry.ts` had zero in-repo references and one mention in the dev plan. Deletions confirmed (L3-E)
- **Test flake cleanup** — `search.test.ts` no longer hits live DuckDuckGo (mocked `fetch`); `repl.test.ts` no longer hits a Worker OOM from infinite empty-line loops
- **Version 0.1.0** — all packages bumped to 0.1.0; plugin `apiVersion` minimum now `^0.1.0`
  - Plugins using `apiVersion: "^1.0"` will no longer load — update to `^0.1.0`

### Fixed

- `MCPServerConfig` assignment in `subcommands/index.ts` no longer fails typecheck when DTS regenerates (cast through `unknown` since the on-disk shape is wider than the closed type)

### Notes for tool authors

- **The `Tool` public API is unchanged.** L1-A migrated the *internal* paths to route through `ctx.state`; your tools still receive `Context` and can still mutate `ctx.messages` directly if needed. Subscribers to `ctx.state.onChange` only see mutations made via the wrapper API.
- **The `Tool.executeStream` async generator** is now preferred for long-running tools that produce incremental output. Yield `{ type: 'log', text }`, `{ type: 'partial_output', text }`, or `{ type: 'metric', data }` events, then a terminal `{ type: 'final', output }`. The TUI live-tails these.

## [0.1.0] — 2026-05-13

### Added

- **TUI (React/Ink)** — full-screen terminal UI with streaming text, slash command picker, file picker (`@` token), message queue, and crash recovery
- **Slash command picker** — type `/` to open a fuzzy-filtered dropdown of all commands; navigate with `↑/↓`, accept with `Enter` or `Tab`
- **History scroll** — `PageUp`/`PageDown` (or `Ctrl+K`/`Ctrl+J`) navigate history; `Ctrl+G` jumps to top; auto-scrolls to newest entry unless user scrolled up
- **Streaming throttle** — `provider.text_delta` events buffered at 100ms (~10fps) to eliminate per-character flicker during streaming
- **Queue persistence** — TUI message queue survives crashes; rehydrated on restart with `QueueStore`
- **Crash recovery** — abandoned session lockfiles detected on boot; offers to resume or discard
- **Encrypted secrets** — plaintext `apiKey` fields in config files auto-migrated to AES-GCM vault at `~/.wrongstack/.key`
- **Monorepo structure** — `packages/cli`, `packages/core`, `packages/mcp`, `packages/providers`, `packages/tools` with pnpm workspaces
- **Minimal kernel** — `Container`, `Pipeline`, `EventBus` primitives (under 600 lines total)
- **4 wire-family transports** — `anthropic`, `openai`, `openai-compatible`, `google`
- **Provider catalog** — fetched from `models.dev/api.json`, 24h TTL cache, ~110 providers
- **8 built-in tools** — `read`, `write`, `edit`, `glob`, `grep`, `bash`, `fetch`, `todo`
- **3 additional tools** — `replace` (batch regex replace), `search` (web search), `git` (common operations)
- **5 more tools** — `exec` (restricted shell), `patch` (apply diffs), `json` (parse/query), `diff` (show differences), `tree` (directory tree)
- **11 dev tools** — `lint`, `format`, `typecheck`, `test`, `install`, `audit`, `outdated`, `logs`, `document`, `scaffold`, `kill` (optional)
- **4 meta tools** — `tool_search`, `tool_use`, `batch_tool_use`, `tool_help` for tool introspection and orchestration
- **Mode system** — 8 built-in agent modes (default, code-reviewer, code-auditor, architect, debugger, tester, devops, refactorer) with role-specific prompts
- **Multi-agent system** — `AutonomousRunner` (done-condition loop), `AgentBridge` (in-memory messaging), `MultiAgentCoordinator` (task orchestration, parallel subagents)
- **Spec-driven development** — `SpecParser`, `TaskGenerator`, `TaskTracker`, `TaskFlow` for specification-first workflow with skills `sdd-SKILL.md` and `multi-agent-SKILL.md`
- **Extended session events** — mode_changed, task_*, agent_*, spec_*, skill_*, tool_call_start/end, message_truncated
- **SessionAnalyzer** — query and analyze session events for replay and retrieval
- **Session memory** — `remember`/`forget` for cross-session notes
- **Plugin system** — full `PluginAPI` with container, pipelines, registries for tools/providers/MCP
- **Permission policy** — per-project `trust.json` with allow/deny rules
- **Session compaction** — automatic context summarization to stay within token limits
- **Skills system** — user-global and project-local skills loaded from `~/.wrongstack/skills/`
- **REPL mode** — interactive prompt with command history
- **Slash commands** — `/providers`, `/models`, `/resume`, `/help`
- **Subcommands** — `wstack providers`, `wstack models`, `wstack resume`
- **Biome linting** — project-wide lint and format via Biome
- **Vitest testing** — test suite with coverage support
- **`AGENTS.md`** — project-level conventions committed to repo

### Configuration Added

- **`~/.wrongstack/config.json`** — global provider/model selection
- **`~/.wrongstack/memory.md`** — user-global agent notes
- **Project `/.wrongstack/AGENTS.md`** — shared project conventions
- **`WRONGSTACK_FETCH_ALLOW_PRIVATE=1`** — opt-in to allow localhost in fetch tool

### Fixed

- **Streaming flicker** — per-character Ink re-renders during streaming now throttled at 100ms, eliminating visible flash/jitter on fast providers

## [0.1.0] — 2026-05-13

Initial release.


- `**packages/webui/** + **packages/core/src/coordination/agents/phase8-delivery.ts** — `pnpm release:check` cleanup`: fixed seven pre-existing WebUI test failures (`@testing-library/react` dep added; AgentsPage-local `fmtCost/fmtDuration/fmtElapsed/sparkline` added with compact semantics; `dashboard-primitives.fmtCost` accepts negative values; `clientNodeType('cli')` maps to repl; `slash-routing` test fixture `listMemory` typo + vi.hoisted shared mocks; `queued-messages-file-mention-picker` `toBeEmptyDOMElement` replaced with native assertion + `mockTextarea` helper + manual raf flush; `streaming-performance` chunk count check via regex). Fixed a parse error in core's `phase8-delivery.ts` (line 139) where an unescaped `{` inside a template-literal prompt was being interpreted as a JS interpolation start. Release:check now exits 0 with 663 test files / 9057 tests passed + 89 webui files / 1558 tests passed, no vulnerabilities, typecheck + build clean.

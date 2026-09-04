# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`gpt-6-astra` is available under the ChatGPT sign-in (`openai-codex`) provider.** OpenAI's GPT-6 Astra now leads the Codex picker as the recommended model — added to the curated overlay (`packages/cli/data/providers.json`) and to the offline `CODEX_MODELS` floor in core, so it shows up whether or not the overlay sync is reachable. It carries the same wire reasoning efforts as the 5.6 line (`low`/`medium`/`high`/`xhigh`/`max` — `ultra` is a product orchestration mode, not a wire value), text+image input, and the lineup's 1.05M context / 128k output declaration; the live `/codex/models` probe remains the runtime guard on the window the backend actually enforces. `gpt-5.6-sol` is no longer tagged current. (`packages/core/src/models/codex-catalog.ts`, `packages/cli/data/providers.json`)

## [0.320.1] — 2026-09-04

### Added

- **A useful benchmark now works out of the box.** `wstack bench run` defaults to
  the bundled six-task Node `core` suite, graded by real tests. Use `--cell
  provider/model` (or a saved model) without cloning a dataset or writing a
  config. `--suite smoke` remains a three-task wiring check, not a quality
  score. (`packages/bench`, `wstack bench run`)
- **Benchmark reports expose variance and failures.** `--repeats N` adds
  Pass@N, All-pass, and per-task flakiness alongside Pass@1. Completed rows
  stream to `results.jsonl`, the report names grader and agent failure details,
  and `wstack bench compare` refuses to silently compare incompatible harnesses.
  (`packages/bench`, `wstack bench compare`)
- **Brain councils can deliberate twice before a decision.** The first round is
  independent; the optional default second round presents other ballots as
  untrusted quoted data, lets seats revise only on substantive evidence, and
  records how many votes changed. Set `/brain council rounds 1` for a
  single-round panel. (`/brain council`)
- **Chronicle gains a configurable volume policy.** `chronicle.detail` can
  fold routine high-volume telemetry into bounded counters while always keeping
  failures, denials, and cancellations as raw evidence. Retention limits cover
  days, events, and disk usage. (`packages/core/chronicle`)

### Changed

- **Chronicle journals use less disk without weakening verification.** Event
  payloads are losslessly compressed when beneficial, legacy rows remain
  readable, and incremental vacuum returns pages after purges or event-limit
  trims instead of keeping the database at its historical high-water mark.
  (`packages/core/chronicle`)
- **Brain decisions carry more operator context across the CLI, TUI, SimpleUI,
  and HQ.** The shared decision flow now exposes deliberation and telemetry
  data to the surfaces that render and inspect a council outcome.

### Fixed

- **Benchmark comparisons now include the operator's effective harness policy.**
  The sandbox hashes behavior-affecting settings it actually reads, while
  excluding credentials and the chosen provider/model. Different skills,
  token-saving, or system-prompt settings can no longer masquerade as a model
  difference. (`packages/bench/src/isolation.ts`)
- **Incomplete runs no longer flatter a model's cost or exit successfully.**
  Timed-out and crashed rows are labelled as lower-bound usage rather than
  ordinary zero-cost work; a matrix where every attempt crashes exits non-zero.
  (`wstack bench run`)

## [0.320.0] — 2026-09-04

### Added

- **The statusline picker owns the full rail contract.** `/statusline` now decides which chips render, on which of the four rails, and at what density; the bar consumes that layout through a single shorten-before-drop fitter (`layoutRail()`), so a narrow terminal concedes detail rather than dropping chips. A pinned-density chip never degrades — it can only be dropped. The rails regrouped by volatility into L1 identity, L2 vitals, L3 safety & work, and L4 async, matching the grouping already used by `core/statusline`, and the click map consumes the same layout as the renderer so mouse hit-testing cannot drift from what is drawn. (`54a0aadfe`)
- **Session storage policy is wired into session-store construction.** `DefaultSessionStore` takes a hot/cold `storage` policy resolved from `resolveSessionLoggingConfig(config)`, so the setting affects real construction rather than only the type definitions. With `sessionLogging.storage.autoArchive` enabled, the container also kicks off an idempotent background `archiveIdle({ backfill: true })` on first construction — it walks the existing sessions directory so upgrading a long-lived project compresses its backlog on the next restart instead of waiting out `archiveAfterDays` again. The call is fire-and-forget and a rejection is only logged: a session store must never refuse to construct because archive-idle could not reach disk. (`c3049dec2`)
- **The TUI theme registry grew from 50 to 64 presets.** Fourteen palettes were missing from the picker: `oceanic-next`, `one-half-dark`, `ayu-mirage`, `seti`, `paraiso-dark`, `darcula`, `slack-dark`, `vitesse-black`, `atom-dark`, and `github-dark-high-contrast`, plus four original themes aimed at gaps no port covered — `contrast-max` (pure black, AAA-targeted text and borders), `colorblind-safe` (blue/orange coding with no red-vs-green reliance), `sandstone` (warm stone neutrals), and `everforest-hard`. Every preset is selectable through `/theme`, the CLI picker, and the boot theme adapter, and is validated by the same per-preset contrast gate. (`a08d78c63`)

### Fixed

- **`/help <slash>` and `/help <slash> <deep>` reach the shared help renderer.** `slash-deep-help.ts` shipped with five exports and ~40 tests to keep the in-REPL and `wstack <sub> --help` surfaces from drifting — and no production caller. So `/help mcp` showed only `/mcp`'s short inline string, and `/help mcp add` answered `Unknown command: /mcp add`. `/help <slash>` now appends the focused block after the inline help (the inline field teaches the slash form a REPL user actually types, so it is kept rather than replaced), and a two-token query renders the deep block. (`help.ts`)
- **A dead duplicate of the WebUI trust-boundary authorizer was removed.** `packages/cli/src/webui-server/privileged-actions.ts` exported its own `authorizeCliWebUIAction` plus a `createCliProcessRoutes` factory, both referenced only by their own test; every real host wires process routes through `webui-server`'s `authorizeWebUIAction` instead. The copy had already fallen behind the original — it dropped `sessionId` from both the trust request's `actor` and its `scope` — so wiring it up later would have silently weakened session attribution on `process.kill`. (`privileged-actions.ts`)

- **`/flow` is reachable.** The text-first cross-board Kanban view shipped fully implemented and tested, but `createWorkbenchSlashCommand` was never mounted into any registry — it sat in `architecture/test-only-exports.json`, where green coverage proved the function worked while no user could invoke the command. It is now registered alongside `/kanban` in the TUI's core command mount. (`docs/slash/README.md`)
- **Twelve registered slash commands were missing from the slash-command overview.** `docs/slash/README.md` presents its tables as derived from the registration sites, but `/theme`, `/tier`, `/effort`, `/profile`, `/sidebar`, `/intake`, `/provider-status`, `/connections`, `/flow`, `/solo`, and `/cron` appeared in none of them, and had no per-command page either. All are listed now, and the overview once again covers every registered command name.

- **The plugin feature matrix stopped advertising tool names that do not exist.** `docs/feature-matrix.md` is the only place that maps a plugin to the tool ids an operator actually types, and it is hand-written — so it had drifted into 19 of 64 rows naming tools the plugin never declares (`error_lens_status` for the real `error_lens_history`, `test_generate` for `generate_unit_tests`, and 17 more, each of which fails at the call site), three plugins claiming to mutate files while writing none, and `gitignore-guard` missing from the matrix entirely. All 65 rows now match the source, and a new `pnpm check:feature-matrix` gate in CI verifies every row's directory and tool ids against `packages/plugins/src` so the matrix cannot drift silently again.

- **A Telegram poller restarted after `stop()` no longer runs as a zombie.** `stop()` aborts the injected `AbortController` to cancel the in-flight long poll, but the controller was readonly and `start()` reused it — so every `getUpdates` after a restart carried an already-aborted signal, rejected silently, and delivered no updates until the process itself restarted, while the loop kept spinning with `active === true`. `start()` now swaps in a fresh controller when the previous signal was aborted. (`0c34c8515`)
- **OpenAI Codex no longer loses usage telemetry on terminal-only streams.** `parseOpenAIResponsesStream` dropped usage from any `response.completed`/`incomplete` envelope that arrived without the start-producing events, because the terminal `if (started)` guard never fired for a backend that goes straight to a terminal envelope. A usage-bearing terminal now synthesizes the paired `message_start` so the usage-bearing `message_stop` is delivered; usage-less terminals stay silent. (`695d63a27`)
- **The TUI model, mode, auth, autonomy, theme, and skills pickers respond to keys again.** The statusline rewrite in `54a0aadfe` deleted stage 1 of the `usePickerKeys` dispatch table — the `tryAuthModelPickerKeys` call and its import — leaving the 353-line handler compiled but unreferenced, so every one of those pickers silently ignored input. The stage is restored verbatim. (`559090ad7`)
- **Fourteen themes no longer render Catppuccin Mocha's body text on their own palettes.** `tokyo-night`, `nord`, `cyberpunk`, `dracula`, `gruvbox-dark`, `solarized-dark`, `one-dark`, `monokai`, `rose-pine`, `kanagawa`, `ayu-dark`, `everforest`, `night-owl`, and `synthwave` spread `...baseTheme` without overriding `textPrimary`, `textSecondary`, or `textMuted`, so each displayed Mocha's lavender foreground and comment gray on its own base — a cool blue-gray body on warm Gruvbox, and so on. All three now carry each palette's real text tones, and every colour key is written explicitly per preset so the inheritance cannot silently recur. (`a08d78c63`)
- **Faint theme tokens were lifted to readable contrast.** Ten presets rendered code comments below 3:1 against their own surface; `borderSubtle` was byte-identical to `surfaceRaised` in ten presets, so card dividers and tree prefixes vanished on a raised panel; `synthwave` and `blood-moon` panel borders sat at 1.12:1 and 1.24:1 against their base; and five presets had a `surfaceRaised` so close to `surface` that raised panels had no visible elevation. (`a08d78c63`)
- **Transcript roles and status colors stopped sharing a channel.** `assistant == tool == accent` in five presets made tool output indistinguishable from prose, and `blood-moon` painted the prompt, the assistant label, and errors in one red. The three role colours are now distinct per preset, and no preset uses its failure colour as its prompt colour. (`a08d78c63`)
- **Syntax highlighting matches the palettes it claims to port.** Monokai, Dracula, Synthwave, Ayu Dark, and GitHub Dark render strings in their upstream colours (yellow/orange/tan, not theme-green) via explicit `syntax` overrides, joining the existing `dark-plus` override. (`a08d78c63`)

### Changed

- **Three more superseded duplicates were removed from the CLI and core.** `wiring/cli-heap-watchdog.ts` duplicated `wiring/heap-watchdog-setup.ts`, which is the one `cli-main.ts` actually calls — the CLI heap watchdog was never unprotected, it just had two implementations and tested both side by side in the same `it.each`. `session-writer-flush.ts`'s `flushBufferSync` was the naive exit flush that `SessionWriteBuffer.flushSync` superseded (its sibling `isClosedHandleError` stays; it has five real callers). `DefaultProviderRunner` documented itself as "bound to `TOKENS.ProviderRunner` by the CLI at boot" and never was: the agent loop treats an unbound token as "no DI runner", and the single place that installs a default — the replay wiring — reimplements the same one-line body inline. The remaining test coverage was rewritten against the live implementations rather than dropped, and `architecture/test-only-exports.json` had its twelve now-resolved entries pruned.

- **Three superseded TUI components and a block of dead lazy imports were removed.** `StatuslineDetailPanel` (302 lines) documented its own entry point as "the F12 picker's detail option" — an option that was never built; the `/statusline` picker now reports measured per-line fill instead. `LiveActivityStrip` was replaced by the async rail's per-subagent `fleet_agents` chips, and `MemoryContextWidget` by the context panel plus the statusline memory chip. Each was reachable only from its own tests, which is coverage proving the code works rather than that anything calls it. Separately, `App.tsx` carried 21 unreferenced `const _X = lazy(...)` declarations left over after the per-view lazy imports moved into `view-registry.ts`; the three overlay-panel handles that App.tsx does render (`CronJobsPanel`, `ProcessMonitor`, `QueuePanel`) stay. Three comments that named the removed components were corrected.

- **`computeRailSpans` was removed from the statusline rail module.** The statusline v3 rewrite moved the status bar's click-map onto `layoutRail` directly, leaving `computeRailSpans` as an unreachable four-field projection kept alive only by its own tests — while two comments still described it as the thing production used. The tests now apply that projection locally, and the comments name `layoutRail`. Reading `computeRailSpans` from the hot render path would have cost a second layout pass per rail, so the shim was dropped rather than re-wired.

- **TUI theme palettes moved into per-family modules.** Palette data now lives in `packages/tui/src/theme-presets/<family>.ts` (21 family modules plus `base.ts` and `options.ts`) and is composed by a thin `theme-presets.ts` index. The architecture hotspot guardrail caps that file at 1424 lines and the single inline `themePresets` Record could not absorb more presets. The public `./theme-presets.js` path and the `theme.ts` facade are unchanged; adding a theme is now core id → family module → picker row → CLI `THEME_META`, all still compile-enforced. A spread-composition guard in the index now rejects duplicate preset ids across modules — a mistake the old single-object literal caught at compile time and spreading cannot. (`a08d78c63`)
- **The theme preset suite enforces the palette contract it previously lacked.** Per-preset assertions now cover AA body text on both surfaces, the `textPrimary > textSecondary > textMuted` emphasis hierarchy, `borderSubtle < borderDefault < borderActive` ordering, distinct `user`/`assistant`/`tool` role colours, and that no non-Catppuccin preset carries a Catppuccin text token (513 → 845 tests). `docs/tui-themes.md` was regenerated from the live palette and documents the new floors. (`a08d78c63`)

## [0.319.2] — 2026-09-03

### Security

- **Provider configuration no longer accepts link-local or cloud-metadata endpoints.**
  The endpoint validator resolves hostnames and rejects `0.0.0.0/8`,
  `169.254.0.0/16`, IPv6 link-local/unspecified forms, and embedded IPv4
  metadata addresses. Updating an endpoint also retains an explicit empty
  credential-variable list when appropriate, so a catalog default cannot
  silently reattach an old key to a new destination. (`2b069a7bd`)
- **YOLO approval detects credential names throughout nested tool input.**
  The bounded scan recognizes environment-variable arrays, strings, and
  MCP-style maps under common aliases, and sends calls that name a well-known
  credential back for human approval. (`2b069a7bd`)
- **Patch permissions expose and enforce actual diff destinations.** The tool
  reports stripped target paths to the permission layer, understands Git
  rename/copy headers, and fails closed when a non-empty patch has no parsable
  target. (`2b069a7bd`)

### Fixed

- **Google explicit-cache setup avoids repeated rejected requests.** Failed or
  incomplete cache-creation responses are remembered briefly, so subsequent
  turns use the normal request path instead of retrying the same cache setup.
  (`2b069a7bd`)

### Changed

- **All public package and website version metadata now align to `0.319.2`.**
  (`2b069a7bd`)

## [0.317.1] — 2026-08-31

### Fixed

- **Session Catalog transaction failures preserve their primary SQLite error.** If SQLite has already closed a failed transaction, a best-effort rollback no longer replaces the underlying disk or database error with `cannot rollback - no transaction is active`.
- **Plugin declaration builds accept the existing alternate tool-input field names without invalid TypeScript narrowing.**

## [0.317.0] — 2026-08-30

### Added

- **MCP-alias tool calls now render diffs through the canonical edit/write pipeline.** Aliased MCP tool entries reuse the standard edit/write canonicalization so patch previews stay consistent with first-class tools, and pathless patch entries fall back to a generic `Update(changes)` label. (`44c3750f8`, `b316c2140`)
- **TUI tool output rendering was expanded and pinned by tests.** The tool-output surface covers more tool families, including Windows-path handling for grep output. (`7d621afbf`, `dca97cac2`)

### Fixed

- **The mailbox SSE stream can no longer stall or leak on a wedged credential check.** Mid-stream credential revalidation is raced against a 10-second timeout and the serialized delivery queue is capped at 256 pending operations; either limit closes the stream instead of letting queued event payloads accumulate while keepalives go silent forever. (`f7e306a73`)
- **The session-note hub no longer retains torn-down agents' event buses.** Contributing inboxes are reference-counted per session and the cached first-wins bus is released when the last inbox unregisters, so the process-wide singleton cannot pin a dead agent's listeners. (`f7e306a73`)
- **Release scripts split extract targets on the first colon.** (`54a969b76`)

### Changed

- **Release evidence was refreshed for 0.317.0.** Architecture report pairs, hotspot ratchets, and core-API snapshots now match the committed workspace shape. (`8ccd26450`, `a92f76477`, `f9ee6d393`, `7d8303826`)

## [0.316.3] — 2026-08-30

### Fixed

- **Patch release metadata now targets a fresh npm package graph.** The root, 34 package manifests, both apps, website package files, README highlights, `META.version`, JSON-LD metadata, and both changelog surfaces now describe `0.316.3`.

## [0.316.2] — 2026-08-30

### Fixed

- **Patch release metadata now targets a fresh npm package graph.** The root, 34 package manifests, both apps, website package files, README highlights, `META.version`, JSON-LD metadata, and both changelog surfaces now describe `0.316.2`.
- **The update path is prepared for republishing after registry/cache resolution failures.** `wrongstack update` could fail while installing the `0.316.1` CLI dependency set if npm resolved the CLI before every matching `@wrongstack/*` package version was available.

## [0.316.1] — 2026-08-30

### Added

- **Model cost tiers provide deterministic routing by expense level.** The new `modelTiers` config binds a fallback profile, spend budget, and runtime settings under named levels such as `budget`, `standard`, and `premium`; `/tier`, the TUI resource menu, and the WebUI Settings panel all edit the same table, while Kanban dispatch and subagent spawning resolve explicit model, fallback profile, tier, and session-leader choices in order. (`cdb5ec0ff`)
- **Leaders can propose or apply guarded tier switches.** Leader self-switching supports `off`, `propose`, and `auto` modes with dwell windows, max-tier ceilings, context-fit checks, and break-even savings guards so a cheaper model switch must pay for its prompt-cache warmup and cannot strand the current context. (`cdb5ec0ff`)
- **Session diagnostics expose scrubbed recovery state across CLI and browser surfaces.** `sessions doctor`, WebUI resume handlers, SimpleUI session views, TUI resume pickers, and shared secret scrubbing now surface session metadata without leaking raw secrets. (`f68855e76`)

### Changed

- **Internal barrel exports were narrowed across the workspace.** Core, WebUI, CLI, TUI, WebUI server, Tools, SAGE, Governance, ACP, SDD, primitives, WebUI protocol, WrongTrace, plug-lsp, and bench packages de-export internal-only symbols and refresh architecture evidence so public API snapshots track the smaller supported surface. (`3068168e5`, `878b698ad`, `90a85c22b`, `047f49ffe`, `dacbdf712`, `c59707eec`, `38633ee57`, `71690d6b8`, `4b686a447`, `bb5edb7c6`, `a60b8ab97`, `fe1d5e609`, `65d28f313`, `047952eea`, `97721ea02`, `29ab5a3e7`, `d14ef35ba`, `3cb23eebf`)
- **TUI drag selection now copies complete chat-history content blocks.** Selection geometry was simplified around content-block boundaries, keeping wrapped-line copy behavior intentional and covered by focused drag-selection tests. (`a91261601`)
- **Release evidence and CI ratchets were refreshed for 0.316.1.** The version bump, typecheck baselines, architecture reports, and stale-exception cleanup timeout now match the current workspace shape. (`f65bd058c`, `605c9fa6a`, `548f6b4ef`, `cf8205d9c`)

### Fixed

- **`/doctor` no longer reports WrongStack's own settings as unknown keys.** The doctor's `KNOWN_TOP_LEVEL_KEYS` whitelist had drifted behind `Config`, so fields actively written by `/theme`, `/fallback gate`, prompt variants, model tiers, Chronicle, and cloud sync could be flagged for deletion. `ConfigKeyCoverage` now fails the build in both directions, and the phantom top-level `agents` allowance is gone. (`f68855e76`)
- **The in-project config drift guard now checks every `Config` field.** `KNOWN_CONFIG_TOP_LEVEL_KEYS` is compile-checked against `keyof Config`; `themePreset`, `chronicle`, `fallbackGateSeconds`, and `modelTiers` are explicitly allowed, while repo-committed `systemPrompt` is explicitly denied because the `lite` prompt variant omits the tool-output trust boundary. (`f68855e76`)
- **Autonomous goal startup no longer leaks work after stop or timeout.** `executeTask` now receives an `AbortSignal`, WebUI goal handling propagates cancellation, and `PhaseOrchestrator.start()` avoids installing a monitor interval after a mid-start stop. (`9c431fe50`, `6e8a90409`)
- **Concurrent registry and SDD cleanup paths are more resilient on Windows CI.** Persistent process-registry writes use unique temporary filenames, and SDD board projector cleanup tolerates in-flight temp-file deletion. (`01e0286c0`, `f12bb9d52`)
- **WebUI file-handler contracts cover tree ordering and payload shape.** Focused tests now pin file-tree sorting and response shape expectations around the server file handlers. (`2210d416b`)
- **All public release surfaces align to `0.316.1`.** The root, 34 package manifests, both apps, website package files, README highlights, `META.version`, JSON-LD metadata, and both changelog surfaces now describe the same release.

## [0.316.0] — 2026-08-28

Consolidates the intermediate `0.314.0` version bump into one documented
release.

### Added

- **Provider waiting-room events now have a durable audit trail.** Model block/open events are written to JSONL, exposed through the provider-status command path, and broadcast with real-time error context so operators can see why a route is blocked or reopened. (`23de1b801`, `23fd22342`, `99a5fdbb9`)
- **Stats-driven tool auto-thinning (`tools.autoThin`).** Off by default. Opt in with `/settings autothin on` (or directly in your profile config). The pipeline observes every tool invocation via the EventBus, folds the counts into a per-tool, per-day Chronicle rollup (`tool_daily`), and — only on an explicit `/tool autothin apply` or with `applyOnBoot: true` — disables the tools that match `minInvocations` and `idleDays`. Decisions are tagged `reason: 'auto-thinned'` in `ToolsConfig.disabledToolMeta` so they survive restarts; `/tool autothin undo` re-enables only the auto-thinned subset (operator-authored disables are preserved). The in-process event-bridge Map is the fallback when Chronicle is unavailable. New: `ToolsConfig.autoThin`, `ToolsConfig.disabledToolMeta`, `AutoThinConfig`, `DisabledToolMeta`, `ToolRegistry.thinUnderused()`, `ToolRegistry.enableAutoThinned()`, `ToolRegistry.applyDisabledMeta()`, `ToolUsageSource` (hybrid Chronicle/in-process resolver), `/tool autothin {status|candidates|apply|undo|config}`, `/settings autothin on|off`, `/settings autothin-idle <days>`, `/settings autothin-min <count>`, `/settings autothin-boot on|off`. See `docs/auto-thinning.md`. (`33285dde2`)
- **WebUI session startup can recover itself.** Browser sessions now auto-resume and retry after `session_not_ready`, with lane-guard warnings emitted once instead of repeatedly interrupting the operator. (`14e70bb09`)

### Changed

- **Provider cooldowns separate quota exhaustion from ordinary temporary blocks.** Quota failures escalate deliberately, ordinary blocks expire sooner, and the waiting room stops over-quarantining routes that should be retried. (`4d1579ba1`, `37767a0ce`)
- **WebUI orchestration state is scoped per active session.** Todos, tasks, plan state, tab-slot recycling, orchestration stores, and session fixtures now preserve ownership across multi-tab workflows. (`f3d5a9c90`, `a3b1328d4`, `25ef39037`, `6fd692bbf`, `c8ff4aa83`, `6964de260`, `9f4ff2e1e`, `9adeac00e`)
- **ActivityBar navigation is denser and session-oriented.** Worktrees moved under Changes, Office Map moved under Roster, and retired officemap literals were removed from tests and architecture evidence. (`04f4d6494`, `42e5dde5d`)
- **TUI statusline chips are grouped into four semantic rails.** The workspace reorder is covered by refreshed fixtures so field positions remain intentional. (`426738354`, `30e686cd6`)
- **All public release surfaces align to `0.316.0`.** The root, 34 package manifests, both apps, website package files, README highlights, `META.version`, JSON-LD metadata, and both changelog surfaces now describe the same release.

### Fixed

- **Pruned agent registry rows rebuild from HTTP heartbeats.** Heartbeats can restore missing rows with registration guards instead of leaving provider status stale. (`7ea907627`, `22371a7b1`)
- **Mailbox serve startup output keeps stdout and stderr separated.** `TerminalRenderer.writeStderr()` routes banners correctly and tests cover the stream split. (`7b156dd67`, `2c2697cde`, `3c79dae34`)
- **Mailbox MCP credentials require an explicit project id.** Credential issuance now fails closed when the project boundary is missing. (`9d421d46a`)

## [0.313.1] — 2026-08-25

### Added

- **The TUI now ships with 50 compile-checked theme presets.** Fourteen new palettes — Matrix Green, Amber CRT, Cyber Noir, Cobalt Monochrome, Blood Moon, Cobalt2, Shades of Purple, Flexoki Dark, LaserWave, Andromeda, GitHub Dark Dimmed, Hyper Snazzy, Tokyo Night Moon, and Gruvbox Dark Hard — are available through the same persisted `/theme` picker and boot-time adapter as the existing themes. (`a0cf228d1`)
- **`/lite`, `/full`, and `/sidebar` provide persistent TUI layout control.** `/lite` switches to a minimum statusline and full-width history, `/full` restores the detailed rail and sidebar, and `/sidebar` can toggle, show, hide, or report the right rail independently. Changes apply immediately and persist through the normal settings path. (`a0cf228d1`)
- **Model switches are synchronized across browser surfaces.** The server protocol now broadcasts `provider.model_switched`; WebUI updates its active provider/model state and conversation, while SimpleUI exposes the switch in its activity state. (`a0cf228d1`)

### Changed

- **Provider retries now give transient failures a realistic recovery window.** The fallback schedule moves from 1s → 2s → 4s to 4s → 8s → 16s with bounded jitter, while an explicit provider `Retry-After` remains authoritative. (`a0cf228d1`)
- **Core and Tools builds share cross-subpath runtime identity.** esbuild splitting keeps error classes and process-wide registries from being duplicated into every published subpath bundle, so built installs preserve `ProviderError` classification, fallback decisions, and singleton ownership just like source execution. Duck-typed error guards remain as a defensive compatibility boundary. (`a0cf228d1`)
- **All public release surfaces align to `0.313.1`.** The root, 34 package manifests, both apps, website package files, README highlights, `META.version`, JSON-LD metadata, and both changelog surfaces now describe the same release.

### Fixed

- **The provider waiting room is enforced at the wire boundary.** Every leader and subagent call now skips quarantined provider/model pairs before opening a socket, records terminal failures and successes exactly once, preserves provider error metadata across bundle boundaries, and rotates fallback chains for network-shaped failures instead of repeatedly selecting a known-bad route. (`a0cf228d1`)
- **WrongProxy connection failures fail open without racing the retry.** A refused proxy connection disables the live proxy route, waits for the bounded provider rebuild chain to settle, and then retries through the direct provider endpoint without requiring a restart. (`a0cf228d1`)
- **Identical user input is deduplicated only as a short accidental burst.** The agent suppresses byte-identical submissions for 1.5 seconds to catch terminal re-entry and client resubmit loops, but deliberate repeats after the window — and retries after failed, aborted, or thrown runs — execute normally. (`d32220358`, `7c2e966c0`)

## [0.313.0] — 2026-08-25

Consolidates the intermediate `0.311.0` and `0.312.0` version bumps into one
documented release.

### Added

- **WrongProxy and WrongTrace now form one optional local integration across CLI, TUI, WebUI, and subagents.** Provider base URLs can be rerouted through the external daemon while `@wrongstack/wrongtrace` supplies a public, zero-hard-dependency adapter with JSON-RPC 2.0 IPC, MCP, and HTTP fallbacks. The daemon is discovered at `http://localhost:3444` by default, and every path remains fail-open when it is absent. (`bdac3d320`, `e5566e462`, `b21b3ed87`)
- **WrongTrace guardrails cover every host that can execute mutating tools.** CLI leaders, fleet workers, standalone WebUI sessions, and runtime light subagents share reference-counted file-lock hooks, typed decision telemetry, persisted gate counters, a bounded atlas/friction prompt digest, and completion telemetry without introducing a startup or availability dependency. (`fb9578afc`, `afe2257d6`, `ef6261e27`, `c2c6f8b11`, `8f52191f2`)
- **The TUI can select and copy transcript text by dragging in its default managed-mouse mode.** Release commits the selection to the clipboard, the rail shows the selected band, wrapped card rows recover their source text correctly, gutters are clamped, and scrolling cancels stale selections. A new `static` animation style also provides a motionless working indicator. (`363269bb1`, `0e8afde27`, `18fdccb97`, `52ed22da7`, `2e02feab2`, `9c0b617d2`)
- **Provider health is visible in WebUI Connections.** The panel consumes the live provider-health WebSocket state instead of maintaining a parallel snapshot path. (`131c016ac`, `7b99e42b4`)

### Changed

- **WrongProxy configuration applies to the live provider immediately.** Switching providers or changing proxy settings rebuilds routing from the previous effective baseline, so enabling, disabling, or editing the URL does not require a restart and does not stack rewrites. (`d80f81b17`, `fb0b6a034`, `4744f6094`, `fcfd4ea80`)
- **All release surfaces are aligned to `0.313.0`.** The root, 34 package manifests, both apps, website package files, README highlights, `META.version`, JSON-LD `softwareVersion`/`dateModified`, and both changelog surfaces now describe the same release.

### Security

- **`git_autocommit` is fenced to caller-owned paths.** Scoped commits use explicit pathspecs, preserve foreign staged files, reject concurrent drift, and no longer stage the whole shared tree when the index is empty unless `autoStage` is deliberately enabled. (`7b90b0f48`, `4d1f94d61`)

### Fixed

- **PowerShell tool transport uses the native encoded-command contract.** Wrapped scripts are sent as UTF-16LE Base64 through `-EncodedCommand`, avoiding BOM, stdin, and quoting failures seen with `-Command -`. (`37185db1`, `9af478a29`)
- **Transient webhook outages recover automatically.** The circuit breaker enters a timed half-open state after its cooldown instead of suppressing every future delivery until a manual reset. (`d9038d2a8`)
- **Persisted TUI queues survive startup hydration.** The mount-time empty state can no longer clear `queue.json`, and messages added while hydration is pending are flushed after the stored queue is restored. (`1ca2990be`, `2c410551e`)
- **Desktop and session state preserve the latest run.** Final-only assistant text is deduplicated per run rather than against older conversation history, final window geometry is saved before shutdown, mailbox badges honor session affinity, and `/context` no longer counts tool-result frames as user turns. (`2802bd55f`, `8dec7ac7d`, `4252d7bea`, `ec6a11637`)
- **Hard billing-limit responses rotate through fallback correctly.** Provider `403`/`429` responses that explicitly report exhausted quota are classified as `quota_exhausted` instead of generic authentication or rate-limit failures. (`de1f7e062`)

### Documentation

- **WrongTrace integration is documented end to end.** New [`docs/wrongtrace.md`](docs/wrongtrace.md) covers the optional external daemon, the IPC → MCP → HTTP routing matrix, the deliberate `lockFile` HTTP-only exception, the full REST surface, agent helpers, executor hooks, test-suite map, troubleshooting, and file map. The README, docs index, package table, website feature story, and sitemap all link to the same integration contract. (`fb0b6a034`, `07b89779a`, `f66e25866`)

## [0.310.1] — 2026-08-23

### Fixed

- **Anthropic usage accumulation keeps cache telemetry across `message_start` → `message_delta`.** `packages/providers/src/presets/anthropic.ts` previously rebuilt `state.usage` from scratch on `message_start` (resetting cache fields to a freshly-derived aggregate), then replaced it again on `message_delta` with only `output_tokens`, silently zeroing cache read/write figures that had already arrived. Worse, the TTL-split derivation (`cacheWrite5m + cacheWrite1h`) ran unconditionally on every event, so a partial-TTL gateway that reported the 5m bucket on `message_start` and the 1h bucket on `message_delta` had the later event overwrite the prior. A new `mergeAnthropicUsage()` helper unifies both paths: present fields overwrite, absent fields keep the previously-seen value, and a new `cacheWriteFromAggregate` provenance flag (set once any event supplies the explicit `cache_creation_input_tokens` aggregate) prevents the TTL-split sum from clobbering an authoritative aggregate when only a partial split is reported later. Absent buckets stay absent on the canonical `Usage` — the split-presence signal downstream consumers rely on is preserved instead of being fabric­ated to zero. Backed by a new 195-line `presets-anthropic-openai-google.test.ts` covering message_start, message_delta, partial-TTL, mixed-shape, and authoritative-aggregate-pinning scenarios.
- **TUI sidebar scroll clamp accounts for the new cache card.** `packages/tui/src/reducers/workspace-panels.ts` raised `computeMaxSidebarScroll`'s prompt-cache reservation by 11 rows so a sidebar with the full cache card (header + hit line + meter + provider-hit + read + write + 5m/1h TTL split + saved USD + coverage + margin) plus the system vitals card still scrolls to its last item instead of clipping the bottom row. `sidebar-scroll-keys.test.ts` and `sidebar-worklist-wrap.test.tsx` were updated to pin the new scroll maxima (110 → 121, 87 → 98, 95 → 106, 1 → 12).
- **Anthropic-compatible gateway usage on `message_delta` is now merged, not replaced.** Gateways that send the full `usage` object on the final event (not just `output_tokens`) used to lose everything but `output_tokens` because the handler wrote `state.usage = { ...state.usage, output: u.output_tokens }` — early cache telemetry was wiped. The merge now also reads `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, and the `ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens` split when a non-canonical gateway reports them on the final event.

### Added

- **TUI prompt-cache card surfaces the 5m/1h TTL split and a saved-USD row.** `packages/tui/src/components/sidebar-content.tsx` now renders `write 5m` and `write 1h` rows under the cache card when both TTL buckets are present, plus a green `saved ~$N.NN` row whenever priced cache reads have actually saved money (zero rows when they haven't — no zero-fabrication). The primary cache chip in `packages/tui/src/components/status-bar-rails.tsx` also grew compact `r<read> w<write>` figures after the hit-ratio and a `~$saved` tail when `cache.savedUsd > 0`, with the `r`/`w` prefixes chosen to distinguish cache tokens from the ↑/↓ request tokens of the tokens chip. `StatusBarRailBuildParams.cache` gained `readTokens`, `writeTokens`, `savedUsd`, and the optional `cacheWrite5m` / `cacheWrite1h` TTL split.

### Changed

- **All release surfaces are aligned to `0.310.1`.** The root and 33 workspace manifests, both apps, the website `package.json` + `package-lock.json`, and `website/src/lib/utils.ts` `META.version` and JSON-LD `softwareVersion` now match the published manifests.

## [0.310.0] — 2026-08-23

### Changed

- **WebUI context-breakdown token figures now match the CLI/TUI estimator.** `webui-server/src/server/token-estimator.ts` delegates to `@wrongstack/core/utils`' calibrated basis (3.5 chars/token + EWM calibration) instead of a private 4-chars/token heuristic, so the number shown in the browser's context debug view is the same number compaction and the context bar decide on. User-visible shift: mixed-content conversations read ~14% higher than before (4/3.5 ≈ 1.143), and empty blocks now floor at 1 token — both intentional conservatism. The canonical ReDoS regex guard also moved to a new dependency-leaf `@wrongstack/primitives` package, unifying three drifted copies (core/tools/kanban) that existed only because kanban sits below both in the workspace DAG. (`07577d9f8`)
- **All release surfaces are aligned to `0.310.0`.** The root and workspace manifests, both apps, the README highlights, and the website metadata, JSON-LD, and release changelog now match the published manifests. The interim `0.309.1` and `0.309.2` bumps are folded into this documented release.

## [0.309.0] — 2026-08-20

### Added

- **Third-party plugins now have a supported SDK and end-to-end lifecycle.** The new `@wrongstack/plugin-sdk` package publishes the bounded runtime, safe JSON handling, credential-pattern checks, ReDoS guards, local binary controls, LLM helpers, and sandbox primitives previously internal to the official plugin bundle. Trust-aware discovery, installation, validation, loading, and external-plugin wiring make those extensions usable without bypassing WrongStack's existing plugin boundary. (`276cceca5`)
- **Explore Companion performs read-only background investigation for the leader.** State-triggered probes can inspect unread files, recover from zero-hit searches, follow todo changes, and return findings through the mailbox without blocking the main agent or consuming its spawn budget. (`968f825e2`)
- **Reasoning effort is controllable from both CLI and WebUI.** The new `/effort` command and model-aware settings selector share the core `ReasoningEffort` vocabulary, persist the chosen level, and expose only the options supported by the active model. (`336377631`, `4930f962b`, `4f4e137a9`)
- **Director workflows can run deterministic mutation testing.** `mutation_test` creates bounded mutation plans and assigns them to the dedicated Chaos Monkey role, with test execution, restoration, and reporting covered by unit and integration tests. (`691642c0d`)

### Changed

- **Background subagents receive a graceful-finish lifecycle.** Cleanup now asks eligible workers to finish and waits within a bounded window so Chimera and coordination results are not discarded at the session boundary. (`2ac39c555`, `19cf48a04`, `07e6de24e`)
- **Effort and thinking levels propagate consistently across provider families.** OpenAI, Google, Anthropic, compatible endpoints, and policy adapters use exhaustive mappings and preserve documented as well as explicitly unknown capability states instead of silently dropping effort. (`9ee04dd27`, `40a1a474b`, `1448c279b`)
- **All current public release surfaces are aligned to `0.309.0`.** The root, 31 packages, 2 apps, README highlights, website metadata, JSON-LD, and both changelog surfaces now report the same release line.

### Fixed

- **Mailbox and fleet status traffic is lower-noise and safer to render.** Send payloads are projected to prose, status mail is gated accordingly, and duplicate fleet pulses are coalesced before publication. (`1f80752ab`)
- **Kanban goal metrics respect direction.** Verification now distinguishes higher-is-better from lower-is-better targets, and the direction is preserved through task types, tool schemas, prompts, and WebUI dispatch. (`d66f424d3`, `772900287`)
- **Stopping a goal cancels its in-flight task.** The task executor now receives the goal's abort signal and returns an interrupted node to `pending` rather than letting work continue after stop or timeout. (`9c431fe50`, `a618cb805`)

## [0.308.6] — 2026-08-18

### Changed

- **All 24 bundled skills now follow the v2 structure.** Each skill in `packages/core/skills/` carries an explicit `## Out of scope` section (in-lane guardrail) and a `## Before returning` checklist (in-lane enforcement). The two sections answer "what is this skill NOT for" and "did the model stay in scope," addressing the failure mode where models drift past a skill's stated rules. Versions bumped accordingly: `1.0.0` → `1.1.0`, `1.1.0` → `1.2.0`, `1.2.0` → `1.3.0`, `2.0.0` → `2.1.0`. The four unversioned skills (`design-system`, `multi-agent`, `wrongstack-kanban`, `wrongstack-mailbox-mcp`) now carry a `version` field, and `docs/SKILL-TEMPLATE.md` codifies the standard structure for future skill authoring.
- **All release surfaces are aligned to `0.308.6`.** The root and workspace manifests, both apps, the README highlights, and the website metadata, JSON-LD, and release changelog now match the published manifests.

## [0.308.0] — 2026-08-15

### Added

- **Vector Memory adds local semantic recall alongside SAGE.** A dedicated `@wrongstack/vector-memory` package provides local ONNX embeddings, SQLite-backed storage, lifecycle wiring, runtime tools, and WebUI/SimpleUI panels without replacing the existing lexical memory path.
- **Prompt journal evidence is now inspectable and recoverable.** Runtime prompt captures can be exported through the WebUI, while bounded persistence and recovery keep useful prompt history available across session failures.

### Changed

- **Vibe Protocol orchestration and codebase proof are wired through the runtime.** The SDD, CLI, tool registry, and instruction surfaces now share the implementation path, with checked-in proof artifacts and targeted tests covering the integration.
- **All root, package, app, and website release surfaces are aligned to `0.308.0`.** The website metadata, JSON-LD, README highlights, and release changelog now match the published workspace manifests.

### Security

- **Plugin execution boundaries received another hardening pass.** Runtime sandboxing, ReDoS guards, path targeting, prompt-firewall handling, and security-sensitive plugin tests now cover more hostile inputs and failure paths.
- **The install-script allowlist explicitly documents `sharp`.** It is reviewed as the optional `@huggingface/transformers` image backend used by Vector Memory and remains covered by the lockfile freshness guard.

## [0.307.0] — 2026-08-15

### Added

- **The WebUI file manager is now a complete project workspace.** Files and folders can be created, deleted, renamed, and moved through the shared protocol; the tree refreshes from a live project watcher, supports bounded fuzzy search and size sorting, and shows Git decorations. Open tabs survive refresh as path-only stubs, reads reject binary or oversized files, and errors stay inline without destroying the surrounding tree. Monaco remains off the initial bundle until an editor is opened, while SimpleUI gains syntax highlighting, Tab indentation, and keyboard save. (`bb257a2f1`, `d6170dfe0`, `793480c17`)
- **Fallback routing can be diagnosed before an outage.** `/fallback doctor` reports effective depth, provider diversity, credential gaps, and unhealthy chains; `/fallback test [errorKind]` simulates the exact rotation order; and `/fallback gate` makes the hand-off countdown configurable or immediate. (`46179cf05`)
- **The SDD flow supports deliberate revision instead of one-way progression.** Spec, implementation, and task-review phases can be rewound safely, requirement changes invalidate stale downstream artifacts, the WebUI exposes interview progress and quick replies, and the generated task graph remains tied to the active SDD/Kanban lifecycle. (`b7547ea6a`)
- **TechStack analysis now reports policy risk as well as versions.** Dependency enrichment classifies license obligations, detects cross-workspace version misalignment, persists bounded finding caches, and produces SPDX 2.3 package records with the required declaration and supplier fields. (`b7547ea6a`, `067edefa2`)
- **Seven code-intelligence operations are first-class runtime capabilities.** Clarification, repository skeletons and maps, AST replacement, impact analysis, targeted tests, and AST security scans are now present in the capability manifest and system instructions with their intended usage patterns. (`66eee39ac`)

### Changed

- **Goal and delegate orchestration now fails closed and reports real lifecycle state.** Goal phases default to `stopOnFailure`, empty task plans are rejected, delegate-started telemetry is emitted only after a successful spawn, the launch preface no longer overwrites `TaskSpec.description`, and context-overflow recovery can defer the primary probe instead of spending work on a request that cannot fit. (`9e44e5f55`, `dd4a863ca`)
- **Idle live surfaces do substantially less repeated work.** Session/HQ snapshots, worktree, collaboration, and goal broadcasts use change fingerprints; SDD polling checks a cheap updated-at index before loading a board; and a bounded keep-alive still prevents healthy sessions from aging out of HQ. (`b1f850c01`)
- **Prompt and environment caches follow every input that changes rendered instructions.** Project overlay fingerprints, host/subagent audience, model context size, date rollover, mode, project root, and the instruction-directory override now invalidate the relevant cache instead of serving stale prompt layers. Capture windows are LRU-bounded for long-lived daemons. (`93b8fcec2`, `d57b74069`, `ba7719d14`, `360cedad1`, `861581f82`, `3e730afca`)

### Security

- **External Telegram text is fenced as untrusted evidence.** The mailbox bridge scrubs credentials, neutralizes embedded delimiters, and wraps inbound bodies so remote text cannot masquerade as agent instructions. (`f6a93201c`)
- **YOLO shell approval no longer bypasses the protected state-root boundary.** Redirection, `tee`, `cp`, and `mv` writes targeting trust, auth, local config, or key files are classified as destructive even when issued through a shell. (`7da73ef78`)
- **WebUI file launches validate the canonical target.** The project root and requested path are resolved before containment and metacharacter checks, including symlink targets, and the watcher is non-persistent so it cannot keep an otherwise idle server alive. (`a7fda02c2`, `4dfa2b90c`)
- **`wstack mcp serve --tools` can no longer silently widen exposure.** Both space-separated and equals forms preserve the requested whitelist, while a missing list fails with usage guidance instead of falling back to the default tool set. (`d3949984d`)

### Fixed

- **Session and provider recovery preserve usable state across failures.** Fallback diagnostics share the runtime chain semantics, session truncation and replay retain lifecycle markers, resumed writers finalize in the correct order, and review evidence accepts recoverable JSON fences without promoting disk-failed findings. (`46179cf05`, `85977b7e3`)
- **Mailbox unread counts respect session affinity.** Messages stamped for another session no longer inflate a leader's unread total when the same message would be rejected on read. (`8ff99d881`)
- **Failed WebUI sends mark the initiating bubble.** The request id now travels through `run.result`, so an error updates the stable user message rather than leaving it looking successfully submitted. (`dc16d5813`)
- **Chronicle migration metrics are idempotent and failure-safe.** Legacy JSONL partitions fold only at the recorded import boundary, pre-import aggregates rebuild once when needed, malformed events roll back within savepoints, quarantined families remain inspectable, and journal handles close on every refresh path. (`cd8f326db`, `c09d39e74`, `02c51cad8`)

## [0.306.4] — 2026-08-13

Aligned the release surfaces — root and per-package manifests, both apps, the website
`META.version` and JSON-LD `softwareVersion`/`dateModified`, the website changelog
entry, and the README — to a single version line. The substantive 0.306.3 work is
re-published unchanged under this version.

### Added

- **A card that cannot pass verification now parks instead of wedging the board.** The completion gate could refuse forever: `finalizeTaskCompletion` put a refused card back in `review` and the managed `transitionTask` threw, and neither counted anything — so the same card could be re-verified indefinitely, and on a managed board nothing downstream of it could start. Refusals are now counted on the card, and at the second one (`completionGate.maxVerificationAttempts`, default 2) it is parked with the refusal's own words attached. Only refusals the next call cannot fix spend the budget: a missing `transitionAction` or an exceeded WIP limit still just tells you what to pass. A waiting card is told its blocker is parked and will not clear itself, rather than reporting the same "not completed yet" as a dependency that is merely still running.
- **Agents now walk a cost ladder before writing new code.** Delete instead, does it need to exist, does the repo already do it, does the language, platform, or an installed dependency do it, is it one line — and only then the minimum that works. It carries an explicit limit: the ladder trims what the agent invented, never what the user asked for, and reuse claims need a named file, symbol, or package rather than recollection. Wired into the default, pro, and lite identities plus the subagent baseline, and enforced as a review dimension in the code-reviewer agent.

## [0.306.3] — 2026-08-13

Initial release of the parked-verification and cost-ladder surfacing (republished
under 0.306.4 to keep build, package, and website surfaces in lockstep).

### Added

- **A card that cannot pass verification now parks instead of wedging the board.** The completion gate could refuse forever: `finalizeTaskCompletion` put a refused card back in `review` and the managed `transitionTask` threw, and neither counted anything — so the same card could be re-verified indefinitely, and on a managed board nothing downstream of it could start. Refusals are now counted on the card, and at the second one (`completionGate.maxVerificationAttempts`, default 2) it is parked with the refusal's own words attached. Only refusals the next call cannot fix spend the budget: a missing `transitionAction` or an exceeded WIP limit still just tells you what to pass. A waiting card is told its blocker is parked and will not clear itself, rather than reporting the same "not completed yet" as a dependency that is merely still running.
- **Agents now walk a cost ladder before writing new code.** Delete instead, does it need to exist, does the repo already do it, does the language, platform, or an installed dependency do it, is it one line — and only then the minimum that works. It carries an explicit limit: the ladder trims what the agent invented, never what the user asked for, and reuse claims need a named file, symbol, or package rather than recollection. Wired into the default, pro, and lite identities plus the subagent baseline, and enforced as a review dimension in the code-reviewer agent.

## [0.306.2] — 2026-08-12

Consolidates the intermediate `0.306.1` package bump.

### Added

- **The TUI now opens runtime resources as native interactive menus.** Models, prompts, skills, memory results, sessions, worktrees, branches, themes, tools, cron jobs, and agents share a searchable picker contract with keyboard and mouse navigation instead of falling back to text-only lists. (`291559eff`, `b04b37796`)
- **Theme selection includes a live preview.** The picker renders representative status, transcript, diff, code, and panel colors before a preset is applied, while shared windowing keeps large pickers responsive. (`4802564da`)
- **SAGE relationships are queryable without leaking session-scoped memories.** Remembered items maintain explicit relationship edges, related-candidate traversal follows the graph, and tool, middleware, and MCP paths preserve the caller's session boundary. (`291559eff`)
- **Memory injected into prompts is fenced as evidence, not instructions.** Shared sanitization and tagged rendering keep stored project text from masquerading as higher-priority agent guidance. (`291559eff`)

### Security

- **Project daemons no longer hand their IPC token to other local accounts on Windows.** Every project server writes a metadata file carrying the per-process token that gates its IPC surface, with `mode: 0o600` — which Node honors on POSIX and ignores on Windows, where the file instead inherits the parent directory's ACLs. The endpoint excludes nobody on Windows either, so the token was readable by any local account. Mailbox, Chronicle, SAGE, Kanban, and Codebase Index now strip inherited ACEs and grant the owner alone; Session Catalog already did. Verified by reading the resulting ACL on a live daemon, not by inspection. (`4802564da`, `c7b1b39a8`)
- **`audience: "leaders"` mail can no longer be read by naming another agent.** The store's leaders-only gate keys off the query's `unreadBy` identity, and `isMailboxLeader` accepts any identity whose base segment is `leader` — so a body-supplied `unreadBy: "leader@…"` made the store answer as a leader. A worker credential holding only `mail.read.self` could read leader-only mail. `unreadBy` is now derived from the authenticated actor; only the legacy bearer-token operator may read on another actor's behalf. (`4802564da`)
- **Credential rotation no longer extends a lifetime or revives a revoked credential.** Rotation defaulted the new TTL to the per-kind maximum, so a deliberately short-lived token silently became a 7-day one on first rotation; it now carries the predecessor's lifetime forward (still clamped, so it can only narrow). Rotating a revoked credential minted a fresh active one for the same principal and logged it as routine — revocation now blocks rotation, and undoing it must be an explicit re-issue. (`4802564da`)
- **Untrusted mailbox boundaries now bound the work a single request can ask for.** Query `limit` was validated only as "a positive integer", and batch acknowledgement had no length cap at all — `ackMany` applies a whole batch inside one `BEGIN IMMEDIATE`, so one request could hold the project's only write lock past every other surface's `busy_timeout`. Both are capped at 500 across the HTTP bridge, the boundary codecs, and the MCP adapter, from one shared constant. The MCP schema's `maximum` bounded nothing at runtime (MCP does not validate `inputSchema`) and is now enforced in code. (`4802564da`)
- **A mailbox message can no longer task a subagent.** The tech-stack consumer acted on an `assign` addressed to it from any sender — and the mailbox is a shared bus. The body chose a file path and was pasted verbatim into the task of a freshly spawned agent holding `read`, `fetch`, and `mailbox`. It now accepts only the dep-watcher family, validates the path on every extraction branch (no absolute paths, no parent escapes, recognised manifests only), and fences the notification body as data rather than instructions. (`4802564da`)

### Fixed

- **SimpleUI no longer throws away the newest mail.** The server sends query results newest-first, so capping with a trailing slice kept the oldest entries and dropped exactly the new mail the panel exists to show — measured at 30 messages lost on a 130-message payload, which the `unreadOnly` path can reach. The WebUI store had already fixed this; SimpleUI carried the unfixed copy. (`4802564da`)
- **`to: "@session"` over the mailbox HTTP bridge answers 400 instead of 500.** The alias needs a session id to expand, and without one `normalizeRecipient` threw a bare `TypeError` that the router classified as an internal error, leaking the message. It is now expanded for credential actors that carry a session and refused with a usable validation error otherwise. (`4802564da`)
- **Kanban and Codebase Index daemons no longer leave a window with no metadata file.** Both wrote a temp file and renamed it, falling back to `rm(target)` and retrying — and on Windows that fallback is the common path, because the rename fails whenever a reader holds the destination. A client reading between the `rm` and the retry concludes there is no daemon and spawns a second one. Both now use `atomicWrite`, which never unlinks the destination. (`c7b1b39a8`)
- **The package-outdated watcher's documented sender gate is now applied.** `techStackAgentId` was declared and documented but never read — it appeared exactly once in the codebase, in its own type — so any sender could drive high-priority notifications, including broadcasts to every agent. Both mailbox consumers now match the sender as an agent family, so a worker spawned as `tech-stack-<manifest>` still passes while an unrelated peer does not. (`4802564da`)
- **Native terminal selection is recoverable without giving up managed history.** `/mouse native` now releases mouse tracking for ordinary click-drag copy, while paging keys continue to navigate WrongStack's bounded transcript; `/mouse on` or `/mouse off` restores application ownership. (`291559eff`)

### Changed

- **Mailbox read paths are served from indexes instead of materializing the store.** `unreadCount` ran on every pre-tool hook and re-read every message plus the whole receipt table to return an integer (measured 19.1 ms → 4.4 ms over 3,000 messages); the HTTP bridge answered "is this message mine?" on every `ack` by listing the actor's entire mailbox (30 ms → 0.48 ms, 5,000 rows → 3) and now asks by message id; and each agent heartbeat cost a full roster round-trip per attached surface, which only registration now pays. (`4802564da`)
- **Owner-only file hardening moved to `@wrongstack/persistence`.** It sat in `@wrongstack/core/security`, out of reach of `@wrongstack/kanban`, which depends only on persistence and cannot depend on core without closing a cycle. `@wrongstack/core/security` re-exports it, so no caller changed. (`c7b1b39a8`)
- **Git process execution now has a reusable service boundary.** Slash commands and TUI resource menus share one bounded, hidden-window runner instead of importing command-layer code across the architecture boundary. (`b04b37796`)

## [0.306.0] — 2026-08-12

### Added

- **Interactive launches now make the system-prompt trade-off visible.** The startup flow offers Lite, Standard, and Pro variants with estimates derived from the same resolved instruction layers used at runtime, persists the choice, and keeps non-interactive and explicitly pinned launches prompt-free. (`d6e6401f0`)
- **Chimera findings now carry machine-checkable evidence.** Reviews can emit structured findings, cited paths and code anchors are checked against the live working tree before they can drive a cascade, and reports retain lifecycle and per-check evidence records for later audit. (`d6e6401f0`, `e7ebcc45e`)
- **`gitignore-guard` keeps generated artifacts out of commits.** The new first-party plugin watches writes and edits, suggests a matching ignore rule by default, can append it when configured, respects nested `.gitignore` files, and never writes outside the project root. (`bca834e37`)

### Changed

- **Kanban completion now trusts fresh verifier coverage without trusting stale evidence.** Verification reports record the criteria they actually passed; the Done gate requires complete id and description/type fingerprint parity with the current card, while `tickChecks` can settle manual criteria in the same transition through one shared preflight and mutation contract. (`a3d95e3d4`, `8f6ba1b31`)
- **Chimera reviews can use their own fallback ladder.** `extensions["wstack-chimera"].fallbackModels` and `fallbackProfile` are resolved ahead of the session chain, deduplicated by provider/model, and applied consistently to review and cascade execution. (`3b59b531b`, `e7ebcc45e`)
- **Project jargon ranks real concepts ahead of incidental identifiers.** Definition extraction is sentence-bounded, repeated mentions add a capped confidence bonus, and the SAGE mirror and model-facing glossary now share the same confidence/freshness ordering. (`7e2a8f92b`, `2ca29a484`)
- **The public plugin inventory is now 73 managed plugins:** 6 core plugins, 65 suite plugins, and 2 bridges.

### Fixed

- **`/settings` no longer overflows or leaves garbled rows on short terminals.** The TUI derives its visible window from the real viewport, input height, wrapping width, headers, and bottom chrome, caps the picker, and keeps filtered results centered while scrolling. (`eedabdc70`, `7ca824cf4`)
- **HQ help reaches the HQ dispatcher.** `wstack hq --help`, token help, and audit help are no longer intercepted by the global alias/short-circuit path, and the browser token gate points to the correct one-time-secret command. (`f05d63d3f`)
- **Review cascades no longer advance on phantom or mismatched proof.** Claimed command exits are compared with orchestrator-observed results, evidence status is persisted, and failed or missing proof stops the re-review ladder instead of being treated as a verified fix. (`d6e6401f0`, `e7ebcc45e`)

## [0.305.1] — 2026-08-11

### Added

- **The TUI now ships with 35 persistent theme presets.** `/theme` opens an interactive picker or accepts a preset id directly, and the selected palette is saved to the active profile. The expanded token system covers panels, borders, transcript roles, monitor overlays, syntax highlighting, and diff washes instead of recoloring only a handful of accents.
- **`wstack doctor --daemons` makes project services observable without waking them.** It reports Kanban, SAGE, Chronicle, Mailbox, Session Catalog, and Codebase Index endpoints as `live`, `stale`, or `stopped`, includes the owner PID when metadata is available, and `--clear-stale` removes only endpoints that a fresh probe still proves dead.
- **Project-daemon ownership and recovery now have one documented contract.** `docs/project-daemons.md` records bind-before-store election, private endpoint permissions, stale-socket reclamation, graceful feature degradation, diagnostics, and manual recovery.

### Changed

- **Per-project daemons now share one endpoint election primitive.** Kanban, SAGE, Chronicle, Mailbox, Session Catalog, and Codebase Index bind through `bindProjectEndpoint`: the bind elects the sole owner, Unix endpoint directories are private (`0700`), sockets are owner-only (`0600`), and a losing contender exits without opening a second writer.
- **HQ's operational surfaces received a broad visual and interaction pass.** Cockpit, Control, Fleet Map, Live Console, Mailbox, and Alerts now share the refreshed console shell and responsive styling, with focused view coverage for alert badges, control state, fleet/Kanban/mailbox panels, and the application shell.

### Fixed

- **A dead Unix daemon no longer leaves the project permanently wedged.** On `EADDRINUSE`, the shared binder probes the endpoint, preserves a live owner, and reclaims only an unresponsive stale socket before retrying with a bounded race-safe loop. Windows named pipes keep their platform-specific no-stale-file behavior.
- **An optional Kanban projection can no longer abort CLI startup.** Session hydration records the degradation, returns `null`, and emits one renderer-visible notice with the daemon diagnostic command; todos, plans, and tasks remain available even when board synchronization is down.
- **ACP terminal teardown is explicit and idempotent.** `TerminalServer.dispose()` releases child processes, detaches the host abort listener, supports `Symbol.dispose`, and rejects post-disposal terminal creation so stale references cannot spawn orphan processes.
- **Reconnects stop retaining dead sockets and session state.** Desktop agent-bridge and WebUI connection paths detach message handlers, clear reconnect timers, and fence late events by socket generation; ACP session shutdown now disposes its terminal server on every close path.

## [0.304.0] — 2026-08-11

### Added

- **What a roster agent learned is now scored against what actually happened.** Every completed task is scanned for the directives it exercised — matched on the anchors capture already extracts (exact commands, paths, package names) — and each one takes that task's success or failure onto its own record (`applied=N; wins=M` on the entry). Attribution runs *before* capture, so a directive written by a task cannot open its record with a win it did nothing to earn, and a cancelled task is not scored at all. The record then decides what eviction drops first, whether a taught near-duplicate may replace an existing rule, and which directives the distillation pass is told to keep.
- **A directive that keeps failing is retired.** After eight applications below a 0.3 success rate it stops being injected, is scrubbed out of the skill addendum and consolidated document it had been distilled into, and is logged to `.wrongstack/agents/<role>/quarantine.md` (local) rather than deleted — a rule can be right about a project that has since changed. If the agent writes it again it re-enters with a fresh record and gets a retrial.
- **`/agent-improve <role> show` and the WebUI Self-Learning tab report learning quality, not just volume**: directive hit rate, how many directives have never been exercised, a hit-rate chip per role in the list, a Retired section, and a `loaded` badge plus affinity score per skill. New `agent-roster.quarantine` message; `agent-roster.skills` now carries `score`/`eager`/`eagerLimit`.
- **Blocked work now explains itself on every surface.** SimpleUI, TUI, and WebUI todo rows carry the dependency that is holding them back instead of showing an unexplained blocked state.
- **Last-resort fallback breadth is configurable.** `fallbackMaxLastResortCandidates` bounds how many emergency candidates may be appended, is visible in `/fallback`, and is validated by config doctor.

### Changed

- **The leader's roster menu describes what each agent does.** It was built from the first 80 characters of each role prompt — every one of which opens `You are the X agent. Your job is…`, so a third of each line was boilerplate and the distinguishing half was truncated. It now renders the curated `capability.summary` the catalog already writes for all 75 agents and the dispatcher already routes on. Measured before the change: of 77 roles offered, 10 had ever completed a task and 2 accounted for 73% of all captured learning, while `database`, `backend`, `frontend`, `devops` and `android` had never once been chosen.
- **`spawn_subagent` leads with `description` instead of `role`.** Passing a role skips dispatch entirely, so a half-remembered id silently cost the specialist; the schema and usage hint now say so.
- **Skill ranking no longer treats failure as evidence of relevance.** The success rate skipped Laplace smoothing when a skill had no outcomes, so ten straight failures scored above an untried skill, and a per-load bonus paid a skill for having been selected — a loop. Ranking is now centred on a neutral prior, decays outcome evidence with a 30-day half-life, and gives untried skills an exploration bonus that fades with use. With no history every candidate still scores identically and the curated order is preserved.
- **Kanban tracks work without becoming permission to perform it.** Prompt guidance, task dispatch, and managed lifecycle adoption now treat the board as an evidence and coordination surface; adoption can be explicitly reversed, and all start-readiness consumers share the same dependency and composite-parent predicates.
- **Fallback construction has one authority.** Direct model fallback, One Shot, and profile-based callers now converge on `FallbackProfileManager.resolveCandidates`, preserving explicit-chain isolation while applying the last-resort cap after deduplication.

### Fixed

- **The distillation pass no longer deletes what earlier passes distilled.** The per-skill addendum was rendered from the capture buffer and written over the file, but the buffer is pruned after every pass — so a model-less run, or a single per-skill call timing out before the pruning consolidation, silently discarded every directive an earlier pass had produced. The pass now merges onto the existing addendum, and a pass with nothing new is a true no-op.
- **The spawn skill budget no longer spends its last bytes on generic text.** An over-budget skill was dropped whole; the bundled body is now shortened so the project addendum survives. Measured on this repository, `reviewer`'s learned `testing` practice overflowed the 16 000-character budget by 381 characters and was cut on *every* spawn while 8 KB of generic body from two other skills stayed — its counters read `testing.loaded: 0` beside `chimera.loaded: 197`.
- **The automatic-optimization cooldown applies without a model.** It was measured from the last consolidation, which a model-less pass never writes, so `minIntervalMs` never applied and a full pass re-ran after every capture. The stamp now lives in `learning.json` as `lastOptimizeAt`.
- **The dispatcher's model tie-break was never wired.** `dispatchAgent` is two-stage by design, but nothing supplied stage two to the `Director`, so every description the keyword heuristic could not resolve fell through to the `executor` generalist. The host now provides a classifier (model-matrix slot `dispatcher`) that declines rather than throws, leaving routing on its heuristic result on any failure.
- **`git` and `release` agents can now say they are stuck.** Every tool preset carries `mailbox` so a blocked subagent can escalate; `vcs` was the only one without it, silencing the two roles whose work (force-push, tag collision, dirty tree) least often has a safe default.
- Capture no longer reverts the optimization pass's bookkeeping by writing `learning.json` from a value read earlier in the call.
- **Todo and Kanban state no longer drift under pruning and repeated sync.** Ordering is stable, board growth is bounded, acceptance criteria survive the bridge, and the WebUI inspector keeps its task context as rows move.
- **A prompt refresh or `beforeRun` failure cannot wedge the next agent run.** Both operations now execute inside the run's `try/finally` boundary, so lifecycle cleanup always releases the active-run state.

## [0.303.0] — 2026-08-10

### Added

- **Roster agents now develop their skills per project, not just accumulate notes.** A subagent ends a run with a directive tagged to the skill it refines (`## LEARNED [skill: testing]`, or routed automatically from the wording). A background pass distils the directives for each skill into `.wrongstack/agents/<role>/skills/<skill>.md` and the runtime injects that addendum directly beneath the bundled skill body on the next spawn, instructing the agent to prefer it where the two differ.
- **Skill selection is ranked by project affinity.** The full curated skill pool for a role (carried as the new `SubagentConfig.skillPool`) is ranked by routed learning, task outcome and usage before the eager-load cap is applied, so a skill this project developed can displace an unused sibling. `skills/affinity.json` holds the counters; a skill can be pinned.
- **The distillation pass runs unattended.** `fleet.learning.autoOptimize` (default on) triggers on buffer size or on directives waiting to reach their skill, with a 20 s debounce, a 6 h per-role cooldown, process-wide serialization, exponential failure backoff and a start-up sweep. Each pass emits `agent.learning.optimized`.
- **New surfaces:** `/agent-improve <role> optimize|skills [<skill>] [pin|unpin]`; WebUI Self-Learning skills panel with affinity, addendum bodies and auto-optimize status; a TUI feed line when a background pass completes; `subagent.skills.dropped` for skills that fail to load.
- `scripts/repair-agent-learning.mjs` migrates and repairs pre-existing `learned.md` buffers.
- **The Codebase Index now has a deeper incremental intelligence path.** Tree-sitter WASM adds C, C++, Java, C#, PHP, Ruby, Swift, Kotlin, Elixir, and Shell extraction with a safe regex fallback; content-addressed invalidation avoids reparsing unchanged content; and hybrid trigram/semantic search combines FTS5 and local 384-dimensional TF-IDF vectors with reciprocal-rank fusion. (`188eb5f17`)
- **Call-graph and indexing work scale beyond an in-memory scan.** Recursive SQLite CTEs power transitive callers, callees, and dead-code reachability; large seed sets stay correct through temporary tables; and sufficiently large repositories can use a bounded parser-worker pool. The project-server protocol can negotiate MessagePack frames while retaining a JSON fallback. (`188eb5f17`)

### Changed

- **`.wrongstack/agents/` is now committed.** What an agent learned about this codebase is a project asset; leaving it ignored meant every clone and CI run started the roster untrained. `archive/` and `skills/affinity.json` stay local.
- **Learning capture also runs on failed and cancelled tasks**, and on ACP-delegated agents, which previously discarded every `## LEARNED` block they produced.
- **The capture frequency cap is a rolling 30-minute window** instead of a per-process counter that never reset — in a long-lived project daemon it had become "3 captures per role, ever". `/clear` resets it explicitly.
- Consolidation archives the raw buffer and resets it, and its metadata now snapshots the post-prune state so the freshness gate compares like with like.

### Fixed

- **Roles silently stopped learning once `learned.md` passed 8 KB.** The size gate blocked every automatic capture and had no path that could clear it, because consolidation wrote a separate file and never touched the raw buffer. Over-budget buffers are now trimmed at write time (cheapest entries first) and size never blocks a capture.
- **Repeated captures corrupted the buffer.** Stored `How` anchors carried their own list markup, so each re-render wrapped them again (`- *How:*   - *How:* …`). Anchors are stored bare and the renderer owns the label, making a parse→render round-trip a fixed point.
- **`.json` path anchors were truncated to `.js`** by a first-match extension alternation, handing agents file paths that do not exist.
- **`/agent-improve <role> capture` could never succeed** — it read a `lastAgentOutput` context key nothing ever wrote. **`consolidate` persisted nothing** on the CLI path; both surfaces now share one implementation.
- **Post-consolidation deltas selected the wrong directives.** The structured buffer is sorted, so slicing by entry count returned whichever entries sorted last; the delta is now selected by capture timestamp. Entry counting no longer uses `splitLearnedEntries`, which returns 2 for any structured document.
- **The "teach this agent" flow was silently destructive** — appended text was invisible to the structured parser and the next capture rewrote the file without it.
- Cross-role conflict detection compared whole documents, so shared boilerplate made almost any two roles look like they conflicted; it now compares individual directives.
- The commit-SHA scrubber no longer deletes ordinary words spelled from hex letters (`defaced`, `acceded`).
- `knowledge.json` `liveQueries` and `verifyThreshold` reached a prompt for the first time; the agent-prompt cache key now includes the project root.
- **Website: every prerendered command route and sitemap URL lost its first letter** (`/commands/mailbox` was emitted as `/commands/ailbox`). The build-time slug helper double-stripped the leading slash. 98 command URLs corrected.
- **Windows self-update now resolves the global package manager rather than a project-local shim.** `wstack update` also gives a recoverable locked-native-file diagnosis instead of leaving a failed update ambiguous. (`958d785a3`)


## [0.302.2] — 2026-08-09

### Fixed

- **Explicit fallback chains are now authoritative.** Setting `fallbackModels` (or a named `fallbackProfile`) to a usable chain no longer dilutes the user's intent by prepending every configured provider or favorites. Auto-derivation, favorites, the default profile, and `resolveAllConfigured` depth only fire when no explicit chain produced usable models, so a dead explicit chain still falls through to last-resort depth. (`c5e61e113`, `f3e5166a8`)
- **Stop cancels the current attempt, not the whole session.** The WebUI Stop button now respects the abort signal inside `runFallbackChain` so user cancellation halts fallback rotation, and the abort controller map is keyed by `sessionId` instead of `WebSocket` so pressing Stop only cancels the targeted session's run, not every concurrent session in the host. (`684b433e5`)

## [0.302.0] — 2026-08-08

Consolidates the intermediate `0.301.1` package bump.

### Added

- **The CLI-hosted WebUI now serves HTTP and WebSocket traffic from one port.** The host can launch discoverable child sessions for additional projects while preserving project/session identity and bounded lifecycle cleanup. (`84c3e14bb`)

### Changed

- **The public plugin inventory now reports 72 managed plugins**, matching the canonical runtime catalog: 6 core plugins, 64 suite plugins, and 2 bridges. (`2ef680672`)

### Fixed

- **WebUI Kanban detail views are more reliable.** Task trees and verification dashboards retain their selected task context, while the inspector no longer renders a duplicated action surface. (`ee972764d`)
- **OpenCode Go requests preserve sticky routing.** Provider calls now send `x-opencode-session`, keeping a WrongStack session on the same upstream model route. (`1482df22b`)
- **Shared Vitest aliases no longer corrupt prefixed package names.** Central aliases are typed and sorted longest-first, and TUI snapshots use stable dates instead of drifting with the calendar. (`6d22a42eb`, `8aac142cb`, `614b560bb`)

## [0.301.0] — 2026-08-07

The broader set of changes included in this release has not yet been specified.

### Documentation

- **Mailbox session-affinity guard documentation now matches PR #314.** The `acceptMailboxMessageForSession` contract explicitly preserves strict `!== undefined` presence checks so malformed persisted values continue to fail closed.

## [0.300.0] — 2026-08-05

### Added

- **WebUI palette system.** Appearance settings now offer emerald-gold, blue-navy, and purple-pink palettes over the light/dark theme. The selected palette persists locally, synchronizes across tabs, and applies consistently to the top bar and settings surfaces. (`bcb946c89`, `9378ba482`, `b306ff3e6`)
- **Opt-in chat-input auto-collapse.** The WebUI input remains expanded by default; users can enable a persisted Auto-collapse preference that responds to transcript updates and session transitions, then expands again at completion. The control remains reachable even while the input is collapsed. (`83142e8f8`, `efd2f6f8e`)

### Changed

- **WebUI runtime colors now use semantic theme tokens** rather than hard-coded palette values, keeping light and dark variants consistent and testable. (`67e70bf3c`)
- **Loopback WebUI and SimpleUI HTTP APIs require a token on every bind.** The instance registry supplies that token to the legitimate FleetNotifier `POST /api/fleet/ping` caller, rather than treating loopback as an authentication boundary. (`5a26cd0f2`)

### Fixed

- **Council decisions preserve reliable timeout, cancellation, diversity, and usage semantics.** Overall and per-seat budgets compose correctly; only caller cancellation produces a cancelled result; unresolved open-question disagreement remains visible; and correlation warnings use only attributable valid votes. (`4779a00bf`)
- **Fresh Council runs no longer display a previous verdict.** Reconnect replays are deduplicated, while a new seat clears stale resolution state before the next vote. (`44f846b1c`)
- **Sensitive agent-state files are protected from silent writes.** Permission helpers now recognize configuration, trust, and authentication state as protected paths. (`5a26cd0f2`)

## [0.299.0] — 2026-08-04

### Added

- **Requirements Intake, from request to submitted record.** The new `@wrongstack/requirement-intake` domain package preserves an immutable original request, tracks source-annotated normalized fields, validates LLM suggestions as proposals requiring explicit acceptance, and applies fail-closed authorization, optimistic concurrency, locking, and idempotent submission. It is available through REST, `/intake`, SDD, WebUI, and the read-only-by-default `wstack-requirement-intake-mcp` server. (`81a052383`, `e546fc402`)
- **Council-backed decisions and Kanban verification.** Core Council receives typed persona ids and a one-shot LLM orchestration seam; Kanban can now send acceptance criteria with concrete diff evidence to a multi-perspective Council verifier. A verdict never substitutes for evidence, and unresolved dispatches remain visible instead of being treated as a pass. (`8136fac09`, `f8f9e6718`)
- **Codebase call-graph tools.** Tier-1 `codebase-incoming-calls` and `codebase-outgoing-calls` traverse the SQLite reference graph to return enriched callers or callees for a symbol. They distinguish missing symbols from empty results, report ambiguity/unresolved references, preserve global ordering across chunked SQL queries, and are available through project-index dispatch paths and the public API. (`e1ef4fc0b`, `dcc3bf946`, `dc8a82383`, `89b1c5b57`, `e61515f33`)
- **First-party project-service MCP presets.** Kanban, Mailbox, and Codebase Index MCP servers can be enabled from the built-in registry with their explicit capability boundaries. (`4e976523e`, `be0b874a3`)
- **HQ Kanban visibility.** The HQ board now includes a read-only task inspector and queue-health bar. (`61c3bef46`, `f14854f81`)

### Changed

- **The CLI-hosted WebUI uses the same project-scoped Requirements Intake service as the standalone server.** Intake records are no longer unavailable merely because the browser surface was started from the CLI; hosts without a project root continue to return an explicit unavailable response. (`e546fc402`)
- **Workspace inventory now contains 29 packages and 2 apps**, with 61 built-in tools, 29 bundled skills, a 77-role roster, and 64 focused plugin exports. (`9f0ef4694`)

### Fixed

- **Kanban project daemons exit reliably.** Idle shutdown now waits for readiness where needed and routes every exit path through a bounded stop-and-exit path, preventing cleanup failures from leaving a zombie process or stale endpoint. (`2ff9a1355`, `b8864e6a1`, `eb5b41318`)
- **Worktree and SDD recovery protect evidence.** Conflict-marker detection handles CRLF and Markdown setext headings without false positives; a dirty tracked worktree is never hard-reset during rollback, and an unsafe rollback refusal hard-stops the SDD run. (`de7bb9be8`, `51a4ca708`, `022224ec9`, `6ce3b8a2`)
- **Network and UI boundaries are hardened.** HTTP execution and loopback checks use the shared IP-aware guard for SSRF-resistant validation, while HQ authentication prevents duplicate submissions and restores accessible, deliberate focus behavior. (`9c197bf18`, `18b99104f`, `c3ab1c7bd`, `c297b23c5`)
- **TUI sidebar scrolling accounts for routed panels and legacy swarm settings**, preserving visible worklist rows in narrow rails and mixed persisted configurations. (`dfe7362c7`, `7fa7bbdc6`, `f37f7e8ea`, `f1432619d`)

## [0.298.3] — 2026-08-03

Consolidates the intermediate 0.298.2 package bump.

### Added

- **Models.dev model management across WebUI and TUI.** Providers can now add a catalog model or custom definition, edit its schema inline, select the active model, remove an override, or reset it to the catalog. The persisted `modelsDev` definition is schema-validated and retained as a delta, while top-level `config.models` takes precedence over provider-local custom definitions for the same model id. (`f71ae3cfe`, `8775d7312`, `98da3cf66`)
- **TUI per-panel routing.** Every F-key panel plus Connections can be placed in the right sidebar or lower region from Settings. The sidebar presents a layered mission-control rail and accepts up to six open routed panels, with deterministic overflow visibility. (`1efb406b6`, `aef431c7d`)

### Changed

- **SAGE anchor verification batches Git blob checks** for a memory into one subprocess, preserving per-anchor results while avoiding one Git spawn per anchor. Review proposals now keep their target, reason, and suggested action in typed fields rather than overloaded tags. (`b08b2c34a`, `69d75ff19`)
- **WebUI provider settings use the row-based model editor** rather than a chips-only list, including dense filtering, catalog selection, inline editing, and translated controls in all supported locales. (`8775d7312`, `c8a8f6d28`)

### Fixed

- **Model edits preserve complete definitions.** Updates deep-merge limits and costs, preserve untouched models.dev fields, reliably persist capability toggles, classify catalog rows correctly, and discard stale catalog-search responses. Custom-model add/remove now keeps the provider allowlist synchronized. (`2ccea36a5`, `1dd2dcb7e`)
- **TUI panel routing updates and sizing are stable.** Persisted settings are used after the picker closes, fleet compatibility state remains synchronized, and nested routed panels respect the actual sidebar dimensions. (`f1f5c2d3a`, `1f54ac558`, `6199f1d53`, `a0a9f7b52`)
- **Trust boundaries are stricter.** ACP client callbacks now use bounded, fail-closed permission handling; untrusted mailbox sends cannot forge `sessionAffinity`; and saving settings to a new scope merges the destination config before writing so destination-only values are not lost. (`85953d8f4`, `4c56a88dd`, `99a39c166`, `a321a4fd2`)

## [0.298.1] — 2026-08-02

### Added

- **Kanban architecture program (Phases 0–4).** Canonical task classifier (15 queue buckets) with deterministic enforcement; board kind system (project, session mirror, SDD mirror, import, archive) with retention policies; shared dispatch service with lease fencing; parent/child atomic gate (parent cannot reach Done until all children completed); session-board prune (archive/delete past TTL); lifecycle-aware stale recovery preserving managed lifecycle stages. (`9226bb53a`, `44c9c57da`, `8638a2364`, `3e1fdfd4e`, `16d97e531`)
- **TUI: link highlighting in markdown renderer.** `[text](url)` and bare URLs are colored in accent. (`127f92abd`)
- **CLI: subcommand docs parity.** 7 missing help entries added; manifest generator script. (`2e365bfb6`)
- **Core: typed environment-variable parsing helpers** — `envBool`, `envInt`, `envFloat`, `envString`, `envEnum`. (`e655ee336`)
- **Core: unified tool error taxonomy.** Structured `ToolErrorInfo` attached to all tool error results. (`e12a16f3b`)
- **WebUI: display settings tab** mirroring TUI display fields. (`ac2ca1cba`)

### Changed

- **WebUI shell decomposition.** App.tsx split from 981 to 447 lines — WorkbenchTopbar, PanelSuspense, and ViewRouter extracted as focused modules. (`f52a67730`, `9e2016fd0`)
- **WebUI-HQ: CSS monolith consolidation.** The 4,340-line HQ stylesheet split into 6 focused style modules. (`020dfdfc8`)
- **Core: tool error results wired into executor catch blocks** — replaced voided `classifyToolError` with structured `toolErrorResult`. (`70f97f9e9`)

### Fixed

- **Security hardening (25+ fixes).** WS-001: CSRF/rebinding guard on WebUI HTTP surface; WS-002: OAuth callback HTML escaping + headers; WS-003: port-aware loopback WS origin trust; WS-004: MCP payload validation + Win32 spawn hardening; WS-005: token required for Origin-less WS clients; WS-006: ACP WebSocket authentication; WS-007: unconditional HQ secret scrubbing; WS-008: YOLO escalation chain closed; WS-009: HQ query-param tokens confined to loopback; WS-010–012: HQ auth expiry, capability gate, open-mode floor; WS-013: provider API key isolation from baseUrl changes; WS-014/022/037/053: Pages job permissions + unwired controls; WS-016: repo-committed prompts can no longer redefine the agent; WS-021/052: design.materialize write containment; WS-034: scrubber anchor derivation; WS-038: gitignore security artifacts; WS-044: HQ browser tokens stored as SHA-256 verifiers. Vault KEK leak and CI supply-chain gaps closed; atomicWrite mode ceiling and Windows ACL hardening on sensitive appends.
- **TUI: powerline-rail width budgeting** — separator cost mismatch fixed (5→2). (`3a1215c6c`)
- **TUI: silence-terminal stdout.write restore leak** in `unsilenceTerminal`. (`f294de6eb`)
- **WebUI: 8 vertical scroll containers** missing `min-h-0` constraint. (`f624c50a5`)
- **SAGE: config drift** — removed `bash` from `inject.triggers` type. (`77dbf658b`)
- **Tools: file-size caps** added to `json` and `diff` tools to prevent OOM on large files. (`0efc8d236`)

## [0.297.2] — 2026-07-31

Consolidates intermediate bumps 0.296.4 through 0.297.2.

### Added

- **Persistent version chip + update-available warning** across TUI, WebUI, and SimpleUI. (`31a0808de`, `6972df07c`)
- **Statusline: default density changed to minimum** across TUI/CLI/core/WebUI; picker and chip registry synced to rendered four-line layout. (`9f715b387`, `95e67f20e`, `c84170895`)
- **Dead-code-scan improvements** — pnpm-workspace.yaml `packages:` key scoping, barrel re-export traversal, build-output entry-point mapping to source. (`c69b9e95c`–`b431294d0`)
- **SimpleUI decomposition** — settings/prefs, mailbox cluster, worklist commands, topbar chrome, and update banner extracted into focused hooks and components. (`51d09c16b`–`4c1b398ab`)

### Changed

- **IPC socket paths shortened** for macOS `sun_path` headroom across SAGE, Kanban, Mailbox, and Chronicle daemons; endpoint-invalid surfaced in health panels. (`4649d6c94`, `4779936e7`, `318ca33e0`, `f209b6183`)
- **Coverage thresholds lowered** from 100% per-file to 90% aggregate across 6 vitest configs. (`f4606cea5`)
- **Core: HQ protocol envelope primitives** extracted to a dependency leaf. (`603a61db3`)

### Fixed

- **Core: heap-watchdog `lastMajorGcAt`** read a stale timestamp from the previous GC event. (`391dc14ea`)
- **TUI: settings picker field 42 (Read symbols)** now persists and applies live. (`725333105`)
- **Next-steps suggestions** gated on the turn final message. (`974c31597`)
- **WebUI-HQ: peer envelopes** no longer poison resume cursors; restart heuristic tightened. (`215c568a9`)
- **Architecture: phantom tools cycle** removed; regex literals in module scanner stripped. (`b01687b51`)
- **i18n: missing `endpointInvalidBadge` and `endpointInvalidRemedy`** added to 6 locales. (`d1c490d6b`)

## [0.296.3] — 2026-07-30

### Added

- **Mailbox: one project owner over local IPC.** Every CLI, TUI, WebUI, SimpleUI, Desktop, HQ, agent-loop, tool, and HTTP-bridge caller now reaches one elected project service over a deterministic Unix socket or Windows named pipe. The owner alone opens `_mailbox.sqlite`, serializes messages, per-actor receipts, agent/client presence, credentials, retention, and one-time legacy imports, and exposes PID, storage, protocol, client, request, latency, and uptime health. (`9c7fad0cb`, `a0a7d0edd`)
- **Kanban: project-scoped SQLite service and live event bridge.** Boards, assignments, presence, queue claims, revision-checked mutations, legacy import, and HQ/WebUI updates now run through one elected IPC owner. Daemon events replace board-directory watchers, reconnects trigger authoritative reconciliation, and the supervisor bridge forwards mutations without giving clients direct database access. (`248a2953e`, `941f1cd4e`)
- **Chronicle: authoritative SQLite journal.** The project Chronicle owner now stores the hash-chained event stream in SQLite, uses indexed SQL for query/facet/summary operations, performs row-level retention, imports verified legacy JSONL transactionally, and keeps the legacy reader available through `WRONGSTACK_CHRONICLE_STORE=jsonl` for migration verification.
- **SAGE: standalone MCP memory server.** New `@wrongstack/sage-mcp` package and `wstack-sage-mcp` binary expose the existing project-owned SAGE backend to MCP clients over stdio or loopback HTTP. The default surface is read-only; `--writable` explicitly enables confirm-class tools while destructive-tier tools remain hidden. (`53b7a8a5e`)
- **SAGE: unified search service and external IPC guidance.** A shared search contract now supports lexical, path, tag, kind, audience, status, importance, confidence, recency, and pagination filters, with dedicated guidance for direct IPC consumers and MCP clients.
- **TUI: service-connections panel.** `/connections` (`/conn`, `/conns`) and `Ctrl+N` open an auto-refreshing health panel for Chronicle, Codebase Index, SAGE Memory, Kanban IPC, and Mailbox IPC, including owner PID, mode, clients, active requests, queue depth, latency, and uptime. (`58de0bf8b`)
- **TUI: copy retained and streaming boxes.** Every retained chat box and active tool-stream box now exposes a copy target with virtual-scroll-aware hit testing; reasoning-hidden content is not offered as a copy target. (`46a55d009`, `ee4d28fd5`)
- **Prompt refinement: configurable pre-refine grace countdown on every interactive surface.** TUI, WebUI, and SimpleUI now share a configurable delay before the refiner LLM call (default 3 seconds; presets `0, 2, 3, 5, 8, 10`). In the TUI, **Enter** refines immediately, any other key sends as-is, **Esc** cancels, and the panel identifies the refiner provider/model. (`a73ace08d`, `555fe0104`)
- **SimpleUI: project mailbox drawer.** The lightweight browser surface can inspect unread and recent messages, see online agents and mailbox health, send direct mail, and mark read, acknowledge, reopen, or soft-delete messages through the same server-backed WebSocket routes as the other surfaces.
- **WebUI: clearer SAGE and fallback workflows.** All memories and audience-scoped guidance now occupy separate full-width tabs, tag filters collapse when inactive, SAGE tool results render as memory cards, and fallback-model references are parsed consistently across WebUI and SimpleUI.
- **TUI: live terminal-title model updates.** `/model` and `/setmodel` immediately update the idle terminal title without waiting for the next tool or provider event. (`4c1220981`)
- **Read tool: indexed symbols in advanced mode.** Advanced reads can include matching Codebase Index symbols, with CLI and TUI settings to control the additional context. (`ec9ea1db7`)
- **WebUI: durable queued-message and next-step actions.** Queued sends now survive reconnects more predictably, while next-step actions expose clearer send, edit, and dismissal behavior. (`f5d7e00b5`)
- **TUI: searchable refine-failure model picker.** Typing filters the fallback-model list so large provider catalogs remain quick to navigate. (`c86278581`)

### Changed

- **Mailbox storage is SQLite/IPC-only in production.** `RemoteMailbox` is now the sole production client and the server owns automatic compaction and credentials. Legacy JSONL messages, registrations, clients, and credentials are imported once and left untouched for recovery; production no longer writes them. (`a0a7d0edd`)
- **Core mailbox API is intentionally smaller (BREAKING).** `DefaultMailbox`, `GlobalMailbox`, `getSharedMailbox`, `_clearMailboxSingletons`, and the obsolete HQ mailbox factory are no longer public. Integrators must use `createProjectMailbox`, `getSharedProjectMailbox`, `RemoteMailbox`, or the exported project-server and credential-store contracts. (`37d8c4697`)
- **Codebase Index full rebuilds use bounded parsing and storage.** Declaration extraction uses bounded source slices, raw source is not retained, reference ownership uses binary search, force rebuilds defer redundant reference repair, and an optional short-lived parser-worker pool handles TS/JS sources. `WRONGSTACK_INDEX_PARSE_WORKERS=0..4` controls it; `WRONGSTACK_PERF_PROFILE=frugal` disables workers. On the source benchmark this reduced CPU from ~39.4s to ~30.5s, peak heap from ~243 MiB to ~139 MiB, peak RSS from ~544 MiB to ~423 MiB, and wall time from ~37.6s to ~33.1s.
- **CLI startup defers the interactive session graph.** The entry point now separates flag parsing and lightweight commands from full interactive assembly, removes the dead picker subtree, and keeps package boundaries explicit. (`f3f03a603`, `4b14fb872`)
- **TUI statusline configuration matches the rendered four-line layout.** The picker order, navigation, chip icon registry, mailbox spacing, SAGE totals, and line-four memory pipeline counters now reflect the actual status bar. (`95e67f20e`, `c84170895`, `328243559`, `bf2bef6a3`)
- **Resource profiles apply consistently.** Shared SQLite warning suppression and perf-profile cache/mmap defaults now cover additional stores; TechStack's registry cache is capped and prunes expired/oldest entries instead of growing for the process lifetime.
- **Project services expose explicit lifecycle controls.** Mailbox, Kanban, Chronicle, Codebase Index, and SAGE owners clean up stale project state, support controlled shutdown, and report richer connection health; HQ also bounds stale clients and applies WebSocket backpressure. (`4836a08c5`)
- **Codebase Index dead-code analysis follows real package entry points.** Build-output and `bin` entries map back to source, pnpm workspace parsing is scoped to the `packages:` block, and barrel re-exports are traversed without false dead-code reports. (`c69b9e95c`…`b431294d0`)

### Fixed

- **CLI: subagent teardown leak (host-subagent-factory).** `dispose()` now calls `agent.teardown()` so the per-subagent Context's `drainAgentHooks()` runs and clears the mailbox heartbeat `setInterval`, awareness-polling `setInterval`, HQ publisher connection, and `mbox.startAutoCompactTimer()` timer registered at subagent construction. Without this, every retired subagent retained 4 live timers and 1 HQ socket for the rest of the leader process's lifetime — a long-running kanban-dispatch loop with N subagents accumulated 4N timers and N HQ sockets. Two focused regression tests in `multi-agent.test.ts` pin `agentHooks.size === 0` after `dispose()` and after three sequential subagent retirements.
- **Core: Director.remove now drops its own `subagentMeta` and `priceLookups` entries.** When the Director runs without a `FleetManager` (the non-fleet fallback path used by tests and lightweight consumers), the per-subagent metadata and price-lookup Maps live on the Director itself. `remove()` previously cleared `subagentBridges`, `manifestEntries`, `usedNicknames`, `taskWorktrees`, `budgetPolicy`, and `fleetManager` — but NOT its own `subagentMeta` and `priceLookups`. The price-lookup key is derived from `subagentMeta` (provider/model), so `remove()` now resolves it before deleting the meta entry. Two focused tests in `director.test.ts` pin the per-retirement cleanup and the 50-retirement idempotence invariant.
- **Core: FleetManager.removeSubagent now drops `priceLookups` correctly.** The previous `priceLookups.delete(subagentId)` was a no-op because the Map is keyed by `${provider}/${model}` (shared across subagents using the same model), not by subagentId. `removeSubagent` now resolves the price-lookup key from `subagentMeta` (provider/model) BEFORE deleting the meta entry — order matters because `Map.delete` is a no-op on a missing key. Two focused tests in `fleet-manager-extra.test.ts` pin the per-retirement cleanup and the 50-retirement idempotence invariant.
- **TUI: useTuiActivity caches `os.cpus()` and merges the enhance animation into the timing tick.** The per-tick `useMemo` keyed on `nowTick` (10s clock) used to call `os.cpus()` to read the core count — each call allocates a fresh array. Hoisted to a module-level `CPU_CORES` constant so the per-10s tick path does zero `os` work. The loading-dot animation (`setEnhanceBusy`) used to own a SECOND independent 1s `useAnimation` interval that kept ticking even when nothing else was active, doubling the Ink render cadence during enhance. Both now share one tick (`isActive: timingActive || enhanceActive`) and `enhanceDots` is derived as `enhanceBusy ? timingFrame % 36 : 0`. Two regression tests in `use-tui-activity.test.ts` pin the shared-tick invariants.
- **TUI: `/clear` resets all session-specific UI state.** Conversation state, pending refs, memory/context counters, copy targets, panel state, token previews, and other session-bound values no longer survive into the next conversation. (`14856ac9b`)
- **TUI: failed startup closes the opened session writer.** Hydration or initialization failures no longer leave a live writer/ownership claim behind. (`da9ccdcc9`)
- **Session registry: Windows atomic publication tolerates transient locks.** Registry replacement retries bounded `EPERM`/`EBUSY` races while preserving atomic publish and exclusive live-session ownership. (`eae22feb6`)
- **Kanban: tool and lock timeouts no longer contradict each other.** The callable tool deadline now exceeds the 15-second contention lock instead of timing out at 5 seconds while a valid lock wait is still active. (`2e2883245`)
- **WebUI settings state remains synchronized.** Exhaustive-dependency handling and local-preference resets no longer capture stale values or discard unrelated settings. (`5aa2b1e13`)
- **TUI statusline memory accounting is restored.** The memory injector pipeline counters render on line four again and record totals come from the active SAGE surface capability rather than an obsolete path. (`328243559`, `bf2bef6a3`)
- **TUI history and copy affordances stay aligned.** Copy icons track retained/streaming boxes through virtual scrolling, hidden reasoning does not expose a misleading target, and the live-stream icon no longer shifts relative to its box. (`46a55d009`…`9b4d2bf84`)
- **SQLite startup noise is scoped away.** The Node experimental warning is suppressed only while loading `node:sqlite`; unrelated warnings continue to flow normally. (`375c17f8f`)
- **Chronicle legacy import isolates broken day chains.** Each day family imports in its own transaction; a hash or sequence break quarantines that entire day without repairing or partially importing it, while healthy days continue. Quarantine metadata persists, `ping` exposes the missing dates/reasons, and TUI/WebUI health reports degrade visibly instead of serving an apparently complete audit trail. Infrastructure failures still fail loudly, and failed store opens release SQLite/WAL handles before a real retry.
- **Connections health probes the canonical mailbox endpoint.** TUI and WebUI now derive the mailbox pipe from the project data directory, matching the daemon owner, instead of probing a second endpoint from the repository root and reporting a healthy live service as sleeping.
- **Security Scanner bounds file-head reads.** Large-file discovery no longer requires loading complete files when only a bounded prefix is needed.
- **Fallback and session messages are normalized across browser surfaces.** Provider/model references, rendered next steps, SAGE blocks, and session-swap guards now preserve the active session and avoid showing protocol text as chat content.
- **Subagents share provider quarantine state.** CLI, runtime, Chimera, and WebUI-created subagents now receive the host `ProviderModelStatusTracker`, preventing rate-limited models from being retried through an isolated fallback path. (`90bcb3738`)
- **Todo checkpoints keep session and trace identity separate.** TUI resumes and WebUI session switches rebind the checkpoint store without leaking todos across sessions or confusing trace IDs with session IDs. (`2368e9873`)
- **Long-running state remains bounded.** Context file-tracking collections, pending tool status, Chronicle stream state, and Kanban listeners now have caps, expiry, or independent stale-state cleanup. (`d253c0e38`, `8b52dbb97`, `499e949dd`)
- **SAGE ignores writes to already-closed client sockets.** Broadcast and error-response paths contain socket teardown races instead of crashing the project service. (`d6369f459`)
- **TUI branch-switch notices flow through conversation state.** Git branch changes are journaled consistently rather than bypassing the retained conversation state. (`5f8b9ad91`)
- **CLI storage observability distinguishes routine activity from failures.** Expected persistence telemetry stays quiet while actual storage errors remain visible. (`ba60a6a56`)

### Tooling

- **CI warms workspace distributions before TUI heap-soak and Playwright E2E jobs.** Tests that import built package entrypoints no longer start against missing/stale `dist` output. (`30961bcf4`)
- **Windows SQLite cleanup tests retry WAL/SHM removal.** Kanban teardown now tolerates short-lived `EBUSY` locks, and the test-type ratchet fixtures match the current contracts. (`e1692a4a6`, `6a64aa338`)
- **Architecture guards enforce single-owner project services.** New mailbox/Kanban daemon boundaries reject direct production store construction and public API snapshots pin the smaller mailbox surface.

### Documentation

- Added the mailbox single-owner/SQLite architecture, Chronicle SQLite journal design, SAGE direct-IPC and unified-search guides, the standalone SAGE MCP architecture/safety/tool references, and Telegram broker ADR plus operations runbook. (`936818b00`, `a862225b2`)

## [0.296.2] — 2026-07-28

### Fixed

- **Core: parseHqFrame test retry under full-suite worker contention.** Added `retry: 1` to the `parseHqFrame` describe block — the 5 intermittent failures only appear under full-suite load (1,829 files, 25% maxWorkers) and pass in isolation; the retry lets transient contention self-heal without masking real regressions. (`479e13d2c`)
- **Core: ChronicleRemoteJournal test retry under full-suite worker contention.** Added `retry: 1` to the `ChronicleRemoteJournal` describe block — the 4 intermittent `this.client.call is not a function` failures only appear under full-suite fork-worker load with `vi.useFakeTimers()` and pass in isolation. (`ef77a61b1`)
- **Core: ChronicleMetricsStore test retry for Windows SQLite EBUSY races.** Added `retry: 1` to the `ChronicleMetricsStore` describe block — the 5 intermittent failures are Windows SQLite WAL file-locking races (`EBUSY` on `metrics.db-shm` unlink) under parallel test workers; all 4 tests pass in isolation. (`ef77a61b1`)

## [0.296.1] — 2026-07-27

### Added

- **Chronicle: per-project telemetry server.** CLI/TUI producers now batch scrubbed Chronicle event envelopes over local IPC to one project owner, which serializes the hash chain, rotation and retention while owning a single file watcher, query cache, and metrics projection. Coding Intelligence queries use the same server, with the in-process journal retained as an explicit source/dev fallback.
- **WebUI Connections health.** Settings now reports WebUI, Chronicle, Codebase Index, and SAGE project-service ownership, mode, PID, storage, watcher, queue, client, request, and latency health from one refreshable screen, while distinguishing required services from on-demand sleeping services.
- **WebUI Context Window Editor.** Zustand store, React component, and server-side handler for interactive context-window message removal with validation, repair preview, and conflict detection. (_Note: shipped in `f08d71c32` alongside the TUI interrupt-controller test due to a staging overlap._)
- **Mailbox: Global Mailbox P0 contract repairs.** Foundation-layer rewrite with v2 read projection, version-fence enforcement, compaction preservation, security gate, multiprocess concurrency, and rollback compatibility. (`92215fa2a`, `263e15cfc`, `754410b6e`)
- **Provider status: 429 quarantine and waiting-room panel.** Immediate 429 quarantine with prose reset-hint parsing, sibling-model quarantine on account-level quota exhaustion, and a WebUI waiting-room panel. (`eee3e61a9`, `e68ed3f41`)
- **Storage: session ID and name resolution.** Dedicated session ID resolution module wired into session store and agent loop, plus session name resolution, content preview, and enhanced recovery metadata. (`c8e14c60a`, `f55cfc1f3`)
- **Chimera: review report tracking.** Lifecycle and finding commands for review report tracking. (`404b3a333`)
- **Prompts: lite and pro system variants.** New lite system prompt variant and system-pro prompt selection via `systemPrompt.variant` config. (`57739604d`, `cd17dde7a`)
- **SimpleUI: art-deco design overhaul.** Full interface overhaul with art-deco design system aligned to the corporate brand palette. (`e0d8025bb`, `0b61ee317`)
- **CLI: ECONNRESET handling.** `ECONNRESET` is now handled as a broken pipe on Windows instead of crashing. (`012518ce0`)
- **TUI: dedicated `useSessionInterruptController` test suite.** 8 tests covering `abortLeader` streaming-ref cleanup, `resetSession` full reset (including `tokenPreviewsRef`), and teardown neutering. (`4f04ff663`)

### Changed

- **Monorepo: large-scale module decomposition.** Extracted focused modules across 10 packages — desktop (runtime groups, project picker, path resolution), CLI (REPL rendering, memory commands, subcommand help), core (fallback tools, session store, config loader, agent identity), TUI (input validation, status bar formatting, settings picker), WebUI (kanban board, code map, agent office, agent roster), tools (kanban contracts, codebase index writer), and SAGE (SQLite store helpers). No behavioral changes; all existing tests pass. (`e6cc6cc7b`…`2f9fd40aa`, 19 commits)
- **Dependencies: workspace refresh.** All workspace dependencies refreshed to latest compatible versions. (`14f7b72b2`)

### Fixed

- **TUI: Map/ref leaks in fleet bridges, abort handler, and `/clear`.** Four related fixes for long-running sessions with heavy subagent fan-out: (1) `use-director-fleet-bridge` now calls `finalizeTurn()` on `subagent.removed` before cleanup so force-terminated agents still commit their final chat message, and clears `labelsRef` on effect teardown via a `seen`-Set; (2) `use-subagent-events` tracks all ref-touching subagent IDs in a `seen` Set and clears `labelsRef`/`ctxDispatchRef` on effect teardown; (3) `abortLeader()` clears `streamingTextRef`, `streamSegmentsRef`, `pendingDeltaRef`, and `flushTimerRef` immediately after abort since the normal `provider.response` cleanup never fires on a mid-stream abort; (4) `resetSession()` clears `tokenPreviewsRef` on `/clear` so stale attachment previews don't survive across conversations. Verified by heap-soak benchmark (plateau slope ≈ 0 at 2,000 entries) and full TUI suite (244 files, 3,784 tests). (`7f1db9d1d`, `c82089abd`)
- **Coordination: lifecycle leaks and concurrency isolation.** Closed partial-spawn orphan-agent and controller-entry leaks, three lifecycle leaks in budget policy and collab controllers, and isolated concurrent collab sessions with ownership guards on all event filters. Fixed `removeNode` dependent-readiness ordering so dependents transition to ready. (`023fdf38d`, `77c4ee7f1`, `50fbf65a7`, `f54d3f585`)
- **TUI: harden `extractSageBlock` trailing-whitespace tolerance.** Trailing blank/whitespace lines after the SAGE block no longer cause the strict `every()` check to reject the entire block, leaking SAGE content into tool output. (`d248d7305`)
- **CLI: flush conversation journal before clearing session state.** Prevents data loss when `/clear` races with the journal writer. (`9443c1df3`)
- **Mailbox: `isFanOutRecipient` base-alias matching.** Now catches base aliases, not only exact agent IDs. (`76c5816f0`)
- **CLI/Core: ignore aborted output consumers.** Prevents unhandled rejection noise when a run is interrupted mid-stream. (`bf3b8f08b`, `4f466d026`)
- **Plugins: pass vault to built-in plugins.** Built-in plugins now receive the vault reference. (`f449cef48`)
- **Sync: harden cloud synchronization.** Improved error handling and retry logic. (`1b6246140`)
- **SimpleUI: consume rendered next steps.** Next-steps blocks are now properly consumed instead of rendered as raw text. (`2388bea47`)
- **Autonomy: advance past stalled todos.** The autonomy engine no longer gets stuck on a stalled todo item. (`211bf84a2`)
- **Skills: invalidate SkillLoader cache after create/edit.** The skill loader cache is now invalidated after `skills.create` and `skills.edit`, and the build-once guard in the system prompt builder was removed. (`b2b6d2ec9`)
- **Core: harden agent config and manifest data contracts.** Stricter validation of agent configuration and knowledge manifests. (`225510c41`)
- **Chimera: remove hard-coded review fallbacks and unused symbols.** Cleaned up review fallback logic and removed unused symbols causing `check:test-types` failure. (`083e09d48`, `e4f0020f6`)

### Tooling

- **CI: TUI heap-soak regression gate.** New `tui-heap-soak` job runs the quick profile (120 entries, 2 plateau samples at 72/160 columns) and asserts plateau slope stays within ±512 KiB/sample and mounted heap stays under 50 MiB. Wired into the composite CI Gate. (`07da8dc74`)
- **Architecture: regenerated snapshots.** Core API, hotspot, and test-typecheck baseline snapshots regenerated from committed state. (`fff22edd9`)

## [0.296.0] — 2026-07-25

### Added

- **Chronicle: derived metrics store.** A disposable SQLite projection (`<chronicle>/metrics.db`, node:sqlite/WAL) turns the raw journal into queryable aggregates — `provider_daily` (per provider×model×day attempt/success/failure/retry/fallback counts, tokens, duration stats), `task_outcomes` (status, timing, retries, board/run/session lineage, files touched), `file_lineage` (each mutation with full session/agent/task/board/tool/model attribution), and `token_cost` (latest cumulative cost per scope). Ingest is incremental via per-partition byte offsets, so raw partitions can be purged by retention without losing metrics. `wstack chronicle metrics [providers|tasks|files|summary]` and the `chronicle.metrics` WebUI message expose it; the Coding Intelligence dashboard gains Model-reliability and Task-outcomes strips fed from the store instead of re-scanning the journal.
- **Chronicle: task/kanban file lineage.** `file.event` mutations are now persisted with `scope.kanbanBoardId` and task attribution, and `kanban.*` events join the durable coding-signal set, so "which session, board, and task caused this file change" is answerable directly from scope filters.
- **Chronicle: journal retention.** `chronicle.retentionDays` (default 30, floored at 7, `0` disables) arms the existing checkpoint-safe auto-purge, which previously had no configuration surface.
- **CLI: dedicated session-registry wiring module.** Session-registry setup was extracted from `cli-main.ts` into `./wiring/session-registry.ts` (`setupSessionRegistry`) for a clearer startup composition. (`99e6d83aa`)
- **Agent roster: headless consolidation.** Role learning entries can be consolidated headlessly via an LLM synthesis pass, with live WebSocket broadcast and a debounced roster refresh. (`29ebd6a5d`)
- **Config: dedicated config-type modules.** Config types were split into focused files, and new `ModelRuntimeConfig` exports were added. (`60dca9df1`)
- **Goal: duration-realism assessor.** A new assessor evaluates whether a goal's estimated duration is realistic. (`d469c5483`)
- **Goal WS handler: chimera auto-review.** Completed goal tasks now trigger an automatic chimera review pass. (`3e19e7276`)
- **Docs: full README rewrite** covering architecture, scale, and comparison sections. (`4fc05b70d`)

### Changed

- **Directory rules: explicit empty tool allowlists now deny all tools.** A rule in `.wrongstack/directory-rules.json` with `allowOnlyTools: []` is treated as an intentional deny-all constraint. Remove `allowOnlyTools` from a rule to impose no allowlist constraint; use a non-empty list to permit only the named tools.
- **Kanban decomposition: empty command markers remain manual checks.** Success criteria containing only a dollar-sign marker, `run:`, `verify:`, or `cmd:` (with optional whitespace) are no longer classified as executable command checks; command markers must be followed by command text.
- **WebUI i18n: full SettingsPanel locale parity.** All SettingsPanel locale files were restructured to 456/456 key parity, Spanish features/subtitle and German locale strings were translated, and `PluginToggleList` was wired into the context tab. (`bc020d035`, `d232e53c6`, `dbd0ecf22`, `215b9e3f9`, `fa5bfce52`)

### Fixed

- **Chronicle: fleet snapshots dominated journal volume.** `session.agents_updated` (a full-fleet state snapshot fired on every flush, ~76% of journal bytes) and `network.request.started/completed` are now reduced to windowed rollup aggregates instead of persisted raw; `provider.attempt.started`'s prompt manifest records its tool-name roster once per `manifestHash` rather than re-embedding it every attempt. Combined with retention, steady-state journal growth drops ~75%.
- **Chronicle: partitions over ~512 MB could not be purged or verified.** Entry verification read each partition into a single string, exceeding V8's maximum string length on large legacy partitions and leaving `purge`/`verify` permanently unable to process them; verification now streams line by line.
- **Chronicle: `provider.fallback` produced a blank-identity metrics row.** The event carries its provider identity under `attributes.from`, not top-level runtime, so the metrics store recorded fallbacks under an empty `('', '')` key; they are now attributed to the provider fallen back from.
- **ProviderError duck-type guard across package boundaries.** Added `ProviderError.isProviderError()` static method that checks structural properties (`name === 'ProviderError'`, `status`, `retryable`, `kind`) rather than relying solely on `instanceof`, which can fail when npm hoists duplicate `@wrongstack/core` copies at runtime. Updated 7 critical `instanceof ProviderError` call sites in `provider-runner.ts`, `fallback-model.ts`, `retry-policy.ts`, and `isContextOverflowShaped()` to use the combined guard. (#304)
- **`fallbackAuto: false` config now respected.** `fallbackCandidates()` previously used `!opts.closedWorld` instead of the actual `config.fallbackAuto` value, and unconditionally appended smart-defaults. Now resolves `effectiveFallbackAuto` from `config.fallbackAuto` and only appends smart-defaults when true. (#305)
- **SSE `TypeError: terminated` now normalized to retryable ProviderError.** `WireAdapter.stream()` wraps `yield* this.parseStream()` with error normalization so transport errors (`terminated`, `fetch failed`, `ECONNRESET`, `ETIMEDOUT`, `UND_ERR_*`) become retryable `ProviderError(status=0, kind=network)` instead of escaping as raw `TypeError`s that bypass retry and fallback. (#306)
- **WebUI Chimera toggle defaults to disabled.** `context-meta.ts` now uses `chimeraExt?.['enabled'] === true` (strict opt-in) instead of `!== false`, matching the plugin's `defaultState: 'inactive'`. (#307)
- **`--desktop` no longer crashes with `ERR_INVALID_URL`.** `rendererIndexPath()` now returns a `file://` URL (via `new URL(...).href`) instead of a bare filesystem path, fixing Electron's `loadURL()` requirement. (#293)
- **TUI long-prompt input supports vertical scrolling.** Added `MAX_VISIBLE_ROWS=10` cap with scroll-offset tracking that auto-follows cursor position, a scroll indicator in the bottom frame, and Home/End navigation support. (#295)
- **WebUI-server prefs validation.** Added missing display-only prefs to the validation whitelist, fixed `modelAvailabilitySchedule` typing, moved `groupToolCalls` / `showThinkingLogs` into `BOOLEAN_PREF_KEYS`, and moved `modelAvailabilitySchedule` into `ARRAY_PREF_KEYS`. (`b2a03f2fc`, `98464199d`)
- **WebUI settings tabs.** Fixed nested `TabsContent` in `BasicSettingsTabs`, corrected accent-color i18n keys, and removed an unused `TabsContent` import. (`dbd0ecf22`, `215b9e3f9`)
- **Tests: WebSocket handshake in `handleMessage` calls.** `handleMessage` calls now pass a `WebSocket`, with protocol counts and mock syntax updated to match. (`e6716108b`)

## [0.295.0] — 2026-07-23

> The **repository identity, shared HQ Kanban, Brain control plane, and indexed
> memory release**. Projects now carry a clone-stable identity, HQ provides a
> cross-machine Kanban workspace, Brain decisions become configurable and
> replayable, and SAGE defaults to indexed SQLite/FTS5 storage. The release also
> hardens deterministic verification and aligns every package, app, README, and
> website surface to `0.295.0`.

### Added

- **Repository-stable project identity.** `.wrongstack/project.json` carries a committed `proj_<ULID>` across clones, worktrees, forks, and machines, so HQ merges their telemetry and Kanban snapshots under one project without per-machine alias configuration. `wstack project id|init|rekey` and `/project id|init|rekey` expose the lifecycle; explicit rekeying lets a fork become an independent HQ project. Existing `hq.projectAlias` identities remain a fallback when no committed identity exists.

- **HQ shared Kanban view.** The HQ dashboard now exposes a dedicated read-only Kanban workspace with project and board selection, live snapshot-triggered refresh, periodic reconciliation, WIP signals, task metadata, and responsive columns. Boards are loaded through the project-scoped Kanban API, so every clone or machine carrying the same committed project identity sees the same project board.

- **TUI: soft half-block wordmark.** The startup banner's `WRONGSTACK` pixel face is now designed on a 5×5 grid with 2-bit density (empty / lower-half `▄` / upper-half `▀` / full `█`). Each cell renders across two terminal rows, doubling the vertical resolution to 10 rows so diagonals and curves fade through half-blocks instead of the previous hard "either fully lit or fully blank" look. The 53-column footprint and 65-column layout breakpoint are unchanged.

- **Brain: deterministic rule tier.** `brain.rules` is evaluated before anything that costs tokens — match on source, risk band, fallback, offered options and question/context patterns; `defer` carves exceptions out of broader rules. An invalid pattern disables only its own rule and is reported via `/brain rules`.
- **Brain: replay trace.** `brain.trace` records one JSONL row per decision — every tier the ladder ran, every pool target called (including the failures the fallback loop swallowed), every council seat's vote, timings and tokens. Rows convert to `BrainEvaluationCaseV1` fixtures for offline replay. Disabled by default; `content: none | redacted | full`.
- **Brain: decision provenance and `/brain stats`.** `brain.decision_*` events now carry the resolving `tier`, so deterministic decisions can be told apart from ones that cost a provider call.
- **Brain: LLM quality gate.** Empty or hedging responses ("I don't know", "insufficient evidence") are no longer presented as decisions; optional `minConfidence` floor; configurable `maxTokens`; `denyIsTerminal` distinguishes a genuine model refusal from a dead pool.
- **Brain: LLM circuit breaker.** A dead pool previously cost `models.length × decisionTimeoutMs` on *every* decision; it is now skipped after N consecutive failures, with a half-open probe and per-target health ordering.
- **Brain: decision cache.** `brain.cache` (off by default) replays a previous council/LLM verdict for an identical repeated question. Deterministic tiers and `ask_human` are never cached, and a decision the ledger later observes to have failed is evicted.
- **Brain: configurable heuristics, monitor and escalation.** `brain.heuristics` switches each built-in pattern individually (plus a custom resolution vocabulary); `brain.monitor` gains `enabled`, `policy` (`llm | steer | observe`), per-signal toggles, `fileEditTools`, and the previously unreachable `errorStormWindowMs` / `stallCheckIntervalMs`; `brain.terminalPolicy` selects the headless escalation variant.
- **Brain: remaining council/ledger knobs.** `council.perCallTimeoutMs`, `maxConcurrency` (previously pinned at 3), `distinctness`, `judgeMaxTokens`, custom `seats`; `ledger.maxMemoryEntries`, `interventionRetryWindowMs`.
- New `/brain` subcommands (`stats`, `rules`, `heuristics`, `llm`, `trace`, `cache`, `escalation`, `monitor`), with matching controls in the WebUI Brain settings and the TUI Brain panel.

### Fixed

- **Brain: `maxAutoRisk: 'all'` behaved as `'high'`.** The ceiling was looked up in a table keyed by *request* risk, which has no `all` entry, so it silently resolved to the fallback level — `critical` requests were auto-denied by the very tier configured to be permissive, and never reached the LLM.
- **Brain: Brain settings changes deleted un-surfaced config blocks.** `apply()` persists the whole canonical config, and its builder omitted `brain.trace`, `brain.llm` and the new `council.*` fields, so changing any Brain setting erased them from the user's config file. A round-trip guard now asserts the property for every top-level and nested field.
- **Brain: council token usage always reported zero.** The council adapter's LLM caller discarded provider usage and hardcoded `{input: 0, output: 0, total: 0}`, making the cost of every council decision structurally invisible.
- **Brain: file-churn signal never fired for non-standard edit tools.** The tracked tool names were a fixed set; hosts whose edit tools are named differently got no churn detection and no way to notice.
- **Brain: the single-LLM prompt had no trust boundary.** The council voter prompt marked question/context as untrusted evidence; the single-model tier did not, while the monitor injects raw tool output straight into that context.
- **Brain: truncated responses became decisions.** A response cut off at the token budget was accepted as a verdict; `stopReason: 'max_tokens'` is now surfaced.

### Changed

- Super Memory now defaults to the indexed SQLite/FTS5 backend. Existing JSONL records migrate automatically; `engine: "jsonl"` remains available as an explicit compatibility option and as a fallback when `node:sqlite` is unavailable.
- Chronicle WebUI facet aggregation now scans each journal snapshot once for all requested fields instead of re-reading every partition once per facet; older servers remain supported through the existing single-facet protocol.
- Codebase watcher bursts now batch files whose debounce windows expire together into one worker/SQLite index operation while preserving per-file debounce behavior.
- Session listings now reuse cached summary arrays and incrementally consume appended `_index.jsonl` ranges, avoiding full index reparses after cross-process session updates.
- Chronicle file observation now hashes project files with bounded concurrency and reuses complete rescan fingerprints, eliminating the second stat/read/SHA-256 pass when `fs.watch` omits a filename.
- `loadPlugins()` now returns a `PluginHostHandle` (with `.loaded`, `.failed`, `.dispose()`, `.disposed`) instead of the loose `{ loaded, failed }` object. Destructuring `const { loaded, failed } = await loadPlugins(...)` remains compatible. `unloadPlugins()` is deprecated — prefer `handle.dispose()` for unambiguous host-scoped teardown.
- Kanban verification now keeps package managers and runtimes out of the generic shell allowlist, invokes only locally resolved Vitest/Jest entrypoints with argv-safe spawning, treats nonzero runner exits as failures, drains output deterministically, and terminates timed-out process trees.
- **All release surfaces aligned to `0.295.0`** — the root, 21 packages, 2 apps, website manifests and structured metadata, README highlights, website changelog, and this changelog report the same current release.

## [0.293.0] — 2026-07-20

> **API stabilization patch.** Deprecated compatibility shims are removed,
> the permission model is safe-by-default, structured logging replaces
> ad-hoc `console.*` calls, and the OpenAI tool-call adapter no longer
> emulates legacy bugs. See
> [`docs/migration/v0.293.0.md`](docs/migration/v0.293.0.md) for the full
> migration guide.

### Security
- **ACP permission policy is now safe-by-default** — `ACPSession` defaults to
  `readOnlyPermissionPolicy` instead of auto-approving everything. Trusted
  paths (Director, `/acp` slash, `wstack acp spawn/parallel`) explicitly opt
  into `defaultPermissionPolicy`. New or unknown callers get read-only by
  default ("deny by default, allow by exception").
- **`execFileSync` replaces `execSync`** in `cli-main.ts` — eliminates the
  shell-injection surface for the git-branch probe. Arguments are passed as
  an argv array, never parsed by a shell.
- **Home-directory startup guard** — `wstack` now refuses to start when the
  current working directory is the user's home directory (`%USERPROFILE%` on
  Windows, `$HOME` on Linux/macOS). Instead of silently creating a `.git`
  repo at the top of the filesystem and treating every file under it as
  project state, it prints a red warning ("This is not a working directory")
  and exits with code 1. Utility subcommands (`wstack auth`, `wstack version`,
  etc.) are unaffected — they dispatch before the guard fires.

### Removed (BREAKING)
- **`jsonArgumentsBuggy` option removed from the OpenAI tool-call adapter**
  (**BREAKING**) — `FromOpenAIOptions.jsonArgumentsBuggy`, the matching
  conditional bug emulation in `from-openai.ts`, and the entry in
  `openai-compatible.ts`'s `VALID_QUIRK_KEYS` are all gone. Providers that
  previously passed `{ quirks: { jsonArgumentsBuggy: true } }` to emulate the
  legacy OpenAI Realtime/Responses `arguments: "{}"` quirk now always receive
  the raw `arguments` string untouched. Drop the key from provider configs or
  the adapter will ignore it silently (no error). See
  `docs/plans/breaking-changes-next-major.md` for the full rationale.
- **`streamFleet` boolean removed; replaced by `fleetChatVerbosity` enum**
  (**BREAKING**) — The `AutonomyConfig.streamFleet` boolean, the
  `FleetStreamController.enabled`/`setEnabled` API, and the `LiveSettingsInput.streamFleet`
  field are all gone across core, cli, tui, webui, and webui-server. Use
  `fleetChatVerbosity: 'off' | 'full'` and `setMode()` instead. The WebUI
  local-prefs store includes a v10 migration that maps legacy
  `streamFleet: true → 'full'` and deletes the old key. `/settings stream-fleet`
  and `/agents chat` slash commands now use the enum directly.
- **`yoloDestructive`, `forceAllYolo`, and `confirmDestructive` removed**
  (**BREAKING**) — These were no-op compatibility fields on
  `PermissionPolicyOptions` and the runtime container's permission interface.
  YOLO mode already auto-approves every non-denied tool call (including
  destructive ones) via the sole `yolo: boolean` toggle. The
  `DefaultPermissionPolicy.setYoloDestructive`/`getYoloDestructive`/
  `setConfirmDestructive`/`getConfirmDestructive` methods are also gone.
- **Deprecated API aliases removed** (**BREAKING**) — `CodexRefreshedTokens`
  (use `OAuthRefreshedTokens`), `setCodexTokenPersister` (use
  `setOAuthTokenPersister`), `ProviderAvailability` (use `ProviderHealth`),
  and `HookRunnerOptions.allowShell` (use `allowNonPolicy`) are all gone.
  None had any consumers in the codebase.

### Added
- **Alibaba Token Plan Personal Edition provider** — 11 models (Qwen, GLM,
  DeepSeek, Wan2.7, HappyHorse) with drift-guard test coverage.
- **WebUI OAuth device-flow experience** — provider sign-in shows device codes,
  polls authorization state, reports progress and failures, and labels OAuth
  provider types consistently across settings and supported locales.
- **Richer context and memory inspection** — the WebUI replaces its inspector
  with an agents sidebar, adds a fullscreen memory graph, and redesigns context
  dashboards with detailed memory/token breakdowns. The TUI context panel and
  status bar expose the same information with clearer layout and thresholds.

### Changed
- **Modern token-saving tiers** — models with 128k-or-larger context windows use
  minimal prompt trimming instead of the legacy aggressive tier, retaining full
  capabilities while reducing recurring prompt overhead.
- **Prompt-cache defaults are optimized** — stable identity, tool-usage, and
  environment blocks carry cache markers; OpenAI prompt caching is enabled and
  cache lifetime defaults to one hour.
- **Structured Logger migration** — `console.*` calls in `phase-orchestrator`,
  `llm-selector`, `models-registry`, `selective-compactor`, `compaction-core`,
  and `compactor.ts` (HybridCompactor) + `intelligent-compactor.ts` now use the
  structured `Logger` interface. All three compactor classes wire
  `setCompactionDebugLogger(this.logger)` in their constructors.
- **TUI status presentation is calmer and denser** — memory context moves into
  the dedicated fourth status line, utilization uses a five-level Catppuccin
  progression, and the thinking-word animation uses a softer pastel palette.

### Fixed
- **Context visualization edge cases** — percentage bars are clamped, duplicate
  status-section decoration is removed, and the WebUI context modal no longer
  captures a stale timeout closure.
- **All release surfaces aligned to `0.293.0`** — workspace manifests, apps,
  README highlights, changelog data, migration docs, and website metadata now
  identify the same current release.

## [0.292.1] — 2026-07-20

> The **fresh coordination and resilient fallback patch**. Mailbox HTTP clients
> avoid stale retained messages by default, provider fallback reacts more
> accurately to quota and endpoint failures, and the browser interfaces gain
> smaller internal seams plus clearer user-message presentation.

### Added
- **Mailbox HTTP look-back controls** — `/mailbox/query`, `/mailbox/check`, and
  `/mailbox/events` accept `?sinceMs=<milliseconds>`. The standalone bridge and
  HQ gateway default to a one-hour window, `sinceMs=0` requests the full retained
  history, and positive overrides are capped at seven days. The same cutoff is
  applied before acknowledgements and to live SSE events so filtered messages
  are neither exposed nor marked read accidentally.
- **Mailbox bridge contract coverage** — router, HQ mutation, bridge mutation,
  and staged-source guard tests pin query forwarding, validation, timestamp
  filtering, acknowledgement behavior, and the public look-back constants.
- **SimpleUI component and hook seams** — agent/session selection, model
  selection, composer actions, file mentions, image attachments, and sticky
  scrolling now live in focused hooks and components with dedicated tests.

### Changed
- **SimpleUI composition is slimmer** — the main application now delegates its
  roster, model, composer, attachment, mention, and scroll behavior without
  changing the surrounding session workflow.
- **WebUI user-message surfaces are transparent** — standard and watch-mode
  user bubbles retain their primary-color border and directional corner while
  using normal foreground colors for readable links, code, and blockquotes.

### Fixed
- **Provider quota parsing is more complete** — retry delays and exhaustion
  signals embedded in provider response bodies are recognized, including
  usage-limit and rate-limit-exceeded wording.
- **Fallback routing rechecks live state** — provider availability is evaluated
  before each fallback attempt instead of relying on an earlier snapshot.
- **Endpoint-level 502 handling distinguishes outages from lost connectivity** —
  reachable-network failures enter the provider waiting room, while genuine
  connectivity loss avoids incorrectly penalizing the endpoint.
- **All release surfaces aligned to `0.292.1`** — workspace manifests, app
  packages, website metadata and release content, README highlights, and this
  changelog now report the same current version.

## [0.292.0] — 2026-07-20

> The **task-aware memory, context resilience, and HQ auth forensics release**.
> Super Memory retrieves project knowledge only when the current task calls for
> it, context management adapts to real gateway limits, and HQ authentication
> audit entries can be tied back to a secret-safe projection of persisted state.

### Added — HQ auth audit forensic tie-back (`contentHash`)
- **`contentHash` field on `HqAuthAuditEntry`** — every audit entry now carries
  a SHA-256 hash of the redacted `auth.json` projection, letting an operator
  reviewing `auth-audit.jsonl` tie an entry back to the exact on-disk state
  that produced it without the log ever holding derivable token material.
- **`hqAuthContentHash` helper + `HQ_AUTH_CONTENT_HASH_REDACTED` sentinel**
  (exported from `@wrongstack/core`) — the helper computes the hash over a
  projection where raw token strings, `passwordHash`, and `cookieSecret` are
  replaced by the sentinel, so two files that differ only in secrets hash
  identically. Re-derivable from the current `auth.json` via
  `hqAuthContentHash(await readHqAuthFile(dir))`.
- **Five emission sites carry `contentHash`** — `first-run` (browser + client)
  and `password-rotate` in `auth-store.ts`, `expired-prune` (browser + client)
  in `hq-server.ts`, and `token create` / `token revoke` in the `wstack hq`
  CLI handler. Every `kind` in the `HqAuthAuditKind` union now has at least
  one emission site with forensic tie-back. All five re-read the persisted
  file after writing (rather than hashing the in-memory snapshot) because
  `writeHqAuthFile` re-stamps `updatedAt` on the persisted payload.
- **`wstack hq audit verify` CLI helper** — re-derives the contentHash from
  the current on-disk `auth.json` and prints it alongside the resolved file
  paths, so an operator can compare against audit entries without writing a
  script. Exits 1 with an honest `(unavailable)` message when `auth.json` is
  missing (distinguishing it from the unreadable/malformed case).
- **Projection-shape snapshot test** — `auth-store-content-hash.test.ts` pins
  a known `(file → hash)` pair so any future change to the redacted projection
  (field set, key order, sentinel value) surfaces as an intentional test
  update rather than a silent hash migration across every deployed audit log.
- **`hq audit verify` test coverage** — `hq-audit-verify.test.ts` (7 cases)
  pins the output format, both exit-code paths, and the CLI-to-core hash
  contract.

### Changed
- **Task-aware Memory Injector** — on-demand retrieval now combines concrete
  tool paths/queries with live todo and Kanban state, expands direct seeds via
  graph and structural anchors, prefers long-lived project knowledge, and
  records pressure/budget/candidate/injection measurements. Every run now emits
  a bounded decision trace: the TUI renders activation/injection cards and the
  WebUI keeps the latest 50 runs as inspectable widgets with tag/anchor match
  reasons, confidence, freshness, importance, persistence, score, rejection
  reason, and character budget details. Activation (selected) and injection
  (actually written into context) are tracked separately. The trace stays outside model context. The normal
  budget rises to 8 diverse hints / 2800 characters and contracts near context limits.
- **Super Memory is on-demand by default** — ordinary turns no longer receive
  memory automatically; bounded, relevant active hints are attached only after
  matching file, search, edit, or shell tool calls. Deleted tombstones never
  enter model context, while stale hints are limited to mutation warnings.
- **Gateway-specific context limits are learned after overflow** — when a route
  rejects a request below the model catalog's advertised window, the session
  adopts the observed effective ceiling for subsequent context reporting and
  compaction instead of continuing to use the inflated catalog denominator.
- **Selective compaction keeps a refined working set** — selector previews span
  old constraints and the current tail, recent working pairs are protected in
  code, and collapsed tool exchanges retain bounded file/error evidence without
  carrying their raw payloads forward. Rewrites remain threshold-driven to
  preserve prompt-cache stability between compactions.
- **Active-profile settings routing is consistent** — CLI, TUI, WebUI, auth,
  provider, plugin, and MCP configuration mutations target the selected profile
  instead of treating the root bootstrap file as a settings store.
- **Context reporting and interface state are more reliable** — `/context`
  opens through the TUI panel path, status-line accounting uses the effective
  provider context, and derived WebUI fleet selectors retain stable snapshots.
- **All release surfaces aligned to `0.292.0`** — workspace manifests, app
  packages, website metadata and release content, README highlights, and this
  changelog now report the same current version.

## [0.291.1] — 2026-07-19

> The **explainable permissions and runtime hardening release**. Permission
> decisions are now inspectable before execution and recorded after execution;
> autonomy has an explicit opt-out; Super Memory gains safe maintenance tools;
> and provider routing, profile migration, TUI behavior, and session replay are
> more resilient under real-world workloads.

### Added — permissions, autonomy, and operations
- **Read-only permission explainer** — `wstack permissions explain` evaluates a
  proposed tool call through the effective permission policy and returns a
  structured decision trace without executing the tool.
- **Chronicle permission decisions** — effective allow, confirm, and deny
  outcomes are recorded so operators can audit which policy governed a tool
  call and why.
- **Explicit YOLO opt-out and first-run disclosure** — `--no-yolo` and
  persisted `yolo: false` provide a clear override, while the first interactive
  launch explains the selected behavior. Explicit deny rules continue to win.
- **Super Memory maintenance workflow** — memory listing is paginated, deleted
  record purging is opt-in, embedding backfill is idempotent, and
  `scripts/super-memory-maintenance.mjs` provides a dedicated maintenance entry
  point for large stores.

### Added — bundled operational skills
- **`auto-review` and `mnemosyne` now ship with `@wrongstack/core`** — their
  project-independent instructions and Mnemosyne agent prompt resource are
  available in every WrongStack project instead of remaining local development
  skills. Bundled-skill discovery is sorted within each priority layer so
  eager prompt-budget selection is deterministic across filesystems; eager and
  progressive context paths are covered by integration tests.

### Changed — routing and configuration reliability
- **Profile migration is concurrency-safe** — migration writes are serialized,
  backed up, and hardened against multiple WrongStack processes starting at
  the same time.
- **Reviewer routing stays explicit** — Chimera review subagents always receive
  the active session provider/model, the shared reviewer fallback chain cannot
  resolve empty, and runtime drift checks keep CLI and core defaults aligned.
- **Provider-only matrix routes are preserved** — resolving a route no longer
  drops a provider selection when no model override is present.

### Fixed — execution and interface stability
- **Provider tool-schema compatibility** — top-level `anyOf`, `oneOf`, and
  `allOf` schemas are normalized for Anthropic and OpenAI tool payloads.
- **Session replay integrity** — empty assistant turns are no longer persisted,
  and existing empty turns are repaired when sessions are replayed.
- **Process and command guards** — Node runtime termination checks and command
  validation are hardened without weakening explicit user-approved execution.
- **TUI streaming stability** — measurement no-ops no longer trigger render
  churn, streaming output no longer causes unexpected upward scrolling, and
  asynchronous coordination tests wait on observable state instead of fixed
  timers.
- **All release surfaces aligned to `0.291.1`** — workspace manifests, app
  packages, website metadata and content, README highlights, and changelog
  release data now report the same current version.

## [0.290.0] — 2026-07-18

> The **Super Memory deletion-protection and storage-health release**. It closes
> autonomous deletion paths, adds review-mediated decisions, and keeps the
> JSONL backend compact and observable as stores grow.

### Added — Super Memory storage health
- **Periodic JSONL compaction** — the append-only `memories.jsonl` log now
  compacts automatically after mutations when total memory records exceed 3×
  the unique ID count (minimum 500 records). The rewrite is atomic (temp-file +
  rename) and preserves non-memory records. Uses the same revision-based dedup
  logic as `loadMemories`. JSONL backend only; SQLite compacts automatically
  via UPSERT.
- **`/memory compact-log` slash command** (JSONL backend only) — manual
  on-demand log compaction, complementing the automatic threshold-gated path.
  Unlike `/memory compact` (LLM-based content deduplication), this is a
  mechanical operation that rewrites the JSONL keeping only the latest record
  per memory ID. The SQLite backend returns a capability message instead.
- **`resolveCandidate` review pipeline** — new store method that applies
  user-authorized review decisions (delete/archive/keep) to candidate targets.
  Permanent memories refuse deletion even via the resolver. The resolver is
  the sole authorized path for autonomous deletion — it passes `force`
  internally as the review decision.
- **`compactLog()` public API** — the compaction logic is now exposed as a
  public method returning before/after statistics, enabling programmatic and
  CLI invocation. JSONL backend only.
- **`getLogStats()` public API** — read-only log health metrics (raw records,
  unique IDs, duplicate ratio, file size) surfaced in `/memory stats` with
  a compaction hint when the duplicate ratio exceeds 3×.

### Changed — Super Memory deletion protection
- **`memory_delete` requires `force: true` for ALL deletions** — previously
  only `persistence: 'permanent'` memories were guarded. Now every deletion
  via the `memory_delete` tool and `deleteSuperMemory` store method requires
  explicit authorization via the `force` flag. The tool schema, store guard,
  and system prompt all reflect this contract. Note: `memory_update({ status:
  'deleted' })` and `forget` remain available as lower-level escape hatches
  for non-permanent memories; the guard specifically closes the autonomous
  agent paths (Mnemosyne, consolidator, unguarded tool calls).
- **SessionMemoryConsolidator is strictly add-only** — the consolidator (runs
  unattended after every session) can no longer issue `edit` or `delete` ops.
  LLM-emitted non-`add` operations are silently ignored. This closes the
  unsupervised substring-matched deletion path identified in the mass-deletion
  postmortem.
- **Mnemosyne Phase 3 is propose-only** — the custodian agent files review
  proposals via `memory_candidates({ action: 'propose' })` and never calls
  `memory_delete` or `memory_update({ status: 'archived' })`. Final decisions
  belong to the user via `memory_candidates({ action: 'resolve' })`.
- **JSONL dedup prefers non-deleted on equal revisions** — when two records
  share the same revision, the store now prefers `active`/`stale`/`archived`
  over `deleted`. A same-revision tombstone is treated as a stale duplicate,
  not a newer state. Previously, file ordering determined the winner, causing
  active memories to appear deleted after log reordering.

### Fixed — Super Memory
- **JSONL dedup ordering bug** — fixed the root cause of active memories
  silently flipping to `deleted`: the `revision >= current.revision` tiebreaker
  used last-in-file-wins on equal revisions, allowing a same-revision tombstone
  appended after an active record to overwrite it. Changed to strict
  `revision > current.revision` with status-preference on ties.
- **Super Memory mass-deletion root cause** — closed the three autonomous
  deletion paths identified in the postmortem: (1) Mnemosyne Phase 3 direct
  deletions (now propose-only), (2) consolidator LLM-issued edit/delete ops
  (now add-only), (3) unguarded `memory_delete` tool calls (now require
  `force: true`). The `memory_update({ status: 'deleted' })` and `forget`
  paths remain available as explicit escape hatches for non-permanent memories.

## [0.289.0] — 2026-07-18

> The **self-correcting review release**. Chimera and continuous auto-review now
> understand the work around a changed file, can dispatch targeted fix agents
> for serious findings, and re-review the result in a bounded loop. This release
> also completes the internal AutoPhase → Goal vocabulary migration and raises
> confidence across the monorepo with a broad integration-test and coverage pass.

### Added — Context-aware review and bounded cascade
- **Richer review context** — review agents receive per-file diffs, sibling
  changes, recent commits, active TODOs, the current Kanban card, and Chronicle
  provenance instead of judging isolated file snapshots. Rename and quoted-path
  parsing is hardened for real-world Git output.
- **Continuous `/auto-review` surface** — the opt-in `wstack-auto-review`
  plugin exposes its status and configuration, debounces iteration-complete
  changes, and sends bounded batches through the governed Chimera review path.
- **Severity-driven fix agents** — `cascadeOn: "high" | "critical"` can
  dispatch `bug-hunter` and, for security-related findings,
  `security-scanner` to investigate and apply verified fixes.
- **Closed self-correcting loop** — after cascade agents finish, WrongStack
  re-reads the changed files and reviews the post-fix state. `maxCascadeDepth`
  bounds the fix → re-review cycle (default `2`), with an explicit manual-review
  notice when the limit is reached.
- **Post-session Chimera parity** — `cascadeOn` and `maxCascadeDepth` are also
  wired into the Chimera plugin, so session-end reviews can use the same bounded
  correction flow as continuous auto-review.

### Changed — Goal terminology and runtime reliability
- **AutoPhase internals are now Goal internals** — source directories, exported
  `AutoPhase*` symbols, CLI/TUI state, tests, and documentation were migrated to
  `Goal*` naming. Consumers of the old exported names must update their imports.
- **SDD task generation is implemented** — `TaskGenerator.generateFromSpec()`
  now turns spec requirements into task nodes, unblocking the TaskFlow suite.
- **TUI interaction fixes** — completed tasks no longer leave a stale draft that
  swallows Enter, `/clear` cleans up fleet state, Escape handling is consistent,
  and the banner model label refreshes after remount.
- **Security and persistence hardening** — command arguments are redacted at
  telemetry emit sites, SuperMemory SQLite matches JSONL hygiene and deletion
  safety, agent-status registry writes are serialized, and OAuth links are
  rendered as clickable OSC 8 terminal hyperlinks.

### Added — Verification depth
- **Broad integration coverage** now exercises Director, session storage,
  ToolExecutor, mailbox/HQ protocol paths, SDD controls, Kanban concurrency,
  SuperMemory, TechStack, LSP search, WebUI finalization, and core utilities.
- **Coverage reporting and gates** were refreshed from verified monorepo-wide
  results, with flaky SDD, Kanban, and responsive WebUI assertions stabilized.

### Changed — Release alignment
- **All release surfaces are aligned to `0.289.0`** — workspace manifests,
  both apps, website metadata and badges, README highlights, and the website
  changelog share the same release line.

### Added — Adaptive `/goal` coordination
- **`[DONE: index|prefix]` deliverable markers** — autonomy iterations can
  now mark individual deliverables complete via a 1-based index or a
  case-insensitive text prefix (e.g. `[DONE: 2]` or `[DONE: refactor auth]`).
  Markers are idempotent and silently ignored when they don't match.
- **`GoalKanban` ↔ `/goal` two-way sync** — when the coordinator runs,
  every newly-completed deliverable moves its matching Kanban task into
  the `Done` column with `status: 'completed'`. Conversely, a task already
  marked completed in the UI rewinds the goal's `progress` and re-applies
  the `✅` marker on the next coordinator pass.
- **Deterministic progress bar** — `goal.progress` is now
  `Math.round(done / total * 100)` derived from the deliverables checklist
  (not from whatever percentage the LLM emitted). `progressNote` is set to
  `'<done>/<total> deliverables complete'`, which the TUI's `GoalPanel`
  already renders next to its bar.
- **One-shot Brain consultation** — when every deliverable is complete,
  the coordinator asks Brain once for a strict `goal_reached` vs
  `keep_working` verdict. `goal_reached` persists
  `goalState: 'completed'`, `engineState: 'stopped'`,
  `progressNote: 'goal reached'`, `reachedAt`, and `reachedNote: 'goal reached'`.
  `keep_working` (and `deny`) keep the goal active at `100%` so the next
  iteration can re-attempt. Brain is never called when the deliverable
  list is empty, when markers complete no deliverables, or when Brain
  isn't wired.

### Changed
- **Coordinator is the sole owner of completion decisions.** The legacy
  `[PROGRESS: 100%]` auto-complete path no longer unlinks `goal.json`
  when a `[DONE:]` marker was emitted in the same iteration. The single
  guard `if (parsed.progress >= 100 && coordinatedProgress === undefined)`
  enforces the contract: if the new flow ran, it owns the verdict.
- **`goal.json` is preserved on reach.** `/goal reached` now persists the
  final state (`goalState: 'completed'`, `reachedAt`, `reachedNote`) in
  the file instead of deleting it, so the TUI progress bar and the
  WebUI status snapshot keep showing the 100% / "goal reached" verdict
  across reloads and across sessions.

### Added — Schema (additive, backward-compatible)
- **`GoalFile.kanbanBoardId?: string`** — preferred lookup key for the
  Kanban sync; falls back to the existing tag-based search if absent.
- **`GoalFile.reachedAt?: string`** — ISO timestamp recorded when Brain
  confirms `goal_reached`.
- **`GoalFile.reachedNote?: string`** — currently the literal
  `'goal reached'`; reserved for future verdict variants.
- **`JournalEntry.source: 'deliverable'`** — new source for the
  per-deliverable audit entry the coordinator appends.

### Reference
- Coordinator: `packages/core/src/storage/goal-coordination.ts`
- Engine wiring: `packages/core/src/execution/eternal-autonomy.ts`
- Storage: `packages/core/src/storage/goal-store.ts`
- Slash reference: `docs/slash/goal.md` (new "Adaptive coordination" section)
- Tests: `packages/core/tests/storage/goal-coordination.test.ts` (8 cases),
  `packages/core/tests/execution/eternal-autonomy.test.ts` (full-loop case)

## [0.288.0] — 2026-07-17

> The **interactive launch-menu release**. A plain `wstack` launch now opens a
> remembered four-option surface picker on a TTY, covering TUI/REPL, WebUI,
> SimpleUI, and HQ without requiring users to memorize flags. The release also
> aligns the root, all 21 packages, both apps, and the marketing website to
> `0.288.0`.

### Added — Interactive launch menu
- **`wstack` shows a four-option launch menu on a TTY** when no surface
  flag is given. The menu lets the user pick between TUI/REPL, WebUI,
  SimpleUI, and HQ, plus an optional port + host for the bound
  surfaces. A previous choice is summarized as a one-line
  "Continue with these? [Y/n/q]" gate, mirroring the existing
  `runLaunchPrompts` pattern. Implementation lives in
  `packages/cli/src/boot/launch-menu.ts` and is wired into
  `cli-context.ts` between the help/desktop/HQ short-circuits and
  `boot()`.
- **`--no-menu` flag** opts out of the menu and falls back to the
  historical behaviour (the first interactive prompt becomes the
  TUI/REPL picker).
- **`LaunchMenuChoice` schema** added to `packages/core/src/types/config.ts`
  and persisted as `config.launch.menuChoice` so the next launch can
  offer the summary gate.
- **`docs/cli/launch-menu.md`** describes the menu flow, default ports,
  skip rules, and opt-out paths.

### Changed — Release alignment
- **All release surfaces are aligned to `0.288.0`** — the root manifest,
  21 workspace packages, 2 apps, website package metadata, JSON-LD software
  version, homepage version badge, README release summary, and website
  changelog now share one package line.

## [0.287.0] — 2026-07-15

### Added — Always-on Director Mode & Goal Flow
- **Director Mode is permanently enabled** — `--director` / `--no-director`
  CLI flags, the `directorMode` configuration field, the runtime
  `promoteToDirector()` switch, and the `/director` "promote" semantics have
  all been removed. `isDirectorMode()` unconditionally returns `true`,
  `ensureDirector()` always builds the Director, the delegate tool is
  registered unconditionally, and the entire fleet surface (`/spawn`,
  `/fleet`, `/delegate`, `/goal`, `/supervisor`, `/shadow`) is available on
  every session.
- **Goal Flow with Kanban launch** — `/goal set` now auto-creates a Kanban
  board for the deliverables, renders a Goal event plus a kanban preview,
  prompts for the autonomy mode (Eternal or Parallel), and launches the
  chosen mode. The new `GoalKanbanPanel` auto-refreshes every two seconds
  during an autonomy run.
- **TUI context window inspector** — F-key panel that shows live token
  pressure, a per-segment composition bar, and a token-by-tool table.
- **SuperMemory WebUI integration** — full CRUD panel, WS handlers,
  `/memory` navigation, and a memory-graph viewer that renders anchor
  nodes, supersedes / supersedes-by / contradicts relations, and tooltips.
- **TUI cron surfaces** — `/cron` slash command, cron-jobs panel, cron
  trigger chip, and the cron-store / cron-jobs wiring behind them.
- **Cron-aware `Date` helpers** — SuperMemory now tolerates empty or
  malformed `ts` values via `parseDate()`, `daysAgo()`, and `fmtDate()`.
- **WebUI memory lifecycle hardening** — request-generation tokens and
  explicit listener cleanup keep `loadMemories()`, `handleSave()`, and
  `handleDeleteConfirm()` from leaking WS handlers or leaving `saving` /
  `deleting` stuck.
- **WebUI context dashboard hardening** — request-generation token, scoped
  timeouts, and proper WS unsubscribe guarantee that `fetchDebug` cannot leave
  the dashboard in a permanent "loading" state and that updates never reach
  unmounted components.

### Added — Memory, Mailbox & Tooling
- **ToolExecutor "governed execution bridge"** — meta-tools (`tool_use`,
  `batch_tool_use`) must now route nested calls through a bridge installed on
  `Context.meta` by the live `ToolExecutor`. The bridge reruns every nested
  call through the normal schema, hook, permission, capability, timeout,
  scrub, and audit path. Tools that try to bypass it fail closed with an
  actionable error and never touch `tool.execute()` directly.
- **ACP `session/request_permission` error responses** — when the configured
  permission policy throws, the ACP session now answers the JSON-RPC request
  with a structured `-32603` error instead of leaving the requester hanging.
- **Project-wide agent mailbox contract** — every client and agent now shares
  one canonical project identity across processes, sessions, branches, and
  linked Git worktrees. System prompts at every token-saving tier explain how
  to discover peers, read mail, address exact agent ids, and broadcast.
- **Mailbox read-receipt batching** — the agent-loop mailbox checker now
  issues a single `ackMany` per iteration instead of one `ack()` per message,
  removing the read–modify–rewrite hot loop on multi-message turns.
- **SuperMemory CRUD in `/memory` CLI command** — `remember`, `update`, and
  `delete` work end-to-end against the SuperMemory store with structured
  flag-based arguments and validation feedback.

### Changed — UX, Tooling & API
- **Next-step prompt contract** — `<nextsteps>`, `/suggest`, and prediction
  output now contain only exact agent-directed messages that can be submitted
  through the TUI or WebUI; human-only chores are excluded and no-op status
  text is no longer stored as a selectable suggestion.
- **TUI F3 agents monitor redesigned** — left/right split with a compact
  sidebar of agent cards and a wider transcript pane, bounded by a real
  `maxPanelRows` budget so the panel no longer overflows inline layouts.
- **TUI banner redesign** — gradient FIGlet wordmark, version pinned to the
  top-right, compact connection-info block, and links block at the bottom.
- **TUI terminal-resize correctness** — `<Static>` re-emits history at the
  new width on resize, and `ScrollableHistory` tracks terminal width via
  React state to avoid stale renders.
- **Cron-driven PostToolUse hooks run in the background** — advisory
  PostToolUse hooks (`test-runner-gate`, `type-gate`, `format-on-save`,
  `dead-code-detector`, `diff-summary`, `refactor-suggester`,
  `security-hotspot-scanner`, `config-validator`, `schema-evolution-guard`,
  `interface-contract-guard`, `feature-flag-tracker`, `doc-sync-guard`,
  `spec-linker`, `auto-i18n-extractor`, `accessibility-auditor`,
  `api-compatibility-gate`, `migration-planner`, and friends) run
  fire-and-forget. PreToolUse hooks and security-critical PostToolUse hooks
  (`secret-scanner`, `path-guard`, `checkpoint`, `lint-gate`, `loop-breaker`,
  `injection-shield`, `token-budget`) stay synchronous.
- **`MultiAgentHost` keeps `isDirectorMode()` true at every stage** — the
  Director is built lazily on first spawn but the host reports
  `isDirectorMode() === true` from construction, so callers no longer have to
  special-case the pre-spawn window.
- **`MultiAgentHost` interface** — `promoteToDirector()` always materialises
  the lazy Director; the obsolete `directorMode` option, `directorPinned`
  launch flag, and `Cannot promote ... --director` error path have been
  removed.

### Fixed — Correctness, Stability & Tooling
- **`isSuperMemoryStore` guard checks every Super Memory method** — the
  duck-type now verifies `getSuperMemory` and `deleteSuperMemory` as well,
  preventing late `TypeError`s from non-conforming `MemoryStore` instances
  in `/memory update` / `/memory delete`.
- **`goalTag` board selection uses exact match** — the Kanban goal-tag
  picker now matches board tags by exact equality instead of `includes()`,
  so `goal:auth` no longer hijacks the `goal:authentication` board.
- **`closePanels` resets `contextPanelOpen`** — toggling another panel no
  longer leaves the context panel stale, so `/context window` reliably
  closes before re-opening.
- **TUI reducer is exhaustively checked** — new action variants surface as
  compile errors instead of silently returning `undefined`.
- **Worktree-monitor action names match the reducer** — F4 toggles and the
  `/worktree` slash command use the same `toggleWorktreeMonitor` action
  the reducer expects.
- **`MemoryManager` request lifecycle** — `loadMemories`, `handleSave`,
  and `handleDeleteConfirm` now use generation tokens, timeouts, and
  explicit unsubscribe so the panel never reports stale results or leaks
  WS handlers across reloads.
- **Workspace memory backend simplification** — `superMemory.enabled=false`
  no longer switches memory backends; the Super Memory store is now the
  single canonical store and `enabled` only gates auto-injection / hygiene
  behaviour.
- **Lint and test tooling hardening** — `test-runner-gate` plugin and its
  tests were rewritten to use `node:child_process.execFile` via a callback
  promise (it was previously awaiting a non-promise, which masked real
  failures). WebUI accessibility audit, TUI input double-stdin suppression,
  CronPanel unused-variable cleanup, CronTrigger fragment removal, and
  desktop SVG `<title>` were all resolved in this release.

### Tooling — Build & Test
- **TypeScript 7 build system stayed in place** — esbuild + native
  `tsc --emitDeclarationOnly`; no `tsup` or `jszip` is used. WebUI/HQ
  bundles use the Vite 8 / Rolldown `manualChunks` function contract.
- **Coverage thresholds** — root Vitest: ≥73% lines/funcs, ≥72% statements,
  ≥64% branches. WebUI: ≥19% statements/branches/lines/funcs. These are
  calibrated to the codebase without DOM/jsdom and without LSP stubs.

## [0.286.0] — 2026-07-13

> The **autonomous Brain, realtime mailbox, and accessibility hardening**
> release. The Brain grows a headless autonomous decision layer with live
> settings across CLI/TUI/WebUI and exact option-id enforcement; the mailbox
> bridge adds SSE push, indexing, compaction, and HTTP hardening; WebUI and HQ
> get a broad accessibility/performance pass; the TUI gains a fullscreen F3
> agents monitor; MCP OAuth becomes governed; and the workspace manifests,
> website, README, and changelog are aligned to `0.286.0`.

### Added — Brain, mailbox & media
- **Autonomous Brain control plane** — added headless autonomy, an LLM pool,
  multi-LLM council support, and a decision ledger, with live/persistable Brain
  settings shared across CLI, TUI, WebUI, and the reusable model picker.
- **Exact Brain option selection** — Brain decisions with options now require an
  exact option id, preventing prose such as "do not spawn" from accidentally
  selecting a `spawn` option.
- **Realtime mailbox bridge** — added SSE delivery for external agents,
  ack/delete/restore events, sender/recipient indexes for fast queries, HTTP
  bridge rate limiting/from-validation/TTL coverage, and mailbox auto-compaction
  UI with localized badges.
- **WebUI image input** — chat now carries pasted, dropped, picked, regenerated,
  and edit-resend image attachments as real `ImageBlock`s, with a vision-adapter
  fallback for non-vision models.
- **Governed MCP OAuth** — MCP authorization now routes through the governed
  OAuth path instead of ad-hoc approval flow glue.

### Changed — WebUI, TUI & docs
- **Accessibility sweep** — enabled the Biome accessibility preset and resolved
  label, role, aria-expanded, icon-button, autofocus, contrast, semantic-list,
  keyboard, and Radix Dialog modal warnings across WebUI, HQ, and website
  components.
- **TUI agents monitor** — F3 now opens a fullscreen agents monitor and Esc
  priority handling closes overlays reliably.
- **WebUI performance polish** — lazily loads `react-markdown`,
  `@uiw/react-textarea-code-editor`, and SetupScreen paths, debounces mailbox
  refresh bursts, fixes analytics timer cleanup, and replaces unsafe
  `crypto.randomUUID` / index-key patterns.
- **Welcome, Kanban, and settings UX** — refreshed the WelcomeScreen with
  gradient prompt cards, improved Kanban live polling and task-card semantics,
  and added display toggles for thinking logs and tool-call grouping.
- **Release and project docs** — updated tool counts, licensing badges, fleet
  roster numbers, release checklist state, roadmap status, and the `wstack init`
  deprecation wording.

### Fixed — runtime correctness
- **Subagent and HQ cleanup** — retired completed subagents more reliably,
  filtered dead sessions from HQ views, and fixed memory leaks found during the
  audit pass.
- **Core status and logging fixes** — conflict-marker detection is deterministic,
  mailbox status tie-breaks are stable, missing permission-policy schema exports
  are restored, and plan/task-store save failures use structured JSON logging.
- **Goal lifecycle repairs** — fixed three goal lifecycle bugs and refreshed the
  TUI goal summary every tick so status lines update after goal clearing.
- **Test-suite portability** — repaired POSIX runner failures and kept the tool,
  core, TUI, and security-scanner regressions passing across platforms.

### Changed — tests & versions
- **Coverage and regression net** — expanded targeted tests across kanban,
  tools, TUI, WebUI Server, ACP, MCP, telegram, super-memory, SDD, providers,
  mailbox SSE, Brain decisions, and release/workflow cleanup paths while raising
  coverage thresholds.
- **Version alignment** — all workspace packages, the apps, the HQ dashboard,
  and `website/` are aligned to `0.286.0`; README and CHANGELOG release copy now
  match that package line.

## [0.285.0] — 2026-07-11

> The **TypeScript 7 build-system and release-docs alignment** release. The
> workspace build moved off 19 individual `tsup` configurations and onto one
> topologically ordered esbuild + TypeScript 7 package driver, while compiler
> API consumers use the supported TypeScript 6 compatibility package. README
> and the website now describe the current 18-package + 2-app workspace shape
> and the release copy is aligned to `0.285.0`.

### Changed — build system
- **TypeScript 7 + esbuild packaging** — replaced all 19 `tsup` configurations
  with one topologically orchestrated package driver: esbuild produces ESM/CJS
  bundles and native TypeScript 7 emits declaration trees. Package dependencies
  remain external, flattened declaration entry points use safe re-export shims,
  and the WebUI/Vite, CLI shebang, WebUI Server bin, and Electron preload/main
  contracts are preserved.
- **Compiler API compatibility isolated** — syntax diagnostics and codebase
  indexing use Microsoft's `@typescript/typescript6` compatibility package,
  while workspace builds and typechecks run on TypeScript 7.0.2. This follows
  TypeScript 7's supported side-by-side path until its new API stabilizes.

### Changed — docs & website
- **Workspace package count refreshed** — README and the website now describe the
  current workspace shape as 18 packages + 2 apps, update the package table with
  `@wrongstack/kanban`, `@wrongstack/sdd`, `@wrongstack/security-scanner`,
  `@wrongstack/webui-server`, and the published `wrongstack` app, and remove
  stale workspace-count wording from release copy.

## [0.284.0] — 2026-07-10

> The **HQ dashboard hardening and prompt-cache stability** release. The HQ
> browser gets a real token layer — a full-screen token gate, a single
> sessionStorage-backed token source, and an auth scope that gates exactly the
> data channels — plus a machine→project→terminal→agent fleet topology map, a
> mailbox composer with server-routed message actions, and per-agent live
> transcripts in the Console. The core agent freezes each system-prompt epoch
> and splits the prompt into core/session/volatile regions so the provider
> cache prefix stays byte-stable; built-in tools declare structured selection
> boundaries; ChatGPT/Codex OAuth gains a fallback loopback port and
> `id_token` account recovery; and boot validates saved provider/model
> defaults before offering them. All 18 packages, 2 apps, and the website are
> aligned to `0.284.0`.

### Added — HQ command center
- **Browser token gate** — when HQ runs in browser-token mode, a token-less or
  stale-token tab now renders a full-screen token-entry gate instead of a bare
  JSON 401 or an endless "reconnecting…"; submitting stores the token and
  reloads the dashboard authenticated.
- **Single browser-token source** — a new `lib/auth.ts` reads the `?token=`
  startup URL once, persists it to `sessionStorage`, and feeds every consumer:
  HTTP requests through `authorizedFetch` (`Authorization: Bearer`) and the WS
  client through `?token=`.
- **Fleet topology map** — the Fleet Map view is rebuilt on a pure
  machine → project → terminal → agent topology builder with live agent badges
  and dedicated regression tests.
- **Mailbox composer + message actions** — compose mailbox messages from the
  dashboard and act on existing ones (mark read, acknowledge, reopen, soft
  delete, restore) through `POST /api/mailbox/messages/:id/action`; the server
  resolves the target project mailbox from `sessionId`/`projectId` so a
  browser can never supply a raw filesystem path.
- **Per-agent Console transcripts** — the Live Console merges subagent
  `agent.message` payloads into transcript entries, so selected agents render
  chat-style thinking/tool/error turns the same way sessions do.
- **Publisher connect diagnostics** — after five consecutive failed HQ
  connects the publisher emits one structured warning naming both possible
  causes (unreachable server vs rejected client token) instead of queueing
  silently forever.

### Added — core agent & tools
- **System-prompt regions** — `SystemPromptBuilder.buildRegions()` splits the
  prompt into `core` / `session` / `volatile` regions; core + session form the
  provider-cache prefix and stay byte-for-byte stable, while volatile blocks
  (active plan, plugin contributors) are appended at request time.
- **Frozen prompt epochs** — each system-prompt array is frozen at its first
  request boundary so turn-time code cannot silently invalidate the provider
  cache prefix; the completed-work ledger now rides as a volatile request-time
  block instead of mutating the prompt in place.
- **Tool selection boundaries** — tools can declare
  `selection: { doNotUseWhen, useInstead }`; eight built-ins (`read`, `write`,
  `edit`, `bash`, `exec`, `glob`, `grep`, `patch`) ship boundaries and the
  system prompt renders them next to each tool listing.

### Changed
- **HQ auth scope** — the dashboard shell (index.html, `/assets/*`, SPA
  fallback) is served publicly; browser tokens now gate exactly the data
  channels — every `/api/*` route and the WS upgrades.
- **ChatGPT/Codex OAuth hardening** — the loopback server falls back to port
  `1457` when `1455` is busy, the authorize URL carries the actual bound port,
  scopes include the connectors API, and the account id is recovered from the
  `id_token` when the access token lacks it.
- **Saved-default validation at boot** — before offering "Continue with
  these?", boot verifies the saved provider still exists, has a usable
  credential, and that the saved model is still visible; invalid defaults
  route to the picker with a reason (or exit with guidance in
  `--no-interactive` runs) instead of crashing later in provider setup.
- **Catalog-backed model lists** — for ChatGPT/OpenAI/Codex the saved config
  model list is treated as a cache/visibility hint augmented from the curated
  catalog, and provider mutations clear stale top-level provider/model
  defaults (`clearStaleProviderDefaults`).
- **TUI auth panel URLs** — OAuth flow URLs render fully wrapped in a hint
  color instead of truncating, so they can be copied or clicked.
- **Desktop project manifests** — `projects.json` and desktop state entries
  are normalized and deduped through one shape-tolerant parser (accepts
  `projects`, `recentProjects`, and `recents` arrays).
- **Docs** — `AGENTS.md` consolidated as the single agent-facing project
  reference (`CLAUDE.md` removed); the tool-author guide documents the new
  `selection` boundary field.

### Fixed
- **Desktop recents survival** — unregistering a project no longer removes it
  from the recent-projects list.
- **HQ mailbox project resolution** — `projectId` now matches both the
  registry `projectSlug` and the sha-derived id publishers stamp on event
  envelopes, so mailbox sends and actions reach projects regardless of id
  scheme.

## [0.283.1] — 2026-07-08

> The **HQ prompt delivery and picker polish** patch. HQ PromptDock can now
> choose whether an operator prompt is a steer, BTW note, or queued message, and
> falls back to direct mailbox delivery when no client is connected; the HQ Live
> Console renders richer chat/tool transcripts; terminal provider/model pickers
> share the new responsive boxed UI; and the SQLite codebase indexer avoids
> repeated statement preparation during large writes. All workspace packages and
> the website are aligned to `0.283.1`.

### Added — HQ command center
- **PromptDock send types** — HQ prompts can be sent as `steer`, `btw`, or
  `queue`, with the emitted subject derived from the selected type so a steer,
  FYI note, or queued prompt cannot drift into the wrong subject label.
- **Offline mailbox delivery** — the HQ dashboard falls back to
  `POST /api/mailbox-send` when a target project has no connected client,
  writing directly to the project mailbox through server-side session/project
  resolution instead of requiring an online terminal.
- **Richer Live Console transcript** — `@wrongstack/webui-hq` now renders
  selected session transcripts as chat turns with user/assistant bubbles,
  collapsible tool cards, diff views for edits/writes, terminal-style output,
  pretty JSON/input views, and todo checklists.
- **HQ dashboard regression coverage** — PromptDock subject derivation and the
  transcript formatting/rendering helpers now have focused tests.

### Changed
- **Responsive terminal pickers** — the startup provider/model picker now uses
  the refreshed boxed layout, adapts to terminal width, and the numbered
  fallback picker uses the same visual treatment.
- **Faster codebase indexing writes** — `IndexStore` caches prepared SQLite
  statements during symbol writes to avoid repeated prepare/finalize overhead on
  large indexing runs.

### Fixed
- **PromptDock subject/type mismatch** — the subject line now follows the send
  type single source of truth, preventing stale queue-flavored subjects on
  steer/BTW sends.
- **CI lint blockers** — two Biome error-level violations were cleared so the
  release gate stays green.

## [0.283.0] — 2026-07-08

> The **interactive surfaces and kanban reliability** release. TUI slash
> commands now open first-class panels for MCP, tools, Brain, Shadow, Help, and
> the remaining command-backed surfaces; WebUI gets a broad visual/i18n refresh
> with persisted tool toggles; built-in modes split into lite/deep families;
> context-window overrides are honored consistently; kanban orchestration gains
> queue/recovery/cost guardrails; and mailbox, Telegram, fallback, and shell
> confirmation paths are tightened. All workspace packages and the website are
> aligned to `0.283.0`.

### Added — interactive surfaces
- **TUI slash-menu panels** — `/mcp`, `/tools`, `/brain`, `/shadow`, and
  `/help` now open interactive Ink panels with reducer-backed keyboard flows
  instead of dumping static command text.
- **Remaining command-backed panel wiring** — `/agents`, `/coordinator`, and
  `/goal` now route into their existing TUI surfaces where appropriate, keeping
  the slash menu and monitor panels in sync.
- **Continue/shell safety panels** — TUI history rehydration, continue-intent
  detection, shell command warning UI, and reducer state make risky continue or
  shell-confirm paths explicit and resumable.
- **WebUI settings panels** — Brain, Shadow, and Tools settings are exposed in
  the WebUI settings surface with matching i18n entries.

### Added — kanban and benchmarks
- **Kanban reliable queue groundwork** — queue health, recovery routing,
  reliable-queue behavior, retry/cost handling, and Director integration now
  have dedicated types, manager/storage support, tool surface updates, and
  regression tests.
- **Kanban orchestration docs** — the roadmap, orchestration contract, and
  cost/director integration design now document the intended queue and
  recovery behavior.
- **Local manifest benchmark suite** — `@wrongstack/bench` adds local manifest
  suite/grader support, richer fingerprint handling, and session-metric
  updates for local benchmark runs.

### Changed — modes and context
- **Built-in modes split into lite/deep families** — token-saving variants
  (`audit-lite`, `debug-lite`, `plan-lite`, `refactor-lite`, `research-lite`,
  `review-lite`, `test-lite`) are now explicit mode definitions, and `/mode`
  docs/tool output describe the new families.
- **Context-window overrides honored consistently** — mode/context-window
  overrides now flow through CLI execution, REPL, TUI settings, and mode
  picker paths instead of being dropped in selected surfaces.
- **Model fallback/tool menu polish** — fallback switching and tool-menu state
  handling were tightened so provider/model changes and tool selections behave
  consistently across surfaces.

### Changed — WebUI polish
- **Broad component refresh** — WebUI layout, settings, side panels, dashboards,
  SDD/kanban views, message bubbles, welcome/setup screens, and activity bar
  styling were refreshed together with English/Turkish i18n updates.
- **Accent-color contract** — `packages/webui/src/lib/accent-colors.ts` now
  centralizes accent color resolution and is locked by unit tests.
- **Persisted tool toggles across surfaces** — tool enable/disable choices now
  round-trip through CLI-hosted WebUI introspection, standalone WebUI message
  handling, Desktop wiring, and the TUI tools picker.

### Fixed
- **Global mailbox read/write serialization** — mailbox reads now share the
  same lock discipline as writes and capture post-write file stats inside the
  lock, closing a race around concurrent mailbox access.
- **Telegram command rename** — the Telegram plugin's generic `status` slash
  command is now `telegram-health`, avoiding collisions with core status-like
  surfaces.
- **Tool package test resolution** — Vitest resolves the tools package from
  source in the relevant test paths, avoiding stale built-artifact assumptions.
- **Version line** — all workspace manifests, the HQ dashboard package, and
  `website/` are aligned to `0.283.0`, with release snapshots updated.

## [0.282.1] — 2026-07-06

### Added
- MCP server configs now support `passthroughEnv`, letting official stdio MCP
  presets forward only explicitly named parent environment variables (for
  example `GITHUB_TOKEN`, `BRAVE_SEARCH_API_KEY`, or provider-specific keys)
  while keeping the default child-process environment scrubbed.

### Fixed
- The configured max tool timeout is now passed to the tool executor in every
  CLI construction path, so long-running tools respect `maxToolTimeoutMs`
  consistently.
- MCP server config loaded at boot now merges with built-in presets before the
  registry starts, preserving newer preset defaults such as `passthroughEnv`
  for configs saved by older versions.
- WebUI subagent output cleanup now strips both canonical `<nextsteps>` blocks
  and legacy `<next_steps>` blocks, including persisted older output.
- The WebUI `Ctrl+M` quick model switcher now filters by model description in
  addition to provider id, model id, and display name.

## [0.282.0] — 2026-07-06

> The **fleet awareness, HQ control plane, Desktop, skills, and 36-plugin**
> release. Adds Brain-gated fleet supervision, peer visibility between agents,
> a cross-machine HQ command center with persisted telemetry and token-scoped
> control, skill-registry search/authoring improvements, first-class Desktop
> documentation, and the official plugin catalog expansion from 21 to 36.
> All workspace packages and the website are aligned to `0.282.0`.

### Added — Fleet supervision + peer awareness

- **Early-finisher awaits** — `await_tasks` gains `mode: "all" | "any"` (+
  `timeoutMs` for any-mode): the leader can handle each finisher as it lands
  instead of blocking on the slowest sibling. Backed by
  `Director.awaitTasksAny` / coordinator `awaitTasksAny`. The fire-and-forget
  report-back is no longer silenced for an entire awaited batch — only
  results actually returned in-band skip the mailbox notification, so slow
  siblings of an any-await reach the leader as `result` mails.
- **FleetSupervisor** (`/supervisor`) — a brain-gated shadow watcher over the
  Director fleet: detects pinned-task starvation, overloaded workers, deep
  backlogs, stuck agents, and failure streaks; clears every proposal through
  the tiered Brain (`/brain risk` ceiling) and then rebalances pending tasks
  onto idle workers ("workload reduced" steer to the loser), spawns helpers,
  steers stuck/failing workers, or notifies the leader. New rebalancing
  primitives `listPendingTasks` / `retargetPendingTask` (pending tasks only —
  running work is never pulled). Audit trail via new
  `fleet.supervisor.{signal,decision,action}` events and `/supervisor log`.
- **Peer awareness** — agents on the same project now see each other mid-run:
  a periodic `[FLEET PULSE]` digest folded into every agent's context, a
  read-only `fleet_status` tool (available to subagents), and `type:'status'`
  broadcast mails on subagent spawn/completion/budget pressure (rate-capped).
  Task start/stop now enriches the mailbox registry heartbeat with
  `currentTask`, so cross-process peers see live task info.
- **Config** — new top-level `fleet` key (`pulse`, `statusBroadcasts`,
  `supervisor`), deny-listed for repo-committed in-project config.

### Added — HQ Command Center control plane

- **Project-independent HQ server** (`wstack --hq` / `wstack hq`) now acts as
  the deliberate cross-machine command center for WrongStack. REPL, TUI,
  CLI-hosted WebUI, and standalone WebUI clients publish versioned telemetry
  over `/ws/client`; browsers subscribe to `hq.snapshot`, `hq.event`, and
  `hq.alert` frames over `/ws/browser`.
- **Telemetry bridges** forward session snapshots/transcripts, agent status,
  fleet snapshots, Brain decisions/interventions, worktree lifecycle events,
  tool start/complete events, and token/cost usage into HQ without coupling the
  dashboard to in-process objects.
- **Token-scoped control plane** adds browser → server → client command queues
  for `steer`, `abort`, `spawn`, `broadcast`, and gated `run-command`. Browser
  tokens need `control.enqueue`; clients must advertise `control.receive`; and
  `run-command` remains behind the client-side operator opt-in
  (`--hq-allow-exec`) and routes as a leader steer so the agent permission
  policy still applies.
- **Persistence + alerts** — HQ now survives restart with `events.jsonl`,
  `snapshot.json`, and `timeseries.jsonl`, exposes event/trend/alert APIs, and
  evaluates fleet-cost, stale-machine, high-concurrency, and failure-spike
  alert rules.

### Changed — Cross-surface coordination and session safety

- **Canonical project identity** — every surface now derives the project slug
  from the same `projectSlug()` helper and touches the shared
  `~/.wrongstack/projects.json` manifest, keeping REPL/TUI/WebUI/Desktop/HQ
  views on one coordination plane.
- **GlobalMailbox identity model** — agents register as session-unique
  `<base>@<session-tag>` identities while bare aliases (for example `leader`)
  fan out to all live matching agents. Mail send/ack share one lock so a
  concurrent append cannot erase read receipts.
- **Session registry safety** — live sessions from every surface are published
  through `SessionRegistry`, and session deletion now refuses to remove a run
  still referenced by `active.json` or held by another live process. Optional
  session names persist through CLI/WebUI rename flows and listings prefer the
  user label when present.

### Added — Skill system (registry search, authoring toolkit, private repos)

- **`/skill-search`** — new command that searches the skills.sh skill registry
  (the open agent-skills marketplace backed by mastra-ai/skills-api, 34k+
  skills across 2.8k+ repos). Results show name, author, install count, a
  0–100 security score (low scores flagged with ⚠), and the `/skill-install`
  ref. See `docs/slash/skill-search.md`.
- **Registry adapter layer** (`packages/core/src/skills/registry/`) — a pluggable
  `SkillRegistryAdapter` interface with two built-in adapters: `github-direct`
  (the original `user/repo` install path) and `skills.sh` (search + resolve).
  The installer resolves `<adapterId>:<registryId>` refs (e.g.
  `skills.sh:octo/repo@v1`) to a GitHub install target and records the
  originating registry in the manifest (`registryFrom`).
- **`/skill-gen` authoring toolkit** — `/skill-gen` is now a multi-tool:
  - `/skill-gen skeleton <name> --desc "..." --trigger a,b` — generate a valid
    SKILL.md scaffold (`packages/core/src/skills/skill-generator.ts`).
  - `/skill-gen from-prompt "<text>"` — turn a prompt into a skill draft.
  - `/skill-gen validate <name>` — kebab-case format + collision check.
  - `/skill-gen view <name>` (renamed from the misleading `edit`) and
    `/skill-gen edit <name>` (now actually opens `$EDITOR`/`$VISUAL`).
  The bare `/skill-gen` AI-guided wizard flow is preserved.
- **Private GitHub repo installs** — `GITHUB_TOKEN` / `GH_TOKEN` (or
  `WRONGSTACK_GITHUB_TOKEN`) is now read by the skill installer and sent as a
  bearer token, enabling private-repo installs and the much higher
  authenticated GitHub API rate limit. The 403/404 messages now point at the
  env var when no token is set.
- **`config.skills.registryUrl`** — point `/skill-search` at a self-hosted
  skills-api instance. Stripped from repo-committed in-project config (the
  parsed response flows into the prompt → SSRF/prompt-injection guard).

### Changed — Skill system (Cursor fix, centralized limits, AGENTS.md sync)

- **Cursor foreign-skill path fixed** — Cursor now uses the standard
  `~/.cursor/skills/` subdir (aligned with skills.sh / antfu-skills-cli /
  vercel-labs), not the WrongStack-only `~/.cursor/skills-cursor/`. The
  previous path meant real Cursor skills were never discovered.
- **Centralized skill limits** (`packages/core/src/skills/limits.ts`) — the
  per-skill body cap, resource cap, eager-mode budget, tarball/file size
  limits, compact-body budgets, and name length are now in one place
  (`SKILL_LIMITS`) consumed by the loader, system-prompt builder, `skill`
  tool, installer, and github-fetcher. Previously duplicated magic numbers
  (e.g. the 16k body cap was defined independently in two modules).
- **`resolveForeignToolIdsWithWarnings`** — surfaces unknown tool ids in
  `config.skills.foreignSources` (likely typos) instead of silently dropping
  them.
- **AGENTS.md bundle skill list synced** — now lists all 23 bundled skills
  (was 16); notably `output-standards`, which almost every other skill
  depends on for `<nextsteps>` formatting.

### Added — Desktop Surface

- **WrongStack Desktop is now covered as a first-class surface** — the root
  README documents the Electron shell alongside the plain REPL, Ink/React TUI,
  and standalone/embedded WebUI. Coverage includes `wstack desktop`,
  `wrongstack --desktop`,
  `wrongstack-desktop`, `wstack-desktop`, recent/registered project launch,
  multi-session project runtimes, WebUI embedding, native menu routing,
  terminal launcher commands, YOLO / next prediction / auto-compact toggles,
  token-required local runtimes, window/sidebar persistence, browser open,
  folder reveal, reload, and runtime log visibility.

### Added — 15 new plugins (21 → 36)

- **`loop-breaker`** — detects runaway tool-call loops (identical repeats and
  A-B-A-B oscillation), warns with additional context, then blocks when the loop
  persists.
- **`path-guard`** — blocks writes, edits, and destructive shell commands that
  touch protected paths such as `.env`, `.git`, lockfiles, and migrations.
- **`context-pins`** — adds `pin_add`, `pin_remove`, and `pin_list`; pinned
  facts persist under the project directory and survive compaction.
- **`checkpoint`** — captures pre-edit file snapshots and exposes
  `checkpoint_create`, `checkpoint_list`, and `checkpoint_restore` for manual
  rollback.
- **`error-lens`** — distills failed command output into compact error context
  and keeps `error_lens_history` for recent failures.
- **`dep-guard`** — supervises dependency installs with deny-list,
  typosquat/lookalike, and unpinned-version warnings.
- **`config-validator`** — validates JSON, JSONC, YAML, and TOML files after
  write/edit operations and reports syntax issues in the same turn.
- **`notify-hub`** — sends configured session/tool/budget notifications and
  ad-hoc `notify_send` messages to a webhook.
- **`changelog-writer`** — collects session work and writes
  Keep-a-Changelog entries through `changelog_add`, `changelog_preview`, and
  `changelog_write`.
- **`injection-shield`** — scans tool output for prompt-injection patterns and
  warns the model that the content is data, not instructions.
- **Deep provider-wrapper plugins** — `llm-cache`, `model-router`,
  `prompt-firewall`, `auto-escalate`, and `token-throttle` now demonstrate the
  full `AgentExtension` surface (`wrapProviderRunner` / `onError`). They load
  inert by default and require `config.extensions['<name>'].enabled = true`
  before changing provider-call semantics.

### Changed — Documentation

- **Root README now documents all four user-facing surfaces plus HQ** — plain
  REPL, Ink/React TUI, standalone/embedded WebUI, the Electron Desktop shell,
  and the cross-machine HQ command center.
- **README package and command maps updated** — `@wrongstack/desktop`,
  `@wrongstack/acp`, `@wrongstack/bench`, and `@wrongstack/webui-hq` are listed
  in the package table; `wrongstack webui`, `wrongstack desktop`, and
  `wrongstack hq` are listed as subcommands; `--webui`, `--desktop`, `--hq`,
  `--host`, `--port`, `--strict-port`, `--data-dir`, `--hq-allow-exec`,
  `--no-interactive`, `--open`, `--mouse`, `--eternal`, and `--skip-index` are
  included in the flag table; `/hq` and `/supervisor` are now covered in the
  slash-command table.
- **README HQ coverage added** — documents the cross-machine HQ surface,
  auto-discovery, token scopes, telemetry streams, persisted event/snapshot/
  timeseries storage, alerting, and guarded command routing.
- **README `/auth` coverage refreshed** — documents the TUI interactive auth
  panel, `/auth login` OAuth shortcut, and the REPL's non-blocking credential
  dashboard fallback.
- **README plugin section updated to the 36-plugin catalog** — replaces the
  stale 10-plugin table with the current catalog-backed list, documents the
  opt-in deep provider-wrapper plugins, and calls out retired plugin names
  (`web-search`, `json-path`) with their built-in tool replacements.
- **README observability count corrected** from 53 typed events to 97 typed
  events, matching the current kernel `EventMap`.
- **README bundled-skill count corrected** from 22 to 23 and now includes the
  `plugin-author` bundled skill.

## [0.278.0] — 2026-07-01

> The **21-plugin milestone** release. Eight new plugins ship alongside
> structural improvements: a shared `PluginAPI.mailbox` field, a
> `catalog.ts` single source of truth, an opt-in `autoFix` mode for
> `spec-linker`, a two-layer release gate, and a `release.yml` CI
> workflow. The H1 audit pattern now covers all 21 plugins end-to-end.

### Added — 8 new plugins (10 → 21)

- **`import-organizer`** (`PostToolUse` on `write|edit`) — runs
  `biome check --write --unsafe` after every save, re-sorting imports
  alphabetically, grouping by source, and removing unused entries.
  Falls back to `eslint --fix` if biome is missing.
- **`todo-listener`** (`PostToolUse` on `todo`) — broadcasts the new
  todo-list snapshot to the project mailbox on every todo tool call.
  Other agents in the same project (terminals, WebUIs, shadow agents)
  see what this one is working on in real time. Adds a new
  `api.mailbox` PluginAPI field.
- **`session-recap`** (`Stop` hook) — posts a one-page session summary
  to the mailbox when the agent loop ends. Aggregates tokens
  (per model), tool-call counts, commit count, and the last N events
  from the session transcript.
- **`spec-linker`** (`PostToolUse` on `write|edit`) — scans markdown
  files for unlinked plugin references and surfaces them via
  `additionalContext`. With `autoFix: true`, also registers a
  `PreToolUse` hook on `write` that wraps each unlinked reference
  in a markdown link via `modifiedInput.content` (case-preserving).
- **`branch-guard`** — detects uncommitted changes on protected
  branches and suggests a safe `git stash → checkout -b → stash pop`
  workflow in the block reason.
- **`lint-gate`** enhancements — `fixRules` config to limit which
  rules auto-fix applies to, plus `edit` support (snippet-level fix
  with explicit caveat about file-level rules).
- **`diff-summary`** — `includeContext` config controls the number of
  surrounding context lines via `git -U<N>`.
- **`format-on-save`** — PostToolUse hook that runs `biome format
  --write` on the file after every write or edit.

### Added — Infrastructure

- **`PluginAPI.mailbox`** — new optional field on the plugin API
  (mirrors the `api.modelsRegistry` pattern). Plugins that publish
  to other agents (`todo-listener`, `session-recap`) call
  `api.mailbox.send`. Minimal hosts (tests, the LSP server) skip the
  field and the affected plugins silently no-op.
- **`packages/plugins/src/catalog.ts`** — single source of truth
  for the 21 plugins' names and source paths. Each plugin is
  imported once at module load, its `name` field is read, and the
  result is exposed as `PLUGIN_CATALOG` (ReadonlyMap) and
  `PLUGIN_NAMES` (readonly string[]). Sanity checks at module load
  enforce kebab-case names and reject duplicates. `spec-linker`
  reads from this catalog instead of carrying its own
  hardcoded map.
- **`packages/plugins/tests/catalog.test.ts`** — 7 regression tests
  pinning the catalog: every plugin exported from `index.ts` must
  have an entry; entries must be kebab-case; retired plugin names
  (`web-search`, `json-path`) must never reappear.

### Added — Release pipeline

- **`prepublishOnly` + `test:guard`** — npm/pnpm-standard release
  guard that runs `vitest run` against the three highest-leverage
  test files (`catalog.test.ts`, `plugin-teardown.test.ts`,
  `smoke.test.ts`) in ≈2s. Fires automatically before `pnpm publish`,
  even when `pnpm release` is bypassed.
- **`.github/workflows/release.yml`** — CI workflow that runs both
  release layers (Layer 1 `pnpm release:check`, Layer 2
  `pnpm prepublishOnly`) on `v*` tag push and on `workflow_dispatch`
  with a `dry_run` toggle. Adds an explicit `NPM_TOKEN` secret
  contract.
- **`docs/release-process.md`** — documents the two-layer guard
  model, the command matrix, and the "how to add a new guard"
  workflow.
- **`docs/feature-matrix.md`** — new bird's-eye-view reference
  covering all 21 plugins across 6 categories (developer workflow,
  quality, safety, observability, cross-agent, utilities), with a
  hook-trigger table and a stacking recommendation.

### Changed

- **The H1 audit pattern is now complete** — all 21 plugins expose
  `teardown()` (idempotent re-init, resource release) and
  `health()` (counter report). `plugin-teardown.test.ts` is
  now part of the release guard.
- **`secret-scanner`** is a two-stage hook — PreToolUse blocks or
  redacts credentials in `bash`/`write`/`edit` input; PostToolUse
  warns on credentials leaking in tool output. Custom regex
  patterns are configurable via `customPatterns`.
- **`token-budget`** exposes a `model` config with wildcard support
  (`"gpt-4*"` matches every GPT-4 variant). The `Stop` hook blocks
  the agent loop if the budget is already exhausted; a
  PostToolUse hook injects one-shot `additionalContext` when the
  warn or stop threshold is crossed.
- **`commit-validator`** supports `bodyRequired` and `minBodyLength`
  for projects that require a non-trivial commit body.

### Fixed

- **`cli-main.ts` ordering** — `brainMailbox` is now created
  immediately before `setupPlugins` (slash registry, then mailbox,
  then plugins) so the new `api.mailbox` field is populated for
  every plugin loaded at boot. Previously the constructor was
  ~400 lines below `setupPlugins`, leaving the field undefined
  for all built-in plugins.
- **`import-organizer` linter detection** — lazy probe on first
  hook invocation (not at setup time) so the plugin doesn't
  shell out to `npx biome --version` during `setup()`.
- **`secret-scanner` regex `lastIndex` reset** — the global regex
  now resets before each scan, so consecutive `findMatches` calls
  on the same input don't skip matches.
- **`branch-guard` body regex** — the `re.lastIndex` reset
  similarly prevents skipped matches on the dirty-workflow
  suggestion.

### Removed

- Two retired plugins (`web-search`, `json-path`) were already
  removed in `0.277.x`; the catalog test now enforces that
  neither name can reappear without an explicit catalog update.

### Plugin count

```
0.277.x: 10 plugins
0.278.0: 21 plugins  (+11 from 0.277.x, +8 in this release)
```

## [0.277.2] — 2026-06-30

_No notable changes — internal version bump._

## [0.277.1] — 2026-06-30

> The **catastrophic-only YOLO gate** patch. Recalibrates the 0.277.0
> destructive-confirmation gate so YOLO only stops for effectively irreversible
> machine-, disk-, filesystem-, or home-wide destruction. Recoverable dev work
> now stays frictionless again, including navigation/reads outside the project,
> `git reset --hard`, `git clean -xdf`, database deletes, `chmod -R`,
> pipe-to-shell installers, and deleting ordinary sibling/cache directories.
> Windows shell interpreters are also in the default `exec` allowlist so
> `exec cmd /c dir` and PowerShell cmdlets work without custom config.

### Changed

- **YOLO risk detection is catastrophic-only.** `isClearlyDestructiveBashCommand`
  now focuses on whole-root, whole-drive, home-directory, system-directory,
  disk/partition, raw block-device, and fork-bomb cases. The project-root
  parameter remains for API stability, but shell-command path escapes, reads,
  navigation, ordinary single-file writes, git/database resets, and most
  destructive-but-recoverable workflows no longer trigger the YOLO destructive
  prompt.

- **Windows shell interpreters are allowlisted for `exec`.** Added `cmd`,
  `cmd.exe`, `powershell`, `powershell.exe`, `pwsh`, and `pwsh.exe` to the
  default restricted-exec allowlist. Destructive `cmd /c ...` and PowerShell
  command lines still pass through the permission policy's reconstructed command
  string and the catastrophic classifier.

### Fixed

- **Windows read/listing false positives under YOLO.** Commands such as
  `cd /d "<project>" && dir ... | findstr ...`, `dir C:\Windows`,
  `Get-Content ..\config.json`, and `type C:\logs\app.log` are now treated as
  read/navigation work and do not prompt.

### Changed — versions

- **All workspace packages aligned to 0.277.1**: `wrongstack`,
  `@wrongstack/cli`, `@wrongstack/core`, `@wrongstack/mcp`,
  `@wrongstack/plug-lsp`, `@wrongstack/plugins`, `@wrongstack/providers`,
  `@wrongstack/runtime`, `@wrongstack/skills`, `@wrongstack/telegram`,
  `@wrongstack/tools`, `@wrongstack/tui`, `@wrongstack/webui`,
  `@wrongstack/acp`, `@wrongstack/bench`, and the umbrella `apps/wrongstack`.
  The marketing site (`website/`) is aligned in lockstep.

## [0.277.0] — 2026-06-30

> The **permission hardening, Windows command-shim, and tool-output polish**
> release. YOLO now auto-approves normal trusted work while still forcing an
> explicit per-call approval for clearly destructive operations; the legacy
> destructive override flags remain accepted for compatibility but no longer
> bypass that gate. Windows `.cmd` / `.bat` execution now goes through a vetted
> `cmd.exe` shim across tools and ACP launch paths, fixing path-with-spaces
> failures without reopening shell-injection holes. Search/fetch are smoother
> as auto-permission read-only network tools, search parsing/ranking is more
> resilient, and the TUI now renders command danger levels plus consistent
> bash/exec output previews. Also includes project-root containment fixes for
> design/json file paths, dependency updates through `@types/node@26`, and
> lockstep `0.277.0` package alignment.

### Added

- **TUI exec danger chips.** Tool history now surfaces `exec` danger metadata as
  compact `DESTRUCTIVE` / `CAUTION` banners with the first matching reason, plus
  stacked secondary reasons when present.

- **Windows command-shim helpers.** New vetted `buildWin32CmdShimInvocation()`
  helpers in the tools, CLI, and ACP paths launch `.cmd` / `.bat` wrappers
  through `cmd.exe /d /c call ...` with metacharacter rejection and quoted
  arguments.

- **Broader default `exec` allowlist.** The restricted `exec` tool now covers a
  much wider set of common developer, Windows, cloud, archive, database, VCS,
  security, document-conversion, and inspection commands while retaining
  argument-level destructive-pattern checks.

- **Brain decision-log module.** The rolling `/brain status` log subscription
  moved out of `cli-main.ts` into `packages/cli/src/boot/brain-decision-log.ts`
  with dedicated tests and teardown handling.

### Changed

- **YOLO destructive confirmation is always on.** `--yolo` and `/yolo` now mean
  "auto-approve normal project work"; clearly destructive shell/exec/write
  operations still prompt. `--confirm-destructive`, `--yolo-destructive`, and
  `--force-all-yolo` are deprecated compatibility flags and do not bypass the
  destructive gate. Session soft-allows are one-shot, and the destructive gate
  runs before trust-file allow rules.

- **Search and fetch are auto-permission read-only network tools.** Both still
  carry the `net.outbound` capability and SSRF/private-network safeguards, but
  ordinary web lookup no longer needs a confirmation prompt.

- **Search result handling is more resilient.** DuckDuckGo and Bing parsers now
  handle modern markup variants, unwrap redirect URLs, decode HTML entities,
  rank by query overlap after URL de-duping, and fall back to DuckDuckGo when
  Google/Bing return no relevant static results. Cache entries preserve the
  effective result source.

- **Command output previews are standardized.** TUI formatting now handles both
  `stdout`/`stderr` and `output`/`error` result shapes, accepts `timed_out` and
  `timedOut`, and uses one compact line-count/preview shape for `bash`,
  `shell`, and `exec`.

- **Dependency and runtime metadata refreshed.** `@types/node` moved from
  `25.9.4` to `26.0.1` across all 14 workspaces, `undici-types` to `^8.5.0`,
  Biome to `^2.5.1`, and Playwright to `^1.61.1`; the root engine floor is now
  `node >=22.19.0`. TypeScript 6.0.3 remains compatible, and the root
  `typecheck` script now runs the recursive workspace typecheck without
  `--parallel`. Verified with `pnpm typecheck` across all 16 workspaces and
  `pnpm audit --audit-level=high` (no vulnerabilities).

### Fixed

- **CWE-22 path containment fixes.** `design { action: "materialize" }` now
  rejects caller-supplied output paths that would escape the project root, and
  the `json` tool resolves file reads through the project containment helper.

- **Windows `.cmd` / `.bat` spawning with paths that contain spaces.** `exec`,
  `outdated`, spawn-background helpers, CLI utilities, and ACP probe/transport
  paths now use the same shim instead of Node's `shell: true` argument path.

- **TUI diff background compatibility.** DiffBlock background washes now render
  only when the terminal reports background-color support, avoiding washed-out
  blocks on limited terminals.

- **Autonomy next-step drift while todos are open.** REPL/TUI suggestion parsing
  suppresses `<nextsteps>` while live todos are still pending or in progress,
  preventing `/next` and auto-suggest flows from pivoting away mid-task.

- **Shadow-agent and fleet shutdown races.** Shadow passes now bail after
  `workComplete()`, expected internal spawn-budget races are swallowed, and
  fleet/director manifest writes are flushed and serialized on shutdown.

- **Plugin/tool packaging edge cases.** `@wrongstack/tools/codebase-index` is
  now exported for plugin consumers, and a new built-in executor smoke test
  asserts permission/mutation invariants across registered tools.

### Changed — versions

- **All workspace packages aligned to 0.277.0**: `wrongstack`,
  `@wrongstack/cli`, `@wrongstack/core`, `@wrongstack/mcp`,
  `@wrongstack/plug-lsp`, `@wrongstack/plugins`, `@wrongstack/providers`,
  `@wrongstack/runtime`, `@wrongstack/skills`, `@wrongstack/telegram`,
  `@wrongstack/tools`, `@wrongstack/tui`, `@wrongstack/webui`,
  `@wrongstack/acp`, `@wrongstack/bench`, and the umbrella `apps/wrongstack`.
  The marketing site (`website/`) is aligned in lockstep. The interim
  `0.276.3` and `0.276.4` bumps are folded into this documented release.

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
  - **Leader only** — only the top-level session agent (leader) emits `<nextsteps>`.
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

# AGENTS.md — WrongStack Developer Reference

> **DO NOT DELETE THIS FILE.** Loaded into WrongStack's system prompt as persistent project context. Merge additions rather than replacing.

## Project brief

WrongStack is a terminal AI coding agent in TypeScript: an LLM that reads code, edits files, runs shell commands, and reasons through bugs. Per-call approval and project-root containment form the non-YOLO policy: tool calls that mutate or touch the network prompt the user unless YOLO is on; filesystem tools refuse to read or write outside the active project root unless `features.allowOutsideProjectRoot` is set; explicit deny rules in the trust file and `permission: 'deny'` tools still win over YOLO. Interactive first launch currently selects and persists YOLO on; use `--no-yolo` or `/yolo off` to restore approval prompts. Monorepo: 29 packages + 2 apps + website. Runtime surfaces: CLI (REPL), optional TUI (React/Ink), WebUI (Vite/React), SimpleUI (lightweight browser chat), Desktop (Electron), and HQ. Published entry: `apps/wrongstack/src/index.js` → `@wrongstack/cli` → `packages/cli/src/index.ts` / `cli-main.ts`.

## Package map

```
core/              — Kernel: Container, Pipeline, EventBus, RunController, Context
providers/         — Anthropic, OpenAI, Google, OpenAI-compatible adapters
tools/             — Builtin tools: read, write, bash, exec, git, grep, glob, ...
mcp/               — MCP client + registry + stdio/SSE/streamable-http transports
plug-lsp/          — LSP bridge (/lsp:start, /lsp:diag, /lsp:goto)
acp/               — Agent Client Protocol: client + agent (Zed, JetBrains, VSCode)
cli/               — REPL, subcommands, slash commands, plugin management
tui/               — React/Ink terminal UI (lazy-loaded behind --tui)
runtime/           — Default runtime wiring: makeDefaultRuntime()
kanban/            — Kanban/task-board primitives and queue state helpers
sdd/               — Spec-Driven Development stores, trackers, and workflow helpers
security-scanner/  — Security scanning package surface
sage/      — Project-local structured memory, graph, verification, hygiene, and retrieval
telegram/          — Telegram bridge plugin
webui/             — Vite+React web UI frontend and client state (docs/webui.md)
simpleui/          — Lightweight browser chat (conversation, tool progress, agent tabs)
webui-server/      — Shared Node WebUI backend that powers `wstack --webui`
webui-hq/          — React HQ Command Center dashboard
plugins/           — 64-entry first-party plugin catalog and subpath exports
bench/             — Benchmark harness (Aider polyglot + SWE-bench); docs/subcommands/bench.md
apps/wrongstack/   — bin entry (wrongstack / wstack)
apps/desktop/      — Electron desktop shell
```

**Dependency direction:** `@wrongstack/kanban` has no WrongStack dependency and sits below `core`; `core` declares it as its sole `@wrongstack/*` package dependency. `core` must not depend on `cli`, `tui`, `webui`, `simpleui`, `webui-server`, `webui-hq`, apps, or other packages that consume core. Product surfaces compose the lower packages; never reverse a surface dependency into the kernel.

## Kernel (`packages/core/src/kernel/`)

**Container** — Typed DI keyed by `Token<T>` (branded symbol, not string). Bindings: `factory`/`value`/`decorator`; lazy + memoized. All well-known tokens (Logger, SessionStore, PermissionPolicy, Compactor, BrainArbiter, HookRegistry, …) live in `tokens.ts`. Plugins rebind tokens before `Agent.run`. No service locator.

**Pipeline\<T\>** — Linear middleware chain. Six pipelines per agent step: `userInput` (every user turn), `request` (before provider call), `response` (after), `assistantOutput` (per text block), `toolCall` (after every tool call), `contextWindow` (before send if context may be too large). Middleware: `{ name, owner, handler: async (req, next) => ... }`; a middleware can `replace` a step — last `replace` wins (position-aware).

**EventBus** — Typed pub/sub for session, run, iteration, provider, tool, context, compaction, MCP, subagent, worktree, fleet, brain, storage, and error lifecycles. `EventMap` in `kernel/events.ts` is the source of truth; do not maintain a hand-count.

**RunController** — One per `Agent.run`. Owns `AbortController`, chains parent signal, drains abort hooks LIFO on dispose.

## Context and agent lifecycle

`Context` is the live run object (messages, todos, system prompt, session writer, tools, provider, signal, cwd, model, meta) and implements `RunEnv`. `ctx.state: ConversationState` is an observable wrapper — `appendMessage(m)` / `replaceMessages(ms)` fire `onChange`; direct mutation works but bypasses subscribers.

Lifecycle (`packages/core/src/core/agent.ts`): `Agent.run` → `normalizeAndEmitUserInput` (userInput pipeline + appendMessage) → per iteration: checkIterationLimit → build request (request pipeline) → `runProviderWithRetry` (text_delta / response pipeline) → text only? done : `ToolExecutor.executeBatch` (permission check → tool.execute → toolCall pipeline → append) → `compactContextIfNeeded` (contextWindow pipeline) → `RunResult`.

## Provider failure taxonomy & retry/fallback

Every provider HTTP failure is classified ONCE, at error construction, into `ProviderError.kind` (`rate_limit | overloaded | server | timeout | network | stream_hang | auth | context_overflow | content_filter | invalid_request | unknown`) by `classifyProviderError()` in `core/src/types/provider.ts` — the single home for status/type/message heuristics. **Consumers branch on `err.kind`, never re-derive from status/regex.** `isRetryableKind()` / `kindToCode()` live beside it. Retry-After headers are parsed by `retryAfterMsFromHeaders` (providers/error-parse.ts) into `body.retryAfterMs` via `translateError(status, text, headers?)`; wire-format backfills the hint even when a custom `normalizeError` ignores headers.

Three consumer layers, fixed precedence: (1) **in-place retries** — `runProviderWithRetry` + `DefaultRetryPolicy`: attempts per kind (rate_limit/stream_hang 5, overloaded/server 3, timeout/network 2, else 0), delay = Retry-After hint else exponential+jitter; (2) **cross-provider fallback** — `fallback-model`'s `wrapProviderRunner` hops the chain ONLY for capacity/transport kinds (request-shaped kinds never hop); each hop gets its own layer-1 cycle; (3) **recovery strategies** — `errorHandler.recover`, one strategy per kind: `context_overflow` → compact+retry, `rate_limit` → last-resort backoff, `overloaded/server/stream_hang` → cheaper-model downgrade, `content_filter` → closest-cost sibling reroute; a `retry` decision re-enters layers 1–2, bounded by `recoveryRetries ≤ 2`.

## Tools

`Tool<I, O>`: `name`, `description`, `inputSchema` (JSONSchema), `permission: 'auto'|'confirm'|'deny'`, `mutating`, `execute(input, ctx, opts)`, optional `executeStream` (preferred — yields `log`/`partial_output`/`metric`/`file_changed`/`warning` then `{type:'final', output}`; executor publishes each as `tool.progress`), optional `cleanup`. Execution strategies: `parallel`, `sequential`, `smart` (default).

**Cancellation:** every tool MUST observe `opts.signal` (run abort + per-tool timeout via `AbortSignal.any`). Long walks poll `signal.aborted` (grep, glob); subprocess tools pass the signal to spawn / tree-kill (bash, exec, git); file mutators call `signal.throwIfAborted()` right before `atomicWrite` (write, edit); MCP proxy tools forward it into `client.callTool` (drops the request AND sends `notifications/cancelled`).

**Malformed-argument repair:** adapters parse streamed tool args via `parseToolInput` (`providers/src/_tool-input.ts`) — ladder: direct parse → code-fence strip → JSON5-style sanitize → truncation completion → composed → double-wrap salvage → `{ __raw }` sentinel. Executor validates against `inputSchema` with one lossless coercion pass (`coerceAgainstSchema`) before rejecting; unrecoverable input → `is_error` tool_result naming exact fields.

**Loop detection** (`tools.loopDetection`): (1) consecutive effectively-identical iterations; (2) sliding window of per-call `(name + canonicalized args)` hashes catching interleaved repeats. Default `steer-then-cut`: steer note at 3, cut at 5 (`status: 'max_iterations'`); modes `cut`, `off`; emits `tool.loop_detected`.

## Lifecycle hooks

User/plugin hooks that **steer** (EventBus can't block). Core in `core/src/hooks/`; types `types/hooks.ts`; token `TOKENS.HookRegistry`. Events: `PreToolUse`/`PostToolUse` (ToolExecutor), `UserPromptSubmit` (userInput middleware), `SessionStart`/`Stop` (AgentExtension). `PreToolUse` outcomes: `allow`, `deny {reason}`, `mutate {input}`; mutate-stage hooks compose before validate-stage hooks inspect (validators can't rewrite); `allow`/`mutate` never bypass the permission policy, incl. YOLO. Deadline-bound, cancellable, per-hook `failurePolicy: open|closed`. Transports: command (`config.hooks`, JSON over stdin, exit 2 = deny), HTTP, in-process (`api.registerHook`). `--no-hooks` keeps `policy: true` enforcement hooks. See `docs/hooks.md`.

## Fallback model

`config.fallbackModels` (`--fallback-model a,b,c`) — ordered chain tried when primary is overloaded after its own retries. An `AgentExtension` (`core/src/core/fallback-model.ts`) wrapping the provider runner: walks the chain within one provider call (doesn't burn `recoveryRetries`); cross-provider targets supported. After success the leader stays on the fallback during cooldown, then probes half-open. Emits `provider.fallback`.

## Multi-agent

`Agent.run()` rejects a second concurrent call on the same instance with `AGENT_RUN_FAILED`; mutable `Context` and run state are not a shareable concurrency boundary. `DefaultMultiAgentCoordinator`: task queue with `maxConcurrent` (default 4; `--max-concurrent` / `WRONGSTACK_MAX_CONCURRENT` / `/fleet concurrency`); per-subagent `SubagentBudget` (iterations/tool-calls/tokens/cost/timeout); `AgentBridge` for parent↔subagent messaging; subagent signal recycled between tasks.

Subagent live lifecycle is host-configured by `config.fleet.lifecycle`: CLI/WebUI hosts default to `retireOnTaskComplete: true` and `idleTimeoutMs: 30000`. A final task result retires the worker on the next event-loop turn unless queued work already reused it; spawned/between-task workers are removed after the idle window. Removal must release Director/coordinator resources and emit `subagent.removed` so SessionRegistry, TUI, WebUI, and AgentMonitor delete the live entry. This lifecycle timeout is separate from the in-task `SubagentBudget.idleTimeoutMs` activity watchdog.

Budgets self-extend via `budget.threshold_reached` → onThreshold → `extend`. On overrun: (1) no handler / `'sync'` mode / no EventBus → synchronous `BudgetExceededError`; (2) bus + listener → `BudgetThresholdSignal`, runner awaits the negotiated decision (live production path — the coordinator always registers a listener); (3) bus but no listener → `onThreshold` runs synchronously: a **sync** policy handler is honored in place, an **async** one is a hard stop. Each exceeded kind negotiates independently, one event per kind.

Failure results preserve progress: `TaskResult.partial` carries the latest `SubagentPartialResult` (last 4K chars, via `reportProgress`); the delegate tool consumes it first, falling back to JSONL transcript recovery. Structured success results: every CLI fleet subagent gets the task-local `submit_result` tool (`{summary, findings, files_examined, confidence, suggested_next_steps}`, capped 8K) → `TaskResult.report`; roll-up/delegate/mailbox prefer it; `TaskResult.result` kept for legacy runners.

Model routing via `config.modelMatrix`: exact role → role phase → `*` → leader model; entries can set `provider`/`model`, `fallbackProfile`, `modelRuntime` overrides (runtime-only entries valid). `/setmodel` and WebUI Settings → Model Routing persist the same shape.

Recursion: hard depth ceiling 2 (`HARD_MAX_SPAWN_DEPTH`, config may narrow, never widen); CLI default 64 lifetime spawns (`fleet.budget.maxSpawns`, overridable via `--max-spawns` / `WRONGSTACK_MAX_SPAWNS`); `Director.spawn` overwrites caller lineage with authoritative `spawnLineage`; fleet-wide `fleet.budget.maxTokens`/`maxCostUsd` refuse new spawns at ceiling (in-flight tasks undisturbed). Live used/remaining spawns and winning source labels surface on `/fleet status` Budget block (also WebUI + HQ). See `docs/director-architecture.md` and `docs/slash/fleet.md`.

Roster reachability: `FLEET_ROSTER` is 77 roles (75-role phase catalog + `generic` + `shadow-agent`). The leader's menu (`rosterSummaryFromConfigs`) renders `dispatch.summary` — the catalog's curated `capability.summary`, copied onto each config by `withDispatchMetadata` without mutating the definition — not the role prompt's first line, which is `You are the X agent. Your job is…` boilerplate for every role and truncates before the distinguishing half. `spawn_subagent` dispatches only when `role` is absent, so the schema leads with `description`; `Director.dispatchClassifier` is wired from `MultiAgentHost` (model-matrix slot `dispatcher`, returns `null` on any failure) so an ambiguous description reaches stage 2 instead of falling to `executor`. Role toolsets come from composable `TOOLS` presets in `agents/types.ts` (49 distinct tools across the roster; `generic`/`shadow-agent` declare none and get everything visible); `selectSubagentTools` **throws** on a tool the runtime has not registered, and every preset carries `mailbox` so a blocked subagent can escalate rather than only fail. Guards: `roster-discoverability.test.ts`. See `docs/director-architecture.md`.

### Fleet supervision + peer awareness

**Early finishers** — `Director.awaitTasksAny(ids, {timeoutMs?})` resolves on FIRST completion; leader tool `await_tasks` takes `mode: 'all'|'any'`. **Consumed-in-band rule** (`director.ts`): a result returned in-band (batch waiter or winning any-await) sends no report-back mail; every other completion reaches the leader as mailbox `result`. **Rebalancing** — `listPendingTasks()` / `retargetPendingTask(taskId, subagentId|undefined)`; only still-PENDING tasks move (task id preserved); running tasks can only be steered/terminated.

**FleetSupervisor** (`core/coordination/fleet-supervisor.ts`) — brain-gated shadow watcher over the Director fleet (SDD has its own `SddSupervisor`). Rule-first signals (starvation, overloaded worker, deep backlog → spawn helper, stuck agent, failure streak, idle-with-work); every proposal goes through `TOKENS.BrainArbiter` (`fallback:'ask_human'`). Actions: retarget+steer+notify, spawn helper, steer, notify, terminate (opt-in); rate-limited per (signal,subject). Never calls budget extend/deny, never preempts running tasks, never flips autonomy, dormant after `work_complete`. Wired in `MultiAgentHost.buildDirector`; `/supervisor`; config `config.fleet.supervisor`. Helper spawning routes through `dispatchAgent` + `FLEET_ROSTER`. Any child FleetBus event counts as liveness (long provider call ≠ stuck).

**Peer awareness** — (1) fleet-pulse digest: `[FLEET PULSE]` peer block folded every N iterations (`core/core/fleet-pulse.ts` + `attachFleetPulse`; deduped, char-capped, 30s throttle); (2) `fleet_status` tool — read-only peer snapshot from the mailbox registry (`coordination.fleet.read`); (3) status broadcasts — `cli/fleet/status-broadcast.ts` turns spawn/completion/budget-pressure into `type:'status'` mails (coalesced + rate-capped). Config: `config.fleet.pulse` / `.statusBroadcasts`; the whole `fleet` key is **deny-listed for in-project config**.

## The Brain (decision layer)

One Brain per session at `TOKENS.BrainArbiter`, between agents and human. All autonomous consumers (Director, Goal `phase-orchestrator.ts`, Eternal engine `eternal-autonomy.ts` / `--eternal`) route blocking decisions through it.

**Three tiers** (wired in `cli-main.ts`): 1. `DefaultBrainArbiter` — deterministic policy. 2. `createTieredBrainArbiter` + `createAutonomyBrain` (`core/execution/autonomy-brain.ts`) — LLM engine gated by a live autonomy ceiling (`/brain risk off|low|medium|high|all`, default `medium`, read per decision). 3. `HumanEscalatingBrainArbiter` + `BrainDecisionQueue` — interactive prompt (TUI `BrainDecisionPrompt`). `ObservableBrainArbiter` emits `brain.decision_*` around the chain.

**Self-activation:** `BrainMonitor` (`core/coordination/brain-monitor.ts`) watches for tool-failure streaks (3× same tool) and error storms (4 in 60s), consults the Brain, and on steer sends a high-priority `steer` mail `brain@<tag>` → `leader@<tag>`; emits `brain.intervention`; 120s per-signal cooldown. `/brain` shows status + last 20 decisions.

**Surfaces:** TUI renders decisions as BRAIN entries + ask-human overlay, interventions as ⚡ (`use-brain-events.ts`); both WebUI servers broadcast `brain.*` as `{type:'brain.event'}` WS messages; the standalone WebUI wires its own Brain (policy → LLM, no human tier) + BrainMonitor and serves `/brain` over WS.

**Option decision contract:** an LLM Brain decision with options must return exact JSON `{ "optionId": "<exact-id>", "rationale": "..." }` (legacy leading `[exact-id]` accepted). Free-text substring matching is forbidden — "do not spawn" must never select `spawn`. No exact valid id → denied, falls through the tier chain; FleetSupervisor likewise refuses answers without one.

## Cross-surface coordination

All surfaces on one project share `~/.wrongstack/projects/<slug>/`:

- **One canonical slug** via `projectSlug()` (`core/utils/wstack-paths.ts`); `resolveProjectDir` (mailbox paths) and WebUI's `generateProjectSlug` DELEGATE to it — never reintroduce an inline copy (a divergent copy once split agents into two mailboxes).
- **projects.json** auto-touched on every boot via file-locked `touchProjectInManifest()` (`cli/slash-commands/project-utils.ts`).
- **Project mailbox** (`_mailbox.sqlite`, owned by one detached server per project and reached only over IPC — see `mailbox-ipc-boundary.test.ts`): agents register under session-unique `<base>@<session-tag>` (`attachMailboxChecker` → `ctx.meta['globalAgentId']`), 30s heartbeats (stale 60s). Bare base id (`leader`) is an alias — readers query unique id + alias + `*`, dedupe by message id; "to leader" fans out to every live leader, "to leader@a1b2c3d4" is exact. Send/ack are transactions inside the single owner, so there is no cross-process file lock to lose. Presence state is best-effort and has known race windows; it is coordination metadata, not an authorization boundary.
- **SessionRegistry** (cross-process): CLI + standalone WebUI register sessions and run `AgentStatusTracker`; `/sessions status` lists every surface.
- Agents read mail each iteration (`mailbox-loop` folds fresh mail into one provider request, then removes the raw block after evaluation); only the assistant/tool/task consequence or a concise durable conclusion remains. Agents write via `mail_send`/`mail_inbox` or the `mailbox` power-tool; fleet subagents get distinct identities via Context `agentId`/`agentName` (host.ts). Humans can send from `/mailbox`, the main WebUI Mailbox composer, or HQ. `audience=leaders` is enforced in agent polling/inbox/query paths and is visibly labeled in CLI, TUI, WebUI, Office, and HQ views; Chimera sends are forced to `to=leader` + `audience=leaders`.

## Collab Debug Session

`CollabSession` (`/collab <paths>` or `collab_debug` tool): three-agent parallel pipeline `bug-hunter` → `refactor-planner` → `critic`. Agents emit structured events via the `fleet_emit` tool → `FleetBus`; downstream agents consume in real time (`bug.found` per-finding no batching, `refactor.plan` per bug, `critic.evaluation` → Director final report). Known payloads schema-validated and role-bound; attribution from executing `Context.agentId` + `subagentTaskId`, never model-supplied; unknown event types allowed for plugins. Code: `core/src/coordination/collab-debug.ts`, `fleet-bus.ts`; TUI `fleet-monitor.tsx` (Ctrl+F), `fleet-panel.tsx`.

## HQ Command Center (port 3499)

`wstack --hq`: project-independent, **the only deliberately cross-machine** server (everything else is loopback-only). Aggregates telemetry from every connected surface and can steer them. Full docs: `docs/subcommands/hq.md` + `docs/plans/hq-command-center-2026-07.md`.

Hub-and-spoke, two WS channels: `/ws/client` — surfaces publish versioned `HqEventEnvelope`s (`HQ_PROTOCOL_VERSION = 1`) via an `HqPublisher` + EventBus bridges (session/agent/fleet/brain/worktree/tool[redacted]/cost; wiring in `cli-main.ts` ~L1370, `webui/src/server/pre-context-services.ts`, `tui/src/run-tui.ts`); `/ws/browser` — dashboard subscribes to `hq.snapshot` (debounced 250ms) + `hq.event` + `hq.alert`. Persists `events.jsonl`/`snapshot.json`/`timeseries.jsonl` under `<dataDir>`; HTTP `/api/events`, `/api/trends/cost`, `/api/alerts`. Control plane: browser `POST /api/command` → per-client queue → `client.command_poll`/`hq.command_batch`/`client.command_ack`; token scopes via `HqToken.capabilities`; commands `steer`/`abort`/`spawn`/`broadcast`/`run-command` (RCE-gated: `--hq-allow-exec` + `control.execute`; even then routed as a steer — the agent's own permission policy applies). `HqAlertEngine` evaluates the snapshot every 15s; only state transitions emit `hq.alert`. Separate browser/client token sets in `<dataDir>/auth.json`. Code: `core/src/hq/`; `cli/src/hq-server.ts`, `hq-dashboard-html.ts` (→ React `packages/webui-hq/`, Phase 5), `hq-command-controller.ts`, `hq-publisher.ts`, `boot/short-circuit-hq.ts`.

TUI fleet surfaces: `Ctrl+F` fleet monitor · `Ctrl+G` agents monitor · `/fleet status|dispatch|log|usage|spawn|stream` (`/fleet status` includes concurrency + lifetime spawn budget).

## MCP integration

**Client:** `MCPClient` speaks JSON-RPC 2.0 over `stdio`/`sse`/`streamable-http`. `MCPRegistry`: exponential backoff + jitter on reconnect (cap 5 cycles → `failed`). Tools prefixed `mcp__<server>__<tool>`. Manage via `/mcp`, `wstack mcp`, or WebUI Settings → MCP — all persist to `mcpServers` and drive the same registry.

**Lazy connect** (per-server `MCPServerConfig.lazy`): no spawn at boot; tools registered from an on-disk manifest cache (`~/.wrongstack/cache/mcp-tools/<server>.json`, invalidated by `configHash`) via resolver-backed wrappers (`wrapMCPTool` accepts a client or client factory). Spawns on first tool call through `MCPRegistry.ensureConnected` (single-flight), `'dormant'` until then; idle-auto-sleeps after `idleTimeoutMs` (default 5 min) keeping wrappers registered.

**Management core:** `packages/mcp/src/manage.ts` — single surface-agnostic core (add/update/remove/enable/disable/restart/discover/list) returning structured results; REPL renders via `mcp-utils.ts`, both WebUI servers translate to WS via `mcp-handlers.ts` and own a live `MCPRegistry`.

**Server:** `wstack mcp serve` (`packages/mcp/src/server.ts` + `cli/src/mcp-serve.ts`) exposes the builtin tool registry over stdio. Default read-only; `--yolo` exposes write/exec, `--tools a,b,c` whitelists. See `docs/mcp-server.md`.

## Compactors

`config.context.strategy` selects via `createStrategyCompactor` (`execution/strategy-compactor.ts`); `TOKENS.Compactor` binds to it in both CLI and WebUI: `hybrid` *(default)* — lossless rule-based (elides oversized old tool results, collapses ancient turns into one digest preserving all text; raw tool I/O stays in the session log); `intelligent` — LLM summarization, falls back to the lossless digest; `selective` — LLM keep/collapse selection + summarization. LLM strategies resolve `provider` from `ctx` at `compact()`-time and degrade to lossless hybrid without one. Shared primitives (elision with `tool_use`/`tool_result` pair preservation, digest, safe-cut boundary) in `execution/compaction-core.ts`; canonical estimator `utils/token-estimate.ts:estimateMessageTokens` (chars/3.5, calibrated via `recordActualUsage`). `AutoCompactionMiddleware` wraps the `contextWindow` pipeline (fires after every iteration); `repairToolUseAdjacency()` removes orphan blocks after context surgery. Context modes: `balanced` (default), `frugal`, `deep`, `archival`.

## SAGE memory invariants

`SqliteSageStore` is the sole `TOKENS.MemoryStore` on CLI/TUI/Desktop/standalone WebUI. Canonical revisions live in project-local `.wrongstack/memories/sage.db`, with WAL-backed concurrency, indexed reads, and FTS5 search. Existing JSONL memories, review candidates, graph edges, and audit records migrate automatically on first open. The legacy files remain as a backup, but JSONL is no longer a selectable or writable runtime backend. Node's built-in `node:sqlite` support (Node >= 22.5) is required.

Automatic memory injection is host-parity behavior: CLI and standalone WebUI install tool-call middleware by default; ordinary request/turn injection is opt-in (`Sage.inject.turnContext: true`). The deterministic Memory Injector folds live todo/Kanban state into the concrete tool query, expands direct seeds through shared file/symbol/package/command/tag metadata and the graph, prioritizes long-lived structural kinds, diversifies the bounded result, and scales its 8-hint/2800-char default against current context pressure. Tool paths resolve from the live working directory before project-relative anchor lookup; write/edit/replace/patch targets re-verify affected anchors (unless `Sage.hygiene.autoOnFileChange` is false). Only active memory is automatic guidance; stale memory may be surfaced as a warning after mutation verification, while deleted tombstones are never placed in model context. Injection is relevance-gated, size-capped, session-cooldown-aware, fail-open, and suppresses facts already present in the system/tool result. Graph structure connects memory → symbol/file/directory/package/command, symbol → file, file → ancestor directories, and memory → session/tool/source nodes. Keep `core` independent of `sage`.

## Plugins

Declare `capabilities: { tools, providers, slashCommands, mcp, pipelines, llm }`, receive a scoped `api`; `llm: true` means the plugin may call host-routed `api.llm` but must retain a deterministic fallback; `setup(api)` registers, `teardown()` runs on SIGINT and natural exit. See `docs/plugin-author-guide.md`.

## Session storage

Sessions: `~/.wrongstack/projects/<sha256(absProjectRoot).slice(0,12)>/sessions/<id>.jsonl`, one `SessionEvent` per line (`core/src/types/session.ts`; two-tier audit via `session.auditLevel`). Always-written Core Reconstruct Set: `user_input`, `llm_response`, `tool_result`, `checkpoint`, `in_flight_start`/`end`, `session_*`. `DefaultSessionStore.list()` reads sidecar `<id>.summary.json`; `DefaultSessionReader` provides query/replay/search/export. Path source of truth: `resolveWstackPaths()` (`core/src/utils/wstack-paths.ts`).

**Session names:** `SessionSummary.name?` is an optional user label, distinct from auto-derived `title`; set via `SessionStore.rename(id, name)` (`/sessions rename`, `session.rename` WS); listings prefer `name`; rename is NOT guarded by the in-use check. **Delete in-use guard:** `DefaultSessionStore.delete()` refuses to remove a session any live process is using through the optional `isSessionInUse` callback, wired to `SessionRegistry.listByProject(slug)`; the guard throws.

### Recording invariants (do not regress)

1. **`agent.ctx.session` is the single live writer** — persisters resolve it at append time (pass a getter `() => context.session` to `createSessionEventBridge`, never a captured instance).
2. **Every path that swaps `ctx.session`** (TUI resume, WebUI resume/new/projects.select, exit) finalizes the old writer: append `session_end` with usage, then `close()`; explicit resume atomically moves SessionRegistry ownership to the selected session id.
3. **`FileSessionWriter` serializes all writes** through a FIFO `writeChain`; idempotent awaitable `close()`; no second write path.
4. **No mid-stream `session_end`** — `/save` flushes, never ends; recovery treats only a *trailing* `session_end` as clean exit.
5. **Session ids are date-sharded** (`2026-06-11/<base>`); sidecar paths go through `sessionScopedPath()`; directory scans must descend one shard level.
6. Regression net: `core/tests/storage/session-lifecycle.test.ts` — extend when touching the lifecycle; test with sharded ids.

In-tree project state: committed `.wrongstack/project.json` (stable `proj_<ULID>` shared by HQ), `.wrongstack/AGENTS.md`, `.wrongstack/skills/`, `.wrongstack/agents/` (per-role identity, learned directives and project-developed skill addenda — committed so a fresh clone starts trained; its `archive/` and `skills/affinity.json` stay local), optional `.wrongstack/config.json`; everything else in `~/.wrongstack/projects/<hash>/`.

**Security — `inProjectConfig` is untrusted.** `<project>/.wrongstack/config.json` is attacker-controllable (ships in a repo) yet merges above the user's global config. `stripUnsafeInProjectFields()` (`config-loader.ts`) is an **allow-list** — only benign preferences (`model`, `context`, `tools`, `features`, `autonomy`, `indexing`, `session`, `log`, `launch`, …) survive; everything else (`provider`, `apiKey`, `baseUrl`, `providers`, `mcpServers`, `hooks`, `plugins`, `sync`, `yolo`, `extensions`, `hq`, `acp`, `fleet`) is dropped with a warning (otherwise: RCE via `mcpServers`/`hooks`/LSP `command`, key exfil via `baseUrl`). Allowed parents still have nested guards: `tools.exec.allow`/`.danger`, `skills.extraDirs`/`.registryUrl`, and `Sage.storage.directory` are stripped. `assertInProjectAllowListComplete()` throws if a new top-level `Config` field isn't classified in `IN_PROJECT_ALLOWED_KEYS` or `KNOWN_DENIED_IN_PROJECT` — new fields are **denied by default**; update one of the two lists when adding a field. Sensitive per-project config → non-committed `~/.wrongstack/projects/<hash>/config.local.json`.

## Observability & commands

Three noop-default pillars: Metrics (`MetricsSink`, opt-in `--metrics`), Traces (`Tracer`, bind real `OTelTracer`), Health (`HealthRegistry`, `--metrics`); Prometheus `--metrics-port 9090`; OTLP exporters available. Commands: `pnpm run build` · `pnpm test` · `pnpm run typecheck` · `pnpm run lint` · `pnpm run dev`.

## Key files

`apps/wrongstack/src/index.js` (published bin shim) · `packages/cli/src/index.ts` (export + main-entry guard) · `packages/cli/src/cli-main.ts` (boot orchestrator) · `packages/cli/src/repl.ts` · `packages/cli/src/slash-commands/index.ts` · `packages/core/src/kernel/{container,pipeline,events,run-controller}.ts` · `packages/core/src/core/agent.ts` (main loop) · `packages/core/src/execution/tool-executor.ts` · `packages/core/src/coordination/multi-agent-coordinator.ts` · `packages/tools/src/builtin.ts` · `packages/mcp/src/client.ts`.

## Slash commands

All in `packages/cli/src/slash-commands/`; each exports `buildXxxCommand(opts: SlashCommandContext): SlashCommand` (`name`, `description`, optional `aliases`/`help`, `async run(args, ctx)`). `SlashCommandContext` (wired in `cli/src/index.ts`) carries the registries, context, paths, renderer, stores, provider/model, and the onSpawn/onFleet*/onAutonomy/etc. callbacks. Adding one: create `slash-commands/<name>.ts` → register in `buildBuiltinSlashCommands()` (`index.ts`) → tests `packages/cli/tests/slash-<name>.test.ts` → docs `docs/slash/<name>.md`.

`buildBuiltinSlashCommands()` is the authoritative built-in list; do not maintain a hand-count here. `git`, `health`, `metrics`, `plan`, and `security` are implemented and registered. Skill commands (`/skill*`) are supplied by the first-party skills plugin rather than this built-in array.

## Issue tracking

Completed multi-PR follow-up notes live under `docs/archive/work-items/issues/`. Track new follow-ups in the project issue tracker rather than adding them to the current documentation path.

## Skill system

Skills are `SKILL.md` files (agentskills.io: YAML frontmatter `name`/`description` + markdown body) loaded by `DefaultSkillLoader` (`execution/skill-loader.ts`, `TOKENS.SkillLoader`). Discovery priority, first-seen wins by name: project `.wrongstack/skills/` → project `.claude/skills/` → project foreign dirs (`.{codex,cursor,agents,gemini,qwen,trae,windsurf}/skills/`; cursor: `skills-cursor`) → active profile `~/.wrongstack/profiles/<name>/skills/` → `~/.claude/skills/` → same foreign set under `~` → `config.skills.extraDirs` (profile config only) → `packages/core/skills/` (bundled). Foreign layers read-only; dedup by name; frontmatter via shared `skills/frontmatter.ts` (`validateSkillName`); symlinks followed.

**Injection:** `DefaultSystemPromptBuilder` injects skill bodies. Mode `'progressive'` injects only a name+trigger manifest + a `skill` tool (`tools/src/skill.ts`) loading body + resources on demand; default `'eager'` injects all bodies bounded by `eagerMaxChars` (default 24000, highest-priority first; overflow → manifest + tool).

**Commands** (via `createSkillsPlugin`): `/skill`, `/skill-gen`, `/skill-search`, `/skill-install <user/repo|registry:id>`, `/skill-import`, `/skill-update`, `/skill-uninstall`. Config: `config.skills = { readClaudeSkills, foreignSources, mode, eagerMaxChars, extraDirs, registryUrl }`; `extraDirs`/`registryUrl` stripped from in-project config (prompt-injection / SSRF). `/skill-search` queries a registry (default skills.sh); private GitHub repos work with `GITHUB_TOKEN`/`GH_TOKEN`. **Limits** in one place — `core/src/skills/limits.ts` (`SKILL_LIMITS`).

29 bundled skills live under `packages/core/skills/` (`output-standards` is depended on by almost every other skill — don't drop it). See `docs/skills.md`.

## Prompt library

`DefaultPromptLoader` (`execution/prompt-loader.ts`, `TOKENS.PromptLoader`), three layers deduped by `slug` (higher shadows lower): `<project>/.wrongstack/prompts/` → active profile `~/.wrongstack/profiles/<name>/prompts/` → `packages/core/data/prompts/` (bundled read-only, built by `packages/core/scripts/build-prompts.mjs`). `PromptEntry` is v2; v1 upgrades lazily on read (`migratePromptEntry`). Favoriting/editing a builtin **copies it down** to the profile layer (`forkedFrom:<slug>`) — bundled dataset never mutated. `renderPrompt(entry, values)` fills `{{variable}}` placeholders. Surfaced via the `wstack-prompts` plugin (`/prompt`, `/prompts`, `/prompt-gen`).

## Domain knowledge

- **IDs are ULIDs** not UUIDs (`ulid.ts` in core)
- **`tool.executed` events** are truncated before session-log write (threshold configurable)
- **Secret encryption** — API keys in active profile configs are encrypted per-machine (`~/.wrongstack/.key`, `DefaultSecretVault`)
- **`runText`** — a slash command returning `{ runText: "..." }` makes the REPL inject that text as the next user turn (`/goal`, `/sdd`, `/autonomy` steering)

## Verification checklist

`pnpm run typecheck` + `pnpm test` before any PR. New slash commands → tests in `packages/cli/tests/slash-<name>.test.ts`; new tools → tests in their package; new kernel token → `tokens.ts` + document here; new EventBus event → `events.ts` with doc comment.

## Pre-commit hook

`.githooks/pre-commit` (install: `pnpm run setup:hooks`) runs `guard-against-corruption`, `lint-console-logging`, `guard-unresolved-imports`, and Core API snapshot sync. Workspace-wide typecheck is **not** in pre-commit (it would see unstaged/untracked WIP and force `--no-verify`). Run `pnpm build` once after pulling to seed local `dist/` (routes through `scripts/build.mjs`, topological sort, then `scripts/build-package.mjs` for esbuild + TypeScript declaration emit). **Never `pnpm -r build`** — alphabetical order can build a consumer before its workspace dependency, causing missing or stale declaration resolution and potentially unloadable runtime output. Stale-dist errors after pulling main → `pnpm build`.

`.githooks/pre-push` runs `pnpm ci:local` (lint → build → typecheck → tests + architecture/snapshot gates) and blocks the push on failure. Docs-only pushes skip it. Coverage and Playwright e2e stay in GitHub CI. Emergency skip: `WRONGSTACK_SKIP_PRE_PUSH=1` or `--no-verify` (`release:check` is still the full maintainer gate).

## Useful pointers

ADRs `docs/adr/` · changelog `CHANGELOG.md` · configuration `docs/configuration.md` · authoring guides `docs/{plugin,provider,tool}-author-guide.md` + `docs/skills.md` · troubleshooting `docs/troubleshooting.md` · slash docs `docs/slash/README.md`

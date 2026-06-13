# AGENTS.md — WrongStack Developer Reference

> **DO NOT DELETE THIS FILE.** It is loaded into WrongStack's system prompt as
> persistent project context. Previous content here may contain decisions,
> architecture notes, domain knowledge, or verification history that should be
> preserved. Merge additions rather than replacing.

## Project brief

WrongStack is a terminal AI coding agent built in TypeScript. It runs an LLM that reads code, edits files, runs shell commands, and reasons through bugs — with a permission policy that auto-approves trusted/YOLO-normal project work while gating clearly destructive or project-escaping calls unless explicitly overridden. The project is a monorepo of 10+ packages.

**Runtime:** CLI (REPL), optional TUI (React/Ink), optional WebUI (Vite/React)
**Primary users:** Individual developers, teams
**Entry point:** `apps/wrongstack/src/main.ts` → `packages/cli/src/index.ts`

## Package map

```
packages/core/        — Kernel: Container, Pipeline, EventBus, RunController, Context
packages/providers/   — Anthropic, OpenAI, Google, OpenAI-compatible adapters
packages/tools/       — Builtin tools: read, write, bash, exec, git, grep, glob, ...
packages/mcp/         — MCP client + registry + stdio/SSE/streamable-http transports
packages/plug-lsp/    — LSP bridge (slash commands: /lsp:start, /lsp:diag, /lsp:goto)
packages/acp/         — Agent Client Protocol: client + agent (Zed, JetBrains, VSCode ACP)
packages/cli/         — REPL, subcommands, slash commands, plugin management
packages/tui/         — React/Ink terminal UI (lazy-loaded behind --tui)
packages/runtime/     — Default runtime wiring: makeDefaultRuntime()
packages/telegram/    — Telegram bridge plugin
packages/webui/       — Vite+React web UI: standalone `webui` binary + CLI `--webui` (see docs/webui.md)
packages/plugins/     — Built-in plugin host: cron, file-watcher, session-tracker, subagent
packages/skills/      — Bundled skill registry (16 SKILL.md files shipped in core/skills/)
apps/wrongstack/      — bin entry (wrongstack / wstack)
```

**Dependency direction:** `core` → nothing WrongStack-internal. `providers/tools/mcp/plug-lsp/acp/runtime/telegram/plugins/skills` → `core`. `cli/tui` → everything beneath. Never reverse these layers.

## Key architectural concepts

### Kernel (≤600 lines total)

`packages/core/src/kernel/` has four primitives:

**Container** — Typed DI indexed by `Token<T>` (branded symbol). Bindings: `factory`, `value`, `decorator`. Resolution is lazy and memoized. Well-known tokens in `tokens.ts`:

```
TOKENS.Logger · TOKENS.TokenCounter · TOKENS.SessionStore · TOKENS.MemoryStore
TOKENS.PermissionPolicy · TOKENS.Compactor · TOKENS.PathResolver · TOKENS.ConfigLoader
TOKENS.ConfigStore · TOKENS.Renderer · TOKENS.InputReader · TOKENS.ErrorHandler
TOKENS.RetryPolicy · TOKENS.SkillLoader · TOKENS.SystemPromptBuilder · TOKENS.SecretScrubber
TOKENS.ModelsRegistry · TOKENS.ModeStore · TOKENS.ProviderRunner · TOKENS.WorktreeManager
TOKENS.BrainArbiter · TOKENS.HookRegistry
```

Plugins rebind any token before `Agent.run`. No service-locator pattern — every dependency is explicit.

**Pipeline<T>** — Linear middleware chain. Six pipelines fire per agent step:

| Pipeline | Fires |
|---|---|
| `userInput` | Every user turn |
| `request` | Before each provider call |
| `response` | After each provider call |
| `assistantOutput` | Per assistant text block |
| `toolCall` | After every tool call |
| `contextWindow` | Before sending if context might be too large |

Middleware shape:
```ts
const mw: Middleware<Request> = {
  name: 'my-mw',
  owner: 'my-plugin',
  handler: async (req, next) => { /* before */ const out = await next(req); /* after */ return out; },
};
```

**EventBus** — Typed pub/sub. All events defined in `packages/core/src/kernel/events.ts` (typed `EventMap`):

| Category | Events |
|---|---|
| **Session** | `session.started`, `session.ended`, `session.damaged`, `session.rewound` |
| **Iteration** | `iteration.started`, `iteration.completed`, `iteration.limit_reached` |
| **Provider** | `provider.response`, `provider.text_delta`, `provider.thinking_delta`, `provider.tool_use_start`, `provider.tool_use_stop`, `provider.retry`, `provider.error`, `provider.fallback`, `provider.trust.persisted` |
| **Tool** | `tool.started`, `tool.progress`, `tool.confirm_needed`, `tool.executed` |
| **Context** | `ctx.pct`, `token.threshold`, `budget.threshold_reached`, `context.repaired` |
| **Compaction** | `compaction.fired`, `compaction.failed` |
| **MCP** | `mcp.server.connected`, `mcp.server.reconnected`, `mcp.server.disconnected` |
| **Subagent** | `subagent.spawned`, `subagent.task_started`, `subagent.task_completed`, `subagent.budget_warning`, `subagent.budget_extended`, `subagent.tool_executed`, `subagent.iteration_summary`, `subagent.done`, `subagent.ctx_pct` |
| **Worktree** | `worktree.allocated`, `worktree.committed`, `worktree.merged`, `worktree.conflict`, `worktree.released`, `worktree.failed` |
| **Session (audit)** | `checkpoint.written`, `in_flight.started`, `in_flight.ended`, `token.cost_estimate_unavailable` |
| **Fleet** | `coordinator.stats` |
| **Brain** | `brain.decision_requested`, `brain.decision_answered`, `brain.decision_ask_human`, `brain.human_answered`, `brain.decision_denied`, `brain.intervention` |
| **Errors** | `error` |

Total: **~50 events** across 12 categories. Source of truth is the `EventMap` type in `events.ts` — any new event must be added there AND to this table.

**RunController** — One per `Agent.run`. Owns `AbortController`, chains parent signal, drains abort hooks LIFO on dispose.

### Context and ConversationState

`Context` is the live agent-run object: messages, todos, system prompt, session writer, tools, provider, signal, cwd, model, meta.

After L1-A, `Context` implements `RunEnv` (read-only env interface). `ctx.state: ConversationState` is an observable wrapper over mutable fields. `ctx.state.appendMessage(m)` and `ctx.state.replaceMessages(ms)` fire `onChange` events. Direct mutation still works for backward compat but subscribers won't see those changes.

### Agent lifecycle

```
user input → Agent.run
  ↓ normalizeAndEmitUserInput (userInput pipeline + ctx.state.appendMessage)
  ↓ for each iteration:
      checkIterationLimit
      build request → request pipeline
      runProviderWithRetry → provider text_delta / response pipeline
      if text only → done
      else tool_use blocks:
          ToolExecutor.executeBatch
            permission check
            tool.execute → toolCall pipeline → ctx.state.append
      compactContextIfNeeded → contextWindow pipeline
  ↓ RunResult
```

### Tools streaming contract

```ts
interface Tool<I, O> {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  permission: 'auto' | 'confirm' | 'deny';
  mutating: boolean;
  execute(input, ctx, opts): Promise<O>;
  executeStream?(input, ctx, opts): AsyncIterable<ToolStreamEvent<O>>; // preferred when available
  cleanup?(input, ctx): Promise<void>;
}
```

`executeStream` yields `log`, `partial_output`, `metric`, `file_changed`, `warning` events, then terminal `{ type: 'final', output }`. The executor publishes each as `tool.progress` on the EventBus. Tool execution strategies: `parallel` (all at once), `sequential`, or `smart` (auto, defaults to parallel for independent tools).

### Lifecycle hooks

User/plugin-defined hooks that **steer** (not just observe — the EventBus can't block). Core lives in `packages/core/src/hooks/` (`HookRegistry`, `HookRunner`, `runShellHook`); pure types in `types/hooks.ts`; DI token `TOKENS.HookRegistry`. Events: `PreToolUse` / `PostToolUse` (wired in `ToolExecutor` — block, rewrite input, append context), `UserPromptSubmit` (a `userInput` pipeline middleware — block via thrown `HookBlockedError`, inject context), `SessionStart` / `Stop` (an `AgentExtension`). Two transports: **shell** (`config.hooks`, JSON over stdin, exit 2 = block) and **in-process** (`api.registerHook(event, matcher, fn)`). CLI wiring in `packages/cli/src/hooks-wiring.ts` + boot in `index.ts`; gated off by `--no-hooks`. See `docs/hooks.md`.

### Fallback model

`config.fallbackModels` (CLI `--fallback-model a,b,c`) — ordered chain tried when the primary is overloaded (429/529/5xx) after its own retries. Implemented as an `AgentExtension` (`packages/cli/src/fallback-model.ts`) that wraps the provider runner: walks the chain within a single provider call (so it doesn't burn the loop's `recoveryRetries`), cross-provider via `buildProviderForId` (shared with `/model`), and `beforeRun` restores the primary each turn. Emits `provider.fallback`.

### Multi-agent

`DefaultMultiAgentCoordinator` manages a fleet with:
- Task queue with `maxConcurrent` (default 4) in-flight limit
- Per-subagent `SubagentBudget`: maxIterations, maxToolCalls, maxTokens, maxCostUsd, timeoutMs
- `AgentBridge` for bidirectional parent↔subagent messaging
- `BudgetExceededError` → `timeout` or `stopped` result status
- Subagent signal lifecycle: `AbortController` recycled between tasks

For director-driven evolution, see `docs/director-architecture.md`.

### The Brain (decision layer)

One **Brain** instance per session, bound at `TOKENS.BrainArbiter`, sits
between the agents and the human. Every autonomous consumer — Director
(`director.ts`, `director-construction.ts`), AutoPhase
(`phase-orchestrator.ts`), Eternal engine (`eternal-autonomy.ts`, incl.
the `--eternal` flag path) — routes blocking decisions through it.

**Three tiers** (`cli-main.ts` wires the chain):
1. `DefaultBrainArbiter` — deterministic policy (low-risk fast path,
   fallback semantics).
2. `createTieredBrainArbiter` + `createAutonomyBrain`
   (`core/execution/autonomy-brain.ts`) — LLM decision engine, gated by a
   **live autonomy ceiling** (`/brain risk off|low|medium|high|all`,
   default `medium`, read on every decision). Sees the live
   provider/model via a lazy wrapper.
3. `HumanEscalatingBrainArbiter` + `BrainDecisionQueue` — interactive
   prompt (TUI `BrainDecisionPrompt`). `ObservableBrainArbiter` emits
   `brain.decision_*` events around the whole chain.

**Self-activation:** `BrainMonitor`
(`core/coordination/brain-monitor.ts`) watches the EventBus for
tool-failure streaks (3× same tool) and error storms (4 in 60s),
consults the Brain (`source: 'system'`, options steer/continue, fallback
`continue`), and on a steer decision sends a high-priority `steer` mail
from `brain@<sessionTag>` to `leader@<sessionTag>` — folded into the
agent's conversation by the mailbox loop. Emits `brain.intervention`
either way; 120s per-signal cooldown; policy-only brains degrade to
observe-only. `/brain` shows status + the last 20 decisions.

**Surfaces:** TUI renders `brain.decision_*` as BRAIN history entries +
the ask-human overlay, and `brain.intervention` as a ⚡ intervention
entry (`use-brain-events.ts`). Both WebUI servers broadcast `brain.*` as
`{type: 'brain.event'}` WS messages; the frontend (`ws-handlers.ts`)
surfaces interventions as chat notices + toasts. The standalone WebUI
server wires its own Brain (policy → LLM, no human tier yet — `ask_human`
falls back) + BrainMonitor, and serves the `/brain` command over WS
(`brain.status` / `brain.risk` / `brain.ask` messages).

### Cross-surface coordination (multi-terminal / multi-WebUI)

Any number of terminals, TUIs and WebUIs working on the same project share
one coordination plane under `~/.wrongstack/projects/<slug>/`:

- **One canonical project dir.** Every surface derives `<slug>` via
  `projectSlug()` (`core/utils/wstack-paths.ts`). `resolveProjectDir`
  (GlobalMailbox) and the WebUI's `generateProjectSlug` DELEGATE to it —
  never reintroduce an inline slug copy (a divergent copy once split agents
  on edge-named projects into two mailboxes).
- **projects.json** (`~/.wrongstack/projects.json`) is auto-touched on every
  boot — CLI/TUI via `touchProjectInManifest()` (file-locked) in
  `cli/slash-commands/project-utils.ts`, standalone WebUI via its local
  equivalent. Entries: name/root/slug/createdAt/lastSeen/lastWorkingDir.
- **GlobalMailbox** (`_mailbox.jsonl` + `_mailbox.registry.json`): agents
  register under a **session-unique identity** `<base>@<session-tag>` (set by
  `attachMailboxChecker` into `ctx.meta['globalAgentId']`) with 30s
  heartbeats (stale after 60s). The bare base id (`leader`) is an alias:
  the loop checker, the `mailbox` tool, and `/mailbox` query unique id +
  alias + `*` and dedupe by message id; read receipts always go under the
  unique id. "to leader" fans out to every live leader process; "to
  leader@a1b2c3d4" is exact. send() and ack() share one file lock (an unlocked
  append racing ack's rewrite is silently erased).
- **SessionRegistry** (cross-process): both the CLI and the standalone
  WebUI register their sessions and run `AgentStatusTracker`, so
  `/sessions status` lists every surface's live sessions.
- **Surfaces.** Agents read incoming mail automatically each iteration
  (`mailbox-loop` folds steer/btw inline) and write via `mail_send` /
  `mail_inbox` (high-affordance thin wrappers) or the multi-action
  `mailbox` power-tool — all registered in CLI and WebUI, available to
  fleet subagents (full registry by default), and covered by a mailbox
  protocol block in the system prompt + subagent baseline (identity,
  broadcast-milestones etiquette, answer-your-mail). Fleet subagents get
  distinct identities via Context `agentId`/`agentName` (host.ts).
  Humans use `/mailbox` (inbox / agents / send / broadcast / history);
  the TUI and both WebUI servers forward `mailbox.received` /
  `mailbox.agent_registered` live.

### Collab Debug Session

A **CollabSession** (triggered by `/collab <paths>` or `collab_debug` tool) runs a three-agent parallel pipeline: `bug-hunter` → `refactor-planner` → `critic`. Each agent emits structured events via `fleet_emit` tool, which the Director routes to the `FleetBus`. Downstream agents consume events in real time (not just at task completion).

**Event types:**
| Event | Emitted by | Consumed by |
|-------|-----------|-------------|
| `bug.found` | BugHunter | RefactorPlanner, Critic |
| `refactor.plan` | RefactorPlanner | Critic |
| `critic.evaluation` | Critic | Director (aggregated into final report) |

**Key rules:**
- Agents use `fleet_emit` tool for real-time event emission, NOT scratchpad JSON parsing
- BugHunter emits `bug.found` per-finding as soon as each is found (no batching)
- RefactorPlanner reads the BugHunter report from scratchpad, emits `refactor.plan` per bug
- Critic reads both reports, emits `critic.evaluation` per subject
- FleetMonitor (Ctrl+F) and FleetPanel show real-time agent status + event counts
- Timeline in FleetMonitor shows last 20 events across all agents

**Code references:**
- `packages/core/src/coordination/collab-debug.ts` — `CollabSession` class
- `packages/core/src/coordination/fleet-bus.ts` — `FleetBus` event routing
- `packages/tui/src/components/fleet-monitor.tsx` — Ctrl+F dashboard
- `packages/tui/src/components/fleet-panel.tsx` — status bar compact view

### TUI Fleet Commands

| Key / Command | Effect |
|---|---|
| `Ctrl+F` | Toggle full fleet monitor dashboard |
| `Ctrl+G` | Toggle agents monitor (per-agent live view) |
| `/fleet status` | Pending + completed task table per subagent |
| `/fleet dispatch <task>` | Route task to best agent (heuristic + LLM) and spawn |
| `/fleet log <id>` | Compact JSONL transcript summary for subagent |
| `/fleet usage` | Per-agent iterations, tool calls, cost rollup |
| `/fleet spawn <role> [n]` | Spawn N agents of given role |
| `/fleet stream on\|off` | Show/hide subagent activity in leader history |

### MCP integration

**Client** (consume external servers): `MCPClient` speaks JSON-RPC 2.0 over three transports: `stdio` (child process), `sse` (server-sent events), `streamable-http` (NDJSON). `MCPRegistry` manages the fleet with exponential backoff + jitter on reconnect (cap 5 cycles, then `failed`). Tools get namespace prefix `mcp__<serverName>__<toolName>`. Enable/disable/restart via `/mcp` (REPL) or `wstack mcp` (CLI), persisted to `mcpServers` in config.

**Server** (expose WrongStack outward): `MCPServer` + `serveStdio` (`packages/mcp/src/server.ts`) make WrongStack itself an MCP server — `wstack mcp serve` exposes the built-in tool registry over stdio JSON-RPC. Default policy is read-only (`AutoApprovePermissionPolicy`); `--yolo` exposes write/exec tools, `--tools a,b,c` whitelists. CLI wiring in `packages/cli/src/mcp-serve.ts`. See `docs/mcp-server.md`.

### Compactors

`config.context.strategy` selects the compactor through `createStrategyCompactor` (`execution/strategy-compactor.ts`); `TOKENS.Compactor` binds to it in both the CLI container and the WebUI server (one wiring, two surfaces):

| `strategy` | Compactor | Behavior |
|---|---|---|
| `hybrid` *(default)* | `HybridCompactor` | Lossless rule-based — no LLM. Elides oversized old tool results, then collapses ancient turns into one digest that **preserves all text** (instructions/decisions) and drops only raw tool I/O (still in the session log). |
| `intelligent` | `IntelligentCompactor` | LLM summarization of ancient turns; falls back to the lossless digest if the summarizer call fails. |
| `selective` | `SelectiveCompactor` | LLM-driven keep/collapse selection (`LLMSelector`) + summarization. |

The LLM strategies resolve their `provider` from `ctx` at `compact()`-time (so binding before `context.provider` exists is safe) and degrade to lossless hybrid when no provider is available. Shared primitives — token estimate, tool-result elision *with `tool_use`/`tool_result` pair preservation*, lossless digest, safe-cut boundary — live in `execution/compaction-core.ts`. The single canonical message-token estimator is `utils/token-estimate.ts:estimateMessageTokens` (chars/3.5), with per-`(provider,model)` calibration fed by `recordActualUsage` after each API call.

`AutoCompactionMiddleware` wraps the `contextWindow` pipeline and fires automatically when token thresholds are crossed; it writes a `compaction` session event carrying the collapse digest. `repairToolUseAdjacency()` removes orphan `tool_use`/`tool_result` blocks after context surgery or compaction.

Context modes: `balanced` (default), `frugal` (compacts early), `deep` (delays compaction), `archival` (keeps summaries prominent).

### Plugins

Declare `capabilities: { tools, providers, slashCommands, mcp, pipelines }` and receive a scoped `api`:

```ts
export default {
  name: 'my-plugin',
  apiVersion: '^0.1.0',
  capabilities: { tools: true },
  async setup(api) { api.tools.register(myTool); },
  async teardown() { /* close handles */ },
};
```

The loader runs `teardown()` on SIGINT and natural exit. See `docs/plugin-author-guide.md`.

## Session storage

All persistent per-project state (including sessions) lives under the user home:

```
~/.wrongstack/projects/<sha256(absProjectRoot).slice(0,12)>/sessions/<id>.jsonl
```

Each line is a `SessionEvent`. See `packages/core/src/types/session.ts` for the full
union and two-tier audit model (`session.auditLevel`).

Key events that are **always** written (Core Reconstruct Set):
- `user_input`, `llm_response`, `tool_result`
- `checkpoint`, `in_flight_start`/`in_flight_end`, `session_*`

Many richer audit events (`compaction`, `tool_call_*`, provider retries, etc.)
are controlled by `Config.session.auditLevel` (default: "standard").

`DefaultSessionStore.list()` reads a side-car `<id>.summary.json` for fast listing.
`DefaultSessionReader` provides query/replay/search/export.

**Source of truth for paths:** `resolveWstackPaths()` in `packages/core/src/utils/wstack-paths.ts`.

### Recording invariants (do not regress)

1. **`agent.ctx.session` is the single live writer.** Anything that persists
   events long-term must resolve the writer at append time — the CLI's
   `sessionBridge` and the standalone WebUI server pass a **getter**
   (`() => context.session`) to `createSessionEventBridge`, never a captured
   writer instance.
2. **Every code path that swaps `ctx.session`** (TUI `onResumeSession`, WebUI
   `session.resume` / `session.new` / `projects.select`, process exit) must
   finalize the writer it leaves: append `session_end` with current usage,
   then `close()`. Resume paths additionally re-point the recovery lock
   (`active.json`) at the new session id.
3. **`FileSessionWriter` serializes all disk writes** through a FIFO
   `writeChain`, shares one lazy-init promise for the `session_start` record,
   and exposes an idempotent awaitable `close()`. Don't add a second write
   path around it.
4. **Mid-stream `session_end` markers are forbidden** — `/save` flushes, it
   does not end. Recovery (`RecoveryLock`, `SessionRecovery`) treats only a
   *trailing* `session_end` as a clean exit.
5. **Session ids are date-sharded** (`2026-06-11/<base>`). Per-session sidecar
   paths (`.jsonl`/`.summary.json`/`.annotations.json`/`.audit.jsonl`/
   `.replay.jsonl`) must go through `sessionScopedPath()`
   (`packages/core/src/utils/session-scoped-path.ts`) — containment-checked,
   shard-slash-friendly. Directory scans for session artifacts must descend
   one shard level; root-only scans miss every modern session.
6. The end-to-end regression net is
   `packages/core/tests/storage/session-lifecycle.test.ts` — extend it when
   touching the lifecycle. Always test with sharded ids, not flat ones.

The **only** things that live inside the project tree itself are the committed
`.wrongstack/AGENTS.md` and `.wrongstack/skills/`. Everything else is in
`~/.wrongstack/projects/<hash>/`.

## Observability

Three pillars, all behind noop-default interfaces:

| Pillar | Interface | Default | Opt-in |
|---|---|---|---|
| Metrics | `MetricsSink` | `NoopMetricsSink` | `--metrics` |
| Traces | `Tracer` | `NoopTracer` | bind real `OTelTracer` |
| Health | `HealthRegistry` | `DefaultHealthRegistry` | `--metrics` |

Prometheus endpoint: `--metrics-port 9090`. OTLP exporters available.

## Commands

| Command | Script |
|---------|--------|
| Build | `pnpm run build` |
| Test | `pnpm test` |
| Typecheck | `pnpm run typecheck` |
| Lint | `pnpm run lint` |
| Dev | `pnpm run dev` |

## Key files and entry points

| File | Role |
|---|---|
| `apps/wrongstack/src/main.ts` | Binary entry point |
| `packages/cli/src/index.ts` | CLI boot: parse argv → wire container → run REPL/TUI |
| `packages/cli/src/repl.ts` | REPL implementation, slash command dispatch |
| `packages/cli/src/slash-commands/index.ts` | All builtin slash commands registered here |
| `packages/cli/src/slash-commands/helpers.ts` | Shared helpers: `detectProjectFacts`, `renderAgentsTemplate`, `countTurnPairs`, etc. |
| `packages/core/src/kernel/container.ts` | DI container |
| `packages/core/src/kernel/pipeline.ts` | Middleware pipeline |
| `packages/core/src/kernel/event-bus.ts` | Typed pub/sub |
| `packages/core/src/kernel/run-controller.ts` | Abort signal and cleanup management |
| `packages/core/src/agent.ts` | `Agent.run` — the main loop |
| `packages/core/src/execution/tool-executor.ts` | Tool batch execution |
| `packages/core/src/execution/intelligent-compactor.ts` | LLM-assisted compaction + repair |
| `packages/core/src/coordination/multi-agent-coordinator.ts` | Subagent fleet coordinator |
| `packages/tools/src/builtin.ts` | All builtin tools |
| `packages/mcp/src/client.ts` | MCP client + transport layer |
| `packages/core/src/storage/session-store.ts` | Session persistence |
| `packages/core/src/storage/memory-store.ts` | Memory persistence |
| `packages/core/src/storage/plan-store.ts` | Plan persistence |

## Slash commands

All slash commands live in `packages/cli/src/slash-commands/`. Each is a `buildXxxCommand(opts: SlashCommandContext): SlashCommand` that returns an object with `name`, `description`, optional `aliases`, optional `help`, and an `async run(args, ctx)` method.

Key `SlashCommandContext` fields wired in `packages/cli/src/index.ts`:
```
registry · toolRegistry · context · cwd · projectRoot · renderer
memoryStore · sessionStore · skillLoader · modeStore · compactor
tokenCounter · llmProvider · llmModel · planPath
onSpawn · onAgents · onDirector · onFleet · onFleetRetry · onFleetLog
onYolo · onAutonomy · onEternalStart · onEternalStop · onPlugin
statuslineConfig · statuslineHiddenItems · metricsSink · healthRegistry
```

Slash commands are documented in `docs/slash/`. When adding a new one:
1. Create `packages/cli/src/slash-commands/<name>.ts`
2. Export `buildXxxCommand(opts: SlashCommandContext): SlashCommand`
3. Import and add to `buildBuiltinSlashCommands()` in `index.ts`
4. Add tests: `packages/cli/tests/slash-<name>.test.ts`
5. Add docs: `docs/slash/<name>.md`

**Currently registered (33):** `help`, `init`, `clear`, `compact`, `context`, `tools`, `plugin`, `mcp`, `diag`, `stats`, `spawn`, `agents`, `director`, `fleet`, `memory`, `todos`, `sdd`, `save`, `load`, `yolo`, `autonomy`, `goal`, `brain`, `btw`, `next`, `mode`, `exit`, `fix`, `autophase`, `worktree`, `settings`, `collab`, `statusline`.

Previously-planned but not yet implemented: `git`, `health`, `metrics`, `plan`, `security`, `skill-gen`, `skills`. Their `docs/slash/*.md` files were deleted in 2026-06-13 (H13 from the 2026-06-03 audit). If any of them become priorities, add them via a `buildXxxCommand` registered in `packages/cli/src/slash-commands/index.ts` first, then write a fresh `docs/slash/<name>.md` describing the actual implementation.

## Issue tracking

Open issues and follow-up refactors that span more than a single PR are tracked as `docs/issues/YYYY-MM-DD-<slug>.md` files. The first such file is `docs/issues/2026-06-13-tui-app-refactor.md`, which describes an 8-PR plan to split `packages/tui/src/app.tsx` (5,671 lines) into focused hooks. Future refactors of similar scope should also land here so the next session can pick up where the last one left off.

These files are the **in-repo equivalent of a GitHub issue**. When opening the corresponding GitHub issue, copy the markdown body to the issue; when closing the GitHub issue, the file stays as historical record.

## Skill system

Skills are `SKILL.md` files loaded by `DefaultSkillLoader` from three scopes (first-seen wins by name):

| Priority | Location |
|---|---|
| 1 | `<project>/.wrongstack/skills/` |
| 2 | `~/.wrongstack/skills/` |
| 3 | `packages/core/skills/` (bundled) |

Format:
```markdown
---
name: my-skill
description: |
  Use this skill when <trigger condition>.
  Triggers: user says "X", "Y".
version: 1.0.0
---

# My Skill

## Overview
One-line description of what this skill does.

## Rules
1. Rule one
2. Rule two

## Patterns
### Do
```ts
// good example
```

### Don't
```ts
// bad example
```

## Skills in scope
- `other-skill` — for delegation when this skill needs help
```

Bundled skills: `api-design`, `audit-log`, `bug-hunter`, `docker-deploy`, `git-flow`, `multi-agent`, `node-modern`, `observability`, `prompt-engineering`, `react-modern`, `refactor-planner`, `sdd`, `security-scanner`, `skill-creator`, `testing`, `typescript-strict`.

See `docs/skills.md` for the full authoring guide.

## Domain knowledge

- **IDs are ULIDs** not UUIDs — see `ulid.ts` in core
- **Token brandings** — `Token<T>` is a branded `symbol` for type-safe DI, not a string
- **Pipeline middleware** can `replace` a step — the last `replace` in the chain wins (position-aware)
- **Compactor runs after every iteration** via the `contextWindow` pipeline, not explicitly in the agent loop
- **MCP reconnect** uses exponential backoff with jitter, capped at 5 cycles, then the server transitions to `failed`
- **`tool.executed` events** are truncated before writing to the session log to avoid flooding — truncation threshold is configurable
- **Secret encryption** — API keys in `~/.wrongstack/config.json` are encrypted with a per-machine key derived from `~/.wrongstack/.key` using `DefaultSecretVault`
- **`runText` in slash command results** — when a slash command returns `{ runText: "..." }`, the REPL injects that text as the next user turn (used by `/goal`, `/sdd`, `/autonomy` for steering)

## Verification checklist

- Run `pnpm run typecheck` before any PR
- Run `pnpm test` — 3091+ tests should all pass
- New slash commands need tests in `packages/cli/tests/slash-<name>.test.ts`
- New tools need tests in the corresponding package
- If adding a new kernel token, update `tokens.ts` and document in this file
- If adding a new EventBus event type, add it to `events.ts` with doc comment

## Useful pointers

- **Architecture decisions:** `docs/adr/` — architectural decision records
- **Plugin authoring:** `docs/plugin-author-guide.md`
- **Provider authoring:** `docs/provider-author-guide.md`
- **Tool authoring:** `docs/tool-author-guide.md`
- **Skill authoring:** `docs/skills.md`
- **Troubleshooting:** `docs/troubleshooting.md`
- **Slash command docs:** `docs/slash/README.md`
- **Changelog:** `CHANGELOG.md`
- **Configuration:** `docs/configuration.md`
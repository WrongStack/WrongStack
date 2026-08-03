# WrongStack — Comprehensive Architecture Report

> **Generated:** 2026-07-28  
> **Version:** 0.296.2  
> **Repository:** github.com/WrongStack/WrongStack  
> **Stack:** TypeScript 7 strict, pnpm workspace monorepo, Node.js ≥ 22.19

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Workspace Layout & Dependency Graph](#2-workspace-layout--dependency-graph)
3. [The Kernel (packages/core/src/kernel)](#3-the-kernel)
4. [Core Agent Runtime (packages/core/src/core)](#4-core-agent-runtime)
5. [Execution Layer (packages/core/src/execution)](#5-execution-layer)
6. [Coordination & Multi-Agent (packages/core/src/coordination)](#6-coordination--multi-agent)
7. [Plugin System (packages/core/src/plugin)](#7-plugin-system)
8. [Security Model (packages/core/src/security)](#8-security-model)
9. [Storage & Persistence (packages/core/src/storage + packages/persistence)](#9-storage--persistence)
10. [Types & Interfaces (packages/core/src/types)](#10-types--interfaces)
11. [Providers Package (packages/providers)](#11-providers-package)
12. [Tools Package (packages/tools)](#12-tools-package)
13. [Plugins Package (packages/plugins)](#13-plugins-package)
14. [CLI Package (packages/cli)](#14-cli-package)
15. [MCP Integration (packages/mcp + packages/core/src/infrastructure)](#15-mcp-integration)
16. [UI Surfaces](#16-ui-surfaces)
    - [TUI — Terminal UI (packages/tui)](#161-tui--terminal-ui)
    - [WebUI — Browser Frontend (packages/webui)](#162-webui--browser-frontend)
    - [WebUI Server (packages/webui-server)](#163-webui-server)
    - [SimpleUI (packages/simpleui)](#164-simpleui)
    - [HQ Command Center (packages/webui-hq)](#165-hq-command-center)
17. [Specialized Packages](#17-specialized-packages)
    - [Kanban (packages/kanban)](#171-kanban)
    - [SDD — Spec-Driven Development (packages/sdd)](#172-sdd)
    - [Security Scanner (packages/security-scanner)](#173-security-scanner)
    - [SAGE (packages/sage)](#174-sage)
    - [TechStack (packages/techstack)](#175-techstack)
    - [ACP — Agent Client Protocol (packages/acp)](#176-acp)
    - [Plug-LSP (packages/plug-lsp)](#177-plug-lsp)
    - [Telegram Bridge (packages/telegram)](#178-telegram-bridge)
    - [Runtime (packages/runtime)](#179-runtime)
    - [Bench (packages/bench)](#1710-bench)
18. [Applications](#18-applications)
    - [wrongstack / wstack (apps/wrongstack)](#181-wrongstack--wstack)
    - [Desktop (apps/desktop)](#182-desktop)
19. [Observability & Instrumentation](#19-observability--instrumentation)
20. [Scripts & DevOps](#20-scripts--devops)
21. [Architecture Summary & Key Patterns](#21-architecture-summary--key-patterns)

---

## 1. Project Overview

**WrongStack** is a free, open-source, MIT-licensed AI coding agent that runs in the terminal. It reads code, edits files, runs commands, and reasons through bugs across five surfaces: a plain REPL, a full-screen Ink/React TUI (`--tui`), a browser WebUI (`--webui`), an Electron desktop shell (`--desktop`), and a cross-machine HQ command center (`--hq`).

Key numbers:
- **~630 source files** across 17 packages + 2 apps
- **59 built-in tools** in `@wrongstack/tools`
- **29 built-in skills** shipped with `@wrongstack/core`
- **73 managed plugin rows** (8 core + 63 in `@wrongstack/plugins` + 2 bridges)
- **~140 LLM providers** auto-discovered from models.dev
- **~75 slash commands** in the CLI
- **75 agent roles** in the multi-agent roster
- **TypeScript 7 strict**, ESM-only, `noUncheckedIndexedAccess`

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js ≥ 22.19.0 |
| Language | TypeScript 7 (strict) |
| Package manager | pnpm 11, workspaces |
| Linter/Formatter | Biome 2.5 |
| Test runner | Vitest 4 (forks pool) |
| E2E | Playwright |
| Terminal UI | Ink 7 + React 19 |
| Browser UI | Vite 8 + React 19 + Tailwind 4 + Zustand + i18next |
| Backend | Node HTTP + WebSocket (`ws`) |
| Desktop | Electron 43 |
| DI | Custom `Container` (typed, token-based) |
| Build | esbuild (custom scripts) |

---

## 2. Workspace Layout & Dependency Graph

```
apps/
  wrongstack/       → published npm entry shim (re-exports @wrongstack/cli)
  desktop/          → Electron shell (depends on core, webui, webui-server)
packages/
  persistence/      → DEPENDENCY-FREE filesystem primitives (lowest layer)
  kanban/           → Standalone kanban board manager (depends only on persistence)
        ↓
  core/             → THE KERNEL — container, pipeline, event bus, agent, types,
                       coordination/director, storage, security, plugins, hooks,
                       skills, observability, infrastructure, replay, chronicle,
                       tasking, worktree, hq protocol, notifications, extension
        ↓
  ↓  ↓  ↓  ↓  ↓  ↓
  providers/        → LLM provider adapters (Anthropic, OpenAI, Google)
  tools/            → 59 built-in tools (filesystem, shell, git, etc.)
  sdd/              → Spec-Driven Development engine
  security-scanner/ → Security scanning tooling
  sage/     → SQLite-backed memory store
  mcp/              → MCP client (stdio, SSE, streamable HTTP transports)
  acp/              → Agent Client Protocol integration
  plug-lsp/         → LSP bridge + code intelligence
  runtime/          → Default runtime implementations
  bench/            → Agentic benchmark harness
  techstack/        → Dependency intelligence
  telegram/         → Telegram bridge plugin
        ↓
  ↓  ↓  ↓  ↓  ↓  ↓
  plugins/          → 63 first-party plugin collection
  tui/              → Ink/React terminal UI
  webui/            → Vite/React browser frontend
  webui-server/     → WebSocket/HTTP backend for web UIs
  webui-hq/         → HQ command center dashboard
  simpleui/         → Minimal browser chat surface
```

The dependency graph is a strict DAG enforced by `packages/core/tests/architecture/package-boundaries.test.ts`. **`@wrongstack/kanban`** is the only package below `core` — it depends solely on `@wrongstack/persistence` (which has zero WrongStack dependencies). All other packages depend on `core`.

---

## 3. The Kernel

`packages/core/src/kernel/` holds **six modules** (~1,670 lines total) and is the innermost layer. Nothing else in the codebase is allowed to expand it.

### 3.1 Container (`container.ts`)
A typed dependency injection container indexed by `Token<T>` (a branded `Symbol.for(...)`). Supports three binding forms:
- **`bind(token, factory, opts)`** — registers a factory (throws if token already bound)
- **`override(token, factory, opts)`** — replaces an existing binding (throws if absent)
- **`decorate(token, decorator)`** — wraps an existing binding

Resolution is lazy and singleton-memoized. Circular dependencies are detected at runtime via a `resolving` Set. Tokens use `Symbol.for()` (global registry) so DI survives accidental module duplication on case-insensitive filesystems.

### 3.2 Pipeline (`pipeline.ts`)
A Koa-style linear middleware chain over a value of type `T`. Named middleware with position-aware insertion (`insertBefore`, `insertAfter`, `replace`, `remove`). Error handling is per-middleware: `'rethrow'` (default for core middleware) or `'swallow'` (for plugins). Read-only views can be exposed to consumers.

Six named pipelines run per agent iteration:
| Pipeline | Payload | When |
|---|---|---|
| `userInput` | `{ content, text, ctx }` | Every user turn |
| `request` | `Request` | Before each provider call |
| `response` | `Response` | After each provider call |
| `assistantOutput` | `TextBlock` | Per text block |
| `toolCall` | `{ toolUse, result, ctx, tool }` | After each tool call |
| `contextWindow` | `Context` | Before sending if too large |

### 3.3 EventBus (`events.ts`)
Typed pub/sub with 11 event category maps: `AgentEventMap`, `BrainEventMap`, `FileEventMap`, `FleetEventMap`, `MemoryEventMap`, `ProviderEventMap`, `ProcessEventMap`, `NetworkEventMap`, `SddEventMap`, `SessionEventMap`, `ToolEventMap`, `WorktreeEventMap`. Subscribers cannot modify or cancel. Exceptions are caught. `ScopedEventBus` provides auto-unsubscribe on scope disposal. Events include: `iteration.started`, `iteration.completed`, `provider.text_delta`, `tool.progress`, `permission.evaluated`, `compaction.fired`, `mcp.server.connected`, etc.

### 3.4 RunController (`run-controller.ts`)
One per `Agent.run()`. Owns an `AbortController`, chains parent signals, drains abort hooks in LIFO order. Hooks are snapshot-before-fire to prevent re-triggering during cleanup.

### 3.5 Tokens (`tokens.ts`)
The well-known DI tokens:
`Logger`, `TokenCounter`, `SessionStore`, `MemoryPort`, `PermissionPolicy`, `Compactor`, `PathResolver`, `ConfigLoader`, `ConfigStore`, `FallbackProfileManager`, `Renderer`, `InputReader`, `ErrorHandler`, `RetryPolicy`, `SkillLoader`, `PromptLoader`, `SystemPromptBuilder`, `SecretScrubber`, `ModelsRegistry`, `ModeStore`, `ProviderRunner`, `WorktreeManager`, `BrainArbiter`, `HookRegistry`.

---

## 4. Core Agent Runtime

`packages/core/src/core/` implements the **agent loop**:

### 4.1 Agent (`agent.ts`)
The central class. Owns: `Container`, `ToolRegistry`, `ProviderRegistry`, `EventBus`, `Pipelines`, `Context`, `ToolExecutor`, `ExtensionRegistry`, and plugin lifecycle. Key properties:
- `maxIterations` — per-run cap (soft limit, auto-extendable)
- `executionStrategy` — `'parallel' | 'sequential' | 'smart'`
- `autoExtendLimit` — iteration cap auto-extension
- `autonomousContinue` — auto-continue mode
- Guarded against concurrent `run()` calls.

### 4.2 Agent Loop (`agent-loop.ts`)
The inner loop handler (`createAgentLoopHandler`). Per iteration:
1. `normalizeAndEmitUserInput` → `userInput` pipeline → `ctx.state.appendMessage`
2. Check iteration limit
3. Build request → `request` pipeline
4. `runProviderWithRetry` → streaming response
5. Process response → `response` pipeline → `assistantOutput` pipeline
6. If tool_use blocks: `ToolExecutor.executeBatch` → permission check → execute → `toolCall` pipeline
7. `compactContextIfNeeded` → `contextWindow` pipeline
8. Loop

### 4.3 Context (`context.ts`)
The live agent-run object: messages, todos, system prompt, session writer, tools, provider, signal, cwd, model, meta. Implements `RunEnv` interface (read-only env). Contains:
- `ctx.state: ConversationState` — observable wrapper over mutable fields with `onChange` subscribers
- `ctx.meta` — mutable metadata bag
- `ctx.todos` — tracked session todos

### 4.4 Conversation State (`conversation-state.ts`)
Observable wrapper around mutable conversation fields. `appendMessage(m)` and `replaceMessages(ms)` fire `onChange` events that UI components subscribe to.

### 4.5 System Prompt Builder (`system-prompt-builder.ts`)
Four-layer prompt architecture: Identity (static) → Tool usage (static) → Environment (semistatic) → Volatile (dynamic). Processes contributions from skills, plugins, modes, and instructions.

### 4.6 Provider Runner (`provider-runner.ts`)
`runProviderWithRetry` orchestrates the provider call with retry logic, streaming, and fallback chain rotation.

---

## 5. Execution Layer

`packages/core/src/execution/` contains runtime execution components:

### 5.1 ToolExecutor (`tool-executor.ts`, ~1454 lines)
The engine that runs tools. Key features:
- **Three execution strategies**: `parallel` (all at once), `sequential` (one after another), `smart` (auto: parallel when independent)
- **Streaming**: Prefers `executeStream` over `execute` when available; yields `log`, `partial_output`, `metric`, `file_changed`, or `warning` events → published as `tool.progress` on EventBus
- **Permission checks**: Every tool call goes through `PermissionPolicy` before execution
- **Output capping**: Per-iteration output is capped and truncated
- **Timeouts**: `iterationTimeoutMs` (default 300s), `maxToolTimeoutMs` (default 300s)
- **Schema validation**: Inputs coerced and validated against `inputSchema`
- **Telemetry**: Wraps executions with process and network telemetry spans

### 5.2 Compactors (`compactor.ts`, `selective-compactor.ts`, `intelligent-compactor.ts`, `strategy-compactor.ts`)
Three compaction strategies compose in `HybridCompactor`:
- **SelectiveCompactor** — preserves task-critical messages, elides the rest
- **IntelligentCompactor** — LLM-assisted summarization of ancient turns
- **StrategyCompactor** — policy-driven strategy selection

`AutoCompactionMiddleware` wraps the `contextWindow` pipeline with automatic compaction at threshold fractions (`warnThreshold`, `softThreshold`, `hardThreshold`).

Context-window modes: `balanced` (default), `frugal` (token-saver), `deep` (long-reasoning), `archival` (decision-preserving).

### 5.3 Autonomy Brain (`autonomy-brain.ts`)
The "Brain" is an authority seam for autonomous decisions. `createAutonomyBrain` wires a tiered decision system:
- `createTieredBrainArbiter` with tiers: deterministic first, then LLM-assisted, then human escalation
- `BrainDecisionCache` for memoization
- `BrainRule` system for pattern-based auto-decisions
- `BrainMonitor` watches for distress signals (tool failure streaks, error storms, agent stalls, file churn)

### 5.4 Council (`council-orchestrator.ts`, `council-brain.ts`, `council-personas.ts`, `council-profiles.ts`, `council-resolution.ts`)
Multi-perspective evaluation system:
- Voters + optional Judge for resolution
- Built-in persona registry with configurable profiles
- Quorum, approval fractions, timeouts per voter/judge
- Weighted resolution via `resolveCouncilVotes`

### 5.5 One-Shot LLM (`one-shot-llm.ts`)
`OneShotOrchestrator` for isolated single-turn LLM calls. Supports provider selection, model routing by role, fallback chains, timeout.

### 5.6 Prompt Enhancer / Refiner (`prompt-enhancer.ts`)
`enhanceUserPrompt` with gated enhancer reasoning, retry logic, and fallback chains. `resolveConfiguredRefinerRef` resolves the refiner model reference from config.

### 5.7 Model Runtime (`model-runtime.ts`)
Resolves model runtime configurations: reasoning effort, token budgets, caching settings, model-specific middleware.

### 5.8 Design System (`design-color.ts`, `design-detect.ts`, `design-kit-loader.ts`, `design-materialize.ts`, `design-tune.ts`, `design-verify.ts`)
Full design kit management: load design kits, detect usage, materialize CSS tokens, tune parameters, verify compliance.

### 5.9 Skill Loader (`skill-loader.ts`)
Loads skills from disk, merges frontmatter, registers skills with the system prompt builder.

---

## 6. Coordination & Multi-Agent

`packages/core/src/coordination/` is the **largest subdirectory** in core. It handles:

### 6.1 Director System (`director.ts`, ~1705 lines)
The LLM-driven orchestration layer. A `Director` manages a fleet of subagents, each with:
- Independent provider, model, context, session, budget
- Task queue with `maxConcurrent` (default 4) limit
- Per-subagent budget (`SubagentBudget`: maxIterations, maxToolCalls, maxTokens, maxCostUsd, timeoutMs)
- `AgentBridge` for parent↔subagent messaging
- Budget precedence: task > subagent > coordinator

The Director exposes 14+ tools to the model: `spawn_subagent`, `assign_task`, `await_tasks`, `ask_subagent`, `ask_result`, `roll_up`, `quality_gate`, `collab_debug`, `fleet_emit`, `fleet_status`, `work_complete`, `terminate_subagent`, `terminate_all`, `kanban_queue`.

Subagents run with worktree isolation (optional), per-subagent JSONL transcripts, and budget enforcement.

### 6.2 Multi-Agent Coordinator (`multi-agent-coordinator.ts`)
`DefaultMultiAgentCoordinator` manages a fleet of subagents with task queue, concurrency control, and event emission (`subagent.spawned`, `subagent.task_started`, `subagent.task_completed`, etc.).

### 6.3 Fleet Management (`fleet.ts`, `fleet-manager.ts`, `fleet-bus.ts`, `fleet-supervisor.ts`, `fleet-spawn.ts`)
- **Fleet roster**: 47 agent roles with phase assignments, budgets, and model routing
- **FleetManager**: holds subagents, manages lifecycle
- **FleetBus**: typed pub/sub for fleet events (usage aggregation, event distribution)
- **FleetSupervisor**: monitors subagent health, budget pressure, activity
- **Fleet spawning**: `spawn()` creates `DirectorFleetHost` instances

### 6.4 Brain System (`brain.ts`, `brain-rules.ts`, `brain-cache.ts`, `brain-monitor.ts`, `brain-ledger.ts`, `brain-telemetry.ts`, `brain-trace.ts`)
Decision-making infrastructure:
- `BrainArbiter` interface: `decide(request, ctx) → BrainDecision`
- `DefaultBrainArbiter`: configurable, composable
- `BrainRule`: regex-based pattern matching rules for auto-decisions
- `BrainDecisionCache`: LRU cache with configurable TTL
- `BrainMonitor`: watches for distress signals, enforces escalation policies
- `BrainDecisionLedger`: auditable log of all brain decisions
- `BrainTraceRecorder`: full trace recording for evaluation/replay

### 6.5 Dispatcher (`dispatcher.ts`)
`dispatchAgent` routes tasks to the best agent using an `LLMClassifier` or `scoreAgents` heuristic. Supports `DEFAULT_DISPATCH_ROLE` for fallback routing.

### 6.6 Mailbox System (SQLite IPC)

Inter-agent messaging across processes, sessions, worktrees, and machines via a **single-owner, SQLite-backed IPC architecture**:
- `SqliteMailbox` (`sqlite-mailbox.ts`) — the authoritative store; only the elected project server opens the SQLite database directly
- `MailboxProjectServer` (`mailbox-project-server.ts`, `mailbox-project-server-protocol.ts`, `mailbox-project-server-endpoint.ts`) — detached IPC server that owns `~/.wrongstack/projects/<slug>/_mailbox.sqlite`
- `RemoteMailbox` (`remote-mailbox.ts`) — client-side proxy; all production callers communicate over deterministic IPC
- `MailboxProjectServerClient` (`mailbox-project-server-client.ts`) — IPC client connection and framing
- Message types: `note`, `ask`, `assign`, `steer`, `btw`, `broadcast`, `status`, `result`, `review`, `control`
- Audience scoping: `all` vs `leaders` (hides from subagents)
- HTTP bridge (`mailbox-http-router.ts`, `mailbox-http-auth.ts`, `mailbox-http-rate-limit.ts`) for cross-machine communication
- Mailbox hooks (`mailbox-hooks.ts`) for lifecycle events
- Supporting modules: `mailbox-actions.ts`, `mailbox-events.ts`, `mailbox-health.ts`, `mailbox-message-codec.ts`, `mailbox-tool.ts`, `mailbox-types.ts`, `mailbox-credential-store.ts`, `mailbox-retention-state.ts`, `mailbox-receipt-folding.ts`, `mailbox-type-properties.ts`, `mailbox-registry-codec.ts`, `mailbox-codecs.ts`, `mailbox-parse-state.ts`, `mailbox-constants.ts`, `mailbox-status-mappers.ts`, `single-instance-mailbox.ts`, `mail-tools.ts`

The old `GlobalMailbox` and `DefaultMailbox` JSONL implementations have been removed. Production construction fails closed with no escape hatch. The architecture boundary is enforced by `packages/core/tests/architecture/mailbox-ipc-boundary.test.ts`.

### 6.7 Agent Catalog (`agents/`)
75 agent roles organized in phases:
- Phase 1: Discovery agents
- Phase 2: Planning agents
- Phase 3: Build agents (platform, meta)
- Phase 4: Verify agents
- Phase 5: Review agents
- Phase 6: Domain agents
- Phase 7: Knowledge agents
- Phase 8: Delivery agents
- Phase 9: Meta/platform-meta agents
Each agent definition includes: id, name, role, model requirements, capabilities, prompt, and budget.

### 6.8 Other Coordination Modules
- **Collab Debug** (`collab-debug.ts`): 3-agent collaborative debugging (BugHunter → RefactorPlanner → Critic)
- **Consensus Protocol** (`consensus-protocol.ts`): multi-agent consensus
- **Task DAG** (`task-dag.ts`): directed acyclic graph for task dependencies
- **Task Auctioneer** (`task-auctioneer.ts`): distributes tasks among agents
- **Worktree Task Runner** (`worktree-task-runner.ts`): Git worktree isolation for subagent tasks
- **Autonomous Coordinator** (`autonomous-coordinator.ts`): goal-driven autonomous execution
- **Change Manager** (`change-manager.ts`): tracks and manages file changes across agents
- **Knowledge Graph** (`knowledge-graph.ts`): structured fact storage and querying

---

## 7. Plugin System

`packages/core/src/plugin/` defines the plugin architecture:

### 7.1 Plugin API (`api.ts`)
`DefaultPluginAPI` provides the scoped API given to each plugin:
```ts
interface PluginAPI {
  tools: { register(tool): void; unregister(name): void };
  pipelines: { on(name): ReadonlyPipeline; register(name, mw): void };
  events: { on(event, handler): void; emit(event, data): void };
  settings: { get(key): unknown; set(key, value): void };
  container: Container;
  logger: Logger;
  config: { get<K>(key): Config[K]; set<K>(key, value): void };
}
```

### 7.2 Plugin Config (`config.ts`)
`resolvePluginConfig` validates plugin configuration against metadata. Supports diff detection, redaction, and source tracking.

### 7.3 Plugin Loader (`loader.ts`)
`loadPlugins` discovers and loads plugins from configured paths. Supports `KERNEL_API_VERSION` validation. Returns `PluginLoadFailure[]` for failed plugins. `teardown()` called on SIGINT and natural exit.

### 7.4 Built-in Plugins (core)
- **Auto Review Plugin** — automated git-tracked file change review via Chimera
- **Chimera Plugin** — post-session code quality review
- **Prompts Plugin** — prompt library management
- **Skills Plugin** — skill installation and management
- **Sync Plugin** — project state synchronization

---

## 8. Security Model

`packages/core/src/security/` implements defense-in-depth:

### 8.1 Capabilities (`capabilities.ts`)
`ToolCapabilities` enum defines well-known capabilities. `DANGEROUS_FOR_SUBAGENTS` lists capabilities restricted for subagents (bash, exec, write, edit, etc.). `WIDE_SUBAGENT_CAPABILITIES` lists capabilities allowed for wide subagent roles.

### 8.2 Permission Policy (`permission-policy.ts`, `permission-policy-schema.ts`)
`PermissionPolicy` interface with `check(tool, input, ctx) → Promise<PermissionDecision>`. Built-in implementations:
- `DefaultPermissionPolicy` — configurable per-tool permissions
- `ReadonlyPermissionPolicy` — denies all mutations
- Trust policy validation with JSON Schema (`TRUST_POLICY_JSON_SCHEMA`)

### 8.3 Secret Vault (`secret-vault.ts`)
AES-256-GCM encrypted at rest with per-machine key. `noOpVault` for environments without encryption. `RotatableSecretVault` supports key rotation.

### 8.4 Secret Scrubber (`secret-scrubber.ts`)
`DefaultSecretScrubber` redacts secrets from logs, tool output, and session data.

### 8.5 Other Security Modules
- **Trust Boundary** (`trust-boundary.ts`) — cross-agent trust enforcement
- **YOLO Risk** (`yolo-risk.ts`) — risk assessment for YOLO mode
- **Config Secrets** (`config-secrets.ts`) — encrypted config values
- **Kanban Boundary** (`kanban-boundary.ts`) — evaluates tool calls against Kanban-defined boundaries

---

## 9. Storage & Persistence

### 9.1 Persistence Package (`packages/persistence`)
**Zero-dependency** filesystem primitives. Provides:
- Atomic file writes
- JSONL reading/writing
- Directory operations
- Lock files

Used by `@wrongstack/kanban` and `@wrongstack/core`.

### 9.2 Core Storage (`packages/core/src/storage/`)
Extensive storage layer:
- **SessionStore** (`session-store.ts`) — JSONL files under `~/.wrongstack/projects/<hash>/sessions/<date>/sess_<ULID>.jsonl`
- **SessionReader** (`session-reader.ts`) — query/replay/search/export over sessions
- **ConfigStore** (`config-store.ts`) — app configuration persistence with validation
- **ConfigLoader** (`config-loader.ts`) — config loading from disk with migration support
- **Memory Backend** (`memory-backend.ts`) — memory storage backend
- **Memory Graph Backend** (`memory-graph-backend.ts`) — relationship-based memory
- **Memory Consolidator** (`memory-consolidator.ts`) — memory deduplication and merging
- **Plan Store** (`plan-store.ts`) — session-persistent plans
- **Task Store** (`task-store.ts`) — structured task persistence
- **Queue Store** (`queue-store.ts`) — task queue persistence
- **Goal Store** (`goal-store.ts`) — autonomous goal persistence
- **Director State** (`director-state.ts`) — fleet director state checkpointing
- **Tool Audit Log** (`tool-audit-log.ts`) — tool call audit trail
- **Session Event Bridge** (`session-event-bridge.ts`) — bridges session events to audit
- **Session Rewinder** (`session-rewinder.ts`) — session replay/rewind support
- **Session Analyzer** (`session-analyzer.ts`) — session data analysis
- **Cloud Sync** (`cloud-sync.ts`) — optional cloud synchronization

---

## 10. Types & Interfaces

`packages/core/src/types/` contains **~55 type definition files** defining the public contract. Key types:

| Type File | Key Exports |
|-----------|-------------|
| `tool.ts` | `Tool<I,O>`, `ToolProgressEvent`, `Permission`, `RiskTier`, `ToolIconId`, `JSONSchema` |
| `provider.ts` | `Provider`, `WireFormatConfig`, `StreamEvent`, `ProviderCapabilities` |
| `session.ts` | `SessionStore`, `SessionWriter`, `SessionEvent` |
| `config.ts` | `ConfigLoader`, `ConfigStore`, `UserConfig` |
| `memory.ts` | `MemoryPort`, `MemoryEntry`, `MemorySearchResult` |
| `plugin.ts` | `Plugin`, `PluginAPI`, `Capabilities` |
| `errors.ts` | `WrongStackError`, `ToolError`, `FetchError`, error codes |
| `multi-agent.ts` | `SubagentRunner`, `TaskSpec`, `TaskResult`, `CoordinatorStatus` |
| `compactor.ts` | `Compactor`, `CompactReport` |
| `messages.ts` | Message block types (user, assistant, tool_use, tool_result) |
| `token-counter.ts` | `TokenCounter`, `CacheStats` |
| `permission.ts` | `PermissionPolicy`, `PermissionDecision` |
| `mode.ts` | `ModeStore`, mode definitions |
| `observability.ts` | `Tracer`, `MetricsSink`, `EventBridge` |
| `tool-executor.ts` | `ToolExecutorLike`, `ToolBatchResult`, execution strategies |

---

## 11. Providers Package

`packages/providers/` provides **LLM provider adapters** built on a declarative `WireFormatConfig` system.

### 11.1 Wire Format (`wire-format.ts`, `wire-adapter.ts`)
Unified contract for defining provider wire protocols:
```ts
const config: WireFormatConfig<MyStreamState> = {
  id, family, capabilities, defaultBaseUrl,
  buildUrl, buildHeaders, buildBody,
  createStreamState, parseStreamEvent, finalizeStream,
};
```
`WireFormatProvider` consumes the config and returns a fully-wired Provider.

### 11.2 Provider Presets
- **AnthropicProvider** (`anthropic.ts`) — Claude API with prompt caching
- **OpenAIProvider** (`openai.ts`, `openai-shared.ts`) — GPT models with structured outputs
- **GoogleProvider** (`google.ts`) — Gemini models
- **OpenAICompatibleProvider** (`openai-compatible.ts`) — generic compatible endpoints
- **GitHub Copilot** (`github-copilot.ts`) — Copilot API with token refresh
- **OpenAI Codex** (`openai-codex.ts`) — Codex subscription API
- **MiniMax** (`minimax.ts`) — MiniMax models
- **Local LLM** (`presets/local-llm.ts`) — local model endpoints

### 11.3 Provider Definitions (`provider-definitions.ts`)
~140 provider definitions pulled live from models.dev API, organized by family with capabilities, pricing, and model lists.

### 11.4 OAuth (`oauth/`)
- `claude.ts` — Anthropic OAuth flow (Claude Pro/Max subscription)
- `chatgpt.ts` — OpenAI/ChatGPT OAuth flow
- `copilot.ts` — GitHub Copilot OAuth
- `oauth-refresh.ts` — automatic token refresh coordination

### 11.5 Tool Format (`tool-format/`)
Bidirectional tool format conversion: `to-anthropic`, `to-openai`, `to-responses`, `from-anthropic`, `from-openai`.

---

## 12. Tools Package

`packages/tools/` provides **59 built-in tools** — the largest individual tool collection. Each tool has a standalone file exporting the `Tool<I,O>` object.

### 12.1 Tool Architecture
Every tool implements:
```ts
interface Tool<I, O> {
  name: string;
  description: string;
  usageHint?: string;
  category?: string;
  inputSchema: JSONSchema;
  permission: 'auto' | 'confirm' | 'deny';
  mutating: boolean;
  riskTier?: 'safe' | 'standard' | 'destructive';
  capabilities?: readonly string[];
  execute(input, ctx, opts): Promise<O>;
  executeStream?(input, ctx, opts): AsyncIterable<ToolStreamEvent<O>>;
  cleanup?(input, ctx): Promise<void>;
}
```

### 12.2 Tool Categories

**Filesystem:** `read`, `write`, `edit`, `replace`, `glob`, `grep`, `tree`, `diff`, `patch`

**Shell:** `bash`, `exec`, `spawn-background`

**Network:** `fetch`, `search`

**Code Quality:** `lint`, `format`, `typecheck`, `test`, `document`, `scaffold`, `e2e`

**Package Management:** `install`, `audit`, `outdated`

**Source Control:** `git`

**Session Management:** `todo`, `plan`, `task`, `skill`, `mode`, `memory`, `kanban`, `session-kanban`

**Meta:** `tool-search`, `tool-use`, `tool-help`, `batch-tool-use`, `next-steps`, `tool-summary`, `tool-diff`, `tool-icons`, `tool-tier`, `ps-slash`, `auto-proceed-loop-guard`

**Code Intelligence:** `codebase-index`, `codebase-search`, `codebase-stats` (with parsers for TS, JS, Go, Rust, Python, YAML, JSON)

**Browser:** Full Playwright-based browser automation (`browser_open`, `navigate`, `snapshot`, `screenshot`, `click`, `type`, `select`, `evaluate`, `upload`, etc.)

**Languages:** Multi-language detection + execution profiles for TypeScript, JavaScript, Go, Rust, PHP, C#, Python, Java, etc.

**Configuration:** `set-working-dir`, `design`

### 12.3 Browser Module (`browser/`)
Full isolation with network guard proxy, security validation, artifact management, and Playwright browser lifecycle.

### 12.4 Codebase Index (`codebase-index/`)
SQLite-backed BM25 full-text search index. Workers for parallel indexing. Language-specific parsers (TS, JS, Go, Rust, Python, JSON, YAML). Background indexing with circuit breaker.

### 12.5 Languages Module (`languages/`)
Detects language workspaces, profiles for each language (primary and additional), and executes predefined operations (syntax check, semantic check, lint, format, test, compile, build, run, debug, package install/add/remove/update/audit/outdated).

---

## 13. Plugins Package

`packages/plugins/` provides **63 first-party plugin modules** organized as individual directories under `src/`. Each exports a Plugin implementation.

### 13.1 Plugin Catalog

| Plugin | Purpose |
|--------|---------|
| `git-autocommit` | AI-generated conventional commits |
| `semver-bump` | Version bumping from conventional commits |
| `cron` | Recurring task scheduling |
| `secret-scanner` | Credential detection in code |
| `todo-tracker` | Persistent todo list management |
| `lint-gate` | Pre-commit lint enforcement |
| `type-gate` | Pre-commit typecheck enforcement |
| `test-runner-gate` | Pre-commit test execution |
| `test-coverage-gate` | Coverage threshold enforcement |
| `branch-guard` | Branch protection rules |
| `commit-validator` | Commit message format validation |
| `format-on-save` | Auto-format on file save |
| `import-organizer` | Auto-organize imports |
| `diff-summary` | AI-generated diff summaries |
| `injection-shield` | Prompt injection detection |
| `prompt-firewall` | Prompt pattern blocking |
| `loop-breaker` | Detection of agent looping behavior |
| `process-guard` | Kill command protection |
| `dep-guard` | Dependency allow/deny lists |
| `config-validator` | Configuration validation |
| `error-lens` | Error analysis and display |
| `knowledge-graph` | Structured fact storage |
| `context-pins` | Pinned context facts |
| `cost-tracker` | Token/usage cost tracking |
| `file-watcher` | File change monitoring |
| `notify-hub` | Cross-channel notifications |
| `checkpoint` | Session checkpointing |
| `token-budget` | Per-session token budgets |
| `token-throttle` | Token rate limiting |
| `model-router` | Model selection routing |
| `plugin-stack-observer` | Plugin load order observation |
| `dead-code-detector` | Unused code detection |
| `duplicate-code-detector` | Code duplication detection |
| `code-metrics` | Code complexity metrics |
| `refactor-suggester` | AI refactoring suggestions |
| `test-generator` | Automated test generation |
| `migration-planner` | Code migration planning |
| `pr-drafter` | Automatic PR drafting |
| `release-notes-generator` | Release note generation |
| `changelog-writer` | Changelog management |
| `smart-rename` | Intelligent symbol renaming |
| `auto-doc` | Automatic documentation generation |
| `shell-check` | Shell script validation |
| `template-engine` | Code templating |
| `spec-linker` | Spec-to-code linking |
| `session-recap` | Session summary generation |
| `auto-escalate` | Automatic issue escalation |
| `llm-cache` | LLM response caching |
| `feature-flag-tracker` | Feature flag management |
| `interface-contract-guard` | Interface compliance checking |
| `api-compatibility-gate` | API compatibility verification |
| `schema-evolution-guard` | Schema migration safety |
| `performance-regression-gate` | Performance regression detection |
| `test-flake-detector` | Flaky test identification |
| `license-audit-gate` | License compliance checking |
| `accessibility-auditor` | Accessibility issue detection |
| `security-hotspot-scanner` | Security hotspot identification |
| `dependency-vulnerability-gate` | Vulnerability scanning |
| `doc-sync-guard` | Documentation sync verification |
| `auto-i18n-extractor` | i18n string extraction |
| `semantic-search-indexer` | Semantic code search indexing |
| `agent-handoff` | Inter-agent handoff |
| `audit` | Session audit logging |

### 13.2 Plugin Factory (`factories/index.ts`)
Standard plugin factory functions used to create consistent plugin wrappers.

### 13.3 Manifest (`manifest/index.ts`)
Plugin manifest generation and metadata management.

---

## 14. CLI Package

`packages/cli/` is the **assembly layer** — the biggest package (~250 source files) that wires everything together.

### 14.1 Boot Sequence (`cli-main.ts`, `boot.ts`, `boot-config.ts`)
1. Parse argv → flags + positional (`arg-parser.ts`)
2. `bootConfig(flags)` — resolve paths, create vault, migrate secrets, load config (`config-doctor.ts`)
3. Subcommand dispatch if first positional matches (`subcommands/`)
4. Pre-launch prompts on interactive TTY (`pre-launch/`): project check, mode, YOLO
5. Wire container with all DI tokens (`boot/container-wiring.ts`)
6. Wire registries: tools, providers, slash commands, plugins (`wiring/`)
7. Wire pipelines, system prompt builder, MCP registry, multi-agent coordinator
8. Launch: `runRepl(...)` (readline-based) or `runTui(...)` (Ink/React) or dispatch to WebUI/desktop/HQ

### 14.2 Execution Modes (`execution.ts`, `execution-mode.ts`)
Determines which surface to launch: REPL, TUI, WebUI, SimpleUI, Desktop, HQ, or single-shot command.

### 14.3 Slash Commands (`slash-commands/`)
**~75 slash command handlers** organized as individual files. Slash commands are the primary user interaction mechanism in the REPL/TUI:
`/help`, `/model`, `/mode`, `/settings`, `/project`, `/session`, `/todos`, `/tasks`, `/plan`, `/goal`, `/kanban`, `/sdd`, `/memory`, `/git`, `/init`, `/auth`, `/mcp`, `/plugin`, `/fix`, `/review`, `/audit`, `/security`, `/techstack`, `/fleet`, `/collab`, `/delegate`, `/spawn-agents`, `/compact`, `/prune`, `/context`, `/clear`, `/exit`, `/rewind`, `/worktree`, `/design`, `/telegram`, `/mailbox`, `/hq`, `/health`, `/metrics`, `/diag-stats`, `/doctor`, `/enhance`, `/refiner`, `/suggest`, `/next`, `/tuneup`, `/yolo`, `/surfaces`, `/coordinator`, `/supervisor`, `/shadow`, `/btw`, `/brain`, `/interrupt`, `/sync`, `/statusline`, `/f-keys`, `/models`, `/setmodel`, `/modelcaps`, `/server`, `/version`, `/update`, `/tools`, `/skills`, `/prompts`, `/fallback`, `/dev`, `/browser`, `/worktree`, and more.

Each slash command handler receives a `CommandContext` with access to the container, agent, and IO.

### 14.4 Wiring Modules (`wiring/`)
25+ wiring files that bind together the system at boot:
- `plugins.ts` — plugin loading lifecycle
- `tools.ts` — tool registration
- `provider.ts`, `provider-runtime.ts` — provider setup
- `pipeline.ts` — pipeline middleware configuration
- `session.ts` — session lifecycle wiring
- `slash-commands.ts` — slash command registration
- `controllers.ts` — runtime controllers
- `metrics.ts` — observability wiring
- `director-setup.ts` — director/fleet wiring
- `sdd-handlers.ts` — SDD integration
- `sage.ts` — memory backend wiring
- `mailbox-bridge-bootstrap.ts` — mailbox bridge startup
- `brain-and-orchestration.ts` — Brain/autonomy wiring

### 14.5 WebUI Server Integration (`webui-server/`)
17 modules that bridge the CLI with the webui-server:
- `lifecycle.ts` — server lifecycle management
- `connection-handler.ts` — WebSocket connection handling
- `setup-events.ts` — event projection for WebUI
- `provider-config.ts` — provider configuration for WebUI
- `stream-coalescer.ts` — stream event coalescing
- `session-start-payload.ts` — session initialization payload
- `privileged-actions.ts` — privileged WebUI operations
- `kanban-run-mirror.ts`, `kanban-supervisor.ts`, `kanban-host-adapter.ts` — Kanban integration
- `static-serve.ts` — static file serving
- `client-registration.ts` — client identity management

### 14.6 HQ Server (`hq-server/`)
Cross-machine command center backend:
- `startup.ts` — HQ server bootstrap
- `routes.ts` — HTTP route definitions
- `ws.ts` — WebSocket handler
- `auth.ts`, `auth-state.ts` — authentication
- `snapshot.ts` — state snapshot generation
- `audit-actor.ts` — audit logging

### 14.7 Auth Menu (`auth-menu/`)
Interactive provider authentication with multiple flows:
- Top menu, provider menu, OAuth menu
- Anthropic OAuth, GitHub Copilot OAuth, OpenAI Codex OAuth
- Local API key entry, direct config
- Loopback server for OAuth callbacks

### 14.8 SDD Services (`services/sdd/`)
- `project-context.ts` — SDD project context loading
- `spec-detection.ts` — automatic spec detection
- `task-manager.ts` — SDD task management

---

## 15. MCP Integration

### 15.1 Core MCP (`packages/mcp`)
The Model Context Protocol client and registry:
- **Three transports**: `stdio` (child process), `sse` (server-sent events), `streamable-http` (session-based NDJSON)
- **JSON-RPC 2.0** protocol implementation
- **MCPClient** — full client lifecycle (connect, list tools, call tool, disconnect)
- **MCPRegistry** — manages fleet of clients with:
  - Exponential backoff + jitter on reconnect (max 5 cycles, then `failed` state)
  - Tool-list cache invalidation on `notifications/tools/list_changed`
  - Tool namespace prefix: `mcp__<serverName>__`
- **StdioTransport**, **SSETransport**, **StreamableHTTPTransport**

### 15.2 Infrastructure MCP Servers (`packages/core/src/infrastructure/mcp-servers.ts`)
Built-in MCP server presets (all disabled by default):
filesystem, github, context7, brave-search, block, everart, slack, aws, google-maps, sentinel, zai-vision, minimax-vision.

### 15.3 Core MCP Tools (`packages/core/src/tools/`)
- `mcp-control.ts` — `MCPControlTool` for managing server lifecycle (list, search, enable, disable, restart, activate, deactivate)
- `mcp-use.ts` — `McpUseTool` for calling MCP tools with lazy activation

---

## 16. UI Surfaces

### 16.1 TUI — Terminal UI (`packages/tui`)
Ink + React 19, ~135 source files.

**Architecture:** React component tree rendered via Ink 7 in the terminal. Communicates with the core runtime via EventBus subscriptions.

**Key components:**
- `app.tsx` — root component with key handling and panel management
- `app-reducer.ts` — state machine for UI state
- `history.tsx` — conversation history with scrollback
- `input.tsx` — multi-line input with paste handling
- `status-bar.tsx` — live model/tokens/cost/tool status
- `components/` — ~85 React components organized by feature

**Panels (side/modal):**
- `history-panel`, `slash-menu`, `model-picker`, `mode-picker`
- `settings-picker`, `project-picker`, `file-picker`, `mcp-picker`, `plugin-picker`, `prompt-picker`
- `help-overlay`, `help-panel`
- `fleet-monitor`, `fleet-panel`, `agents-monitor`
- `brain-panel`, `brain-decision-prompt`
- `kanban-panel`, `goal-panel`, `goal-kanban-panel`, `phase-panel`, `plan-panel`
- `sdd-board-overlay`, `checkpoint-timeline`
- `coordinator-panel`, `shadow-panel`, `audit-panel`
- `queue-panel`, `todos-monitor`, `memory-context-widget`
- `auth-panel`, `lifecycle-panel`
- `context-panel`, `enhance-panel`, `refine-failure-panel`
- `worktree-monitor`, `worktree-panel`, `process-list`
- `composer-status-chip`, `live-activity-strip`, `powerline-rail`
- `shell-command-warning`, `confirm-prompt`, `esc-confirm-prompt`

**Hooks (~36):** `use-tui-event-bridge`, `use-tui-slash-commands`, `use-app-picker-keys`, `use-autonomous-coordinator`, `use-brain-events`, `use-director-fleet-bridge`, `use-paste-handling`, `use-input-history-persistence`, `use-live-todos`, `use-interrupt-ladder`, `use-statusbar-view-model`, `use-stream-chip-expiration`, `use-subagent-events`, `use-terminal-render-lifecycle`, `use-token-counter-refresh`, etc.

**Reducers:** activity, composer, conversation, dialogs, fleet, panel-pickers, settings-panel, settings-values, workspace-panels.

### 16.2 WebUI — Browser Frontend (`packages/webui`)
Vite 8 + React 19 + Tailwind 4 + Zustand + i18next, ~199 source files.

**Architecture:** Single-page application communicating with the backend via WebSocket (`ws-client.ts`). Zustand stores for state management.

**Key components (100+):**
- `App.tsx` — root with routing and layout
- `ChatView.tsx` — main conversation interface
- `ChatInput.tsx` — message composition with mentions, file picker
- `MessageBubble.tsx` — streaming message rendering with Markdown
- `InspectorPanel.tsx` — detailed tool call inspection
- `FleetMonitor.tsx` — multi-agent visualization
- `KanbanView.tsx` — kanban board UI
- `SddHub.tsx`, `SddBoardView.tsx`, `SddFlowGraph.tsx`, `SddWizard.tsx` — SDD workflow
- `GoalPanel.tsx`, `GoalView.tsx` — autonomous goal tracking
- `SettingsPanel.tsx` — full settings management
- `TerminalPanel.tsx` — integrated terminal (xterm.js + node-pty)
- `FileExplorer.tsx` — file browsing
- `DiffView.tsx`, `MonacoDiffView.tsx` — diff visualization
- `CodeEditor.tsx` — Monaco editor integration
- `WorktreeGraph.tsx`, `WorktreeLanes.tsx` — worktree visualization
- `MailboxPanel.tsx` — inter-agent mailbox UI
- `MemoryManager.tsx` — memory management
- `CronJobsPanel.tsx` — cron job management
- `AgentOfficeView.tsx` — office map visualization
- `BoardView.tsx`, `TaskBoard.tsx` — task board views
- `DebugDashboard.tsx`, `AnalyticsDashboard.tsx`, `WorkDashboard.tsx` — dashboards
- `SetupScreen.tsx` — initial provider setup

**Stores (Zustand, ~30):** chat-store, config-store, session-store, fleet-store, kanban-store, mailbox-store, file-store, history-store, goal-store, goal-run-store, sdd-board-store, sdd-wizard-store, ui-store, memory-lifecycle-store, techstack-store, etc.

**i18n:** Internationalization with i18next, resource loading from locales.

### 16.3 WebUI Server (`packages/webui-server`)
~139 source files. The shared HTTP/WebSocket backend that powers `wstack --webui`.

**Architecture:** Decomposed from a single ~2954-line god module into 11 focused modules plus handlers:

**Core modules:**
- `start-webui.ts` — server lifecycle orchestration (boot → pre-context services → agent services → routes → dispatcher → connection handler → server runtime)
- `pre-context-services.ts` — registries, stores, system prompt, provider
- `backend-services.ts` — pipelines, compaction, agent, Brain, WS handlers
- `routes.ts` — 13 route records (conversation, session, project, provider, kanban, goal, memory, etc.)
- `message-dispatcher.ts` — WebSocket message dispatch (`switch(msg.type)` with runLock)
- `server-runtime.ts` — WS/HTTP/shutdown + port resolution
- `connection-handler.ts` — WS connection lifecycle + F5 replay
- `setup-screen.ts` — provider resolution ladder

**Handlers (~40):** conversation-operations, session-handlers, project-handlers, provider-handlers, memory-handlers, kanban-routes, goal-handlers, brain-handlers, mode-handlers, file-handlers, git-handlers, mcp-handlers, mailbox-handlers, prefs-handlers, process-handlers, techstack-handlers, sdd-board-routes, sdd-wizard-routes, worktree-routes, collaboration-ws, terminal-ws, etc.

**Protocol (`protocol/`):** TypeScript types and decoders for the WS protocol:
- `client-conversation.ts`, `client-integrations.ts`, `client-operations.ts`, `client-workspace.ts`
- `server-conversation.ts`, `server-integrations.ts`, `server-operations.ts`, `server-workspace.ts`
- `connection-fsm.ts` — connection state machine
- `registry.ts` — protocol type registry
- `projections.ts` — event projections

### 16.4 SimpleUI (`packages/simpleui`)
A deliberately minimal browser chat surface. Vite + React, with:
- Markdown rendering via react-markdown + rehype-pretty-code + shiki
- WebSocket connection to webui-server
- Minimal component tree focused on chat

### 16.5 HQ Command Center (`packages/webui-hq`)
Offline React app for the cross-machine coordination surface (port 3499). Features:
- Agent fleet monitoring across machines
- Session aggregation
- Mailbox state viewer
- Cost tracking
- Worktree management
- Brain decision visualization
- Project switching

---

## 17. Specialized Packages

### 17.1 Kanban (`packages/kanban`)
Standalone, project-scoped multi-kanban service with a single IPC owner and SQLite persistence. Depends only on `@wrongstack/persistence`. Provides:
- CRUD operations on boards, columns, tasks
- Managed cards with lifecycle transitions (Backlog → Todo → Running → Review → Done)
- Task assignment, dependencies, recovery
- Queue health monitoring
- Goal/metric tracking
- Split/merge/copy/transfer operations
- Event emission and change tracking

### 17.2 SDD — Spec-Driven Development (`packages/sdd`)
SDD workflow engine extracted from core. Provides:
- Task graph generation from specs
- Task tracking with dependency resolution
- Lifecycle management (given/when/then acceptance criteria)
- AI-driven spec building
- Phase management

### 17.3 Security Scanner (`packages/security-scanner`)
Standalone security scanning surface. Provides:
- Tech-stack detector (cross-language dependency intelligence)
- Secret scanner (credential/regex pattern detection)
- Report generator
- Interactive slash-command for on-demand security scans

### 17.4 SAGE (`packages/sage`)
Project-local memory system:
- SQLite-backed storage
- Graph-ready anchors (file, symbol, command)
- Lexical/tag/path/anchor search
- Memory hygiene primitives (status: active/pending/archived/deleted)
- Categorization (fact, decision, convention, preference, reference, anti_pattern, etc.)

### 17.5 TechStack (`packages/techstack`)
Cross-language dependency intelligence for the active target project:
- Discover, inventory, enrich, analyze, and report dependencies
- Ecosystem-specific logic (npm, pip, cargo, go, nuget, etc.)
- Version checking against registries
- Outdated dependency detection

### 17.6 ACP — Agent Client Protocol (`packages/acp`)
Integration with the Agent Client Protocol standard:
- **ACP Client** — connects to external ACP-compatible agents
- **ACP Agent** — exposes WrongStack as an ACP agent
- **SDK integration** — wraps the `@agentclientprotocol/sdk`
- **V1 protocol** — ACP v1 protocol implementation
- **Legacy support** — backward compatibility layer

### 17.7 Plug-LSP (`packages/plug-lsp`)
LSP bridge + language tooling plugin:
- **codebase-lsp-search** — LSP-powered code search
- **codebase-index** — symbol indexing (SQLite + per-language parsers)
- **auto-doc** — automatic documentation generation (TS, Rust, Go, Python, Shell parsers)
- LSP setup script (`wrongstack-lsp-setup`)

### 17.8 Telegram Bridge (`packages/telegram`)
Plugin that bridges WrongStack with Telegram:
- Send messages, receive prompts, get notifications
- Approval prompts via inline buttons
- Read incoming messages

### 17.9 Runtime (`packages/runtime`)
Default runtime implementations and host-level composition helpers:
- Vision support
- Clipboard access
- Host environment probing
- Tool registration helpers
- Pack module

### 17.10 Bench (`packages/bench`)
Model-independent agentic benchmark harness:
- Aider polyglot benchmark support
- SWE-bench Verified integration
- Deterministic graders
- Harness fingerprinting
- Benchmark result recording and reporting

---

## 18. Applications

### 18.1 wrongstack / wstack (`apps/wrongstack`)
The published npm entry shim. Thin re-export of `@wrongstack/cli`. Provides both `wstack` and `wrongstack` binaries.

### 18.2 Desktop (`apps/desktop`)
Electron shell for managing multiple local WrongStack runtimes. Depends on `@wrongstack/webui` and `@wrongstack/webui-server`. Uses Electron 43 for the desktop window, manages the runtime lifecycle, and provides a graphical interface for managing multiple sessions.

---

## 19. Observability & Instrumentation

`packages/core/src/observability/` provides **opt-in** three-pillar observability:

| Pillar | Interface | Default | Activation |
|--------|-----------|---------|------------|
| Metrics | `MetricsSink` | `NoopMetricsSink` | `--metrics` CLI flag |
| Traces | `Tracer` | `NoopTracer` | Wire a real `OTelTracer` |
| Health | `HealthRegistry` | `DefaultHealthRegistry` | `--metrics` enables it |

**Prometheus:** `--metrics-port 9090` starts HTTP on `127.0.0.1` exposing `/metrics`. OTLP exporters available via `startOtlpMetricsExporter` / `startOtlpTraceExporter`.

**Tracing:** `Agent.run` opens an `agent.run` span; per-iteration `agent.iteration` and `provider.complete` spans nest inside. Tool spans opened by ToolExecutor.

**Key modules:**
- `otel-tracer.ts` — OpenTelemetry tracer implementation
- `otlp-metrics.ts`, `otlp-traces.ts` — OTLP exporters
- `prometheus.ts` — Prometheus scrape endpoint
- `network-telemetry.ts`, `process-telemetry.ts` — automatic tool wrappers
- `redact-command.ts` — command redaction for metrics
- `event-bridge.ts` — event-to-metric bridging

---

## 20. Scripts & DevOps

### 20.1 Build System
`scripts/build.mjs` — orchestrated monorepo build with dependency ordering. `scripts/build-package.mjs` — per-package esbuild. Supports incremental builds, caching, and skip-if-workspace-build.

### 20.2 CI/Quality Scripts
- `check-architecture-health.mjs` — architecture boundary enforcement
- `check-build-lineage.mjs` — build artifact integrity verification
- `check-test-inventory.mjs` — test coverage tracking
- `check-test-skips.mjs` — skip budget enforcement
- `check-test-typecheck.mjs` — test type safety
- `check-package-contracts.mjs` — package exports validation
- `check-file-size.mjs` — file size limits
- `check-i18n-completeness.mjs` — i18n coverage
- `lint-distributive-types.mjs` — type distribution linting
- `lint-console-logging.mjs` — console.log linting
- `snapshot-core-public-api.mjs` — public API snapshot generation

### 20.3 Release Pipeline
`release:check` runs: audit → build → provider catalog → plugin manifest → package contracts → build manifest → architecture health → test inventory → test skips → test types → node-pty check → i18n → typecheck → test. Then `release` publishes with `pnpm publish -r`.

### 20.4 Security
- `install-mailbox-bridge-skills.sh` — mailbox bridge setup
- `sync-models.mjs` — model/version synchronization
- `guard-mailbox-bridge.mjs`, `guard-unresolved-imports.mjs`, `guard-against-corruption.mjs` — integrity guards
- `generate-provider-catalog.mjs`, `generate-plugin-projections.mjs` — catalog generation

---

## 21. Architecture Summary & Key Patterns

### 21.1 Layered Architecture
```
apps (wrongstack, desktop)
    ↓ depends on
packages (tui, webui, webui-server, cli, plugins)  → product-facing
    ↓ depends on
packages (providers, tools, sdd, security-scanner, sage, mcp, acp, plug-lsp, techstack, telegram, runtime, bench)  → domain packages
    ↓ depends on
packages/core  → THE KERNEL (container, pipeline, event bus, agent, coordination, storage)
    ↓ depends on
packages/kanban, packages/persistence  → lowest layer (no WrongStack dependency)
```

### 21.2 Key Design Patterns

1. **Dependency Injection via Container**: Typed `Token<T>` DI with `Symbol.for()` for resilience. Every subsystem is swappable at boot.

2. **Middleware Pipeline**: Koa-style pipelines for userInput, request, response, assistantOutput, toolCall, and contextWindow. Plugins can hook into any stage.

3. **Event-Driven Architecture**: EventBus with 20+ event types. Every runtime moment fires an event. UI surfaces subscribe independently — no coupling between runtime and presentation.

4. **Plugin System**: Capability-declaring plugins receive a scoped API. Teardown on SIGINT/exit. `capabilities` field ensures declared vs actual usage consistency.

5. **Brain-Gated Autonomy**: Tiered decision system (deterministic → LLM → human escalation) for high-risk operations. Rules, cache, ledger, monitor, and trace subsystems compose modularly.

6. **Multi-Agent Director**: LLM-driven orchestration with per-subagent budgets, worktree isolation, and full audit trails. 47 agent roles with phase-based organization.

7. **Streaming Tools**: `executeStream` yields typed progress events (`log`, `partial_output`, `metric`, `file_changed`, `warning`) → published on EventBus → consumed by all UI surfaces uniformly.

8. **Inter-Agent SQLite Mailbox**: Single-owner, SQLite-backed IPC messaging across processes, sessions, worktrees, and machines. All production callers use `RemoteMailbox` over deterministic IPC. The old GlobalMailbox/JSONL architecture was removed. HTTP bridge (`mailbox-http-router.ts`) for cross-machine communication. Type-safe with audience scoping. Enforced by `mailbox-ipc-boundary.test.ts`.

9. **Two-Layer Compaction**: `SelectiveCompactor` (preserves critical messages) + `IntelligentCompactor` (LLM summarization) compose in `HybridCompactor`. Policy-driven with four modes.

10. **Surface Independence**: TUI, WebUI, SimpleUI, HQ, Desktop all consume the same EventBus events and WS protocol — no surface-specific backend coupling.

### 21.3 Test Coverage
- **Root Vitest**: forks pool, 60s timeouts, 25% max workers
- **Coverage targets**: 74% lines, 73% functions, 64% branches, 73% statements
- **Separate runs**: WebUI tests (jsdom environment), HQ dashboard tests
- **E2E**: Playwright with full test suite for WebUI flows
- Architecture boundary tests enforce package DAG
- 470+ coverage enhancement tests (kanban 95%, techstack 84%, sage 82%, sdd 90%, plug-lsp 84%)

---

*Report generated from direct analysis of ~630 source files across 17 packages and 2 apps, architecture documentation, package manifests, and type definitions.*

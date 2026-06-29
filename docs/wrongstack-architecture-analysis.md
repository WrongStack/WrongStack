# WrongStack In-Depth Architecture Analysis Report

> This report analyzes all critical subsystems of the WrongStack monorepo layer by layer.

---

## 1. Project Structure

WrongStack is a monorepo managed with **pnpm workspaces**. Main packages:

```
WrongStack/
├── packages/
│   ├── core/         → Agent core, kernel, coordination, tool system
│   ├── cli/          → REPL, slash commands, user interface
│   ├── providers/    → Anthropic, OpenAI, Google adapters
│   └── tui/          → Terminal UI (Ink-based React)
├── .wrongstack/      → Project-level skills, settings
├── pnpm-workspace.yaml
└── package.json
```

---

## 2. Kernel Layer

The kernel provides the infrastructure services that all upper layers depend on.

### 2.1 Container (`kernel/container.ts`) — Dependency Injection

**Purpose:** Type-safe DI container. Service lifecycle management via `bind`, `override`, `decorate`.

**Design decisions:**
- **bind()** — Throws if token is already bound (duplicate registration protection)
- **override()** — Throws if token is not bound (mistaken override protection)
- **decorate()** — Stacks decorators; cache is cleared when a new decorator is added
- **Circular dependency detection:** The `resolving` Set catches A→B→A cycles as structured errors instead of "Maximum call stack size exceeded"

```typescript
class Container {
  bind<T>(token: Token<T>, factory: Factory<T>, opts?: BindOptions): void
  override<T>(token: Token<T>, factory: Factory<T>, opts?: BindOptions): void
  decorate<T>(token: Token<T>, decorator: Decorator<T>, owner?: string): void
  resolve<T>(token: Token<T>): T
  safeResolve<T>(token: Token<T>): T | undefined
  has(token: Token<unknown>): boolean
}
```

**Singleton by default:** Every binding defaults to singleton (`opts.singleton ?? true`). This ensures providers, loggers, etc. are shared as single instances.

### 2.2 Tokens (`kernel/tokens.ts`)

Container tokens are defined as a central object:

```typescript
export const TOKENS = {
  Logger: t<Logger>('Logger'),
  TokenCounter: t<TokenCounter>('TokenCounter'),
  SessionStore: t<SessionStore>('SessionStore'),
  MemoryStore: t<MemoryStore>('MemoryStore'),
  PermissionPolicy: t<PermissionPolicy>('PermissionPolicy'),
  Compactor: t<Compactor>('Compactor'),
  PathResolver: t<PathResolver>('PathResolver'),
  ConfigLoader: t<ConfigLoader>('ConfigLoader'),
  ConfigStore: t<ConfigStore>('ConfigStore'),
  Renderer: t<Renderer>('Renderer'),
  InputReader: t<InputReader>('InputReader'),
  ErrorHandler: t<ErrorHandler>('ErrorHandler'),
  RetryPolicy: t<RetryPolicy>('RetryPolicy'),
  SkillLoader: t<SkillLoader>('SkillLoader'),
  SystemPromptBuilder: t<SystemPromptBuilder>('SystemPromptBuilder'),
  SecretScrubber: t<SecretScrubber>('SecretScrubber'),
  ModelsRegistry: t<ModelsRegistry>('ModelsRegistry'),
  ModeStore: t<ModeStore>('ModeStore'),
  ProviderRunner: t<ProviderRunner>('ProviderRunner'),
  WorktreeManager: t<WorktreeManager>('WorktreeManager'),
  BrainArbiter: t<BrainArbiter>('BrainArbiter'),
  HookRegistry: t<HookRegistry>('HookRegistry'),
} as const;
```

Every token is symbol-based and provides compile-time type safety.

### 2.3 EventBus (`kernel/events.ts`) — Type-Safe Event Bus

**Observer-only** design: subscribers cannot modify or cancel events. Subscriber errors are caught.

EventMap defines all system events in a type-safe manner:

| Event Category | Example Events |
|---|---|
| **Brain** | `brain.decision_requested`, `brain.decision_answered`, `brain.decision_ask_human` |
| **Session** | `session.started`, `session.ended`, `session.damaged` |
| **Iteration** | `iteration.started`, `iteration.completed`, `iteration.limit_reached` |
| **Provider** | `provider.response`, `provider.text_delta`, `provider.thinking_delta`, `provider.tool_use_start/stop`, `provider.stream_error`, `provider.retry`, `provider.error`, `provider.fallback` |
| **Tool** | `tool.started`, `tool.progress`, `tool.executed`, `tool.needs_confirmation`, `tool.confirmed`, `tool.denied`, `tool.error` |
| **Memory** | `memory.remembered`, `memory.forgotten`, `memory.cleared`, `memory.consolidated` |
| **Compaction** | `compaction.completed`, `compaction.error` |
| **Context** | `context.changed`, `context.tokens_updated` |
| **Multi-Agent** | `subagent.spawned`, `subagent.task_assigned`, `subagent.task_completed`, `subagent.stopped` |
| **Autonomous** | `autonomous.triggered`, `autonomous.aborted` |

**Key takeaway:** EventBus is the nervous system of the application. All components (Agent, TUI, Session, Memory, Tools) communicate through this bus. The type-safe EventMap catches event name/payload errors at compile time.

### 2.4 RunController (`kernel/run-controller.ts`)

Manages the abort + cleanup lifecycle of a single agent run:

- **Abort signal:** Cooperative cancellation via `signal`
- **Parent signal propagation:** If the parent run is aborted, the child is aborted too
- **Cleanup hooks:** `onAbort(fn)` registers cleanup functions that run in LIFO order (last registered runs first)
- **Idempotent:** `dispose()` can be called multiple times; hooks run only once
- **Error isolation:** Even if one hook throws, the others still run; errors are sent to `errorSink`

---

## 3. Agent Core

### 3.1 Agent Class (`core/agent.ts`)

The Agent is the orchestrator at the center of the entire system:

```typescript
class Agent {
  readonly container: Container;
  readonly tools: ToolRegistry;
  readonly providers: ProviderRegistry;
  readonly events: EventBus;
  readonly pipelines: AgentPipelines;
  readonly ctx: Context;
  readonly maxIterations: number;
  readonly executionStrategy: 'parallel' | 'sequential' | 'smart';
  readonly perIterationOutputCapBytes: number;
  readonly toolExecutor: ToolExecutorLike;
  readonly extensions: ExtensionRegistry;
  
  // Handler delegation
  private readonly _toolHandler: AgentToolHandler;
  private readonly _responseHandler: AgentResponseHandler;
  private readonly _loopHandler: AgentLoopHandler;
}
```

**Design principle:** The Agent delegates work to three separate handlers:
1. **AgentLoopHandler** — Iteration loop, continue logic
2. **AgentResponseHandler** — Processing provider responses (text, tool_use, thinking blocks)
3. **AgentToolHandler** — Tool batch execution, permission, error handling

**`run()` method flow:**
1. Create `RunController`, wire up abort signal
2. Refresh `ctx.tools` from registry (MCP/plugin tools may register later)
3. Start tracer span
4. Normalize input
5. Run extensions (`runBeforeRun`)
6. Start the main loop via `_loopHandler.runInner()`
7. Run extensions (`runAfterRun`)
8. On error: wrap with `AgentError`, emit event
9. Finally: close span, dispose controller

**Key insight:** The line `this.ctx.tools = this.tools.list()` is critical — when Context is constructed, MCP/plugin tools may not yet be registered. Without this refresh, `tool_search` would report zero tools.

---

## 4. Coordination Layer

### 4.1 Multi-Agent Coordinator (`coordination/multi-agent-coordinator.ts`)

A **1006-line** massive file — the heart of the subagent lifecycle.

**Core data structures:**
```typescript
interface SubagentEntry {
  config: SubagentConfig;
  context: SubagentContext;
  status: 'running' | 'idle' | 'stopped' | 'error';
  currentTask?: string;
  abortController: AbortController;
  activeBudget?: SubagentBudget;
}

class DefaultMultiAgentCoordinator {
  private readonly subagents = new Map<string, SubagentEntry>();
  private readonly usedNicknames = new Set<string>();
  private readonly terminating = new Set<string>();
  private pendingTasks: TaskSpec[] = [];
  private completedResults: TaskResult[];
  private static readonly MAX_COMPLETED_RESULTS = 10_000;
}
```

**Nickname system:** Each subagent is assigned a memorable name like `einstein`, `tesla`. The `usedNicknames` Set prevents two subagents from receiving the same name.

**Terminating Set:** Prevents the `assign+terminate` race condition — a subagent being terminated cannot receive new tasks.

### 4.2 FleetBus (`coordination/fleet-bus.ts`)

Fleet-wide fan-in event bus. Each subagent's own EventBus is plugged in via `attach()`:

```typescript
class FleetBus {
  private readonly byId = new Map<string, Set<FleetHandler>>();
  private readonly byType = new Map<string, Set<FleetHandler>>();
  private readonly any = new Set<FleetHandler>();
  
  attach(subagentId: string, bus: EventBus, taskId?: string): () => void;
  subscribe(subagentId: string, handler: FleetHandler): () => void;
  filter(type: string, handler: FleetHandler): () => void;
  onAny(handler: FleetHandler): () => void;
}
```

**Three subscription modes:**
1. `subscribe(id, handler)` — All events from a single subagent
2. `filter(type, handler)` — One event type across the entire fleet
3. `onAny(handler)` — Everything

**Key design:** `subagent.*` events are filtered out — they originate from MultiAgentHost, not from the subagent's own bus. Duplicate prevention.

### 4.3 Brain (`coordination/brain.ts`)

Decision-making authority layer. Human > Brain > Director/Leader hierarchy:

```typescript
type BrainDecision =
  | { type: 'answer'; optionId?: string; text: string; rationale?: string }
  | { type: 'ask_human'; prompt: string; options?: BrainDecisionOption[] }
  | { type: 'deny'; reason: string };
```

**`ObservableBrainArbiter`:** A decorator that publishes every decision on the EventBus. The TUI renders decisions via the `brain.decision_answered` event — not coupled directly to Brain.

**`BrainDecisionQueue`:** Bridge between `ask_human` decisions and the UI. An event is emitted, and when the TUI responds, the promise resolves. Safety via timeout support.

---

## 5. Registries

### 5.1 ToolRegistry (`registry/tool-registry.ts`)

**Purpose:** Hold all tools in a central Map, perform collision/schema validation.

**Five registration modes:**

| Method | Duplicate behavior | Use case |
|---|---|---|
| `register()` | Throws | Boot-time strict registration |
| `tryRegister()` | Silently returns `false` | Plugin/MCP flexible registration |
| `registerAll()` | Skip on conflict | Bulk MCP tool registration |
| `registerAllOrThrow()` | Throws | Strict boot |
| `registerDefault()` | Skip if exists | Overridable defaults |

**Wrap mechanism (`ToolWrapper`):** Can decorate an existing tool — wrapping `execute` to add logging, caching, or retry. Wrappers stack; each receives the output of the previous one.

**Key takeaway:** ToolRegistry is not just a Map — with registration-time validation, collision strategy, and decorator chains, it **ensures runtime safety at registration time**.

### 5.2 ProviderRegistry (`registry/provider-registry.ts`)

**Purpose:** Register provider factories (Anthropic, OpenAI, Google, etc.).

```typescript
interface ProviderFactory {
  type: string;        // Registry key: "anthropic", "openai"
  family: WireFamily;  // Wire protocol family (anthropic | openai | google)
  create(cfg: ProviderConfig): Provider;
}
```

- **The `family` field is critical:** Same-type providers (e.g. OpenAI and DeepSeek, which is OpenAI-compatible) share the same `WireFamily`. This allows tool format conversion, streaming handler selection, etc. without instantiating the provider — **routing is capability-based**.
- `override()` can replace an existing factory (useful in tests or plugin overrides).

### 5.3 SlashCommandRegistry (`registry/slash-command-registry.ts`)

Registers `/` commands in the REPL. Each slash command consists of a name, description, and handler function.

---

## 6. Extension System

### 6.1 Extension Points (`extension/extension-points.ts`)

Hooks that can be attached to every phase of the Agent lifecycle:

| Hook | When called | What it can do |
|---|---|---|
| `BeforeRunHook` | Before `Agent.run()` starts | Modify input, prevent the run |
| `AfterRunHook` | When run ends (success or failure) | Teardown, metrics |
| `BeforeIterationHook` | Before each iteration | Modify `ctx.messages`, `ctx.model` |
| `AfterIterationHook` | After each iteration | Monitoring, throttling |
| `OnErrorHook` | Provider/tool error | Decide `retry` / `fail` / `continue` |
| `ProviderRunnerWrapper` | Completely wrap the provider call | Cache, fallback-model, retry logic |
| `BeforeToolExecutionHook` | Before tool batch execution | Filter/modify tool list |
| `AfterToolExecutionHook` | After tool execution | Result logging, transform |

**Key design principle:** Extensions are **always optional** and **their errors are isolated** — a failing extension never aborts the agent run. This provides plugin safety (sandboxing).

### 6.2 ExtensionRegistry (`extension/registry.ts`)

Ensures ordered execution of extensions. In each phase (`runBeforeRun`, `runAfterRun`, etc.) all registered hooks are called sequentially; even if one throws, the others still run.

---

## 7. Context and ConversationState

### 7.1 Context (`core/context.ts`) — L1-A

Context is the object that holds the **live state of a single agent run**:

```
Context
├── provider        → Provider instance that makes API calls
├── session         → SessionWriter that writes JSONL
├── signal          → AbortController signal
├── tokenCounter    → Token usage tracking
├── messages[]      → Conversation history
├── todos[]         → Todo list
├── readFiles Set   → Read file tracking
├── fileMtimes Map  → File modification tracking
├── tools[]         → Current tool snapshot
├── meta{}          → Key-value metadata store
└── _state          → Lazy ConversationState wrapper
```

**The L1-A label is intentional:** Context's read-only environment shape is exposed via `RunEnv`, and its mutable shape via `ConversationState`. New code declares the narrower type as its parameter; legacy code can still pass `Context` because it structurally satisfies both.

**Abort Hook mechanism:** `registerAbortHook(fn)` registers cleanup functions that run when the run ends. `drainAbortHooks()` executes them in LIFO order (last registered runs first) — **idempotent**: calling it again won't re-run them.

**File tracking:** `recordRead(absPath, mtimeMs)` tracks read files. Cleared via `clearFileTracking()` after compaction — the agent naturally repopulates the list on the next file access.

### 7.2 ConversationState (`core/conversation-state.ts`)

An **observable** wrapper over Context:

```typescript
type StateChange =
  | { kind: 'message_appended'; message: Message }
  | { kind: 'messages_replaced'; messages: readonly Message[] }
  | { kind: 'todos_replaced'; todos: readonly TodoItem[] }
  | { kind: 'meta_set'; key: string; value: unknown }
  | { kind: 'meta_deleted'; key: string }
  | { kind: 'meta_cleared' };
```

- **Lazy initialization:** `ctx.state` is created on first access — systems that don't subscribe pay nothing.
- **Deep-freeze snapshot:** The `snapshot()` method enables safe reads across async boundaries.
- **Auto-clear todos:** When all todos are `completed`, the list is automatically cleared — the user doesn't have to manually run `/todos clear`.
- **Warning:** Direct `ctx.messages.push()` should be avoided — it bypasses the observer layer. New code should use `ctx.state.appendMessage()`.

---

## 8. Compaction System

### 8.1 Compactor Interface (`types/compactor.ts`)

```typescript
interface Compactor {
  compact(ctx: Context, opts?: { aggressive?: boolean }): Promise<CompactReport>;
}
```

**CompactReport structure:**

| Field | Meaning |
|---|---|
| `before` / `after` | Message-only token count |
| `fullRequestTokensBefore` / `fullRequestTokensAfter` | Full API request: messages + systemPrompt + toolDefs |
| `reductions[]` | How much was saved in which phase |
| `repaired?` | Broken tool_use/result reference repair |
| `collapsedDigest?` | Summary text of collapsed old conversations |

**Three strategies:** `'hybrid'` (fast rules, default), `'intelligent'` (LLM summarization), `'selective'` (LLM-driven smart selection).

### 8.2 Context Window Policy (`types/config.ts` → ContextConfig)

```
warnThreshold  → 60-70%: UI warning
softThreshold  → 80-85%: Compaction starts
hardThreshold  → 95%: Aggressive compaction
preserveK      → Last N messages are preserved
elideThreshold → Threshold for eliding short tool results
```

With `autoCompact: true` (default), compaction is automatically triggered when thresholds are crossed. `effectiveMaxContext` can trigger earlier than the provider's actual window.

---

## 9. Session System (`types/session.ts`)

### 9.1 Two-Tier Logging Model

Session JSONL files write in **two tiers**:

**Core Reconstruct Set** (always written, required for resume/rewind):
- `session_start`, `session_resumed`, `user_input`, `llm_response`, `tool_result`
- `checkpoint`, `file_snapshot`, `rewound`, `session_end`

**Audit Detail Set** (controlled by `auditLevel`):
- `llm_request`, `tool_use`, `tool_call_start/end`, `compaction`, `error`

| auditLevel | What is written |
|---|---|
| `minimal` | Core Reconstruct only |
| `standard` (default) | Core + lightweight audit |
| `full` | Everything, including heavy payloads |

**Location:** `~/.wrongstack/projects/<sha256(projectRoot).slice(0,12)>/sessions/<date>/sess_<ULID>.jsonl`

**Guarantee:** All writes are best-effort — a failed write never aborts the agent loop. Sensitive content passes through `SecretScrubber`.

### 9.2 Session Metadata

```typescript
interface SessionMetadata {
  id: string;
  title?: string;
  model?: string;
  provider?: string;
  startedAt: string;
  endedAt?: string;
  pendingToolUses?: string[];  // Open tool calls — for resume
}
```

---

## 10. Permission System (`types/permission.ts`)

### 10.1 Trust Policy

```typescript
interface TrustPolicy {
  [toolNameOrPattern: string]: {
    allow?: string[];
    deny?: string[];
    auto?: boolean;
    trustWorkdir?: boolean;
    denyPrivate?: boolean;
  };
}
```

Tool permission decisions come from these sources:
- `'default'` — The tool's declared `permission` field
- `'trust'` — Permanent rule in trust.json
- `'yolo'` / `'yolo_destructive'` — YOLO mode (auto-approve)
- `'user'` — User's `'always'` response
- `'deny'` — Permanent deny rule
- `'context'` — Contextual inference
- `'subagent_guard'` — Subagent restriction

### 10.2 Risk Tier System

```typescript
type RiskTier = 'safe' | 'standard' | 'destructive';
```

- **YOLO mode** auto-approves everything by default, but with `--confirm-destructive`, destructive-tier tools still require confirmation.
- `denyOnce()` / `allowOnce()` — Session-scoped temporary rules that prevent the LLM from re-triggering the same tool call or auto-approving it.

---

## 11. Memory System (`types/memory.ts`)

### 11.1 Memory Entry Structure

```typescript
interface MemoryEntry {
  scope: 'project-agents' | 'project-memory' | 'user-memory';
  text: string;
  ts: string;
  type?: 'fact' | 'decision' | 'convention' | 'preference' | 'reference' | 'anti_pattern';
  tags?: string[];
  priority?: 'critical' | 'high' | 'medium' | 'low';
  source?: string;
  confidence?: number;       // 0.0–1.0
  lastAccessed?: string;     // ISO timestamp
}
```

**Three scopes:**

| Scope | Sharing | Example |
|---|---|---|
| `project-memory` | All sessions, all agents | "Using pnpm workspaces" |
| `project-agents` | Among project agents | "default branch: main" |
| `user-memory` | User-specific, global | "Reply in Turkish" |

### 11.2 Relevance Scoring

Pre-injection scoring via `MemoryRelevanceContext`:
- `currentTask` — Current task
- `activeSkills` — Active skills
- `activeMode` — Active mode
- `toolNames` — Relevant tools

**`critical` priority entries are always injected; `low` ones may be skipped.**

### 11.3 Memory Events (EventBus)

```typescript
'memory.remembered' → MemoryRememberedPayload
'memory.forgotten'  → MemoryForgottenPayload
'memory.cleared'    → MemoryClearedPayload
'memory.consolidated' → MemoryConsolidatedPayload
```

---

## 12. Subagent Budget (`coordination/subagent-budget.ts`)

### 12.1 Budget Types

```typescript
type BudgetKind = 'tool_calls' | 'iterations' | 'tokens' | 'timeout' | 'idle_timeout' | 'cost';
```

**Critical design: Timeout Preemption**

```
TIMEOUT_PREEMPT_FRACTION = 0.85
```

When 85% of the wall-clock timeout is reached, the coordinator **proactively** requests a budget extension. If the subagent is still working, the limit is extended via a `threshold_reached` event — so the agent never enters a "timed out" state. If there's still no response at the real deadline, it's forcibly stopped.

### 12.2 Budget Observer

```typescript
interface BudgetUsage {
  iterations: number;
  toolCalls: number;
  tokens: { input: number; output: number; total: number };
  costUsd: number;
  elapsedMs: number;
}
```

When a limit is exceeded, `BudgetExceededError` reports a structured error containing `kind`, `limit`, and `observed` fields.

**Negotiation modes:** `'auto'` (ask the coordinator, default), `'sync'` (throw immediately, for fire-and-forget subagents).

---

## 13. Worktree Manager (`worktree/worktree-manager.ts`)

Provides **git worktree isolation** between parallel phases of AutoPhase.

### 13.1 Lifecycle

```
allocating → active → committing → merging → merged
                                    └→ needs-review (conflict)
(any) → failed
```

Each worktree:
- Has a separate branch (`wstack/ap/<slug>`)
- Has a separate filesystem checkout directory
- Is merged back to the base branch via squash-merge

### 13.2 Conflict Resolution

A conflict resolver can be provided via `MergeOpts.resolve`. If the resolver returns `true` and no conflict markers remain, the merge is committed; otherwise a hard reset parks it in the `needs-review` state — **the base tree is never left dirty.**

---

## 14. Hook System (`hooks/`)

### 14.1 Structure

```
hooks/
├── registry.ts      → Hook registration and execution
├── runner.ts        → Shell hook execution
├── shell-executor.ts → Shell command execution
└── index.ts
```

Shell hooks allow external scripts to attach to WrongStack lifecycle events (tool execution, session start, etc.). Connected to the Container via `HookRegistry` (TOKENS.HookRegistry).

---

## 15. Provider Interface (`types/provider.ts`)

### 15.1 Request/Response Model

```typescript
interface Request {
  model: string;
  system?: TextBlock[];
  messages: Message[];
  tools?: Tool[];
  maxTokens: number;
  toolChoice?: 'auto' | 'required' | 'none' | { type: 'tool'; name: string };
}
```

The **StreamEvent** union type models SSE events:
- `message_start`, `content_block_start/stop`, `text_delta`, `tool_use_start/input_delta/stop`, `thinking_start/delta/stop`

### 15.2 Usage (Token Usage)

**Disjoint semantics:** `input`, `cacheRead`, `cacheWrite` never overlap:
- `input` = FRESH tokens (full price)
- `cacheRead` = Read from cache (discounted)
- `cacheWrite` = Written to cache (first write)

Provider inconsistencies are normalized at the adapter layer:
- **Anthropic:** Already disjoint
- **OpenAI:** `prompt_tokens` is the total; the adapter subtracts `cached_tokens`
- **Google:** `promptTokenCount` is the total; the adapter subtracts

Without this disjoint invariant, cost calculations would be wrong and cache-hit ratios would be inflated.

### 15.3 Capabilities

```typescript
interface Capabilities {
  tools: boolean;
  parallelTools: boolean;
  vision: boolean;
  streaming: boolean;
  promptCache: boolean;
  systemPrompt: boolean;
  jsonMode: boolean;
  reasoning: boolean;
  maxContext: number;
  cacheControl: 'native' | 'auto' | 'none';
}
```

Each provider declares its own capabilities — the agent loop adapts accordingly (e.g. sequential tool execution when `parallelTools: false`).

---

## 16. Tool System (`types/tool.ts`)

### 16.1 Tool Interface

```typescript
interface Tool<I = unknown, O = unknown> {
  name: string;
  description: string;
  usageHint?: string;
  inputSchema: JSONSchema;
  permission: Permission;         // 'auto' | 'confirm' | 'deny'
  mutating: boolean;
  riskTier?: RiskTier;            // 'safe' | 'standard' | 'destructive'
  trustFieldName?: string;        // Input field the permission policy checks against
  category?: string;
  
  execute(input: I, ctx: Context, opts?): Promise<O>;
  executeStream?(input: I, ctx: Context, opts?): AsyncGenerator<ToolStreamEvent<O>>;
  cleanup?(): void | Promise<void>;
}
```

### 16.2 Progress Streaming

Long-running tools (bash, file scanning) produce progress events via `executeStream`:

```typescript
type ToolProgressEvent = {
  type: 'log' | 'warning' | 'metric' | 'file_changed' | 'partial_output';
  text?: string;
  data?: Record<string, unknown>;
};
```

These events are published on the EventBus as `tool.progress` — TUI, logger, and observability layer all consume from the same channel.

### 16.3 Cleanup Lifecycle

`Tool.cleanup()` — Releases resources owned by the tool (child processes, file handles). Hooks registered via Context's `registerAbortHook()` are for **run-level** cleanup; use `cleanup` for tool-level cleanup.

---

## 17. Configuration (`types/config.ts`)

WrongStack's configuration is multi-layered:

### 17.1 ContextConfig

```typescript
interface ContextConfig {
  mode?: ContextWindowModeId;
  warnThreshold: number;
  softThreshold: number;
  hardThreshold: number;
  autoCompact?: boolean;
  summarizerModel?: string;
  effectiveMaxContext?: number;
  preserveK: number;
  strategy?: 'hybrid' | 'intelligent' | 'selective';
}
```

### 17.2 ProviderConfig

```typescript
interface ProviderConfig {
  type: string;
  apiKey?: string;
  apiKeys?: ProviderApiKey[];
  activeKey?: string;
  baseUrl?: string;
  family?: WireFamily;  // Wire protocol override
  model?: string;
  capabilities?: Record<string, unknown>;
}
```

**Multiple API Key support:** The `apiKeys` array allows defining multiple keys for the same provider. Selection is made via `activeKey`; the legacy `apiKey` field is retained for backward compatibility.

### 17.3 ToolsConfig

```typescript
interface ToolsConfig {
  defaultExecutionStrategy: 'parallel' | 'sequential' | 'smart';
  maxIterations: number;
  iterationTimeoutMs: number;
  sessionTimeoutMs: number;
  perIterationOutputCapBytes: number;
  autoExtendLimit?: boolean;  // Automatically extend iteration limit by +100
}
```

---

## 18. SubagentConfig (`types/multi-agent.ts`)

Subagent configuration, with director mode extensions:

```typescript
interface SubagentConfig {
  id?: string;
  name: string;
  role?: string;
  prompt?: string;
  maxIterations?: number;
  maxToolCalls?: number;
  maxTokens?: number;
  maxCostUsd?: number;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  tools?: string[];
  model?: string;
  priority?: number;
  cwd?: string;
  
  // Director orchestration extensions
  provider?: string;              // Cross-provider routing
  sessionPath?: string;           // JSONL path override
  systemPromptOverride?: string;  // Additional prompt text
  skillContent?: string;          // SKILL.md content
  textStream?: 'director' | 'silent' | 'user';
  toolStream?: 'director' | 'silent' | 'user';
}
```

**`textStream` / `toolStream` routing:** Controls where subagent output goes. Default is `'director'` — to the parent via FleetBus. `'silent'` only returns the final result. `'user'` forwards directly to the user.

---

## 19. Architectural Patterns — Summary Assessment

### 19.1 Positive Patterns

| Pattern | Where Used | Impact |
|---|---|---|
| **Dependency Injection (Container)** | All core services | Testability, loose coupling |
| **Typed Event Bus** | Agent, provider, tool, memory | Observability, UI integration |
| **Factory Pattern (Registries)** | Tool, Provider, SlashCommand | Runtime extensibility |
| **Observer (ConversationState)** | Context mutations | Deterministic change stream |
| **Extension Point Pipeline** | Agent lifecycle | Plugin sandboxing |
| **Budget with Preemption** | Subagent timeout | Graceful extension |
| **Two-tier Session Logging** | JSONL audit | Resume safety + performance |
| **Worktree Isolation** | AutoPhase parallel phases | File conflict prevention |

### 19.2 Potential Risk Areas

| Area | Risk | Why |
|---|---|---|
| `Context` mutable fields | Medium | `messages[]`, `todos[]` are directly accessible; observer bypass risk |
| `completedResults` in Coordinator | Low | Capped at `MAX_COMPLETED_RESULTS = 10_000` but can grow in long-running coordinators |
| `FleetBus` handler leak | Low | `attach()` returns a disposer but callers may forget to call it |
| Multi-provider streaming | Medium | Each provider has a different SSE format; adapter complexity |
| Config backward compat | Low | `apiKey` ↔ `apiKeys` legacy burden |

### 19.3 Suggested Improvements

1. **Make ConversationState mandatory:** Deprecate direct `ctx.messages` mutation, require all writes to go through `ctx.state`.
2. **Concretize memory relevance scoring:** The `MemoryRelevanceContext` interface exists but implementation details are missing — the scoring strategy should be documented.
3. **FleetBus attach/dispose automation:** Guarantee the disposer is called automatically when a subagent terminates (via WeakRef/finalization registry).
4. **Context snapshot serialization:** `snapshot()` is frozen but not serializable — JSON serialization support could be added for distributed scenarios.

---

## 20. Data Flow — End to End

```
User input
     ↓
  REPL / CLI
     ↓
  Dispatcher.run()
     ↓
  Agent.run()
     ├── ExtensionRegistry.runBeforeRun()
     ├── RunController (abort + cleanup)
     ├── AgentLoopHandler.runInner()
     │       ↓
     │   [Iteration loop]
     │       ├── ProviderRunner → Provider.call() → SSE Stream
     │       │       ├── EventBus: provider.text_delta, tool_use_start/stop
     │       │       └── Usage → TokenCounter
     │       ├── AgentResponseHandler → Block processing
     │       ├── AgentToolHandler → Tool batch execution
     │       │       ├── PermissionPolicy.evaluate()
     │       │       ├── Tool.execute() / Tool.executeStream()
     │       │       └── EventBus: tool.started, tool.progress, tool.executed
     │       ├── Compaction (if threshold crossed)
     │       │       └── CompactReport → EventBus
     │       └── Autonomous continue (optional)
     ├── ExtensionRegistry.runAfterRun()
     └── RunController.dispose()
     
     In parallel:
     ├── SessionWriter → JSONL append
     ├── EventBus → TUI / Logger / Memory updates
     └── MemoryStore → remember / search / forget
```

---

*Report complete. All critical subsystems of WrongStack (Kernel, Agent Core, Coordination, Registries, Extensions, Context, Compaction, Session, Permission, Memory, Budget, Worktree, Hooks, Provider, Tool, Config) have been analyzed.*

# WrongStack Architecture Reference

Complete technical architecture of the WrongStack AI coding agent system.
Covers every layer from kernel primitives through agent orchestration,
security, persistence, multi-agent coordination, autonomy, and user interfaces.

---

## Table of Contents

1. [Package Architecture](#1-package-architecture)
2. [Kernel Primitives](#2-kernel-primitives)
3. [Agent Lifecycle](#3-agent-lifecycle)
4. [System Prompt Architecture](#4-system-prompt-architecture)
5. [Token Estimation & Calibration](#5-token-estimation--calibration)
6. [Compaction System](#6-compaction-system)
7. [Event System](#7-event-system)
8. [Security Architecture](#8-security-architecture)
9. [Persistence Architecture](#9-persistence-architecture)
10. [Memory Store](#10-memory-store)
11. [Skill System](#11-skill-system)
12. [Multi-Agent Coordination](#12-multi-agent-coordination)
13. [Autonomous / Eternal Mode](#13-autonomous--eternal-mode)
14. [MCP Client](#14-mcp-client)
15. [TUI Architecture](#15-tui-architecture)
16. [WebUI Architecture](#16-webui-architecture)
17. [End-to-End Data Flow](#17-end-to-end-data-flow)
18. [ACP Ensemble Integration](#18-acp-ensemble-integration)

---

## 1. Package Architecture

### Dependency Graph

```
core (zero internal dependencies)
 ├── kernel/     — Container, Pipeline, EventBus, Tokens
 ├── core/       — Agent, AgentLoop, Context, SystemPrompt
 ├── execution/  — ToolExecutor, Compactor, AutonomyEngine
 ├── coordination/ — Director, Coordinator, Fleet, Delegate
 ├── security/   — PermissionPolicy, Capabilities, Secrets
 ├── storage/    — SessionStore, GoalStore, MemoryStore
 └── types/      — All type definitions
      ↓
providers/  — Anthropic/OpenAI/Google/OpenAI-compatible adapters
tools/      — 36 built-in tools (read, write, bash, grep...)
mcp/        — MCP client + registry + transports
runtime/    — Default runtime implementations
acp/        — ACP server/client for external agent protocols
plugins/    — Bundled plugin library
plug-lsp/   — LSP bridge + language tooling
telegram/   — Telegram bridge plugin
skills/     — Skill subpackages
      ↓
cli/    — REPL, slash commands, subcommands, plugin management
tui/    — React/Ink terminal UI
webui/  — Vite+React web UI
      ↓
apps/wrongstack/ — Binary entry point
```

### Package Responsibilities

| Package | Role |
|---------|------|
| `core` | Runtime kernel, types, agent loop, tool execution, compaction, coordination, security, persistence |
| `providers` | LLM provider adapters: Anthropic, OpenAI, Google, OpenAI-compatible via WireFormatConfig |
| `tools` | 36 built-in tools for filesystem, shell, search, git, dependencies, scaffolding |
| `mcp` | MCP client with stdio/SSE/streamable-http transports, registry, tool wrapping |
| `cli` | REPL, slash commands, subcommands, interactive pickers, plugin management |
| `tui` | React/Ink terminal UI with live streaming, history, fleet monitoring, status bar |
| `webui` | Vite+React browser UI with WebSocket transport, Zustand stores, multi-panel layout |

---

## 2. Kernel Primitives

The kernel (`packages/core/src/kernel/`) is ~1670 lines total (including the full event type catalog). Six modules:

### Container

A typed DI container indexed by `Token<T>` (branded symbols). Bindings support
`factory`, `value`, and `decorator` forms. Resolution is lazy and memoized.

22 well-known tokens (as of v0.270.0):

```
TOKENS.Logger              TOKENS.TokenCounter      TOKENS.SessionStore
TOKENS.MemoryStore         TOKENS.PermissionPolicy  TOKENS.Compactor
TOKENS.PathResolver        TOKENS.ConfigLoader      TOKENS.ConfigStore
TOKENS.Renderer            TOKENS.InputReader       TOKENS.ErrorHandler
TOKENS.RetryPolicy         TOKENS.SkillLoader       TOKENS.SystemPromptBuilder
TOKENS.SecretScrubber      TOKENS.ModelsRegistry    TOKENS.ModeStore
TOKENS.ProviderRunner      TOKENS.WorktreeManager   TOKENS.BrainArbiter
TOKENS.HookRegistry
```

Plugins can rebind any token before `Agent.run`. No service locator pattern —
every dependency arrives through the container explicitly.

### Pipeline

Linear middleware over a typed value. Six pipelines run per agent step:

| Pipeline | Value | Fires |
|----------|-------|-------|
| `userInput` | `{ content, text, ctx }` | Every user turn |
| `request` | `Request` | Before each provider call |
| `response` | `Response` | After each provider call |
| `assistantOutput` | `TextBlock` | Per assistant text block |
| `toolCall` | `{ toolUse, result, ctx, tool }` | After every tool call |
| `contextWindow` | `Context` | Before sending if context is near limit |

Middleware shape:

```ts
const mw: Middleware<Request> = {
  name: 'my-mw',
  owner: 'my-plugin',
  handler: async (req, next) => {
    const before = performance.now();
    const out = await next(req);
    log('took', performance.now() - before);
    return out;
  },
};
```

### EventBus

Typed pub/sub. Subscribers cannot modify or cancel events. Subscriber
exceptions are caught — one bad listener never crashes others.

Key features:
- `on(event, fn)` — subscribe, returns unsubscribe function
- `once(event, fn)` — auto-unsubscribe after first fire
- `onPattern('tool.*', fn)` — wildcard subscription (prefix matching)
- `onRegex(/pattern/, fn)` — regex subscription
- `onAny(fn)` — subscribe to all events
- `emitCustom(name, payload)` — plugin-defined events (wildcard only)
- `emit(event, payload)` — typed emission

`ScopedEventBus` extends EventBus with auto-cleanup:

```ts
const bus = new ScopedEventBus();
bus.on('tool.executed', handler);  // tracked
bus.teardown();                     // removes ALL tracked listeners
```

Supports `using` keyword (Node ≥22): `using bus = new ScopedEventBus();`

### RunController

Centralizes abort + cleanup for a single agent run. Wraps an AbortController
and exposes a registry of teardown hooks that fire LIFO, exactly once, when
the run aborts OR ends normally.

```ts
const controller = new RunController({ parentSignal: opts.signal });
controller.onAbort(() => cleanup());  // register hook
controller.abort('user interrupt');    // force abort
await controller.dispose();           // normal end — fires hooks too
```

---

## 3. Agent Lifecycle

### Three Nested Loops

```
┌── ETERNAL LOOP (EternalAutonomyEngine) ─────────────┐
│  while (!stopped) { SENSE → DECIDE → EXECUTE → ...  │
│  ┌── OUTER LOOP (AutonomousRunner) ──────────────┐   │
│  │  while (!done) { check condition → agent.run } │   │
│  │  ┌── INNER LOOP (Agent.run → runInner) ─────┐  │   │
│  │  │  for (i=0; ; i++) {                      │  │   │
│  │  │    SENSE  → build system prompt          │  │   │
│  │  │    DECIDE → call provider (LLM)          │  │   │
│  │  │    EXECUTE→ run tools model asked for    │  │   │
│  │  │    REFLECT→ feed results, check stop     │  │   │
│  │  │  }                                       │  │   │
│  │  └──────────────────────────────────────────┘  │   │
│  └────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────┘
```

### Inner Loop — `runInner()` (agent-loop.ts)

The core iteration. Each iteration:

```ts
for (let i = 0; ; i++) {
  // ABORT CHECK
  if (controller.signal.aborted) return { status: 'aborted' };

  // ITERATION LIMIT CHECK (auto-extend)
  if (hasHardLimit && i >= effectiveLimit) {
    extendBy = await requestLimitExtension(...);
    if (extendBy > 0) { effectiveLimit += extendBy; continue; }
    return { status: 'max_iterations' };
  }

  // HOOKS & EVENTS
  await extensions.runBeforeIteration(ctx, i);
  events.emit('iteration.started', { ctx, index: i });

  // SENSE: Build request
  injectPendingBtwNotes();
  req = await buildAndRunRequestPipeline(opts);
  session.append({ type: 'llm_request', estimatedInputTokens, ... });

  // DECIDE: Call provider
  res = await customRunner(ctx, req);  // wrapProviderRunner hook
  recordActualUsage(res.usage.input, calibratedEstimate, calibrationKey);

  // REFLECT: Process response
  responseResult = await processResponse(res, req);
  // → response pipeline, token accounting, assistant output, [continue]/[done]

  // EXECUTE: Run tools (if any)
  toolUses = res.content.filter(isToolUseBlock);
  if (toolUses.length === 0) return { status: 'done', finalText };
  await handlers.tools.executeTools(toolUses);

  // POST-ITERATION
  emitContextPct();
  events.emit('iteration.completed', { ... });
  await compactContextIfNeeded();
  await extensions.runAfterIteration(ctx, i);
}
```

### Tool Execution Flow (tool-executor.ts)

```
executeBatch(toolUses, ctx, strategy)
  │
  └─ runOne (per tool)
      ├─ 1. Registry lookup (exists?)
      ├─ 2. inputSchema validation (HARD GATE)
      ├─ 3. Malformed argument detection (__raw sentinel)
      ├─ 4. PreToolUse hook (block/rewrite)
      ├─ 5. PermissionPolicy.evaluate() (9-step decision tree)
      ├─ 6. Dangerous capability enforcement
      ├─ 7. Permission = deny → denied
      ├─ 8. Permission = confirm → ask user (confirmAwaiter)
      ├─ 9. Permission = auto → executeTool()
      │     ├─ tool.started event
      │     ├─ runWithTimeout (AbortSignal.any)
      │     ├─ serialize → secret scrub → output cap
      │     └─ tool_result
      └─ PostToolUse hook

Execution strategies:
  sequential → one at a time
  parallel   → Promise.all
  smart      → non-mutating parallel, then mutating sequential
```

### Agent Construction (agent.ts)

```ts
class Agent {
  constructor(init: AgentInit) {
    this.container = init.container;
    this.tools = init.tools;
    this.providers = init.providers;
    this.events = init.events;
    this.pipelines = init.pipelines;   // 6 pipelines
    this.ctx = init.context;
    this.maxIterations = init.maxIterations ?? 100;
    this.toolExecutor = init.toolExecutor;
    this.extensions = init.extensions;  // lifecycle hooks
    // Create handlers:
    this._toolHandler = createAgentToolHandler(this);
    this._responseHandler = createAgentResponseHandler(this);
    this._loopHandler = createAgentLoopHandler(this, { tools, response });
  }
}
```

### RunResult

```ts
interface RunResult {
  status: 'done' | 'failed' | 'max_iterations' | 'aborted';
  error?: WrongStackError;
  finalText?: string;
  iterations: number;
  delegateSummaries?: Array<{ summary: string; ok: boolean }>;
  abortReason?: string;
}
```

---

## 4. System Prompt Architecture

### 6-Layer Structure

Built by `DefaultSystemPromptBuilder.build()` each turn:

```
Layer 1: IDENTITY (static, cacheable)
  Fixed ~300-line text. Agent's core identity, rules, principles.
  Never changes. Perfect for Anthropic prompt cache.

Layer 2: TOOL USAGE (static, cacheable)
  Tools grouped by category + common patterns.
  + delegation guide (if delegate tool present)
  + context management guide (if context_manager present)
  Adaptive threshold: ~50% for small models, ~70% for large models.

Layer 3: ENVIRONMENT (semi-static, cached per project)
  Working directory, OS, Node.js version, shell
  Git status (2s timeout spawn)
  Detected languages (11 marker files, parallel fs.access)
  Skills in scope (compact list: name + trigger)
  Today's date, provider/model, mode, context window

Layer 4: MEMORY + SKILLS (ephemeral)
  Relevant memory entries via scoreRelevant (max 8)
  Full skill bodies (strip YAML frontmatter, session cache)

Layer 5: MODE (ephemeral)
  Active mode prompt (teach, code-reviewer, brief, etc.)

Layer 6: PLAN (ephemeral, suppressed for subagents)
  Active plan items with [x]/[~]/[ ] checkboxes
  Re-read from disk every build()

Plugin Contributors (ephemeral)
  Additional TextBlocks from plugins via registerSystemPromptContributor()
```

### Cache Strategy

```ts
// Static layers (no cache_control) → cached by Anthropic
blocks = [
  { type: 'text', text: layer1 },  // identity
  { type: 'text', text: layer2 },  // tool usage
  { type: 'text', text: layer3 },  // environment
];

// Ephemeral layers → NOT cached, sent every turn
blocks.push({
  type: 'text',
  text: layer4,
  cache_control: { type: 'ephemeral' },
});
```

### Environment Detection

```ts
buildEnvironment(ctx):
  // Cached per project root
  if (envCacheByRoot.has(projectRoot)) return cached;

  // Parallel probes:
  [git, langs] = await Promise.all([
    gitStatus(root),        // spawn git status, 2s timeout
    detectLanguages(root),  // 11 marker files, parallel fs.access
  ]);

  // Git status parser:
  // "## main...origin/main [ahead 1]\nM packages/core/src/agent.ts"
  // → "branch=main, 3 modified, 0 staged"

  // Language detection:
  // → "JavaScript/TypeScript, Go, Rust"
```

---

## 5. Token Estimation & Calibration

### Heuristic

```ts
RoughTokenEstimate(text): Math.ceil(text.length / 3.5)
// Conservative overestimate (3.5 chars/token)
```

### Three Estimation Levels

```ts
// Level 1: Message tokens
estimateMessageTokens(messages): number
  // Sums text + tool_use inputs + tool_result content

// Level 2: Tool definition tokens
estimateToolDefTokens(tool): number
  // name + description + JSON.stringify(inputSchema)

// Level 3: Full request tokens (used by compaction + context bar)
estimateRequestTokens(messages, systemPrompt, tools): RequestTokenBreakdown
  // Returns { messages, systemPrompt, tools, total }
  // Overhead: short convos ~30-50%, medium ~15-30%, long ~5-15%
```

### Calibration System

After each provider call, actual usage calibrates the estimate:

```ts
recordActualUsage(actualInputTokens, estimatedInputTokens, calibrationKey):
  sampleRatio = actualInputTokens / estimatedInputTokens

  if first sample:
    cal.ratio = sampleRatio
  else:
    cal.ratio = 0.3 * sampleRatio + 0.7 * oldRatio  // EWM α=0.3

  cal.ratio = clamp(cal.ratio, 0.5, 1.5)  // sanity bound

// Per-provider/model calibration buckets:
calibrationKey = `${providerId}/${model}`  // e.g. "anthropic/claude-sonnet-4-6"
```

Calibration requires ≥3 samples before applying. Before that,
`estimateRequestTokensCalibrated` falls back to the uncalibrated heuristic.

### Estimation Cache

```ts
ESTIMATE_CACHE: Map<jsonString, tokenEstimate>  // max 10K entries
// Avoids repeated JSON.stringify of tool inputs
// Evicts oldest 25% when at capacity (LRU-ish)
```

### Integration Points

```
Agent Loop:
  llm_request log → estimateRequestTokens (uncalibrated)
  After provider → recordActualUsage → calibration update
  ctx.pct event   → estimateRequestTokensCalibrated
  Compaction      → estimateRequestTokensCalibrated
```

---

## 6. Compaction System

### Three Compactor Types

| Compactor | Strategy | LLM Calls | When |
|-----------|----------|-----------|------|
| **HybridCompactor** | Rule-based: elision + lossless/smart digest | No | Default, most sessions |
| **SelectiveCompactor** | LLM-driven: selector chooses, summarizer condenses | Yes (selector + summarizer) | Large/important sessions |
| **IntelligentCompactor** | LLM summarization, no structured selection | Yes | Middle ground |

### Two-Phase Strategy (HybridCompactor)

```
Phase 1: ELISION (always)
  Replace large old tool_results with "[elided: ~N tokens]"
  Preserve last preserveK user+assistant pairs
  Never break tool_use/tool_result pairs

Phase 2: COLLAPSE (aggressive mode only)
  Collapse old messages into a single digest
  Smart mode: content scoring (critical → verbatim, noise → collapsed)
  Normal mode: preserve all text, drop only tool I/O
```

### Content Scoring

```ts
scoreMessage(message, context): 0 | 1 | 2 | 3 | 4 | 5

SCORE 5 (CRITICAL) — verbatim preservation:
  User corrections ("no", "wrong", "stop", "don't")
  Error/exception messages
  Security findings
  Architecture/design decisions

SCORE 3 (MEDIUM) — first sentence preserved:
  Normal exchanges, successful tool calls (default)

SCORE 1 (LOW) — one-line summary:
  Large tool results (>3K chars)
  grep/list/tree outputs
  3rd-4th repeated identical failure

SCORE 0 (NOISE) — fully collapsed:
  Pure tool I/O with no text
  5th+ repeated identical failure
```

### AutoCompactionMiddleware

Monitors context pressure via `contextWindow` pipeline:

```
load = tokens / maxContext

load < 0.60 → nothing
load ≥ 0.60 → WARN: elision only
load ≥ 0.75 → SOFT: elision + collapse (per aggressiveOn setting)
load ≥ 0.90 → HARD: always aggressive collapse

aggressiveOn: 'warn' | 'soft' | 'hard'
```

No-op retry prevention: if compaction at a given level produced no reduction,
skip until either pressure escalates or context grows by ≥2000 tokens.

### Safe Boundary Detection

```ts
findSafeBoundary(messages, from, to): number
  // Walk backward to find user message with text
  // Then find its exchange start (previous tool-free assistant)
  // Never breaks tool_use/tool_result pairs

findExchangeStart(messages, userIndex): number
  // Walk backward:
  // Assistant without tool_use → boundary = assistant position + 1
  // User message found → boundary = that position
```

---

## 7. Event System

### Event Categories (50+ events)

**Session Lifecycle:**
`session.started`, `session.ended`, `session.damaged`, `session.rewound`,
`in_flight.started`, `in_flight.ended`, `checkpoint.written`

**Iteration:**
`iteration.started`, `iteration.completed`, `iteration.limit_reached`,
`ctx.pct`, `ctx.max_context`

**Provider (LLM):**
`provider.response`, `provider.text_delta`, `provider.thinking_delta`,
`provider.tool_use_start`, `provider.tool_use_stop`, `provider.stream_error`,
`provider.retry`, `provider.error`, `provider.fallback`

**Tool Execution:**
`tool.started`, `tool.progress`, `tool.executed`, `tool.confirm_needed`,
`trust.persisted`

**Subagent / Fleet:**
`subagent.spawned`, `subagent.task_started`, `subagent.task_completed`,
`subagent.tool_executed`, `subagent.iteration_summary`, `subagent.done`,
`subagent.budget_warning`, `subagent.budget_extended`, `subagent.ctx_pct`,
`budget.threshold_reached`, `delegate.started`, `delegate.completed`

**Other:**
`compaction.fired`, `compaction.failed`, `context.repaired`,
`mcp.server.connected`, `mcp.server.reconnected`, `mcp.server.disconnected`,
`memory.remembered`, `memory.forgotten`, `memory.cleared`, `memory.consolidated`,
`coordinator.stats`, `concurrency.changed`,
`worktree.allocated`, `worktree.committed`, `worktree.merged`, `worktree.released`,
`error`

### EventBus API

```ts
class EventBus {
  on(event, fn): () => void          // Subscribe, returns unsubscribe
  once(event, fn): () => void        // Auto-unsubscribe after first fire
  onPattern(prefix, fn): () => void  // Wildcard: 'tool.*'
  onRegex(regex, fn): () => void     // Regex match
  onAny(fn): () => void              // All events
  emit(event, payload): void         // Typed emission
  emitCustom(event, payload): void   // Plugin-defined (wildcard only)
  hasListenerFor(event): boolean     // Check if anyone is listening
}
```

### Chronological Event Flow (Single Iteration)

```
1. checkpoint.written          ← writeCheckpoint
2. in_flight.started           ← writeInFlightMarker
3. iteration.started           ← agent-loop.ts:210
4. context.repaired            ← (if needed) adjacency repair
5. provider.text_delta         ← per SSE chunk (streaming)
6. provider.thinking_delta     ← per thinking chunk
7. provider.tool_use_start     ← model started tool call
8. provider.tool_use_stop      ← model finished tool call
9. provider.response           ← usage + stopReason
10. tool.started               ← per tool
11. tool.progress              ← streaming tool output
12. tool.confirm_needed        ← (if needed) confirmation dialog
13. trust.persisted            ← (if needed) always/deny persisted
14. tool.executed              ← per tool completed
15. ctx.pct                    ← context fill percentage
16. compaction.fired           ← (if needed) compaction triggered
17. iteration.completed        ← iteration end
18. in_flight.ended            ← clearInFlightMarker
```

---

## 8. Security Architecture

### Five Defense Layers

```
L1: TOOL DECLARATION
  permission: 'auto' | 'confirm' | 'deny'
  mutating: true | false
  riskTier: 'safe' | 'standard' | 'destructive'
  capabilities: ['fs.read', 'shell.arbitrary', ...]

L2: INPUT VALIDATION (Tool Executor)
  inputSchema JSON Schema validation (HARD GATE)
  Malformed argument detection (__raw sentinel)
  PreToolUse hook (block/rewrite)

L3: PERMISSION POLICY (DefaultPermissionPolicy)
  9-step decision tree

L4: DANGEROUS CAPABILITY ENFORCEMENT
  Outside YOLO: auto → force confirm for dangerous capabilities
  Subagents: dangerous capabilities → DENY

L5: OUTPUT SANITIZATION
  SecretScrubber: 15 regex patterns
  Session log scrub: user_input + llm_response
  SecretVault: AES-256-GCM disk encryption
```

### Permission Policy — 9-Step Decision Tree

```ts
evaluate(tool, input, ctx):
  1. LAZY LOAD — reload trust file if not loaded
  2. NAMESPACE MATCH — mcp__server__* wildcard patterns
  3. TOOL-NAME ENTRY — policy["toolName"] exists?
  4. SUBJECT COMPUTE — subjectKey or heuristic (path, command, url)
  5. SESSION SOFT DENY — 'n' pressed this session → deny
  6. SESSION SOFT ALLOW — 'y' pressed this session → auto
  7. DENY PATTERN — matched in trust file → deny
  8. TOOL DEFAULT DENY — tool.permission === 'deny' → deny
  9. ALLOW PATTERN — matched in trust file → auto
  10. POLICY AUTO — policy[tool].auto === true → auto
  11. YOLO MODE
      ├─ confirmDestructive + destructive → confirm
      └─ else → auto
  12. SMART BYPASS — write/edit of already-read file → auto
  13. TOOL DEFAULT AUTO — permission === 'auto' && !mutating → auto
  14. CONFIRM — ask user via promptDelegate or return 'confirm'
```

### Trust File

```json
{
  "bash": {
    "allow": ["pnpm test", "pnpm build"],
    "deny": ["rm -rf /"]
  },
  "write": { "allow": ["src/**"] },
  "edit": { "auto": true },
  "mcp__filesystem__*": { "allow": ["src/**", "packages/**"] }
}
```

Pattern matching supports globs. `denyOnce`/`allowOnce` provide session-scoped
soft rules that never persist to disk.

### Capability-Based Security

```ts
ToolCapabilities = {
  SHELL_ARBITRARY: 'shell.arbitrary',       // bash
  SHELL_RESTRICTED: 'shell.restricted',      // exec
  FS_READ: 'fs.read',                       // read, glob, grep
  FS_WRITE: 'fs.write',                     // write, edit, replace
  FS_WRITE_OUTSIDE_PROJECT: 'fs.write.outside-project',
  NET_OUTBOUND: 'net.outbound',             // fetch, search
  MCP_PROXY: 'mcp.proxy',                   // MCP tools
  SUBAGENT_SPAWN: 'subagent.spawn',         // delegate
  CONFIG_MUTATE: 'config.mutate',
  PACKAGE_INSTALL: 'package.install',       // install
}
```

**Dangerous for subagents (auto-deny):**
`shell.arbitrary`, `shell.restricted`, `fs.write`, `fs.write.outside-project`,
`mcp.proxy`, `subagent.spawn`, `config.mutate`, `package.install`

### Subagent Permission Policy

```ts
class AutoApprovePermissionPolicy {
  evaluate(tool):
    blocked =
      tool.permission === 'deny' ||
      hasDangerousCapabilityForSubagents(tool) ||
      tool.name.startsWith('mcp__');

    if (blocked) return { permission: 'deny', source: 'subagent_guard' };
    return { permission: 'auto', source: 'yolo' };
}
```

### YOLO Destructive Detection

```ts
isClearlyDestructiveBashCommand(command, projectRoot):
  // Destructive patterns:
  git clean -xdf, git reset --hard
  rm -rf (target outside project)
  drop/truncate table/database
  mkfs, format, shutdown, reboot
  chmod -R 777, chown -R
  curl | sh, powershell -encodedcommand

  // Path escape detection:
  cd .., ../outside/path, /absolute/path outside project
  PROJECT_ESCAPE_PATTERN: /\.\./
```

### Secret Scrubber

15 regex patterns, 64KB chunked processing:

```
anthropic_key   → sk-ant-api03-xxx... → [REDACTED:anthropic_key]
openai_key      → sk-xxx...           → [REDACTED:openai_key]
github_pat      → ghp_xxx...          → [REDACTED:github_pat]
aws_access_key  → AKIAxxx...          → [REDACTED:aws_access_key]
jwt             → eyJxxx.yyy.zzz      → [REDACTED:jwt]
private_key     → -----BEGIN RSA...   → [REDACTED:private_key]
bearer_token    → Bearer xxx...       → [REDACTED:bearer_token]
database_uris   → mongodb://, postgresql://, mysql://, redis://
high_entropy_env → API_KEY=xxx        → API_KEY=[REDACTED:high_entropy_env]
```

Applied at two points:
1. Tool executor: serialize → scrub → cap
2. Session writer: scrubEvent() before JSONL append

### Secret Vault

AES-256-GCM encryption for API keys at rest:

```
Format: enc:v1:<iv_base64>:<tag_base64>:<ciphertext_base64>
Key file: ~/.wrongstack/key (32 bytes, mode 0o600)
Auto-generated if missing. Plaintext values pass through unchanged.
```

---

## 9. Persistence Architecture

### Session Storage

```
sessions/
├── _index.jsonl                    ← session index (with tombstones)
├── YYYY-MM-DD/                     ← date shard directories
│   └── sess_<ULID>.jsonl           ← session JSONL log
│   └── *.summary.json               ← session metadata sidecar
│   └── *.plan.json / *.todos.json   ← plan/todos sidecars
```

Session ID format: `YYYY-MM-DD/sess_<ULID>`
Example: `2026-06-09/sess_01JX2S9V7T5M6N7P8Q9R0STXVW`

### Session JSONL Events

```jsonl
{"type":"session_start","ts":"...","id":"...","model":"...","provider":"..."}
{"type":"user_input","ts":"...","content":[...]}
{"type":"checkpoint","ts":"...","promptIndex":0,"promptPreview":"..."}
{"type":"file_snapshot","ts":"...","promptIndex":0,"files":[...]}
{"type":"in_flight_start","ts":"...","context":"iteration 0 / max 100"}
{"type":"llm_request","ts":"...","model":"...","estimatedInputTokens":45000}
{"type":"llm_response","ts":"...","content":[...],"stopReason":"end_turn","usage":{...}}
{"type":"tool_result","ts":"...","id":"...","content":"...","isError":false}
{"type":"compaction","ts":"...","before":50000,"after":35000,"level":"soft"}
{"type":"in_flight_end","ts":"...","reason":"clean"}
{"type":"session_end","ts":"...","usage":{...}}
```

### FileSessionWriter

```ts
class FileSessionWriter {
  // Lazy init: writes session_start on first append()
  // Secret scrub: scrubs user_input + llm_response before write
  // Summary tracking: updates in-memory stats on each append
  // Best-effort append: failures logged, never crash agent

  async append(event): void    // Write JSON line + observe for summary
  async writeCheckpoint(idx, preview): void  // Checkpoint + file_snapshot
  async writeInFlightMarker(context): void   // in_flight_start
  async clearInFlightMarker(reason): void    // in_flight_end
  async close(): void           // session_end + summary.json + index entry
}
```

### Crash Detection — SessionRecovery

```ts
detectStale(sessionId): StaleSession | null
  // Read last 8KB of JSONL (O(1) I/O)
  // If last event is in_flight_start (no matching in_flight_end) → stale
  // Returns: { sessionId, path, lastEventTs, context, eventCount }
```

### Session Rewinder

```ts
rewindToCheckpoint(sessionId, checkpointIndex):
  // 1. Read all events
  // 2. Find target checkpoint
  // 3. Collect file_snapshots after checkpoint
  // 4. Revert files to "before" content
  // 5. Truncate session log at checkpoint
  // 6. Emit session.rewound event
```

### Session Replay

```ts
replay(events, sessionId): { messages: Message[], usage: Usage }
  // Reconstruct conversation from JSONL events
  // Track open tool_use → pair with tool_results
  // Emit session.damaged for orphan tool_results
  // Run repairToolUseAdjacency on output
```

### Audit Levels

```
MINIMAL  → Events needed for session reconstruction only
           session_start, user_input, llm_response, tool_result,
           checkpoint, file_snapshot, in_flight_*, session_end

STANDARD → Minimal + high-value audit events
           + llm_request, tool_use, tool_call_start/end,
             compaction, error, provider_retry/error

FULL     → Everything, with sampling
           + tool_progress (every 8th, first always preserved)
           + all plugin custom events
```

### Session Index

`_index.jsonl` — one line per closed session. Tombstone entries for deleted
sessions. Auto-compacts every 30 appends (dedup, remove tombstones, keep
latest). `rebuildIndex()` rescans all sessions on disk for recovery.

---

## 10. Memory Store

### Three Scopes

```ts
files: Record<MemoryScope, string> = {
  'project-agents': '<project>/.wrongstack/AGENTS.md',       // committed, shared
  'project-memory': '~/.wrongstack/projects/<hash>/memory.md', // per-project
  'user-memory':    '~/.wrongstack/memory.md',                // global, personal
};
```

### Entry Format

```markdown
- [2026-06-09T14:30:00.000Z] [convention|high] mem_1717952000_a1b2 Use conventional commits #git #commit
- [2026-06-08T10:00:00.000Z] [anti_pattern|high] mem_1717866000_c3d4 Never use `any` in TypeScript #typescript
```

Fields: timestamp, type|priority (optional), entry ID (optional), text, #tags

Memory types: `fact`, `decision`, `convention`, `preference`, `reference`, `anti_pattern`
Priority levels: `critical`, `high`, `medium`, `low`

### Serialization

Per-scope write chain prevents read-modify-write race conditions:

```ts
async runSerialized(scope, work):
  prior = writeChain.get(scope) ?? Promise.resolve()
  next = prior.catch(() => undefined).then(work)
  writeChain.set(scope, next)
  return await next
```

### Relevance Scoring

```ts
scoreRelevant(ctx, scope, limit=8): ScoredEntry[]
  for each entry:
    score = 0
    // Word overlap with current task (primary signal)
    for w in taskWords:
      if text.includes(w): score += 2
      if tags.includes(w): score += 3

    // Skill/tool relevance
    for w in skillWords: score += 1 if matched
    for w in toolWords: score += 1 if matched

    // Priority boost: critical +5, high +3, medium +1, low -2
    // Type boost: anti_pattern +3, decision +2, convention +2, preference +1
    // Recency: <1 day +1, >30 days -1
    // Confidence penalty: <0.5 → -2
    // Repetition avoidance: accessed <1hr ago → -1

  // Filter by minimum threshold (2) or critical/high priority
  return top N by score, max 15
```

### Memory Consolidation

```ts
remember(text, scope, metadata?):
  // 1. Append entry to backend
  // 2. Check size: if > MAX_BYTES_TOTAL (32KB / ~8K tokens)
  //    → auto-consolidate: evict oldest low-priority entries
  // 3. Mirror to project backup if in temp sandbox
  // 4. Emit memory.remembered event
```

### Memory Consolidator (Session-End Learning)

After each session (`afterRun` hook), the consolidate LLM reviews the session
summary and suggests memory operations:

```json
{
  "operations": [
    { "action": "add", "text": "Auth logic in packages/core/src/auth/",
      "type": "reference", "priority": "high", "tags": ["auth", "core"] },
    { "action": "delete", "query": "old auth pattern" }
  ]
}
```

### Mirror Backup

Detects temp sandbox environments (opencode, CI) by checking if global root
contains `/tmp/`, `/temp/`, or `/cache/`. When detected, mirrors memory
files to `<project>/.wrongstack/memory-persist/` so they survive cleanup.

---

## 11. Skill System

### Discovery Order (Shadowing)

```
1. Project-committed:  <project>/.wrongstack/skills/<name>/SKILL.md
2. User-global:        ~/.wrongstack/skills/<name>/SKILL.md
3. Bundled:            packages/core/skills/<name>/SKILL.md
```

Higher priority shadows lower. Same-named skill in project dir wins over bundled.

### Skill Format

```markdown
---
name: node-modern
description: |
  Use this skill when writing or reviewing Node.js >= 22 TypeScript code.
  Triggers: user mentions "node", "esm", "fetch", "AbortSignal".
version: 1.0.0
---

# Modern Node.js (>= 22) — WrongStack

## Rules
1. Always use ESM...
```

Frontmatter fields: `name` (kebab-case), `description` (first sentence = trigger),
`version` (semver).

### Trigger Extraction

The first sentence of `description` is the trigger — used for skill activation:

```ts
parseDescription(raw):
  desc = parseFrontmatter(raw).description
  firstSentenceEnd = desc.indexOf('. ')
  trigger = desc.slice(0, firstSentenceEnd + 1).trim()
  scope = extract parenthetical items ("Covers A, B, C" → ['A', 'B', 'C'])
```

### Prompt Integration

**Layer 3 (Environment) — compact skill list:**
```markdown
## Skills in scope for this session
- **node-modern**  (writing or reviewing Node.js >= 22 TypeScript code…)
- **bug-hunter**   (scanning source code for bugs, anti-patterns…)
```

**Layer 4 (Memory + Skills) — full skill bodies:**
```markdown
# Active Skills

## Skill: node-modern

# Modern Node.js (>= 22) — WrongStack
## Rules...
```

### Cache Strategy

```ts
class DefaultSkillLoader {
  private cache?: SkillManifest[];       // session-lifetime cache
  async list(): if cache return cache;   // discover once
  async readBody(name): string;          // full SKILL.md content
  invalidateCache(): void;              // force re-discovery
}
```

---

## 12. Multi-Agent Coordination

### Architecture — Four Layers

```
┌─────────────────────────────────────────────────┐
│ DIRECTOR (LLM-driven orchestrator)               │
│ 15+ director tools: spawn, assign, awaitTasks,   │
│ terminate, fleetStatus, fleetUsage, rollUp,      │
│ askSubagent, workComplete, collabDebug            │
├─────────────────────────────────────────────────┤
│ FLEET MANAGER (policy container)                  │
│ canSpawn? maxSpawns? maxCost? contextPressure?   │
│ FleetBus, FleetUsageAggregator, manifest          │
├─────────────────────────────────────────────────┤
│ COORDINATOR (task dispatch loop)                  │
│ spawn → assign → tryDispatchNext → runDispatched │
│ Concurrency control, budget enforcement          │
├─────────────────────────────────────────────────┤
│ SUBAGENT RUNNER (actual LLM execution)           │
│ Agent.run() with own context, tools, provider    │
└─────────────────────────────────────────────────┘
```

### Coordinator — Dispatch Loop

```ts
class DefaultMultiAgentCoordinator {
  subagents: Map<string, SubagentEntry>   // idle/running/stopped
  pendingTasks: TaskSpec[]                // queued tasks
  inFlight: number                        // currently executing

  tryDispatchNext():
    while canDispatch():  // inFlight < maxConcurrent && pendingTasks > 0
      task = takeNextDispatchableTask()
      // Find idle subagent, assign, increment inFlight
      runDispatched(subagentId, task)
      // On completion: recordCompletion(), inFlight--, tryDispatchNext()

  canDispatch():
    return inFlight < maxConcurrent && pendingTasks.length > 0
}
```

**Dead-end detection:** If all subagents are stopped and pending tasks remain,
drain them as `aborted_by_parent` — prevents infinite wait on a dead fleet.

### Subagent Lifecycle

```
1. SPAWN → status='idle'
2. ASSIGN → pendingTasks queue
3. DISPATCH → runDispatched → status='running'
   └─ Agent.run(task) with subagent budget
4. COMPLETION → recordCompletion → status='idle'
   ├─ inFlight--
   ├─ tryDispatchNext (next task)
   └─ task.completed event
5. TERMINATE → abortController.abort() → status='stopped'
```

### Delegate Tool

Single-call interface for the model: spawn + assign + await in one tool call.

```ts
delegate({ task, role?, name?, timeoutMs?, maxIterations?, maxToolCalls? })
  // 1. Auto-promote host to director mode
  // 2. spawn_subagent(role or name)
  // 3. assign_task(subagentId, task)
  // 4. await_tasks(taskId) → result
```

Parallel delegation: fire multiple delegate calls through provider's
parallel-tool-call surface.

### Fleet Manager

Policy decisions and observability:

```ts
class FleetManager {
  canSpawn(config): error | null
    // Checks: spawnDepth, spawnCount, maxCost, leaderContextPressure
    // Context pressure gate: reject if leader context ≥ 85% full

  recordSpawn(subagentId, config): void
    // Increment spawnCount, add to manifest

  snapshot(): FleetUsage
    // Total and per-subagent token/cost breakdown

  fleet: FleetBus           // fleet-wide event bus
  usage: FleetUsageAggregator  // token/cost tracking
}
```

### Subagent Budget

Each subagent has independent limits:
- `maxIterations`, `maxToolCalls`, `maxTokens`, `maxCostUsd`
- `timeoutMs` (wall-clock), `idleTimeoutMs` (inactivity)

Budget threshold reached → `budget.threshold_reached` event →
coordinator extends or denies → `subagent.budget_extended` event.

Auto-extend: coordinator can automatically extend budgets when a limit is hit.

### Roster — Pre-defined Subagent Roles

30+ agent roles with tuned prompts:

```
audit-log, bug-hunter, refactor-planner, security-scanner,
critic, explorer, search, research, analyst, planner,
architect, executor, refactor, simplifier, migration,
vision, debugger, tracer, test, e2e, browser,
performance, chaos, code-reviewer, security-reviewer,
accessibility, compliance, database, api, auth, data,
frontend, backend, designer, document, uml, i18n,
prompt, git, release, devops, observability,
dependency, skill-manage, self-improving, context, cost, tech-stack
```

---

## 13. Autonomous / Eternal Mode

### Goal Architecture

```json
{
  "version": 1,
  "goal": "improve test coverage across all packages",
  "refinedGoal": "Achieve ≥80% line coverage...",
  "deliverables": ["≥80% coverage in core/", "≥80% coverage in tools/"],
  "progress": 65,
  "progressNote": "core done (82%), tools at 58%",
  "progressTrend": "steady",
  "setAt": "2026-06-09T10:00:00Z",
  "lastActivityAt": "2026-06-09T14:30:00Z",
  "iterations": 142,
  "engineState": "running",
  "goalState": "active",
  "todoAttempts": { "todo-1": 2 },
  "journal": [
    { "iteration": 142, "source": "todo", "task": "...",
      "status": "success", "tokens": { "input": 45000, "output": 3200 }, "costUsd": 0.023 }
  ]
}
```

Storage: `~/.wrongstack/projects/<slug>/goal.json` — single canonical location
shared by `/goal` slash command, TUI F9 panel, and autonomy engines.

### EternalAutonomyEngine — Full Loop

```ts
run():
  persistEngineState('running')
  while !stopRequested:
    runOneIteration()
    if transient failure: exponential backoff (2s → 60s cap)
    sleep(cycleGapMs ?? 1000)

runOneIteration():
  // SENSE
  goal = loadGoal(goalPath)
  if !goal || goalState ≠ 'active' → stop

  // DECIDE — three sources, priority order:
  // 1. pickPendingTodo (stuck detection: max 3 attempts per todo)
  // 2. pickGitTask (dirty working tree)
  // 3. brainstormTask (LLM: "what should I do next?")

  // EXECUTE
  result = agent.run(directive, {
    autonomousContinue: true,
    maxIterations: 500,       // inner loop cap
    signal: AbortSignal(5min)  // iteration timeout
  })
  // Model uses [continue]/[done]/[GOAL_COMPLETE] markers

  // REFLECT
  bumpTodoAttempt (if failed)
  capture token/cost delta
  appendJournal(entry)
  parseProgressFromText → updateProgress()
  check GOAL_COMPLETE / GOAL_CLEAR markers
  maybeCompact (every 25 iterations or 85% pressure)
  sleep(cycleGapMs) or exponential backoff
```

### Decision Sources

**1. TODO:** Pending items from `agent.ctx.todos`. Stuck detection: max
`todoMaxAttempts` (3) per todo — after that, rotate to other sources.

**2. GIT:** Dirty working tree from `git status --porcelain`. Task: "Inspect
dirty working tree and either finish in-progress work or revert it."

**3. BRAINSTORM:** LLM-powered decision. Prompts: "Output ONE concrete,
immediately-actionable task that advances the goal." Returns `BRAINSTORM_DONE`
sentinel when no work remains. 3 consecutive DONE responses → consult brain
for completion verification.

### Directive Builder

Each iteration sends a rich directive to the agent:

```
═══ ETERNAL AUTONOMY — iteration directive ═══

Mission: improve test coverage
Iteration: #143
Source: todo
Task: Add tests for config-loader.ts edge cases

── EXECUTION PROTOCOL ──
1. EXECUTE END-TO-END — use [continue]/[done] markers
2. UPDATE TODO STATE — mark in_progress before work, completed/cancelled after
3. MISSION-COMPLETE PROTOCOL — [GOAL_COMPLETE] only when verifiably done
4. NO INTERACTIVITY — user is asleep, don't ask questions
```

### Autonomy Brain — Risk-Gated Decisions

```ts
createAutonomyBrain({ provider, model, maxAutoRisk = 'high' }):
  decide(request):
    // 1. RISK GATE — request risk > maxAutoRisk → auto-deny
    // 2. HEURISTIC — deadlock → skip, retry-exhausted → move on
    // 3. LLM EVALUATION — complex decisions via mini LLM call
```

Risk levels: `low(0) < medium(1) < high(2) < critical(3)`.
Brain's own LLM prompt: "PREFER CONTINUATION. Default answer is always continue."

### Progress Tracking

Model emits `[PROGRESS: N%]` in final text. Engine parses and records:

```ts
parseProgressFromText(text): { progress, note? }
  // Matches: [PROGRESS: 72%], [progress: 100%] — 3/5 deliverables done

recordProgress(goal, progress, note):
  // Append to progressHistory (last 200)
  // Compute trend: accelerating (avgΔ > 2), stalling (avgΔ < -1), steady
```

### Transient Failure Recovery

Exponential backoff for recoverable errors (rate limits, network):

```
computeTransientBackoffMs():
  base * 2^retries, capped at 60s
  retry 1: 2s, retry 2: 4s, retry 3: 8s, retry 4: 16s, retry 5+: 60s
```

Sleep is interruptible — checks `stopRequested` every 250ms, so Ctrl+C
lands within 250ms even during a 60s backoff.

### Autonomy Prompt Contributor

Injects autonomy state into agent's system prompt every turn:

```markdown
## ETERNAL AUTONOMY — active mission

Mission: improve test coverage
Iteration: #143
Recent journal (last 5): ...

### Loop control markers
- [continue] — chain to next step
- [done] — sub-task finished
- [GOAL_COMPLETE] — mission verifiably done

### Operating principles
- YOLO is active, proceed without pre-confirming
- Mark todos in_progress before work, completed/cancelled when done
- If approach fails twice, pivot
```

Gating: suppressed for subagents, hidden when engine is not active,
hidden when goal is completed/abandoned. Tagged `ephemeral`
for prompt cache compatibility.

### Parallel Eternal Engine

Multi-agent fan-out variant. Each iteration spawns N parallel subagents
(1–16 slots). Decompose → fan-out → aggregate → loop.

Uses `DefaultMultiAgentCoordinator` + `AgentSubagentRunner` for subagent
lifecycle. Optional smart dispatch routes each slot task to the best-fit
catalog agent via heuristic keyword scoring.

---

## 14. MCP Client

### Three Transports

| Transport | Mechanism | Use Case |
|-----------|-----------|----------|
| **stdio** | Child process spawn, pipe JSON-RPC | Local MCP servers (npx, uvx) |
| **sse** | HTTP SSE (server→client) + POST (client→server) | Remote MCP servers, event-driven |
| **streamable-http** | Session-based HTTP, NDJSON responses | Next-gen MCP servers |

### Connection Protocol (JSON-RPC 2.0)

```jsonc
// REQUEST
{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}

// RESPONSE
{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"read_file","inputSchema":{...}}]}}

// NOTIFICATION (no id)
{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}

// ERROR
{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}
```

### stdio Transport Lifecycle

```ts
connectStdio():
  // 1. Spawn child process (shell:true on Windows for .cmd shims)
  child = spawn(command, args, { stdio: ['pipe','pipe','pipe'] })

  // 2. stdout → JSON-RPC parser
  child.stdout.on('data', chunk → onData → onLine)

  // 3. stderr intentionally discarded (server logs, not protocol)

  // 4. Child exit → fail pending requests + notify registry (reconnect)

  // 5. MCP handshake
  initialize → initialized → tools/list → normalizeMCPTools
```

Request-response matching via `pending: Map<id, { resolve, reject, timer }>`.

### Tool Wrapping

```ts
wrapMCPTool(serverName, mcpTool, client, permission='confirm'): Tool
  qualifiedName = `mcp__${serverName}__${mcpTool.name}`
  // Example: mcp__filesystem__read_file

  return {
    name: qualifiedName,
    permission,
    mutating: isMutatingTool(mcpTool),  // name/schema heuristic
    inputSchema: mcpTool.inputSchema,
    async execute(input) {
      res = await client.callTool(mcpTool.name, input)
      if res.isError: throw Error
      return stringify(res.content)
    }
  }
```

**Mutating detection:** regex on tool name and inputSchema property names:
`/create|update|delete|write|send|set|put|post|patch|remove|rename|move/i`

### Connection Lifecycle — Reconnect with Backoff

```
Disconnect → scheduleReconnect
  ├─ Max 5 reconnect cycles
  ├─ Exponential backoff: 1s → 2s → 4s → 8s → 16s (cap 30s)
  ├─ ±20% jitter to prevent reconnect stampedes
  └─ Each cycle: up to 3 connection attempts
      └─ 500ms * 2^attempt between attempts

Failed after 5 cycles → manual restart() required
```

### `tools/list_changed` — Dynamic Tool Updates

Server sends notification → client re-fetches tool list → registry
unregisters old tools → wraps and registers new tools. Tools cache
survives reconnects so re-registration doesn't require re-discovery.

### Security Checks

- URL validation: blocks IMDS addresses (169.254.x.x, fe80–febf, fd00:ec2::254)
- HTTP only allowed for loopback; remote servers must use HTTPS
- MCP tools auto-DENY for subagents (via AutoApprovePermissionPolicy)
- Windows: `shell: true` for .cmd shims, but command comes from config, not model

---

## 15. TUI Architecture

### Technology Stack

- **React/Ink**: React for terminal rendering (ANSI escape codes)
- **Single process**: Agent + TUI in same Node.js process
- **Direct EventBus**: No proxy — subscribes directly to agent events
- **useReducer**: Single reducer manages all TUI state (~30 fields)

### State Management

```tsx
const [state, dispatch] = useReducer(reducer, {
  entries: [],           // history: banner, user, assistant, tool, info, error
  buffer: '',            // input buffer
  cursor: 0,             // cursor position
  streamingText: '',     // live streaming text (throttled)
  toolStream: null,      // live tool output box
  status: 'idle',        // idle | running | streaming
  runningTools: Map,     // { id → { name, startedAt } }
  fleet: {},             // { subagentId → FleetEntry }
  leader: {              // leader agent stats for AgentsMonitor
    iterations, toolCalls, recentTools, currentTool, ctxPct
  },
  picker: {},            // @-mention file picker
  slashPicker: {},       // slash command picker
  modelPicker: {},       // two-step provider → model picker
  settingsPicker: {},    // 19-field settings editor
  confirmQueue: [],      // permission confirmation prompts
  enhance: {},           // prompt refinement preview
  escConfirm: null,      // exit confirmation overlay
  fleetCost: 0,          // cumulative fleet cost
  fleetTokens: {},       // fleet token breakdown
  // ... + overlay flags, git info, plan counts, checkpoints, etc.
})
```

### Event Bridge — Direct EventBus Subscription

```tsx
useEffect(() => {
  const offDelta = events.on('provider.text_delta', (e) => {
    streamingTextRef.current += e.text;       // synchronous accumulation
    pendingDeltaRef.current += e.text;        // throttle buffer
    if (!flushTimerRef.current)
      flushTimerRef.current = setTimeout(flush, 100);  // 10fps throttle
  });

  const offToolStart = events.on('tool.started', (e) => {
    dispatch({ type: 'toolStarted', id: e.id, name: e.name });
  });

  const offTool = events.on('tool.executed', (e) => {
    dispatch({ type: 'addEntry', entry: { kind: 'tool', name: e.name, ... } });
    dispatch({ type: 'toolEnded', name: e.name });
  });

  // ... 20+ event listeners

  return () => { offDelta(); offToolStart(); offTool(); /* ... */ };
}, [events]);
```

### Streaming Text Throttle

Two representations of streaming text:

- `streamingTextRef.current` — always complete, read synchronously after
  `agent.run()` returns (avoids throttle race)
- `state.streamingText` — throttled at ~10fps via `flushTimer` for render

The ref prevents the final chunk from leaking into the next frame's scrollback.

### Input Pipeline

```
stdin keypress → Ink <Input> → handleKey(key)
  ├─ Escape → steering mode (abort + redirect)
  ├─ Enter  → submit(text)
  │           ├─ /slash → dispatch to slash command registry
  │           ├─ @file  → file picker token resolution
  │           └─ normal → agent.run(text) via runBlocks
  ├─ Ctrl+C → abort (first: abort agent; second: confirm exit)
  ├─ Ctrl+S → settings picker
  ├─ Ctrl+V / Alt+V → clipboard image paste
  ├─ Ctrl+P/↑ / Ctrl+N/↓ → input history navigation
  ├─ Tab → picker selection cycle
  └─ Backspace → smart deletion (respects inline tokens)
```

### Ink Rendering — Static vs Live

```tsx
<Box>
  {/* Static: rendered once, never changes (scrollback) */}
  <Static items={state.entries}>
    {(entry) => <HistoryEntry entry={entry} />}
  </Static>

  {/* Live: re-rendered every frame */}
  <LiveActivityStrip fleet={fleetEntries} />
  <Input buffer={state.buffer} ... />
  <StatusBar status={state.status} ... />
</Box>
```

### Status Bar — Live Polling

State that lives outside React (agent.ctx, permission policy, engine):

```tsx
// Every 2s: poll autonomy, yolo, mode, model, provider (all sync reads)
const poll = () => {
  const a = getAutonomy?.() ?? 'off';
  const y = getYolo?.() ?? false;
  const m = getModeLabel?.() ?? '';
  const curModel = agent.ctx.model;
  const curProvider = agent.ctx.provider?.id ?? '';
  if (changed) { setAutonomyLive(a); setYoloLive(y); /* ... */ }
};
setInterval(poll, 2000);

// Every 5s: git branch + change counts (subprocess)
setInterval(() => readGitInfo(cwd).then(setGitInfo), 5000);

// Every 2s: todo counts (agent.ctx.todos array)
setInterval(() => {
  const snap = JSON.stringify(todos.map(t => t.status));
  if (snap !== prev) triggerRerender();
}, 2000);
```

Status bar chips: `⬢ teach │ ● running │ ⚡ YOLO │ ⏱ 2m │ 📋 3/5 │
🚀 2 running │ 🌿 main ≡1 ●3 │ ████░░ 67% │ $0.0423`

### Terminal Resize Handling

When terminal resizes, ANSI escape sequences corrupt. TUI closes all
overlays, erases live region (`\x1b[J`), waits 300ms for terminal
to settle at new dimensions, then restores overlays.

---

## 16. WebUI Architecture

### Technology Stack

- **React/Vite**: React DOM rendering with Tailwind CSS
- **Separate process**: Agent (CLI) ↔ WebSocket ↔ Browser
- **Zustand**: Multi-store state management
- **WebSocket**: EventBus events proxied as JSON messages

### State Management — Zustand Stores

```tsx
function AppInner() {
  const { currentView, sidebarOpen } = useUIStore();
  const isLoading = useChatStore(s => s.isLoading);
  const iteration = useSessionStore(s => s.iteration);
  const goal = useGoalStore(s => s.goal);
  const worktrees = useWorktreeStore(s => s.worktrees);

  return (
    <div className="flex h-screen">
      {sidebarOpen && <Sidebar />}
      <main>
        <ConnectionBanner />
        <GoalPanel goal={goal} />
        <FleetPanel />
        <TodosPanel />
        {worktrees.length > 0 && <WorktreeGraph />}
        <ChatView />
      </main>
      <ConfirmDialog />
      <CommandPalette />
      <QuickModelSwitcher />
    </div>
  );
}
```

### WebSocket Transport

```tsx
useWebSocketBootstrap():
  ws = new WebSocket(wsUrl)

  ws.onmessage = (event) => {
    msg = JSON.parse(event.data)
    switch msg.type:
      case 'text_delta':    chatStore.append(msg.text)
      case 'tool_started':  chatStore.addToolEntry(msg)
      case 'tool_executed': chatStore.addToolResult(msg)
      case 'session_update': sessionStore.update(msg)
      case 'confirm_needed': uiStore.openConfirm(msg)
  }

  // Client → Server:
  ws.send({ type: 'user_input', text: message })
  ws.send({ type: 'confirm_response', decision: 'yes' })
  ws.send({ type: 'clear_context' })
```

### Keyboard Shortcuts

```
Ctrl+\       → toggle sidebar
Ctrl+F       → search overlay
Ctrl+/       → focus chat textarea
Ctrl+L       → clear chat (outside inputs)
Ctrl+N       → new session
Ctrl+Shift+D → compact mode toggle

Vim-style chat navigation (outside inputs):
j / ArrowDown → next message
k / ArrowUp   → previous message
g             → first message
G             → last message
c             → copy focused message
Escape        → clear focus
```

---

## 17. End-to-End Data Flow

### Complete Iteration

```
╔═══ 1. INPUT ═══════════════════════════════════════════╗
║ User: "fix the bug in auth.ts"                         ║
║   ↓                                                    ║
║ userInput pipeline → ctx.state.appendMessage(user)     ║
║ session.writeCheckpoint + file_snapshot                 ║
║ session.writeInFlightMarker                             ║
╚════════════════════════════════════════════════════════╝
                         ↓
╔═══ 2. SENSE ═══════════════════════════════════════════╗
║ SystemPromptBuilder.build(ctx) → 6 layers              ║
║ repairToolUseAdjacency                                  ║
║ request pipeline → Request{model,system,msgs,tools}    ║
║ session.append(llm_request)                             ║
╚════════════════════════════════════════════════════════╝
                         ↓
╔═══ 3. DECIDE ══════════════════════════════════════════╗
║ wrapProviderRunner hook                                 ║
║ provider.stream(Request) → SSE → StreamEvent[]         ║
║   provider.text_delta → TUI live rendering             ║
║ recordActualUsage → EWM calibration (α=0.3)            ║
╚════════════════════════════════════════════════════════╝
                         ↓
╔═══ 4. REFLECT ═════════════════════════════════════════╗
║ response pipeline                                       ║
║ tokenCounter.account(usage) → cost tracking            ║
║ assistant output render → [continue]/[done] parse      ║
║ ctx.state.appendMessage(assistant)                      ║
║ session.append(llm_response)                            ║
╚════════════════════════════════════════════════════════╝
                         ↓
╔═══ 5. EXECUTE (if tool_use) ═══════════════════════════╗
║ beforeToolExecution hook                                ║
║ ToolExecutor.executeBatch(strategy)                     ║
║   ├─ HARD GATE: inputSchema validation                 ║
║   ├─ PermissionPolicy.evaluate() — 9-step tree         ║
║   ├─ executeTool → serialize → scrub → cap             ║
║   └─ toolCall pipeline                                 ║
║ ctx.state.appendMessage(user with tool_results)         ║
║ afterToolExecution hook                                 ║
╚════════════════════════════════════════════════════════╝
                         ↓
╔═══ 6. WRAP-UP ═════════════════════════════════════════╗
║ ctx.pct event (context fill %)                          ║
║ compaction (if load ≥ threshold)                        ║
║   → elision → collapse → repair                         ║
║ iteration.completed event                               ║
║ session.clearInFlightMarker                             ║
║ tool_use? → next iteration : done                       ║
╚════════════════════════════════════════════════════════╝
                         ↓
╔═══ 7. TEARDOWN ════════════════════════════════════════╗
║ afterRun hook → MemoryConsolidator                     ║
║ controller.dispose() → abort hooks (LIFO)              ║
║ session.close() → summary.json + index                 ║
║ agent.teardown() → plugins (reverse order)             ║
╚════════════════════════════════════════════════════════╝
```

### Security — Defense in Depth

```
L1: TOOL DECLARATION — permission, mutating, riskTier, capabilities
L2: INPUT VALIDATION — JSON Schema, malformed detection, PreToolUse hook
L3: PERMISSION POLICY — 9-step decision tree, trust file, YOLO
L4: DANGEROUS CAP ENFORCEMENT — YOLO gate, subagent deny
L5: OUTPUT SANITIZATION — SecretScrubber, SecretVault
```

### Cross-Cutting Concerns

```
OBSERVABILITY:   EventBus (50+ events), SessionEventBridge,
                 TokenCounter, Tracer (OTel)

SECURITY:        PermissionPolicy, Capabilities, SecretScrubber,
                 SecretVault, Path containment

PERSISTENCE:     SessionStore (JSONL + index), GoalStore (goal.json),
                 MemoryStore (3-scope Markdown), TrustStore

EXTENSIBILITY:   Plugins, Pipelines (6), Hooks, Skills,
                 Modes, SystemPromptContributors
```

---

## 18. ACP Ensemble Integration

WrongStack is a first-class peer in the [Agent Client Protocol v1](https://agentclientprotocol.com/get-started/introduction) — both as a client (drives external agents like Claude Code, Gemini CLI, Codex CLI, OpenCode, Cline) and as a server (external editors like Zed, JetBrains Junie, VS Code ACP can drive WrongStack). The "ensemble" feature fans a single task out to multiple agents in parallel and aggregates the results.

### Where it lives

```
packages/acp/                    v1 client + server + ensemble
  types/acp-v1.ts                v1 type definitions, discriminated SessionUpdate
  registry/
    agents.catalog.ts            12-entry static catalog
    ensemble-registry.ts         $PATH probe, 5s cache
  client/                        v1 client (WrongStack → external agents)
    acp-session.ts               state machine (initialize → session/new → session/prompt)
    file-server.ts               sandboxed fs/* methods
    terminal-server.ts           sandboxed terminal/* methods
    permission.ts                permission UX
  agent/                         v1 server (external editor → WrongStack)
    protocol-handler.ts          v1 method set
    wrongstack-acp-agent.ts      bootstrap binary (no-op echo by default)
    server-agent-turn.ts         real Agent → server adapter
    stdio-transport.ts           JSON-RPC 2.0 over stdio
  integration/
    acp-subagent-runner.ts       single-agent runner
    ensemble-runner.ts           multi-agent orchestrator
```

### Two roles, one protocol

```
                        ┌──────────────────────────────────┐
                        │       WrongStack CLI / TUI       │
                        │  /spawn claude-code "refactor"   │
                        │  /ensemble claude-code,gemini-cli│
                        │  wstack acp parallel <csv> <task>│
                        └──────────┬───────────────────────┘
                                   │ SubagentRunner
                                   ▼
                        ┌──────────────────────────────────┐
                        │  packages/acp                    │
                        │  ┌──────────────────────────┐    │
                        │  │  EnsembleRegistry        │    │
                        │  │  ── $PATH probe, 5s cache│    │
                        │  └──────────────────────────┘    │
                        │  ┌──────────────────────────┐    │
                        │  │  ACPSession (per agent)  │    │
                        │  │  ── v1 state machine     │    │
                        │  │  ── stream → bridge      │    │
                        │  │  ── session/cancel on    │    │
                        │  │     AbortSignal          │    │
                        │  └──────────────────────────┘    │
                        │  ┌──────────────────────────┐    │
                        │  │  runEnsemble()           │    │
                        │  │  ── Promise.allSettled   │    │
                        │  │  ── skip / fail / cancel │    │
                        │  └──────────────────────────┘    │
                        └──┬──────┬──────┬────────────────┘
                           │stdio │stdio │stdio
                           ▼      ▼      ▼
                        claude  gemini  codex
```

### User-facing surfaces (three entry points to the same `runEnsemble`)

| Surface | Command | Renderer |
|---|---|---|
| CLI | `wstack acp parallel <csv> <task>` | Formatted text block |
| TUI/REPL | `/ensemble <csv> <task>` | Same text block in chat history |
| Programmatic | `import { runEnsemble } from '@wrongstack/acp'` | Caller's choice |

### v1 wire format (key methods)

| Method | Direction | Triggered by |
|---|---|---|
| `initialize` | request → result | First message on the wire; negotiates `protocolVersion: 1` |
| `session/new` | request → result | Client opens a new conversation |
| `session/prompt` | request → result | Client sends the user's text |
| `session/cancel` | notification | Client aborts (Ctrl-C / AbortSignal) |
| `session/update` | notification | Agent streams chunks, tool calls, plan entries, usage |
| `fs/read_text_file`, `fs/write_text_file` | request → result | Agent asks to read/write a project file |
| `terminal/create`, `terminal/output`, `terminal/kill`, … | request → result | Agent wants to run a shell command |
| `session/request_permission` | request → result | Agent asks the user before a risky action |

### Live catalog on this host (8 of 12 detected)

```
✓ claude-code    2.1.178   ✓ gemini-cli     0.45.1
✓ codex-cli      0.139.0   ✓ copilot        github
✓ cline          11.11.0   ✓ qwen-code      0.16.0
✓ kiro-cli       0.12.224  ✓ opencode       1.15.5
— goose          (not installed)
— openhands      (not installed)
— mistral-vibe   (not installed)
— cursor         (not installed)
```

### Verified

- 14 test files / 153 tests pass + 1 skipped (live probe)
- All 16 packages typecheck clean
- End-to-end smoke test (`pnpm --filter @wrongstack/acp smoke`) walks a full v1 session and exits 0
- `wstack acp list`, `wstack acp spawn`, `wstack acp parallel` all functional
- `/ensemble` slash command wired into the REPL

### See also

- [`docs/acp-ensemble.md`](acp-ensemble.md) — full design doc (375 LoC)
- [`docs/subcommands/acp.md`](subcommands/acp.md) — CLI surface
- [`docs/slash/ensemble.md`](slash/ensemble.md) — `/ensemble` slash command
- [ACP v1 spec](https://agentclientprotocol.com/get-started/introduction)

---

### Key Numbers

```
33     built-in tools
50+    event types
25+    DI tokens
15     secret scrubber patterns
11     language detection markers
9      permission policy steps
6      system prompt layers
6      pipeline middleware points
5      security layers
3      compactor types
3      loop layers (internal, outer, eternal)
3      memory scopes
3      session audit levels
3      MCP transports
3      skill discovery paths
2      permission policies (normal + subagent)
1      kernel (~1670 lines incl. event types)
```

---

*Generated: 2026-06-09. This document reflects the architecture as examined
across the full WrongStack codebase.*

# Architecture

How WrongStack is wired together, from the bottom up.

---

## Package layout

```
packages/
  core/         types + kernel + defaults — the runtime, zero opinions
  providers/    Anthropic / OpenAI / Google / OpenAI-compatible adapters
  tools/        bash, read, write, edit, grep, …, plus the meta-tools
  mcp/          MCP client + registry + stdio/SSE/streamable-http transports
  cli/          REPL, subcommands, interactive pickers, slash commands, plugin management
  tui/          React/Ink terminal UI (lazy-loaded behind --tui)
  plug-lsp/     LSP bridge + language tooling + slash commands
  runtime/      Default runtime implementations and host-level composition helpers
  acp/          ACP server/client integration for external agent protocols
  plugins/      Bundled plugin library
  telegram/     Telegram bridge plugin — send messages, receive prompts, get notified
  skills/       Skill subpackages published independently
  webui/        Standalone Vite+React web UI (wstackui) + WS backend; also embeddable via --webui
apps/
  wrongstack/   bin entry — runs cli/main(argv)
```

Each package depends only on what's below it. `core` depends on nothing
WrongStack-internal; `providers`/`tools`/`mcp`/`plug-lsp`/`runtime`/`acp`/`plugins`/`telegram` depend on `core`;
`cli`/`tui`/`webui` compose the product-facing surfaces above those packages.

---

## The kernel (~1670 lines total)

`packages/core/src/kernel/` holds six modules (Container, Pipeline, EventBus,
RunController, Tokens, plus the full event type catalog). Nothing else in the
codebase is allowed to expand it without a strong reason.

### `Container`

A typed DI container indexed by `Token<T>` (a branded `symbol`). Bindings
support `factory`, `value`, and `decorator` forms; resolution is lazy and
memoized. The well-known tokens are in [`tokens.ts`](../packages/core/src/kernel/tokens.ts):

```
TOKENS.Logger          TOKENS.TokenCounter      TOKENS.SessionStore
TOKENS.MemoryStore     TOKENS.PermissionPolicy  TOKENS.Compactor
TOKENS.PathResolver    TOKENS.ConfigLoader      TOKENS.ConfigStore
TOKENS.Renderer        TOKENS.InputReader       TOKENS.ErrorHandler
TOKENS.RetryPolicy     TOKENS.SkillLoader       TOKENS.SystemPromptBuilder
TOKENS.SecretScrubber  TOKENS.ModelsRegistry    TOKENS.ModeStore
TOKENS.ProviderRunner  TOKENS.WorktreeManager   TOKENS.BrainArbiter
TOKENS.HookRegistry
```

The CLI binds defaults at boot; plugins can rebind any token before
`Agent.run`. There is no service-locator pattern — every dependency arrives
through the container explicitly.

### `Pipeline<T>`

Linear middleware over a value of type `T`. Six pipelines run per agent step:

| Pipeline | Value | Fires |
|---|---|---|
| `userInput` | `{ content, text, ctx }` | every user turn |
| `request` | `Request` | before each provider call |
| `response` | `Response` | after each provider call |
| `assistantOutput` | `TextBlock` | per assistant text block |
| `toolCall` | `{ toolUse, result, ctx, tool }` | after every tool call |
| `contextWindow` | `Context` | before sending if context might be too large |

Middleware shape:

```ts
const mw: Middleware<Request> = {
  name: 'my-mw',
  owner: 'my-plugin',
  handler: async (req, next) => {
    const before = perf.now();
    const out = await next(req);
    log('took', perf.now() - before);
    return out;
  },
};
```

`Pipeline` has a `setErrorHandler(fn)` so the host can decide
rethrow-vs-swallow when a plugin handler crashes. Default is rethrow.
`insertBefore`/`insertAfter`/`replace`/`remove` support position-aware
mutation of the chain; `asReadonly()` exposes a frozen view for plugins.

### `EventBus`

Typed pub/sub. Every meaningful runtime moment fires an event:
`iteration.started`, `iteration.completed`, `provider.text_delta`,
`provider.response`, `provider.retry`, `provider.error`,
`tool.started`, `tool.progress`, `tool.executed`, `tool.confirm_needed`,
`compaction.fired`, `compaction.failed`, `mcp.server.connected`,
`mcp.server.reconnected`, `mcp.server.disconnected`, and ~30 more.
See [`events.ts`](../packages/core/src/kernel/events.ts).

The CLI subscribes for spinner / live-tail / session-log; the TUI subscribes
the same events into React state; observability sinks subscribe via
`wireMetricsToEvents`. V2-D added `listenerCount()` for leak-detection.

### `RunController`

One per `Agent.run`. Owns the `AbortController`, chains the parent signal,
drains abort hooks when the run ends (LIFO order), and enforces cleanup
even on normal exit via `dispose()`. Hooks are snapshot before firing so
hooks added during cleanup don't re-trigger.

---

## `Context` and the L1-A reactive split

`Context` is the live agent-run object: messages, todos, system prompt,
session writer, tools, provider, signal, cwd, model, meta. It's the
parameter passed to every Tool's `execute(input, ctx, opts)`.

After L1-A:

- `Context implements RunEnv` — the read-only env interface (provider,
  session, signal, tokenCounter, cwd, projectRoot, model, systemPrompt,
  tools). Subsystems that only read declare `RunEnv` and accept any
  `Context` for free.
- `ctx.state: ConversationState` — observable wrapper over the mutable
  fields. `ctx.state.appendMessage(m)` and `ctx.state.replaceMessages(ms)`
  fire `onChange` events that the UI can subscribe to.
- The public `Tool.execute(input, ctx, opts)` API is **unchanged.** Tools
  that mutate `ctx.messages` directly still work; subscribers just don't
  see those mutations until the next state-routed write.

`Agent.run` and every compactor now route through `ctx.state`. Direct
mutation is reserved for legacy and external tool code.

```ts
const unsubscribe = ctx.state.onChange((change, state) => {
  if (change.kind === 'message_appended') updateUI(change.message);
});
```

---

## Agent lifecycle

```text
                   ┌───────────┐
   user input ────►│ Agent.run │
                   └─────┬─────┘
                         │   normalizeAndEmitUserInput
                         │     → userInput pipeline
                         │     → ctx.state.appendMessage
                         ▼
                   ┌──────────────────────────┐
                   │ for each iteration       │
                   │   checkIterationLimit    │
                   │   build request          │ ← request pipeline
                   │   runProviderWithRetry   │ ← provider.complete span
                   │   processResponse        │ ← provider.text_delta / response pipeline
                   │   if assistant text only → done
                   │   else: tool_use blocks  │
                   │     ToolExecutor.executeBatch
                   │       permission check   │
                   │       tool.execute(eS)  │ ← tool.<name> span
                   │       toolCall pipeline  │
                   │       ctx.state.append   │
                   │   compactContextIfNeeded │ ← contextWindow pipeline
                   │   loop                   │
                   └──────────────────────────┘
                         │
                         ▼
                   ┌─────────────┐
                   │ RunResult   │
                   └─────────────┘
```

Iteration cap is a soft limit: when reached, the agent fires
`iteration.limit_reached` and either auto-extends by 100 (default) or
waits for a listener to grant/deny. `autoExtendLimit` is configurable.

Errors at any layer are surfaced as `WrongStackError` (extends `Error`
with `code`, `severity`, `recoverable`). `RunResult.error` is typed
`WrongStackError | undefined`.

---

## Providers — declarative wire formats

A `Provider` adapts a model's HTTP API to the unified `complete` /
`stream` interface. Declarative providers use `WireFormatConfig`
presets, while the native Anthropic/OpenAI/Google classes keep custom
constructor options and share the same canonical stream events:

```ts
const config: WireFormatConfig<MyStreamState> = {
  id: 'my-llm',
  family: 'openai-compatible',
  capabilities,
  defaultBaseUrl: 'https://api.my-llm.com/v1',
  buildUrl: (baseUrl, req) => `${baseUrl}/chat/completions`,
  buildHeaders: (apiKey, req) => ({ authorization: `Bearer ${apiKey}` }),
  buildBody: (req) => ({ model: req.model, messages: req.messages, stream: true }),
  createStreamState: () => ({ ... }),
  parseStreamEvent: (event, state) => streamEvents,
  finalizeStream: (state) => [{ type: 'message_stop', stopReason, usage }],
};
```

`WireFormatProvider` consumes the config and gives you a fully-wired
`Provider`. The package also exports hand-written `AnthropicProvider`,
`OpenAIProvider`, `GoogleProvider`, and `OpenAICompatibleProvider`
classes for the common built-in transports.

See [`provider-author-guide.md`](provider-author-guide.md) for writing
a new one.

---

## Tools — the streaming contract

A `Tool` is the runtime-callable interface that the model invokes:

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
  subjectKey?: string;
  capabilities?: readonly string[];
  execute(input, ctx, opts): Promise<O>;
  executeStream?(input, ctx, opts): AsyncIterable<ToolStreamEvent<O>>;
  cleanup?(input, ctx): Promise<void>;
}
```

`riskTier` feeds the permission policy: YOLO auto-approves normal project work, while clearly destructive calls can still prompt unless `--yolo-destructive` is active.

When defined, `executeStream` is preferred: yields `log`, `partial_output`,
`metric`, `file_changed`, or `warning` events, then a terminal
`{ type: 'final', output }`. The executor publishes each event as
`tool.progress` on the EventBus; the TUI live-tails.

`ToolExecutor` runs tools with three strategies: `parallel` (all at once),
`sequential` (one after another), or `smart` (auto, defaults to parallel
when tools are independent). Output per iteration is capped and truncated
in `tool.executed` events to avoid flooding the session log.

See [`tool-author-guide.md`](tool-author-guide.md).

---

## Compactors

Three compaction strategies compose in `HybridCompactor`:

| Compactor | Strategy |
|---|---|
| `SelectiveCompactor` | preserves task-critical messages, elides the rest |
| `IntelligentCompactor` | LLM-assisted summarization of ancient turns |
| `LLMSelector` | picks the best model for context reduction decisions |

`AutoCompactionMiddleware` wraps the contextWindow pipeline and fires
compaction automatically when token threshold fractions are crossed
(`warnThreshold`, `softThreshold`, `hardThreshold`). Compaction is
best-effort — a failure fires `compaction.failed` but never aborts the
run.

Context-window behavior is policy-driven. `context.mode` selects one of
the built-in presets:

| Mode | Behavior |
|---|---|
| `balanced` | Default rolling compaction; preserves the recent tail and trims old heavy tool output. |
| `frugal` | Token-saver mode; compacts early and keeps a tighter verbatim tail. |
| `deep` | Long-reasoning mode; delays compaction and keeps more recent turns intact. |
| `archival` | Decision-preserving mode; compacts steadily while keeping summaries prominent. |

The active policy is copied into `ctx.meta.contextWindowPolicy` at boot
and can change during a session. `AutoCompactionMiddleware` reads that
policy before every provider turn, while `HybridCompactor` reads the same
policy to choose preservation depth and tool-result elision thresholds.
CLI users switch with `/context mode <id>`; WebUI clients can call
`context.modes.list` and `context.mode.switch`.

Manual context surgery is guarded by a provider-protocol repair pass.
`repairToolUseAdjacency` removes orphan `tool_use` / `tool_result` blocks
that can appear when summaries or prunes cut through a tool exchange. The
repair runs after context-manager mutations, after WebUI compact/repair
actions, when damaged sessions are replayed, and immediately before every
provider request as the final safety net. CLI users can force it with
`/context repair`; WebUI clients can send `context.repair`.

---

## Multi-agent

`DefaultMultiAgentCoordinator` manages a fleet of subagents with:

- Task queue with `maxConcurrent` (default 4) in-flight limit
- Per-subagent `SubagentBudget` (maxIterations, maxToolCalls, maxTokens,
  maxCostUsd, timeoutMs) with precedence: task > subagent > coordinator
- `AgentBridge` for bidirectional parent↔subagent messaging
- `BudgetExceededError` surfaced as `timeout` or `stopped` result status
- Subagent signal lifecycle (AbortController recycled between tasks so
  aborted subagents can take new work)

`makeAgentSubagentRunner()` wraps a regular `Agent` instance as a
`SubagentRunner`. The coordinator emits events such as `subagent.spawned`,
`subagent.task_started`, `subagent.task_completed`, `subagent.done`,
`subagent.budget_warning`, and `subagent.ctx_pct`.

For the **director-driven** evolution of this — where every subagent
runs with its own provider, model, context, session, and budget under
an LLM-driven Director agent — see
[director-architecture.md](director-architecture.md). The current
implementation exposes director/fleet orchestration tools and persists
fleet state under the project session directory.

---

## MCP integration

`MCPClient` speaks JSON-RPC 2.0 over three transports: `stdio` (child
process), `sse` (server-sent events), `streamable-http` (session-based
NDJSON). `MCPRegistry` manages a fleet of clients with:

- Exponential backoff + jitter on reconnect (capped at 5 cycles, then
  transitions to `failed` and surfaces in `/diag`)
- Tool-list cache that invalidates on `notifications/tools/list_changed`
- Tool namespace prefix: `mcp__<serverName>__`

Built-in presets in [`mcp-servers.ts`](../packages/core/src/infrastructure/mcp-servers.ts):
filesystem, github, context7, brave-search, block, everart, slack, aws,
google-maps, sentinel, zai-vision, and minimax-vision. All disabled by default.

---

## Plugins

Plugins declare `capabilities` (`tools`, `providers`, `slashCommands`,
`mcp`, `pipelines`) and receive a scoped `api`:

```ts
export default {
  name: 'my-plugin',
  apiVersion: '^0.1.0',
  capabilities: { tools: true },
  async setup(api) {
    api.tools.register(myTool);
  },
  async teardown() {
    // close handles, kill subprocesses, etc.
  },
};
```

The loader runs `teardown()` on SIGINT and natural exit. When a plugin
calls `api.tools.register` but `capabilities.tools !== true`, the loader
logs a warning.

See [`plugin-author-guide.md`](plugin-author-guide.md).

---

## Observability (opt-in, noop by default)

Three pillars, all behind interfaces with noop default impls:

| Pillar | Interface | Default | Opt-in via |
|---|---|---|---|
| Metrics | `MetricsSink` | `NoopMetricsSink` | `--metrics` CLI flag |
| Traces | `Tracer` | `NoopTracer` | bind a real `OTelTracer` |
| Health | `HealthRegistry` | `DefaultHealthRegistry` | enabled with `--metrics` |

Prometheus pull endpoint: `--metrics-port 9090` starts an HTTP server on
`127.0.0.1` exposing `/metrics` in v0.0.4 text format. Set
`METRICS_HOST=0.0.0.0` to bind publicly. OTLP exporters are also
available via `startOtlpMetricsExporter` / `startOtlpTraceExporter`.

`Agent.run` opens an `agent.run` span; per-iteration `agent.iteration`
spans and `provider.complete` spans nest inside. Tool spans are opened
by the ToolExecutor. Everything is noop unless you wire a real tracer.

---

## Session storage

JSONL files under `~/.wrongstack/projects/<hash>/sessions/<date>/sess_<ULID>.jsonl`.
Each line is one `SessionEvent`: `user_input`, `llm_request`, `llm_response`,
`tool_use`, `tool_result`, `compaction`, `error`, plus mode/task/agent/
skill events.

`DefaultSessionStore.list()` reads a session-scoped `.summary.json` sidecar
for fast listing; only damaged or pre-manifest sessions force a full parse.

`DefaultSessionReader` provides query/replay/search/export over the
store. Export formats: markdown, json, text.

---

## CLI entry shape

`packages/cli/src/index.ts` does:

1. Parse argv → flags + positional
2. `bootConfig(flags)` — resolve paths, create vault, migrate secrets, load config
3. Subcommand dispatch if `positional[0]` matches (`init`, `auth`, `mcp`, …)
4. Otherwise: pre-launch prompts (project check, mode, yolo) on interactive TTY
5. Wire container, registries, pipelines, system prompt builder, mcp registry,
   plugins, multi-agent coordinator
6. `runRepl(...)` or `runTui(...)` based on mode

The CLI knows nothing the plugins / providers / tools couldn't also do —
it's just the assembly of defaults + the interactive shell.

---

## WebUI

A Vite+React web UI served by the CLI via `--webui` (or standalone via the
`wstackui` binary). The server starts an HTTP server that mounts the
compiled React app and wires it to the same EventBus and session store as
the CLI/TUI, so all surfaces stay consistent with the agent run.

The standalone server lives in `packages/webui/src/server/` and was
decomposed from a single ~2954-line god module (`index.ts`) into 11
focused modules, each under 800 lines. The split preserves the package's
public API (`exports["./server"]` → `index.ts`) and every
`opts.services?` injection point the CLI's embedded `--webui` mode relies
on.

### Module map

```
packages/webui/src/server/
  index.ts                 (164)  Pure re-export barrel — the public API entry
  start-webui.ts           (777)  Server lifecycle orchestration
  pre-context-services.ts  (359)  Pre-context registries/stores factory
  backend-services.ts      (491)  Post-context agent services factory
  routes.ts                (771)  Route-table construction (13 route records)
  message-dispatcher.ts    (604)  WS message dispatch (switch(msg.type))
  server-runtime.ts        (334)  WS/HTTP/shutdown + port resolution
  pref-helpers.ts          (339)  Pref persistence (config.json read/write)
  connection-handler.ts    (249)  WS connection lifecycle + F5 replay
  setup-screen.ts          (117)  Provider resolution ladder
  context-meta.ts          (100)  Config→context.meta projection
```

### `startWebUI` orchestration flow

`startWebUI` (in `start-webui.ts`) reads as connect-the-dots — boot,
build services in two layers, wire routes/dispatcher/connection, serve:

```text
bootConfig()
  │
  ├─ createPreContextServices()        ← registries, stores, session,
  │   (pre-context-services.ts)          system prompt, provider, context
  │
  ├─ createAgentServices()             ← pipelines, compaction, agent,
  │   (backend-services.ts)              Brain, per-feature WS handlers
  │
  ├─ buildRoutes(state, deps, cb)      ← 13 route records
  │   (routes.ts)
  │
  ├─ createMessageDispatcher()         ← switch(msg.type) + runLock
  │   (message-dispatcher.ts)
  │
  ├─ createConnectionHandler()         ← rate-limit, F5 replay, lifecycle
  │   (connection-handler.ts)
  │
  ├─ resolvePorts() + createWsServers() ← host/port/auth, WS servers
  │   (server-runtime.ts)
  │
  ├─ armEvents()                       ← once-only setupEvents bridge
  │   (server-runtime.ts)
  │
  └─ startHttpServer() + registerShutdown()
      (server-runtime.ts)
```

### Mutable state threading

Several bindings are `let` in `startWebUI` because the route layer swaps
them at runtime: `config` (model switch), `session` / `sessionStore` /
`sessionStartedAt` (`/new`, `/resume`), `projectRoot` / `workingDir`
(`projects.select`), `modeId` (mode switch). These are wrapped into a
`WebuiMutableState` object (getters + setters) that `buildRoutes` reads
live — preserving the original closure-capture semantics without the
inline construction. The `configWriteLock` uses a `ConfigWriteLockHolder`
object (mutated in place by `pref-helpers.ts`) because TypeScript
flattens `Promise<Promise<void>>`.

### Shared handler parity

The standalone server and the CLI's embedded `--webui` server share the
same WS protocol. `ws-handler-parity.test.ts` scans both servers' message
dispatchers for identical `case` labels and asserts every
`WSClientMessage` union member is handled — so a handler added to one
but not the other fails CI loudly.

---

## Where to look next

- **Building a plugin** → [plugin-author-guide.md](plugin-author-guide.md)
- **Adding a new provider** → [provider-author-guide.md](provider-author-guide.md)
- **Writing a tool** → [tool-author-guide.md](tool-author-guide.md)
- **Writing a skill** → [skills.md](skills.md)
- **YOLO mode** → [yolo-mode.md](yolo-mode.md)
- **Configuration reference** → [configuration.md](configuration.md)
- **Troubleshooting** → [troubleshooting.md](troubleshooting.md)
- **Recent changes** → [`../CHANGELOG.md`](../CHANGELOG.md)

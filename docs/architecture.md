# Architecture

This is the maintained map of the running WrongStack system. It describes the
current source tree, not a proposed target architecture. For narrower contracts,
use the linked documents at the end.

WrongStack is a local-first TypeScript/Node.js AI coding-agent platform. The
published wstack command composes a shared runtime for terminal, browser,
desktop, protocol, plugin, and dashboard surfaces. A project can have several
such clients at once; shared project state is owned by local services rather
than by each client process.

---

## System at a glance

\`\`\`text
                              +--------------------------------------+
                              |         @wrongstack/cli              |
                              | boot, composition, commands, launch  |
                              +-------+--------------+---------------+
                                      |              |
                    +-----------------+              +------------------+
                    v                                                     v
          REPL / @wrongstack-tui                                HTTP + WebSocket hosts
                                                     @wrongstack/webui-server / HQ server
                    |                                                     |
                    +----------------------+------------------------------+
                                           v
                         @wrongstack/core Agent and runtime contracts
          config · permissions · providers · tools · sessions · coordination
                                           |
             +-----------------------------+-----------------------------+
             v                             v                             v
     domain packages                 external protocols             local project services
  kanban · sage · sdd · tools        MCP · ACP · plugins       IPC owner -> SQLite authority
                                                               mailbox · Chronicle · SAGE
                                                               Kanban · Codebase Index
\`\`\`

The important boundary is not a UI versus a backend: every UI is a client of
the same runtime and, where data must be shared across processes, a client of
the same project-scoped owner. Browser clients never receive a direct SQLite
handle.

---

## Workspace and dependency direction

The pnpm workspace contains 29 packages, two applications, and the marketing
site. All current workspace packages share the version in the root
`package.json`; do not hard-code that number here.

| Area | Packages / application | Responsibility |
| --- | --- | --- |
| Foundation | @wrongstack/persistence, @wrongstack/kanban, @wrongstack/core | SQLite/file primitives, task-board domain, agent kernel and contracts |
| Runtime composition | @wrongstack/runtime, @wrongstack/providers, @wrongstack/tools | Default host wiring, provider implementations, built-in tools and Codebase Index |
| Agent domains | @wrongstack/sage, @wrongstack/sdd, @wrongstack/requirement-intake, @wrongstack/techstack, @wrongstack/governance | Memory, spec workflow, intake, project analysis, and governance contracts |
| External integration | @wrongstack/mcp, @wrongstack/acp, @wrongstack/plug-lsp, @wrongstack/plugins, @wrongstack/telegram | MCP, Agent Client Protocol, LSP, bundled extensions, and Telegram bridge |
| MCP products | codebase-index-mcp, kanban-mcp, mailbox-mcp, requirement-intake-mcp, sage-mcp | Capability-limited MCP facades over local domains |
| User surfaces | cli, tui, webui, webui-server, simpleui, webui-hq, desktop | Terminal, full browser UI, small browser UI, HQ dashboard, and Electron shell |
| Support | bench, security-scanner, wrongstack | Benchmarks, standalone scan surface, and published command shim |

The package graph is a directed acyclic graph checked by
packages/core/tests/architecture/package-boundaries.test.ts and by the
topological build runner. persistence has no WrongStack workspace dependency.
kanban depends on persistence. core depends on both; it is therefore the agent
foundation, not a dependency-free kernel. Product surfaces depend toward these
lower layers and must not create a reverse dependency from core into a surface
package.

Within packages/core/src, the seven-layer runtime-import rules in
[architecture-rules.md](architecture-rules.md) are enforced: primitives and
types, infrastructure, domain, execution, storage, coordination, then
high-level extension/observability/plugin/skill modules. Type-only edges are
allowed where the runtime graph would not be.

---

## Core runtime

@wrongstack/core supplies contracts and implementations shared by every host.
Its key namespaces are kernel, core, execution, storage, security,
coordination, chronicle, models, registry, skills, plugin, and observability.

### Kernel and composition

packages/core/src/kernel contains the typed Container, Pipeline, EventBus,
RunController, and token catalogue. The CLI and WebUI server are composition
roots: they bind concrete services into the container and pass explicit
dependencies to the agent. Extensions receive scoped APIs rather than an
unrestricted global service locator.

EventBus is the in-process live-event spine. Provider streaming, tool state,
permissions, compaction, subagent activity, Brain decisions, and project
service health are published as typed events. It is deliberately separate from
durable state: an event may be dropped by a disconnected UI, which must then
refresh its authoritative store.

RunController owns an agent run's abort signal and cleanup hooks. It chains a
parent abort signal and disposes hooks on normal completion as well as failure.

### Agent turn

Agent in packages/core/src/core/agent.ts owns a single conversational run. At
boot, a host provides a provider, model, system prompt, session writer, tool
registry, pipelines, permission policy, token counter, and optional
coordination services. A turn follows this shape:

\`\`\`text
input -> normalize and persist user message -> user-input middleware
  -> build provider request -> request middleware -> provider stream/response
  -> append assistant content and emit deltas
  -> execute requested tools (permission decision first)
  -> append tool results -> compact/repair context when needed -> next iteration
  -> final RunResult and guaranteed controller cleanup
\`\`\`

Context is the per-run object passed to tools. Its observable conversation state
lets UI hosts react to routed mutations; legacy direct mutation still exists for
compatibility and must not be treated as a new extension pattern. The executor
and context manager repair provider tool-use/tool-result adjacency before a
request where edits, summaries, or replay could have broken it.

### Tools, providers, and permissioning

Tools implement the common Tool contract: JSON-schema input, a declared
permission/risk/mutation profile, execute, and optionally streamed progress and
cleanup. ToolExecutor evaluates permission before execution, supports
sequential, parallel, and smart scheduling, emits progress/results, and bounds
retained output so a long command does not unboundedly grow a session or UI.

@wrongstack/providers turns provider catalog/configuration records into the
core Provider contract. It contains native Anthropic, OpenAI, Google,
OpenAI-compatible, OAuth, and compatibility adapters; declarative wire-format
providers cover catalog-defined OpenAI-compatible APIs. Provider selection,
fallback profiles, retries, and model/mode state remain host-visible core
concerns, so all frontends see the same decisions.

DefaultPermissionPolicy combines a tool's declaration with trusted patterns,
capabilities, and input-specific risk. Interactive REPL prompts can resolve a
confirmation inline; TUI and WebUI receive a confirmation event. YOLO is not a
universal bypass: absolute denies remain enforced and destructive shell actions
remain confirmable unless destructive YOLO has been explicitly enabled.

Configuration is loaded by DefaultConfigLoader in this order: bootstrap
metadata, active user profile, project-local state, restricted in-project
configuration, additional sources, environment overrides, then CLI flags. The
root user config is bootstrap-only (version and activeProfile); settings live in
the active profile. Untrusted in-project configuration is stripped of unsafe
fields before it can affect a runtime. Secret-bearing configuration is handled
through the vault/config-secret path rather than exposed to browser clients.

### Context, sessions, and durable artifacts

HybridCompactor and the context-window policy keep provider payloads within the
selected model's usable window. The built-in context modes control when
compaction begins and how much recent content/tool output stays verbatim.

Conversation content remains deliberately file-based: DefaultSessionStore
persists scrubbed session events in sharded JSONL files under the resolved
WrongStack state directory. JSONL is the transcript/replay authority. The
project Session Catalog daemon owns the rebuildable SQLite catalog, session
claims, resume reservations, maintenance exclusion, and bounded live presence;
clients retain local replay/search helpers, checkpoint CAS, and bounded load
caches. Session JSONL is not the source of truth for mailbox, Kanban, SAGE,
Chronicle, or code-index state.

---

## Project-scoped state ownership

Several processes can attach to one project (a CLI, TUI, WebUI, MCP process, or
HQ bridge). For a shared mutable domain, one detached local service owns the
SQLite handle. Clients use a deterministic endpoint — a Windows named pipe or
Unix-domain socket — and a newline-delimited authenticated protocol.

\`\`\`text
client process -- local IPC -- elected detached owner -- SQLite / watcher
       |                         |
       +-- reconnect + query ----+-- notifications accelerate, never authorize
\`\`\`

The endpoint bind elects the owner. Owner-only metadata carries the per-process
authentication token; protocol version/hello, health ping, client lease, idle
shutdown, bounded frame size, and bounded per-client write queues protect the
lifecycle. A slow client may be disconnected rather than allowed to grow the
owner's memory indefinitely. It reconnects and reads authoritative state.
Production clients fail closed if their required owner cannot be reached; test
or explicitly requested inline modes are named escape hatches, not automatic
fallbacks.

| Domain | Owner and authority | Clients and responsibility |
| --- | --- | --- |
| Mailbox | mailbox-project-server.ts is the only production opener of the project SqliteMailbox database. | RemoteMailbox is used by CLI, TUI, WebUI, HQ, and bridges. It sends/query/acks through IPC and republishes events locally. There is no production JSONL fallback. |
| Chronicle | chronicle/project-server.ts owns SQLite journals, ordering/hash chains, retention, metrics, journal queries, and the project watcher. | Originating clients map/scrub events then append/query over the Chronicle project-server client. Legacy journal import is handled by the owner. |
| SAGE memory | packages/sage/src/project-server.ts owns the SQLite memory graph/search store. | RemoteMemoryPort implements the memory-port contract for all hosts. Retrieval/memory injection and tools use the port, not direct store construction. |
| Kanban | packages/kanban/src/server/project-server.ts owns SqliteKanbanStorage at .wrongstack/kanbans/_kanban.sqlite. | Domain calls, board events, workflow state, and supervisor integration go through the Kanban client/store facade. Legacy board data is migrated transactionally by storage. |
| Codebase Index | packages/tools/src/codebase-index/project-server.ts owns the SQLite index, write queue, index job, and external file watcher. | Search/index/call-graph tools and Code Atlas use the shared client. Read work can overlap; writes and full-index coalescing stay with the owner. |
| Session Catalog | core/session-catalog/project-server.ts owns catalog.sqlite plus durable hashed lease proofs, two-phase resume reservations, maintenance leases, and bounded live presence. Sharded session JSONL remains transcript authority. | DefaultSessionStore publishes coarse summary boundaries; ProjectSessionRegistry supplies claim/heartbeat/presence compatibility; TUI, WebUI, SimpleUI, and local HQ query or subscribe over authenticated IPC. The device-global session-registry.json is no longer a production authority. |

connections.health in the WebUI server exposes a common operational view of
these services: owner identity, endpoint/storage state, clients, queue/watcher
status, and latency. It is a diagnostic projection, not a second authority.

---

## Coordination, governance, and autonomous work

DefaultMultiAgentCoordinator provides bounded concurrent subagent execution,
per-task budgets, abort propagation, parent/child messaging, and lifecycle
events. FleetManager, FleetBus, Director, task registry, worktree support, and
Kanban bridges build the higher-level fleet model. The Director can dispatch
agents, await/terminate work, roll up results, and persist fleet state without
turning an individual subagent's local transcript into global truth.

The mailbox is the durable inter-agent communications domain; Kanban is the
durable work-board domain. Their event streams make work visible, but clients
must reconcile from SQLite after restarts or disconnects.

### Brain and Council

The Brain is an authority layer above a leader/director and below the human.
Callers submit a typed decision request with source, risk, alternatives, and a
safe fallback. BrainArbiter can answer deterministically, deny, or escalate to
BrainDecisionQueue; the latter waits for a correlated human answer from a
surface and applies a terminal policy when a headless timeout is configured.
Decision events feed Chronicle and UI timelines.

Brain implementations can be composed with rule, cache, ledger, monitor,
circuit-breaker, and escalation decorators. The optional Council adapter runs a
policy-configured set of LLM seats, each with its own provider/model and
persona. It supports quorum, weighted approval, vetoes, judge synthesis,
bounded concurrency/timeouts, and explicit distinctness warnings. It is a
decision aid, not a path around permission policy or human escalation.

### SAGE

SAGE is the project memory subsystem: structured memory, graph edges, retrieval,
audience filtering, anchors, usage/injection accounting, hygiene, and optional
embedding support are stored in SQLite. Its middleware injects relevant memory
into a run under explicit token/context controls; its tools expose controlled
memory operations. The current triage pipeline pre-filters candidates, scores
value, detects likely merges, can ask an LLM evaluator, and dispatches approved
actions through the same service contract.

### SDD and requirements

@wrongstack/requirement-intake captures requirements. @wrongstack/sdd parses
specifications, generates and tracks tasks, stores spec/task graphs, projects
work into boards, runs interviews, decomposes tasks, checks atomicity/critical
paths, and can drive bounded auto/parallel execution. Its Kanban integration
uses the Kanban service boundary rather than a private board file.

---

## External extension and protocol boundaries

### Plugins and skills

@wrongstack/plugins is the first-party plugin suite. Its public exports are
generated from the typed plugin manifest; update the manifest and run the
projection generator rather than hand-maintaining a second catalogue. The core
plugin loader gives a plugin only the APIs/capabilities it declares (tools,
providers, commands, pipelines, MCP, and related extension points) and invokes
teardown on process shutdown.

Skills are discovered by the core skill loader and included in the system-prompt
construction flow. Project-local sources take precedence over user, foreign,
extra-directory, and bundled sources; deterministic ordering prevents prompt
selection from depending on filesystem enumeration order.

### MCP

@wrongstack/mcp implements JSON-RPC MCP client and server roles. Clients use
stdio child processes, SSE, or streamable HTTP; MCPRegistry owns connection
state, lazy/eager connection, tool/resource/prompt capability changes, and
tool-name namespacing. The server side wraps a tool backend and can serve the
same protocol over stdio or HTTP. The specialized *-mcp packages are thin
capability boundaries over project services, not alternative stores.

### ACP

@wrongstack/acp implements both directions of the Agent Client Protocol.
WrongStackACPServer exposes a core-agent turn to external ACP clients over
stdio JSON-RPC by default (with a port/bridge option). ACP client transports can
drive external agents through local stdio or remote WebSocket sessions. The
registry and ensemble runner supply catalogued external-agent execution; ACP
tool translation still passes through the local permission/trust boundary.

### Other integration packages

@wrongstack/plug-lsp attaches language tooling to the tool/runtime contract.
@wrongstack/telegram provides the message bridge as a plugin-facing domain.
@wrongstack/security-scanner is a separate scanning surface built on shared
contracts, and @wrongstack/bench measures system behavior without becoming a
runtime dependency of the agent loop.

---

## Hosts and user interfaces

### CLI and TUI

The published wrongstack application is a small bin shim around
@wrongstack/cli. The CLI parses arguments, resolves boot configuration, handles
short-circuit subcommands/surfaces, wires services and registries, and then
dispatches an REPL, Ink TUI, WebUI host, SimpleUI host, desktop launch, or HQ
server as requested. Slash commands are a CLI interaction layer over the same
domain services; they should not open project databases directly.

@wrongstack/tui is React/Ink. It renders agent streaming, tools, prompts,
sessions, fleet state, project-service health, Kanban, SAGE/Brain interactions,
and terminal-specific controls from runtime events and service snapshots.

### Full WebUI and SimpleUI

@wrongstack/webui is the full React 19/Vite browser client. It owns browser
components, stores, hooks, protocol helpers, and localization. It does not own
a second Node backend: src/server/index.ts is a compatibility re-export of
@wrongstack/webui-server.

startWebUI is the WebUI server composition root. It creates pre-context services
(configuration, paths, registries, session, provider, prompt, and context),
creates agent services (pipelines, agent, feature handlers), then builds route
families, WebSocket dispatch, connection lifecycle, HTTP/static serving,
authentication, and shutdown handling. Some bindings are intentionally live and
mutable for session, model, project, and mode switching; route/dispatcher
modules read them through the shared mutable-state interface rather than stale
closure copies.

@wrongstack/simpleui is a deliberately smaller browser client served by the
same backend protocol. It sends ordinary user_message frames, keeps a compact
per-session composer/file-reference state, and avoids the full WebUI's optional
prompt-refinement route. It remains a client of the same mailbox and project
services.

### HQ and desktop

The CLI HQ server (packages/cli/src/hq-server.ts) is the cross-machine operator
surface. @wrongstack/webui-hq is its offline-capable Vite/React dashboard; it
consumes snapshot/event/alert/command-status frames over /ws/browser plus
authenticated HTTP routes. HQ aggregates health, fleet, mailbox, Kanban, cost,
Brain, worktree, and alert views. It does not become the writer for a project's
local SQLite stores.

@wrongstack/desktop is an Electron application that packages the WebUI and
WebUI-server dependencies for managing local runtimes. The website project is
separate marketing/documentation output and is not part of the agent host.

---

## Observability, safety, and verification

Metrics, tracing, and health are interface-based with no-op defaults. Hosts can
wire Prometheus/OTLP exporters and runtime health collection without making the
agent loop depend on a specific telemetry vendor. Chronicle converts important
runtime events into durable, queryable project history; secret scrubbing occurs
before persistence-oriented adapters receive event content.

The workspace release path validates more than compilation. pnpm release:check
runs dependency audit, build, provider/plugin catalogue checks, package
contracts, build lineage, architecture snapshot/health checks, test inventory,
skip/type baselines, native terminal checks, i18n, typecheck, and coverage.
Architecture artifacts are generated: use snapshot-core-public-api.mjs --write
and the architecture-health writer, then rerun their no-write checks; do not
hand-edit their measured JSON output.

When changing an architectural boundary, test the production call chain as well
as the local implementation. In particular, a focused mock or an inline test
mode is not evidence that a CLI/TUI/WebUI/MCP production client uses the
project-service owner.

---

## Where to look next

- [Core runtime import rules](architecture-rules.md)
- [WebUI architecture](webui.md)
- [MCP server architecture](mcp-server.md)
- [Director and fleet architecture](director-architecture.md)
- [Kanban architecture](kanban-architecture.md)
- [Kanban contract graph](kanban-contract-graph.md)
- [Kanban orchestration contract](kanban-orchestration-contract.md)
- [Todo/plan storage](todos_architecture.md)
- [Skills](skills.md)
- [Configuration reference](configuration.md)
- [Plugin author guide](plugin-author-guide.md)
- [Provider author guide](provider-author-guide.md)
- [Tool author guide](tool-author-guide.md)
- [Security model](../SECURITY.md)

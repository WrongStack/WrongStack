# Kanban Architecture and Operations

> Architecture and operating report for WrongStack's project-scoped multi-kanban
> system.

**Status as of 2026-08-11**: the Kanban system runs as one detached,
project-scoped IPC service with an authoritative SQLite database. It supports multiple boards per
project, human CRUD, agent-visible queue operations, dependency-aware claiming,
ordered chains, split/merge lineage, goal metrics, TaskGraph import/export/sync,
and Director-backed multi-agent dispatch through `kanban_queue`.

On top of that base, five subsystems govern what a card *means*: the managed
lifecycle ([§17](#17-managed-lifecycle)), the card contract graph and atomicity
scoring ([§18](#18-card-contract-and-atomicity)), executable completion
verification ([§19](#19-completion-verification)), the Workbench projection and
queue-anomaly vocabulary ([§20](#20-workbench-and-queue-health)), and the
execution-time security boundary ([§21](#21-security-boundary)). Each is
optional: a plain board behaves exactly as this document described before they
existed.

---

## Table of Contents

1. [Purpose](#1-purpose)
2. [System Map](#2-system-map)
3. [Data Model](#3-data-model)
4. [Storage and Consistency](#4-storage-and-consistency)
5. [Core Manager API](#5-core-manager-api)
6. [Task Readiness and Queue Semantics](#6-task-readiness-and-queue-semantics)
7. [Assignment and Routing](#7-assignment-and-routing)
8. [Director and Multi-Agent Flow](#8-director-and-multi-agent-flow)
9. [Task Splitting, Merging, and Chains](#9-task-splitting-merging-and-chains)
10. [TaskGraph, SDD, and Goal Bridge](#10-taskgraph-sdd-and-goal-bridge)
11. [User and Agent Surfaces](#11-user-and-agent-surfaces)
12. [Status Mapping](#12-status-mapping)
13. [Operational Recipes](#13-operational-recipes)
14. [Invariants and Failure Handling](#14-invariants-and-failure-handling)
15. [Testing and Verification](#15-testing-and-verification)
16. [Known Gaps and Next Work](#16-known-gaps-and-next-work)
17. [Managed Lifecycle](#17-managed-lifecycle)
18. [Card Contract and Atomicity](#18-card-contract-and-atomicity)
19. [Completion Verification](#19-completion-verification)
20. [Workbench and Queue Health](#20-workbench-and-queue-health)
21. [Security Boundary](#21-security-boundary)

---

## 1. Purpose

WrongStack Kanban is the durable project work queue shared by humans, leader
agents, fleet subagents, SDD-style task graphs, and Goal-style phase graphs.
It is intentionally simple at the storage layer and rich at the orchestration
layer:

- **Humans** can create boards, edit tasks, add dependencies, chain ordered work,
  split or merge task scope, and assign routing hints.
- **Agents** can inspect snapshots, claim ready work, mark assignment progress,
  and preserve traceability when they split or merge work.
- **Director fleets** can atomically claim dependency-ready tasks and dispatch
  them to subagents with per-task routing hints.
- **SDD / Goal** can exchange work through `TaskGraph` imports, exports,
  and syncs without losing origin metadata.

The core Kanban model is provider-free. It can store provider/model/tool routing
hints, but it does not call LLMs directly. Execution remains owned by the
Director, fleet host, or surface-specific dispatch hooks.

---

## 2. System Map

```text
Project root
  .wrongstack/kanbans/_kanban.sqlite
        ^
        | only the elected owner opens SQLite
packages/kanban/src/server/project-server.ts
        ^
        | named pipe on Windows / Unix socket elsewhere
packages/kanban/src/server/client.ts
        ^
        | protocol v6: typed domain wire codec + storage/admin RPC
packages/kanban/
  types.ts          data model
  client-domain.ts  stateful public API -> IPC only
  manager.ts        daemon-local CRUD, graph operations, queue semantics
        ^
        |
+-------+----------------+------------------+----------------------+
| CLI slash command      | Agent tool       | WebUI / WS routes    |
| /kanban ...            | kanban           | kanban.* messages    |
| packages/cli/...       | packages/tools   | cli + standalone UI  |
+------------------------+------------------+----------------------+
        ^
        |
Director tools
  kanban_queue -> claim ready task -> spawn subagent -> assign fleet task
```

Primary implementation files:

| Layer | File | Responsibility |
|---|---|---|
| Model | `packages/kanban/src/types.ts` | Board, column, task, assignment, chain, metric, graph-origin types |
| IPC owner | `packages/kanban/src/server/project-server.ts` | Endpoint election, request serialization, events, lifecycle and health |
| SQLite | `packages/kanban/src/server/sqlite-storage.ts` | Authoritative boards, events, metadata and one-time legacy import |
| Stateful client API | `packages/kanban/src/client-domain.ts` | Whitelisted high-level operations routed through protocol v6 `domainCall` |
| Remote storage | `packages/kanban/src/server/remote-storage.ts` | Fail-closed client access to the project owner |
| Storage boundary | `packages/kanban/src/storage.ts` | Public persistence contract and test-only legacy JSON codec |
| Manager | `packages/kanban/src/manager.ts` | Board/task CRUD, dependency checks, claim/release, split/merge, chain, TaskGraph bridge |
| Wire allowlist | `packages/kanban/src/domain-operations.ts` | The explicit list of stateful operations the daemon will execute; also the public-client boundary |
| Managed lifecycle | `packages/kanban/src/manager/lifecycle.ts` | Ordered stage transitions, definition-of-done validation, lifecycle issue codes ([§17](#17-managed-lifecycle)) |
| Card contract | `packages/kanban/src/contract-graph.ts` | Implementation-readiness evaluation; published on its own browser-safe subpath ([§18](#18-card-contract-and-atomicity)) |
| Atomicity | `packages/kanban/src/atomicity/` | Deterministic, LLM-free scoring of whether a card should be split ([§18](#18-card-contract-and-atomicity)) |
| Completion gate | `packages/kanban/src/verification/` | Executable acceptance criteria and the single funnel every "done" passes through ([§19](#19-completion-verification)) |
| Workbench | `packages/kanban/src/manager/workbench.ts` | Bounded Now/Next/Blocked/Review projection over all boards ([§20](#20-workbench-and-queue-health)) |
| Queue anomalies | `packages/kanban/src/queue-anomalies.ts` | One attention vocabulary shared by every health surface; browser-safe subpath ([§20](#20-workbench-and-queue-health)) |
| Board kinds | `packages/kanban/src/manager/board-kind-filter.ts` | `project` / `session_mirror` / `sdd_mirror` / `import` / `archive`, and what global queue operations exclude by default |
| Presence | `packages/kanban/src/manager/presence.ts` | Per-session/agent heartbeat, TTL-based active/inactive derivation |
| Session mirror | `packages/tools/src/session-kanban.ts` | Bidirectional projection between session todo list and session-owned board |
| Agent tool | `packages/tools/src/kanban.ts` | LLM-callable `kanban` tool actions; records presence on every successful mutation |
| External MCP | `packages/kanban-mcp` | Project-bound stdio/HTTP server with read, manage, destructive, and long-poll watch tiers |
| External-agent skill | `packages/core/skills/wrongstack-kanban/SKILL.md` | Portable inspect/claim/heartbeat/verify/reconcile workflow for MCP-capable coding agents |
| Director tool | `packages/core/src/coordination/director-tools.ts` | `kanban_queue` fleet dispatch bridge; subagent prompt includes reassessment contract |
| Security boundary | `packages/core/src/security/kanban-boundary.ts` | Execution-time governance, lease and filesystem checks, called from `tool-executor.ts` ([§21](#21-security-boundary)) |
| System prompt | `packages/core/instructions/system{,-pro,-lite}.md` | `<!--ws:if tool=kanban-->` blocks: card prerequisites, hard conditions, lifecycle, evidence and hand-off rules |
| CLI | `packages/cli/src/slash-commands/kanban.ts` | Human slash-command surface (`/kanban`, `/kb`, `/board`) |
| TUI panel | `packages/tui/src/components/kanban-panel.tsx` | In-terminal board panel, opened with F12 / Ctrl+Y or `/kanban open` |
| TUI board audit | `packages/tui/src/kanban-audit.ts` | Board hygiene verdicts; parity-locked with the WebUI copy (see [§15](#15-testing-and-verification)) |
| Embedded WebUI WS | `packages/cli/src/webui-server/kanban-host-adapter.ts` | CLI-hosted WebUI messages |
| Standalone WebUI WS | `packages/webui-server/src/server/kanban-routes.ts` | Standalone WebUI messages |
| Frontend store | `packages/webui/src/stores/kanban-store.ts` | Client state/actions for boards and tasks |
| Frontend board audit | `packages/webui/src/lib/kanban-cleaner.ts` | The WebUI half of the board audit; must produce the same codes as the TUI copy |
| HQ store | `packages/core/src/hq/kanban-store.ts` | Cross-project snapshot merge by revision then timestamp; a stale writer never wins |

---

## 3. Data Model

### Board

`KanbanBoard` is a project-scoped board:

- `id`: UUID-like board id. Short unique prefixes are accepted by the resolver.
- `title`, `description`, `tags`
- `columns`: ordered `KanbanColumn[]`
- `tasks`: ordered `KanbanTask[]`
- `generatedBy`: optional source marker such as `duplicate:<id>`,
  `sdd:<graphId>`, or `goal:<graphId>:<phaseId>`
- timestamps and `version`

Default columns are:

| Column id | Title | Default meaning |
|---|---|---|
| `backlog` | Backlog | Not yet ready or not prioritized |
| `todo` | To Do | Pending planned work |
| `in-progress` | In Progress | Active work |
| `review` | Review | Waiting on review / validation |
| `done` | Done | Completed work |

The system permits custom columns. Task status is still the semantic source for
queue behavior.

### Task

`KanbanTask` contains both human workflow fields and orchestration metadata:

| Field group | Fields |
|---|---|
| Identity | `id`, `title`, `description`, timestamps |
| Placement | `columnId`, `order`, `priority`, `status` |
| Human ownership | `assignedAgent`, `assignee`, `labels` |
| Agent routing | `assignment` |
| Agent/session presence | `presence[]` — see [Board presence](#board-presence) below |
| Graph shape | `dependsOn`, `chain`, `parentTaskId`, `childTaskIds`, `mergedIntoTaskId`, `mergedFromTaskIds`, `origin` |
| Acceptance | `successCriteria`, `goalMetrics` |
| Notes and links | `notes`, `links` |
| Estimates | `estimatedHours`, `actualHours` |

### Assignment

`KanbanAgentAssignment` is the durable record of how an agent should, or did,
work a task:

| Field | Meaning |
|---|---|
| `agentId`, `name`, `role` | Logical worker identity or roster role |
| `provider`, `model` | Per-task model routing hints |
| `fallbackProfile`, `fallbackModels` | Per-task fallback policy hints |
| `tools` | Tool allow-list hint for the worker |
| `allowedCapabilities` | Capability allow-list hint for subagent permission policy |
| `status` | `assigned`, `queued`, `running`, `completed`, `failed`, `cancelled` |
| `subagentId`, `runTaskId` | Runtime fleet identifiers after dispatch |
| `lastResult`, `error` | Completion summary or failure reason |

The assignment object is metadata. It does not execute work by itself.

### Board Presence

`KanbanBoardPresence` records which sessions and agents are actively reading or
mutating a board. Presence is per-session + per-agent, stored as an array on the
SQLite-backed board record, never as an external store:

| Field | Meaning |
|---|---|
| `id` | `"<sessionId>:<agentId>"` — stable composite key |
| `sessionId`, `agentId` | Logical identity |
| `agentName` | Human-readable name for the UI |
| `taskId`, `runTaskId` | Which task (if any) the agent is currently associated with |
| `firstSeenAt`, `lastSeenAt` | ISO8601 — first and most recent activity |
| `activeUntil` | ISO8601 deadline after which `active` becomes `false` |
| `active` | Derived at read time: `now < activeUntil` |

**Lifecycle:**
- Every successful `kanban` tool call calls `touchKanbanPresence()`, refreshing
  `lastSeenAt` and extending `activeUntil` (default TTL: 2 minutes).
- The board watcher on the owning session sends a heartbeat every 60 seconds.
- Readers compare `activeUntil` against wall-clock time so a crashed process
  does not appear active indefinitely.
- `getBoard()` and `listBoards()` return live presence (computed on read).
- The WebUI KanbanView renders a **Live board users** chip bar showing active
  sessions, agent names, and relative last-seen time.

---

## 4. Storage and Consistency

The authoritative database is:

```text
<projectRoot>/.wrongstack/kanbans/_kanban.sqlite
```

Production follows one path:

```text
CLI / TUI / WebUI / tools / Director
  -> Kanban client
  -> named pipe or Unix socket
  -> elected project server
  -> SQLite
```

Storage guarantees:

- Only the endpoint-election winner opens SQLite.
- Stateful package APIs execute their manager logic inside the elected daemon
  through the protocol v6 `domainCall` allowlist.
- Production is fail-closed; disabling or losing the daemon does not enable a
  direct-file fallback.
- `ServerKanbanStore` uses the same typed `domainCall` codec; it has no second
  JSON-string RPC contract or manager/storage fallback.
- The wire method allowlist exposes only control, `domainCall`, and typed
  storage primitives. Old high-level method names are rejected as unknown.
- Board ids must match `^[A-Za-z0-9][A-Za-z0-9_-]*$` and cannot include `..`.
- Board references can be full ids or unique prefixes.
- Mutations use revision-checked SQLite writes and reject stale updates.
- Board events and HQ sync metadata live in the same database.
- Every successful SQLite create/update/delete commit emits exactly one daemon
  mutation event; server events replace board-directory filesystem watchers.
- Event subscribers follow daemon restarts. HQ performs a full authoritative
  reconciliation after reconnect, and WebUI receives explicit board-deletion
  notifications instead of retaining stale cards.
- Existing `<boardId>.json`, `<boardId>.events.jsonl`, and `.hq-sync.json`
  files are imported transactionally once and deleted only after the SQLite
  commit succeeds. Failed imports preserve every source for retry; a committed
  import with interrupted cleanup retries deletion on the next daemon start.
- The legacy file codec is available only to tests and migration coverage.

---

## 5. Core Manager API

The manager (`packages/kanban/src/manager.ts`) is the canonical behavior
surface inside the project server. Tools, CLI, TUI, Director, and WebUI import
the package-level API; stateful exports are overridden by
`packages/kanban/src/client-domain.ts` and run through the daemon's explicit
operation allowlist. Clients never execute manager mutations or open storage.

### External MCP boundary

`wstack-kanban-mcp --project-root <path>` connects to the same deterministic project server as
WrongStack's own tools. The MCP process does not construct `SqliteKanbanStorage` and has no
direct-file fallback.

The default surface exposes `kanban_read` and `kanban_watch`. `--writable` adds non-destructive
board/task management; `--destructive` additionally exposes delete, merge, and cross-board transfer
operations and implies writable mode. Non-loopback HTTP binds require a bearer token.

`kanban_watch` is a bounded long poll over daemon mutation events. Callers must re-read the board
after an event, timeout, or disconnect because the event is a wake-up hint rather than an
authoritative snapshot. The bundled `wrongstack-kanban` skill teaches this reconciliation contract
to external coding agents.

### Board and column operations

- `createBoard`, `listBoards`, `getBoard`, `updateBoard`, `removeBoard`
- `duplicateBoard`
- `addColumn`, `updateColumn`, `removeColumn`

### Task CRUD

- `addTask`, `updateTask`, `moveTask`, `removeTask`
- `copyTaskToBoard`, `transferTaskToBoard`
- `getTask`, `searchKanban`
- `exportBoardAsMarkdown`

### Orchestration

- `listReadyTasks`
- `claimReadyTask`
- `releaseTaskClaim`
- `assignTask`
- `updateTaskAssignment`
- `getKanbanOrchestrationSnapshot`

### Graph operations

- `addDependency`
- `setTaskChain`, `getTaskChain`
- `splitTask`, `mergeTasks`
- `addGoalMetricToTask`, `updateGoalMetricOnTask`
- `addCheckToTask`, `updateCheckOnTask`
- `addNoteToTask`, `addLinkToTask`

### External graph bridge

- `createBoardFromTaskGraph`
- `syncBoardFromTaskGraph`
- `exportBoardToTaskGraph`
- `buildTaskGraphFromKanbanBoard`
- `createBoardsFromPhaseGraph`

---

## 6. Task Readiness and Queue Semantics

A task is ready for queue work when all of these are true:

1. `task.status` is `pending` or `ready`.
2. `task.assignment?.status` is not `queued` or `running`.
3. `task.mergedIntoTaskId` is not set.
4. Every `dependsOn` task has `status === 'completed'`.

`listReadyTasks()` applies that predicate and returns matching tasks. The default
queue ordering sorts ready work by priority and task ordering.

`claimReadyTask()` is the atomic queue entry point. It:

1. Finds the next ready task on one board, or across board summaries if no board
   is specified.
2. Preserves existing assignment routing metadata unless the claim input
   explicitly overrides it.
3. Writes a `queued` assignment by default.
4. Sets `assignedAgent` / `assignee` from assignment hints when present.
5. Keeps the task itself in `ready` unless the claim status is `running`.

`releaseTaskClaim()` clears the assignment, optionally clears visible assignee
fields, and returns the task to `ready` or `blocked` depending on dependency
state. A release reason is recorded as a system note.

---

## 7. Assignment and Routing

Routing is deliberately stored on each task so different tasks in the same
board can use different models, providers, roles, and tool scopes.

Recommended routing fields:

```json
{
  "role": "implementer",
  "provider": "openai",
  "model": "gpt-5",
  "fallbackModels": ["anthropic/anthropic-test-model"],
  "tools": ["bash", "kanban"],
  "allowedCapabilities": ["fs.write"]
}
```

Preservation rules:

- `assignTask()` replaces the assignment with the requested routing object.
- `claimReadyTask()` merges the existing assignment with claim overrides.
- `kanban_queue` resolves runtime subagent config from:
  1. explicit `kanban_queue` input,
  2. task assignment metadata,
  3. roster role defaults,
  4. fallback name-only config.
- If a task or roster has a tool list, `kanban_queue` ensures the `kanban` tool
  is included so the worker can mark progress.

This means a human can preconfigure a task once, and later a leader or Director
can claim it without losing provider/model/role/tool decisions.

---

## 8. Director and Multi-Agent Flow

`kanban_queue` is a Director tool. It is registered alongside
`spawn_subagent`, `assign_task`, `await_tasks`, and other Director tools, but is
hidden from ordinary subagent tool sets to avoid recursive fleet orchestration.

Primary flow:

```text
Director calls kanban_queue
  -> list candidate ready tasks if query is present
  -> claimReadyTask(projectRoot, status: queued)
  -> build SubagentConfig from assignment + roster
  -> Director.spawn(config)
  -> Director.assign(TaskSpec with Kanban prompt and context)
  -> updateTaskAssignment(status: running, subagentId, runTaskId)
  -> optionally Director.awaitTasks([...])
  -> updateTaskAssignment(status: completed|failed, lastResult|error)
```

Failure behavior:

- If `spawn` fails, the task assignment is marked `failed`.
- If `spawn` succeeds but `assign` fails, `kanban_queue` attempts
  `Director.terminate(subagentId)` to avoid leaving an idle worker alive, then
  marks the task assignment `failed`.
- If `awaitCompletion` is true and a fleet result is not `success`, the task is
  marked `failed` and the tool returns `ok: false` with `resultFailures`.
- If `awaitCompletion` is false, the task remains `running` and the leader can
  use `await_tasks` plus the `kanban` tool's `mark_assignment` later.

The assigned prompt includes board id, task id, origin metadata, routing hints,
chain metadata, dependency summaries, success criteria, goal metrics, and an
instruction to call `kanban mark_assignment` on start/finish.

---

## 9. Task Splitting, Merging, and Chains

### Splitting

`splitTask()` creates child tasks from a parent. Options control what the
children inherit:

- assignment
- labels
- success criteria
- goal metrics
- dependencies
- ordered chain metadata

If `rewireDependents` is enabled, downstream tasks that depended on the parent
can be rewired to depend on the children. The parent records `childTaskIds`.

### Merging

`mergeTasks()` creates a new merged task and records lineage:

- new task gets `mergedFromTaskIds`
- source tasks can be closed/archived
- dependents can be rewired to the merged task
- assignment can be preserved from the first source task

This keeps traceability when agents discover that work should be combined
rather than completed separately.

### Chains

`setTaskChain()` writes ordered `KanbanTaskChainRef` metadata:

- `chainId`
- zero-based `order`
- `previousTaskId`
- `nextTaskId`

By default, it enforces dependencies in chain order, so task N depends on
task N-1. `getTaskChain()` can load a chain by chain id or by any task in the
chain.

Chains are the preferred representation for strictly sequential work. Plain
dependencies still represent arbitrary DAG edges.

---

## 10. TaskGraph, SDD, and Goal Bridge

Kanban can interoperate with `TaskGraph`, which is the task DAG shape used by
SDD and Goal-style planning.

### Import

`createBoardFromTaskGraph(projectRoot, graph, options)` creates a new board:

- graph nodes become Kanban tasks
- `depends_on` and `blocks` edges become `dependsOn`
- graph parent/children fields become task lineage fields
- every imported task receives `origin`

Example origin:

```json
{
  "system": "sdd",
  "graphId": "graph-1",
  "taskId": "t2",
  "specId": "spec-1"
}
```

### Sync

`syncBoardFromTaskGraph()` updates an existing board using origin metadata:

- known graph-origin tasks are updated in place
- new graph nodes create new tasks
- missing graph-origin tasks are archived by default
- manual dependencies are preserved unless explicitly disabled
- dependency cycles are rejected

Manual follow-up tasks can remain on the board while SDD/Goal-owned tasks
continue syncing from the source graph.

### Export

`exportBoardToTaskGraph()` converts a board back into a `TaskGraph`:

- non-archived tasks become graph nodes by default
- `dependsOn` becomes `depends_on` edges
- origin task ids are preserved unless disabled
- `assignment` metadata is copied into the Kanban payload carried by graph nodes

This supports round-trips such as:

```text
SDD TaskGraph -> Kanban board -> human/agent edits -> TaskGraph export
```

### PhaseGraph

`createBoardsFromPhaseGraph()` creates one board per phase. Each board is tagged
with `goal`, the phase graph id, and phase id, and task origins include the
phase id.

### Workflow runtime state

Shared mutable workflow state follows the same project-owner boundary as board
mutations. The Kanban daemon stores revisioned `workflowId` records in SQLite
and exposes read/write/list/delete plus an atomic command queue over IPC.

- SDD uses `sdd:<runId>` for the authoritative live board snapshot and its
  cross-process control queue, plus `sdd:session` for the shared interview.
  CLI and standalone WebUI read that state through IPC; `sdd-session.json`,
  `<runId>.json`, and `<runId>.control.jsonl` are legacy import formats only.
- Goal completion is committed to the phase Kanban board first; `goal.json` is
  rebuilt as a compatibility projection after the board transition succeeds.
- Specs, task graphs, checkpoints, and append-only audit logs remain files:
  they are versionable artifacts or engine recovery data, not competing
  cross-process authorities.

Recovery is project-scoped rather than chat-session-scoped:

- A replacement WebUI process rehydrates an existing `sdd:session`; CLI users
  select it explicitly with `/sdd resume`.
- SDD task status changes are persisted in the project task-graph store.
  Restart recovery retains completed tasks and resets orphaned `in_progress`
  tasks to `pending` before an explicitly started run continues.
- Goal phase graphs follow the same explicit-resume rule: completed phases and
  tasks are retained, while interrupted running work is normalized to pending.
- The daemon never auto-launches execution after restart. This avoids duplicate
  workers; a user or orchestration surface must explicitly resume/start work.

Workflow writes support an expected revision so independent clients cannot
silently overwrite a newer value. Production constructors bind to the
project-scoped daemon; compatibility file transports must be selected
explicitly.

---

## 11. User and Agent Surfaces

### Agent tool: `kanban`

The `kanban` tool exposes board, task, queue, graph, assignment, and metadata
actions to agents. Important actions:

| Action | Purpose |
|---|---|
| `snapshot` | Get ready/queued/running/blocked/review/failed/completed summary |
| `ready_tasks` | List dependency-ready work |
| `claim_task` | Atomically claim one ready task |
| `release_task` | Release a claim back to ready/blocked |
| `assign_task` | Store routing metadata on a task |
| `mark_assignment` | Mark runtime status and write result/error |
| `split_task` | Split large or ambiguous scope |
| `merge_tasks` | Merge overlapping scope |
| `set_chain`, `get_chain` | Manage ordered task chains |
| `add_goal_metric`, `update_goal_metric` | Track measurable outcomes |
| `add_check`, `update_check`, `remove_check` | Write acceptance criteria; `checkType` + `checkNotes` make one executable ([§19](#19-completion-verification)) |
| `verify_completion` | Run the criteria and persist the report |
| `workbench` | Bounded Now/Next/Blocked/Review view across boards |
| `start_task` | Claim a card and bind it to this run |
| `transition_task` | Move a managed card one lifecycle stage |
| `assess_atomicity`, `propose_decomposition`, `split_atomic` | Size and split scope |
| `upsert_contract_node`, `add_contract_edge`, … | Author the card contract map ([§18](#18-card-contract-and-atomicity)) |
| `export_task_graph`, `sync_task_graph` | Exchange TaskGraph data |

### Human slash command: `/kanban`

Main CLI capabilities:

- board CRUD: create, duplicate, show, delete, rename, generate, export
- queue view: `snapshot`, `task ready`, `task claim`, `task release`
- task CRUD: add, show, move, done, block, remove
- graph operations: split, merge, chain, depend
- metadata: assign, dispatch, metric, note, check
- TaskGraph bridge: `graph export`, `graph import`, `graph sync`
- retention: `prune [days] [--all] [--yes]`, dry-run until `--yes`

Aliases are `/kb` and `/board`; `queue` is an alias for `snapshot`. Board and
task ids may be abbreviated wherever the prefix resolves unambiguously.

Adopting or releasing the managed lifecycle has **no slash subcommand** — it is
only reachable through the `kanban` tool's `adopt_managed_lifecycle` /
`release_managed_lifecycle` actions (and their MCP `kanban_manage` equivalents).
Once a board is managed, `/kanban task move` and `task done` route through the
lifecycle guard, and `task block` is refused outright because `blocked` is a
card status rather than a lifecycle stage.

### TUI

`/kanban open` (also `panel` or `tui`), **F12**, or **Ctrl+Y** opens the board
panel in the terminal; `packages/tui/src/components/goal-kanban-panel.tsx` is
the Goal-phase equivalent. Slash parsing lives in
`packages/tui/src/kanban-slash.ts`, and the Workbench has its own entry point in
`packages/tui/src/workbench-slash.ts`.

`packages/tui/src/kanban-audit.ts` runs a board hygiene audit with eleven
verdict codes — `abandoned-running-task`, `stale-running-task`, `stale-review`,
`skipped-lifecycle-state`, `board-oversized`, and the `missing-*` family
(`assignee`, `description`, `due-date`, `labels`, `subtasks`,
`success-criteria`). The audit is pure: it takes an explicit `now` so the same
board always produces the same verdicts.

### WebUI

Both WebUI servers route Kanban messages through the same IPC-backed public
client:

- embedded CLI WebUI: `packages/cli/src/webui-server/kanban-host-adapter.ts`
- standalone WebUI: `packages/webui-server/src/server/kanban-routes.ts`

The frontend store (`packages/webui/src/stores/kanban-store.ts`) mirrors the
same operations for UI usage. The board view has five modes — `focus`, `board`,
`tree`, `contracts`, `dashboard` — backed by dedicated panels for the task
inspector, contract graph, verification report, decomposition proposals, the
boundary editor and the queue health bar.

`packages/webui/src/lib/kanban-cleaner.ts` is the WebUI half of the TUI board
audit and must produce identical verdicts; see [§15](#15-testing-and-verification).

Contract-map routes live in
`packages/webui-server/src/server/kanban-contract-routes.ts` and broadcast the
updated board after every mutation, so the three contract panels repaint
without a refetch.

### Director tool: `kanban_queue`

This is the fleet bridge for autonomous orchestration. It is meant for leader
or Director use, not for ordinary worker subagents.

Kanban agents are instructed with the **reassessment contract**:

1. The board is the live plan, not a frozen assignment snapshot.
2. Before material work and whenever evidence changes, call `get_board` to
   reassess tasks, dependencies, and peer changes.
3. Agents may call `add_task`, `update_task`, `split_task`, `merge_tasks`,
   `move_task`, `delete_task`, or dependency actions when the plan should
   change.
4. Every successful board mutation updates shared pending work, notifies the
   owning session via `[KANBAN TODO UPDATE]` in the conversation, and
   broadcasts a human-readable status summary (item counts, no JSON) to the
   session mailbox.

### Session-Kanban Bridge

Every WrongStack session has a **session-owned Kanban board** (tagged
`session-work:session:<id>`). The session's leader writes todo, task, and plan
state into this board through the `attachSessionKanbanMirror()` binding:

```text
Leader todo tool ──────────────────┐
Leader task file (onChange) ───────┤
Leader plan file (onChange) ───────┤
                                   ▼
                    ┌──────────────────────────┐
                    │  session-kanban.ts        │
                    │  projectSessionTodosTo... │
                    │  (via TaskGraph sync)     │
                    └──────────┬───────────────┘
                               │ IPC
                               ▼
                    ┌──────────────────────────┐
                    │  Kanban project server    │
                    │  _kanban.sqlite           │
                    └──────────────────────────┘
```

**Reverse projection — board → todos:**

When a Kanban agent (or another surface) mutates the session board, the daemon
event subscription in `attachSessionKanbanMirror()` triggers
`applySessionKanbanBoardToTodos()`. This function:

1. Filters board tasks that originated from `session-todo` or are
   origin-less (board-created cards).
2. Sorts them by column order → task order → creation time.
3. Maps card fields to `TodoItem` (id, content, status, activeForm).
4. Calls `context.state.replaceTodos()`, which fires `todos_replaced` to every
   consumer (TUI via `useLiveTodos`, WebUI via `todos.updated` WS broadcast).
5. Fires a `[KANBAN TODO UPDATE]` block into the leader's conversation.
6. Broadcasts a human-readable status summary (item counts, no JSON) to the
   session mailbox.

**Idempotency:** Duplicate mirroring of the same snapshot is suppressed via
`sameTodos()` structural comparison. A board-created card with no `origin` is
matched by its kanban `id` in `findTaskByOrigin()`, so the next todo mirror
adopts it instead of creating a duplicate card.

**The todo tool warns; it does not fail.** `todo` returns successfully for every
input it can parse, and reports disagreements with the board in
`kanban_warnings` rather than rejecting the turn:

- A row the board will not start (unmet dependencies, missing criteria) is
  **demoted to pending** with the board's own reason attached — rather than
  left claiming `in_progress` while the card never moved.
- A row that would reopen a Done card is reported and left completed, because
  Done is terminal on a managed board.
- An unfinished row omitted from a shorter list is **retained**: omission is
  not a cancellation mechanism. Cancel work by deleting its card.
- A row that matches no card becomes one, so work discovered mid-run reaches
  the board instead of living only in the list.

`packages/tools/tests/kanban-todo-flow-e2e.test.ts` walks the whole loop —
three cards to completion, a card added mid-run, a split, a merge, a deletion
of the active card, and a contradictory row — asserting the run is never left
without a next move.

---

## 12. Status Mapping

Kanban has two related status concepts:

1. `KanbanTask.status`: user-visible task state.
2. `KanbanAgentAssignment.status`: runtime assignment state.

Important mappings:

| Assignment status | Task status effect |
|---|---|
| `assigned` | Keeps normal task status unless recovering from completed/failed |
| `queued` | Keeps task ready unless recovering from completed/failed |
| `running` | Sets task status to `in_progress` |
| `completed` | Sets task status to `completed` and writes `completedAt` |
| `failed` | Sets task status to `failed` |
| `cancelled` | Sets task status to `blocked` |

Column movement can also set task status based on the target column. For
orchestration, assignment status is the stronger runtime signal.

---

## 13. Operational Recipes

### Human prepares routed work

```text
/kanban create "Release API v2"
/kanban task add <board> "Implement endpoint"
/kanban task assign <board> <task> implementer --provider=openai --model=gpt-5
/kanban task metric add <board> <task> "tests passing" 1 count
```

### Agent claims and completes work

```json
{ "action": "snapshot" }
{ "action": "claim_task", "boardId": "...", "agentId": "worker-a" }
{ "action": "mark_assignment", "boardId": "...", "taskId": "...", "assignmentStatus": "running" }
{ "action": "mark_assignment", "boardId": "...", "taskId": "...", "assignmentStatus": "completed", "lastResult": "..." }
```

### Director dispatches ready work

```json
{
  "action": "dispatch_ready",
  "boardId": "...",
  "maxTasks": 3,
  "awaitCompletion": true
}
```

### Agent splits oversized scope

```json
{
  "action": "split_task",
  "boardId": "...",
  "taskId": "...",
  "childTitles": ["Backend slice", "Frontend slice"],
  "chainChildren": true,
  "rewireDependents": true
}
```

### SDD round-trip

```text
/kanban graph import <graphId>
/kanban task chain <board> <taskA> <taskB> <taskC>
/kanban graph export <board> <newGraphId>
```

---

## 14. Invariants and Failure Handling

The Kanban system should preserve these invariants:

1. **No path escape**: board ids are validated before lookup or migration.
2. **One database owner**: only the elected project server opens SQLite.
3. **IPC-only clients**: stateful public operations use the whitelisted
   `domainCall`; an unavailable/disabled daemon fails closed.
4. **No raw client storage**: SQLite, board paths, JSON/JSONL migration and
   direct manager execution stay inside the Kanban package owner/test boundary.
5. **No dependency cycles**: dependency and graph sync operations reject cycles.
6. **No self dependency**: a task cannot depend on itself.
7. **Ready means dependency-ready**: queued/running tasks are excluded from
   ready search.
8. **Assignment routing survives claims**: a claim merges existing routing
   metadata with explicit overrides.
9. **Lineage survives scope changes**: split/merge operations write parent,
   child, merged-from, and merged-into fields.
10. **Ordered chain is explicit**: chain metadata is not inferred from arbitrary
   dependencies.
11. **Graph origin is stable**: sync uses `origin.graphId`, `origin.taskId`, and
   optional `origin.phaseId` to update imported tasks.
12. **Runtime failures are visible**: failed dispatch/await results write
    `assignment.error` and set task status to `failed`.
13. **The board records work, it does not permit it**: no Kanban state gates
    another tool unless an operator sets `tools.kanbanGovernance`, and the
    `kanban` tool itself is never gated ([§21](#21-security-boundary)).
14. **Every executor host agrees**: all six `ToolExecutor` construction sites
    resolve the governance flag from the same config key.
15. **A stale worker cannot write**: a `leaseId` that no longer matches the
    card's assignment blocks filesystem and shell tools for that worker.
16. **"Done" has one definition**: every completion path runs through
    `completion-gate.ts` ([§19](#19-completion-verification)).
17. **An acceptance criterion is re-runnable**: verification updates its status
    and audit fields and never overwrites `check.notes`, which is the input a
    plugin executes. Both write-back sites (`completion-protocol.ts` and
    `completion-gate.ts`) follow this.
18. **No gate is a dead end**: every state a refusal demands can also be left
    — dependencies cleared, `atomic` unset, criteria removed
    ([§17](#17-managed-lifecycle)).
19. **The active card is recoverable**: a resumed session rebinds from board
    presence rather than starting un-bound
    ([§21](#21-security-boundary)).
20. **One attention vocabulary**: health surfaces branch on
    `hasKanbanQueueAnomalies()`, never on a locally computed sum
    ([§20](#20-workbench-and-queue-health)).

Known failure behaviors:

- Board not found returns `null`/failure at manager and surface layers.
- Ambiguous board/task id prefixes throw an error.
- Dispatch failure after spawn attempts subagent termination.
- Claim release can record a system note.
- `kanban_queue` with no matching ready work returns a non-error empty result.

---

## 15. Testing and Verification

Current focused coverage lives primarily in:

- `packages/kanban/tests/sqlite-project-server.test.ts`
- `packages/kanban/tests/architecture/kanban-ipc-boundary.test.ts`
- `packages/kanban/tests/project-server-lifecycle.test.ts`
- `packages/kanban/tests/kanban-supervisor-bridge.test.ts`
- `packages/webui-server/tests/kanban-daemon-subscriber.test.ts`
- `packages/cli/tests/kanban-slash-coverage.test.ts`
- `packages/webui-server/tests/kanban-host-routes.test.ts`
- `packages/webui/tests/stores/kanban-store.test.ts`
- `packages/core/tests/security/kanban-boundary.test.ts`
- `packages/core/tests/security/kanban-does-not-gate-work.test.ts`

Two of these are **parity locks** rather than ordinary coverage — they exist
because the same rule is implemented twice and the copies drifted before:

- `packages/cli/tests/kanban-cleaner-parity.test.ts` runs a shared board corpus
  through the TUI audit and the WebUI cleaner and compares the
  `taskId:code:severity` triples. Messages may differ; codes and severities may
  not. Three API-shape differences are deliberate and documented in the source.
- `packages/cli/tests/architecture/kanban-governance-hosts.test.ts` walks
  `packages/*/src` for `new ToolExecutor(` sites, asserts the set matches the
  six known hosts, and requires each to resolve `requireKanbanGovernance` from
  `tools.kanbanGovernance` rather than a literal ([§21](#21-security-boundary)).
- `packages/tools/tests/kanban-executable-criteria.test.ts` asserts the tool's
  `checkType` enum equals the default verifier registry's plugin ids, so the
  tool can never offer a criterion type nothing can run
  ([§19](#19-completion-verification)).

Important covered behaviors:

- board create/read/update/delete
- path traversal rejection
- multi-board copy/transfer
- assignment lifecycle
- atomic claim/release queue behavior
- claim preserving provider/model/tool metadata
- `kanban_queue` dispatch, completion, assign-failure cleanup, and awaited failure reporting
- dependency cycle rejection
- ordered chain readiness
- split/merge rewiring
- goal metrics
- TaskGraph import/sync/export
- WebSocket route parity
- WebUI store state transitions
- managed lifecycle adoption, ordered transitions, and each refusal code
- completion-gate enforcement per board kind
- governance/lease/filesystem boundary decisions at the tool executor

Recommended local verification for Kanban changes:

```bash
pnpm --filter @wrongstack/core typecheck
pnpm --filter @wrongstack/core build
pnpm --filter @wrongstack/tools typecheck
pnpm --filter @wrongstack/webui typecheck
pnpm --filter @wrongstack/cli typecheck
pnpm --filter @wrongstack/tui typecheck
pnpm vitest run packages/cli/tests/kanban-slash-coverage.test.ts packages/webui-server/tests/kanban-host-routes.test.ts
pnpm --filter @wrongstack/webui test -- tests/stores/kanban-store.test.ts
pnpm exec biome lint packages/kanban/src/types.ts packages/kanban/src/manager.ts packages/kanban/src/storage.ts packages/tools/src/kanban.ts
```

Avoid running broad recursive typecheck/build commands in parallel with package
builds that clean `dist/`; consumers can briefly fail declaration resolution
while a dependency package is rebuilding.

---

## 16. Known Gaps and Next Work

The current implementation is enough for deterministic project-local Kanban and
first-class fleet dispatch. The next useful work is deeper orchestration:

1. **Richer assignment schema**
   Future task-level routing may need explicit goal metrics policy, evaluator
   role, retry policy, cost ceiling, or model-runtime reasoning settings.

2. **Conflict-aware multi-agent merge policy**
   Kanban can represent split/merge lineage, but code changes still rely on
   worktree/Director conflict handling outside Kanban.

3. **UI for chains and graph lineage**
   CLI and WebUI expose the data, but a dedicated chain/graph visualization
   would make ordered task work easier to inspect.

4. **End-to-end multi-agent integration tests**
   Current tests use fake Directors for queue dispatch. A full test with a
   coordinator, fake subagent runner, and Kanban board would raise confidence in
   real fleet behavior.

5. **No UI surface for `tools.kanbanGovernance`**
   The gate ([§21](#21-security-boundary)) is a config-file key only. That
   matches its siblings (`tools.exec`, `tools.council`, `tools.nextsteps`), but
   an installation-wide switch with real behavioural weight would be easier to
   reason about with a `/settings` entry that shows whether it is on.

6. **No contract-map editor in the WebUI**
   The map is now writable from the agent tool, the WebSocket routes, and MCP
   ([§18](#18-card-contract-and-atomicity)), and the panels repaint on every
   mutation. What the browser still lacks is authoring: the empty state offers
   "Start contract map", but adding and connecting nodes by hand needs a graph
   editor that does not exist yet. A human-only workflow can configure
   enforcement and read the map; populating it currently goes through an agent.

7. **No CLI surface for the contract map**
   `/kanban` has no `contract` subcommand, so the map is agent-, MCP- and
   browser-writable but not scriptable from the terminal.

---

## 17. Managed Lifecycle

`packages/kanban/src/manager/lifecycle.ts` is optional and per-board. A board
adopts it with the `kanban` action `adopt_managed_lifecycle` (which requires an
`actor` and an audit `comment`) and leaves it with `release_managed_lifecycle`,
keeping every card and its history. A board that never adopts it behaves
exactly as [§6](#6-task-readiness-and-queue-semantics) describes.

Adoption maps five stages onto the board's real column ids and pins each stage
to a task status:

| Stage | Default column | Task status |
|---|---|---|
| `backlog` | `backlog` | `pending` |
| `todo` | `todo` | `ready` |
| `running` | `in-progress` | `in_progress` |
| `review` | `review` | `review` |
| `done` | `done` | `completed` |

Cards then move **one step at a time** via `transition_task`. A refused
transition is not a bare failure: `KanbanLifecycleError` carries structured
issues, and the message names the field or action that would unblock it.

| Issue code | Raised when |
|---|---|
| `task-detail-missing` | A required card field (`assignee`, `successCriteria`, an audit `comment`, …) is absent |
| `managed-policy-invalid` | The board's stage→column policy does not match its actual columns |
| `stage-mismatch` | The card's recorded stage disagrees with the column it sits in |
| `transition-skipped` | The requested move jumps a stage, or patches a field the current stage does not allow |
| `dependency-incomplete` | A `dependsOn` task has not reached Done |
| `parent-child-incomplete` | An `atomic: true` parent tried to leave Review before its children finished |
| `acceptance-criteria-incomplete` | Definition-of-done ran and a criterion has not passed |
| `review-evidence-missing` | Review → Done was attempted without a persisted verification report |

`repair_managed_projection` re-derives stage metadata for cards that drifted
(for example, cards created before adoption). `stripLifecycleIssues` removes the
machine-readable issue block from a message before it is shown to a human.

### No gate may be a dead end

A refusal is legitimate; a refusal with no reachable remedy is not. Every state
these gates demand must be **leavable**, or the gate stops being a check and
becomes a trap — and the only escape left is `release_managed_lifecycle`,
dropping the ceremony for a whole board because of one card.

Three of them were traps, because the state could be entered but not left:

| Gate | The trap | The way out |
|---|---|---|
| `dependency-incomplete` | `add_dependency` had no inverse; `update_task` collapsed an empty `dependsOn` to "not supplied", so a dependency recorded by mistake could only be escaped by completing work nobody wanted, or deleting the blocking card | `update_task` with an explicit `dependsOn: []` clears it |
| `task-detail-missing` on `childTaskIds` | `split_atomic` set `atomic` and nothing could unset it. Delete the children and the parent was stranded: it demanded children forever | `update_task` with `atomic: false` makes it an executable leaf again |
| `acceptance-criteria-incomplete` | Done refuses while any criterion is not `passed`, and criteria could be added but not removed — so a criterion that turned out not to apply left only two options, both bad: park the card, or mark it `passed`, which is a lie | `remove_check` drops it |

Two related corrections came with them. The dependency refusal was written
three times — the lifecycle gate and two branches of the assignment gate — so
which wording a caller saw depended on whether it arrived via `transition_task`
or `mark_assignment`, and only one copy named the escape;
`dependencyIncompleteMessage()` is now the single definition. And the
unmet-criteria message told every caller to "read the ids and pass each one",
which sent a caller holding a card with *no* criteria round get_task → nothing
to update → retry; the empty case now says to add one.

`packages/tools/tests/kanban-no-dead-ends.test.ts` pins each escape and asserts
the refusal message names it.

---

## 18. Card Contract and Atomicity

### Implementation readiness

`evaluateContractGraphReadiness(board, taskId)` answers one question: *is this
card safe to start implementing?* It requires card details and executable
acceptance criteria. It deliberately does **not** require contract-map
structure — even a strict map is an operator review signal, never work the model
must perform before implementing.

Two behaviours were corrected here and are worth stating so they are not
reintroduced:

- The rules belong to **managed boards only**. Applied to a plain board,
  `start_task` refused every card — its first stated reason being that the board
  was not managed, a demand no card can satisfy.
- The Workbench used the same evaluation and reported healthy cards as carrying
  "readiness gaps", so the surface that answers *what should I do next?*
  contradicted `ready_tasks` on the same board.

`contract-graph` is published on its own package subpath because the WebUI
renders it in the browser; importing it from the barrel would drag the IPC
client (`node:net`, `node:child_process`) into the browser bundle.

The graph's own node/edge model — objectives, impacts, guardrails, risks and
verification — is specified in
[kanban-contract-graph.md](kanban-contract-graph.md). This section covers only
how readiness gates a card, and how the map is written.

### Writing the map

Six node kinds hang off a task — `objective` (what the card is for),
`guardrail` (what must keep working), `risk` (what could go wrong),
`component` / `artifact` (what it touches), `verification` (what settles it) —
connected by typed edges to each other and to the card endpoint `task:<id>`.
Adding a non-verification node auto-creates its relation edge to the card, so
the map stays connected without the caller wiring the obvious edge by hand.
A `verification` node can bind to a real `successCriteria` id or `goalMetrics`
id on the same task; an unknown id is rejected rather than stored.

| Surface | How |
|---|---|
| Agent tool | `kanban` actions `get_contract_graph`, `configure_contract_graph`, `upsert_contract_node`, `remove_contract_node`, `add_contract_edge`, `remove_contract_edge` |
| WebUI | `kanban.contract.get` / `.configure` / `.node.upsert` / `.node.remove` / `.edge.add` / `.edge.remove`; every mutation broadcasts the board so open panels repaint |
| External MCP | the same actions, in the `kanban_manage` tier |

Node and edge removal sit in `kanban_manage`, not `kanban_destructive`: the map
is advisory metadata about a card rather than the card itself, and the tier that
can add an annotation should be able to take it back.

> These seven domain operations were on the IPC wire allowlist from the start
> with **no caller anywhere** — no tool action, no WebSocket route, no CLI
> subcommand. The three WebUI panels that render `board.contractGraph`
> therefore always showed the empty state, and no surface could populate one.
> The map is still advisory: `evaluateContractGraphReadiness` deliberately
> excludes map structure, so a strict-but-empty map never blocks `start_task`.

### Atomicity scoring

`packages/kanban/src/atomicity/` scores a card on six weighted criteria. The
engine is pure — no LLM, no I/O, no core dependency — and takes a neutral
candidate shape so both a `KanbanTask` and a mapped task-graph node can be
scored by the same rules.

| Criterion | What it measures |
|---|---|
| `effort` | `estimatedHours` against the ruleset's single-sitting bound |
| `file-scope` | `expectedFileChangeCount` |
| `dependency-fan-in` | `dependsOn.length` |
| `single-verifiable-output` | Whether at least one criterion is of a deterministic type |
| `description-scope` | Whether the description reads as one unit of work |
| `already-decomposed` | `childTaskIds.length` |

A verdict of `needs_decomposition` does not block anything. It appends a
one-line nudge to the tool result naming the failing criteria and suggesting
`propose_decomposition`. `split_atomic` then creates children with `atomic`
pre-set on the parent; children inherit `priority` and `boundary`
unconditionally, `labels` and `dependsOn` by default, and `assignee`,
`assignment`, `successCriteria` and `goalMetrics` only behind an explicit
`inherit*` flag.

---

## 19. Completion Verification

Acceptance criteria can be executable, and the `kanban` tool can author them:
`add_task`, `add_check` and `update_check` all take `checkType` plus
`checkNotes` (the command, test pattern, path, or JSON config the plugin runs).
`checkType` defaults to `manual`, which records an assertion and tests nothing.

The tool offers only the six types the default registry can actually run —
`command`, `test`, `file_exists`, `file_matches`, `git_diff`, `metric` — because
a type with no plugin produces a criterion that silently reports
`skipped — no verifier plugin registered`. That two-place agreement is pinned by
`packages/tools/tests/kanban-executable-criteria.test.ts`.

> This mattered more than it looks. Every write path used to hard-code
> `type: 'manual'`, so no agent-authored criterion could ever reach a verifier:
> the registry passed the hand-set status through, `validateDefinitionOfDone`
> accepted it, and "verified" meant "the author ticked its own box". The same
> hard-coding also kept the atomicity criterion `single-verifiable-output`
> ([§18](#18-card-contract-and-atomicity)) from ever scoring.

`packages/kanban/src/verification/` ships eight verifier plugins:

| Plugin | Verifies by |
|---|---|
| `test` | Running a test command and reading its result |
| `command` | Running an arbitrary command and checking its exit status |
| `git-diff` | Inspecting the working-tree diff |
| `file-exists` | Presence of a path |
| `file-matches` | A regex over file contents (guarded by `safe-regex.ts`) |
| `metric` | A goal metric reaching its target |
| `agent` | Delegating the judgement to an agent |
| `council` | Delegating the judgement to a Council panel |

`completion-gate.ts` is the single funnel every "done" passes through, so the
word means the same thing on every path: managed boards gate inside
`transitionTask`; plain boards park a completed assignment in `review` and let
the async callers (`mark_assignment`, the WebUI dispatch `onDone` handler, the
supervisor sweep) call `finalizeTaskCompletion()`; SDD runs are verified by
their own engine, and their mirror boards are created with enforcement `off`.

Enforcement resolves per board:

| Board | Effective enforcement |
|---|---|
| Managed | `strict` — `off` is not honored; `soft` is |
| Plain | `soft` by default — verification runs and reports persist, nothing blocks |
| SDD mirror | `off` |

A host may override when the board carries no explicit `completionGate` policy.
The Kanban package itself stays env-free: only hosting surfaces
(`packages/tools/src/kanban-tool-results.ts`, `webui-server`) read
`WRONGSTACK_KANBAN_GATE`, which accepts `strict`, `soft`, or `off`.

Separately, `lifecycle.autoAccept` (default `true`) decides whether a *passing*
verification may move a managed card into Done on its own. It is an acceptance
switch, not a gate switch: setting it to `false` holds a verified card in Review
for a human, and setting it to `true` never lets an unverified card through —
`validateDefinitionOfDone` runs either way.

`verifyTaskCompletion()` is async and runs commands, so it must never be called
inside a `mutateBoard` closure — the gate verifies first, then persists report,
criteria and final status in a single board mutation.

**`check.notes` is input, never output.** The write-back updates `status`,
`checkedBy` and `checkedAt` and leaves `notes` alone, because every plugin reads
it as the thing to execute. Writing a result narrative there made an executable
criterion single-use: the re-run read `[failed] File not found: evidence.txt`
as its path and could never pass, so a defect that had since been fixed could
not be re-verified. The outcome already lives in `verificationReport.checks[]`
(status, evidence, error), and nothing renders `notes`.

---

## 20. Workbench and Queue Health

### Workbench

`getKanbanWorkbench()` is a bounded projection across every non-archived board,
for the case where an agent does not know which board or card it should be on.
Results are folded into four lanes — `now` (running), `next` (queued + ready),
`blocked` (blocked + failed), `review` — each capped (default 8 per lane) with
an explicit `omitted` count, plus alerts such as heartbeats coming due.

`buildKanbanWorkbench()` is exported as a pure function of a snapshot so every
UI can test the exact same semantics. It is **navigation, not a task store**:
follow a selected card back to its own board before mutating it. The surface
contract across WebUI, TUI and SimpleUI is specified in
[kanban-workbench.md](kanban-workbench.md).

### Queue anomalies

Three surfaces each grew their own arithmetic for "is this board worth looking
at" — the WebUI route, the background supervisor, and the WebUI health bar —
and a board with failed cards could show a green *healthy* badge directly beside
its own red failure pill. `queue-anomalies.ts` is now the single definition:

| Signal | Source |
|---|---|
| `stale_assignments` | Leases past their TTL |
| `failed` | Cards in `failed` |
| `blocked` | Cards in `blocked` |
| `failed_retryable` | Failed cards still within retry policy |
| `dependency_blocked` | Ready-but-for-dependencies |
| `heartbeat_due` | Running cards whose heartbeat window is closing |

`kanbanQueueAnomalySignals()` returns only non-zero signals, so an empty array
means healthy. The counts **deliberately overlap** (a `failed_retryable` card is
also counted in `failed`) because the total ranks attention rather than
partitioning tasks — never present it as a task count. Branch on
`hasKanbanQueueAnomalies()` instead of comparing the magnitude.

Like `contract-graph`, this ships on its own subpath so the browser bundle does
not pull in the IPC client.

---

## 21. Security Boundary

`packages/core/src/security/kanban-boundary.ts` runs before every tool call,
from a single call site in `packages/core/src/execution/tool-executor.ts`. It is
an execution-time ceiling, not prompt advice: an explicit YOLO or trust rule
never waives it. The `kanban` tool itself always returns `allow` so an agent can
always record evidence or start the next card.

It performs three independent checks.

### The run's active card

`ctx.currentKanbanTaskId` / `currentKanbanBoardId` answer *which card is this
run working*. `start_task` sets them on **any** board — attribution and
governance are two different decisions, and withholding the binding on a plain
board (the default) also withheld the attribution, so `recordFileEvent()` wrote
`scope: 'session'` for every edit and no file activity was ever tied to the card
the board showed as `in_progress`. Binding is safe because the gate below reads
governance from the board's lifecycle mode, not from the presence of a binding.

The binding lives in conversation state, which no resume restores. So
`hydrateSessionKanban()` — the one hook every surface passes through at session
start — calls `rebindSessionKanbanTask()` first. It matches board **presence**
(keyed `<sessionId>:<agentId>`, stored on the board record, so it outlives the
process) against the cards still running, and rebinds the most recently seen
one. It refuses to guess: it never overrides a live binding, ignores a card
whose lease has expired (`recover_stale` may have reassigned it), and returns
null rather than binding on a Kanban daemon that is down.

### A. Governance gate — opt-in, off by default

Requires the run to be bound to a card that is on a **managed** board, passes
`evaluateContractGraphReadiness`, and sits in Running with a live assignment.
Control tools (`kanban`, `plan`, `task`, `todo`) are exempt.

Non-managed boards are **skipped, not blocked**. An observational board — a
session mirror, an SDD mirror, a plain import — structurally cannot carry a
lifecycle, and task-graph sync explicitly refuses to make one managed, so
demanding governance from such a board produced an inescapable deadlock: every
mutating tool blocked, with the only stated remedy unreachable by construction.
Those boards still fall through to check C, which is where their real policy
lives.

The gate is controlled by **`tools.kanbanGovernance`**, default `false` —
because the board is a record of the work, not a permit for it, which is what
both the system prompt and the `kanban` tool description tell the model. When it
was hard-wired `true`, sessions spent their effort on card ceremony instead of
the work the card describes.

```jsonc
// active profile config.json — opt an installation in
{ "tools": { "kanbanGovernance": true } }
```

Six hosts construct a `ToolExecutor` and every one of them must resolve this key
identically, or the contract would change with the door the work came through:

| Host | File |
|---|---|
| CLI / TUI pipeline | `packages/cli/src/wiring/pipeline.ts` |
| `wstack mcp serve` | `packages/cli/src/mcp-serve.ts` |
| ACP agent | `packages/cli/src/acp-server-agent.ts` |
| Fleet subagent factory | `packages/cli/src/fleet/host-subagent-factory.ts` |
| Light subagent factory | `packages/runtime/src/fleet/light-subagent-factory.ts` |
| WebUI backend | `packages/webui-server/src/server/backend-services.ts` |

`packages/cli/tests/architecture/kanban-governance-hosts.test.ts` walks the
workspace, asserts that set is exactly the list of `new ToolExecutor(` sites,
and fails if any of them hard-codes the decision instead of reading the key.

The key is stripped from repo-committed `<project>/.wrongstack/config.json`.
It defaults to `false`, so the only thing an untrusted config could do with it is
turn **off** a gate the operator switched on — the same one-directional risk as
`tools.restrictToProjectRoot`.

### B. Lease fence — always on

When a subagent was dispatched with a frozen `leaseId`, the boundary verifies
the card's current assignment still carries it. A mismatch means
`recover_stale` reclaimed and reassigned the task, so the worker is stale:
tools with `fs.write`, `fs.write.outside-project`, or any `shell.*` capability
are blocked. The `kanban` tool is exempt because it has its own
`expectedLeaseId` fence in the assignment handlers, which is how a stale worker
resolves the situation.

### C. Filesystem boundary — always on

`resolveKanbanBoundaryLayers(board, task)` evaluates the board policy and the
task policy together. Candidate paths are extracted from the tool input by a
fixed key set (`path`, `paths`, `file`, `files`, `cwd`, `worktreePath`, …), with
per-tool overrides where a name is ambiguous — `target` is an identifier for
`plan`/`task`/`document` but a filesystem path for `language_info`. Read, write
and shell-like access are decided separately from the tool's declared
capabilities. Boards with no boundary layers return `allow`.

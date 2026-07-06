# Kanban Architecture and Operations

> Architecture and operating report for WrongStack's project-scoped multi-kanban
> system.

**Status as of 2026-07-06**: the Kanban system supports multiple boards per
project, human CRUD, agent-visible queue operations, dependency-aware claiming,
ordered chains, split/merge lineage, goal metrics, TaskGraph import/export/sync,
and Director-backed multi-agent dispatch through `kanban_queue`.

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
10. [TaskGraph, SDD, and AutoPhase Bridge](#10-taskgraph-sdd-and-autophase-bridge)
11. [User and Agent Surfaces](#11-user-and-agent-surfaces)
12. [Status Mapping](#12-status-mapping)
13. [Operational Recipes](#13-operational-recipes)
14. [Invariants and Failure Handling](#14-invariants-and-failure-handling)
15. [Testing and Verification](#15-testing-and-verification)
16. [Known Gaps and Next Work](#16-known-gaps-and-next-work)

---

## 1. Purpose

WrongStack Kanban is the durable project work queue shared by humans, leader
agents, fleet subagents, SDD-style task graphs, and AutoPhase-style phase graphs.
It is intentionally simple at the storage layer and rich at the orchestration
layer:

- **Humans** can create boards, edit tasks, add dependencies, chain ordered work,
  split or merge task scope, and assign routing hints.
- **Agents** can inspect snapshots, claim ready work, mark assignment progress,
  and preserve traceability when they split or merge work.
- **Director fleets** can atomically claim dependency-ready tasks and dispatch
  them to subagents with per-task routing hints.
- **SDD / AutoPhase** can exchange work through `TaskGraph` imports, exports,
  and syncs without losing origin metadata.

The core Kanban model is provider-free. It can store provider/model/tool routing
hints, but it does not call LLMs directly. Execution remains owned by the
Director, fleet host, or surface-specific dispatch hooks.

---

## 2. System Map

```text
Project root
  .wrongstack/kanbans/<boardId>.json
        ^
        |
packages/core/src/kanban/
  types.ts      data model
  storage.ts    file IO, locking, atomic writes, board refs
  manager.ts    deterministic CRUD, graph operations, queue semantics
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
| Model | `packages/core/src/kanban/types.ts` | Board, column, task, assignment, chain, metric, graph-origin types |
| Storage | `packages/core/src/kanban/storage.ts` | Project-local JSON storage, board id validation, locks, atomic writes |
| Manager | `packages/core/src/kanban/manager.ts` | Board/task CRUD, dependency checks, claim/release, split/merge, chain, TaskGraph bridge |
| Agent tool | `packages/tools/src/kanban.ts` | LLM-callable `kanban` tool actions |
| Director tool | `packages/core/src/coordination/director-tools.ts` | `kanban_queue` fleet dispatch bridge |
| CLI | `packages/cli/src/slash-commands/kanban.ts` | Human slash-command surface |
| Embedded WebUI WS | `packages/cli/src/webui-server/ws-handlers/kanban.ts` | CLI-hosted WebUI messages |
| Standalone WebUI WS | `packages/webui/src/server/kanban-routes.ts` | Standalone WebUI messages |
| Frontend store | `packages/webui/src/stores/kanban-store.ts` | Client state/actions for boards and tasks |

---

## 3. Data Model

### Board

`KanbanBoard` is a project-scoped board:

- `id`: UUID-like board id. Short unique prefixes are accepted by the resolver.
- `title`, `description`, `tags`
- `columns`: ordered `KanbanColumn[]`
- `tasks`: ordered `KanbanTask[]`
- `generatedBy`: optional source marker such as `duplicate:<id>`,
  `sdd:<graphId>`, or `autophase:<graphId>:<phaseId>`
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

---

## 4. Storage and Consistency

Kanban boards are stored under the project tree:

```text
<projectRoot>/.wrongstack/kanbans/<boardId>.json
```

Storage guarantees:

- Board ids must match `^[A-Za-z0-9][A-Za-z0-9_-]*$` and cannot include `..`.
- Board references can be full ids or unique prefixes.
- Reads normalize legacy/missing fields into current defaults.
- Writes use `atomicWrite`.
- Mutations use `withFileLock(filePath, ...)`, so concurrent writers serialize
  through a per-board lock.
- `mutateBoard()` reads, mutates, normalizes, and writes inside one locked block.

This makes queue operations safe enough for multiple surfaces working on the
same board: two agents claiming the same task concurrently should serialize on
the board file, and only one claim should observe the task as ready.

Important boundary: locking is per board file, not global across all boards.
Cross-board workflows such as transfer read/write multiple boards and should not
be treated as a distributed transaction.

---

## 5. Core Manager API

The manager (`packages/core/src/kanban/manager.ts`) is the canonical behavior
surface. Tools, CLI, and WebUI route through it rather than modifying JSON
directly.

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

## 10. TaskGraph, SDD, and AutoPhase Bridge

Kanban can interoperate with `TaskGraph`, which is the task DAG shape used by
SDD and AutoPhase-style planning.

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

Manual follow-up tasks can remain on the board while SDD/AutoPhase-owned tasks
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
with `autophase`, the phase graph id, and phase id, and task origins include the
phase id.

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
| `export_task_graph`, `sync_task_graph` | Exchange TaskGraph data |

### Human slash command: `/kanban`

Main CLI capabilities:

- board CRUD: create, duplicate, show, delete, rename, generate, export
- queue view: `snapshot`, `task ready`, `task claim`, `task release`
- task CRUD: add, show, move, done, block, remove
- graph operations: split, merge, chain, depend
- metadata: assign, dispatch, metric, note, check
- TaskGraph bridge: `graph export`, `graph import`, `graph sync`

### WebUI

Both WebUI servers route Kanban messages through the same core manager:

- embedded CLI WebUI: `packages/cli/src/webui-server/ws-handlers/kanban.ts`
- standalone WebUI: `packages/webui/src/server/kanban-routes.ts`

The frontend store (`packages/webui/src/stores/kanban-store.ts`) mirrors the
same operations for UI usage.

### Director tool: `kanban_queue`

This is the fleet bridge for autonomous orchestration. It is meant for leader
or Director use, not for ordinary worker subagents.

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

1. **No path escape**: board ids are validated before file paths are built.
2. **One writer per board mutation**: `mutateBoard()` holds a file lock.
3. **No dependency cycles**: dependency and graph sync operations reject cycles.
4. **No self dependency**: a task cannot depend on itself.
5. **Ready means dependency-ready**: queued/running tasks are excluded from
   ready search.
6. **Assignment routing survives claims**: a claim merges existing routing
   metadata with explicit overrides.
7. **Lineage survives scope changes**: split/merge operations write parent,
   child, merged-from, and merged-into fields.
8. **Ordered chain is explicit**: chain metadata is not inferred from arbitrary
   dependencies.
9. **Graph origin is stable**: sync uses `origin.graphId`, `origin.taskId`, and
   optional `origin.phaseId` to update imported tasks.
10. **Runtime failures are visible**: failed dispatch/await results write
    `assignment.error` and set task status to `failed`.

Known failure behaviors:

- Board not found returns `null`/failure at manager and surface layers.
- Ambiguous board/task id prefixes throw an error.
- Dispatch failure after spawn attempts subagent termination.
- Claim release can record a system note.
- `kanban_queue` with no matching ready work returns a non-error empty result.

---

## 15. Testing and Verification

Current focused coverage lives primarily in:

- `packages/cli/tests/kanban.test.ts`
- `packages/cli/tests/webui-server/ws-handler-parity.test.ts`
- `packages/webui/tests/stores/kanban-store.test.ts`

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

Recommended local verification for Kanban changes:

```bash
pnpm --filter @wrongstack/core typecheck
pnpm --filter @wrongstack/core build
pnpm --filter @wrongstack/tools typecheck
pnpm --filter @wrongstack/webui typecheck
pnpm --filter @wrongstack/cli typecheck
pnpm --filter @wrongstack/tui typecheck
pnpm vitest run packages/cli/tests/kanban.test.ts packages/cli/tests/webui-server/ws-handler-parity.test.ts
pnpm --filter @wrongstack/webui test -- tests/stores/kanban-store.test.ts
pnpm exec biome lint packages/core/src/kanban/types.ts packages/core/src/kanban/manager.ts packages/core/src/kanban/storage.ts packages/tools/src/kanban.ts
```

Avoid running broad recursive typecheck/build commands in parallel with package
builds that clean `dist/`; consumers can briefly fail declaration resolution
while a dependency package is rebuilding.

---

## 16. Known Gaps and Next Work

The current implementation is enough for deterministic project-local Kanban and
first-class fleet dispatch. The next useful work is deeper orchestration:

1. **Stronger transaction model for cross-board transfer**
   Current board mutations are per-board locked. Cross-board operations are not
   a true two-phase transaction.

2. **Dedicated audit trail for Kanban task events**
   Board JSON stores current state. Long-term event history currently depends on
   session logs or notes. A board-local append-only history would improve
   debugging.

3. **Automatic stale claim recovery**
   Queued/running assignments can remain if a process dies. A recovery policy
   could release or mark stale claims after heartbeat/session inspection.

4. **Richer assignment schema**
   Future task-level routing may need explicit goal metrics policy, evaluator
   role, retry policy, cost ceiling, or model-runtime reasoning settings.

5. **Conflict-aware multi-agent merge policy**
   Kanban can represent split/merge lineage, but code changes still rely on
   worktree/Director conflict handling outside Kanban.

6. **UI for chains and graph lineage**
   CLI and WebUI expose the data, but a dedicated chain/graph visualization
   would make ordered task work easier to inspect.

7. **End-to-end multi-agent integration tests**
   Current tests use fake Directors for queue dispatch. A full test with a
   coordinator, fake subagent runner, and Kanban board would raise confidence in
   real fleet behavior.

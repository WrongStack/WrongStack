# Kanban Orchestration Contract

> Canonical contract for using WrongStack Kanban as the source-of-truth state
> machine for non-trivial LLM, Director, subagent, review, and recovery work.

## Status

Sprint 3 contract — all three orchestration sprints are delivered. This document
defines the behavior Kanban orchestration work should preserve while building on
the lease, queue-health, and cost/retry foundations.

Related docs:

- [kanban-architecture.md](kanban-architecture.md) — existing architecture and
  manager/tool surface.
- [kanban-orchestration-roadmap.md](kanban-orchestration-roadmap.md) — phased
  roadmap for full orchestration.
- [director-architecture.md](director-architecture.md) — Director/fleet concepts
  used by `kanban_queue`.

## Core principle

For non-trivial project work, Kanban is the durable source of truth. Conversation
history, local todos, fleet task ids, and status messages are useful working
memory, but the board task and assignment record are the durable coordination
state.

The default orchestration loop is:

```text
inspect board
  -> find or create task
  -> claim dependency-ready task
  -> mark assignment running
  -> execute work
  -> update checks / notes / metrics
  -> mark assignment completed or failed
  -> release or retry if work cannot proceed
```

## Actor responsibilities

| Actor | Responsibilities | Must not |
|---|---|---|
| Human | Create/edit boards, adjust scope, review visible state, override stuck work | Edit `.wrongstack/kanbans/*.json` by hand while agents are running |
| Leader agent | Plan non-trivial work into Kanban, claim/dispatch ready tasks, coordinate recovery, mark outcomes | Start substantial file-mutating work without an active Kanban task when operating in orchestration mode |
| Director | Use `kanban_queue` to claim ready tasks, spawn workers, write runtime ids, await or surface results | Expose recursive fleet orchestration tools to ordinary subagents |
| Subagent | Work one claimed task, report running/completed/failed, split/merge scope when instructed and allowed | Claim unrelated work or silently abandon a running assignment |
| Reviewer/verifier | Update checks, metrics, notes, and review task outcomes | Mark implementation accepted without evidence required by the task |
| Recovery loop | Detect expired claims and release, retry, or fail them according to policy | Recover active tasks with fresh heartbeat/lease evidence |

## Task lifecycle

### Canonical states

| State | Meaning | Typical writer |
|---|---|---|
| `pending` | Planned work that is not explicitly queue-ready yet | Human, leader, import/sync |
| `ready` | Work eligible for claim when dependencies are complete | Human, leader, release/recovery, graph sync |
| `in_progress` | Work is actively being executed | `mark_assignment running`, Director, worker |
| `review` | Work is implemented but awaiting review/verification | Leader, reviewer, quality gate |
| `completed` | Accepted work; required checks are satisfied or waived | Worker through controlled flow, leader, reviewer |
| `blocked` | Work cannot proceed until a condition outside normal dependencies changes | Human, leader, release/recovery |
| `failed` | Work attempt failed and is not currently retry-ready | Worker, Director, recovery loop |
| `archived` | Work is hidden from active orchestration but retained for traceability | Human, sync/import policy |

### Allowed transitions

```text
pending -> ready
pending -> blocked
pending -> archived

ready -> in_progress
ready -> blocked
ready -> archived

in_progress -> review
in_progress -> completed
in_progress -> failed
in_progress -> blocked

review -> completed
review -> failed
review -> ready

blocked -> ready
blocked -> archived

failed -> ready
failed -> blocked
failed -> archived

completed -> archived
```

### Transition rules

1. `ready -> in_progress` must happen through a claim or assignment update, not
   by directly editing task status.
2. `in_progress -> completed` should only happen when required success criteria
   are passed, skipped, or explicitly waived.
3. `failed -> ready` is a retry transition and should increment or preserve
   attempt metadata once leases/retry policy exist.
4. `blocked -> ready` must record why the blocker cleared when the reason is not
   obvious from dependency status.
5. Imported graph tasks should preserve origin metadata through updates,
   completion, and archive transitions.

## Assignment lifecycle

Assignment status tracks the runtime worker relationship. Task status tracks the
workflow semantics. They are related but not identical.

| Assignment status | Meaning | Task status effect |
|---|---|---|
| `assigned` | Routing metadata exists, but the task is not queued/running | Usually leaves task `pending` or `ready` |
| `queued` | A worker or Director has reserved the task for dispatch | Task may remain `ready` until actually running |
| `running` | A worker is actively executing the task | Task becomes `in_progress` |
| `completed` | Worker reported success | Task becomes `completed` unless a review gate requires `review` |
| `failed` | Worker or dispatch failed | Task becomes `failed` |
| `cancelled` | Assignment was intentionally stopped | Task becomes `blocked` or `ready` depending on release policy |

### Lease metadata

Sprint 1 implementation should add lease metadata without breaking legacy boards:

```ts
interface KanbanAgentAssignmentLeaseFields {
  leaseId?: string;
  claimedAt?: string;
  heartbeatAt?: string;
  leaseExpiresAt?: string;
  attempt?: number;
  maxAttempts?: number;
}
```

Rules:

1. Missing lease fields are valid legacy state.
2. A new claim should set `claimedAt`; Sprint 1 may also set `leaseId`,
   `heartbeatAt`, and `leaseExpiresAt` when lease configuration is available.
3. A heartbeat refresh updates lease timing fields only. It must not overwrite
   `agentId`, `subagentId`, `runTaskId`, `lastResult`, or `error` unless the
   caller explicitly supplies those fields.
4. A lease is stale when `leaseExpiresAt` is present and earlier than the
   recovery check time.
5. If `leaseExpiresAt` is absent, recovery may fall back to `heartbeatAt`,
   `claimedAt`, or existing runtime heartbeat evidence according to the recovery
   policy.

## Claim contract

`claim_task` and `kanban_queue` are the canonical ways to reserve executable
work.

A task is claimable when:

1. task status is `pending` or `ready`;
2. assignment status is not `queued` or `running`;
3. the task has not been merged into another task;
4. all `dependsOn` tasks have status `completed`.

Claim behavior:

1. The mutation is board-local and serialized by the board file lock.
2. Existing routing metadata is preserved unless explicit claim input overrides
   it.
3. The assignment becomes `queued` unless the caller explicitly claims as
   `running`.
4. Visible assignee fields may be populated from assignment hints.
5. Claiming does not imply completion, review, or success.

## Release contract

A claim should be released when the worker cannot proceed but the task should not
be considered a failed implementation attempt.

Release behavior:

1. The assignment is cleared unless the release mode explicitly preserves it.
2. Visible assignee fields are cleared by default.
3. The task returns to `ready` when dependencies are satisfied.
4. The task returns to `blocked` when dependencies are not satisfied or the
   release reason indicates an external blocker.
5. The release reason should be recorded as a system note and, once event logs
   exist, as a `task.released` event.

## Stale recovery contract

Stale recovery exists to prevent lost workers from permanently removing work from
the ready queue.

Recovery candidates:

```text
assignment.status in queued|running
  and lease/heartbeat evidence is expired
  and no fresher fleet/runtime evidence proves the worker is still active
```

Recovery modes:

| Mode | Behavior |
|---|---|
| `release` | Clear the assignment and return task to `ready` or `blocked` |
| `retry` | Clear/replace stale runtime fields, increment attempt, and return to `ready` when attempts remain |
| `fail` | Mark assignment and task failed with a stale-worker error |

Recovery rules:

1. Recovery must run inside the board lock.
2. Recovery must be idempotent: repeating it after the first successful recovery
   should not create duplicate attempts or contradictory status.
3. Recovery must record a reason in notes and, once available, in events.
4. Recovery must not affect tasks with fresh heartbeat/lease evidence.
5. Recovery should not cross board boundaries in a single assumed transaction.

## Event contract

Sprint 1 event logging is append-only observability. The board JSON remains the
fast current-state document.

Minimum event types:

```text
task.claimed
task.assignment.running
task.assignment.completed
task.assignment.failed
task.released
task.stale_recovered
```

Recommended event shape:

```ts
interface KanbanEvent {
  id: string;
  boardId: string;
  taskId?: string;
  type: string;
  actor?: string;
  ts: string;
  before?: unknown;
  after?: unknown;
  correlationId?: string;
  subagentId?: string;
  runTaskId?: string;
  note?: string;
}
```

Rules:

1. Event logging should not make a valid board unreadable if the event append
   fails.
2. Mutating operations should either emit an event or document why they do not.
3. Runtime correlation should prefer `runTaskId`, then `subagentId`, then
   session/agent id when available.
4. Events must not include secrets or full prompt bodies by default.

## Queue health and operational signals (Sprint 2)

Recovery loops and dashboards MUST NOT recompute operational state ad-hoc;
they MUST read the `KanbanQueueHealth` summary produced by
`getKanbanQueueHealth` (and exposed as `kanban action:"queue_health"`).

### Required fields

```ts
interface KanbanQueueHealth {
  generatedAt: string;
  boardIds: string[];
  counts: {
    ready, queued, running, review, failed, completed, pending, archived, blocked
  };
  dependencyBlocked: { count, tasks };
  staleAssignments: { count, tasks };
  failedRetryable: { count, tasks };
  heartbeatDue: { count, tasks };
  lastDispatchedAt?: string;
  lastStaleRecoveredAt?: string;
}
```

### Semantics

| Signal | Meaning |
|---|---|
| `counts.ready` | Tasks with `status === 'ready'` AND no unmet dependencies. Excludes dependency-blocked items. |
| `dependencyBlocked` | Tasks with `status` `ready` or `pending` whose dependencies are not yet completed. May overlap with `pending`. |
| `staleAssignments` | Tasks with `assignment.status` `queued` or `running` AND `assignment.leaseExpiresAt <= now`. |
| `failedRetryable` | Tasks with `status === 'failed'` AND `assignment.attempt < assignment.maxAttempts`. |
| `heartbeatDue` | Tasks with `assignment.status === 'running'` AND `assignment.leaseExpiresAt - now <= heartbeatIntervalMs`. Default heartbeat interval: 60s. |
| `lastDispatchedAt` | Most recent `task.assignment.running` event timestamp across queried boards. |
| `lastStaleRecoveredAt` | Most recent `task.stale_recovered` event timestamp across queried boards. |

### Rules

1. `dependencyBlocked.tasks` MUST NOT overlap with `counts.ready`; a task in
   the blocked-by-dependency bucket is excluded from the ready count so
   WebUI does not show it as claimable.
2. `staleAssignments.tasks` and `heartbeatDue.tasks` MAY overlap; recovery
   loops SHOULD treat a task appearing in both as a prompt for immediate
   `recover_stale` instead of waiting for a natural lapse.
3. Recomputing these signals MUST go through `getKanbanQueueHealth`; the
   `kanban` tool and the recovery loop are not allowed to call the
   underlying manager helpers separately so the snapshot stays consistent.
4. `now` parameter (when supplied to `getKanbanQueueHealth`) MUST be used
   consistently across all per-task comparisons in a single call.

## Tool usage policy

| Tool/action | Intended actor | Contract |
|---|---|---|
| `kanban snapshot` | Human, leader, Director | Read current queue state before coordination decisions |
| `kanban ready_tasks` | Leader, Director | Inspect claimable work without mutating state |
| `kanban claim_task` | Leader, Director, controlled worker | Atomically reserve one ready task; seeds lease metadata (leaseId, claimedAt, leaseExpiresAt) |
| `kanban release_task` | Leader, worker, recovery loop | Return unworkable claimed task to ready/blocked; clears assignment but durable task policy fields (retryPolicy/costCeilingUsd) survive |
| `kanban assign_task` | Human, leader | Store routing + policy metadata before dispatch; mirrors retryPolicy/costCeilingUsd to durable task fields |
| `kanban mark_assignment` | Worker, Director, leader | Report runtime status/result/error; propagates costCeilingUsd and retryPolicy |
| `kanban heartbeat_assignment` | Worker, recovery loop | Refresh lease timing (heartbeatAt, leaseExpiresAt) without touching ownership, result, or error fields |
| `kanban recover_stale` | Leader, Director, recovery loop | Detect expired queued/running assignments and apply release/retry/fail per-task. **Auto mode** (`mode: "auto"`) applies policy rules via `selectRecoveryMode` — see "Recovery router" below |
| `kanban queue_health` | Human, leader, Director, recovery loop | Read `KanbanQueueHealth` summary (counts + staleAssignments + heartbeatDue + dependencyBlocked + failedRetryable) before making coordination decisions |
| `kanban split_task` / `merge_tasks` | Worker with permission, leader | Preserve lineage when scope changes |
| `kanban_queue dispatch_ready` | Director/leader only | Claim ready tasks, check costCeilingUsd against Director budget, seed lease + retryPolicy metadata, spawn fleet workers |
| `await_tasks` | Director/leader only | Wait for fleet results and coordinate follow-up |

### Recovery router (auto mode)

When `recover_stale` is called with `mode: "auto"`, each stale task resolves its own mode through `selectRecoveryMode` using the following rule chain (first match wins):

```text
1. assignment.retryPolicy === "off"              → fail
2. policy.releaseOnFailureKinds includes
   assignment.lastFailureKind                     → release
3. policy.failWhenCostCeilingSet && 
   assignment.costCeilingUsd !== undefined        → fail
4. policy.releaseOnHeartbeatDue && 
   isHeartbeatDue                                 → release
5. assignment.maxAttempts exceeded                → fail
6. default                                        → retry
```

Explicit modes (`"release"`, `"retry"`, `"fail"`) short-circuit the rule chain entirely and keep the Sprint 1 semantics. The optional `policy` argument controls rules 2–4; when absent only rules 1 and 5 apply from the assignment metadata itself.

### Cost ceiling budget gate

`kanban_queue dispatch_ready` checks `task.assignment.costCeilingUsd` against the Director's remaining fleet budget (`Director.getRemainingBudgetUsd()`) before spawning a subagent. When the cost ceiling exceeds the remaining budget the task is marked `failed` with a descriptive error and the dispatch moves to the next candidate. Tasks without a cost ceiling (`undefined`) skip the check entirely.

## Done criteria

### Sprint 1 — Reliable queue

1. This contract is linked from the docs index.
2. Assignment lease fields are present and legacy board normalization remains compatible.
3. Heartbeat semantics refresh lease timing without corrupting assignment owner or result fields.
4. Stale claim recovery can release, retry, or fail expired queued/running tasks.
5. Basic assignment events are emitted for claim/running/completed/failed/release and stale recovery transitions.
6. `kanban_queue` prompts and lifecycle updates align with this contract.
7. Focused tests cover lease normalization, heartbeat, recovery, events, and existing claim/release behavior.
8. A file-backed smoke test demonstrates dispatch, simulated stale worker recovery, retry, and final completion.

### Sprint 2 — Queue health and policy metadata

1. `KanbanQueueHealth` type with per-status counts, staleAssignments, failedRetryable, heartbeatDue, and dependencyBlocked signals.
2. `getKanbanQueueHealth` helper in core; `kanban action:"queue_health"` in the tool.
3. `dependencyBlocked.tasks` is a subset of `counts.ready` — no double-count.
4. `costCeilingUsd`, `retryPolicy`, and `lastFailureKind` fields on `KanbanAgentAssignment` and `AssignKanbanTaskInput`.
5. `KanbanRecoveryPolicy` and `selectRecoveryMode` with six-rule auto mode.
6. WebUI Kanban board detail renders queue health signal bar with color-coded counts and badges.
7. 18 focused test scenarios consolidated in `sprint2-reliable-queue.test.ts`.

### Sprint 3 — Cost/Retry Director integration

1. `Director.getRemainingBudgetUsd()` public method: `maxFleetCostUsd - totalCost`.
2. `kanban_queue` dispatch checks `costCeilingUsd` against remaining budget before spawning; insufficient budget marks the task with failed and continues.
3. `buildKanbanSubagentConfig` passes `assignment.costCeilingUsd` as `config.maxCostUsd` for per-task subagent budget.
4. Durable `KanbanTask.retryPolicy` / `KanbanTask.costCeilingUsd` fields survive `releaseTaskClaim` → re-claim cycles.
5. Fleet prompt includes a "Retry policy" block (`retryPolicy`, `maxAttempts`, `costCeilingUsd`).
6. WebUI health panel shows running cost total (sum of `costCeilingUsd` for running/queued tasks).
7. 6 additional focused test scenarios (24 total in `sprint2-reliable-queue.test.ts`).

## Operational notes

- Prefer one board for a tightly coupled sprint because current locking is
  board-local.
- Use dependencies for arbitrary DAG edges and chains for strict ordered work.
- Keep review/quality gates explicit; do not overload implementation success as
  acceptance when checks are required.
- If no ready tasks exist but incomplete work remains, inspect blocked,
  queued/running, failed, and stale candidates before concluding the board is
  done.

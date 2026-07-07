# Cost/Retry Director Integration — Design

> Audit output for Sprint 3 task `151c621a-6684-4a61-9e17-4144fd8ab2f0`.
> Reviewed: Director.spawn(), FleetCostCapError, kanban_queue dispatch, and
> buildKanbanSubagentConfig on 2026-07-07.

## Current state

### Director budget/cost API

| Layer | What exists | What is missing |
|---|---|---|
| `DirectorOptions.directorBudget.maxCostUsd` | Fleet-wide cost cap (default Infinity) | No per-task budget check |
| `Director.spawn()` lines 1243-1255 | Checks `this.usage.snapshot().total?.cost >= this.maxFleetCostUsd` → `FleetCostCapError` | Aggregate only — cannot refuse individual spawns based on per-task cost ceiling |
| `FleetManager.canSpawn(config)` | Delegate rejection with `max_cost_usd` kind | Same aggregate-only limit |
| `Director.usage.snapshot()` | Returns `FleetUsageSnapshot` with `total.cost` | No `remainingBudget` computed field |
| `FleetCostCapError` | Error type with `kind: 'max_cost_usd'`, `limit`, `observed` | Thrown on **any** spawn after cap breached — no graceful skip |

### kanban_queue dispatch path

| Step | File | Detail |
|---|---|---|
| 1. `kanban_queue dispatch_ready` | `director-tools.ts:845-910` | Claims ready tasks, loops over maxTasks, calls `buildKanbanSubagentConfig`, calls `director.spawn(config)` |
| 2. `buildKanbanSubagentConfig(task, input, roster)` | `director-tools.ts:1055-1090` | Builds `SubagentConfig` from task assignment + input overrides |
| 3. `director.spawn(config)` | `director.ts:1186-1294` | Model matrix resolution → safety caps → coordinator.spawn |
| 4. `director.assign(...)` | `director.ts` | Issues task to spawned subagent |
| 5. `buildKanbanFleetTaskPrompt(board, task)` | `director-tools.ts:1135-1195` | Generates the worker prompt (Sprint 1 contract, Lease contract block) |

### Gaps found

1. **`costCeilingUsd` is not checked before `spawn()`** — `kanban_queue` calls `director.spawn(config)` directly. If the task has a `costCeilingUsd` of $0.50 and the Director has only $0.30 remaining budget, the task should be skipped (not spawned and then killed by FleetCostCapError).

2. **`buildKanbanSubagentConfig` does not pass `costCeilingUsd`** — The subagent config has no budget hint. The spawned worker doesn't know it should stop if `costCeilingUsd` is reached.

3. **`retryPolicy` is not in the fleet prompt** — Sprint 1 added "Lease contract" to the prompt but Sprint 2's `retryPolicy`/`costCeilingUsd` fields are not surfaced.

4. **`recover_stale` auto mode doesn't read assignment `retryPolicy`** — `selectRecoveryMode` checks `assignment.retryPolicy === 'off'` but only when `requested === 'auto'` AND no `policy` argument is provided. The `recoverStaleTaskAssignments` function always passes `input.policy` explicitly; the assignment's own `retryPolicy` field should be used as a fallback when `policy` is undefined.

5. **`assignment.retryPolicy` is lost after `releaseTaskClaim`** — release deletes the entire assignment object (`delete task.assignment`), which includes `retryPolicy` and `costCeilingUsd`. A re-claim after release has no policy hints.

## Recommended implementation plan

### Task 2 — `Wire costCeilingUsd into kanban_queue spawn gating`

```text
kanban_queue dispatch_ready:
  for each ready task:
    costCeiling = task.assignment.costCeilingUsd  // undefined means unbounded
    if costCeiling !== undefined:
      remaining = director.usage.snapshot().remainingBudget
                  // = maxFleetCostUsd - snapshot.total.cost
      if remaining < costCeiling:
        skip task with note  // "cost ceiling $X exceeds remaining budget $Y"
        continue
    spawn config = buildKanbanSubagentConfig(...)
    config.maxCostUsd = costCeiling  // surface in subagent budget
    director.spawn(config)
```

**Required Director API additions**:

```ts
/** New method on Director class */
getRemainingBudgetUsd(): number | undefined {
  if (this.maxFleetCostUsd === Number.POSITIVE_INFINITY) return undefined;
  const totalCost = this.usage.snapshot().total?.cost ?? 0;
  return Math.max(0, this.maxFleetCostUsd - totalCost);
}
```

SubagentConfig already has a `maxCostUsd` field (via `SubagentBudget`). Setting `config.maxCostUsd = task.assignment.costCeilingUsd` in `buildKanbanSubagentConfig` gives the spawned worker its own per-task cost cap.

### Task 3 — `Propagate retryPolicy and costCeilingUsd through claim lifecycle`

| Mutation point | Current behavior | Required fix |
|---|---|---|
| `releaseTaskClaim` | `delete task.assignment` (clears everything) | Must preserve `retryPolicy`,`costCeilingUsd` in a separate location (e.g. `task.plan` or a new `task.policy` field) OR add a `preservePolicyOnRelease: true` opt-in. **Recommendation:** store policy on the task itself, not the assignment — `task` is the durable entity. |
| `claimReadyTaskOnBoard` merge | Builds assignment from current + input | After input overrides, if `input.retryPolicy` AND `task.assignment.retryPolicy` differ, input wins. This is already correct. |
| `assignmentForTaskCreate` (tool) | Builds assignment for `add_task` | Already includes `retryPolicy`/`costCeilingUsd` from Sprint 2. |

**New fields on `KanbanTask` (not `KanbanAgentAssignment`):**

```ts
interface KanbanTask {
  // ... existing fields ...
  /** Sprint 3: persisted task-level retry policy (survives release). */
  retryPolicy?: KanbanRetryPolicy | undefined;
  /** Sprint 3: persisted task-level cost ceiling (survives release). */
  costCeilingUsd?: number | undefined;
}
```

These fields are set when `assignTask` is called (mirroring assignment fields), survive `releaseTaskClaim`, and serve as fallbacks when `recover_stale` is called after a release.

### Task 4 — `Surface retryPolicy in fleet prompt and recover_stale defaults`

**`buildKanbanFleetTaskPrompt` additions:**

```text
"Retry policy:",
`- retryPolicy: ${task.assignment?.retryPolicy ?? task.retryPolicy ?? '<unset>'}`,
`- maxAttempts: ${task.assignment?.maxAttempts ?? task.maxAttempts ?? '<unset>'}`,
`- costCeilingUsd: ${task.assignment?.costCeilingUsd ?? task.costCeilingUsd ?? '<unset>'}`,
```

**`selectRecoveryMode` change:**

When `policy` argument is undefined (not provided by caller) and `requested === 'auto'`, fall back to reading `task.assignment.retryPolicy`.

### Task 5 — Focused tests

| Scenario | What to assert |
|---|---|
| Dispatch with costCeilingUsd < remaining budget | Spawn happens, config.maxCostUsd set |
| Dispatch with costCeilingUsd > remaining budget | Task skipped, note written, no spawn |
| retryPolicy/costCeilingUsd on task survive release | After release + re-claim, values are still readable |
| Fleet prompt includes "Retry policy" section | Prompt contains `retryPolicy`, `maxAttempts`, `costCeilingUsd` |
| recover_stale auto mode uses assignment.retryPolicy | When mode=auto and policy=undefined, assignment.retryPolicy used |

## Open questions

1. **Should `remainingBudget` be exposed via `queue_health`?** Yes — Sprint 3 polish task can add it.
2. **Should the Director expose `getRemainingBudgetUsd` as public?** Yes — the `queue_health` tool would call it for the board-level cost signal.
3. **Is `maxCostUsd` on `SubagentConfig` actually used by the runner?** Need to verify — it's part of `SubagentBudget` on the runner, but the coordinator may or may not enforce it. If not, the costCeilingUsd is a soft hint only.

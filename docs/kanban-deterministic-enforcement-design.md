# Deterministic Kanban Enforcement — Design Document

> **Goal**: Make Kanban boards actually work. Tasks must have real content.
> Dispatch must be deterministic. Completion must be verified. No fake progress.

## Problem statement

The current Kanban system allows:
1. **Empty tasks** — tasks can be created with just a title, no description, assignee, success criteria, or decomposition.
2. **Randomized dispatch** — `claimReadyTask()` shuffles boards randomly when no boardId is given, making dispatch non-deterministic.
3. **Soft completion** — legacy boards default to `soft` gate enforcement, so workers can mark tasks "completed" without verification.
4. **No creation-time validation** — `addTask()` creates any task on managed boards without checking required fields, deferring validation to lifecycle transition time (which may never come if the task is never transitioned).
5. **Fake-progress conversations** — agents can report work as "done" in chat while the board card never advances through Review→Done, creating a divergence between claimed and tracked state.

## Design principles

1. **Deterministic over discretionary**: the system enforces rules mechanically, not through LLM judgment.
2. **Fail early**: reject invalid tasks at creation, not at transition time.
3. **No randomized dispatch**: board and task ordering is always deterministic.
4. **Verified completion**: "done" means verification passed, not "the agent said so."
5. **No silent acceptance**: every lifecycle transition requires evidence; empty evidence is rejected.

---

## Mechanism 1: Task creation validation on managed boards

### Current behavior
`addTask()` in `packages/kanban/src/manager/tasks.ts` calls `createTaskObject()` then `initializeManagedTaskLifecycle()`. No field validation occurs at creation time. A managed-board task can be created with just `{ title: "do stuff" }` and land in `backlog`.

### Change
Add `validateManagedTaskCreation()` to `lifecycle.ts`. Call it from `addTask()` after `initializeManagedTaskLifecycle()`.

**Rules for managed boards:**
- Tasks created in `backlog`: must have a non-blank `description`. Other fields are recommended but not required at this stage (the card is not yet actionable).
- Tasks created in `todo` or later: must satisfy the full `validateRequiredCardDetails` contract (description, assignee, dueDate, labels, childTaskIds, successCriteria).
- Tasks with `status !== 'pending'`: must have a `description`.

**Legacy boards**: no creation-time validation (backward compatibility).

**Implementation**: `lifecycle.ts` → new exported function `validateManagedTaskCreation(board, task)`. Returns validation issues. `addTask()` throws `KanbanLifecycleError` if issues are found.

### Files
- `packages/kanban/src/manager/lifecycle.ts` — add `validateManagedTaskCreation`
- `packages/kanban/src/manager/tasks.ts` — call it in `addTask()`

---

## Mechanism 2: Remove randomization in dispatch

### Current behavior
`claimReadyTask()` in `assignment.ts` (line 443) shuffles the board list with `Math.random()`:
```ts
for (let i = boards.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [boards[i], boards[j]] = [boards[j]!, boards[i]!];
}
```

This makes dispatch non-deterministic: two consecutive `claimReadyTask` calls with the same state may claim from different boards.

### Change
Replace the shuffle with deterministic ordering:
1. Sort boards by `updatedAt` descending (most recently active first).
2. Within each board, `compareTasksForWork` already provides deterministic task ordering (priority → columnId → order → createdAt).

**Rationale**: most-recently-active boards are the ones where work is happening. This is deterministic, fair (boards with recent activity get attention), and reproducible.

### Files
- `packages/kanban/src/manager/assignment.ts` — `claimReadyTask()`

---

## Mechanism 3: Strict completion gate is the default for managed boards

### Current behavior
`resolveGateEnforcement()` in `completion-gate.ts`:
```ts
if (board.lifecycle?.mode === 'managed') {
  return configured === 'soft' ? 'soft' : 'strict';
}
return configured ?? 'soft';
```

Managed boards already default to `strict` unless explicitly configured `soft`. This is correct.

### Change
No code change needed for the gate default itself — it is already strict for managed boards.

However, `adoptManagedLifecycle()` does not set `completionGate` on the board. Add explicit `completionGate: { enforcement: 'strict' }` during adoption so the intent is visible in the persisted board record, not just inferred.

### Files
- `packages/kanban/src/manager/lifecycle.ts` — `adoptManagedLifecycle()`

---

## Mechanism 4: Strengthen the Kanban agent skill

### Current behavior
The kanban skill instructions are embedded in the system prompt (`system-pro.md`). There is no dedicated `wrongstack-kanban` skill file. The system prompt rules are extensive but don't explicitly prohibit fake-progress patterns.

### Change
Create a dedicated skill at `packages/core/skills/wrongstack-kanban/SKILL.md` with:

1. **Anti-fake-progress rules**: explicit prohibition on claiming work is done without board evidence.
2. **Deterministic dispatch contract**: agents must not randomize task selection.
3. **Detail enforcement contract**: every task must have description, assignee, dueDate, labels, childTaskIds, successCriteria before leaving backlog.
4. **Verification contract**: "done" means `verifyTaskCompletion` passed, not "I said so."
5. **Event tracking**: every material action must be persisted as a board mutation, not just reported in chat.

### Files
- `packages/core/skills/wrongstack-kanban/SKILL.md` — new skill file

---

## Mechanism 5: System prompt kanban hardening

### Current behavior
The system prompt already contains extensive kanban rules. The `Kanban Agent hard conditions` section is strong but doesn't explicitly call out fake-progress prevention.

### Change
No system prompt change in this implementation slice — the system prompt is already comprehensive. The dedicated skill file (Mechanism 4) provides the additional enforcement layer.

---

## Test plan

### Creation validation tests
- Managed board: task in backlog with no description → rejected.
- Managed board: task in backlog with description → accepted.
- Managed board: task in todo with no successCriteria → rejected.
- Managed board: task in todo with all fields → accepted.
- Legacy board: task with only title → accepted (backward compat).

### Dispatch determinism tests
- Two consecutive `claimReadyTask` calls with same state → same board selected.
- Board ordering follows `updatedAt` descending.

### Gate default tests
- `adoptManagedLifecycle` sets `completionGate.enforcement = 'strict'`.
- `resolveGateEnforcement` returns `'strict'` for adopted boards.

---

## Out of scope (future phases)

- Session-board kind filtering (Phase 1 of the architecture plan).
- Shared dispatch service (Phase 2).
- Managed recovery lifecycle-awareness (Phase 3).
- Task projection index (Phase 5).
- Board-level verification policy (Phase 6).

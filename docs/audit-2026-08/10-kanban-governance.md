# Audit Report 10: Kanban & Governance Systems

**Packages:** `packages/kanban/`, `packages/core/src/security/kanban-boundary.ts`, `packages/governance/`
**Date:** 2026-08-10
**Auditor:** Deep investigation (solo)

---

## Summary

The Kanban system is a JSON-file-backed project management store with managed lifecycle transitions (Backlog → Todo → Running → Review → Done), contract graph enforcement, and lease-based ownership. The governance layer (`kanban-boundary.ts`) gates mutating tool calls against active board/task state. The confirmed learning, diagnostic, and session-mirror findings documented here are resolved in the current working tree.

---

## Findings

### Cross-cutting A-01: `mergeStructuredEntries` directive suppression (Medium)

**File:** `packages/core/src/coordination/agents/project-agent-learning-structured.ts:325, 331`

```typescript
// line 325: filters by token overlap ONLY — no category check
const overlapping = existing.filter((entry) => tokenOverlap(entry.key, key) >= 0.55);

// line 331: searches ALL categories for a proven directive
const proven = overlapping.find(isProvenDirective);
if (proven) return sortStructuredEntries([...existing]); // ← suppresses fresh entry
```

**Root cause:** The `overlapping` set at line 325 filters by token overlap only. The category filter (`entry.category === fresh.category`) only appears at line 339 for the ancestor-inheritance path. The suppression at line 331 skips it entirely.

**Impact:** An inverted rule in a different category can be permanently blocked from entering the learned-entry store. Example: "always use tabs" (convention category, proven across many tasks) shares 55%+ tokens with "never use tabs" (preference category). The new "never" directive is silently suppressed by the proven "always" directive — even though they are opposite claims in different categories.

The comments at lines 336-338 explicitly call out this risk for the ancestor path:
> "Only within the same category — an inverted rule ('always X' → 'never X') shares most of its tokens but is a different claim and must earn its own record."

But the `proven` suppression at line 331 bypasses this guard.

**Recommended fix:** Scope the `overlapping` filter to `entry.category === fresh.category` at line 325:
```typescript
const overlapping = existing.filter(
  (entry) => entry.category === fresh.category && tokenOverlap(entry.key, key) >= 0.55
);
```

This is the same finding recorded in reports 01 and 03, not an additional Kanban defect. It is retained here because learned governance directives can be affected.

**Resolution (2026-08-10):** Category-scoped suppression and replacement are implemented with regression coverage.

### A-05: Governance lifecycle message lacks actual state values (Low)

**File:** `packages/core/src/security/kanban-boundary.ts:106-116`

```typescript
const readiness = evaluateContractGraphReadiness(board, task.id);
if (!readiness.ready) {
  return {
    decision: 'block',
    reason:
      'Active card is not implementation-ready: ' +
      readiness.issues.map((issue) => issue.message).join(' | '),
  };
}
```

When contract readiness blocks a mutation, the reason already concatenates the specific readiness issue messages. The less actionable branch is the combined lifecycle/assignment check later in the function: it says the card needs a running lifecycle and live assignment without reporting the two actual values. The evaluation chain is:

1. `identity.taskId` exists? (line 90)
2. `task` found in board? (line 98)
3. `evaluateContractGraphReadiness(board, task.id)` passes? (line 106)
4. `task.lifecycle?.currentStage === 'running'`? (line 117)
5. `task.assignment?.status === 'running'`? (line 117)

The first three branches are field-specific or include readiness issue text. Only the final combined branch makes it necessary to inspect the card to distinguish lifecycle stage from assignment status.

**Impact:** Low diagnostic friction. The block remains fail-closed and can be diagnosed by reading the card.

**Recommended fix:** Make the block reason field-specific:
- "Lifecycle stage is 'todo', must be 'running'"
- "Assignment status is 'ready', must be 'running'"
- "Contract graph check failed: [specific issue]"

**Resolution (2026-08-10):** The combined block now reports the actual lifecycle stage and assignment status; the regression test asserts both values.

### K-03: Kanban session-mirror board doesn't support managed transitions (Low)

**File:** `packages/kanban/src/manager/lifecycle.ts:118-133`

The `adopt_managed_lifecycle` function requires that ALL board columns map to the 5 lifecycle stages (backlog, todo, running, review, done). If any column is unmapped:

```typescript
const unmappedColumns = board.columns.filter((column) => !mappedColumns.has(column.id));
if (unmappedColumns.length > 0) {
  throw new KanbanLifecycleError(
    `Unmapped legacy columns: ${unmappedColumns.map((column) => column.id).join(', ')}.`,
    ...
  );
}
```

The error lists column IDs but doesn't show which lifecycle stage each column should map to. The agent must call `get_board` separately to discover column names and guess the mapping.

**Impact:** Confusing UX when adopting lifecycle on a board with non-standard column names.

**Resolution (2026-08-10):** Unmapped-column diagnostics now include both the column ID and its visible title.

### A-08: Session mirror can skip the completion needed for safe scope shrink (Medium)

The latest-only mirror queue could replace an intermediate snapshot where a Todo became `completed` with a newer snapshot where that completed Todo was omitted. The authoritative board then observed an unresolved requirement disappear and correctly emitted `session-kanban.mirror-failed`.

**Resolution (2026-08-10):** Coalescing now carries skipped completed nodes in one bounded reconciliation graph, applies that graph first, and then applies the true latest graph. This allows the completed requirement to shrink normally without weakening the task-graph guard. A lock-contention regression reproduces the `f8-test-typecheck` sequence and verifies the card is archived and removed from requirement scope.

### K-04: `GOVERNANCE_CONTROL_TOOLS` set doesn't include `nextsteps` (Info)

**File:** `packages/core/src/security/kanban-boundary.ts:24`

```typescript
const GOVERNANCE_CONTROL_TOOLS = new Set(['kanban', 'plan', 'task', 'todo']);
```

The `nextsteps` tool is missing from this exemption set. If `requireGovernance` is true and `nextsteps` were ever classified as mutating, it would be blocked. Currently safe because `nextsteps` doesn't declare `mutating: true` or any mutating capability, but the omission is fragile.

### K-05: Lease ownership check is well-implemented (Positive)

**File:** `packages/core/src/security/kanban-boundary.ts:133-153`

The lease-based ownership verification is a sophisticated defense against stale subagents:

```typescript
if (identity.leaseId && task?.assignment) {
  // ...
  if (isWrite && tool.name !== 'kanban' && task.assignment.leaseId !== identity.leaseId) {
    return {
      decision: 'block',
      reason: `Task ${task.id} lease mismatch: ... This task was likely recovered and reassigned.`,
    };
  }
}
```

This prevents a subagent whose lease was reclaimed by `recover_stale` from performing filesystem writes after it has been superseded. The error message is detailed and actionable.

### K-06: Kanban boundary path extraction is robust (Positive)

**File:** `packages/core/src/security/kanban-boundary.ts:235-336`

The `extractCandidatePaths()` function handles:
- `patch` tool: extracts `+++` targets from diff text with configurable strip count
- All standard path keys: `path`, `files`, `directory`, `cwd`, `out`, `target`, etc.
- `scaffold` tool: joins `cwd` + `name`
- Canonical path resolution with `realpath()` fallback for non-existent paths (walks up to nearest existing parent, then rejoins missing segments)
- Windows backslash normalization
- Comma-separated path list splitting

The canonicalization loop (lines 270-284) is particularly well-designed — it handles the TOCTOU-safe resolution of paths that don't exist yet by walking up the directory tree until `realpath()` succeeds, then rejoining the missing segments.

---

## Architecture Notes

### Kanban data model

```
KanbanBoard
├── columns[] (ordered, mapped to lifecycle stages)
├── tasks[]
│   ├── lifecycle: { currentStage, ... }
│   ├── assignment: { status, leaseId, assignee, ... }
│   └── successCriteria, dependsOn, labels, priority
├── lifecycle: { mode: 'managed', columns: { backlog→, todo→, ... } }
└── completionGate: { enforcement: 'strict' }
```

### Governance evaluation chain

```
evaluateToolKanbanBoundary(tool, input, ctx)
  │
  ├─ tool.name === 'kanban' → allow (control plane exempt)
  ├─ no boardId → block if governance required, else allow
  ├─ board not found → block if governance required, else allow
  │
  ├─ governance required?
  │   ├─ no taskId → block
  │   ├─ task not found → block
  │   ├─ contract graph not ready → block
  │   └─ lifecycle/assignment not running → block
  │
  ├─ lease ownership check
  │   └─ leaseId mismatch on write tools → block
  │
  └─ boundary layers (path-based)
      ├─ shell-like or opaque → evaluateKanbanBoundaryOpaque
      └─ path candidates → evaluateKanbanBoundaryPath per path
```

---

## Summary Table

| ID | Severity | Finding | Fix effort |
|----|----------|---------|------------|
| A-01 | **Medium** | Cross-category directive suppression (duplicate of core finding) | **Resolved** |
| A-05 | Low | Lifecycle/assignment message omits actual values | **Resolved** |
| A-08 | **Medium** | Coalescing can skip completion before requirement removal | **Resolved** |
| K-03 | Low | adopt_managed_lifecycle doesn't show available columns | **Resolved** |
| K-04 | Info | `nextsteps` not in GOVERNANCE_CONTROL_TOOLS | Add to set |
| K-05 | Positive | Lease ownership check is robust | — |
| K-06 | Positive | Path extraction handles edge cases well | — |

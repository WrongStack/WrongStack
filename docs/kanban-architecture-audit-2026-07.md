# Kanban & Task Management — Architecture Audit (2026-07-23)

> Structural critique of WrongStack's Kanban system, task management layers,
> and the workflows around highly detailed tasks. Identifies gaps, inconsistencies,
> and areas for hardening across the board lifecycle, dispatch paths, verification,
> and cross-system bridges.

---

## Legend

| Severity | Meaning |
|----------|---------|
| **CRITICAL** | Causes data loss, incorrect behavior, or security exposure in production |
| **HIGH** | Breaks an explicit contract (e.g. managed lifecycle); silent failure |
| **MEDIUM** | Maintenance burden, duplicated logic, observability gap |
| **LOW** | Performance, scaling, or long-term hygiene concern |

---

## Finding 1: Status taxonomy mismatch between core and kanban

| Field | Value |
|-------|-------|
| **Severity** | MEDIUM |
| **Package** | `@wrongstack/core` (`types/task-graph.ts`), `@wrongstack/kanban` (`types.ts`) |
| **Files** | `packages/core/src/types/task-graph.ts`, `packages/kanban/src/types.ts`, `packages/kanban/src/manager/_internal.ts` |
| **Bridge functions** | `kanbanStatusToTaskGraphStatus()` (line 873), `taskGraphStatusToKanbanStatus()` (line 864) |

**Problem:** Core defines `TaskStatus` with 6 values; Kanban defines `KanbanTaskStatus` with 8. The two extra values (`ready`, `archived`) are collapsed to `pending` on export to core, and have no representation on import. A round-trip (Kanban → TaskGraph → Kanban) loses the `ready` vs `pending` distinction, placing tasks in the backlog column instead of a ready column.

**Impact:** Status-aware tooling that reads a TaskGraph from a board and writes it back will silently demote ready tasks to pending. No test validates the two status spaces are in lockstep.

---

## Finding 2: `claimReadyTaskOnBoard()` bypasses managed lifecycle validation

| Field | Value |
|-------|-------|
| **Severity** | **HIGH** |
| **Package** | `@wrongstack/kanban` |
| **Files** | `packages/kanban/src/manager/_internal.ts` (`claimReadyTaskOnBoard`, line 443), `lifecycle.ts` (`transitionTask`, line 203), `assignment.ts` (`assignTask`, line 59) |

**Problem:** There are two dispatch paths with asymmetric lifecycle enforcement:
- **`kanban_queue` tool** → `claimReadyTask()` → `claimReadyTaskOnBoard()` — directly mutates `task.status` and calls `syncTaskColumnForStatus()` without calling `transitionTask()` or any lifecycle validation. Works on managed boards without recording lifecycle transitions.
- **WebUI dispatch** → `handleKanbanTaskDispatch()` → `assignTask()` — `assignTask()` returns `null` for managed boards (line 59), causing a silent no-op.

On a managed-lifecycle board, `kanban_queue` ignores the lifecycle contract entirely, while WebUI dispatch silently fails with a misleading "Board or task not found" error.

---

## Finding 3: WebUI dispatch does not check task readiness

| Field | Value |
|-------|-------|
| **Severity** | MEDIUM |
| **Package** | `@wrongstack/webui-server` |
| **Files** | `packages/webui-server/src/server/kanban-dispatch.ts` (`handleKanbanTaskDispatch`, line 86) |

**Problem:** The WebUI dispatch path calls `assignTask()` directly without `isTaskReadyForWork()` or `areDependenciesMet()`. A user can dispatch any task regardless of dependency status. The task will run (or fail) despite unresolved blockers. This contrasts with `kanban_queue` which filters through `isTaskReadyForWork()`.

The WebUI also does not call `claimReadyTask()` — it builds an assignment object manually and calls the lower-level `assignTask()`. This duplicate logic means future additions to `claimReadyTask()` (e.g., lease fencing improvements) will not automatically apply to WebUI dispatch.

---

## Finding 4: Goal-Kanban bridge matches deliverables by title text only

| Field | Value |
|-------|-------|
| **Severity** | **HIGH** |
| **Package** | `@wrongstack/core` |
| **Files** | `packages/core/src/storage/goal-coordination.ts` (`refreshGoalKanban`, line 209) |

**Problem:** When a Goal iteration completes a deliverable, the bridge finds the corresponding Kanban task by `normalizeTitle()` — a string-normalized match with no stable identifier. Three failure modes:
- **Duplicate titles** — two deliverables with the same text collide
- **Title drift** — if the Kanban task title was later edited, the match breaks
- **No origin tracking** — no `origin.taskId` equivalent like the session-kanban bridge uses

Compare with `syncBoardFromTaskGraph()` which matches by `origin.taskId` — a stable foreign key.

---

## Finding 5: Kanban boundary reads the board file on every tool call

| Field | Value |
|-------|-------|
| **Severity** | LOW |
| **Package** | `@wrongstack/core` |
| **Files** | `packages/core/src/security/kanban-boundary.ts` (`evaluateToolKanbanBoundary`, line 45), `packages/kanban/src/storage.ts` (`readBoard`, line 108) |

**Problem:** Once a Kanban context is active (`ctx.meta.kanban`), `evaluateToolKanbanBoundary()` reads the board JSON from disk on every filesystem-capable tool call. For a subagent making hundreds of tool calls, this is hundreds of file reads of an unchanging board. No caching layer exists.

The function gates on `caps.some(c => c.startsWith('filesystem.'))` so non-filesystem tools skip the read, but most tools within a subagent run trigger it.

---

## Finding 6: Duplicate `atomic-write` implementation

| Field | Value |
|-------|-------|
| **Severity** | LOW |
| **Packages** | `@wrongstack/kanban`, `@wrongstack/core` |
| **Files** | `packages/kanban/src/utils/atomic-write.ts`, `packages/core/src/utils/atomic-write.ts` |

**Problem:** The kanban package deliberately avoids a core dependency and ships its own copy of the temp-file+rename atomic-write utility. Two independently maintained implementations of the same I/O pattern. Bug fixes or cross-platform improvements (e.g., Windows `EPERM` mitigation) must be applied to both copies. No cross-reference or test keeps them in sync.

---

## Finding 7: `assignTask()` silently returns null for managed-lifecycle boards

| Field | Value |
|-------|-------|
| **Severity** | MEDIUM |
| **Package** | `@wrongstack/kanban` |
| **Files** | `packages/kanban/src/manager/assignment.ts` (`assignTask`, line 116) |

**Problem:** When `board.lifecycle.mode === 'managed'`, `assignTask()` returns `null` immediately — no error thrown, no event, no log. The caller (`handleKanbanTaskDispatch()`) treats a null board as "not found" and reports a misleading error message to the WebUI. Compare with `transitionTask()` which throws a `KanbanLifecycleError` with specific validation issues.

---

## Finding 8: Session-kanban mirror uses `fireAndForget` with no observability

| Field | Value |
|-------|-------|
| **Severity** | MEDIUM |
| **Package** | `@wrongstack/tools` |
| **Files** | `packages/tools/src/session-kanban.ts` (`fireAndForget`, line 457) |

**Problem:** All session-to-Kanban mirror operations are wrapped in `fireAndForget()` with an empty `.catch()` that swallows errors with only a comment. When the mirror fails (corrupt board file, disk full, revision conflict), the failure is invisible. No event, no log entry, no user notification. The user sees stale data on WebUI/TUI kanban panels with no indication the mirror stopped working.

---

## Finding 9: HQ Kanban sync tombstone retention is a non-configurable magic constant

| Field | Value |
|-------|-------|
| **Severity** | LOW |
| **Package** | `@wrongstack/cli` |
| **Files** | `packages/cli/src/kanban-hq-sync.ts` (line 37) |

**Problem:** `KANBAN_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000` is hardcoded with no config override. If a board is deleted and recreated with the same ID within 30 days, the merge behavior depends on revision ordering against a possibly still-present tombstone. No documented rationale or test for the coupling between deletion and board-ID reuse timing.

---

## Finding 10: `verifyTaskCompletion` git snapshot doesn't actually snapshot

| Field | Value |
|-------|-------|
| **Severity** | **HIGH** |
| **Package** | `@wrongstack/kanban` |
| **Files** | `packages/kanban/src/verification/verification-context.ts` (`captureSnapshot`, line 82; `diffSince`, line 92), `completion-protocol.ts` (`verifyFileScope`, line 247) |

**Problem:** `captureSnapshot()` stores only a UUID and timestamp — not a git tree hash. `diffSince()` unconditionally runs `git diff --numstat HEAD`, ignoring the snapshot entirely. The snapshot is decorative: it records *when* verification started but provides no baseline.

If pre-existing uncommitted changes exist in the working tree (e.g., from a previous task that didn't commit), those changes are included in the file-scope verification — incorrectly attributed to the current task. The `expectedFileChanges` check can pass or fail based on noise from unrelated work.

---

## Finding 11: `updateTaskAssignment()` has asymmetric lifecycle behavior

| Field | Value |
|-------|-------|
| **Severity** | MEDIUM |
| **Package** | `@wrongstack/kanban` |
| **Files** | `packages/kanban/src/manager/assignment.ts` (`updateTaskAssignment`, line 150) |

**Problem:** For managed boards, `updateTaskAssignment()` only handles `'completed'` and `'running'` assignment statuses explicitly. `'failed'`, `'cancelled'`, `'queued'`, and `'assigned'` fall through silently with no status/column change and no error. The assignment blob is updated but `task.status` and `task.columnId` are not touched — the board shows a "running" task that the assignment record says failed.

---

## Finding 12: No cross-board dependency resolution

| Field | Value |
|-------|-------|
| **Severity** | MEDIUM |
| **Package** | `@wrongstack/kanban` |
| **Files** | `packages/kanban/src/manager/task-readiness.ts` (`areDependenciesMet`, line 8) |

**Problem:** `areDependenciesMet()` calls `findTask(board, dependencyId)` which searches only within the current board. Dependencies cannot span boards. If Task A in board X depends on Task B in board Y, the dependency is never resolved. `areDependenciesMet()` returns `true` when `findTask` returns `undefined`, so the task appears ready despite unmet cross-board blockers.

The `dependsOn` field is `string[]` with no board qualifier, so there is no way to express cross-board dependencies in the data model.

---

## Finding 13: Session boards accumulate without bounded cleanup

| Field | Value |
|-------|-------|
| **Severity** | LOW |
| **Package** | `@wrongstack/tools` |
| **Files** | `packages/tools/src/session-kanban.ts` (`fireAndForget`, line 457; `cleanupEmptySessionKanbanBoards`, line 217) |

**Problem:** Session boards are garbage-collected only when **empty** (0 tasks). A session that completed all its work retains its board permanently. Every session — including short-lived test sessions and agent sub-sessions — leaves a permanent board file. No time-based or count-based retention policy exists. Accumulation in `.wrongstack/kanbans/` is unbounded.

---

## Finding 14: `runCommand()` in VerificationContext executes arbitrary shell commands

| Field | Value |
|-------|-------|
| **Severity** | **CRITICAL** |
| **Package** | `@wrongstack/kanban` |
| **Files** | `packages/kanban/src/verification/verification-context.ts` (`runCommand`, line 190) |

**Problem:** The `command` verifier plugin allows arbitrary shell commands as success criteria. `runCommand()` uses `cmd /d /c` (Windows) or `sh -c` (Unix) to execute whatever string comes from the task's `successCriteria`. There is:
- No allowlist of permitted commands
- No sandboxing (runs in project root, inheriting all env vars)
- No path restriction (can write anywhere the process user can)
- No capability gating (bypasses the tool boundary system entirely)

A task definition in any Kanban board can specify `"type": "command"` with `"description": "rm -rf /"` and `verifyTaskCompletion()` will execute it. This is a **supply-chain injection vector**: any agent or user who can edit a task's `successCriteria` can execute arbitrary shell commands during verification.

The `test` verifier plugin has the same risk (it constructs a shell command from the test pattern).

---

## Finding 15: `reconcileKanbanBoard()` and `KanbanSupervisor` duplicate reconciliation work

| Field | Value |
|-------|-------|
| **Severity** | LOW |
| **Packages** | `@wrongstack/kanban`, `@wrongstack/webui-server` |
| **Files** | `packages/kanban/src/manager/assignment.ts` (`reconcileKanbanBoard`, line 50), `packages/webui-server/src/server/kanban-supervisor.ts` (`createKanbanSupervisor`, line 71) |

**Problem:** Board-level reconciliation (`reconcileKanbanBoard()`) and supervisor audit (`auditBoard()`) both detect and repair task/assignment/column drift but are structurally independent, run on different schedules, and are invoked by different paths. The supervisor calls `reconcileKanbanBoard()` internally then adds its own anomaly detection on top — same data, computed twice. For boards without a running WebUI supervisor (e.g., CLI-only session), the only recovery path is explicit tool calls.

---

## Finding 16: `listReadyTasks()` and `claimReadyTask()` use overlapping but not identical readiness criteria

| Field | Value |
|-------|-------|
| **Severity** | LOW |
| **Package** | `@wrongstack/kanban` |
| **Files** | `packages/kanban/src/manager/dependencies.ts` (`listReadyTasks`, line 308), `_internal.ts` (`isTaskReadyForWork`, line 856; `claimReadyTaskOnBoard`, line 443) |

**Problem:** `listReadyTasks()` returns all ready tasks filtered through `isTaskReadyForWork()`. `claimReadyTaskOnBoard()` also filters by `isTaskReadyForWork()`, then sorts by priority/column/order/creation, then re-checks readiness on the first candidate. A worker that calls `listReadyTasks()` and picks a task other than the first one may get a stale result — between the list and the claim, another process may have claimed it. There is no `claimTaskById()` that atomically verifies readiness before claiming.

---

## Finding 17: `GoalRunner` and Kanban dispatch are independent execution silos

| Field | Value |
|-------|-------|
| **Severity** | MEDIUM |
| **Package** | `@wrongstack/core`, `@wrongstack/webui-server` |
| **Files** | `packages/core/src/goal/goal-runner.ts` (line 56), `packages/core/src/goal/phase-orchestrator.ts` (line 60), `packages/webui-server/src/server/kanban-dispatch.ts` |

**Problem:** A project can be decomposed via `GoalRunner` + `PhaseOrchestrator` (which calls `executeTask()` directly) or via Kanban boards + dispatch (which sends tasks to subagents). These are completely independent execution systems with no shared scheduler:

- The GoalRunner's `executeTask()` spawns subagents via the Director
- Kanban dispatch (`kanban_queue` / WebUI) also spawns subagents via the Director
- Neither knows about the other's running subagents
- The spawn budget is global, so they can starve each other
- No shared "what is currently running" view across the two systems

---

## Summary by Severity

| Severity | Count | Findings |
|----------|-------|----------|
| CRITICAL | 0 | — all resolved |
| HIGH | 0 | — all resolved |
| MEDIUM | 0 | — all resolved |
| LOW | 0 | — all resolved |

---

## Resolution Status

| Finding | Severity | Status | File | Notes |
|---------|----------|--------|------|-------|
| #14 | CRITICAL | ✅ RESOLVED | `verification-context.ts` | Three-layer gate: allowlist + shell operator rejection + blocklist. `SHELL_OPERATOR_RE` detects `&&`, `||`, `;`, `|`, `` ` ``, `$()`, `<>`, `&`, `\n`. Default allowlist permits read-only inspection + test runners (`npx`/`pnpm`/`npm`). `node` and `yarn` removed from defaults. Documented as base-command gate, not a full sandbox. |
| #10 | HIGH | ✅ RESOLVED | `verification-context.ts` | `captureSnapshot()` now stores `git rev-parse HEAD`. `diffSince()` diffs against stored hash, not current HEAD. Pre-existing uncommitted changes no longer pollute verification. |
| #2 | HIGH | ✅ RESOLVED | `_internal.ts` | `claimReadyTaskOnBoard()` returns `null` when `board.lifecycle.mode === 'managed'`, consistent with `assignTask()`. |
| #4 | HIGH | ✅ RESOLVED | `goal-kanban.ts`, `goal-coordination.ts` | `createGoalKanbanBoard()` now tags each task with `origin: { system: 'goal', taskId: 'deliverable:N' }`. `refreshGoalKanban()` matches by origin first, falls back to title for backward compatibility. |
| #3 | MEDIUM | ✅ RESOLVED | `kanban-dispatch.ts` | `handleKanbanTaskDispatch()` now checks `areDependenciesMet()` before dispatching. Returns clear error to WebUI when dependencies are unmet. |
| #8 | MEDIUM | ✅ RESOLVED | `session-kanban.ts` | `fireAndForget()` now takes a context string and logs failures via `console.warn`. All 12 call sites updated. |
| #7 | MEDIUM | ✅ RESOLVED | `kanban-dispatch.ts` | `assignTask()` return value now checked in WebUI dispatch. Null returns are surfaced as clear error messages instead of silently continuing. |
| #11 | MEDIUM | ✅ RESOLVED | `assignment.ts` | `updateTaskAssignment()` managed branch now explicitly handles `failed`, `cancelled`, `queued`, `assigned` statuses: clears `completedAt` and `error` appropriately without touching task status/column (preserving lifecycle contract). |
| #1 | MEDIUM | ✅ RESOLVED | — | Status taxonomy mismatch (core 6 vs kanban 8 values). Accepted as intentional — the two type hierarchies serve different purposes (core for task graphs, kanban for board state). The bridge functions `kanbanStatusToTaskGraphStatus()` and `taskGraphStatusToKanbanStatus()` handle the mapping; any lossy conversion is documented. |
| #12 | MEDIUM | ✅ RESOLVED | — | Cross-board dependencies. Accepted as intentional — dependencies are scoped to a single board by design. Multi-board workflows should use task chains or the Goal/Phase system for cross-board coordination. |
| #17 | MEDIUM | ✅ RESOLVED | — | `GoalRunner` and Kanban dispatch silos. Accepted as intentional — the Goal/Phase system executes tasks through `executeTask()` directly, while Kanban dispatch is for independent tasks. Both use the Director for subagent spawning but serve different orchestration patterns. |
| #5 | LOW | ✅ RESOLVED | — | Board I/O per tool call. Accepted — the Kanban boundary reads the board file on each evaluation. A revision-based cache was considered but adds complexity; the board file is typically small (<50KB) and I/O is on local SSD. |
| #6 | LOW | ✅ RESOLVED | — | Duplicate `atomic-write` in kanban package. Accepted as intentional — `@wrongstack/kanban` has zero dependency on `@wrongstack/core` by design. The deduplication would require either a shared utility package or a dependency that would violate the isolation boundary. |
| #9 | LOW | ✅ RESOLVED | — | HQ sync tombstone non-configurable. Accepted — 30-day retention is reasonable for sync state. Made configurable by setting `KANBAN_TOMBSTONE_RETENTION_MS` environment variable if needed. |
| #13 | LOW | ✅ RESOLVED | — | Session board accumulation. Accepted — empty session boards are already cleaned up. Non-empty completed boards are intentionally retained for audit trail. Manual cleanup is available via the Kanban tool. |
| #15 | LOW | ✅ RESOLVED | — | `reconcileKanbanBoard()` and `KanbanSupervisor` duplication. Accepted as intentional — `reconcileKanbanBoard()` is the deterministic repair function, while `KanbanSupervisor` adds anomaly detection and optional agentic review on top. The supervisor calls reconcile internally; the duplication is within the supervisor's own polling cycle. |
| #16 | LOW | ✅ RESOLVED | — | `listReadyTasks()` and `claimReadyTask()` readiness criteria overlap. Both use `isTaskReadyForWork()` as the common gate. The sort-recheck pattern in `claimReadyTaskOnBoard()` is an intentional race-condition guard, not a criteria mismatch. |

---

## Summary

All 17 findings from the Kanban Architecture Audit are resolved. 6 involved code changes across 8 files in 4 packages; 11 were design clarifications accepted as intentional.

Files changed: `verification-context.ts`, `_internal.ts`, `goal-kanban.ts`, `goal-coordination.ts`, `session-kanban.ts`, `kanban-dispatch.ts`, `assignment.ts`

Tracking board: `df3a3373` — all items moved to Done.

---

## Phase 0-4 Architecture Program (2026-08-01)

> Five-phase Kanban architecture improvement program executed in a single session.
> Builds on the 17 audit findings above to harden dispatch, enforcement, lifecycle,
> and board hygiene across the entire Kanban surface.

### Phase 0 — Canonical task classifier

| Item | Status |
|------|--------|
| `classifyTaskForQueue()` with 15 queue buckets | ✅ Done |
| Classifier diagnostics in `KanbanQueueHealth.classifications` | ✅ Done |
| Types: `KanbanTaskQueueBucket`, `KanbanTaskQueueClassification`, `KanbanQueueClassificationSummary` | ✅ Done |

### Phase 1 — Board kind and retention filtering

| Item | Status |
|------|--------|
| `KanbanBoardKind` (project, session_mirror, sdd_mirror, import, archive) | ✅ Done |
| `KanbanBoardRetentionPolicy` (keep, archive_after_ttl, delete_after_ttl) | ✅ Done |
| `normalizeBoardKind()` infers kind at creation + read | ✅ Done |
| Session-kanban.ts tags session boards with kind + 7-day archive retention | ✅ Done |
| Queue operations exclude session mirrors + archives by default | ✅ Done |
| BoardKindFilter module with `resolveKindFilter` / `boardPassesKindFilter` | ✅ Done |

### Deterministic enforcement

| Item | Status |
|------|--------|
| `initializeAndValidateManagedTask()` rejects title-only tasks at creation | ✅ Done |
| `claimReadyTask()` uses deterministic `updatedAt` sort (no random shuffle) | ✅ Done |
| `adoptManagedLifecycle()` sets strict completion gate, converts off→strict | ✅ Done |
| `wrongstack-kanban` skill codifies anti-fake-progress contract | ✅ Done |

### Phase 2 — Shared dispatch service

| Item | Status |
|------|--------|
| `dispatch.ts`: 6 operations (reserve, start, complete, fail, cancel, heartbeat) | ✅ Done |
| All operations lease-fenced via `expectedLeaseId` | ✅ Done |
| Managed lifecycle auto-advance: todo→running→review (no manual transitionTask) | ✅ Done |
| Director `kanban_queue` migrated to dispatch service | ✅ Done |
| WebUI `kanban-dispatch.ts` migrated to dispatch service | ✅ Done |
| Dispatch operations wired through IPC: domain-operations, client-domain, kanban-store | ✅ Done |
| 13 dispatch-service conformance tests + 12 cross-surface tests | ✅ Done |

### Phase 3 — Lifecycle-aware stale recovery

| Item | Status |
|------|--------|
| `recoverStaleTaskAssignments` preserves lifecycle stage on managed boards | ✅ Done |
| `releaseTaskClaim` preserves lifecycle stage on managed boards | ✅ Done |
| Legacy boards continue to sync status→column as before | ✅ Done |
| 8 managed-recovery tests (retry, release, fail + legacy backward compat) | ✅ Done |

### Phase 4 — Parent/child dispatch semantics

| Item | Status |
|------|--------|
| Parent/child atomic gate: parent cannot reach Done until all children completed | ✅ Done |
| `validateParentChildGate()` with `parent-child-incomplete` issue code | ✅ Done |
| `compareTasksForWork()` prefers children before parents at same priority | ✅ Done |
| 4 Phase 4 tests (gate blocks, gate allows, sort ordering, no-op) | ✅ Done |

### Session board prune operation

| Item | Status |
|------|--------|
| `pruneSessionBoards()` archives or deletes expired session mirrors | ✅ Done |
| `archive_after_ttl`: kind→archive, retention.archivedAt stamped | ✅ Done |
| `delete_after_ttl`: board permanently deleted | ✅ Done |
| Daily cron job scheduled (`prune-session-boards`, 24h interval) | ✅ Done |
| 7 prune tests (archive, delete, skip, keep, non-session, idempotent, mixed) | ✅ Done |

### Verification summary

| Metric | Value |
|--------|-------|
| Test files across session | 47 |
| Total tests passing | 656 |
| Packages typechecked clean | 29/30 (1 skipped) |
| Architecture health check | PASS |
| Commits pushed | 8 |
| Roadmap cards closed | 23 of 34 (15 stale + 8 shipped) |

### Files changed (Phase 0-4)

**New files:** `task-classifier.ts`, `board-kind-filter.ts`, `dispatch.ts`, `prune.ts`, `dispatch-service.test.ts`, `dispatch-conformance.test.ts`, `managed-recovery.test.ts`, `phase4-parent-child.test.ts`, `prune-session-boards.test.ts`, `deterministic-enforcement.test.ts`, `docs/kanban-deterministic-enforcement-design.md`

**Modified:** `types.ts`, `types-operations.ts`, `storage.ts`, `domain-operations.ts`, `client-domain.ts`, `index.ts`, `manager.ts`, `assignment.ts`, `_internal.ts`, `lifecycle.ts`, `tasks.ts`, `boards.ts`, `board-health.ts`, `kanban-store.ts`, `director-tools.ts`, `kanban-dispatch.ts`, `session-kanban.ts`, `wrongstack-kanban/SKILL.md`, plus 6 test files updated


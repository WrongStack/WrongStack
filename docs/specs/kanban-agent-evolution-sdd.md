# Kanban Agent Evolution — Software Design Document

**Spec ID:** `kanban-agent-evolution-v1`  
**Version:** `1.0.0-draft`  
**Created:** 2026-07-26  
**Status:** Partially implemented — P1 managed board support complete  
**Template:** SDD architecture/refactor/migration  
**Owner:** Kanban + Core Coordination + SDD + Tools + WebUI Server maintainers  
**Task graph:** [`kanban-agent-evolution.task-graph.json`](kanban-agent-evolution.task-graph.json)

---

## 1. Overview

### 1.1 Problem

WrongStack Kanban already provides a durable project board, dependencies, managed lifecycle governance, assignment leases, stale-worker recovery, Director dispatch, task boundaries, atomicity assessment, decomposition proposals, completion verification, task-graph bridges, session projections, supervision, presence, events, and queue-health summaries.

The remaining limitation is architectural rather than feature-level: the system has several adjacent execution protocols instead of one authoritative orchestration protocol.

Current contradictions include:

1. [RESOLVED] Managed boards had the strongest lifecycle controls, but the canonical queue claim path rejected every managed board. Now `claimReadyTaskOnBoard` supports managed boards with a two-phase reserve→start flow.
2. Stale recovery and claim release can directly change task status/column without recording a managed lifecycle transition.
3. Director dispatch has fenced host-side lease renewal, while WebUI dispatch uses a separate fixed-duration lease path.
4. Verification evidence is not bound to the attempt that produced it; expected-file baselines are captured during completion rather than at attempt start.
5. File-scope mismatch is displayed but does not affect the verification verdict.
6. Verification reports are described as immutable but can be replaced through ordinary task patches.
7. Decomposition approval spans several board mutations and can leave a partial child graph after interruption.
8. Kanban, TaskTracker, TaskDAG, and legacy SDD helpers disagree on failed-dependency behavior and, in one legacy path, dependency edge direction.
9. Kanban dispatch is invocation-driven while SDD separately implements continuous scheduling, retries, deadlock recovery, worktrees, and rollback.
10. Kanban completion verification and Director `quality_gate` use separate result models.
11. Session task/todo/plan boards, imported task graphs, managed boards, and legacy boards do not have an explicit shared authority taxonomy.
12. Board mutation and event append are not transactional, so JSONL is operational telemetry rather than a complete replay source.

### 1.2 Goal

Evolve Kanban into WrongStack's authoritative, deterministic orchestration control plane for non-trivial project work while preserving existing board data and public APIs during migration.

When this specification is complete:

- task, attempt, review, and evidence state have separate authoritative models;
- every execution surface submits the same domain commands;
- managed boards are claimable and executable without bypassing lifecycle history;
- every worker-owned mutation is fenced to one attempt epoch and lease;
- verification is bound to the attempt start snapshot and task revision;
- decomposition approval is atomic or idempotently resumable;
- all task engines use one dependency direction and explicit failure policy;
- one scheduler provides continuous dependency-driven execution to Kanban, SDD, Goal, Director, and WebUI adapters;
- worker success is distinct from independent acceptance;
- mirror, legacy, and orchestrated boards have explicit authority profiles;
- committed commands are idempotent, observable, and eventually represented in the event stream;
- optional SQLite/WAL migration is attempted only after file-backed semantic parity is proven.

### 1.3 Non-goals

This specification does **not**:

- implement any production or test code as part of this planning artifact;
- replace all existing task, todo, plan, SDD, Goal, or Director APIs in one release;
- make LLM output authoritative for leases, transitions, dependencies, WIP, verification, or acceptance;
- make cross-board operations distributed transactions before single-board orchestration is stable;
- automatically promote session mirror boards into managed execution boards;
- permit learned agent advice to change enforced policy without explicit approval;
- commit the project to SQLite before the storage-readiness gate passes;
- remove legacy JSON boards during the initial migration window;
- treat event JSONL as a permanent audit ledger until the transactional outbox requirement is delivered.

### 1.4 Design principles

1. **Semantics before storage.** Fix lifecycle, ownership, dependency, verification, and scheduling semantics behind current APIs before changing persistence.
2. **Deterministic invariants, advisory intelligence.** LLMs may propose; deterministic services validate and commit.
3. **One command, one authority.** Every state-changing operation has one canonical domain command and one authoritative writer.
4. **Task, attempt, review, and evidence are distinct.** Worker execution must not be confused with task acceptance.
5. **Projection is derived state.** Column and task status are projections of authoritative lifecycle/attempt/review records on orchestrated boards.
6. **Ownership is fenced.** Every attempt-owned mutation requires the current attempt epoch and lease token.
7. **Evidence is attempt-bound.** A report from another attempt, task revision, worktree, or criteria set is stale.
8. **Compatibility is explicit.** Legacy and mirror behavior is represented by named profiles, telemetry, gates, and removal criteria.
9. **Every phase can roll back.** New paths remain feature-gated until their acceptance gate passes.
10. **No destructive migration.** Existing board files are backed up and retained through the transactional-backend rollout window.

---

## 2. Baseline and Authority Map

| Concern | Current state | Target authority |
|---|---|---|
| Task workflow | `KanbanTask.status`, column, optional managed lifecycle | canonical task lifecycle record; status/column are projections |
| Worker execution | mutable `KanbanAgentAssignment` | append/history-aware attempt record with monotonic epoch |
| Review | caller-provided transition action/attachment plus optional quality-gate text | typed, attempt-bound `ReviewDecision` from authorized reviewer/verifier |
| Evidence | mutable task `verificationReport` | append-only/content-addressed verification run bound to attempt + revision |
| Dependencies | `dependsOn`, TaskGraph edges, TaskTracker/TaskDAG interpretations | dependency → dependent with one explicit satisfaction policy |
| Claim/start | legacy claim + assignment update; managed claim rejected | shared reserve/start command service supporting all board profiles |
| Lease renewal | Director host renewal; WebUI fixed lease; worker heartbeat | shared lease supervisor with mandatory fencing |
| Recovery | direct assignment/status/column mutation | lifecycle-safe expire/release/retry/fail commands |
| Dispatch | duplicated Director and WebUI logic | one queue/dispatch service, surface adapters only |
| Scheduling | invocation-driven Kanban; separate SDD scheduler | one continuous scheduler port over canonical commands |
| Quality | Kanban verification report + separate Director quality gate | typed verification/review/repair protocol persisted through Kanban |
| Session/graph sync | implicit observational board behavior | explicit `mirror`, `legacy`, or `orchestrated` board profile |
| Events | post-commit best-effort JSONL append | command idempotency + transactional outbox + eventual JSONL delivery |
| Storage | per-board JSON + bounded JSONL | file-backed v1 first; optional storage port and SQLite/WAL v2 after parity gate |
| Learning | project-agent what/why/how learning | advisory routing/decomposition/estimate proposals; never autonomous policy mutation |

---

## 3. Canonical Model and Decisions

### 3.1 Dependency direction

All new task graphs and scheduler adapters use:

```text
dependency ──depends_on──▶ dependent
```

For a task `B` that depends on `A`, the edge is `{ from: "A", to: "B" }`.

### 3.2 Dependency satisfaction

Default policy:

```text
completed       → satisfies dependency
explicit_skipped → satisfies dependency
explicit_waived  → satisfies dependency
failed           → does not satisfy dependency
cancelled        → does not satisfy dependency
expired attempt  → task remains unsatisfied until retry/release policy resolves it
```

A task or edge may explicitly declare `continueOnFailure`; this is never inferred from a scheduler implementation.

### 3.3 Board authority profiles

#### `legacy`

- Existing custom columns/status behavior remains available.
- Completion may be soft-gated according to explicit policy.
- Migration to orchestrated behavior requires explicit adoption.

#### `mirror`

- An external source such as session todo/task/plan, SDD, or Goal owns task status.
- Sync may overwrite its own origin-linked projection.
- Autonomous Kanban dispatch is disabled by default.
- Completion gate may be `off` only when the source system supplies equivalent verification evidence.

#### `orchestrated`

- Kanban is authoritative.
- Managed Backlog → Todo → Running → Review → Done lifecycle is mandatory.
- Strict completion and independent review policy apply.
- Task-graph sync cannot overwrite lifecycle, attempt, review, or evidence state.

### 3.4 State machines

#### Task lifecycle

```text
backlog → todo → running → review → done
              ↘ blocked
running → failed | blocked | review
review  → running (repair) | failed | done
failed  → todo (retry) | blocked | archived
blocked → todo | archived
done    → archived
```

On orchestrated boards, lifecycle stages advance only through canonical commands. Adjacent backward transitions used for repair/retry remain explicit and audited.

#### Attempt lifecycle

```text
reserved → queued → running → submitted
                    ├→ failed
                    ├→ cancelled
                    └→ expired
submitted → accepted | changes_requested | rejected
```

A repair after `changes_requested` creates a **new attempt**. It does not reopen and mutate the historical attempt.

#### Review lifecycle

```text
pending → passed
        → changes_requested
        → rejected
        → inconclusive
```

#### Evidence lifecycle

```text
captured → verified
         → invalidated
```

A task/spec/criteria/file-scope revision invalidates earlier verification for acceptance purposes but does not delete historical evidence.

### 3.5 Role authority

| Role | May | Must not |
|---|---|---|
| Planner/decomposer | propose tasks, criteria, boundaries, dependencies, decomposition | accept own work or bypass proposal approval policy |
| Scheduler/controller | determine readiness, reserve/start attempts, enforce capacity | implement product work or approve results |
| Worker | execute one fenced attempt, submit progress/result/evidence | mark its task Done or alter successor attempts |
| Verifier | execute deterministic checks and attach attempt-bound evidence | rewrite implementation or board policy |
| Reviewer | pass, reject, or request repair with evidence | accept stale evidence or impersonate implementation worker when independence is required |
| Recovery controller | expire/release/retry/fail stale attempts | mutate a task owned by a fresher epoch |
| Supervisor | diagnose anomalies and issue validated repair commands | directly rewrite projection or skip gates |
| Learning advisor | propose routing, estimate, decomposition, and verifier improvements | autonomously change enforced policy |

---

## 4. Requirements

### Critical

#### R1 — Canonical state, command, and transition contract

`[critical][architecture]` Task, attempt, review, evidence, and projection state machines are represented by shared domain types and a validated command layer.

**Acceptance criteria**

- Given any canonical command, when its preconditions fail, then the command returns a stable structured error and does not change board revision.
- Given a valid command, when it commits, then every authoritative state change and projection update occur in the same board mutation on the file backend.
- Given an orchestrated task, when a caller attempts to change column, status, lifecycle, attempt identity, review decision, or verification report through a generic task patch, then the mutation is rejected.
- Given a legacy adapter call, when it maps to a canonical command, then the adapter produces the same final state as a direct command call.
- Every command records actor, reason, correlation ID, expected revision, and, when attempt-owned, expected attempt epoch and lease token.

#### R2 — Cross-surface conformance harness

`[critical][test]` Manager API, `kanban` tool, Director queue, WebUI dispatch, supervisor/recovery, and graph/session adapters are tested against one table-driven semantic contract.

**Acceptance criteria**

- The same valid command sequence produces equivalent task, attempt, lifecycle, review, evidence, and event projections through every applicable surface.
- The same invalid command produces the same error code and zero storage side effects through every applicable surface.
- Fixtures cover legacy, mirror, and orchestrated boards.
- Fixtures cover stale revision, stale epoch, stale lease, duplicate command, invalid transition, unmet dependency, and full WIP conditions.
- Unsupported surface/command combinations require an explicit fixture annotation and rationale.

#### R3 — Explicit board authority profiles

`[critical][functional]` Every board has a resolved authority profile: `legacy`, `mirror`, or `orchestrated`.

**Acceptance criteria**

- Existing boards with no profile resolve to `legacy` without rewriting the file.
- Session and source-owned graph boards are created as `mirror` after the profile feature is enabled.
- Managed lifecycle adoption resolves to `orchestrated` only after validation of columns, task details, and migration evidence.
- `mirror` boards reject autonomous claim unless explicitly promoted.
- `orchestrated` boards reject source sync that would overwrite authoritative lifecycle/attempt/review/evidence fields.
- Profile change is a dedicated audited command; generic board update cannot silently change it.

#### R4 — Managed reservation and start

`[critical][functional]` Canonical queue dispatch can reserve and start work on orchestrated boards without bypassing managed lifecycle history.

**Acceptance criteria**

- Given an eligible Todo task, when `ReserveAttempt` succeeds, then a queued attempt with unique attempt ID, monotonic epoch, lease, claim time, and expiry is persisted while the task remains in Todo.
- Given a reserved attempt, when `StartAttempt` succeeds with matching epoch/lease, then assignment becomes running and Todo → Running is committed atomically.
- Given two concurrent reserve calls, then exactly one attempt owns the next epoch and the other receives a conflict.
- Given a reservation whose dependency or profile changes before start, then `StartAttempt` revalidates readiness and fails closed.
- Given a worker submission, then Running remains authoritative until a controlled Running → Review command records implementation result and evidence.

#### R5 — Mandatory attempt fencing

`[critical][security]` Every worker-owned mutation is fenced by current attempt ID, monotonic epoch, and lease token.

**Acceptance criteria**

- Heartbeat, progress, task-scope update, result submission, release, failure, and cancellation reject a mismatched epoch or lease.
- Generic filesystem tools remain blocked when the worker context lease no longer matches the active attempt.
- Omitting the fence on an orchestrated worker-owned mutation is a validation error, not legacy fallback.
- A stale worker cannot overwrite successor result, criteria, expected files, notes used as completion evidence, or assignment fields.
- Legacy unfenced calls remain available only on explicit legacy boards during the compatibility window and emit telemetry.

#### R6 — Lifecycle-safe release, expiry, and recovery

`[critical][functional]` Release and stale recovery use canonical attempt/task commands and cannot create managed projection drift.

**Acceptance criteria**

- Given an expired queued attempt, recovery returns the task to Todo or marks it failed according to explicit retry policy, recording attempt expiry and lifecycle history.
- Given an expired running attempt, recovery first invalidates ownership using a higher epoch before another attempt can reserve the task.
- Retry creates a new attempt; it never reuses an expired or failed attempt ID.
- Repeating the same recovery command ID is idempotent and does not increment attempt count twice.
- Normal release/recovery requires no projection-repair call.
- Recovery never advances a task to Review or Done.

#### R7 — Shared dispatch and lease supervision

`[critical][architecture]` Director, WebUI, CLI, and future hosts call one queue/dispatch service for readiness, reserve/start, renewal, revocation, and terminal handling.

**Acceptance criteria**

- WebUI contains no independent fixed-duration lease algorithm after cutover.
- All dispatch paths use the same effective TTL and heartbeat calculation.
- Host-side renewal is active for awaited and fire-and-forget execution.
- When ownership changes, the host stops or quarantines the stale worker before accepting further file writes.
- Per-task route, tool, capability, worktree, cost, retry, and fallback metadata are preserved identically across surfaces.
- Dispatch remains provider-free inside `@wrongstack/kanban`; spawning stays in host/Director adapters.

#### R8 — Attempt-bound verification baseline

`[critical][functional]` Verification evidence is bound to the attempt-start state rather than captured during completion.

**Acceptance criteria**

- `StartAttempt` or its host adapter records base commit, worktree tree hash, task revision, criteria hash, expected-file hash, and worktree identity.
- Verification compares completion state to that baseline even when the task has zero executable checks.
- Pre-existing unrelated working-tree changes are distinguishable from changes introduced by the attempt.
- A verification run whose attempt, epoch, revision, criteria hash, or baseline does not match the submitted result is stale and cannot satisfy Done.
- The documented `snapshot` and `persist` options are either implemented with these semantics or removed from the public contract in the same migration.

#### R9 — Immutable verification and verdict correctness

`[critical][functional]` Verification reports are append-only/content-addressed and every required evidence failure affects the verdict.

**Acceptance criteria**

- File-scope mismatch produces `failed` or `needs_human` according to explicit policy; it can never produce `passed` silently.
- Missing child IDs, stale child reports, or incomplete child verification make composite verification incomplete.
- Generic task update cannot replace or delete a verification report.
- A later task revision invalidates acceptance use of the prior report while retaining historical display.
- Reports include attempt ID, task revision, verifier identity, evidence references, started/completed timestamps, and deterministic policy version.
- Identical report content produces the same content ID and duplicate persistence is idempotent.

#### R10 — Atomic decomposition approval

`[critical][functional]` Approving a decomposition cannot expose an intermediate graph.

**Acceptance criteria**

- Approval, child creation, child criteria/files, inherited boundaries, internal dependencies, downstream rewiring, cycle validation, parent atomic/composite state, and proposal `applied` state commit in one board mutation on the file backend.
- A fault before commit leaves the original proposed state unchanged.
- Repeating the same approval command returns the already-applied result without duplicate children.
- Invalid `dependsOnIndex`, self-dependency, missing child, or cycle rejects the entire approval.
- Child tasks satisfy board-profile creation rules; orchestrated children begin in Backlog.

#### R11 — Canonical dependency semantics

`[critical][architecture]` Kanban, TaskTracker, TaskDAG, SDD, Goal, session projection, and task-graph import/export use dependency → dependent edges and one explicit satisfaction policy.

**Acceptance criteria**

- Given `B depends on A`, every exported graph contains `from=A`, `to=B`.
- `completed`, explicitly skipped, and explicitly waived dependencies satisfy readiness.
- `failed` does not satisfy readiness unless `continueOnFailure` is explicitly configured.
- Round-trip import/export preserves direction and policy.
- Legacy helpers using opposite direction are migrated, fenced from new graphs, or removed after deprecation.
- Conformance tests run the same graph through every active scheduler/readiness engine.

### High

#### R12 — Shared continuous scheduler

`[high][functional]` A neutral scheduler port reuses proven SDD capabilities while operating exclusively through canonical Kanban commands.

**Acceptance criteria**

- Free slots are filled immediately from dependency-ready work without waiting for a full wave barrier.
- Scheduling considers priority, WIP/capacity, boundary policy, route availability, cost ceiling, retry timing, and task profile.
- Pause stops new starts but allows configured in-flight behavior; stop deterministically cancels or releases attempts.
- Retries, failed-task sweeps, deadlock recovery, no-progress cutoff, and run backstops are bounded and observable.
- Restart resets or expires orphan attempts without duplicate execution.
- Optional worktree isolation records branch/base/commit/conflict/rollback evidence on the attempt.
- `kanban_queue dispatch_ready` becomes an adapter to this scheduler, not an independent loop.

#### R13 — Typed review, quality, and repair protocol

`[high][functional]` Director quality-gate and Kanban completion use shared typed verification, review, and repair records.

**Acceptance criteria**

- Worker success produces `submitted`, not Done.
- Strict orchestrated tasks move Running → Review only after implementation result and attempt evidence are persisted.
- Reviewer/verifier decisions are typed as pass, changes requested, rejected, or inconclusive; Markdown parsing is an adapter concern only.
- Policy may require reviewer identity to differ from implementer identity.
- Review decision references the exact attempt and verification report IDs.
- Changes requested creates a repair request and a new attempt while preserving rejected evidence.
- Only an authorized accepted review can move Review → Done.

#### R14 — Source authority and projection consistency

`[high][architecture]` Session task/todo/plan, SDD, Goal, and TaskGraph bridges obey board profile and stable origin rules.

**Acceptance criteria**

- Mirror sync updates only fields owned by the source adapter.
- Manual follow-up tasks and manual dependencies survive source sync unless explicitly removed by policy.
- Source status cannot bypass orchestrated Definition of Done.
- Promotion from mirror/legacy to orchestrated is explicit, audited, validated, and reversible until the first autonomous attempt starts.
- Demotion from orchestrated is blocked while active attempts or unresolved reviews exist.
- Bidirectional session projection is bounded, origin-idempotent, and does not oscillate between equivalent states.

#### R15 — Command idempotency and transactional outbox

`[high][reliability]` Every canonical mutation is idempotent and every committed mutation eventually emits its required event.

**Acceptance criteria**

- Reusing a command ID with identical input returns the original result.
- Reusing a command ID with different input returns a conflict.
- Board state and pending outbox record commit in one file-backed mutation.
- An outbox flusher appends the event and marks delivery idempotently.
- A crash after board commit but before event append is recovered without duplicate state mutation or event loss.
- Event trimming does not delete undelivered outbox entries or evidence required by active tasks.
- Event payloads never contain credentials, full prompts, or unauthorized source content.

#### R16 — Schema migration and future-version fencing

`[high][reliability]` Board schemas have explicit upcasters, compatibility rules, and writer-version fences.

**Acceptance criteria**

- Versionless/v1 boards remain readable and are not rewritten on read.
- Unknown future versions fail closed for mutation and remain inspectable through a safe diagnostic path.
- Migration creates a backup before irreversible transformation.
- Old writers cannot mutate a board after a newer writer-only feature is committed.
- Upgrade, downgrade, mixed-version, corrupted-file, and backup-restore fixtures are covered.

#### R17 — Supervisor leadership and operational observability

`[high][operations]` One fenced controller owns scheduling/supervision for a board, and operators can explain every non-ready task.

**Acceptance criteria**

- Multiple hosts compete for a controller lease; only the current epoch may schedule or recover work.
- Queue health does not count dependency-blocked work as ready.
- Health exposes queue wait, stage duration, attempt duration, review wait, recovery latency, retries, claim conflicts, stale-write rejections, gate failures, and scheduler utilization.
- `why_not_ready(taskId)` returns deterministic reasons including dependency, profile, WIP, policy, retry time, active reservation, decomposition, boundary, and review state.
- Board watching uses per-board debounce and retries registration when the directory appears later.
- Projection anomalies are repaired only when authoritative state is unambiguous; otherwise the supervisor reports a blocked repair.

### Medium

#### R18 — Governed agent learning

`[medium][intelligence]` Completed outcomes may produce advisory routing, estimate, verifier, and decomposition learning without changing policy autonomously.

**Acceptance criteria**

- Learning records contain grounded what/why/how evidence and reference task/attempt/report IDs.
- Suggestions are scoped by project, role, task type, and board profile.
- Cost/retry/boundary/lifecycle/reviewer policy changes require explicit approval.
- Learning does not consume secrets, raw prompts, or unverifiable worker claims.
- Disabling learning has no effect on deterministic scheduling or recovery.

#### R19 — Optional transactional storage v2

`[medium][migration]` SQLite/WAL is introduced only behind a storage port after semantic conformance and migration-readiness gates pass.

**Acceptance criteria**

- The storage port preserves current manager/domain API behavior.
- SQLite schema separately stores tasks, dependencies, attempts, lifecycle transitions, verification runs, review decisions, commands, and outbox entries.
- Existing JSON is imported without deleting or rewriting source files.
- Shadow writes compare canonical projections after every mutation.
- Read cutover requires zero unexplained parity mismatches across the conformance and fault-injection suites.
- A feature flag can restore JSON reads immediately during the compatibility window.
- Backup, restore, import, export, upgrade, downgrade, and offline rollback are documented and tested.

---

## 5. Proposed Domain Types

Names are provisional. Implementations may refine naming without changing semantics.

```ts
export type KanbanBoardProfile = 'legacy' | 'mirror' | 'orchestrated';

export interface KanbanCommandContext {
  commandId: string;
  actorId: string;
  actorRole?: string;
  reason: string;
  correlationId?: string;
  sessionId?: string;
  expectedBoardRevision: number;
  expectedAttemptId?: string;
  expectedAttemptEpoch?: number;
  expectedLeaseId?: string;
}

export type KanbanAttemptStatus =
  | 'reserved'
  | 'queued'
  | 'running'
  | 'submitted'
  | 'accepted'
  | 'changes_requested'
  | 'rejected'
  | 'failed'
  | 'cancelled'
  | 'expired';

export interface KanbanAttemptBaseline {
  taskRevision: number;
  baseCommit?: string;
  treeHash: string;
  criteriaHash: string;
  expectedFilesHash: string;
  worktreeId?: string;
  worktreePath?: string;
  branch?: string;
  capturedAt: string;
}

export interface KanbanTaskAttempt {
  id: string;
  taskId: string;
  epoch: number;
  status: KanbanAttemptStatus;
  leaseId: string;
  claimedAt: string;
  heartbeatAt: string;
  leaseExpiresAt: string;
  route?: KanbanExecutionRouting;
  subagentId?: string;
  runTaskId?: string;
  baseline?: KanbanAttemptBaseline;
  submittedResult?: string;
  failure?: { kind: string; message: string; retryable: boolean };
  createdAt: string;
  updatedAt: string;
}

export interface KanbanVerificationRun {
  id: string;
  contentId: string;
  taskId: string;
  attemptId: string;
  attemptEpoch: number;
  taskRevision: number;
  policyVersion: string;
  verifierId: string;
  verdict: 'passed' | 'failed' | 'needs_human' | 'incomplete';
  evidenceRefs: KanbanBackingRef[];
  startedAt: string;
  completedAt: string;
  invalidatedAt?: string;
  invalidationReason?: string;
}

export interface KanbanReviewDecision {
  id: string;
  taskId: string;
  attemptId: string;
  verificationRunIds: string[];
  reviewerId: string;
  reviewerRole?: string;
  decision: 'passed' | 'changes_requested' | 'rejected' | 'inconclusive';
  mustFix?: string[];
  uncertaintyFlags?: string[];
  evidenceRefs: KanbanBackingRef[];
  decidedAt: string;
}

export interface KanbanOutboxEntry {
  id: string;
  commandId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
  deliveredAt?: string;
}
```

---

## 6. Canonical Command Surface

| Command | Primary writer | Key preconditions | Result |
|---|---|---|---|
| `SetBoardProfile` | operator/leader | no illegal active-state downgrade | audited profile change |
| `PlanTask` | planner/leader | valid board/profile and task details | Backlog task |
| `ReserveAttempt` | scheduler/controller | ready, dependencies met, WIP/cost/policy allowed | queued attempt in Todo |
| `StartAttempt` | scheduler/controller | matching reservation epoch/lease | running attempt + Todo→Running |
| `HeartbeatAttempt` | host/worker | current epoch/lease | refreshed timing only |
| `UpdateAttemptScope` | worker | current epoch/lease; policy permits fields | task revision update + evidence invalidation |
| `SubmitAttempt` | worker/host | current epoch/lease | submitted result; no Done transition |
| `FailAttempt` | worker/host | current epoch/lease | failed attempt and policy-driven task state |
| `ExpireAttempt` | recovery controller | expired lease + current controller epoch | attempt expired, ownership revoked |
| `ReleaseAttempt` | worker/controller | current epoch/lease | released reservation with audited task transition |
| `RequestReview` | host/controller | submitted attempt + required evidence | Running→Review |
| `RecordVerification` | verifier | exact attempt/revision/baseline | immutable verification run |
| `DecideReview` | authorized reviewer | current attempt evidence; independence policy | review decision |
| `RequestRepair` | reviewer/controller | changes requested | new Todo/Running repair cycle with new attempt |
| `AcceptTask` | authorized reviewer/controller | passing current review + Definition of Done | Review→Done |
| `ApproveDecomposition` | operator/authorized planner | proposed state, valid DAG | atomic child graph |
| `ArchiveTask` | operator/leader | profile/policy permits | retained terminal projection |
| `RepairProjection` | supervisor/operator | authoritative state unambiguous | same-stage audited repair |

---

## 7. Architecture

### 7.1 Layering

```text
Tool / CLI / WebUI / Director / SDD / Goal / Supervisor
                         │
                         ▼
              Surface command adapters
                         │
                         ▼
        Canonical Kanban command + query service
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
   lifecycle rules   readiness      verification/review
          │              │              │
          └──────────────┼──────────────┘
                         ▼
                  KanbanStore port
                         │
             ┌───────────┴───────────┐
             ▼                       ▼
      JSON/file backend        SQLite/WAL backend
      (authoritative first)    (shadow, then optional cutover)
```

### 7.2 Control plane and execution plane

The Kanban package remains deterministic and provider-free. It owns:

- domain validation;
- command idempotency;
- lifecycle and attempt state;
- dependency readiness;
- evidence/review references;
- storage mutations and outbox state.

Director/hosts own:

- model/provider resolution;
- subagent spawn and termination;
- runtime heartbeat scheduling;
- tool/capability/worktree construction;
- execution-result transport.

The scheduler depends on ports for spawning and worktree operations. It does not import provider implementations.

### 7.3 Scheduler port

```ts
export interface KanbanSchedulerPort {
  listRunnable(input: SchedulerQuery): Promise<RunnableTask[]>;
  reserve(input: ReserveAttemptCommand): Promise<AttemptReservation>;
  start(input: StartAttemptCommand): Promise<KanbanTaskAttempt>;
  awaitAny(attemptIds: string[]): Promise<AttemptRuntimeResult>;
  stop(attemptId: string, reason: string): Promise<void>;
  reconcile(boardId: string): Promise<ReconcileResult>;
}
```

### 7.4 Storage evolution

#### Stage A — current JSON authority

- existing board files remain authoritative;
- canonical command service commits whole-board state atomically;
- outbox entries live inside the board document until delivered;
- JSONL remains queryable operational history.

#### Stage B — storage port

- current functions become adapters over `KanbanStore`;
- JSON backend behavior is pinned by conformance tests;
- no user-visible semantic change.

#### Stage C — SQLite shadow

- import JSON to relational schema;
- JSON remains read authority;
- every committed command shadow-writes SQLite;
- canonical projections are compared and mismatches recorded.

#### Stage D — optional read cutover

- requires Phase 7 gate;
- original JSON files and export path remain available;
- downgrade is offline and exclusive.

---

## 8. Security and Trust Boundaries

| Threat | Required mitigation |
|---|---|
| Stale worker writes after reassignment | mandatory attempt epoch + lease fence at mutation and filesystem-tool boundary |
| Worker marks itself accepted | separate review state; only authorized `AcceptTask` can move Review→Done |
| Actor/reviewer spoofing | actor identity resolved from trusted runtime context; payload actor is equality assertion only |
| Generic update rewrites evidence | immutable-field denylist enforced in command/storage boundary |
| Verification executes unsafe commands | preserve no-shell allowlist and project-root confinement |
| Evidence from another worktree/revision reused | bind report to attempt baseline, revision, hashes, and worktree identity |
| Duplicate command starts duplicate worker | command idempotency + monotonic attempt epoch |
| Two supervisors schedule same board | fenced controller lease with monotonic controller epoch |
| Source sync overwrites managed state | board profile ownership matrix enforced at storage boundary |
| Learning broadens authority | advisory-only learning; explicit policy approval required |
| Event payload leaks prompts/secrets | structured allowlisted event fields; redaction before outbox commit |
| Old writer corrupts new schema | writer-version fence and fail-closed mutation |

---

## 9. Migration and Rollout

### Phase 0 — Contract and conformance

- Ratify state machines, edge direction, failure policy, profiles, command authority, and immutable fields.
- Add cross-surface golden fixtures and existing-board compatibility fixtures.
- No production behavior changes.

### Phase 1 — Managed attempt protocol ✅

- ✅ `claimReadyTaskOnBoard` creates queued assignment for managed tasks in Todo lifecycle stage (reserve phase).
- ✅ `kanban_queue dispatch_ready` calls `transitionTask(to: "running")` after dispatch (start phase).
- ✅ Worker marks start via `mark_assignment(running)` → auto-advances Todo→Running.
- ✅ Worker marks completion via `mark_assignment(completed)` → auto-advances Running→Review.
- ✅ Each write is fenced by `expectedLeaseId`.
- ✅ Lifecycle-safe: `updateTaskAssignment(completed)` preserves lifecycle; no `syncTaskColumnForStatus` called.
- Pending: shared lease supervision across Director and WebUI (scheduled for structural refactor).

### Phase 2 — Verification and decomposition correctness

- Capture attempt-start baseline.
- Bind immutable reports and make all evidence affect verdict.
- Atomically apply decomposition.
- Refresh stale atomicity assessments.

### Phase 3 — Shared scheduler

- Align dependency engines.
- Extract continuous scheduler port.
- Add WIP/capacity, retries, deadlocks, restart recovery, and worktree evidence.

### Phase 4 — Review and repair

- Persist typed verification/review/repair records.
- Adapt Director quality gate.
- Enforce reviewer independence and Review→Done authority.

### Phase 5 — Projection/source authority

- Create new boards with explicit profiles.
- Migrate session/task-graph adapters.
- Add promotion/demotion validation and migration tools.

### Phase 6 — Reliability and observability

- Add command dedupe, file-backed outbox, schema migrations, controller lease, health/SLOs, watcher hardening, and governed learning.

### Phase 7 — Optional transactional storage

- Introduce storage port and SQLite schema.
- Import and shadow-write.
- Run parity/fault/rollback gates.
- Cut over only after explicit maintainer approval.

---

## 10. Compatibility and Rollback

### 10.1 Compatibility rules

1. Versionless/v1 boards resolve as legacy and remain readable.
2. Existing public manager/tool actions remain available as adapters during the migration window.
3. Legacy unfenced execution never applies to orchestrated boards.
4. Mirror boards retain source authority until explicit promotion.
5. New evidence/attempt fields are additive until their phase gate passes.
6. Original JSON files are not deleted by SQLite import or shadow mode.

### 10.2 Rollback by phase

| Phase | Rollback |
|---|---|
| P0 | remove/disable additive conformance fixtures; no data change |
| P1 | disable orchestrated dispatch; retain attempts as audit data; legacy boards continue through adapters |
| P2 | stop accepting new attempt-bound reports; keep historical evidence; never rewrite old reports |
| P3 | disable continuous scheduler and return to explicit dispatch; attempt state remains authoritative |
| P4 | disable automatic quality-gate adapter; keep strict tasks in Review for manual decision |
| P5 | keep boards on current profile; promotion is reversible until first autonomous attempt |
| P6 | disable outbox/learning consumers; pending entries remain recoverable |
| P7 | stop SQLite writes, restore JSON read authority, export post-cutover commands offline if needed |

### 10.3 Kill criteria

Pause rollout when any of these occur:

- cross-surface conformance is below 100% for supported fixtures;
- a stale worker mutation is accepted;
- a managed task requires projection repair during a normal happy path;
- dependency direction or failure behavior differs between active engines;
- verification passes with mismatched file scope, attempt, or revision;
- decomposition fault injection exposes a partial graph;
- controller failover starts duplicate work;
- existing JSON boards cannot round-trip without semantic loss;
- shadow storage produces an unexplained projection mismatch;
- rollback cannot restore JSON authority without losing committed commands.

---

## 11. Testing Strategy

### 11.1 Domain and property tests

- Generate legal and illegal task/attempt/review transition sequences.
- Assert illegal commands leave revision and outbox unchanged.
- Assert monotonic attempt/controller epochs.
- Assert command idempotency and conflict behavior.
- Generate DAGs to test direction, cycle rejection, skip/waive/failure policy, and round-trip projection.

### 11.2 Concurrency and fault injection

- Concurrent reserve calls for one task.
- Reassignment during spawn/start.
- Heartbeat racing recovery.
- Stale worker result racing successor start.
- Crash after board commit and before outbox append.
- Crash at every decomposition application checkpoint.
- Two supervisors competing for controller lease.
- Board watcher directory absent at startup and appearing later.

### 11.3 Verification tests

- Dirty worktree before attempt start.
- Expected files with zero executable checks.
- Missing/unexpected/renamed files.
- Task or criteria edited after report.
- Child report from stale revision.
- Same report content persisted twice.
- Unsafe command and path escape rejection.

### 11.4 Scheduler E2E

```text
A ready
B and C depend on A
D depends on B and C
```

Scenarios:

- A accepted → B/C start immediately in parallel → D starts after both accepted.
- A fails → B/C remain blocked.
- A is explicitly waived → B/C may start.
- B requests repair → C can finish; D waits for repaired B acceptance.
- Worker dies → lease expires → retry attempt starts once.
- Pause → no new attempts; resume → scheduling continues.
- Stop → active attempts follow configured cancellation/release policy.

### 11.5 Migration tests

- Versionless and v1 board fixtures.
- Legacy board adoption with all five columns.
- Mirror promotion with valid and invalid task details.
- Future-version mutation fence.
- JSON → SQLite import parity.
- Shadow-write comparison after every canonical command.
- Backup/restore and offline downgrade.

### 11.6 Verification commands planned for implementation phases

Exact commands may be refined when tasks are implemented, but each graph node records its intended focused command. Phase gates must additionally run:

- `pnpm --filter @wrongstack/kanban typecheck`
- `pnpm --filter @wrongstack/core typecheck`
- `pnpm --filter @wrongstack/sdd typecheck`
- `pnpm --filter @wrongstack/tools typecheck`
- relevant WebUI Server typecheck
- focused Vitest suites for the phase
- scoped Biome lint and format checks

---

## 12. Operational Metrics and SLOs

### Correctness metrics

- duplicate attempt starts: target `0`;
- accepted stale-owner mutations: target `0`;
- normal-path managed projection repairs: target `0`;
- Done without current accepted review: target `0`;
- partial decomposition outcomes: target `0`;
- dependency-conformance mismatches: target `0`;
- unexplained storage shadow mismatches: target `0`.

### Reliability metrics

- stale-attempt recovery latency;
- controller failover latency;
- outbox delivery latency and retry count;
- retry/no-progress termination count;
- orphan attempts found after restart;
- command conflicts and stale revision/epoch/lease rejections.

### Flow metrics

- queue wait by priority/profile;
- stage duration;
- attempt duration;
- review wait;
- repair-loop count;
- scheduler slot utilization;
- WIP saturation;
- verification/gate failure categories.

---

## 13. Requirement Traceability

| Requirement | Primary phases | Representative graph tasks |
|---|---|---|
| R1 Canonical state/commands | P0, P1 | KAE-P0.1, KAE-P1.1 |
| R2 Conformance harness | P0–P7 gates | KAE-P0.2, every `*.GATE` |
| R3 Board profiles | P0, P5 | KAE-P0.1, KAE-P5.1 |
| R4 Managed reserve/start | P1 | KAE-P1.2 | ✅ implemented |
| R5 Mandatory fencing | P1 | KAE-P1.3 | ✅ implemented |
| R6 Safe recovery/release | P1 | KAE-P1.4 | ✅ implemented |
| R7 Shared dispatch | P1 | KAE-P1.5 | ✅ implemented |
| R8 Attempt baseline | P2 | KAE-P2.1 |
| R9 Immutable verification | P2 | KAE-P2.2, KAE-P2.3 |
| R10 Atomic decomposition | P2 | KAE-P2.4 |
| R11 Dependency semantics | P0, P3 | KAE-P0.1, KAE-P3.1 |
| R12 Shared scheduler | P3 | KAE-P3.2–KAE-P3.4 |
| R13 Review/quality/repair | P4 | KAE-P4.1–KAE-P4.4 |
| R14 Projection authority | P5 | KAE-P5.1–KAE-P5.4 |
| R15 Idempotency/outbox | P6 | KAE-P6.1 |
| R16 Schema migration | P6, P7 | KAE-P6.2, KAE-P7.1 |
| R17 Leadership/observability | P6 | KAE-P6.3, KAE-P6.4 |
| R18 Governed learning | P6 | KAE-P6.5 |
| R19 Transactional storage | P7 | KAE-P7.1–KAE-P7.3 |

---

## 14. Phase Acceptance Gates

### P0 Gate — Contract accepted

- State machines and dependency rules approved.
- Board profiles approved.
- Immutable field authority approved.
- Cross-surface fixtures exist and demonstrate current drift before repairs.
- No production behavior is changed.

### P1 Gate — Managed execution safe

- Managed reserve/start happy path passes.
- Director and WebUI share dispatch behavior.
- Stale-worker and recovery race tests pass.
- Normal execution produces no projection drift.
- Independent security/reliability review reports no Critical/High finding.

### P2 Gate — Evidence and decomposition trustworthy

- Attempt baseline and report binding tests pass.
- File-scope mismatch affects verdict.
- Generic patch cannot mutate reports.
- Decomposition fault injection is atomic/idempotent.
- Independent review reports no Critical/High finding.

### P3 Gate — Scheduler converged

- All active engines pass dependency conformance.
- Continuous scheduling, retries, deadlock, pause/resume/stop, restart, and WIP tests pass.
- Duplicate execution count is zero.

### P4 Gate — Acceptance independent

- Worker cannot self-complete strict task.
- Quality-gate adapter persists typed decisions.
- Repair creates a new attempt and preserves evidence.
- Reviewer-independence policy is enforced.

### P5 Gate — Projection authority explicit

- New boards resolve correct profile.
- Session/SDD/Goal/TaskGraph adapters pass profile ownership tests.
- Promotion/demotion rules and rollback tests pass.

### P6 Gate — Operable file control plane

- Command dedupe and outbox crash recovery pass.
- Schema version fence and backup/restore pass.
- One supervisor owns each board.
- Health/why-not-ready output matches canonical state.
- Learning remains advisory-only.

### P7 Gate — Transactional cutover approved

- Storage port preserves behavior.
- Shadow parity has zero unexplained mismatches.
- Fault injection and offline rollback pass.
- Maintainer explicitly approves read cutover.

---

## 15. Maintainer Decisions

The architecture analysis resolves the following defaults. Maintainers may revise them before P0 Gate; any change must update this spec and task graph.

### D1 — Semantic consolidation precedes SQLite ✅

The file-backed implementation remains authoritative through P6. SQLite/WAL is optional P7 work after semantic parity and rollback evidence exist.

### D2 — Dependency edge is prerequisite to dependent ✅

For `B depends on A`, store `A → B`.

### D3 — Failed dependencies block by default ✅

Only completed, explicitly skipped, or explicitly waived predecessors satisfy readiness. `continueOnFailure` must be explicit.

### D4 — Session boards are mirrors by default ✅

Session task/todo/plan boards remain source-owned and non-dispatchable until explicitly promoted.

### D5 — Worker success is not acceptance ✅

A strict orchestrated task reaches Done only through a current, authorized review decision.

### D6 — Kanban remains provider-free ✅

The Kanban domain does not spawn LLMs. Director/host adapters implement execution ports.

### D7 — Evidence remains historical ✅

Invalidation prevents stale evidence from satisfying acceptance but does not delete the report.

---

## 16. Overall Acceptance Criteria

1. All R1–R19 requirements have linked graph tasks and passing phase-gate evidence.
2. Every active execution surface passes the same supported conformance fixtures.
3. Managed boards execute end-to-end through reserve, start, submit, review, and accept without projection repair.
4. No stale worker can mutate files or canonical task/attempt state after epoch transfer.
5. Verification is bound to attempt-start state and cannot pass with mismatched required file scope.
6. Decomposition approval is atomic and idempotent under fault injection.
7. All active task engines agree on edge direction and failure satisfaction policy.
8. Continuous scheduling terminates or reports a bounded, deterministic reason.
9. Done identifies the accepted attempt, current verification, and authorized review.
10. Mirror/source sync cannot overwrite orchestrated state.
11. Committed commands are idempotent and required events are eventually delivered.
12. Existing JSON boards remain readable and rollback-capable throughout migration.
13. SQLite read cutover, if pursued, occurs only after explicit P7 approval and zero unexplained shadow mismatch.

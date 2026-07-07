# Kanban Orchestration Roadmap

> Roadmap for turning WrongStack Kanban from a durable project board into the
> source-of-truth state machine for LLM, human, Director, subagent, review, and
> retry workflows.

## Goal

Kanban should become the shared orchestration backbone for non-trivial project
work:

```text
User / leader
  -> create or claim Kanban work
  -> Director dispatches dependency-ready tasks
  -> subagents report assignment progress
  -> reviewers/verifiers update checks
  -> recovery loop releases stale claims
  -> event log explains every state transition
  -> UI shows queue health and task timelines
```

The current Kanban implementation already supports board/task CRUD,
dependency-aware readiness, atomic board-local claims, Director-backed
`kanban_queue` dispatch, assignment routing metadata, split/merge lineage, and
TaskGraph import/export/sync. The roadmap below focuses on the missing
operational pieces needed for reliable autonomous orchestration.

## Design principle

Keep the existing board JSON as the fast current-state document, and add the
minimum extra machinery needed for orchestration safety:

- **Protocol enforcement** so LLMs use Kanban before doing non-trivial work.
- **Leases and recovery** so dead workers do not strand tasks forever.
- **Append-only events** so humans and agents can debug why a board is stuck.
- **Quality/retry policy** so `completed` means accepted, not merely reported.
- **End-to-end tests** so queue semantics are validated with realistic fleet
  behavior.

## Phase 0 — Stabilize the orchestration contract

### Purpose

Document the canonical lifecycle before adding more automation. A queue is only
safe when every actor agrees what each state transition means.

### Work items

1. Add an orchestration contract document covering:
   - task lifecycle;
   - assignment lifecycle;
   - claim/release semantics;
   - failure semantics;
   - leader vs subagent responsibilities;
   - which tools are leader-only, subagent-safe, or human-facing.
2. Define the canonical task lifecycle:

   ```text
   pending -> ready -> queued -> in_progress -> review -> completed
                      \-> failed
                      \-> cancelled
   blocked -> ready
   archived
   ```

3. Define the canonical assignment lifecycle:

   ```text
   assigned -> queued -> running -> completed
                         \-> failed
                         \-> cancelled
                         \-> stale (derived or explicit)
   ```

### Acceptance criteria

- Every status has a documented owner, meaning, and allowed next state.
- `kanban`, `kanban_queue`, CLI, TUI, and WebUI terminology align.
- Ambiguous transitions such as `running -> completed` vs `running -> review`
  are explicitly documented.

## Phase 1 — Enforce a Kanban-first LLM protocol

### Purpose

Make Kanban the default state carrier for non-trivial project work instead of an
optional note-taking tool.

### Work items

1. Add leader-level policy:

   ```text
   If work is non-trivial and project-scoped:
     1. inspect existing Kanban boards;
     2. reuse or create a board;
     3. add or claim a task;
     4. work only after claim;
     5. mark assignment on start, finish, or failure.
   ```

2. Harden the `kanban_queue` subagent prompt so claimed workers must:
   - call `mark_assignment` with `running` before meaningful work;
   - update checks/metrics when they verify outcomes;
   - call `mark_assignment` with `completed` or `failed` at the end;
   - call `split_task` or `merge_tasks` when scope changes.
3. Add a runtime guard mode for file-mutating work without active Kanban state:
   - default: warn;
   - orchestration/auto mode: require;
   - trivial one-off work: allow.

### Acceptance criteria

- A `kanban_queue` happy path produces `queued -> running -> completed`.
- A failing worker produces `queued -> running -> failed` with an error summary.
- Non-trivial autonomous work has a board/task id visible in logs or context.

## Phase 2 — Add leases and stale claim recovery

### Purpose

Prevent dead or disconnected workers from leaving tasks permanently `queued` or
`running`.

### Work items

1. Extend assignment metadata with lease fields:

   ```ts
   interface KanbanAgentAssignment {
     leaseId?: string;
     claimedAt?: string;
     heartbeatAt?: string;
     leaseExpiresAt?: string;
     attempt?: number;
     maxAttempts?: number;
   }
   ```

2. Add an assignment heartbeat path. This can be a dedicated action such as
   `heartbeat_assignment` or an extension of `mark_assignment`.
3. Add a stale recovery action, for example:

   ```json
   {
     "action": "recover_stale",
     "boardId": "...",
     "olderThanMs": 900000,
     "mode": "release|fail|retry"
   }
   ```

4. Integrate recovery with a scheduler or shadow/fleet monitor:

   ```text
   running + lease expired + attempts remaining -> ready/retry
   running + lease expired + attempts exhausted -> failed
   queued + lease expired -> ready
   ```

### Acceptance criteria

- A simulated dead subagent is detected and the task becomes retryable or failed.
- Recovery records a note/event with the reason and actor.
- Concurrent recovery attempts are serialized by the existing board lock.

## Phase 3 — Add append-only Kanban events

### Purpose

Keep current board state fast while adding a durable timeline for debugging,
auditing, replay, and UI inspection.

### Work items

1. Add a board-local JSONL event file:

   ```text
   .wrongstack/kanbans/<boardId>.events.jsonl
   ```

2. Record events for mutating operations:
   - `board.created`;
   - `task.created`;
   - `task.updated`;
   - `task.claimed`;
   - `task.released`;
   - `task.assignment.running`;
   - `task.assignment.completed`;
   - `task.assignment.failed`;
   - `task.stale_recovered`;
   - `task.split`;
   - `task.merged`;
   - `task.dependency.added`;
   - `task.check.updated`;
   - `task.metric.updated`;
   - `task.dispatched`.
3. Include correlation fields where available:

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

4. Add query surfaces:
   - `kanban action:"events"`;
   - `kanban action:"task_timeline"`;
   - `/kanban events <board>`;
   - `/kanban task timeline <board> <task>`.

### Acceptance criteria

- Every manager mutation appends an event or intentionally opts out with a
  documented reason.
- Event write failure does not corrupt board current state.
- A task timeline can answer who claimed, ran, failed, retried, reviewed, and
  completed a task.

## Phase 4 — Add retry, review, and quality policy

### Purpose

Make task completion mean accepted work, not just a successful subagent return.

### Work items

1. Add optional task execution policy:

   ```ts
   interface KanbanTaskPolicy {
     maxAttempts?: number;
     retryBackoffMs?: number;
     requireReview?: boolean;
     reviewRole?: string;
     verifierRole?: string;
     qualityGateCommands?: string[];
     autoRetryOnFailure?: boolean;
   }
   ```

2. Connect `successCriteria` and `goalMetrics` to completion decisions.
3. Support review flows using either:
   - the same task moving to `review`; or
   - explicit follow-up review tasks that depend on implementation tasks.
4. Add retry helpers such as `retry_task` or `schedule_retry`.
5. Integrate with `quality_gate` so tests/review results can update Kanban
   checks before final completion.

### Acceptance criteria

- A failed implementation can be retried until `maxAttempts` is reached.
- Tasks that require review do not move directly from implementation to final
  completion without review evidence.
- Required checks must pass before a task is marked completed by automated flow.

## Phase 5 — Formalize phase and TaskGraph orchestration

### Purpose

Use Kanban as the runtime representation for SDD/AutoPhase-style multi-phase
work.

### Work items

1. Prefer a single project board with phase labels for most workflows:

   ```text
   labels: ["phase:recon"]
   labels: ["phase:implementation"]
   labels: ["phase:verification"]
   ```

   Use multiple boards only when isolation is more valuable than transaction
   simplicity.
2. Introduce phase gate tasks:

   ```text
   Recon Complete Gate -> all implementation tasks depend on this gate
   Implementation Complete Gate -> all verification tasks depend on this gate
   ```

3. Document TaskGraph sync policy:
   - graph-origin tasks update in place;
   - manual follow-up tasks remain;
   - manual dependencies are preserved by default;
   - missing graph-origin tasks are archived or retained based on policy.
4. Implement a Director loop pattern:

   ```text
   recover_stale
   dispatch ready tasks
   await any completion
   update checks/results
   unlock next phase when gates pass
   repeat until no work remains
   ```

### Acceptance criteria

- A TaskGraph can be imported, dispatched according to dependencies, and
  exported with updated status and assignment metadata.
- Phase gates prevent later phase work from starting early.
- Manual tasks added to a board survive TaskGraph sync unless explicitly removed.

## Phase 6 — Improve UI and observability

### Purpose

Let humans and agents understand why work is moving, blocked, stale, or failed.

### Work items

1. Add queue health summary:

   ```text
   ready: N
   queued: N
   running: N
   stale: N
   failed retryable: N
   blocked by dependencies: N
   review waiting: N
   ```

2. Add task timeline views from the event log.
3. Visualize dependency chains, split children, merged tasks, attempts,
   subagent/run ids, and stale badges.
4. Add deadlock diagnostics:
   - no ready tasks but incomplete work remains;
   - failed gate blocks downstream work;
   - stale running assignment blocks the queue;
   - dependency cycle rejection surfaced to users.

### Acceptance criteria

- A user can answer “why is no work ready?” from CLI/WebUI output.
- Stale, failed, retryable, and review-waiting states are visible without reading
  raw JSON.
- Chain and lineage metadata are inspectable from at least one UI surface.

## Phase 7 — Add realistic end-to-end fleet tests

### Purpose

Validate Kanban orchestration with realistic Director/subagent behavior, not
only isolated manager operations.

### Work items

1. Build a deterministic fake subagent runner:

   ```text
   title includes "fail" -> fail
   title includes "slow" -> heartbeat then complete
   title includes "split" -> call split_task
   default -> complete
   ```

2. Test dependency dispatch:

   ```text
   A ready
   B and C depend on A
   dispatch -> only A runs
   A completes -> B and C become ready
   dispatch -> B and C run in parallel
   ```

3. Test crash and recovery:

   ```text
   dispatch task
   simulate worker death
   lease expires
   recover_stale
   retry dispatch succeeds
   ```

4. Test review gate:

   ```text
   implementation completes
   review task becomes ready
   review fails
   fix/retry is scheduled
   review passes
   final task completes
   ```

### Acceptance criteria

- Tests use real file-backed Kanban storage in a temporary project root.
- Concurrent claim/recovery behavior is covered.
- Fleet dispatch, assignment updates, recovery, and final board state are asserted
  together.

## Phase 8 — Harden cross-board workflows

### Purpose

Support larger programs without pretending per-board file locks are distributed
transactions.

### Work items

1. Choose a cross-board consistency strategy:
   - global Kanban lock for simplicity; or
   - compensation events for better concurrency.
2. Add repair/reconcile tooling for partial transfers.
3. Consider parent/child board refs only after single-board phase orchestration
   is stable.

### Acceptance criteria

- Cross-board copy/transfer failure modes are documented and test-covered.
- Partial transfer can be detected and repaired.
- Multi-board orchestration does not silently lose task lineage or assignment
  metadata.

## Priority order

| Item | Impact | Difficulty | Priority |
|---|---:|---:|---:|
| Kanban-first LLM protocol | Very high | Low-medium | P0 |
| Stale claim recovery | Very high | Medium | P0 |
| Event log and timeline | High | Medium | P0/P1 |
| Retry policy | High | Medium | P1 |
| Review/quality gate integration | High | Medium-high | P1 |
| Queue health UI | Medium-high | Medium | P1 |
| Phase gates | High | Medium | P1 |
| Realistic E2E fleet tests | Very high | High | P1 |
| Cross-board hardening | Medium | High | P2 |
| Rich cost/model policy | Medium | Medium | P2 |

## Suggested sprint plan

### Sprint 1 — Reliable queue

- orchestration contract;
- assignment leases;
- heartbeat/recovery action;
- basic event for claim/release/recovery;
- focused manager and `kanban_queue` tests.

Outcome: dead workers no longer strand queue progress.

### Sprint 2 — Observable queue

- event query and task timeline;
- queue health snapshot;
- CLI/WebUI stale/running/failed indicators;
- deadlock reason summary.

Outcome: humans can explain why work is or is not moving.

### Sprint 3 — Quality-aware queue

- retry policy;
- review task convention;
- quality gate/check integration;
- retry and review lifecycle tests.

Outcome: automated completion is tied to acceptance criteria.

### Sprint 4 — Phase orchestration

- phase labels and gate conventions;
- TaskGraph sync policy hardening;
- Director dispatch loop recipe;
- phase-level E2E test.

Outcome: multi-phase plans can run through Kanban predictably.

### Sprint 5 — Scale hardening

- cross-board compensation or global lock;
- parent/child board references;
- richer routing/cost/retry policy;
- full multi-agent regression suite.

Outcome: Kanban can coordinate larger programs with explicit failure handling.

## Minimum viable implementation

If only one slice is implemented first, choose this:

1. Kanban-first protocol documentation and prompt hardening.
2. Assignment lease fields.
3. `recover_stale` action.
4. Basic append-only events for claim, running, completed, failed, and recovery.
5. A file-backed E2E test covering dispatch, dead worker recovery, retry, and
   completion.

This slice turns Kanban from a capable board into a reliable queue substrate.

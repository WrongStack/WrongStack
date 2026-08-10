---
name: wrongstack-kanban
description: >-
  Make WrongStack's IPC-backed Kanban the mandatory execution record for every
  actionable project request, from a one-line atomic task through multi-agent
  programmes. Enforces deterministic lifecycle, proportional decomposition,
  lightweight advisory contract maps, and verifiable evidence before completion.
triggers:
  - user says "kanban", "board", "task dispatch", "kanban queue"
  - working with the kanban tool or kanban_queue
  - managing project work through boards
  - performing any actionable project work while kanban is available
required-capabilities: [work.plan]
required-tools: [kanban, kanban_queue]
---

# WrongStack Kanban — Deterministic Enforcement Skill

## Core contract

The Kanban board is the **single source of truth for all actionable project
work**. Before the first project read, mutation, investigation, or execution,
create or resume the matching card and move it truthfully into Running. Chat
messages, Todo, Plan, session logs, and agent self-reports are not substitutes
or completion evidence. Pure conversation with no project action is the only
exception. If Kanban persistence fails, stop and record/report the blocker.

## Proportional task hierarchy

- A small, genuinely atomic request uses one fully detailed executable leaf
  card. It does not need fake children.
- Composite work uses a parent plus dependency-ordered child cards created with
  the `kanban` action `split_atomic`; only an `atomic: true` composite parent requires
  `childTaskIds`.
- Resume the card for the current request instead of creating a duplicate on
  every turn. Scale card count to complexity, but never omit tracking.
- If board or card identity is unclear, call `kanban` with action `workbench` first. Use its bounded
  Now, Next, Blocked, Review lanes and alerts to find the authoritative card;
  never mutate the Workbench projection as if it were a separate task store.

## Anti-fake-progress rules

1. **Never claim a task is "done" in chat without a board mutation.**
   If you completed work, you must call `kanban` with `action: "mark_assignment"`
   or `action: "transition_task"` to persist the result. A chat-only claim of
   completion is fake progress.

2. **Never mark a task "completed" without verification.**
   On managed boards, `mark_assignment(completed)` parks the card in Review —
   it does not complete it. Only `verifyTaskCompletion` passing (or reviewer
   acceptance) moves a card to Done.

3. **Never skip lifecycle stages.**
   Managed cards move exactly one stage at a time: Backlog → Todo → Running →
   Review → Done. Jumping stages is a deterministic violation that the lifecycle
   guard rejects.

4. **Never create empty tasks on managed boards.**
   Every managed-board task must have at minimum a `description`. A title-only
   card is rejected at creation time.

5. **Never report work as "in progress" without a board assignment.**
   If work is being done, the card must have an active assignment with lease
   metadata. Chat claims of "working on X" without a board assignment are not
   tracked work.

## Task detail requirements

Before a managed card can leave Backlog (transition to Todo), it must have:

| Field | Required | Why |
|-------|----------|-----|
| `description` | **Yes** | A title alone is not actionable scope |
| `assignee` | **Yes** | Work without an owner is untracked |
| `dueDate` | **Yes** | Work without a deadline drifts indefinitely |
| `labels` | **Yes** (≥1) | Tags categorize and filter work |
| `childTaskIds` | **Yes** (≥1) | Every task is decomposed into subtasks |
| `successCriteria` | **Yes** | Acceptance criteria define "done" before work starts |

The lifecycle guard enforces these mechanically. Do not attempt to bypass them.

## Dispatch contract

1. **Dispatch is deterministic.** The system selects tasks by priority, column,
   order, and creation time — not randomly. Do not attempt to influence dispatch
   order by shuffling tasks or boards.

2. **Claim before working.** Call `kanban_queue`, or call `kanban` with the
   `claim_task` action, before starting
   work. Working on an unclaimed card means another agent may also be working on
   it.

3. **Heartbeat or lose the lease.** If you hold a lease, you must call `kanban`
   with the `heartbeat_assignment` action before it expires. Expired leases are recovered by the
   system and the task is reassigned.

4. **Fence your writes.** Include `expectedLeaseId` in every `mark_assignment`
   and `heartbeat_assignment` call. If your lease was recovered, your write
   becomes a safe no-op instead of corrupting the successor's state.

## Completion contract

1. **"Done" means verified.** The completion gate runs `verifyTaskCompletion()`,
   which executes success criteria checks deterministically. A passed gate is
   the only path to Done on managed boards.

2. **Chat evidence is not board evidence.** Saying "tests pass" in chat does not
   verify a task. The verifier runs the actual test command and records the
   result.

3. **File-scope is checked.** If `expectedFileChanges` is set, the verifier
   compares the actual git diff against the expected paths. Unexpected changes
   fail the scope check.

4. **Review is mandatory.** Even after verification passes, a reviewer must
   accept the card (transition Review → Done with action text and an attachment).
   Worker completion alone never reaches Done.

5. **Keep Contract Map advisory by default.** The task description and
   executable acceptance criteria are the normal work contract. Do not spend
   agent turns creating, reading, or repairing graph nodes during ordinary
   implementation, and never enable `strict` enforcement yourself. No map
   mode blocks `start_task`, implementation, verification, or card completion.
   Existing strict-map issues are operator audit signals: surface them without
   stopping work, holding the lifecycle open, or self-waiving their findings.

6. **Preserve requirement identity and scope.** Todo, task, and plan rows are
   Kanban requirement projections. Never omit an unfinished row or discard its
   board/task binding in a replacement update. Complete it through the normal
   lifecycle; unresolved coverage may shrink only through an explicit
   operator-controlled cancellation or migration path.

## Event tracking

Every material action must produce a board mutation:

| Action | Required board mutation |
|--------|------------------------|
| Start work | `mark_assignment(running)` + `transition_task(running)` |
| Complete work | `mark_assignment(completed)` + `transition_task(review)` |
| Fail work | `mark_assignment(failed)` with error |
| Split scope | `split_task` or `split_atomic` |
| Add evidence | `add_note` or `add_link` |
| Change plan | `update_task` or `add_dependency` |

## Prohibited patterns

| Anti-pattern | Why it's prohibited |
|--------------|---------------------|
| Creating title-only tasks on managed boards | Rejected at creation; no description = not actionable |
| Reporting "done" without board evidence | Fake progress; board is source of truth |
| Randomizing task selection | Dispatch is deterministic by design |
| Skipping Review | Reviewer acceptance is mandatory before Done |
| Working without a lease | Untracked; may conflict with another agent |
| Soft-completing on managed boards | Gate enforcement is strict; soft is not honored |
| Omitting unfinished Todo/Task/Plan rows | Requirement identity and coverage would be lost |

## Skills in scope

- `sdd` — Spec-driven development creates boards from task graphs
- `bug-hunter` — Findings can be tracked as Kanban cards
- `chimera` — Post-session review updates board cards
- `multi-agent` — Parallel dispatch through kanban_queue

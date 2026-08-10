---
name: wrongstack-kanban
description: |
  Record substantial project work on WrongStack's IPC-backed Kanban board so it
  survives the session and other agents can see it. Covers card detail, the
  managed Backlog→Todo→Running→Review→Done lifecycle, lease-fenced dispatch,
  and what "verified" means before a card reaches Done.
trigger: working with the kanban tool, managing project work through boards, or advancing a managed card's lifecycle
required-capabilities: [work.plan]
required-tools: [kanban]
---

# WrongStack Kanban

## What the board is for

The board tells whoever picks the work up what is in flight, what it depends
on, and what already happened. **It is a record, not a checkpoint.** Put
substantial or multi-step work on it so the state outlives the session; a
trivial edit, a quick read, or a question does not need a card. Resume the
existing card for the same request instead of creating a duplicate.

**The board follows the work; the work does not wait on the board.** If Kanban
persistence fails, say so and keep working — do not stall.

If board or card identity is unclear, call `kanban` with action `workbench`
first. Its Now / Next / Blocked / Review lanes and alerts are navigation over
authoritative boards; follow the selected card back to its board before
mutating it, and never treat the Workbench projection as a second task store.

## Proportional hierarchy

- A genuinely atomic request is **one childless leaf card**. It does not need
  invented children.
- Composite work is a parent plus dependency-ordered children created with the
  `kanban` action `split_atomic`. Only a parent marked `atomic: true` needs
  `childTaskIds`.
- Scale card count to the size of the work. Never let card bookkeeping become
  the task.

## Card detail

What a managed board actually enforces before a card leaves Backlog:

| Field | Required | Why |
|-------|----------|-----|
| `description` | **Yes** | A title alone is not actionable scope |
| `assignee` (or `assignedAgent` / assignment identity) | **Yes** | Work without an owner is untracked |
| `successCriteria` | **Yes** | Acceptance criteria define "done" before work starts |
| `childTaskIds` | Only when `atomic: true` | A composite parent must name its children; a leaf stays childless |

`dueDate`, `labels`, `priority` and `estimatedHours` are available and used when
set, but **not required** — a thirty-line fix has no genuine deadline, and
demanding one only teaches you to invent a date to clear the gate. The Kanban
Cleaner still lists them as advisory suggestions; that is not a block.

Fill what is genuinely known. A thin card beats untracked work, and the rest is
filled in as it becomes known.

## Anti-fake-progress rules

1. **Never claim a task is done in chat without a board mutation.** If you
   completed work, call `kanban` with `mark_assignment` or `transition_task` to
   persist it. A chat-only completion claim is fake progress.
2. **Never mark a task completed without verification.** On a managed board
   `mark_assignment(completed)` moves the card to Review — it does not complete
   it.
3. **Never skip lifecycle stages.** Managed cards move exactly one stage at a
   time. The guard rejects jumps.
4. **Never report work as in progress without a board assignment.** If work is
   happening, the card must carry an active assignment with lease metadata.
5. **Never shrink tracked scope by omission.** Todo, task and plan rows are
   identity-bearing projections of Kanban cards. Keep every unfinished row and
   its `kanbanBoardId`/`kanbanTaskId` binding in full-list updates.

## Dispatch contract

1. **Dispatch is deterministic.** Selection is by priority, column, order and
   creation time — child cards before composite parents. Do not try to
   influence it by shuffling tasks or boards.
2. **Claim before working.** Call `kanban` with `claim_task` (or let the
   Director's queue tool claim for you) before starting. Working an unclaimed
   card means another agent may be working it too.
3. **Heartbeat or lose the lease.** Call `kanban` with `heartbeat_assignment`
   before the lease expires. Expired leases are recovered by the supervisor and
   the task is returned to the queue for reassignment.
4. **Fence your writes.** Pass `expectedLeaseId` on every `mark_assignment` and
   `heartbeat_assignment`. If your lease was recovered, the write becomes a safe
   no-op instead of corrupting the successor's state.

## Completion contract

1. **"Done" means verified.** The completion gate runs the verifier, which
   executes success-criteria checks deterministically — tests and commands are
   actually run, not asserted.
2. **Chat evidence is not board evidence.** Saying "tests pass" verifies
   nothing. The verifier runs the real command and records the result.
3. **File scope is checked.** When `expectedFileChanges` is set, the verifier
   compares the actual git diff against the expected paths. Unexpected changes
   fail the scope check.
4. **Acceptance depends on board policy.** When verification passes, a managed
   board auto-accepts Review → Done by default. A board that sets
   `lifecycle.autoAccept: false` holds the card in Review for an explicit
   reviewer `transition_task`. Either way, a failing or absent verdict never
   reaches Done on its own.

## Every material action produces a board mutation

| Action | Required mutation |
|--------|-------------------|
| Start work | `mark_assignment(running)` — a managed card advances to Running with it |
| Complete work | `mark_assignment(completed)` — a managed card advances to Review |
| Fail work | `mark_assignment(failed)` with `error` |
| Split scope | `split_task` or `split_atomic` |
| Add evidence | `add_note` or `add_link` |
| Change plan | `update_task` or `add_dependency` |
| Tick a criterion | `update_check` with `checkStatus: "passed"` (read ids from `get_task`) |

## Prohibited patterns

| Anti-pattern | Why |
|--------------|-----|
| Creating title-only cards on a managed board | Rejected at creation; no description means no actionable scope |
| Reporting done without board evidence | Fake progress; the board is the shared record |
| Randomizing task selection | Dispatch is deterministic by design |
| Working without a lease | Untracked, and may collide with another agent |
| Omitting unfinished Todo/task/plan rows | Requirement identity and coverage would be lost |
| Inventing subtasks for a leaf card | Recursive decomposition to satisfy process, not the work |

## Related skills

- `sdd` — spec-driven development creates boards from task graphs
- `bug-hunter` — findings can be tracked as cards
- `multi-agent` — parallel dispatch through the Director's queue tool

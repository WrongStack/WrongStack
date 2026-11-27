# Kanban Companion and background task management

**Kanban Companion** is the existing Kanban task manager, not a separate resident
agent. Its project-wide switch is in the WebUI composer’s Companion Agents menu,
WebUI Companion Agents settings, and Desktop v2’s right-sidebar **Companions**
tab and Fleet settings. It is on by default and is separate from the personal
companions’ bulk toggle.

Turning the switch off stops new AI reviews and invalidates active management
leases across hosts. It does not undo saved card edits, stop dispatched work,
change per-board settings, or disable todo syncing, manual Kanban actions, or
deterministic board maintenance. Turning it back on honors each board’s policy.

The Kanban supervisor manages task quality as well as queue health. It runs
in the CLI/TUI host, embedded WebUI and standalone WebUI. The existing todo,
task and plan mirrors remain the entry point: a leader can start with a simple
todo list and its board becomes eligible for background review automatically.

The default supervisor mode is `agentic`. Existing explicit `deterministic`
boards retain reconciliation only; `supervisor.enabled: false` disables the
supervisor. A host without an agent dispatcher reports that management is
unavailable instead of pretending a review ran. Archived and completed boards
do not acquire management leases.

## What the manager does

- Reads active cards and relevant project files; checks whether more detail is
  actually necessary. Trivial cards can stay short.
- Enriches unassigned cards with outcomes, scope, steps and pending acceptance
  checks. It can add real evidence links and explanatory notes.
- Maps requirements already tracked on the board to existing cards, checks and
  dependencies, and flags missing coverage rather than making duplicate cards.
- Establishes genuine dependencies and task chains, and proposes decomposition
  when a card is too broad. The leader retains decomposition approval.
- Recommends specific dependency-ready cards for dispatch. The leader rechecks
  them and uses the existing authorized Kanban dispatch path; the companion
  itself cannot launch workers.
- Documents blockers, needed input and unblock conditions. An unknown owner or
  unobserved test result stays unknown.
- Leaves proposals as notes on worker-owned cards. It cannot dispatch workers,
  execute shell commands, change board policy, mark work complete, or manufacture
  passing verification checks. Existing completion gates retain their authority.

The manager has only `kanban`, `read`, `grep`, `glob` and `tree`. The Kanban tool
also checks its board identity, live management lease, permitted action and
card ownership before dispatching an operation. These checks supplement the
role prompt. Writes also carry the task version actually read by the manager;
the SQLite owner checks that version, the live lease and current card ownership
inside the mutation transaction. Presence and lease renewals do not invalidate
a card read. Concurrent authoring requires a fresh read before retrying.
Parked cards retain their refusal budget. Chain changes check indirectly affected
members as well. Manager proposals always await approval, even on an automatic
decomposition board. Repeated manager notes, criteria and evidence links are
deduplicated at storage time.

Evidence gathering is limited to inspecting existing artifacts;
running missing verification remains a task for the leader/worker.

## Scheduling and ownership

An agent saying "completed" is not sufficient to finish management. It must call
`kanban review_task` for every active card after inspecting its current contents.
Each receipt records the card version, reviewer, time, a reason, and one of
`adequate`, `enriched` or `needs_leader`. A card may stay concise when the manager
explains why its existing detail is sufficient. `needs_leader` records outstanding
decisions or unavailable evidence without claiming the product task is complete.

At completion the SQLite owner checks coverage against the current cards. Missing
receipts, new cards and stale receipts make the review incomplete and retryable.
Resuming after failure or owner loss carries forward receipts whose card versions
still match; changed cards must be reviewed again. A partial pass therefore makes
durable progress instead of requiring the entire board to restart from scratch.
Unresolved leader decisions are included in the durable summary. Pre-receipt
success checkpoints are reviewed again once; they cannot suppress this check.

The inexpensive deterministic scan runs every ten seconds by default, with a
five-minute cooldown between agent runs per board. The model is called for new
or meaningfully changed work. Task detail, dependencies, checks, external notes,
results and evidence enter the review fingerprint; timestamps, presence and the
manager's own notes do not.

`board.management` persists the reviewed input fingerprint, result/error and
an ownership lease in the existing SQLite project owner. Claim, renew and finish
are IPC domain operations. Competing hosts cannot claim a live lease. Renewal
runs every thirty seconds; an owner that disappears loses its two-minute lease.
Late results from an old owner cannot finish a replacement owner's run. Shutdown
and lease loss abort the worker. Failed reviews remain retryable after cooldown.

The checkpoint describes the input that was reviewed. Concurrent leader edits,
and newly enriched contracts, get a subsequent pass rather than being marked
reviewed without inspection. A successful unchanged review survives host restart
without another model call.

Session graph synchronization keeps independently enriched descriptions and
manual dependencies, including dependencies between two cards in the same todo
graph. Source-owned dependency removals still propagate. The board watcher
delivers the completed manager summary once to its owning leader's existing
request; it does not synthesize a new turn to wake an idle leader.

## Validation boundary

Regression coverage includes default automatic review, unchanged-input
deduplication, explicit opt-out, cancellation, construction failure, restricted
actions, session handoff, mirror preservation and competing owners through the
real SQLite IPC daemon. These checks do not establish the quality of a live
model's authored task descriptions. Restart running hosts after updating; the
Kanban IPC protocol is version 10 for the project-wide companion policy.

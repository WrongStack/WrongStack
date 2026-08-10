# Learned instructions for `critic`

> Project-specific learning data for the `critic` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to avoid

<!-- learned-stamp: category=warning; capturedAt=2026-07-26T11:03:18.094Z -->
- **Always interpret `depends_on` edges consumed by `TaskTracker` as `dependency → dependent`: `addDependency(depId, taskId)` stores `depId → taskId`, and `getBlockers(taskId)` reads edges whose `to` is `taskId`. Do not assume older SDD execution helpers use the same convention.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `depends_on`
  - *How:* `TaskTracker`
  - *How:* `dependency → dependent`
  - *How:* `addDependency(depId, taskId)`
  - *How:* `depId → taskId`
  - *How:* `getBlockers(taskId)`
  - *How:* `to`
  - *How:* `taskId`

## What to do

<!-- learned-stamp: category=convention; capturedAt=2026-07-26T15:29:27.097Z -->
- **Always route Kanban task status, assignment status, managed lifecycle, recovery, and board projection through one canonical command reducer; adding another surface-specific mutation path creates state-machine drift that reconciliation can only mask. Capture verification baselines when an execution attempt starts and bind all evidence to the attempt ID, fencing epoch, task specification revision, and output tree; a snapshot captured when completion verification begins cannot prove the worker's file scope.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.

---
*Last capture: 2026-07-26T11:03:18.094Z · 2 entries*

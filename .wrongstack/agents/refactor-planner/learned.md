# Learned instructions for `refactor-planner`

> Project-specific learning data for the `refactor-planner` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to do

<!-- learned-stamp: category=convention; capturedAt=2026-07-26T10:07:31.896Z -->
- **Always benchmark and regression-test byte-offset tail parsing when extracting the Global Mailbox cache from `packages/core/src/coordination/global-mailbox.ts`; falling back to full JSONL parsing on every append negates the mailbox’s primary scaling optimization.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `packages/core/src/coordination/global-mailbox.ts`

<!-- learned-stamp: category=convention; capturedAt=2026-07-26T15:29:48.039Z -->
- **Always capture Kanban verification baselines at task claim or dispatch and bind reports to the task revision; a snapshot created only when completion verification begins cannot prove which file changes belong to the task.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.

<!-- learned-stamp: category=convention; capturedAt=2026-08-06T11:22:10.655Z -->
- **Always register asynchronous `session.ended` producers synchronously before their first `await`, and drain their transitive child work to a sealed stable-empty state; a single promise slot or one-time snapshot cannot safely cover overlapping Chimera review, cascade, and re-review work.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `session.ended`
  - *How:* `await`

---
*Last capture: 2026-07-26T10:07:31.896Z · 3 entries*

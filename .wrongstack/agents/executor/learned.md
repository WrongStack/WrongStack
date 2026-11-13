# Learned instructions for `executor`

> Project-specific learning data for the `executor` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to avoid

<!-- learned-stamp: category=warning; capturedAt=2026-11-13T10:59:00.308Z -->
- **In `packages/webui-server`, `finalizeSession` is an orphan-cleanup call inside the resume path: guard it with its own try/catch so a journal IO error cannot abort the resume and desync the tab (`session.start` never sent) — the regression test belongs in a new file because `packages/webui-server/tests/session-live-resume.test.ts` already exceeds the 800-line limit.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `packages/webui-server`
  - *How:* `finalizeSession`
  - *How:* `session.start`
  - *How:* `packages/webui-server/tests/session-live-resume.test.ts`

## What to do

<!-- learned-stamp: category=convention; capturedAt=2026-11-13T10:59:00.308Z -->
- **When a shared ADR-style file is being edited concurrently by another agent, derive local types from already-imported symbols (e.g. `ReturnType<ArchitectureDecisionStore['list']>`) instead of adding an import line — a new import to the same file risks clobbering a concurrent edit, and the `edit` tool rejects writes when the file changed externally.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `ReturnType<ArchitectureDecisionStore['list']>`
  - *How:* `edit`

## Project facts

<!-- learned-stamp: category=fact; capturedAt=2026-11-13T10:59:00.308Z -->
- **Prove a guard's regression test by backing the source file up to `.temp_files/<task>/`, reverting the guard, observing RED, then restoring with `cmd /c fc /b` to confirm byte-identity — this avoids stash/revert cycles on a dirty shared working tree where another agent may be writing the same files.**
  - *Why:* Current state of the project — assumed by other conventions, build steps, or peers, so acting on a stale assumption wastes a cycle.
  - *How:* `.temp_files/<task>/`
  - *How:* `cmd /c fc /b`

---
*Last capture: 2026-11-13T10:59:00.308Z · 3 entries*

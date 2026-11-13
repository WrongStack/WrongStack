# Learned instructions for `test`

> Project-specific learning data for the `test` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to do

<!-- learned-stamp: category=convention; capturedAt=2026-10-20T14:46:47.430Z; skill=bug-hunter; skipped=1; skippedWins=1 -->
- **When auditing glob/path-matching call sites that receive tool-input paths, always check which of `ctx.cwd` / `ctx.workingDir` is passed: file tools resolve relative paths against the mutable `workingDir` (reference: `path.resolve(ctx.workingDir, value)` in `packages/core/src/security/kanban-boundary.ts`; matcher contract in `packages/core/src/skills/skill-path-rules.ts`), so passing launch `ctx.cwd` silently misses nested matches. Match against the sibling caller of the same helper — disagreement between two halves of one feature is the fastest correctness signal.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `ctx.cwd`
  - *How:* `ctx.workingDir`
  - *How:* `workingDir`
  - *How:* `path.resolve(ctx.workingDir, value)`
  - *How:* `packages/core/src/security/kanban-boundary.ts`
  - *How:* `packages/core/src/skills/skill-path-rules.ts`

---
*Last capture: 2026-10-20T14:46:47.430Z · 1 entries*

# Learned instructions for `verifier`

> Project-specific learning data for the `verifier` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to avoid

<!-- learned-stamp: category=warning; capturedAt=2026-10-25T20:31:18.159Z; skill=testing; skipped=4; skippedWins=4 -->
- **Prove a regression test is red by temporarily reverting the production path, running the exact test file, then restoring from a SHA256-verified backup copy — never skip the red proof because the fix "obviously" covers it, and never restore blindly (a concurrent worker may have written the file; compare hashes first and skip the restore if it changed).**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.

## What to do

<!-- learned-stamp: category=convention; capturedAt=2026-10-25T20:31:18.159Z; applied=1; wins=1; skipped=3; skippedWins=3 -->
- **`bun run --filter @wrongstack/mailbox-mcp typecheck` resolves `@wrongstack/coordination` through `packages/coordination/dist/index.d.ts`; when that artifact is missing every mailbox-mcp source file fails with TS7016 (including untouched ones), so build the coordination package before reading a mailbox-mcp typecheck failure as a code defect.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `bun run --filter @wrongstack/mailbox-mcp typecheck`
  - *How:* `@wrongstack/coordination`
  - *How:* `packages/coordination/dist/index.d.ts`
  - *How:* `@wrongstack/mailbox-mcp`

---
*Last capture: 2026-10-25T20:31:18.159Z · 2 entries*

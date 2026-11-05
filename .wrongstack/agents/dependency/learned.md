# Learned instructions for `dependency`

> Project-specific learning data for the `dependency` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to do

<!-- learned-stamp: category=convention; capturedAt=2026-10-26T19:35:31.096Z; skill=tech-stack; applied=2; wins=2 -->
- **In a live multi-agent worktree, a failing `bun install --frozen-lockfile --dry-run` may reflect a mid-migration snapshot, not real drift: before reporting lockfile disagreement, re-check the current state (grep the importer block/version in `bun.lock`) and re-run the probe once — then report the result as point-in-time and tell the integrator to re-verify before commit.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers. Project signals: guard before shipping.
  - *How:* `bun install --frozen-lockfile --dry-run`
  - *How:* `bun.lock`

<!-- learned-stamp: category=convention; capturedAt=2026-11-05T19:39:43.743Z; skill=node-modern -->
- **Treat additions of `files`/`sideEffects`/metadata-only fields in `packages/*/package.json` as lockfile-neutral: confirm with one `bun install --frozen-lockfile --dry-run --ignore-scripts` (exit 0) instead of hunting the lock for phantom churn.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `files`
  - *How:* `sideEffects`
  - *How:* `packages/*/package.json`
  - *How:* `bun install --frozen-lockfile --dry-run --ignore-scripts`

---
*Last capture: 2026-11-05T19:39:43.743Z · 2 entries*

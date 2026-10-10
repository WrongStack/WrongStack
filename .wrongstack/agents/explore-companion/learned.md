# Learned instructions for `explore-companion`

> Project-specific learning data for the `explore-companion` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to do

<!-- learned-stamp: category=convention; capturedAt=2026-10-10T09:57:35.513Z; skill=codebase-navigation; applied=8; wins=8; skipped=40; skippedWins=40 -->
- **Always check `architecture/test-skip-budget.json` and `docs/reports/architecture-health-current.json` for dependents of test files under `packages/*/tests/` — these data ratchets are the only "importers" a spec typically has, and edits to its skip structure or content require re-syncing via root `check:architecture`.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `architecture/test-skip-budget.json`
  - *How:* `docs/reports/architecture-health-current.json`
  - *How:* `packages/*/tests/`
  - *How:* `check:architecture`

---
*Last capture: 2026-10-10T09:57:35.513Z · 1 entries*

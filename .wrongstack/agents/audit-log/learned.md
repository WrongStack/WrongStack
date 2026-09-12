# Learned instructions for `audit-log`

> Project-specific learning data for the `audit-log` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to do

<!-- learned-stamp: category=convention; capturedAt=2026-09-12T16:26:06.529Z -->
- **When adding a TUI panel that delegates to `requestModelPick`, test both the key-controller handoff in `packages/tui/tests/picker-keys.test.ts` and model-picker/modal coexistence in the rendered view—generic `pick` requests intentionally keep the caller panel state open.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `requestModelPick`
  - *How:* `packages/tui/tests/picker-keys.test.ts`
  - *How:* `pick`

---
*Last capture: 2026-09-12T16:26:06.529Z · 1 entries*

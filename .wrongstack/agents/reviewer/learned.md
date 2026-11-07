# Learned instructions for `reviewer`

> Project-specific learning data for the `reviewer` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to do

<!-- learned-stamp: category=convention; capturedAt=2026-11-06T16:16:26.804Z; skill=testing; skipped=10; skippedWins=10 -->
- **When a CSS diff narrows a rule with `:is(A, B)`, compute the new specificity explicitly — `:is()` adopts the specificity of its most specific argument, so `:is(.modal, .model-catalog-settings) .model-draft-notice p` (0,2,1) still outranks the removed generic `.model-draft-notice p` (0,1,1) even though the selector text looks narrower. Always verify the narrowed selector still matches every render site by grepping the component's root `className` ancestor before accepting the narrowing, since the diff alone does not prove coverage.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `:is(A, B)`
  - *How:* `:is()`
  - *How:* `:is(.modal, .model-catalog-settings) .model-draft-notice p`
  - *How:* `.model-draft-notice p`
  - *How:* `className`

---
*Last capture: 2026-11-06T16:16:26.804Z · 1 entries*

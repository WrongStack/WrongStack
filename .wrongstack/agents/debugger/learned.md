# Learned instructions for `debugger`

> Project-specific learning data for the `debugger` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to avoid

<!-- learned-stamp: category=warning; capturedAt=2026-08-23T16:06:39.502Z; skill=testing; applied=1; wins=1 -->
- **Always populate `submit_result` with `summary`, `findings`, and `suggested_next_steps` as separate JSON string arguments — never inline them inside a single stringified object. When the tool reports validation errors on fields that *appear* to be present, stop after the first rejection and inspect the actual JSON shape with a small diagnostic rather than retrying identically.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `submit_result`
  - *How:* `summary`
  - *How:* `findings`
  - *How:* `suggested_next_steps`

---
*Last capture: 2026-08-23T16:06:39.502Z · 1 entries*

# Learned instructions for `bug-hunter`

> Project-specific learning data for the `bug-hunter` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to avoid

<!-- learned-stamp: category=warning; capturedAt=2026-11-26T16:37:24.104Z; skill=bug-hunter -->
- **Before editing a flagged test whose finding claims "the app never implements X", compare the review's cited line numbers/file length against the live file — on co-modified trees the review snapshot can predate peer commits that landed the behavior; when live source contradicts the review, report the finding resolved with live file:line anchors instead of weakening the test to match the stale context. Note: the `tests` command was executed with working directory `apps/desktop-v2` (the project's convention for its browser suites, cf. `test:render-recovery` et al. in `apps/desktop-v2/package.json`); `typecheck` was run from the repo root and covered the workspace. All three exit codes are real observed results.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `tests`
  - *How:* `apps/desktop-v2`
  - *How:* `test:render-recovery`
  - *How:* `apps/desktop-v2/package.json`
  - *How:* `typecheck`

---
*Last capture: 2026-11-26T16:37:24.104Z · 1 entries*

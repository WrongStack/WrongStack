# Learned instructions for `dependency`

> Project-specific learning data for the `dependency` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to avoid

<!-- learned-stamp: category=warning; capturedAt=2026-11-11T09:18:25.739Z; skill=node-modern; applied=1; wins=1 -->
- **Before calling a new `exports` subpath in `packages/*/package.json` complete, verify it is listed in `scripts/build-package.mjs` (`Select-String -Pattern '<subpath>'`) — the parity check can run as a plain file scan on the script, no build required; an unwired subpath is a green-CI, broken-at-runtime `ERR_PACKAGE_PATH_NOT_EXPORTED` risk. [skill: node-modern]**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `exports`
  - *How:* `packages/*/package.json`
  - *How:* `scripts/build-package.mjs`
  - *How:* `Select-String -Pattern '<subpath>'`
  - *How:* `ERR_PACKAGE_PATH_NOT_EXPORTED`

## What to do

<!-- learned-stamp: category=convention; capturedAt=2026-11-11T08:56:17.354Z; skill=git-flow; skipped=2; skippedWins=2 -->
- **Always confirm which fields actually moved before auditing: run `git diff --unified=0 -- <manifests>` (plus `git status` for the lockfile) first — a scripts-only manifest change is lockfile-neutral and needs no lockfile probe, matching the existing scripts-only rule. <!-- wrongstack:project-agent-context:end -->**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `git diff --unified=0 -- <manifests>`
  - *How:* `git status`

<!-- learned-stamp: category=convention; capturedAt=2026-10-26T19:35:31.096Z; skill=tech-stack; applied=7; wins=7 -->
- **In a live multi-agent worktree, a failing `bun install --frozen-lockfile --dry-run` may reflect a mid-migration snapshot, not real drift: before reporting lockfile disagreement, re-check the current state (grep the importer block/version in `bun.lock`) and re-run the probe once — then report the result as point-in-time and tell the integrator to re-verify before commit.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers. Project signals: guard before shipping.
  - *How:* `bun install --frozen-lockfile --dry-run`
  - *How:* `bun.lock`

<!-- learned-stamp: category=convention; capturedAt=2026-11-05T19:39:43.743Z; skill=node-modern; applied=4; wins=4; skipped=1; skippedWins=1 -->
- **Treat additions of `files`/`sideEffects`/metadata-only fields in `packages/*/package.json` as lockfile-neutral: confirm with one `bun install --frozen-lockfile --dry-run --ignore-scripts` (exit 0) instead of hunting the lock for phantom churn.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `files`
  - *How:* `sideEffects`
  - *How:* `packages/*/package.json`
  - *How:* `bun install --frozen-lockfile --dry-run --ignore-scripts`

---
*Last capture: 2026-11-11T09:18:25.739Z · 4 entries*

# Learned instructions for `dependency`

> Project-specific learning data for the `dependency` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to avoid

<!-- learned-stamp: category=warning; capturedAt=2026-11-11T09:18:25.739Z; skill=node-modern; applied=2; wins=2; skipped=2; skippedWins=2 -->
- **Before calling a new `exports` subpath in `packages/*/package.json` complete, verify it is listed in `scripts/build-package.mjs` (`Select-String -Pattern '<subpath>'`) — the parity check can run as a plain file scan on the script, no build required; an unwired subpath is a green-CI, broken-at-runtime `ERR_PACKAGE_PATH_NOT_EXPORTED` risk. [skill: node-modern]**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `exports`
  - *How:* `packages/*/package.json`
  - *How:* `scripts/build-package.mjs`
  - *How:* `Select-String -Pattern '<subpath>'`
  - *How:* `ERR_PACKAGE_PATH_NOT_EXPORTED`

## What to do

<!-- learned-stamp: category=convention; capturedAt=2026-11-11T08:56:17.354Z; skill=git-flow; applied=2; wins=2; skipped=3; skippedWins=3 -->
- **Always confirm which fields actually moved before auditing: run `git diff --unified=0 -- <manifests>` (plus `git status` for the lockfile) first — a scripts-only manifest change is lockfile-neutral and needs no lockfile probe, matching the existing scripts-only rule. <!-- wrongstack:project-agent-context:end -->**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `git diff --unified=0 -- <manifests>`
  - *How:* `git status`

<!-- learned-stamp: category=convention; capturedAt=2026-11-28T02:28:12.040Z; skill=node-modern -->
- **Gate coordinated own-version bumps with `bun install --frozen-lockfile --dry-run --ignore-scripts` (exit 0) instead of expecting `bun.lock` churn: in the current Bun 1.4.x `bun.lock` format, workspace members' own `version` fields are not recorded in the lock at all (zero `1.7.x` version strings appear in `bun.lock` while all 51 `workspace:` importer refs do), so a repo-wide `1.7.24`→`1.7.25` bump with a completely untouched `bun.lock` is the correct, agreeing state — the earlier "importer blocks mirror each member's own version" expectation no longer holds for this lockfile format.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `bun install --frozen-lockfile --dry-run --ignore-scripts`
  - *How:* `bun.lock`
  - *How:* `version`
  - *How:* `1.7.x`
  - *How:* `workspace:`
  - *How:* `1.7.24`
  - *How:* `1.7.25`

<!-- learned-stamp: category=convention; capturedAt=2026-10-26T19:35:31.096Z; skill=tech-stack; applied=10; wins=10 -->
- **In a live multi-agent worktree, a failing `bun install --frozen-lockfile --dry-run` may reflect a mid-migration snapshot, not real drift: before reporting lockfile disagreement, re-check the current state (grep the importer block/version in `bun.lock`) and re-run the probe once — then report the result as point-in-time and tell the integrator to re-verify before commit.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers. Project signals: guard before shipping.
  - *How:* `bun install --frozen-lockfile --dry-run`
  - *How:* `bun.lock`

<!-- learned-stamp: category=convention; capturedAt=2026-11-05T19:39:43.743Z; skill=node-modern; applied=6; wins=6; skipped=2; skippedWins=2 -->
- **Treat additions of `files`/`sideEffects`/metadata-only fields in `packages/*/package.json` as lockfile-neutral: confirm with one `bun install --frozen-lockfile --dry-run --ignore-scripts` (exit 0) instead of hunting the lock for phantom churn.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `files`
  - *How:* `sideEffects`
  - *How:* `packages/*/package.json`
  - *How:* `bun install --frozen-lockfile --dry-run --ignore-scripts`

<!-- learned-stamp: category=convention; capturedAt=2026-11-16T12:36:50.855Z; skill=node-modern; applied=1; wins=1 -->
- **When a workspace member's test resolves packages via `createRequire` against a sibling's `package.json` (e.g. `packages/tui/tests/browser-terminal.browser.tsx` resolving `@xterm/xterm` from `packages/webui`), record it as a cross-package supply-chain coupling: the importing member's tests silently depend on the sibling's dependency tree, so audit both siblings' manifests and verify the target exists in the sibling's own `node_modules` rather than the root.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `createRequire`
  - *How:* `package.json`
  - *How:* `packages/tui/tests/browser-terminal.browser.tsx`
  - *How:* `@xterm/xterm`
  - *How:* `packages/webui`
  - *How:* `node_modules`

---
*Last capture: 2026-11-28T02:28:12.040Z · 6 entries*

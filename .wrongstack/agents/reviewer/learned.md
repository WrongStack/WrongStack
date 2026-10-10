# Learned instructions for `reviewer`

> Project-specific learning data for the `reviewer` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to avoid

<!-- learned-stamp: category=warning; capturedAt=2026-10-08T15:05:09.222Z; skill=chimera; applied=6; wins=6; skipped=56; skippedWins=56 -->
- **When reviewing a dependency removal in a `package.json`, verify lockfile sync by matching remaining references to their owning importer block: pnpm prunes fully-unused package resolutions, so zero references for a removed dep means the lockfile was regenerated, and a surviving reference is legitimate only if its importer block's dep set matches a *different* package (compare sibling deps like select/separator/tabs against the edited `package.json`). Never attribute a lockfile reference by line proximity alone. ```json { "findings": [] } ```**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `package.json`
  - *How:* `json { "findings": [] }`

## What to do

<!-- learned-stamp: category=convention; capturedAt=2026-10-09T14:37:43.780Z; applied=3; wins=3; skipped=26; skippedWins=26 -->
- **Always verify `hsl(var(--token))` → `var(--token)` migrations by reading the token definition format first: `packages/simpleui/src/styles.css` defines custom properties as **full color values** (hex/rgba, e.g. `--success: #5ee0a0`, `--line-strong: rgba(253, 159, 2, 0.34)`), unlike `packages/webui`'s HSL-component triples. In simpleui the bare `var()` form is correct and any `hsl(var(...))` wrapper is invalid CSS; confirm with `grep "hsl\(var\(" packages/simpleui/src/styles.css` returning zero before crediting the cleanup. ```json { "findings": [] } ```**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `hsl(var(--token))`
  - *How:* `var(--token)`
  - *How:* `packages/simpleui/src/styles.css`
  - *How:* `--success: #5ee0a0`
  - *How:* `--line-strong: rgba(253, 159, 2, 0.34)`
  - *How:* `packages/webui`
  - *How:* `var()`
  - *How:* `hsl(var(...))`
  - *How:* `grep "hsl\(var\(" packages/simpleui/src/styles.css`
  - *How:* `json { "findings": [] }`

<!-- learned-stamp: category=convention; capturedAt=2026-10-08T15:22:10.673Z; skill=chimera; applied=4; wins=4; skipped=56; skippedWins=56 -->
- **Treat the `Number.isFinite(x) && x >= min ? Math.min(x, 2_147_483_647) : DEFAULT` guard as the established convention for env-configured timer durations across WrongStack project servers (`mailbox-project-server*.ts`, `session-catalog/project-server.ts`, `kanban/src/server/project-server.ts`, `sage/src/project-server.ts`, `tools/src/codebase-index/project-server.ts`) — Node clamps `setTimeout`/`setInterval` delays above 2^31−1 ms to 1 ms. When reviewing new env-parsed idle/heartbeat values, a missing `Math.min(..., 2_147_483_647)` clamp is a real bug (1 ms flood); the clamp's presence is correct, not a magic number. ```json { "findings": [] } ```**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `Number.isFinite(x) && x >= min ? Math.min(x, 2_147_483_647) : DEFAULT`
  - *How:* `mailbox-project-server*.ts`
  - *How:* `session-catalog/project-server.ts`
  - *How:* `kanban/src/server/project-server.ts`
  - *How:* `sage/src/project-server.ts`
  - *How:* `tools/src/codebase-index/project-server.ts`
  - *How:* `setTimeout`
  - *How:* `setInterval`
  - *How:* `Math.min(..., 2_147_483_647)`
  - *How:* `json { "findings": [] }`

<!-- learned-stamp: category=convention; capturedAt=2026-10-09T14:08:20.706Z; skill=chimera; applied=6; wins=6; skipped=35; skippedWins=35 -->
- **When reviewing browser-policy wiring in `packages/tools/src/browser/tools.ts`, treat `browserPrivateOrigins(root)` from `./policy.js` as the merged allowlist source (project `/browser allow` origins plus `WRONGSTACK_BROWSER_PRIVATE_ORIGINS`). Before judging immediacy claims in `docs/browser-automation.md`, check that `managerFor`'s per-root manager cache snapshot is refreshed by the sibling slash command or `BrowserSessionManager` (`packages/tools/src/browser/manager.ts`) — the snapshot in tools.ts alone cannot establish or refute "takes effect immediately in existing sessions". `timeoutMs` + `managesOwnTimeout: true` on browser tools follow the established convention in `packages/tools/src/exec.ts`/`bash.ts`/`pwsh.ts` and are correct for multi-minute install subprocesses, not a suspicious override. ```json { "findings": [] } ```**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `packages/tools/src/browser/tools.ts`
  - *How:* `browserPrivateOrigins(root)`
  - *How:* `./policy.js`
  - *How:* `/browser allow`
  - *How:* `WRONGSTACK_BROWSER_PRIVATE_ORIGINS`
  - *How:* `docs/browser-automation.md`
  - *How:* `managerFor`
  - *How:* `BrowserSessionManager`
  - *How:* `packages/tools/src/browser/manager.ts`
  - *How:* `timeoutMs`
  - *How:* `managesOwnTimeout: true`
  - *How:* `packages/tools/src/exec.ts`
  - *How:* `bash.ts`
  - *How:* `pwsh.ts`
  - *How:* `json { "findings": [] }`

---
*Last capture: 2026-10-09T14:37:43.780Z · 4 entries*

# Learned instructions for `bug-hunter`

> Project-specific learning data for the `bug-hunter` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to avoid

<!-- learned-stamp: category=warning; capturedAt=2026-08-02T10:24:32.478Z -->
- **Always require strict `owner_session_id = ?` matching on every session-memory merge query in `packages/sage/src/sqlite-store-remember.ts`. Do not let owned writes merge with `owner_session_id IS NULL` legacy rows, because session-filtered retrieval deliberately hides those rows and adoption would silently change their ownership semantics.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `owner_session_id = ?`
  - *How:* `packages/sage/src/sqlite-store-remember.ts`
  - *How:* `owner_session_id IS NULL`

<!-- learned-stamp: category=warning; capturedAt=2026-08-01T21:36:04.878Z -->
- **Always verify pnpm's publish git-check defaults against the installed pnpm and official docs before concluding a local `pnpm publish` will fail on a given branch — since pnpm 10.x the `--publish-branch` default is "master **and** main", so publishing from `main` passes with no `publish-branch` config; an isolated throwaway git repo (`pnpm-workspace.yaml` with `packages: []` to avoid parent-workspace walk-up) plus `pnpm publish --dry-run` cleanly isolates the branch check from a dirty working tree.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check. Project signals: avoid parent-workspace walk-up) plus `pnpm publish --dry-run` cleanly isolates the branch check from a dirty working tree.
  - *How:* `pnpm publish`
  - *How:* `--publish-branch`
  - *How:* `main`
  - *How:* `publish-branch`
  - *How:* `pnpm-workspace.yaml`
  - *How:* `packages: []`
  - *How:* `pnpm publish --dry-run`

## What to do

<!-- learned-stamp: category=convention; capturedAt=2026-08-01T21:14:25.653Z -->
- **- When the `edit` tool reports "no match" for an `old_string` that `read`/`grep` show verbatim, suspect invisible Unicode in the target file.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `edit`
  - *How:* `old_string`
  - *How:* `read`
  - *How:* `grep`

<!-- learned-stamp: category=convention; capturedAt=2026-08-02T10:30:34.475Z -->
- **After parallel Chimera fixes, always re-read the current on-disk file before editing or reporting a finding; if the existing diff already passes the live `sessions` map and separates `totpPendingSecret` from active `totpSecret`, preserve that work rather than applying a duplicate patch.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `sessions`
  - *How:* `totpPendingSecret`
  - *How:* `totpSecret`

<!-- learned-stamp: category=convention; capturedAt=2026-08-02T12:49:32.538Z -->
- **Always clear `selectionRef` in `packages/tui/src/components/scrollable-history.tsx` whenever `HistoryScrollController` moves the viewport — selection coordinates are viewport-relative and become unsafe against newly mounted card spans. When copying compact tool groups, pass every mounted span’s `entryIds` through `toolGroupsByHeadId` to `assembleSelectionText`; using only the group head silently omits later members.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `selectionRef`
  - *How:* `packages/tui/src/components/scrollable-history.tsx`
  - *How:* `HistoryScrollController`
  - *How:* `entryIds`
  - *How:* `toolGroupsByHeadId`
  - *How:* `assembleSelectionText`
  - *How:* `packages/tui/src/components/scrollable-history.ts`

<!-- learned-stamp: category=convention; capturedAt=2026-08-01T21:23:09.021Z -->
- **Always re-read the current on-disk state of every file in a Chimera cascade before citing a finding — concurrent cascade workers (bug-hunter, security-scanner) frequently land fixes mid-session, so a high-confidence review finding can already be resolved. Confirm with `node node_modules/typescript/bin/tsc --noEmit -p packages/<pkg>/tsconfig.json` (exit 0 = no error, not a masked baseline) and the targeted vitest file before classifying a finding as a false positive.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `node node_modules/typescript/bin/tsc --noEmit -p packages/<pkg>/tsconfig.json`

<!-- learned-stamp: category=convention; capturedAt=2026-08-02T07:04:56.948Z -->
- **Always require a path-like filename with an extension and a spaced Markdown separator when parsing `file:line — description` in `packages/core/src/plugins/review-finding-parser.ts`; accepting unspaced hyphens as separators truncates hyphenated repository paths. Validate reviewer citations against the supplied changed-file inventory rather than filesystem existence, and preserve uncited or unparseable findings as actionable.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `file:line — description`
  - *How:* `packages/core/src/plugins/review-finding-parser.ts`

## Patterns to follow

<!-- learned-stamp: category=pattern; capturedAt=2026-08-02T09:57:46.806Z -->
- **Conservatively block the entire RFC 8215 local-use NAT64 prefix `64:ff9b:1::/48` in `packages/core/src/utils/ip-guard.ts`; without the locally configured translation layout, fixed-group IPv4 decoding is unsafe and can permit private destinations through SSRF checks.**
  - *Why:* This project's chosen approach — alternatives were considered and either conflict with existing architecture or were rejected for known reasons.
  - *How:* `64:ff9b:1::/48`
  - *How:* `packages/core/src/utils/ip-guard.ts`

---
*Last capture: 2026-08-02T10:24:32.478Z · 8 entries*

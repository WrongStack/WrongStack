# Learned instructions for `bug-hunter`

> Project-specific learning data for the `bug-hunter` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to avoid

<!-- learned-stamp: category=warning; capturedAt=2026-10-20T12:08:21.720Z; skill=bug-hunter; applied=1; wins=1; skipped=12; skippedWins=11 -->
- **When adding a reference counter that guards a resource lifecycle in `packages/core/src/session-catalog/registry.ts`, decrement it in a `finally` around the awaited RPC, not only on the success path — `activate_reservation` can reject with "Resume reservation expired" and a success-only decrement pins the binding so `closeBinding()` never closes its IPC client.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `packages/core/src/session-catalog/registry.ts`
  - *How:* `finally`
  - *How:* `activate_reservation`
  - *How:* `closeBinding()`

## What to do

<!-- learned-stamp: category=convention; capturedAt=2026-10-20T12:08:21.720Z; skill=bug-hunter; skipped=13; skippedWins=12 -->
- **Always resolve relative write-target paths against `ctx.workingDir ?? ctx.cwd` — the base `resolvePath()` in `packages/tools/src/_util.ts` uses — when matching them against project-relative globs; `ctx.cwd` alone diverges after `set_working_dir()` and makes a path-matched tool gate fire on the wrong file.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `ctx.workingDir ?? ctx.cwd`
  - *How:* `resolvePath()`
  - *How:* `packages/tools/src/_util.ts`
  - *How:* `ctx.cwd`
  - *How:* `set_working_dir()`

<!-- learned-stamp: category=convention; capturedAt=2026-10-27T14:43:14.078Z; applied=1; wins=1; skipped=4; skippedWins=3 -->
- **Always route a new TUI-picker `Config` field through the profile-only path in `packages/cli/src/boot/tui-settings-adapter.ts` when its parent section is denied for in-project configs — check `IN_PROJECT_ALLOWED_KEYS` / `KNOWN_DENIED_IN_PROJECT` in `packages/core/src/storage/config-loader/in-project-policy.ts` and `PROJECT_SAFE_FIELDS` in `packages/cli/src/settings-menu.ts` first, then add the key to `hasProfileOnlySettings` and write it in the `forceGlobal` branch of `persistConfigSetting`; a top-level key absent from `PROJECT_SAFE_FIELDS` is silently stripped by `filterSafeForProject` under `configScope: 'project'` while the in-memory `ConfigStore` still shows the new value, so the write reports success and persists nothing.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `Config`
  - *How:* `packages/cli/src/boot/tui-settings-adapter.ts`
  - *How:* `IN_PROJECT_ALLOWED_KEYS`
  - *How:* `KNOWN_DENIED_IN_PROJECT`
  - *How:* `packages/core/src/storage/config-loader/in-project-policy.ts`
  - *How:* `PROJECT_SAFE_FIELDS`
  - *How:* `packages/cli/src/settings-menu.ts`
  - *How:* `hasProfileOnlySettings`
  - *How:* `forceGlobal`
  - *How:* `persistConfigSetting`
  - *How:* `filterSafeForProject`
  - *How:* `configScope: 'project'`
  - *How:* `ConfigStore`

<!-- learned-stamp: category=convention; capturedAt=2026-10-19T07:41:28.007Z; applied=7; wins=7; skipped=13; skippedWins=12 -->
- **Always trace the synchronous `tool.confirm_resolved` emission path before accepting or rejecting double-emit claims in `packages/core/src/hq/approval-bridge.ts` — resolvers emit that event synchronously (documented at the `grantExpiries` map), the `offResolved` listener announces unconditionally even when `pending` is already deleted, so any new announce site must dedupe via a bus-announced id flag rather than removing either path. Treat a lone `packages/core/src/storage/todos-checkpoint.ts` TS2454 in `packages/core` typecheck output as pre-existing out-of-scope noise and verify it with `git status` on the exact path before letting it fail a review gate.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `tool.confirm_resolved`
  - *How:* `packages/core/src/hq/approval-bridge.ts`
  - *How:* `grantExpiries`
  - *How:* `offResolved`
  - *How:* `pending`
  - *How:* `packages/core/src/storage/todos-checkpoint.ts`
  - *How:* `packages/core`
  - *How:* `git status`

<!-- learned-stamp: category=convention; capturedAt=2026-10-20T12:08:21.720Z; skill=bug-hunter; skipped=13; skippedWins=12 -->
- **Check `connectWithElection()` in `packages/core/src/session-catalog/client.ts` for an `explicitlyClosed` guard before adding a `close()` path that rejects the in-flight connect promise — the election loop has no closed-guard and will `spawnDetached()` a catalog daemon after `close()` returned.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `connectWithElection()`
  - *How:* `packages/core/src/session-catalog/client.ts`
  - *How:* `explicitlyClosed`
  - *How:* `close()`
  - *How:* `spawnDetached()`

## Patterns to follow

<!-- learned-stamp: category=pattern; capturedAt=2026-10-19T10:54:05.353Z; skill=typescript-strict; skipped=19; skippedWins=18 -->
- **Always adjudicate Node-daemon TDZ-closure claims (`closure over a later-declared let`) by checking whether any *synchronous* path can invoke the closure during module evaluation — event-loop callbacks (`net` server `'connection'`, timers, IPC) cannot interleave with synchronous module-body execution. In `packages/sage/src/project-server.ts`, the forward-lazy-closure pattern (`createSlowOperationReporter(() => ({ pendingRequests, clients: clients.size }))` and the `createHygieneRunner` `isBusy` lambda) is intentional and startup-safe; a construct-time TDZ would crash every daemon start and fail `packages/sage/tests/project-server-maintenance.test.ts`.**
  - *Why:* This project's chosen approach — alternatives were considered and either conflict with existing architecture or were rejected for known reasons.
  - *How:* `closure over a later-declared let`
  - *How:* `net`
  - *How:* `'connection'`
  - *How:* `packages/sage/src/project-server.ts`
  - *How:* `createSlowOperationReporter(() => ({ pendingRequests, clients: clients.size }))`
  - *How:* `createHygieneRunner`
  - *How:* `isBusy`
  - *How:* `packages/sage/tests/project-server-maintenance.test.ts`

<!-- learned-stamp: category=pattern; capturedAt=2026-10-18T00:07:18.271Z; skipped=23; skippedWins=22 -->
- **Always check markdown-renderer link components for URL-scheme validation (`javascript:` hrefs) before declaring a React UI XSS-clean — absence of `dangerouslySetInnerHTML` is not sufficient; VibeUI's `markdown-content.tsx` ArtifactLink renders agent-controlled hrefs verbatim while `provider-manager.tsx` already ships a `safeLoginUrl` allowlist pattern to reuse.**
  - *Why:* This project's chosen approach — alternatives were considered and either conflict with existing architecture or were rejected for known reasons.
  - *How:* `javascript:`
  - *How:* `dangerouslySetInnerHTML`
  - *How:* `markdown-content.tsx`
  - *How:* `provider-manager.tsx`
  - *How:* `safeLoginUrl`

<!-- learned-stamp: category=pattern; capturedAt=2026-10-18T00:38:09.992Z; skill=typescript-strict; skipped=22; skippedWins=21 -->
- **Always re-read co-modified vibeui files immediately before editing — `packages/vibeui/src/lib/use-session.ts` was rewritten by a peer mid-hunt (guarded `edit` refused with external-modification), turning confirmed findings into already-fixed ones; report externally-fixed findings as resolved with live line anchors instead of re-applying fixes. Adjudicate Chimera "file shape" claims (one-liner, missing EOF newline) with byte-level checks (`[System.IO.File]::ReadAllBytes(...)` last bytes) rather than rendered diffs — snapshots of actively co-modified trees are routinely stale.**
  - *Why:* This project's chosen approach — alternatives were considered and either conflict with existing architecture or were rejected for known reasons.
  - *How:* `packages/vibeui/src/lib/use-session.ts`
  - *How:* `edit`
  - *How:* `[System.IO.File]::ReadAllBytes(...)`

---
*Last capture: 2026-10-27T14:43:14.078Z · 8 entries*

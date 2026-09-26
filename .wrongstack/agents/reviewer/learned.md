# Learned instructions for `reviewer`

> Project-specific learning data for the `reviewer` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to do

<!-- learned-stamp: category=convention; capturedAt=2026-09-25T20:06:07.396Z; skill=code-review; skipped=2; skippedWins=2 -->
- **- When a diff removes an `import * as X` / named import from a file, grep the whole file for every removed identifier (`grep 'X\.|removedName' <file>`) before accepting it — an unused-import cleanup is only safe when the file shows zero remaining uses; otherwise it is a `TS2304`/runtime break. In `packages/cli/src/hq-server.ts`, removing `isTokenExpired` and `import * as HqServerAuth` was safe only because a repo grep found no residual reference. - Verify newly-called WebUI store methods (`useXStore.getState().<method>`) against the store definition, not just the handler: `setDeepDivePartial` and the 3-arg `jobStarted` in `packages/webui/src/stores/techstack-store.ts` must actually exist with a matching parameter shape, or every dispatch throws a runtime `TypeError` while typecheck of the handler alone may still pass. - `codebase-search` returning 0 hits for a symbol does NOT prove absence when the symbol is a zustand store action inside `create((set) => ({...}))` — those object-literal members are often unindexed; confirm with `grep` against the store file before reporting a missing-method finding. - When a diff introduces a new helper module (`createHqSocketCredentialEnforcer`, `MailboxSnapshotMemory`), read the module itself to confirm every passed state field and callback signature matches, and confirm an identifier the diff newly *depends on but does not add* (e.g. `OPEN_STATE`) is already imported in the consuming file.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `import * as X`
  - *How:* `grep 'X\.|removedName' <file>`
  - *How:* `TS2304`
  - *How:* `packages/cli/src/hq-server.ts`
  - *How:* `isTokenExpired`
  - *How:* `import * as HqServerAuth`
  - *How:* `useXStore.getState().<method>`
  - *How:* `setDeepDivePartial`
  - *How:* `jobStarted`
  - *How:* `packages/webui/src/stores/techstack-store.ts`
  - *How:* `TypeError`
  - *How:* `codebase-search`
  - *How:* `create((set) => ({...}))`
  - *How:* `grep`
  - *How:* `createHqSocketCredentialEnforcer`
  - *How:* `MailboxSnapshotMemory`
  - *How:* `OPEN_STATE`

<!-- learned-stamp: category=convention; capturedAt=2026-09-25T19:25:16.358Z; skill=chimera; skipped=10; skippedWins=10 -->
- **When a diff adds an entry to a protocol message catalog such as `SERVER_EXTENSION_MESSAGE_TYPES` in `packages/webui-protocol/src/server-integrations.ts`, validate it by running the catalog's own parity test (`packages/webui-protocol/tests/message-catalogs.test.ts`) rather than inspecting the array alone — it pins the name regex, non-emptiness, and per-domain duplicate-freedom, which is exactly what a hand-appended string can break. When a new catalog entry appears without a producer, grep the type string repo-wide before flagging it as dead wiring; a type declared in the webui union (`packages/webui/src/types/server-message-system.ts`) and wired into a dispatch map (`packages/webui/src/hooks/ws-handlers/*.ts`) is a forward-declared contract, and the stale catalog list in `docs/architecture/simpleui-message-lifecycle.md` is documentation drift below the reporting threshold, not a finding.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `SERVER_EXTENSION_MESSAGE_TYPES`
  - *How:* `packages/webui-protocol/src/server-integrations.ts`
  - *How:* `packages/webui-protocol/tests/message-catalogs.test.ts`
  - *How:* `packages/webui/src/types/server-message-system.ts`
  - *How:* `packages/webui/src/hooks/ws-handlers/*.ts`
  - *How:* `docs/architecture/simpleui-message-lifecycle.md`

---
*Last capture: 2026-09-25T20:06:07.396Z · 2 entries*

# Learned instructions for `explore`

> Project-specific learning data for the `explore` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to avoid

<!-- learned-stamp: category=warning; capturedAt=2026-08-22T09:38:36.469Z; applied=5; wins=5 -->
- **Always check importers *before* mapping or editing any `project-server-*.ts` helper in `packages/tools/src/codebase-index/` — grep both the exported symbol names (`ServerQueryCaches`, `staleAwareRead`) **and** the module basename (`project-server-query-cache`), because some of these files are extraction drafts that were never wired into `project-server.ts`, which still carries the inline original. A symbol-only grep can miss the module-path import form and vice versa; run both before concluding a file is live or dead.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `project-server-*.ts`
  - *How:* `packages/tools/src/codebase-index/`
  - *How:* `ServerQueryCaches`
  - *How:* `staleAwareRead`
  - *How:* `project-server-query-cache`
  - *How:* `project-server.ts`

<!-- learned-stamp: category=warning; capturedAt=2026-08-21T19:06:14.197Z; applied=6; wins=6 -->
- **Always trace a `packages/core/src/storage/*` helper's consumers by grepping its module basename first (e.g. `grep session-write-buffer`) — storage helpers there typically have exactly one importer (e.g. `session-write-buffer.ts` ← `file-session-writer.ts`), so one hop plus one `new X` grep usually completes the dependency picture without broad exploration. Never treat `codebase-incoming-calls` import/type_ref entries as call sites alone — pair them with a targeted `read` of the constructor and producer methods to distinguish ownership (who creates the object) from usage (who feeds it).**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `packages/core/src/storage/*`
  - *How:* `grep session-write-buffer`
  - *How:* `session-write-buffer.ts`
  - *How:* `file-session-writer.ts`
  - *How:* `new X`
  - *How:* `codebase-incoming-calls`
  - *How:* `read`

<!-- learned-stamp: category=warning; capturedAt=2026-08-22T09:30:41.957Z; applied=1; wins=1 -->
- **When tracing callers of `incomingCallsService`, `outgoingCallsService`, `packageGraphService`, `fileGraphService`, or `symbolGraphService` in the WrongStack repo, always disambiguate between the **sync** implementations in `packages/tools/src/codebase-index/index-service.ts` and the **async shadowing wrappers** with identical names exported from `packages/tools/src/codebase-index/background-indexer.ts` (and re-exported via the `./codebase-index/index` barrel) — the package barrel exports only the wrappers, so external consumers never touch the sync originals directly.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `incomingCallsService`
  - *How:* `outgoingCallsService`
  - *How:* `packageGraphService`
  - *How:* `fileGraphService`
  - *How:* `symbolGraphService`
  - *How:* `packages/tools/src/codebase-index/index-service.ts`
  - *How:* `packages/tools/src/codebase-index/background-indexer.ts`
  - *How:* `./codebase-index/index`

## What to do

<!-- learned-stamp: category=convention; capturedAt=2026-08-22T10:31:12.790Z; applied=5; wins=5 -->
- ****Always submit `submit_result` payloads in compact ASCII batches when the validator returns the misleading "confidence must be 0..1" error in this fleet environment — splitting one long payload into two ASCII-only retries (first full, then minimal) succeeded where neither single longer submission did.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `submit_result`

<!-- learned-stamp: category=convention; capturedAt=2026-08-21T19:18:44.222Z; applied=23; wins=23 -->
- **Always keep `submit_result` payloads short and pure ASCII (no arrows, em-dashes, or ellipses in summary/findings) in this fleet environment — two long multi-byte payloads were rejected with a misleading "required/confidence must be 0..1" validation error while a compact ASCII-only retry with identical information was accepted. If a first submission fails validation, shorten and de-accent before assuming a schema problem.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `submit_result`

<!-- learned-stamp: category=convention; capturedAt=2026-08-22T09:23:56.979Z; applied=12; wins=12 -->
- **Always scope grep/codebase-search for `project-server-client` in the WrongStack repo by package path — the basename exists in at least two unrelated subsystems: `packages/tools/src/codebase-index/project-server-client.ts` (codebase-index daemon IPC client) and `packages/core/src/chronicle/project-server-client.ts` (Chronicle journal daemon, exported via `@wrongstack/core` as `ChronicleProjectServerClient`).**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `project-server-client`
  - *How:* `packages/tools/src/codebase-index/project-server-client.ts`
  - *How:* `packages/core/src/chronicle/project-server-client.ts`
  - *How:* `@wrongstack/core`
  - *How:* `ChronicleProjectServerClient`

<!-- learned-stamp: category=convention; capturedAt=2026-08-21T19:11:21.015Z; applied=1; wins=1 -->
- **To find production consumers of any builder in `packages/cli/src/slash-commands/*.ts`, trace one hop up: `slash-commands/index.ts` `buildBuiltinSlashCommands` aggregates them, then `wiring/slash-commands.ts` `buildCommandHostSlashCommands` bridges to `wiring/cli-slash-commands-setup.ts` — direct importers of the leaf module are almost always tests.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `packages/cli/src/slash-commands/*.ts`
  - *How:* `slash-commands/index.ts`
  - *How:* `buildBuiltinSlashCommands`
  - *How:* `wiring/slash-commands.ts`
  - *How:* `buildCommandHostSlashCommands`
  - *How:* `wiring/cli-slash-commands-setup.ts`

<!-- learned-stamp: category=convention; capturedAt=2026-08-22T10:18:09.821Z; applied=1; wins=1 -->
- **When tracing producers/consumers of an exported factory in packages/simpleui/src/lib/ (e.g. message-handler.ts, message-handler-deps.ts, message-handler-session-start.ts), always grep the module basename with `grep <basename> packages/simpleui` BEFORE relying on `codebase-incoming-calls` — these factory exports are stripped from the symbol index and incoming-calls returns "Symbol not found" even when there is a clear caller in simple-ui-session.tsx and a test in tests/.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `grep <basename> packages/simpleui`
  - *How:* `codebase-incoming-calls`

---
*Last capture: 2026-08-22T10:31:12.790Z · 8 entries*

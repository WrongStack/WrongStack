# Learned instructions for `explore`

> Project-specific learning data for the `explore` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to avoid

<!-- learned-stamp: category=warning; capturedAt=2026-08-21T19:06:14.197Z; applied=3; wins=3 -->
- **Always trace a `packages/core/src/storage/*` helper's consumers by grepping its module basename first (e.g. `grep session-write-buffer`) — storage helpers there typically have exactly one importer (e.g. `session-write-buffer.ts` ← `file-session-writer.ts`), so one hop plus one `new X` grep usually completes the dependency picture without broad exploration. Never treat `codebase-incoming-calls` import/type_ref entries as call sites alone — pair them with a targeted `read` of the constructor and producer methods to distinguish ownership (who creates the object) from usage (who feeds it).**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `packages/core/src/storage/*`
  - *How:* `grep session-write-buffer`
  - *How:* `session-write-buffer.ts`
  - *How:* `file-session-writer.ts`
  - *How:* `new X`
  - *How:* `codebase-incoming-calls`
  - *How:* `read`

## What to do

<!-- learned-stamp: category=convention; capturedAt=2026-08-21T19:18:44.222Z; applied=2; wins=2 -->
- **Always keep `submit_result` payloads short and pure ASCII (no arrows, em-dashes, or ellipses in summary/findings) in this fleet environment — two long multi-byte payloads were rejected with a misleading "required/confidence must be 0..1" validation error while a compact ASCII-only retry with identical information was accepted. If a first submission fails validation, shorten and de-accent before assuming a schema problem.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `submit_result`

<!-- learned-stamp: category=convention; capturedAt=2026-08-21T19:11:21.015Z; applied=1; wins=1 -->
- **To find production consumers of any builder in `packages/cli/src/slash-commands/*.ts`, trace one hop up: `slash-commands/index.ts` `buildBuiltinSlashCommands` aggregates them, then `wiring/slash-commands.ts` `buildCommandHostSlashCommands` bridges to `wiring/cli-slash-commands-setup.ts` — direct importers of the leaf module are almost always tests.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `packages/cli/src/slash-commands/*.ts`
  - *How:* `slash-commands/index.ts`
  - *How:* `buildBuiltinSlashCommands`
  - *How:* `wiring/slash-commands.ts`
  - *How:* `buildCommandHostSlashCommands`
  - *How:* `wiring/cli-slash-commands-setup.ts`

---
*Last capture: 2026-08-21T19:18:44.222Z · 3 entries*

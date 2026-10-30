# Learned instructions for `reviewer`

> Project-specific learning data for the `reviewer` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to avoid

<!-- learned-stamp: category=warning; capturedAt=2026-10-25T16:46:07.508Z; skill=testing; applied=2; wins=2; skipped=126; skippedWins=126 -->
- **- For TUI animation tests in `packages/tui/tests/`, treat `vi.waitFor(..., { timeout, interval })` combined with a `vi.spyOn(Date, 'now')` frozen clock as the established anti-flake pattern (see `banner-formation.test.tsx`): the spy leaves real timers free to drive Ink repaints and waitFor polling, so fixed-ms `settle()` waits are the flaky construct — judge frame determinism from the mocked clock value, not wall-clock time, and do not flag the waitFor form as a hang risk.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `packages/tui/tests/`
  - *How:* `vi.waitFor(..., { timeout, interval })`
  - *How:* `vi.spyOn(Date, 'now')`
  - *How:* `banner-formation.test.tsx`
  - *How:* `settle()`

<!-- learned-stamp: category=warning; capturedAt=2026-10-25T08:16:47.556Z; skill=chimera; applied=5; wins=5; skipped=138; skippedWins=138 -->
- **When reviewing `@wrongstack/*` package.json version bumps, first confirm dependents use `workspace:*` specifiers via a grep of `**/package.json` — this repo does (all 77 declarations), so internal version bumps are metadata-only and cannot break resolution, lockfile specifiers, or `--frozen-lockfile` installs. Also confirm `private: true`, which removes publish-side risk.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `@wrongstack/*`
  - *How:* `workspace:*`
  - *How:* `**/package.json`
  - *How:* `--frozen-lockfile`
  - *How:* `private: true`

<!-- learned-stamp: category=warning; capturedAt=2026-10-25T09:26:00.819Z; skill=code-review; skipped=129; skippedWins=129 -->
- **When reviewing trigger-based change detection in `packages/sage/src/sqlite-store-hq-sync.ts`, check whether `$.updatedAt` is stripped from the `changed()` helper before judging any metadata key's strip list. Because `applySemanticChange` (`packages/sage/src/shared/semantic-rewrite.ts`) always bumps `updatedAt`, every edit path that moves `updatedAt` still satisfies `changed(new) IS NOT changed(old)` and still replicates — so stripping a metadata key only matters for raw SQL paths that mutate `data` without `updatedAt` (e.g. `stampSqliteVerification` in `packages/sage/src/sqlite-store-verification-stamp.ts`), and it never suppresses a legitimate replication.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `packages/sage/src/sqlite-store-hq-sync.ts`
  - *How:* `$.updatedAt`
  - *How:* `changed()`
  - *How:* `applySemanticChange`
  - *How:* `packages/sage/src/shared/semantic-rewrite.ts`
  - *How:* `updatedAt`
  - *How:* `changed(new) IS NOT changed(old)`
  - *How:* `data`
  - *How:* `stampSqliteVerification`
  - *How:* `packages/sage/src/sqlite-store-verification-stamp.ts`

## What to do

<!-- learned-stamp: category=convention; capturedAt=2026-10-27T14:34:24.860Z; applied=4; wins=4; skipped=37; skippedWins=37 -->
- **Always check whether a new `Config` field's **parent section** is in `PROJECT_SAFE_FIELDS` (`packages/cli/src/settings-menu.ts`) before adding the field to a general persist gate in `packages/cli/src/boot/tui-settings-adapter.ts` — a top-level key absent from that set is silently stripped by `filterSafeForProject` under `configScope: 'project'`, while the in-memory ConfigStore still shows the new value, so the write reports success and persists nothing. Cross-reference `packages/core/src/storage/config-loader/in-project-policy.ts` (`IN_PROJECT_ALLOWED_KEYS` / `KNOWN_DENIED_IN_PROJECT`) to learn whether the parent is project-safe at all; if the parent is denied, route the field to the active profile config via the `hasProfileOnlySettings` / `forceGlobal` path instead of the general gate.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `Config`
  - *How:* `PROJECT_SAFE_FIELDS`
  - *How:* `packages/cli/src/settings-menu.ts`
  - *How:* `packages/cli/src/boot/tui-settings-adapter.ts`
  - *How:* `filterSafeForProject`
  - *How:* `configScope: 'project'`
  - *How:* `packages/core/src/storage/config-loader/in-project-policy.ts`
  - *How:* `IN_PROJECT_ALLOWED_KEYS`
  - *How:* `KNOWN_DENIED_IN_PROJECT`
  - *How:* `hasProfileOnlySettings`
  - *How:* `forceGlobal`

<!-- learned-stamp: category=convention; capturedAt=2026-10-25T21:25:00.573Z; skill=chimera; applied=3; wins=3; skipped=77; skippedWins=77 -->
- **Always re-read the changed file on disk before citing a type mismatch from a supplied diff — the diff hunk may show `sessionId: undefined` assigned to a `sessionId: string` field while the working tree already widens it to `string | undefined`; report the on-disk state, not the snapshot.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `sessionId: undefined`
  - *How:* `sessionId: string`
  - *How:* `string | undefined`

<!-- learned-stamp: category=convention; capturedAt=2026-10-27T13:54:21.905Z; applied=3; wins=3; skipped=45; skippedWins=45 -->
- **Always validate Anthropic-compatible provider wire ordering against the OpenAI-shape rule that `tool` messages must immediately follow the assistant `tool_calls` message — when converting a tool-result turn for proxies such as Kimi For Coding, keep `tool_result` blocks first and any pending text block trailing (see `packages/core/src/core/agent-tools.ts` and `packages/providers/src/presets/anthropic.ts`), otherwise the proxy answers 400 with every call reported as unanswered.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `tool`
  - *How:* `tool_calls`
  - *How:* `tool_result`
  - *How:* `packages/core/src/core/agent-tools.ts`
  - *How:* `packages/providers/src/presets/anthropic.ts`

<!-- learned-stamp: category=convention; capturedAt=2026-10-27T14:27:31.500Z; applied=6; wins=6; skipped=38; skippedWins=38 -->
- **Always verify a config-pref handler's field against the authoritative contract type (`packages/contracts/src/types/config/runtime.ts`) before judging a new nested-config update — a spread like `{ ...config.systemPrompt, newField }` is only correct if the sibling fields are preserved, and the contract's optional `?: boolean | undefined` shape means an explicit `false` is meaningfully distinct from an omitted key, so consumers must compare with `=== false` rather than truthiness.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `packages/contracts/src/types/config/runtime.ts`
  - *How:* `{ ...config.systemPrompt, newField }`
  - *How:* `?: boolean | undefined`
  - *How:* `false`
  - *How:* `=== false`

<!-- learned-stamp: category=convention; capturedAt=2026-10-25T21:03:32.097Z; applied=19; wins=19; skipped=70; skippedWins=70 -->
- **Always verify that a change claiming to remove an aggregate/global leak actually removes it from the emitted payload — a projection helper that deletes aggregate keys is useless if the handler re-reads the raw message fields alongside it. Check the response body construction, not just the helper call (see `packages/webui-server/src/server/mailbox-handlers.ts` and `packages/coordination/src/mailbox-http-actor-query.ts`). When a diff replaces a bounded store-level count with an actor-scoped helper, check the helper's internal query limit before accepting the swap — `unreadCountForActor` in `packages/coordination/src/mailbox-http-actor-query.ts` uses `limit: Number.MAX_SAFE_INTEGER` and fans out per recipient, so any caller on a poll path (TUI client status, ACP turn reminders) turns a SQL-bounded count into a full mailbox materialization. When a shared canonical predicate is introduced for a concept that previously had divergent inline copies (here "unread"), grep the changed file for the remaining inline copies before accepting the change — introducing the helper without migrating the sites in the same diff leaves the drift the helper was meant to remove (active task H5 remained unsatisfied).**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `packages/webui-server/src/server/mailbox-handlers.ts`
  - *How:* `packages/coordination/src/mailbox-http-actor-query.ts`
  - *How:* `unreadCountForActor`
  - *How:* `limit: Number.MAX_SAFE_INTEGER`

<!-- learned-stamp: category=convention; capturedAt=2026-10-27T16:55:10.239Z; applied=4; wins=4; skipped=21; skippedWins=21 -->
- **When a scoped diff in `packages/webui-server/src/server/` routes into a newly added sibling module (e.g. `session-handlers.ts` → `project-history-search.ts`, `session-history-content.ts`), read the sibling module's parameter contract and failure mode before clearing the diff — the diff's correctness depends on the helper's validation and optional-method guards, not on the diff hunk alone.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `packages/webui-server/src/server/`
  - *How:* `session-handlers.ts`
  - *How:* `project-history-search.ts`
  - *How:* `session-history-content.ts`

<!-- learned-stamp: category=convention; capturedAt=2026-10-27T17:28:49.476Z; applied=1; wins=1; skipped=12; skippedWins=12 -->
- **When adding an optional counter to `ToolMetrics` in `packages/bench/src/types.ts`, always pair the type change with a `counterSum`-style fold in `packages/bench/src/aggregate.ts` and a `?? 0` render in `packages/bench/src/report/markdown.ts` — because `TaskResult` rows deserialized from pre-metric `results.jsonl` artifacts carry `undefined`, and a naive `results.map(r => r.tools.subagentSpawns)` sum would yield `NaN` in the leaderboard.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `ToolMetrics`
  - *How:* `packages/bench/src/types.ts`
  - *How:* `counterSum`
  - *How:* `packages/bench/src/aggregate.ts`
  - *How:* `?? 0`
  - *How:* `packages/bench/src/report/markdown.ts`
  - *How:* `TaskResult`
  - *How:* `results.jsonl`
  - *How:* `undefined`
  - *How:* `results.map(r => r.tools.subagentSpawns)`
  - *How:* `NaN`

## Patterns to follow

<!-- learned-stamp: category=pattern; capturedAt=2026-10-25T21:20:11.946Z; skill=code-review; applied=8; wins=8; skipped=74; skippedWins=74 -->
- **When a CLI or surface sends to a multi-recipient target (`*`), apply the shared send-type validator to that branch too — not only to the direct-recipient branch. The storage boundary throws for `assign`/`steer` to `*` (`packages/coordination/src/sqlite-mailbox.ts`), and because `RemoteMailbox.send` goes over the IPC socket (`packages/coordination/src/remote-mailbox.ts`), the server's `ok: false` response rejects the client promise. Any branch that calls `mb.send()` without its own try/catch surfaces a raw IPC error instead of a validation message. Check every `mb.send(` call site for a `try/catch`, not just the one the diff touched.**
  - *Why:* This project's chosen approach — alternatives were considered and either conflict with existing architecture or were rejected for known reasons.
  - *How:* `*`
  - *How:* `assign`
  - *How:* `steer`
  - *How:* `packages/coordination/src/sqlite-mailbox.ts`
  - *How:* `RemoteMailbox.send`
  - *How:* `packages/coordination/src/remote-mailbox.ts`
  - *How:* `ok: false`
  - *How:* `mb.send()`
  - *How:* `mb.send(`
  - *How:* `try/catch`

---
*Last capture: 2026-10-27T17:28:49.476Z · 11 entries*

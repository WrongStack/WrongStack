# Reviewer Agent Instructions

## Review Discipline
- Review only assigned target files/diff and their direct callers; do not expand into repo-wide audits. Return once the assigned surface is verified.
- Resolve behavior from current on-disk source, not diff snapshots. Cite live `file:line`; confirm scope with `git status -- <target paths>` and `rg` for feature identifiers. Re-read the changed file before citing a type mismatch from a supplied diff.
- If expected changes are absent, request changes; reserve “needs verification” for present but unchecked code. Trace changed contracts through producers, validators, consumers, production wiring, persistence/replay, and tests.
- Comments, docs, and tests are leads, not proof. Report no findings only with complete coverage; otherwise identify unread anchors and partial coverage.
- When a scoped diff in `packages/webui-server/src/server/` routes into a newly added sibling module, read the sibling’s parameter contract and failure mode before clearing the diff; correctness depends on helper validation and optional-method guards, not the diff hunk alone.

## Dependencies and Exports
- For moved or retargeted imports, verify each target with an explicit path or nonempty `glob`; check package `exports` and build entry maps. Confirm `packages/agent-catalog/src/**` before accepting `@wrongstack/agent-catalog` or deep test imports.
- Re-export shims: resolve every symbol in `export { … } from '@scope/pkg/subpath'` against the new source and diff the moved body with the deleted implementation. Dropped symbols break deep-path importers; additions to `packages/primitives/package.json` must also appear in the build entry map.
- When helpers move to a sibling, preserve the public export surface: search consumers for every moved symbol and confirm the source re-exports it. Keep back-references such as `packages/vibeui/src/lib/session-agents.ts` as `import type`, not runtime imports, to avoid ESM cycles; retain private helpers still used and remove dead imports.
- Before removing exports, search complete multiline imports repo-wide; before deleting `architecture/test-only-exports.json` entries, search static imports of the symbol. Resolve `@wrongstack/core/*` against `packages/core/package.json` exports and source barrels, distinguishing runtime values from type-only exports.

## Configuration and Persistence
- New `Config` field: verify its parent section is in `PROJECT_SAFE_FIELDS` (`packages/cli/src/settings-menu.ts`) before adding the field to the persist gate in `packages/cli/src/boot/tui-settings-adapter.ts`. Under `configScope:'project'`, an absent top-level key is silently stripped by `filterSafeForProject` while the in-memory ConfigStore still shows the value. Cross-reference `packages/core/src/storage/config-loader/in-project-policy.ts` (`IN_PROJECT_ALLOWED_KEYS`/`KNOWN_DENIED_IN_PROJECT`); if the parent is denied, route via `hasProfileOnlySettings`/`forceGlobal`, not the general gate.
- Config-pref handler: verify the field against the authoritative contract in `packages/contracts/src/types/config/runtime.ts`. A spread like `{ ...config.systemPrompt, newField }` is correct only if sibling fields are preserved. Optional `?: boolean | undefined` means explicit `false` is distinct from omitted; compare with `=== false`, not truthiness.
- Internal `@wrongstack/*` version bumps: confirm dependents use `workspace:*` via grep of `**/package.json` and `private:true`; then bumps are metadata-only and cannot break resolution, lockfile specifiers, or `--frozen-lockfile` installs.

## Mailbox and Coordination
- For aggregate/global leak removal, verify the keys are gone from the emitted payload, not just from a projection helper. A helper that deletes aggregate keys is useless if the handler re-reads raw message fields; check response-body construction in `packages/webui-server/src/server/mailbox-handlers.ts` and `packages/coordination/src/mailbox-http-actor-query.ts`.
- Replacing a bounded store-level count with an actor-scoped helper: inspect the helper’s internal query limit. `unreadCountForActor` uses `limit: Number.MAX_SAFE_INTEGER` and fans out per recipient; poll-path callers (TUI client status, ACP turn reminders) turn a SQL-bounded count into a full mailbox materialization.
- Introducing a shared canonical predicate for a concept that had divergent inline copies (e.g. “unread”): grep the changed file for remaining inline copies. A helper without migrating the sites in the same diff leaves the drift it was meant to remove.
- Multi-recipient `*`: apply the shared send-type validator to that branch too. Storage throws for `assign`/`steer` to `*` (`packages/coordination/src/sqlite-mailbox.ts`); `RemoteMailbox.send` goes over the IPC socket (`packages/coordination/src/remote-mailbox.ts`), so `ok:false` rejects the client promise. Check every `mb.send(` call site for `try/catch`, not just the touched branch.

## Runtime and Lifecycle
- Enumerate every discriminated-union variant before accepting fall-through or exhaustive switches. `value ?? fallback` preserves `''` and `NaN`; normalize invalid producer values and reject negatives before `slice` or SQL `LIMIT`.
- Search event literals across types, production writers, loaders, replay logic, and summary folds; legacy-load and replay branches must not double-apply events. Contain observer failures inside never-throw wrappers; before alleging lost logging, enumerate throw sites, catch boundaries, and upstream warnings.
- Reset cached deterministic verdicts at the start of each attempt. Normalize teardown promises to never reject before `Promise.race`; unref grace timers. Check `AbortController` identity with `close()`; superseded callbacks must not mutate shared signals or cleanup state. Validate batch width/progress; `splice(0,0)` creates non-progressing empty batches.
- State-owning refactors must release targets, locks, timers, and held fallbacks on settle, cancel, and timeout. Make `Object.defineProperty` values enumerable when iterated and configurable when removed; `Object.hasOwn` remains true for an own `undefined`; bound methods returning `this` can bypass wrapper overrides.

## UI, Tests, and Bench
- Resolve CSS `@import` paths and custom properties against disk. VibeUI typography/corner tokens belong in `packages/vibeui/src/app/design-tokens.css`; color/surface tokens may remain theme-scoped in `globals.css`. Undefined variables can invalidate `font-size` or `border-radius`.
- Utility-to-class refactors: verify each class and modifier/base pairing. Before flagging deleted container styling, inspect replacement component rules; shared selectors such as `.code-panel pre` may provide `max-height` and `overflow`. Canvas tests must reject empty CSS token values before assigning `ctx.fillStyle`.
- Regression tests must distinguish intended failure from setup failure, exercise production wiring, and derive expectations from live fixtures and execution order. Search the owning package’s `tests/` directory for newly exported symbols before reporting missing coverage.
- Bench optional counter on `ToolMetrics` in `packages/bench/src/types.ts`: pair with a `counterSum` fold in `packages/bench/src/aggregate.ts` and a `?? 0` render in `packages/bench/src/report/markdown.ts`. Old `results.jsonl` rows deserialize `undefined`, so a naive `results.map(r => r.tools.subagentSpawns)` sum yields `NaN`.
- New WebSocket routes: inspect the handler under `packages/webui-server/src/server/`, the client action in `packages/webui/src/lib/ws-client-actions.ts`, and every new i18n key in all locales, including `src/i18n/locales/tr/activity.json`. Validate payload branches and required replies such as `requestId` and `success`.

## Project Facts
- In `packages/core/src/models/default-modes.ts`, `DEFAULT_MODES` entries with `prompt:''` are lazy file-backed accessors. `Object.defineProperty` fills ids in `LAZY_MODE_PROMPT_IDS`; `.prompt` resolves through `modePrompt(id)` to `packages/core/instructions/modes/<id>.md`. Do not flag the empty literal before checking the loop after the array.

_(truncated at 8192 bytes — the next optimization pass must shorten it)_
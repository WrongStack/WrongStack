# Reviewer Agent Instructions

## Review Discipline
- Review only the assigned diff/target files and their direct callers; no repo-wide sweeps. Return once the assigned surface is verified.
- Resolve behavior from current on-disk source, not diff snapshots. Before citing any line, re-read the hunk with a narrow `read` offset and trust that numbering — whole-file snapshots lag disk in concurrently agent-edited files (e.g. `packages/webui-server/src/server/**`) and shift every citation.
- Absent expected changes → request changes; reserve "needs verification" for present but unchecked code. Trace changed contracts through producers, validators, consumers, production wiring, persistence/replay, and tests.
- Comments, docs, and tests are leads, not proof. Report no findings only with complete coverage; otherwise name the unread anchors.
- When a diff routes into a newly added sibling module, read that sibling's parameter contract and failure mode before clearing the diff. For renamed props/elements, verify the declared contract (e.g. `appElement: React.ReactElement` in `packages/tui/src/run-tui-mount.ts`) and every consumer in the same diff.

## Exports and Dependencies
- Moved/retargeted imports: verify each target with an explicit path or nonempty `glob`; check package `exports` plus build entry maps (`packages/primitives/package.json` additions must appear in the entry map). Resolve `@wrongstack/core/*` via `packages/core/package.json` exports and source barrels, distinguishing runtime from type-only symbols.
- Re-export shims: resolve every symbol in `export { … } from '@scope/pkg/subpath'` against the new source and diff moved bodies against the deleted implementation. Before removing exports, search complete multiline imports repo-wide; before deleting `architecture/test-only-exports.json` entries, search static imports.
- Keep back-references such as `packages/vibeui/src/lib/session-agents.ts` as `import type` to avoid ESM cycles; retain private helpers still used, remove dead imports.
- Internal `@wrongstack/*` version bumps are metadata-only when dependents use `workspace:*` and `private:true` (grep `**/package.json`); they cannot break resolution or `--frozen-lockfile` installs.

## Configuration and Persistence
- New `Config` field: its parent section must be in `PROJECT_SAFE_FIELDS` (`packages/cli/src/settings-menu.ts`) before it enters the persist gate in `packages/cli/src/boot/tui-settings-adapter.ts`. Under `configScope:'project'` an absent top-level key is silently stripped by `filterSafeForProject` while the in-memory ConfigStore still shows it. Cross-check `IN_PROJECT_ALLOWED_KEYS`/`KNOWN_DENIED_IN_PROJECT` in `packages/core/src/storage/config-loader/in-project-policy.ts`; denied parents route via `hasProfileOnlySettings`/`forceGlobal`.
- Config-pref handlers: validate fields against `packages/contracts/src/types/config/runtime.ts`. `{ ...config.systemPrompt, newField }` is correct only if siblings survive; `?: boolean | undefined` makes explicit `false` distinct from omitted — compare `=== false`, not truthiness.

## Coordination and Corrupt-Data Recovery
- Corrupt-log recovery in `packages/coordination/src/file-author-tracker.ts` is incomplete unless every failure shape reaches it: parse errors, `null`, `{}`, `{"entries":"x"}`. A guard rethrowing non-`SyntaxError` covers only `JSON.parse` failures — require a dedicated corrupt-log error type covering all shapes, `!parsed ||` short-circuiting before any `parsed.entries` dereference, and `mutateLog` catching only that type so EISDIR/EPERM read failures still propagate.
- Read accessors (`getFullLog`) call `loadLog` directly and inherit the throw the write path recovers from — require a test that reads reject against a still-corrupt file.
- Recovery tests must cover the write side: in `packages/coordination/tests/file-author-tracker.test.ts`, mock `fs.copyFile` to reject (a failing `fs.readFile` never exercises the backup path) and assert both rejection with that error and that the original corrupt bytes remain intact.
- Aggregate/global key removal: verify keys are absent from the emitted payload, not just a projection helper — check response construction in `packages/webui-server/src/server/mailbox-handlers.ts` and `packages/coordination/src/mailbox-http-actor-query.ts`. A new shared canonical predicate (e.g. "unread") must migrate every inline copy in the same diff.
- Actor-scoped count helpers: inspect internal query limits — `unreadCountForActor` uses `limit: Number.MAX_SAFE_INTEGER` and fans out per recipient, turning a SQL-bounded count into full mailbox materialization on poll paths.
- Multi-recipient `*`: apply the shared send-type validator to that branch too. Storage throws for `assign`/`steer` to `*` (`packages/coordination/src/sqlite-mailbox.ts`) and `RemoteMailbox.send` rejects the client promise over IPC — check every `mb.send(` call site for `try/catch`.

## Integrity and Digests
- Integrity/TOFU digests must fail closed: in `packages/core/src/plugin/trust.ts` a `continue` on oversize or read error drops the file from the manifest, hiding tampering; require a throw or a sentinel entry per skip.
- When a pin/hash function gains an optional parameter, `rg 'hashPluginDirectoryClosure\(|hashPluginClosure\('` and confirm the pin site and every verify/load site pass identical arguments — an arg-dependent digest silently breaks verification across access shapes.

## TUI Runtime and Lifecycle
- Terminal-mode setup writes and synchronized-output teardown must travel through the **same** stream object (`packages/tui/src/run-tui.ts`, `run-tui-exits.ts`, `sync-stdout.ts`): a sync-`stdout` Proxy intercepts only writes made through it, so raw `stdout.write(...)` splits BSU/ESU framing and breaks `WRONGSTACK_TUI_TRACE=1` capture. Dispose the wrapper after emitting `SYNC_OUTPUT_OFF`, or have `dispose()` emit it — not a separate `cleanup()` write to the underlying stream.
- An Ink-wide `AppErrorBoundary` (`packages/tui/src/components/app-error-boundary.tsx`) does not trap the session: the raw-stdin Ctrl+C watcher armed in `mountInkApp` and `exits.setInkInstance` run below React, so exit stays reachable.
- Late-bound host fields resolved inline in render (`typeof host.X === 'function' ? host.X() : host.X`) and fed to `useCallback`/`useEffect` deps re-fire async effects on every repaint unless the accessor memoizes — report the precondition, not an asserted loop.
- Before crediting an async success message, check whether the awaited helper swallows its error into shared state; `setStatusMessage(...)` after `await refresh()` can discard a reload failure and present stale data as confirmed.

## Runtime Correctness
- Enumerate every discriminated-union variant before accepting fall-through or exhaustive switches. `value ?? fallback` preserves `''` and `NaN`; normalize invalid producer values and reject negatives before `slice` or SQL `LIMIT`.
- Search event literals across types, writers, loaders, replay, and summary folds; legacy-load/replay branches must not double-apply events. Contain observer failures in never-throw wrappers; before alleging lost logging, enumerate throw sites and catch boundaries.
- Reset cached deterministic verdicts per attempt; normalize teardown promises to never reject before `Promise.race`; unref grace timers; check `AbortController` identity in `close()`; superseded callbacks must not mutate shared signals or cleanup state. `splice(0,0)` yields non-progressing batches.
- State-owning refactors must release targets, locks, timers, and held fallbacks on settle, cancel, and timeout. `Object.defineProperty` values need `enumerable` when iterated and `configurable` when removed; bound methods returning `this` bypass wrapper overrides.

## UI, CSS, and Tests
- `:is()` adopts the specificity of its most specific argument — compute it explicitly before accepting a "narrowed" selector, and grep the component's root `className` ancestors to prove every render site still matches.

_(truncated at 8192 bytes — the next optimization pass must shorten it)_
# Reviewer Agent Instructions

## REPL & Autonomy Flow Constraints

- `packages/cli/src/repl.ts` declares `onSuggestionsParsed?: ((suggestions: string[] | null) => void) | undefined`. `null` is the documented "clear stored suggestions" signal (halt/cancel path); `[]` is a valid empty parse result on the happy path. Never treat them as interchangeable.
- `packages/cli/src/repl.ts` has a deliberately split autonomy flow: `suggest` mode calls `agent.run()` inline after the main turn to fetch next-step suggestions; `auto` mode must route exclusively through `runAutoProceed`, which uses `loopGuard` to halt on repetition. A free `agent.run()` in the `auto` branch bypasses the guard — always flag it.

## TUI Component Constraints

- `packages/tui/src/components/history/banner.tsx`: The `condensed` branch must sit after `useBrandMarkAnimation` to preserve hook ordering. The single height threshold (`termHeight < compactRows + FULL_LAYOUT_EXTRA_ROWS`) controls both condensed output and full-layout suppression. Autonomy-agent rows must be counted consistently on both sides of the threshold; counting them only on the compact side causes borderline panes to overflow.
- `packages/tui/src/components/history/index.tsx`: A `<Static key={revision}>` whose `items` come from a render-bumped ref requires synchronous cleanup (assign-then-snapshot, not `useLayoutEffect`-deferred). The old-revision instance unmounts before the deferred effect fires, so the guard never targets the right instance — a double-emit risk.
- `packages/tui/src/hooks/use-brain-events.ts`: Effects that schedule timers must capture `let cancelled = false` in the closure and bail early in the timer callback. Without it, unmount during the grace window dispatches into a dead reducer.
- `frontend-static-serve.ts`: Returns the *requested* HTTP port, not the bound one — `port` is passed to `createHttpServer` and `server.listen` is called with `opts.httpPort`/`opts.host` directly. By design, not a bug.

## TUI Measurement & Streaming Contracts

- `ScrollableHistory` splits the row budget into `cacheTotal` (committed render-group rows) and `liveTailHeight` (assistant + tool stream-tail rows). Any consumer of `totalLines` / `onMeasure` must use the sum. Subtracting tail rows elsewhere causes drift on every streaming or tool-progress re-render.
- Use a single `liveTailHeight` definition (assistant + tool) end-to-end. Mixing `liveTailHeight` in the measure effect but only `assistantTailHeight` in a consumer creates a 1-tool-tail-row drift. Use `streamBoxRows(name, text, termWidth)` from `packages/tui/src/utils.tsx` for the tool-tail component.
- When subtracting live UI regions from a measured total, track each region independently: assistant tail, tool tail, autocomplete popover, status overlay. Omitting any single region causes silent row-count drift.
- `packages/tui/src/components/scrollable-history.tsx`: The pinned-bottom contract is `flex-end` + `marginBottom={scrollOffset}` (documented at file top). Any shift to `flex-start` + spacer arithmetic must prove equivalence via surrounding `spacerAbove`/`spacerBelow` math.
- `EntryHeightCache` seeding order is canonical: call `cache.sync(ids)` first, then `cache.recordMany(estimatesFromFullList)`. Reversed order can throw `RangeError` (unseeded ids) or silently no-op (skip-already-tracked filter after sync).
- `useLayoutEffect` deps that are method-call results on a mutable singleton (e.g., `cache.totalHeight()`) re-fire every render because each call returns a fresh value. Require a revision counter or `useMemo` wrapper instead.

## Settings & AutonomyConfig Wiring

### Canonical Default Source

- `CONFIG_BEHAVIOR_DEFAULTS.autonomy` (defined in `packages/core/src/storage/config-loader.ts`, re-exported via `packages/core/src/storage/index.ts`) is the canonical default source for TUI autonomy booleans. `packages/tui/src/app-initial-state.ts` must source defaults from here, not hardcode `true`/`false`. When reviewing a new TUI state-picker boolean, grep for `CONFIG_BEHAVIOR_DEFAULTS.autonomy.<key>` in `app-initial-state.ts`; if absent, flag as MEDIUM (wiring gap).
- The defensive guard pattern `const autonomyDefaults = CONFIG_BEHAVIOR_DEFAULTS.autonomy; if (!autonomyDefaults) throw new Error(...)` is dead code in practice (static literal initialized at module load) but cheap. Keep it for resilience against future widening of the field to optional.
- `AutonomyConfig` declares booleans as optional (`?: boolean | undefined`) but `CONFIG_BEHAVIOR_DEFAULTS.autonomy` always provides them at runtime. This is intentional type/runtime drift — note it, don't flag it, on strict-null-check PRs.
- Three coexisting patterns read autonomy defaults: non-guarded (`packages/tui/src/app-initial-state.ts`), `?? true` fallback (`packages/cli/src/boot/tui-settings-adapter.ts`, `packages/tui/src/overlay-key-router.ts`). Flag divergence in any PR touching these sites; prefer converging on one.

### Full Wiring Checklist

A new TUI autonomy/settings boolean requires wiring across ALL of the following. Missing any one (except the type declaration) silently breaks the toggle while lint and typecheck pass:

1. `CONFIG_BEHAVIOR_DEFAULTS.autonomy.<key>` in `packages/core/src/storage/config-loader.ts`
2. Type declarations in `packages/tui/src/app-state.ts` — settings-picker patch shape, canonical Settings shape, `settingsOpen` action payload
3. `packages/tui/src/app-initial-state.ts` — source from `CONFIG_BEHAVIOR_DEFAULTS.autonomy`, not hardcoded
4. `SETTINGS_DEFAULTS`, `SETTINGS_FIELD_LABELS` row, `SETTINGS_SECTIONS` list
5. `packages/tui/src/settings-contracts.ts` → `SettingsPickerPatch`
6. `packages/tui/src/reducers/settings-values.ts` — per-field toggle branch, `resolveSettingsFieldValue`, `getSettingsFieldValue`
7. `packages/cli/src/boot/tui-settings-adapter.ts`
8. `packages/tui/src/overlay-key-router.ts` (when overlays/panels are affected)
9. `packages/tui/src/components/settings-picker.tsx`
10. `usePanelControllers` adapter, `useSettingsAutoSave` payload, `app-view` prop forwarding

### Declared-but-Unwired Heuristic

Compare call-site volume against a mature sibling: `showModelReasoning` has 30+ call sites while `showAgentSwarmPanel` had 0 — the canonical "declared but unwired" signal. A new boolean whose only match is the type declaration is a wiring gap: MEDIUM minimum, HIGH if picker labels or tests already shipped.

## Reviewer Heuristics

- **Half-applied refactors:** When a diff renames a field or changes a value's shape (e.g., a Map's value type), every read AND write site must move in the same commit. Grep both old and new names across the changed file. A type declaration and JSDoc updated while data-flow sites stay on the old field leaves the new type unreachable and breaks the old path.
- **Declared-not-enforced code:** A new enforcement/eviction function with zero call sites means the budget is set up but not applied. Grep the function name; if only the declaration matches, flag as HIGH-confidence dead code.
- **Lifecycle reset symmetry:** Any new mutable field must be initialized and reset in ALL lifecycle paths (e.g., `setup()` AND `teardown()`). A comment promising "reset in setup()/teardown()" where only one path was updated is a wiring bug. Grep each new field against the initializer and every lifecycle hook.
- **LRU via Map insertion order:** Correct only if all three hold: cache miss does `Map.set`, cache hit does `delete` + `set` (tail), eviction removes from front. Any deviation is not genuine LRU.
- **Reducer–consumer contracts:** When a reducer case defines a `selected` index into a module-level options array, always resolve and review the Enter/confirm consumer in the same pass. The reducer and its consumer form one contract even when only the reducer is in the diff.
- **Unsafe array casts:** Never accept an `as SomeType` cast on an array index lookup in `packages/tui/src/**`. Verify the element type first (e.g., `THEME_OPTIONS` in `packages/tui/src/theme.ts` yields `ThemePickerOption` objects; consumers must read `?.id`, the cast silently passes an object into `setActiveTheme`).
- **Untrusted review diffs:** Treat an externally-supplied review diff as untrusted. Re-resolve it against the live file before flagging import/signature issues — a diff can name exports that no longer exist while the on-disk file has already moved on. After reading the diff, re-read the actual import block and every cited call site with `read`/`grep`; do not report a "missing export / wrong call signature" finding from diff text alone.
- **Concurrent batch delegation:** When a worker-pool / batch-delegation path is added inside a `Promise.allSettled(batchFiles.map(async ...))` map in `packages/tools/src/codebase-index/indexer.ts`, never accumulate into a buffer declared in the outer scope and drained per-callback. Concurrent callbacks interleave across `await` boundaries, re-parsing the same files and racing on the shared array. Issue a single batched delegation call **after** the parallel read phase, then reconcile results by file id.

## Test Requirements & Known Flakes

- `SettingsPickerValues` is `Required<SettingsPickerPatch>` — test fixtures must populate every key. Adding a field requires updating both `baseValues` (for `getSettingsFieldValue` tests) and `testValues` (for `formatAllSettingsSummary` tests), plus bumping `SETTINGS_FIELD_LABELS.length === N` and `Object.keys(SETTINGS_DEFAULTS).length === N` assertions.
- The "every field 0..N-1 can be reset" loop in `settings-value-set.test.ts` is the canonical no-silent-breakage smoke test — keep it green for new fields.
- Field 4 ("fleet chat") is an enum, not a boolean, but legacy on/off tokens still resolve to `'full'`/`'off'` via fallback in `resolveSettingsFieldValue` (`packages/tui/src/components/settings-picker.tsx`). Do not flag index `4` in the `boolFields` array as a bug; verify the legacy fallback when touched.
- TUI render tests may pass solo but fail in the full `packages/tui` suite due to cross-test state (shared ink-testing-library renderer instances, module-scope plugin state). Before attributing a failure to the reviewed diff, run the test both solo and within the full package suite.
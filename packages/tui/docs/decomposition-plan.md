# TUI God-File Decomposition Plan (v1.1 — approved)

Targets: `src/app.tsx` (1059 L), `src/run-tui.ts` (652 L), `src/app-key-handler.ts` (1102 L),
`src/hooks/use-tui-slash-commands.ts` (934 L). Line counts as of 2026-09-10; re-read bodies at each
phase start (older notes cite pre-decomposition line numbers that no longer exist).

## Review decisions (2026-09-10)

- **D1 — Phase order:** approved as drafted: Phase 0 → 1 (`run-tui.ts`) → 2 (`use-tui-slash-commands.ts`) → 3 (`app-key-handler.ts`) → 4 (`app.tsx`). Least React-coupled first; App last because it consumes the four stabilized seams.
- **D2 — Facade names/groupings:** names approved as drafted. Membership is finalized by the phase's read-through (A0 for App); membership deltas are recorded in that step's commit message. Name changes require a new review.
- **D3 — Phase 0 characterization tests:** all three included (public-API surface freeze, key-handler replay corpus, slash-registry enumeration). Test-only commits; each must pass against current code before any move.
- **D4 — Plan document:** this file (`packages/tui/docs/decomposition-plan.md`), docs-only commit.

## Behavior-preservation contract (every step)

1. No exported-signature changes. `runTui(opts)`, `createAppKeyHandler(options)`, `useTuiSlashCommands(props)`, `App(props)` and all current exports keep exact types. Old modules become re-export shims during transition (existing repo convention, cf. `app-reducer.ts` re-exporting `reducers/helpers.ts`).
2. Pure code motion. Bodies move verbatim; only import paths and wiring change. Bugs discovered mid-move are logged, not fixed — fixed in their own commit after the move lands green.
3. Hook-order stability. In `App`, hooks move into facade hooks only if every facade is called unconditionally in a fixed order at the top of the component.
4. Ref identity. The ~20 `MutableRefObject`s threaded through `AppKeyHandlerOptions` are created once and passed down; never re-created inside extracted modules.
5. One step = one commit = green gate. Gate: `pnpm --filter @wrongstack/tui typecheck` + `pnpm --filter @wrongstack/tui test` (baseline: 342 files / 5682 tests / ~128s, recorded 2026-09-10).
6. Re-read before each phase; update this file's execution log as steps land.

## Phase 0 — safety net

| Step | Deliverable | Gate |
|---|---|---|
| 0.1 | Baseline recorded: typecheck + full suite green | logs in `.temp_files/tui-baseline-*.log` |
| 0.2 | `tests/public-api-surface.test.ts` — runtime export freeze for `index.ts`, `app.tsx`, `app-reducer.ts`, `run-tui.ts` | vitest run |
| 0.3 | Key-handler replay-corpus test: (input, key, state) tuples → dispatched actions through current `createAppKeyHandler`, snapshotted | vitest run |
| 0.4 | Slash-registry enumeration test: names + order of commands registered by `useTuiSlashCommands` | vitest run |
| 0.5 | Journey tests confirmed green (`app.comprehensive`, resume/render timelines) | part of 0.1 |

## Phase 1 — `run-tui.ts` → ≤120-line orchestrator

| Facade | Absorbs |
|---|---|
| `resolveTuiLaunchPlan(opts)` | TTY guard, capability probe, mouse opt-in, silence decision |
| `setupTuiSession(opts)` | session/client/agent bootstrap (wraps `createRunTuiClientRegistration`) |
| `mountInkApp(deps)` | `render()` + `inkStdin` wiring + raw-Ctrl+C arming + resize erase handler; returns `{ instance, detachResize }` |
| `createExitOrchestrator(...)` | six exit paths through idempotent `cleanup()`/`settle()`; extends `run-tui-teardown.ts`, no duplication |

Invariants: raw-Ctrl+C listener attaches only after Ink owns stdin; cleanup stays idempotent across all six paths; `run-tui.comprehensive/guard/teardown` tests unchanged and green.

## Phase 2 — `hooks/use-tui-slash-commands.ts` → 5 slice hooks

Parent keeps its exact 22-field signature and calls slices in today's registration order (pinned by 0.4):
`useDesignKitSlashCommands`, `useResourceSlashCommands`, `useSettingsSlashCommands`,
`useSessionSlashCommands`, `useProviderSlashCommands`.

## Phase 3 — `app-key-handler.ts` → ordered route chain

Orchestrator keeps the exact `createAppKeyHandler(options)` signature and documents precedence:
1. `createBusyKeyRoute` → 2. `createOverlayKeyRoute` → 3. `createPointerRoute` (explicit `overlayOpen` flag) → 4. `createPickerRoute` → 5. `createComposerRoute`; shared `createPastePipeline`.
Each route takes only the options fields it uses. Acceptance: 0.3 replay corpus produces an identical dispatch trace.

## Phase 4 — `app.tsx` → composition shell (≤ ~250 lines)

A0 first: read the full body; produce a hook → produced-values → consumers table; finalize facade membership (names stay).
Facades (approved names): `useAppState`, `useAppRefSpine`, `useAppBridges`, `useAppEnvironment`, `useAppSession`, `useAppExecution`, `useAppComposer`, `useAppPanels`.
Sub-phase order A1→A8: state+ref spine → bridges → environment → session → execution → composer → panels → AppView wiring + dead-local cleanup.

## Out of scope (separate workstreams)

AppProps slicing (H2), `/clear` leader-abort gate (H5), swallowed key-handler errors (H6), Scrollbar memoization (H7), reducer module-graph purity (M2). Moves and behavior fixes are never mixed in one commit.

## Execution log

- 2026-09-10: plan v1.1 committed; Phase 0.1 baseline started; 0.2 authored.

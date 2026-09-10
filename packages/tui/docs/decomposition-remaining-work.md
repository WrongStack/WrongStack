# TUI Decomposition — Remaining Work (recorded 2026-09-10)

Companion to `decomposition-plan.md` (the approved plan + execution log). This file records
everything still outstanding at the point the executing session paused, so any future session
can resume without archaeology. Work through it top-down; keep the plan's execution log
(`decomposition-plan.md`, append-only) updated as steps land.

## Status snapshot (as of this file)

- **Phase 0 (safety nets)** — COMPLETE. `tests/public-api-surface.test.ts`,
  `tests/slash-registration-enumeration.test.ts`, `tests/key-handler-replay-corpus.test.ts`
  (20 case characterization corpus; snapshot file alongside). All green.
- **Phase 1 (run-tui.ts)** — COMPLETE. Four facades landed:
  `run-tui-launch.ts` (3022839bf), `run-tui-session.ts` (e001084b1),
  `run-tui-mount.ts` (ba82116da + style 6b929c456), `run-tui-exits.ts` (3984ebef1).
- **Phase 2 (use-tui-slash-commands.ts)** — COMPLETE. Five slices landed
  (session 4259d5afd, provider 7aa5df0e3, design-kit af2c3b90b, settings b14169b52,
  resource 19f8358c2). Parent is a ~140-line pure composer; pinned 23-command
  registration order preserved (enumeration test untouched, green).
- **Phase 3 (app-key-handler.ts route chain)** — COMPLETE. Six routes: paste
  `key-route-paste.ts` (routePastePipeline), busy `key-route-busy.ts`
  (routeCtrlCEscalation + routeBusyInterrupt), overlay `key-route-overlay.ts`
  (8 route fns), pointer `key-route-pointer.ts` (routeSidebarFocusScroll +
  routePointerEvents), picker — **no move needed** (already a single delegation to
  the `useAppPickerKeys`-built handler; see plan log R5 entry), composer
  `key-route-composer.ts` (routeComposer + routeComposerTail). Shared context module:
  `key-handler-context.ts` (`KeyRouteContext` = `AppKeyHandlerOptions` + stdout/historyWidth/detach).
  `app-key-handler.ts` is down from 1102 to ~330 lines — an ordered route orchestrator.
- **Phase 4 (app.tsx facades)** — NOT STARTED.

## Remaining Phase 3 work (finish these before Phase 4)

### R5 — Picker route

- **What**: the picker delegation in `handleKey` — the `tryPickerKey(...)` call region
  (slash/@file/prompt pickers), including any sidebar-unfocus pre-step immediately above it.
  Locate by grepping `tryPickerKey` in `src/app-key-handler.ts` (single call site; the
  destructured name is still in the options bag).
- **How**: same pattern as routes 1–4 — move verbatim into
  `src/key-routes/key-route-picker.ts` as `routePicker(ctx, input, key): boolean | Promise<boolean>`
  (match the call's async-ness), replace the parent block with one call at the pinned position,
  trim now-dead imports/destructuring (let `tsc --noEmit` + `biome check` enumerate them;
  unused variables are TS6133 — fix by hand; unused imports biome can autofix).
- **If the block is already a single delegation** to `tryPickerKey` with no surrounding
  logic, record "already extracted — no move needed" in the execution log instead of
  inventing a wrapper (cost-ladder: do not write a module for a one-line call).
- **Gate**: `pnpm exec biome check --write <files> && pnpm --filter @wrongstack/tui run typecheck
  && pnpm --filter @wrongstack/tui exec vitest run tests/key-handler-replay-corpus.test.ts
  tests/public-api-surface.test.ts --config vitest.config.ts && pnpm --filter @wrongstack/tui run test`
  Acceptance oracle: **replay corpus 20/20 with identical dispatch traces.**
- **Land**: `git add` the new file, then
  `git commit --no-verify --only -F <msgfile> -- <files>` (the Core API snapshot pre-commit
  hook fails closed on this shared worktree — documented convention in the plan, D4/log line).

### R6 — Composer route (last god-file step)

- **What**: the composer family still inline in `handleKey`:
  1. `?` / `!` empty-draft shortcuts (help overlay / bash-mode enter),
  2. the Enter pipeline (Shift+Enter newline insert, bash-mode run through `/dev`,
     the 50ms `\r\n` dedupe window, the intentionally-not-awaited detached `submit()`),
  3. the `routeInputKey({...})` delegation (args bag built inline — move it verbatim),
  4. the Ctrl+P → PhaseMonitor/`/goal` alias.
- **How**: extract into `src/key-routes/key-route-composer.ts` (one or two functions —
  prefer two: `routeComposerShortcuts` for 1 and `routeComposerEnter` for 2–4 only if the
  seams are clean; otherwise a single `routeComposer` is fine). The `isEnter` derivation and
  `INPUT_PROMPT` are shared — keep them in the parent and pass through `ctx`/args, or move
  `INPUT_PROMPT` into the route module if the parent no longer uses it (tsc arbitrates).
- **Gate**: same fused chain as R5; acceptance oracle: **replay corpus 20/20 identical
  traces** (the corpus pins Enter/stray-`\n`→submit, `?`→toggleHelp, bash-mode exit).
- **Land**: fenced commit as above. Then append "Phase 3 complete" to the plan execution log,
  refresh SAGE progress memory, post a fleet status note.

### Phase 3 phase gate (after R6)

- Full `pnpm --filter @wrongstack/tui run typecheck` (both tsconfig projects) +
  full `pnpm --filter @wrongstack/tui run test` (expect 345 files green, exit 0).
- Optional but recommended: `pnpm --filter @wrongstack/cli run typecheck` (chains a tools+tui
  build; verifies the downstream consumer against fresh dist).

## Phase 4 — app.tsx facades (NOT STARTED)

1. **A0 (read-and-map, do this first)**: read the full current `src/app.tsx` (~1000 lines;
   line counts drift — re-read, do not trust stored numbers) and produce the dependency
   table: every hook call → produced values → consumers. Record it in the plan execution log
   or a docs file. This finalizes facade **membership** (names below are D2-approved and
   must not change without review):
   `useAppState`, `useAppRefSpine`, `useAppBridges`, `useAppEnvironment`, `useAppSession`,
   `useAppExecution`, `useAppComposer`, `useAppPanels`.
2. **A1–A8**: extract facades one per fenced commit in the plan's order (state+ref spine →
   bridges → environment → session → execution → composer → panels → final AppView wiring).
   Contract §0.3 (fixed facade call order at the top of `App`, no conditional hooks) is the
   hook-safety mechanism. Gate per commit: typecheck + full tui suite; the Phase 0 tests
   (API-surface freeze, replay corpus) must stay untouched and green.
3. Target: `App` reads as composition only (≤ ~250 lines). Props stay 132-field
   `AppProps` — the AppProps slicing (H2) is explicitly out of scope for the decomposition.

## Deferred items needing a review decision (not defects in the decomposition)

- **Settings slice part-param split (chimera MEDIUM, Phase 2)**: splitting
  `useSettingsSlashCommands(deps, part: 'core'|'appearance')` into two purpose-named hooks
  would change D2-approved facade names → requires a new review per D2. Current state is
  correct and gated; decide: split (needs review) or keep (record decision in the plan log).
- **`key-handler-context.ts` re-export block**: 11 type re-exports with zero textual
  consumers today. Confirm at Phase 3 close whether the route modules should import shared
  types from the context module (nice cohesion) or the block should be deleted.
- **`kanban-panel-render.test.ts` header comment**: L4–5 says the footer hint is "Ctrl+J"
  while the suite pins Ctrl+Y — pre-existing doc-comment drift, one-line fix, unrelated to
  the decomposition (found by a peer probe; not touched).

## Out-of-scope report findings still open (from the 2026-09-10 investigation; separate workstreams)

These were explicit non-goals of the decomposition and remain open as their own future
fixes (see the investigation report for details and line anchors):

- H5: `/clear` does not abort the in-flight leader run (session-generation gating absent in
  `use-provider-event-bridge.ts`).
- H6: `use-stable-key-handler.ts` silently swallows key-handler rejections.
- H7: `components/history/scrollbar-rail.tsx` unmemoized (~200 Boxes + ~1000 Texts per
  streaming flush); fresh-array prop from `ScrollableHistory`.
- M2: `reducers/composer.ts` imports `filterPromptPicker` from a `.tsx` component module
  (reducer module-graph purity — move the function to a plain module).
- M8: heap benchmark (`bench/`) is stale; wire `scripts/tui-heap-soak.mjs` into a scheduled
  CI job with a heap budget.

## Environment cautions for the resuming session

- This is a **shared worktree**: peer agents run concurrent `pnpm install` waves that can
  re-gut `node_modules` mid-command. Countermeasures (recorded in SAGE): chain
  install+test in ONE process, run vitest from `packages/tui` cwd (or direct store path),
  never `node -e "..."` on this Windows host (write a `.cjs` under `.temp_files/` instead),
  and `git commit -F <msgfile>` with message files under `.temp_files/` (cmd strips inline
  quotes; `.temp_files/` is wiped by peer cleanup agents — recreate as needed, delete by
  explicit name).
- Before every step: re-read the target region (line numbers in this file, the plan, and
  SAGE memories are dated 2026-09-10 and drift as steps land — contract §0.6).

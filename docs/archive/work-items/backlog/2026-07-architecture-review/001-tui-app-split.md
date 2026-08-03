# Split `packages/tui/src/app.tsx` into feature-scoped modules and sub-hooks

**Labels**  
`refactor` `architecture` `tech-debt` `tui` `hotspot`

## Summary

`packages/tui/src/app.tsx` is still the largest UI hotspot in the repo and currently acts as a UI shell, event bridge, controller host, and feature router. Even after earlier extractions, it remains too large to evolve safely.

## Why this matters

Most TUI feature work still lands in this file. That increases:
- regression risk
- review difficulty
- onboarding cost
- coupling between unrelated UI concerns

This issue is about reducing architectural concentration, not changing product behavior.

## Scope

Refactor `packages/tui/src/app.tsx` into feature-scoped modules/hooks, with the initial goal of reducing the file size and isolating major concerns.

## Acceptance criteria

- [x] `packages/tui/src/app.tsx` is reduced to **< 1500 lines** in the first pass
- [x] Feature slices are extracted into focused modules/hooks:
  - [x] session/history
  - [x] overlay/picker management
  - [x] fleet/director UI
  - [x] settings/statusline
  - [x] SDD/autonomy flows
- [x] No new inline effect/callback blocks over ~30 lines remain in `app.tsx`
- [x] `pnpm --filter @wrongstack/tui typecheck` passes
- [x] `pnpm --filter @wrongstack/tui test` passes
- [x] At least one new integration test covers a real interaction path

## Progress notes

Current session started the first low-risk extraction slices:
- moved restored-history computation into `packages/tui/src/app-initial-state.ts`
- moved the giant reducer bootstrap object into `createInitialState(...)`
- extracted input-history persistence into `packages/tui/src/hooks/use-input-history-persistence.ts`
- extracted prompt-picker loader/category-building into `packages/tui/src/hooks/use-prompt-picker.ts`
- extracted mode-picker opener mapping into `packages/tui/src/hooks/use-mode-picker.ts`
- extracted statusline hidden-item sync into `packages/tui/src/hooks/use-statusline-hidden-sync.ts`
- extracted stream-chip expiration logic into `packages/tui/src/hooks/use-stream-chip-expiration.ts`
- extracted working-directory chip formatting/sync into `packages/tui/src/hooks/use-working-dir-chip.ts`
- extracted composer editing/history/clipboard routing into `packages/tui/src/input-key-router.ts`
- extracted foreground agent execution and queue draining into `packages/tui/src/run-blocks-controller.ts`
- extracted submit orchestration and prompt-refinement recovery into `packages/tui/src/submit-controller.ts` and `packages/tui/src/submit-prompt-refinement.ts`
- extracted modal, settings, pointer, interrupt, and panel-close routing into `packages/tui/src/overlay-key-router.ts`
- introduced grouped, cycle-free host contracts in `packages/tui/src/tui-host-capabilities.ts`
- wired `packages/tui/src/app.tsx` to consume the extracted modules
- added focused tests in:
  - `packages/tui/tests/app-initial-state.test.ts`
  - `packages/tui/tests/prompt-picker-hook.test.ts`
  - `packages/tui/tests/mode-picker-opener.test.ts`
  - `packages/tui/tests/statusline-hidden-sync.test.ts`
  - `packages/tui/tests/stream-chip-expiration.test.ts`
  - `packages/tui/tests/working-dir-chip.test.ts`

The interaction-flow extraction is now protected by the top-level App journey
harness. The first key/submit/run/overlay slices reduced `app.tsx` from 7,672
to 6,129 lines (20.1%) while the full TUI suite remains green. Domain reducer
composition and the final thin-shell target remain tracked by T3.

The T3 reducer and state-contract phases are now complete: `app-reducer.ts` is
an 82-line typed composition root, all ten domain reducers stay below 600
lines, and `app-state.ts` / `app-props.ts` no longer import component-owned
types. Auth, Brain, settings, picker, session, statusline, and worktree
contracts now live in render-neutral modules.

The shell phase is complete. `app.tsx` fell from 6,129 to 1,455 physical
lines. Keyboard routing is isolated in the 674-line `app-key-handler.ts`, the
specialized picker controller is 317 lines, and the render tree is split into
621-line conversation/picker and 391-line status/monitor regions over a
render-neutral contract. Terminal environment state and pure render
projections live in `use-tui-environment-state.ts` and `app-view-state.ts`.

Source typecheck, all 210 TUI test files / 3,376 tests, focused App journeys,
the domain reducer tests, and the test-type ratchet with zero new diagnostics
pass. Architecture analysis reports zero runtime cycles; the state/view and
Brain type cycles removed by T3 no longer require exceptions. No extracted
replacement module crosses the 800-line hotspot threshold.

## Suggested implementation notes

- Prefer feature boundaries over purely mechanical hook extraction.
- Avoid moving complexity wholesale into one replacement hotspot.
- Keep behavior stable; this is a refactor, not a redesign.

## Effort

Estimated: **5–8 days**

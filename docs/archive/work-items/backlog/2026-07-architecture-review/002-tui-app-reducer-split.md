# Split `packages/tui/src/app-reducer.ts` into composed sub-reducers

**Labels**  
`refactor` `architecture` `tech-debt` `tui` `hotspot`

## Summary

`packages/tui/src/app-reducer.ts` has become a secondary hotspot. Logic extracted from `app.tsx` is accumulating here instead of being decomposed.

## Why this matters

Reducer concentration makes state transitions harder to reason about and increases the risk that UI refactors simply move complexity sideways instead of reducing it.

## Scope

Split the reducer into domain-focused sub-reducers and compose them through a typed root reducer.

## Acceptance criteria

- [x] `app-reducer.ts` is split into sub-reducers by domain:
  - [x] history/input
  - [x] pickers/overlays
  - [x] settings/statusline
  - [x] fleet/coordinator
  - [x] sessions/projects
- [x] Root reducer composes sub-reducers through a single typed entrypoint
- [x] State transitions remain behaviorally equivalent
- [x] Existing reducer tests pass unchanged or with minimal fixture updates
- [x] New tests exist for at least 2 extracted reducer domains

## Completion evidence

- `app-reducer.ts` was reduced from 2,532 lines to an 82-line typed composition root.
- Nine domain reducers plus a shared helpers module now live under `packages/tui/src/reducers/`; all are below
  the 600-line T3 limit (146–556 lines excluding the shared helper module).
- Each domain exposes an action type guard and retains a local exhaustive switch,
  so adding an unhandled action remains a compile-time error.
- `packages/tui/tests/domain-reducers.test.ts` exercises activity, settings, and
  workspace reducers directly; the unchanged root-reducer suites also pass.
- Verification: TUI typecheck, 209 test files, and 3,373 tests pass.

## Suggested implementation notes

- Preserve action compatibility where practical.
- Prefer small, testable state domains over one generic “utils” reducer.
- Keep cross-slice coordination explicit.

## Effort

Estimated: **3–5 days**

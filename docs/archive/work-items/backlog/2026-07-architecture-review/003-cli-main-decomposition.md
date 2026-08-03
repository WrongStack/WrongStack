# Continue `packages/cli/src/cli-main.ts` decomposition into stable boot-phase modules

**Labels**  
`refactor` `architecture` `tech-debt` `cli` `hotspot`

## Summary

`packages/cli/src/cli-main.ts` is now a phase orchestrator. Provider state, command-host adapters, fleet/session commands, runtime controllers, picker projection, lifecycle, and final dispatch preparation have typed owners outside the root.

## Why this matters

The completed boundary prevents feature logic from returning to the entrypoint and keeps boot/runtime/surface/shutdown changes independently reviewable.

## Scope

Continue the existing decomposition effort, but focus on stable boot-phase APIs rather than line-moving alone.

## Acceptance criteria

- [x] `cli-main.ts` is reduced to **< 1200 lines** (1,187 physical lines)
- [x] Boot logic is organized behind stable phase APIs:
  - [x] config/bootstrap
  - [x] container wiring
  - [x] session/runtime wiring
  - [x] host dispatch
- [x] `main()` reads as orchestration-only, not implementation-heavy
- [x] `packages/cli/tests/cli-main-baseline.test.ts` remains green
- [x] At least 2 new integration tests cover real dispatch behavior

## Completion evidence (2026-07-22)

The root fell from 2,675 to 1,187 physical lines and its relative import fan-out fell from 47 to 44. Twelve focused wiring modules now own command-host state/adapters, fleet and session commands, provider status and utility tools, eternal commands, runtime controller/picker/lifecycle boundaries, and dispatch preparation. CLI typecheck passes; the full CLI suite passes 250 files / 3,204 tests (2 files / 12 tests skipped); architecture scanner tests pass 8/8; CLI test-type verification reports zero new diagnostics; and architecture health reports zero runtime cycles and zero non-command slash imports.

## Suggested implementation notes

- Prefer extracting named boot-phase functions with typed inputs/outputs.
- Avoid introducing new implicit shared state between phases.
- Keep behavior stable; this issue is not for changing CLI UX.

## Effort

Estimated: **4–6 days**

# Split `packages/core/src/coordination/director.ts` by responsibility

**Labels**  
`refactor` `architecture` `tech-debt` `core` `hotspot`

## Summary

`packages/core/src/coordination/director.ts` is becoming the coordination-layer god module. Spawn policy, task lifecycle, budgets, collab sessions, and repair behavior are too concentrated.

## Why this matters

The multi-agent coordination layer is strategically important, but its current structure raises change risk and makes defects harder to localize.

## Scope

Refactor `director.ts` into focused modules while preserving the public `Director` API.

## Acceptance criteria

- [ ] `director.ts` is split into focused modules:
  - [x] spawn/admission
  - [x] task registry + waiting
  - [x] budget enforcement
  - [ ] repair/quality loops
  - [x] collab session handling
  - [ ] persistence/checkpoint integration
- [x] Public `Director` API remains backward-compatible
- [x] `packages/core/tests/coordination/*.test.ts` remain green
- [x] At least 1 new integration-style test covers a multi-step director flow

## D2 contract checkpoint (2026-07-22)

Director tools now consume explicit structural ports for spawn/admission, budget, assignment, repair, lease/recovery, lifecycle, read models, collaboration, answer storage, and event publishing. Collab sessions have a separate minimal host contract, and model-matrix source ownership moved to the neutral model-matrix module. This removed the five-module Director type cycle and its `ARCH-CYCLE-TYPE-10` exception without changing the public Director API. The remaining unchecked responsibility slices and line-count target belong to D3.

## D3 lifecycle checkpoint (2026-07-22)

Task registry/waiter state and budget policy now have focused state-owning controllers. The Director root dropped from 2,178 to 1,705 scanner lines (21.7%), while `fleet-spawn.ts` became spawn-only instead of retaining divergent lifecycle copies. The two D3 slices meet the program's 20% reduction gate; repair/persistence ownership and the long-term under-1,200 target remain open in this historical umbrella item.

## Suggested implementation notes

- Extract behavior by responsibility, not by arbitrary line ranges.
- Preserve invariants around task ownership, waiters, and budget accounting.
- Keep integration points explicit.

## Effort

Estimated: **5–7 days**

# TUI Feature Inventory & Test Gap Report

> Generated: 2026-08-01
> Source: `packages/tui/src` — 275 production source files
> Tests: `packages/tui/tests` — 266 test files

## Summary

| Metric | Count |
|--------|-------|
| Production source files | 275 |
| Test files | 266 |
| Coverage ratio | 96.7% (file-level) |
| Source files without a direct test | 150 |
| Components | 88 |
| Hooks | 60 |
| Reducers | 10 |
| Slash commands | 12 |
| Core modules | 105 |

## Feature coverage by category

### Components (88 files)

Most components have focused test files. Notable gaps:

| Component | Purpose | Test gap |
|-----------|---------|----------|
| `audit-panel.tsx` | Audit log viewer | No dedicated test |
| `brain-panel.tsx` | Brain status display | Reducer tested, component untested |
| `connections-panel.tsx` | Connection status | Reducer tested, component untested |
| `coordinator-panel.tsx` | Autonomous coordinator UI | Reducer tested, component untested |
| `cron-jobs.tsx` | Cron job monitor | Component tested |
| `goal-panel.tsx` | Goal/phase tracking | Reducer tested, component untested |
| `live-activity-strip.tsx` | Live activity feed | Height tested, render not |
| `phase-panel.tsx` | Phase execution monitor | Component tested |
| `shadow-panel.tsx` | Shadow agent panel | Component tested |
| `worktree-panel.tsx` | Worktree status | Component tested |

### Hooks (60 files)

Hooks are well-tested overall. Gaps:

| Hook | Purpose | Test gap |
|------|---------|----------|
| `use-app-runtime-refs.ts` | Stable runtime references | Untested |
| `use-core-tui-commands.ts` | Core TUI command wiring | Untested |
| `use-director-fleet-bridge.ts` | Director fleet event bridge | Untested |
| `use-help-panel.ts` | Help overlay state | Untested |
| `use-history-viewport-sync.ts` | History scroll sync | Untested |
| `use-interrupt-ladder.ts` | Interrupt escalation | Untested |
| `use-panel-controllers.ts` | Panel open/close | Untested |
| `use-settings-auto-save.ts` | Settings persistence | Untested |
| `use-stable-key-handler.ts` | Stable key dispatch | Untested |
| `use-tui-controllers.ts` | TUI controller wiring | Untested |
| `use-tui-environment-state.ts` | Environment state | Untested |
| `use-tui-event-bridge.ts` | Event bridge wiring | Untested |
| `use-tui-slash-commands.ts` | Slash command wiring | Untested |

### Reducers (10 files)

All reducers have dedicated tests — `domain-reducers.test.ts` covers the full set.

### Slash commands (12 files)

| Command | Test status |
|---------|-------------|
| `/connections` | ✅ Tested |
| `/context` | ✅ Tested |
| `/cron` | ✅ Tested |
| `/exit` | ✅ Tested |
| `/kill`, `/ps` | ✅ Tested |
| `/kanban` | ✅ Tested |
| `/memory` | ✅ Tested |
| `/queue` | ✅ Tested |
| `/settings` | ✅ Tested |
| `/steering` | ✅ Tested |

### Core modules with test gaps

These are infrastructure/utilities where many are type-only or wiring modules:

| Module | Category | Gap severity |
|--------|----------|-------------|
| `app-action-type.ts` | Type definitions | Low (types only) |
| `app-props.ts` | Type definitions | Low |
| `app-settings-type.ts` | Type definitions | Low |
| `app-state-core-types.ts` | Type definitions | Low |
| `app-state-fleet.ts` | Type definitions | Low |
| `app-ui-state.ts` | Type definitions | Low |
| `app-view-contract.ts` | Type definitions | Low |
| `app-view-state.ts` | Type definitions | Low |
| `brain-contracts.ts` | Type definitions | Low |
| `brain-panel-model.ts` | Model types | Low (duplicate path) |
| `settings-contracts.ts` | Type definitions | Low |
| `shared-types.ts` | Type definitions | Low |
| `tui-host-capabilities.ts` | Capability contract | Low |
| `ui-contracts.ts` | Type definitions | Low |

Most of the 150 untested files are type definition modules, wiring layers, or thin adapters that are exercised transitively through component and integration tests.

## Priority recommendations

### High priority (behavior-bearing, untested)

1. **`use-director-fleet-bridge.ts`** — Fleet event wiring; failures would silently drop fleet updates
2. **`use-interrupt-ladder.ts`** — Interrupt escalation logic; bugs affect user Ctrl+C behavior
3. **`use-tui-event-bridge.ts`** — Core event routing; failures break all real-time updates
4. **`use-history-viewport-sync.ts`** — Scroll position sync; failures cause visual glitches
5. **`audit-panel.tsx`** — Renders audit log; no test means rendering regressions go unnoticed

### Medium priority (wiring, low complexity)

6. **`use-panel-controllers.ts`** — Panel open/close orchestration
7. **`use-settings-auto-save.ts`** — Settings persistence debounce
8. **`use-core-tui-commands.ts`** — Command registration

### Low priority (types, adapters)

The ~130 remaining untested files are predominantly type-only modules, thin re-exports, or contract interfaces that are covered transitively by the 266 existing test files.

## Test infrastructure health

- **App journey harness** (`helpers/app-journey-harness.ts`) — Production App composition tested through real submit/history/resume journeys
- **Create-test-state** (`helpers/create-test-state.ts`) — Deterministic state builder for unit tests
- **Virtual scroll stress tests** — 8 dedicated stress tests for scroll behavior at 1000+ entries
- **Status bar overflow & composition** — Width-controlled overflow + rail-order tests on `renderRealTty` in the main config; raw truecolor SGR pins isolated in a dedicated config (`vitest.status-bar-sgr.config.ts`)

The TUI test suite is healthy at 266 files / 3,376+ tests. The gaps are concentrated in wiring hooks and type modules, not in user-facing behavior.

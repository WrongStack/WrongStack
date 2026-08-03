# Refactoring Roadmap — Q3 2026

**Generated:** 2026-07-12  
**Source:** `wrongstack-report-2026-07-12.md` (deep code analysis across 18 packages)  
**Historical backlog:** `docs/archive/work-items/backlog/2026-07-architecture-review/` (18 items)
**Architecture rules:** `docs/architecture-rules.md`  

---

## Overview

This roadmap synthesises the comprehensive report into a **week-by-week execution plan**. It merges the existing 18-item backlog with 8 newly discovered untracked hotspots, fixes section numbering, and clearly separates **done**, **in progress**, and **pending** work.

**Goal:** Reduce the top-10 largest files from a combined **~28,000 lines** to **under 1,500 lines each** while closing cross-package boundary violations and improving code quality metrics.

### Debt dimensions addressed

| Dimension | Metric | Target |
|-----------|--------|--------|
| File size | 127 files >500 lines, 15 >1000 lines | All core files <1000 lines |
| Cross-package edges | 20 CLI→TUI/WebUI violation files | 0 violations |
| Export sprawl | 111 exports from `@wrongstack/core` | <60 exports at top level |
| Type safety | 136 files using `any` in core | <20 files with `any` |
| Error handling | 96 bare `catch(()=>{})` | 0 bare catches in production |
| Logging | 76→60 `console.*` calls in core/src (16 eliminated, 10 classes with Logger support) | 0 direct console calls |
| Test coverage | ~48% ratio in `core` package | >70% for coordination layer |

---

## Wave 0 — Done (baseline secure)

These items are already complete. No action needed.

| Item | Description | Evidence |
|------|-------------|----------|
| **#018** | Modularity audit — file-size scan, import-fan-in, cross-package matrix | Report at `wrongstack-report-2026-07-12.md` |
| **PR #242** | `parseNextSteps` promoted from `@wrongstack/tui` to `@wrongstack/tools` | Merged per PR #242 |
| **Memory leaks ×3** | LargeAnswerStore, BrainDecisionLedger, KnowledgeGraph | Fixed by peer leader |
| **cli-main extractions** | 4 of 8 wiring/ modules extracted (down from 3,492→2,411 lines) | By peer leader |
| **Goal refiner** | Configurable refiner provider/model with 4-tier fallback | By peer leader |
| **WebUI settings** | 5 missing settings added to settings panel | By peer leader |
| **Mailbox client purge** | `purgeClients()` method + HTTP route added | By peer leader |
| **Slash settings** | 48/48 subcommands implemented | By peer leader |

---

## Wave 1 — Safety nets & quick wins (now – week 2)

### Week 1: Safety nets

| ID | Task | File(s) | Effort | Depends on |
|----|------|---------|--------|------------|
| P1.1 | Convert hotspot guardrails from advisory to ratcheting | `hotspot-guardrails.test.ts` | 1 day | — |
| P1.2 | Add façade-module cap rule (≥30 exports → split) | `hotspot-guardrails.test.ts` | 0.5 day | P1.1 |
| P1.3 | Expand TUI integration coverage (mount + interaction) | `packages/tui/tests/` | 2 days | — |
| P1.4 | Expand CLI boot/dispatch integration tests | `packages/cli/tests/` | 2 days | — |
| P1.5 | Fix section numbering in report (duplicate 10/11) | `wrongstack-report-2026-07-12.md` | 0.25 day | — |

### Week 2: Quick code quality wins

| ID | Task | File(s) | Effort | Depends on |
|----|------|---------|--------|------------|
| P1.6 | **✅ DONE**: Replace `console.*` with structured `Logger` (76→60 calls, 10 classes with Logger support) | `packages/core/src/*` | 2 days | — |
| P1.7 | Add explicit `logger` param to bare `catch(()=>{})` blocks (96 sites) | Cross-package | 2 days | — |
| P1.8 | Reduce `@wrongstack/core` export surface — move security/* behind subpath | `packages/core/src/index.ts` | 2 days | — |
| P1.9 | **✅ DONE**: Split `cli/src/hq-server.ts` (2,635→1,576L) — extracted 30 functions into 5 modules under `hq-server/` | `packages/cli/src/hq-server.ts` | 2 days | — |

### Files changed this wave

`hotspot-guardrails.test.ts` · `*` (cross-package console→Logger — ✅ done) · `*` (catch blocks) · `packages/core/src/index.ts` · `packages/cli/src/hq-server.ts` (✅ done) · `packages/cli/src/hq-server/auth.ts` (new) · `packages/cli/src/hq-server/utils.ts` (new) · `packages/cli/src/hq-server/ws.ts` (new) · `packages/cli/src/hq-server/snapshot.ts` (new) · `packages/cli/src/hq-server/types.ts` (new) · TUI test files · CLI test files

---

## Wave 2 — Big hotspot reductions (weeks 3–5)

### Week 3–4: TUI + CLI decomposition

| ID | Task | File(s) | Effort | Depends on |
|----|------|---------|--------|------------|
| P2.1 | **#001**: Complete `tui/app.tsx` split — extract panels/ feature architecture (53 components → focused groups) | `packages/tui/src/app.tsx` (7,600L) | 5 days | P1.3 |
| P2.2 | **#002**: Split `tui/app-reducer.ts` into composed sub-reducers | `packages/tui/src/app-reducer.ts` (2,381L) | 3 days | P2.1 |
| P2.3 | **#003**: Continue `cli-main.ts` decomposition — extract remaining 4 wiring modules | `packages/cli/src/cli-main.ts` (2,411L) | 3 days | P1.4 |
| P2.4 | **NEW**: Split `cli/src/fleet/host.ts` — extract supervisor, registry, broadcast | `packages/cli/src/fleet/host.ts` (2,068L) | 2 days | — |

### Week 5: Core coordination decomposition

| ID | Task | File(s) | Effort | Depends on |
|----|------|---------|--------|------------|
| P2.5 | **#004**: Split `core/director.ts` by responsibility (93 methods → spawn/ task/budget/collab/persist modules) | `packages/core/src/coordination/director.ts` (2,233L) | 5 days | — |
| P2.6 | **NEW**: Split `core/director-tools.ts` by tool family (14 factories → 7 focused files) | `packages/core/src/coordination/director-tools.ts` (1,768L) | 2 days | — |
| P2.7 | **NEW**: Split `core/session-store.ts` into reader / writer / recovery | `packages/core/src/storage/session-store.ts` (1,736L) | 2 days | — |
| P2.8 | **NEW**: Split `webui/types.ts` by domain (session/kanban/fleet/settings) | `packages/webui/src/types.ts` (2,185L) | 1 day | — |

### Target state after Wave 2

```
tui/app.tsx                    7,600L  →  ≤1,500L
tui/app-reducer.ts             2,381L  →  ≤600L
cli/cli-main.ts                2,411L  →  ≤800L
cli/hq-server.ts               2,635L  →  1,576L ✅ (beat target)
cli/fleet/host.ts              2,068L  →  ≤1,000L
core/director.ts               2,233L  →  ≤1,200L
core/director-tools.ts         1,768L  →  ≤1,000L
core/session-store.ts          1,736L  →  ≤500L × 3 files
webui/types.ts                 2,185L  →  ≤500L × 4 files
```

---

## Wave 3 — Cross-package boundary cleanup (weeks 6–7)

### Week 6: Unblock core→mcp cycle

| ID | Task | File(s) | Effort | Depends on |
|----|------|---------|--------|------------|
| P3.1 | **NEW (blocker)**: Move `MCPRegistry` type to `@wrongstack/core` to break `core→mcp` cycle | `packages/mcp/src/registry.ts` → `packages/core/src/` | 2 days | — |
| P3.2 | **#018-B**: Move `@wrongstack/webui/server` to `@wrongstack/core/server` (unblocks 10 CLI violation sites) | `packages/webui/src/server/` → `packages/core/src/server/` | 2 days | P3.1 |

### Week 7: Boundary cleanup

| ID | Task | File(s) | Effort | Depends on |
|----|------|---------|--------|------------|
| P3.3 | **#009**: Extract shared logic from `cli/src/slash-commands/` into service modules | `packages/cli/src/slash-commands/` | 3 days | — |
| P3.4 | **#010**: Make `@wrongstack/runtime` a real package boundary | `packages/runtime/` | 2 days | P3.2 |
| P3.5 | **#011**: Reduce `@wrongstack/core` top-level export sprawl (111→≤60) | `packages/core/src/index.ts` | 2 days | — |
| P3.6 | **#015**: Unify shared app-service flows across CLI, TUI, WebUI | Cross-surface | 2 days | P3.2, P3.3 |

---

## Wave 4 — Governance & visibility (weeks 8–9)

| ID | Task | File(s) | Effort | Depends on |
|----|------|---------|--------|------------|
| P4.1 | **#005**: Deepen TUI integration coverage (post-split regression protection) | `packages/tui/tests/` | 2 days | P2.1 |
| P4.2 | **#006**: Deepen CLI boot/dispatch integration tests | `packages/cli/tests/` | 2 days | P2.3 |
| P4.3 | **#013**: Add multi-agent E2E orchestration tests | `packages/core/tests/coordination/` | 3 days | P2.5 |
| P4.4 | **#012**: Architecture health reporting (CI dashboard) | `scripts/` + CI config | 2 days | — |
| P4.5 | **#014**: Automated drift detection (compare against ratchet) | `scripts/` | 2 days | P4.4 |
| P4.6 | **#017**: Package-boundary visualization (dependency graph) | `scripts/` | 1 day | — |
| P4.7 | **#016**: Temporary architecture exceptions policy | `docs/` | 1 day | — |

---

## New backlog items (not in existing 18-item backlog)

These 8 hotspots were identified during deep code analysis but have no dedicated backlog item yet:

| ID | File | Lines | Recommendation | Suggested wave |
|----|------|-------|---------------|----------------|
| N1 | `cli/src/hq-server.ts` | 2,635→1,576 | ✅ Done — extracted 30 functions into 5 modules | Wave 1 (P1.9) |
| N2 | `cli/src/fleet/host.ts` | 2,068 | Extract supervisor/registry/broadcast concerns | Wave 2 (P2.4) |
| N3 | `core/storage/session-store.ts` | 1,736 | Split into reader/writer/recovery | Wave 2 (P2.7) |
| N4 | `core/coordination/director-tools.ts` | 1,768 | 14 tool factories → 7 files by domain | Wave 2 (P2.6) |
| N5 | `webui/types.ts` | 2,185 | Split by domain (session/kanban/fleet/settings) | Wave 2 (P2.8) |
| N6 | `cli/src/hq-dashboard-html.ts` | 2,293 | Extract inline template + JS from server code | Wave 2 |
| N7 | `webui/components/OfficeMapCanvas.tsx` | 1,943 | Split renderer / hit-test / animation | Wave 2 |
| N8 | `webui/components/SetupScreen.tsx` | 1,540 | One file per onboarding step | Wave 2 |

---

## Performance & memory follow-ups (cross-cutting)

Tracked from peer audits. Not structural refactors but should be done alongside the relevant phase.

| Issue | File | Severity | When |
|-------|------|----------|------|
| Full file RMW on prompt insertion | `prompt-usage-store.ts` | 🔴 P0 | Wave 1 |
| Full file RMW on remember/forget | `memory-backend.ts` | 🔴 P0 | Wave 1 |
| Config `structuredClone` + `deepFreeze` on partial update | `config-store.ts` | 🔴 P0 | Wave 1 |
| Iteration fingerprint canonicalize+stringify | iteration fingerprint | 🟡 P1 | Wave 2 |
| JSONL re-parse on cache invalidation | `global-mailbox.ts` | 🟡 P1 | Wave 2 |
| `CollabBus.injectionQueue` pending forever | `collab-bus.ts` | 🟡 Low | Wave 2 |
| `DesignKitLoader` caches never invalidated | `design-kit-loader.ts` | 🟡 Low | Wave 3 |

---

## Effort summary

| Wave | Focus | Items | PR count | Duration |
|------|-------|-------|----------|----------|
| 0 | **Done** (baseline + bugfixes) | 8 | ~12 | Already complete |
| 1 | Safety nets + quick code quality | 9 | 9 | 2 weeks |
| 2 | Hotspot reductions (8 files → ≤1,500L) | 8 | 8 | 3 weeks |
| 3 | Cross-package boundary cleanup | 6 | 6 | 2 weeks |
| 4 | Governance, visibility, E2E tests | 7 | 7 | 2 weeks |
| **Total** | **Complete program** | **38** | **42** | **~9 weeks** |

### Parallelism potential

| Parallel track A | Parallel track B | Parallel track C |
|-----------------|-----------------|-----------------|
| P1.1–P1.2 (guardrails) | P1.6 (console→Logger) | P1.7 (catch blocks) |
| P1.3 (TUI tests) | P1.4 (CLI tests) | P1.9 (hq-server split) |
| P2.1–P2.2 (TUI split) | P2.3 (cli-main) | P2.4 (fleet/host split) |
| P2.5 (director) | P2.6 (director-tools) | P2.7 (session-store) |
| P3.1–P3.2 (cycle break) | P3.3–P3.5 (boundary) | P3.6 (service unification) |
| P4.1–P4.3 (tests) | P4.4–P4.7 (governance) | — |

Tracks A, B, C can be staffed by separate agents. Tracks are independent within each wave.

---

## Risk register

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| `hq-server.ts` uncommitted hunks block clean rebase | Wave 1 delay | Medium | Resolve via mailbox before starting P1.9 |
| `core→mcp` cycle not broken | Blocks Wave 3 entirely | Low | P3.1 is straightforward — move MCPRegistry type |
| TUI app.tsx split breaks integration tests | Wave 2 delay | Medium | P1.3 (TUI tests) must land before P2.1 |
| Peer conflicts on cli-main extractions | Redoing work | Low | Pause at 4 of 8; communicate via mailbox |
| Performance P0 issues found mid-refactor | Unplanned work | Medium | Address alongside Wave 1 as discovered |

---

## Verification gates

Each PR must pass these before merging:

- [ ] `pnpm typecheck` — zero new type errors
- [ ] `pnpm lint` — zero new lint errors
- [ ] Existing tests pass for the affected package(s)
- [ ] No new `console.*` calls added (enforced by lint rule)
- [ ] Hotspot guardrails test still green (ratchet not lowered)
- [ ] Package-boundary test still green (no new cross-package violations)
- [ ] File count check: changed files ≤20 per PR (reviewable size)

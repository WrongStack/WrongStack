# WrongStack — Comprehensive Refactoring Report

**Date:** 2026-07-12
**Scope:** Full monorepo — 18 packages, ~130K SLOC
**Methodology:** File-size scan, import-fan-in analysis, cross-package dependency matrix, code quality pattern search, test coverage review, existing backlog audit

---

## Executive Summary

The WrongStack monorepo is in a healthy but maturing state. Architecture boundary tests pass. The package graph is acyclic. Security and critical-bug counts are at zero. However, the codebase has grown **significantly** — the modularity audit at `018-modularity-audit-and-plan.md` identified **15 files >1000 lines** (up from 3 on May 30). Several of these are genuine hotspots that increase change risk, reduce discoverability, and make onboarding harder.

**Three dimensions of technical debt** are present:

1. **File size / decomposition debt** — 127 files exceed 500 lines across 4 main packages (core, cli, tui, webui)
2. **Cross-package boundary debt** — CLI imports from TUI and WebUI in 10+ violation sites
3. **Export surface sprawl** — `@wrongstack/core/index.ts` exports 111 symbols, `types/index.ts` re-exports 38 modules via wildcard

An existing 18-item architecture review backlog (`docs/backlog/2026-07-architecture-review/`) with sequenced waves already covers most of these. This report **does not duplicate** that backlog. It validates it, adds fresh measurements, and identifies gaps not yet captured.

---

## 1. Largest Files Needing Immediate Decomposition

### 🔴 P0 — Must split

| Lines | File | Risk |
|-------|------|------|
| **7,600** | `packages/tui/src/app.tsx` | God component — 52 components + 16 hooks imported directly. Simultaneously render root, keyboard host, event-bridge host, controller host, feature router, and panel state machine. **Backlog: #001 (in progress)** |
| **2,631** | `packages/cli/src/hq-server.ts` | HQ HTTP/WS server — 4 concerns mixed: HTTP routes, WS handlers, auth middleware, static serving. **Not tracked in backlog.** |
| **2,411** | `packages/cli/src/cli-main.ts` | CLI orchestrator — still too large despite 4 wiring/ extractions (down from 3,492). **Backlog: #003** |
| **2,293** | `packages/cli/src/hq-dashboard-html.ts` | Mostly generated HTML + inline JS. Can extract template to separate file. **Not tracked.** |
| **2,233** | `packages/core/src/coordination/director.ts` | Coordination-layer god module — spawn policy, task lifecycle, budgets, collab sessions all mixed. **Backlog: #004** |
| **2,185** | `packages/webui/src/types.ts` | All WebUI types in one file. **Not tracked in backlog.** |
| **2,068** | `packages/cli/src/fleet/host.ts` | CLI fleet host — supervisor, registry, broadcast mixed. **Not tracked.** |
| **1,768** | `packages/core/src/coordination/director-tools.ts` | Director tool wrappers — per-tool-family split needed. **Backlog: #004 (indirectly)** |
| **1,736** | `packages/core/src/storage/session-store.ts` | Session store — reader, writer, analyzer, recovery all in one. **Not tracked.** |
| **1,632** | `packages/core/src/coordination/global-mailbox.ts` | Mailbox implementation — core logic + persistence + file locking. |
| **1,617** | `packages/core/src/kernel/events.ts` | Event bus — extract event-type registry. |
| **1,507** | `packages/core/src/hq/protocol.ts` | HQ protocol — consider subdomain splitting. |
| **1,443** | `packages/core/src/types/config.ts` | Config type definitions — very large type file. |

### 🟡 P1 — Should split

| Lines | File | Risk |
|-------|------|------|
| **1,272** | `packages/core/src/coordination/multi-agent-coordinator.ts` | Coordinator — split by responsibility (same pattern as director) |
| **1,270** | `packages/core/src/storage/config-loader.ts` | Config loading — validation, migration, secrets all in one |
| **1,500** | `packages/cli/src/repl.ts` | REPL — history rendering + key handling extraction |
| **1,306** | `packages/cli/src/slash-commands/sdd.ts` | SDD — already partially split into `sdd/` dir, continue extraction |
| **1,249** | `packages/cli/src/slash-commands/kanban.ts` | Kanban — 48 exported functions, moderate size |
| **1,230** | `packages/core/src/execution/tool-executor.ts` | Tool execution — large but well-organized |
| **2,161** | `packages/tui/src/components/history/utils.tsx` | History rendering — split parser/renderer/virtualization |
| **1,664** | `packages/tui/src/components/status-bar.tsx` | Status bar — consider status-area decomposition |
| **1,543** | `packages/tui/src/components/settings-picker.tsx` | Settings picker |
| **1,943** | `packages/webui/src/components/OfficeMapCanvas.tsx` | Office map — split renderer/hit-test/animation |
| **1,540** | `packages/webui/src/components/SetupScreen.tsx` | Setup — one file per onboarding step |
| **1,288** | `packages/webui/src/App.tsx` | WebUI shell — continues growing |
| **1,199** | `packages/webui/src/components/SettingsPanel/index.tsx` | Settings panel — one file per section |

### Total hotspot count: **127 files >500 lines** across 4 main packages

---

## 2. Cross-Package Boundary Violations

### CLI imports from TUI/WebUI (20 files)

The CLI package imports from `@wrongstack/tui` and `@wrongstack/webui` in **20 files** across `packages/cli/src/`:

| Source | Import | From | Severity |
|--------|--------|------|----------|
| `cli/src/auth-menu/panel-service.ts` | `AuthPanelHost` + 3 | `@wrongstack/tui` | 🟡 UI model leaked to CLI |
| `cli/src/execute-deps.ts` | `executeDeps` | `@wrongstack/webui/server` | 🟢 Utility |
| `cli/src/hq-server.ts` | 5 symbols | `@wrongstack/webui/server` | 🟡 Server protocol |
| `cli/src/webui-server.ts` | 5+ symbols | `@wrongstack/webui/server` | 🟡 Server protocol |
| `cli/src/webui-server/*` (12 files) | Various | `@wrongstack/webui/server` | 🟡 Helper reuse |

**Root cause**: `@wrongstack/webui/server` contains server-side infrastructure (HTTP, WS, auth, lifecycle) that the CLI legitimately reuses — but its home in a "webui" package is misleading. The `parseNextSteps` issue (import from TUI) was fixed per PR #242.

**Recommendation**: Extract shared server infrastructure to `@wrongstack/core/server` **after** breaking the `core → mcp` cycle (requires moving `MCPRegistry` to core first). This is fully documented in backlog item #018, §3.1.1.

---

## 3. Export Surface Sprawl

### `@wrongstack/core/index.ts` — 111 exports

The top-level barrel file re-exports from **33 submodules** via 111 `export` statements (9 wildcard + 102 named). This creates:

- **Accidental coupling** — consumers can import anything from the top level instead of subpath imports
- **Blurry boundaries** — hard to tell which exports belong to which layer

### `@wrongstack/core/types/index.ts` — 38 wildcard re-exports

```typescript
export * from './blocks.js';
export * from './messages.js';
export * from './tool.js';
// ... 35 more wildcards
```

This barrel re-exports every type from every types submodule. A module that imports `Config` from `@wrongstack/core` also gets `ToolResult`, `Message`, `EventBus`, etc. in scope.

### `packages/core/src/defaults/index.ts` — 402 lines

Acts as a compatibility barrel with substantial overlap across domain-owned exports.

**Backlog**: Item #011 (Reduce core export sprawl). Not yet started.

---

## 4. Code Quality Issues

### 4.1 Type Safety

- **136 files** in `packages/core/src` use `any` — 77 typed, 59 avoidable
- **25 `@ts-expect-error` / `@ts-ignore`** comments across the codebase (mostly in tests, but 5 in production source)
- **`as any` casts** — 1 found in `mailbox-types.ts` (verified — acceptable for protocol-level type coercion)

### 4.2 Direct `console.*` calls

**Status: 76 → 60** (16 production calls eliminated; many more converted to injectable/logWarn patterns)

- **60 `console.log/warn/error/debug`** occurrences remain in `packages/core/src` production code
- These break down into **deliberate categories**:

| Category | Count | Assessment |
|----------|:-----:|------------|
| `logWarn`/`logError` helper fallbacks (intentional) | ~14 | The helper fallback — fires only when no Logger is configured, preserving backward compatibility |
| Injectable free-function defaults (`warn ?? console.warn`) | ~10 | Callers can pass a logger's `warn` method to override; no changes needed for callers that don't |
| Debug-only (env-guarded by `WRONGSTACK_DEBUG`) | ~10 | Compaction instrumentation, goal debug — only fire in development |
| Early-boot (before Logger is constructed) | ~6 | `boot.ts`, `child-env.ts`, directory utils — no structured logger exists yet |
| Small remaining (1-2 calls each) | ~20 | Low-priority files with 1-2 calls each, mostly in non-critical paths |

- **Hotspots cleaned**: `config-loader.ts` (10→4 all intentional), `skills-plugin.ts` (8→0), `session-store.ts` (5→4 all logWarn fallback), `global-mailbox.ts` (5→0)

### 4.3 Logger migration progress

**10 classes** now accept a structured `Logger` in their options. **6 of them** are wired with production loggers:

| Class | File | Logger wired in production? |
|------|------|:--------------------------:|
| `DefaultConfigLoader` | `storage/config-loader.ts` | ✅ `boot.ts` passes bootLogger |
| `DefaultSecretVault` | `security/secret-vault.ts` | ✅ `boot.ts` passes bootLogger |
| `DefaultSessionStore` | `storage/session-store.ts` | ✅ `runtime/container.ts` passes logger |
| `EternalAutonomyEngine` | `execution/eternal-autonomy.ts` | ✅ `cli-main.ts` passes logger |
| `ParallelEternalEngine` | `execution/parallel-eternal-engine.ts` | ✅ `cli-main.ts` passes logger |
| `HqPublisher` | `hq/publisher.ts` | ✅ `cli-main.ts` + `mailbox-attach.ts` pass logger |
| `QueueStore` | `storage/queue-store.ts` | ✅ `wiring/session.ts` passes logger |
| `DefaultMailbox` | `coordination/mailbox.ts` | ⚪ Option available, not yet wired |
| `DoneConditionChecker` | `execution/autonomous-runner.ts` | ⚪ Option available, not yet wired |
| `AutonomousCoordinator` | `coordination/autonomous-coordinator.ts` | ⚪ Option available, not yet wired |

**Injectable free functions** (9 functions across 5 files) now accept an optional `warn` callback:
- `loadGoal()`, `savePlan()`, `saveTasks()`, `saveTodosCheckpoint()`, `attachTodosCheckpoint()`
- `stripUnsafeInProjectFields()`, `rewriteConfigEncrypted()`, `restrictFilePermissions()`, `checkKeyFilePermissions()`

### 4.4 Large catch-all files

Certain files combine multiple unrelated responsibilities:
- `kanban/manager.ts` — 48 exported functions, all delegating to `storage.ts` with thin validation
- `storage/config-loader.ts` — config loading + validation + secrets + migration
- `kernel/events.ts` — emitter + all event type definitions + helper functions
- `hq/protocol.ts` — all HQ protocol message types + serialization

---

## 5. Performance Bottlenecks (from peer audit)

Reported earlier by peer leader (performance audit):

| Priority | Issue | File | Impact |
|----------|-------|------|--------|
| 🔴 P0 | Full file RMW on every prompt insertion | `prompt-usage-store.ts` | Every prompt insertion rewrites the entire store |
| 🔴 P0 | Full file RMW on every remember/forget | `memory-backend.ts` | Memory mutations rewrite entire file |
| 🔴 P0 | structuredClone + deepFreeze on every config partial update | `config-store.ts` | Full config tree cloned per update |
| 🟡 P1 | Full recursive canonicalize+stringify per iteration | iteration fingerprint | Per-iteration overhead |
| 🟡 P1 | Full JSONL re-parse on cache invalidation | `global-mailbox.ts` | Mailbox reads re-parse entire JSONL |
| 🟡 P1 | Full file RMW per single ack | mailbox | Single ack rewrites entire mailbox |
| 🟡 P1 | WeakSet allocated per call | `safeStringify` | GC pressure |

---

## 6. Memory Leaks (from peer audit)

| Status | Issue | File | Fix |
|--------|-------|------|-----|
| ✅ Fixed | `LargeAnswerStore.store` never cleared | `large-answer-store.ts` | `clear()` wired into Director.shutdown() |
| ✅ Fixed | `BrainDecisionLedger.outcomeByRequest` unbounded | `brain-ledger.ts` | Ring eviction added |
| ✅ Fixed | `KnowledgeGraph` no eviction | `knowledge-graph.ts` | 2000-node cap |
| 🟡 Low | `CollaborationBus.injectionQueue` pending forever | `collab-bus.ts` | Injection queue pending |
| 🟡 Low | `DesignKitLoader` module caches never invalidated | `design-kit-loader.ts` | Process-wide caches |

---

## 7. Test Coverage Gaps

### By package

| Package | Source Files | Tests | Ratio | Assessment |
|---------|------------|-------|-------|------------|
| `core` | 759 | ~362 | ~48% | Inconsistent — core coordination module has poor coverage per cli-main |
| `cli` | 554 | many | High | Good coverage |
| `tui` | 237 | many | High | Good but mostly unit, few integration |
| `webui` | 454 | many | High | Good coverage |
| `tools` | 223 | ~481 | High | Strong |
| `acp` | 58 | ~401 | Very high | Excellent |
| `plugins` | 197 | ~933 | Very high | Excellent |

### Gaps in critical files

Large files (>500 lines) in `@wrongstack/core` **without matching tests**:

| File | Lines | Missing coverage |
|------|-------|-----------------|
| `coordination/director.ts` | 2,233 | Multi-step director flows, error recovery paths |
| `coordination/director-tools.ts` | 1,768 | Tool wrapper edge cases |
| `coordination/global-mailbox.ts` | 1,632 | File lock contention, concurrent access |
| `coordination/multi-agent-coordinator.ts` | 1,272 | Complex coordination scenarios |
| `execution/eternal-autonomy.ts` | 1,043 | Goal refinement + autonomous loop edge cases |
| `coordination/autonomous-coordinator.ts` | 942 | Autonomy state machine transitions |
| `coordination/fleet-supervisor.ts` | 769 | Supervisor recovery paths |
| `coordination/fleet-manager.ts` | 587 | Fleet lifecycle edge cases |
| `storage/session-store.ts` | 1,736 | Reader/writer separation, recovery paths |

### Test quality issues

- **TUI integration coverage is sparse** — backlog item #005 tracks this
- **CLI boot/dispatch integration coverage is thin** — backlog item #006 tracks this
- **Cross-surface E2E tests are missing** — backlog item #013 tracks this

---

## 8. Existing Backlog Alignment

An 18-item architecture review backlog (`docs/backlog/2026-07-architecture-review/`) exists and is well-organized into 5 waves. The modularity audit (#018) adds 3 new findings beyond those:

| Backlog Item | Status | Priority | Notes |
|-------------|--------|----------|-------|
| #001 — `tui/app.tsx` split | **In progress** | 🔴 P0 | 8 hook extractions done; needs panels/ feature-split |
| #002 — `tui/app-reducer.ts` split | Pending | 🔴 P0 | Follows #001 |
| #003 — `cli-main.ts` decomposition | **In progress** | 🔴 P0 | 4 of 8 wiring modules extracted by peer leader |
| #004 — `director.ts` responsibility split | Pending | 🔴 P0 | Will follow #001/#002 |
| #005 — TUI integration coverage | Pending | 🟡 P1 | Enabling work for #001/#002 |
| #006 — CLI boot/dispatch tests | Pending | 🟡 P1 | Enabling work for #003 |
| #007 — Hotspot guardrails ratcheting | Pending | 🟡 P1 | Convert advisory to enforcement |
| #008 — Refresh hotspot docs | Pending | 🟢 P2 | Housekeeping |
| #009 — Extract CLI services from slash-commands | Pending | 🟡 P1 | Cleanup |
| #010 — Make runtime a real boundary | Pending | 🟡 P1 | Package cleanup |
| #011 — Reduce core export sprawl | Pending | 🟡 P1 | ~2–4 days |
| #012 — Architecture health reporting | Pending | 🟢 P2 | Governance |
| #013 — Multi-agent E2E tests | Pending | 🟡 P1 | Quality |
| #014 — Hotspot drift detection | Pending | 🟢 P2 | Governance |
| #015 — Unify shared app services | Pending | 🟡 P1 | Cleanup |
| #016 — Architecture exceptions policy | Pending | 🟢 P2 | Governance |
| #017 — Package boundary visualization | Pending | 🟢 P2 | Governance |
| #018 — Modularity audit (this report) | **Complete** | 📋 | Reference |

### Gaps in backlog: **5 items not tracked**

1. **`packages/cli/src/hq-server.ts`** (2,631 lines) — No backlog item. Should extract WS handlers, HTTP routes, auth middleware.
2. **`packages/cli/src/hq-dashboard-html.ts`** (2,293 lines) — No backlog item. Generated HTML shell.
3. **`packages/cli/src/fleet/host.ts`** (2,068 lines) — No backlog item. Supervisor, registry, broadcast mixed.
4. **`packages/webui/src/types.ts`** (2,185 lines) — No backlog item. All types in one barrel.
5. **`packages/core/src/storage/session-store.ts`** (1,736 lines) — No backlog item. Reader/writer/analyzer/recovery mixed.
6. **`packages/core/src/coordination/director-tools.ts`** (1,768 lines) — In backlog item #004 only as indirect target. Needs explicit per-tool-family split.
7. **`packages/webui/src/components/OfficeMapCanvas.tsx`** (1,943 lines) — No backlog item.
8. **`packages/webui/src/components/SetupScreen.tsx`** (1,540 lines) — No backlog item.

---

## 9. Deep Code Analysis — Class-Level Hotspots

This section adds fresh code-level measurements not present in the previous report. Each entry was verified by reading the source file.

### 9.1 `packages/tui/src/app.tsx` (7,600 lines)

| Metric | Value |
|--------|-------|
| Import statements | 103 (95 internal, 8 external) |
| Component references in render | 53 unique React components |
| `useState` calls | 9 |
| `useEffect` calls | 59 |
| `useCallback` calls | 30 |
| `useRef` calls | 34 |
| `useReducer` calls | 1 |
| Custom hooks | 18 |
| Export symbols | 4 |
| Render return starts at | Line 6,912 (render = 689 lines) |

The `AppProps` interface alone spans ~400 lines (lines 226–699). The component imports 52 child components + 16 hooks directly. It simultaneously serves as the React root, keyboard handler, event bus subscriber, controller factory, panel router, and state dispatcher. **59 `useEffect` calls** indicate excessive side-effect management that should be split into focused hooks.

### 9.2 `packages/cli/src/hq-server.ts` (2,631 lines)

| Metric | Value |
|--------|-------|
| Top-level functions | 39 |
| Core server function | `startHqServerWithAuth` (~1,866 lines, line 765–2631) |
| Internal HTTP route handlers | 10+ inline in a single closure |
| WebSocket upgrade paths | 2 (inline) |
| Auth token maps | 4 `Map`/`Set` instances managed inline |

The main server setup function contains **~1,866 lines** of inline HTTP route handlers, WebSocket upgrade handlers, auth middleware, timers, and cleanup logic — all inside one closure. There is no router abstraction; routes are matched via `if (url.pathname.startsWith('/api/...'))` chains. This structure prevents unit testing individual routes without starting the entire server.

### 9.3 `packages/core/src/coordination/director.ts` (2,233 lines)

| Metric | Value |
|--------|-------|
| Class | `Director` (lines 372–2,232, 1,861 lines) |
| Methods | **~93** |
| Fields/properties | **~114** |
| Imports | 32 internal |

The Director class has **93 methods and 114 fields**, making it one of the largest single classes in the codebase. Responsibilities include:
| Responsibility | Approx methods |
|---|---|
| Spawn/admission | ~15 (`spawn`, `resolveSpawnBudget`, `enforceSpawnBudget`, etc.) |
| Task lifecycle | ~20 (`assign`, `awaitTasks`, `awaitTasksAny`, `completeTask`, etc.) |
| Budget enforcement | ~10 (`setLeaderContextPressure`, `getRemainingBudgetUsd`, extension logic, etc.) |
| Collab sessions | ~8 (`collabDebug`, formatting, reporting) |
| Persistence | ~6 (manifest writing, state checkpoint, director state) |
| Shutdown/cleanup | ~8 (`shutdown`, `stop`, `terminate`, `terminateAll`, etc.) |
| Commands/intervention | ~10 (`hoop/haymaker`, intervention logic) |

### 9.4 `packages/core/src/coordination/director-tools.ts` (1,768 lines)

| Metric | Value |
|--------|-------|
| Top-level functions | 40 |
| Exported tool factories | **14** (`makeSpawnTool`, `makeAssignTool`, `makeAskTool`, etc.) |
| Helper functions | 26 |

Each tool factory (`makeXxxTool`) returns a complete `Tool` object with its own input validation, execution logic, and error handling. The file is a flat collection of 14 independent tool definitions. They could be split into focused files by tool domain:
- `spawn-tool.ts` — `makeSpawnTool`, `instantiateRosterConfig`
- `quality-gate-tool.ts` — `makeQualityGateTool`, assessment logic
- `assign-await-tool.ts` — `makeAssignTool`, `makeAwaitTasksTool`
- `ask-result-rollup.ts` — `makeAskTool`, `makeAskResultTool`, `makeRollUpTool`
- `fleet-control-tools.ts` — `makeFleetTool`, `makeTerminateTool`, `makeWorkCompleteTool`
- `collab-tool.ts` — `makeCollabDebugTool`
- `kanban-queue-tool.ts` — `makeKanbanQueueTool`

### 9.5 `packages/core/src/storage/session-store.ts` (1,736 lines)

| Metric | Value |
|--------|-------|
| Class | `DefaultSessionStore` (lines 153–1,735, 1,583 lines) |
| Methods | ~46 |
| Fields/properties | ~70 |
| Helper functions | 3 top-level |
| Private event-emit helpers | 4 (`emitRead`, `emitWrite`, `emitError`, `emitCasResult`) |

The `DefaultSessionStore` mixes concerns:
- **Reader**: `load()`, `listSessions()`, `getSessionSummary()`, `findSessionByFork()`, `findSessionByWorktree()`
- **Writer**: `create()`, `resume()`, `appendEvent()`, `flushEvents()`, `finalize()`
- **Recovery**: `recover()`, session repair logic
- **Checkpoint/CAS**: checkpoint-based concurrent-write detection
- **Metadata**: session metadata, index management, fork resolution

### 9.6 `packages/core/src/coordination/global-mailbox.ts` (1,632 lines)

| Metric | Value |
|--------|-------|
| Class | `GlobalMailbox` (lines 126–1,631, 1,506 lines) |
| Methods | ~61 |
| Fields/properties | ~48 |

Core mailbox implementation with inline persistence (file lock + JSONL read/write), agent registration, message query/ack/send, client management, and health checking — all in one class.

### 9.7 `packages/core/src/kernel/events.ts` (1,617 lines)

| Metric | Value |
|--------|-------|
| EventMap types | 26 event types (188 lines: 45–232) |
| EventBus class | 209 lines (1,249–1,458) |
| ScopedEventBus class | ~159 lines (1,458–1,617) |
| Other types/interfaces | 4 exported |
| Total exported symbols | 8 |

This file is well-structured: event type definitions (lines 1–1,244) are cleanly separated from the EventBus implementation (lines 1,245+). However, the EventMap having 188 inline lines for 26 events makes the file bulkier than needed. Extracting event payload types into a dedicated `events-types.ts` module would bring EventBus down to ~400 lines.

### 9.8 `packages/cli/src/fleet/host.ts` (2,068 lines)

| Metric | Value |
|--------|-------|
| Imports | 14 (8 external, 6 internal) |
| Exported symbols | 3 |
| Mixed concerns | Fleet host setup, subagent runner factory, worktree integration, director construction |

The file creates the FleetHost lazily and integrates: ACP subagent runners, config-based routing, worktree policy, supervisor setup, shadow agent, and status broadcasting.

---

## 10. Code Quality Anti-Patterns Found

### 10.1 Bare catch blocks
**96 `catch(() => {})`** patterns across the codebase where errors are silently swallowed. Most are in fire-and-forget persistence paths. While intentional in many cases, the prevalence indicates a missing fire-and-forget logging convention.

**Worst files**: `fleet-supervisor.ts` (7), `parallel-eternal-engine.ts` (6), `sdd-parallel-run.ts` (6), `session-store.ts` (12 catch blocks), `extension/registry.ts` (9).

### 10.2 Direct console calls bypassing Logger
**76 `console.log/warn/error/debug`** calls in `packages/core/src` production code. These bypass the structured `Logger` interface and cannot be captured by the observability layer.

**Worst files**: `config-loader.ts` (10), `skills-plugin.ts` (8), `extension/registry.ts` (6), `session-store.ts` (5), `global-mailbox.ts` (5).

### 10.3 Large state-bearing classes
| Class | Lines | Methods | Fields | Issue |
|-------|-------|---------|--------|-------|
| `Director` | 1,861 | 93 | 114 | God class: spawn + task + budget + collab + persist |
| `GlobalMailbox` | 1,506 | 61 | 48 | Persistence + agents + messages + health |
| `DefaultSessionStore` | 1,583 | 46 | 70 | Reader + writer + recovery + CAS |

### 10.4 AppProps interface sprawl
`tui/src/app.tsx` defines a **~400-line AppProps interface** with 40+ optional callback props. Every prop is a function that "when provided" does something — indicating missing abstractions.

### 10.5 Import fan-in on app.tsx
**103 import statements** (95 internal) importing **52 components + 16 hooks + dozens of utilities**. This makes the file's coupling graph extremely dense — any change to any component or hook requires checking this file.

### 10.6 Nested function anti-pattern in cli-main.ts
`function main()` at line 124 spans ~2,287 lines (to end of file). The entire CLI boot sequence, wiring, and dispatch lives in one closure with no decomposition into named phases.

---

## 11. Recommended Execution Order

### Phase 0 — Safety nets (immediately)
- [ ] Convert hotspot guardrails to ratcheting (backlog #007)
- [ ] Expand TUI integration coverage (backlog #005)
- [ ] Expand CLI boot/dispatch tests (backlog #006)

### Phase 1 — Quick wins (next 1–2 weeks)
1. **DONE** — Promote `parseNextSteps` to `@wrongstack/tools` (PR #242)
2. [ ] Add façade-module cap to hotspot guardrails (Decision E from modularity audit #018)
3. [ ] **NEW**: Split `cli/src/hq-server.ts` (2,631 lines) — extract WS handlers, HTTP routes, middleware
4. [ ] **NEW**: Split `cli/src/fleet/host.ts` (2,068 lines) — extract supervisor/registry/broadcast
5. [ ] Replace `console.*` calls with structured `Logger` — ~76 calls in core/src
6. [ ] Add explicit `logger` parameter to bare catch blocks

### Phase 2 — Big hotspot reductions (weeks 3–5)
7. [ ] Complete `tui/app.tsx` split (backlog #001) — move to panels/ feature architecture
8. [ ] Split `tui/app-reducer.ts` (backlog #002)
9. [ ] Split `core/coordination/director.ts` by responsibility (backlog #004)
10. [ ] Split `core/coordination/director-tools.ts` by tool family
11. [ ] Continue `cli-main.ts` decomposition (backlog #003)

### Phase 3 — Cross-package cleanup (weeks 5–7)
12. [ ] Break `core → mcp` cycle by promoting `MCPRegistry` to core (backlog #018 §3.1.1)
13. [ ] Move `@wrongstack/webui/server` to `@wrongstack/core/server` (backlog #018 Decision B)
14. [ ] Extract CLI services from slash-commands (backlog #009)
15. [ ] Reduce core export sprawl (backlog #011)

### Phase 4 — Governance & visibility (ongoing)
16. [ ] Add architecture health reporting (backlog #012)
17. [ ] Add automated drift detection (backlog #014)
18. [ ] Add package boundary visualization (backlog #017)

---

## 12. Effort Summary

| Phase | Items | PR Count | Estimated Effort |
|-------|-------|---------|-----------------|
| 0 — Safety nets | 3 backlog items | 3 PRs | 1 week |
| 1 — Quick wins | 6 items (3 new) | 6 PRs | 1 week |
| 2 — Hotspot reductions | 4 backlog + 1 new | 5 PRs | 3 weeks |
| 3 — Cross-package cleanup | 4 items | 4 PRs | 2 weeks |
| 4 — Governance | 3 items | 3 PRs | 2 weeks |
| **Total** | **20 items** | **21 PRs** | **~9 weeks** |

This is a 2-month program if executed sequentially. Phases 0 and 1 can run partially in parallel across multiple agents. **Note**: Phase 3 is blocked on the `core → mcp` cycle break (backlog #018, §3.1.1) — unblock it early.

---

## 13. Coordination Notes

- **Peer in-flight work**: 4 wiring/ modules already extracted from `cli-main.ts` — verify before extracting more to avoid conflicts
- **`hq-server.ts`** has uncommitted hunks per peer mailbox — needs resolution before Phase 1 split can cleanly rebase
- **Mailbox**: 3 memory leaks fixed (LargeAnswerStore, BrainDecisionLedger, KnowledgeGraph) — 2 low-severity remaining (CollabBus injection queue, DesignKitLoader caches)
- **Performance**: P0 issues in PromptUsageStore, MemoryBackend, ConfigStore — coordinate with the peer who ran the performance audit

---

## 14. Competitive Roadmap Re-audit Addendum

The implementation plans under `docs/competitive-roadmap-2026-2027/` were rechecked against the
live repository. Several roadmap items were more advanced than their headline status suggested,
while a smaller set of trust-boundary gaps remained actionable.

| Area | Re-audit result on 2026-07-12 | Remaining work |
|---|---|---|
| Release integrity / quality engineering | Hardened: release builds use the topological root build, tags must match the root version and originate from `main`, and manual dispatch is dry-run only. | Signing, provenance/attestation, and distribution-channel verification. |
| Live collaboration | Hardened: observer is the default role; privileged roles require a host authorizer; joins and message routing are bound to the active session. | Durable shared-state protocol and cross-process authorization model. |
| Standalone WebUI continuity | Hardened: session swaps now finalize the previous writer and rotate RecoveryLock, SessionRegistry/status tracking, HQ bridges, plan, and task identity. | Broader cross-surface resume/E2E coverage. |
| Permission wrappers | Original P0 claim was overstated. Database, deploy, API, raw execution, and sensitive-read wrappers already converge on capability-based non-YOLO confirmation; regression tests now lock this down. | Policy-authoring UX remains a separate P0 roadmap item. |
| First-party browser | Trust hardening complete for the identified gaps: uploads reject real-path escape; cleanup is per run; a loopback guard proxy pins validated DNS answers for HTTP/HTTPS/WebSocket traffic; private access is exact-origin only; screenshot/trace artifacts are sensitive, hashed, and receive non-content audit sidecars. | SecretVault-backed named inputs and dedicated WebUI/TUI artifact viewers/actions. |
| MCP authentication and legacy sampling | Standards correction: SEP-2577 deprecated sampling, so WrongStack retains unadvertised default-deny compatibility rather than building a new provider execution path. OAuth now has host-owned dynamic Bearer tokens, exact resource binding, bounded 401 handling, registry injection, negotiated protocol headers, DNS-pinned discovery, PKCE S256 authorization/callback validation, mandatory RFC 8707 resource indicators, code exchange, a bounded/file-locked SecretVault token store with single-flight automatic rotation wired into CLI and standalone WebUI, and `/mcp auth start|complete|status|logout` manual/headless authorization with memory-only expiring PKCE state. | Client-metadata/DCR identity selection, managed loopback callback listener, revocation/invalid-grant recovery, public auth events, token-file key-rotation migration, and dedicated WebUI/Desktop controls. |
| Brain evaluation and replay | First offline slice complete: versioned fixtures, runtime validation, no-action arbiter replay, exact-option/unsafe-allowance/escalation metrics, and deterministic regression cases. | Sanitized capture, frozen LLM metadata, comparison reports, adversarial suites, and release thresholds. |
| Policy authoring | First foundation slice complete: canonical JSON schema/validator, stable diagnostics, runtime reuse, and fail-closed malformed-policy behavior including YOLO. | Matched-rule explanation, simulator/linting, audited atomic edits, migrations, and WebUI/TUI editors. |

Highest-value remaining trust work is therefore: finish governed MCP authorization identity/UX,
revocation, and observable state; then continue roadmap item 16 and verify its status drift before
starting lower-priority ecosystem work.

# Modularity Assessment — WrongStack Monorepo

**Date:** 2026-08-22
**Scope:** all 33 workspace packages (`packages/*`, `apps/*`; `website/` excluded)
**Baseline:** `docs/reports/architecture-health-current.json` (generated 2026-08-22T08:40:48Z) + source-level import analysis
**Method:** static analysis of import graphs (workspace edges, module edges, type-module SCCs), file/line inventories, and targeted source reads of every hotspot. No code was changed.

---

## Executive Summary

WrongStack's architecture discipline is genuinely strong for its size: **0 runtime module cycles, 0 non-slash cross-package imports, a working hotspot ratchet, and an exceptions registry with owners and review dates**. The remaining modularity debt clusters into five themes:

1. **Dependency layering inversion** — `core` is not the leaf. The real chain is `persistence ← kanban ← core ← everything`, and the `core → kanban` edge forces utility duplication and awkward re-exports.
2. **Misplaced shared contracts** — the wire protocol shared by two frontend packages lives inside `webui-server`, and 7 of 16 type-module cycles are caused by contract types homed inside implementation modules.
3. **Composition-root bloat** — `cli-main.ts` (952 lines), `webui-server`'s flat 158-file `server/` directory, and a 33-member type cycle in the CLI caused by importing types from a lazy-loader barrel.
4. **Extractable core subsystems** — `goal/`, `hq/`, `chronicle/`, `skills/` are already clean areas with external demand and near-zero internal importers.
5. **Ratchet drift** — three hotspots have outgrown their pinned baselines; one new hotspot is entirely unlisted.

A prioritized remediation roadmap with effort/impact estimates is in [§8](#8-prioritized-roadmap).

---

## 1. System Snapshot

| Metric | Value |
|---|---|
| Packages | 33 (31 in `packages/`, 2 apps) |
| Source files | 3,289 |
| Test files | 2,863 |
| Source lines | ~786,364 |
| Workspace dependency edges | 106 |
| Module edges | 10,161 |
| Runtime module cycles | **0** |
| Type-module cycles | 16 (all registered exceptions; next review 2026-10-01) |
| Test-only exports | 810 (pinned in `architecture/test-only-exports.json`) |

**Largest packages by source files:** `core` 756 · `webui` 462 · `cli` 457 · `tui` 332 · `tools` 187 · `webui-server` 190 · `sage` 103 · `plugins` 86 · `kanban` 86 · `simpleui` 93

**Widest fan-in:** `cli` (24 workspace deps — intended composition root), `webui-server` (11), `tui` (6), `webui` (6).

---

## 2. Package-Level Findings

### 2.1 `core → kanban` breaks the leaf principle (highest structural payoff)

`@wrongstack/core` is documented as the kernel that surfaces compose, but it declares `@wrongstack/kanban` (and `@wrongstack/persistence`) as dependencies. Actual layering:

```
persistence ← kanban ← core ← { 30 packages }
```

Direct kanban usage inside core (runtime, not type-only):

| File | Evidence |
|---|---|
| `core/src/storage/goal-kanban.ts:17` | imports `addTask, createBoard, getBoard, listBoards, removeBoard` |
| `core/src/storage/goal-coordination.ts:1` | imports `updateTask` |
| `core/src/security/kanban-boundary.ts:11` | direct kanban calls |
| `core/src/coordination/director-kanban-queue-helpers.ts:1`, `director-tools.ts:11` | director queue logic calls kanban directly |
| `core/src/types/blocks.ts:59-62` | inline `import('@wrongstack/kanban')` types |
| `core/src/security/file-permissions.ts:2-5` | re-exports from persistence with a comment acknowledging the awkwardness |

**Consequences:** anything needed by both `core` and `kanban` must be duplicated or pushed into `persistence` — this single edge is the root cause of most duplication in [§5](#5-duplication-across-packages). It also means `persistence` must stay dependency-free, limiting where shared primitives can live.

**Fix direction:** define board-store / kanban-boundary **port interfaces in core**, implement them in `kanban`, wire at the `cli` composition root (same pattern as `TOKENS.*` injection already used elsewhere). High effort, highest structural payoff.

### 2.2 `webui → webui-server`: a shared protocol trapped inside a server package

Both frontend packages import the **runtime** wire-protocol helpers from the backend package:

- `webui/src/lib/ws-client.ts:1-14` — `decodeProtocolMessage`, `negotiateProtocol`, connection-FSM helpers
- `simpleui/src/lib/message-handler.ts:19`, `ws.ts:12`, `types.ts:1`

The entire import surface is the `./protocol` subpath (`webui-server/src/protocol/`, 16 files: registry, decoder, projections, connection-FSM, message catalogs). It is browser-safe — it imports only core types and internal files — yet both frontends must depend on the full server package, transitively pulling its **11 workspace deps + `ws`** into frontend dependency graphs.

**Fix:** extract `@wrongstack/webui-protocol` as a leaf package. Low risk, immediate graph win, no behavior change.

### 2.3 `webui-server` is a second composition root

11 workspace dependencies; import volume: `core/types` ×93, `core/utils` ×55, `core/agent` ×35, `tools` ×22, `kanban` ×18, `techstack` ×12, `providers` ×10. Its `@wrongstack/webui` references are only runtime asset serving (`frontend-static-serve.ts`), not code imports.

**Fix direction:** move the techstack / requirement-intake / sdd / sage / mcp tool wrappers behind a registration interface so the server depends on `core` + a registry rather than 11 feature packages. Medium effort; big rebuild-graph win.

### 2.4 Extractable core subsystems (ranked)

| Area | Files | Internal importers | External demand (`@wrongstack/core/<sub>`) | Verdict |
|---|---|---|---|---|
| `goal/` | 14 | **0** | 35 imports (cli, tui, webui-server) | **Cleanest cut in the repo.** Travel companions: `storage/goal-store.ts`, `storage/goal-coordination.ts`, `storage/completed-work-checkpoint.ts`, `cli/goal-host.ts` (930 lines) |
| `hq/` | 43 | 1 (`coordination/remote-mailbox.ts:2`) | 154 imports + own frontend `webui-hq` + `./hq/protocol` already a separate subpath | Strong candidate. Blockers: hq↔coordination edge; internal SCC `ARCH-CYCLE-TYPE-13` (follow the existing `hq/protocol/envelope.ts` leaf precedent) |
| `chronicle/` | 35 | 4 | cli, tui, webui-server (+ `webui/ChronicleDashboard.tsx`) | Good candidate; `chronicle/query.ts` (843 lines) is itself a hotspot |
| `skills/` | 11 | 13 (plugins:6, execution:4, core:3) | 6 packages; already a subpath with asset dirs; registry owner assigned | Good candidate |
| `session-catalog/` | 9 | 4 (all from storage) | 10 | Needs the storage→session-catalog edge inverted or moved |

`coordination/` (164 files) and `storage/` (87 files) are the long-term wins but need pre-work (see [§4](#4-type-module-cycles-root-causes)).

### 2.5 `tui` — asymmetric business-logic coupling

- `sdd` usage is **type-only** (clean): `SddBoardSnapshot`, `SddRunControl`, etc.
- `sage` usage is **runtime business logic in the UI**: `memory-slash*.ts` call `getSageSurface()` (the full Sage business API), `connections-health.ts:19` constructs `SageProjectServerConnection` (an IPC client) directly, `history-entry.ts:7` and `hooks/use-provider-event-bridge.ts:3` import sage tuning constants.

**Fix:** route sage access through `MemoryPort`/projection interfaces; move tuning constants into a shared contract. Low urgency.

### 2.6 Clean patterns worth preserving (no action)

- `providers`, `mcp`, `tools` are clean siblings — zero cross-imports among them.
- `cli`'s 24-dep fan-in is the *intended* composition root; UI dispatch is via dynamic import (`boot/dispatch-tui.ts`, `boot/short-circuit-hq.ts`); static `@wrongstack/tui` imports are type-only.
- Memory stack chain `core ← sage ← vector-memory ← runtime` is sound; the heavy `@huggingface/transformers` is an optionalDependency behind a dynamic import.
- Root-import ratchet holds: only 6 files reference bare `@wrongstack/core` (2 tests, 3 READMEs, 1 browser shim) vs. `maxRootImportFiles: 0` policy — external demand is already on subpaths (`/types` ×1147, `/utils` ×605, `/agent` ×319, `/coordination` ×258, `/kernel` ×252).

---

## 3. The CLI Type Cycle (33 members) — cheapest high-value fix

**Root cause confirmed with import evidence:** `subcommands/index.ts` is a lazy-loader registry (dynamic `import()` of every handler — a deliberate and good design for boot-time heap). But **27 handler files** import their types back from the barrel:

```ts
import type { SubcommandDeps, SubcommandHandler } from '../index.js'
```

plus `acp-server-agent.ts:33` and `mcp-serve.ts:35` (`from './subcommands/index.js'`). In the TypeScript module graph, dynamic imports are real edges, so this closes a cycle through every handler simultaneously. `handlers/hq.ts:39-40` additionally imports `HqServerHandle` from `hq-server.ts`, dragging the ~20-module HQ cluster into the same SCC.

**The kicker:** `SubcommandDeps` actually lives in `subcommands/contracts.ts` (30 lines, no local imports except leaves). The barrel merely re-exports it.

**Fix (mechanical, type-only, zero runtime impact):**

1. Repoint 29 type imports: `from '../index.js'` → `from '../contracts.js'` (27 handlers + `acp-server-agent.ts` + `mcp-serve.ts`).
2. Move `HqServerHandle` out of `hq-server.ts` into `hq-server/handle-types.ts` (or `hq-server/types.ts`) so `handlers/hq.ts` never pulls the server implementation for a type.

This should collapse the entire 33-member SCC in one PR.

---

## 4. Type-Module Cycles — Root Causes

16 registered exceptions (`architecture/exceptions.json`, owners assigned, review 2026-10-01). Seven small ones were examined; every one is the same two patterns:

**Pattern A — contract types homed inside an implementation module:**

| Exception | Package | Evidence |
|---|---|---|
| ARCH-CYCLE-TYPE-17 | mcp | `client.ts` implements the client **and** homes the shared contracts (`ConnectionState` L52, `MCPTool` L62, `ToolCallResult` L68); `tool-schema.ts:1`, `transport-base.ts:10`, `transport-sse.ts:3`, `transport-streamable.ts:1` import them back |
| ARCH-CYCLE-TYPE-02 | acp | `agents.catalog.ts:38` imports `ACPAgentDescriptor` from `ensemble-registry.js`; `ensemble-registry.ts:19` imports the `AGENTS_CATALOG` value back |
| ARCH-CYCLE-TYPE-23 | webui | `official-servers.ts:1` imports `MCPServerConfig` from the 904-line `MCPSection.tsx` — a data catalog depending on its consumer component |
| ARCH-CYCLE-TYPE-28 | tools | `index-service.ts:30` imports worker IPC types from `worker-protocol.js`; `worker-protocol.ts:9` imports call-result types back ("service type re-exports") |
| ARCH-CYCLE-TYPE-18 | plug-lsp | `registry.ts:5` ↔ `document-tracker.ts:7` mutual type-only interface references |

**Pattern B — facade/barrel re-exporting a module that imports types back:**

| Exception | Package | Evidence |
|---|---|---|
| ARCH-CYCLE-TYPE-26 | kanban | `types.ts:969` does `export * from './types-operations.js'` while `types-operations.ts:1-38` imports 37 types back from `types.ts` |
| ARCH-CYCLE-TYPE-24 | techstack | `adapters/interface.ts:18-25` re-exports runtime helpers (`fileExists`, `workspaceRoot`, …) from `./paths.js`; `paths.ts:22` imports `InventoryOptions` back |

**Fix:** extract a leaf `contracts.ts` per package (mcp: `MCPTool`/`ConnectionState`/`ToolCallResult`/`JsonRpcResponse`; acp: `ACPAgentDescriptor`; move `MCPServerConfig` out of the component; drop the helper re-exports in techstack; kill the `export *` facade in kanban). Precedent proving the approach: `hq/protocol/envelope.ts` extraction shrank ARCH-CYCLE-TYPE-13 (2026-07-31).

**Large core cycles (pre-work for coordination/storage extraction):**

- `ARCH-CYCLE-TYPE-11/12` (13-file SCC): 7 files in `types/` (`compactor, error-handler, permission, plugin, provider-runner, slash-command, tool`) import `Context` from `core/context.ts` (963 lines). Extracting `Context` into `types/` kills both.
- `ARCH-CYCLE-TYPE-14`: the root barrel `core/src/index.ts` (1020 lines, 154 exports, ~598 symbols, 13 `export *`) is itself a cycle member with builtin plugins and `tools/mcp-*`.
- `ARCH-CYCLE-TYPE-29` (24 files): `types/autonomy` + `coordination/agents/*` + `execution/parallel-eternal-engine` tied at the type level.
- `storage/` imports `kernel` EventBus in 15+ files — injecting the bus would cut ~20 edges.

---

## 5. Duplication Across Packages

| Utility | Copies | Impact |
|---|---|---|
| ReDoS-safe regex compiler | `core/src/utils/regex-guard.ts` · `tools/src/_regex.ts` · `kanban/src/verification/safe-regex.ts` — **already drifted once** (core's copy had 2/5 heuristics, 512-char cap, no subject cap); pinned by `tools/tests/regex-guard-parity.test.ts` | The parity test exists *because* copies drift. Delete the triplication instead of pinning it |
| `slugify` | `core/src/utils/slug.ts` (canonical) · private copy in `core/src/utils/wstack-paths.ts:203` (documented as intentionally distinct) · `kanban/src/manager/basic-helpers.ts:13` (no cap/fallback) | kanban **cannot** import core's copy — forced by the `core → kanban` edge |
| `nowIso()` | 6 copies: kanban (exported + 2 private), cli, plugins, sage | Trivial to consolidate |
| Token estimation | `core/src/utils/token-estimate.ts` (3.5 chars/token + EWM calibration, 540 lines) vs `webui-server/src/server/token-estimator.ts` (4 chars/token, 134 lines) | **Different constants ⇒ CLI and WebUI show different context-window usage (~14% divergence) for the same session** |
| Shared utils placement | `core/src/utils` = 67 files consumed by 503 runtime files repo-wide | No dependency-leaf primitives package exists below kanban/tools |

**Fix:** create a leaf primitives package (at persistence's level or below) for regex-guard, slugify, `nowIso`, socket-path, atomic-write. Separately, make webui-server's token estimator delegate to core's calibrated implementation (already a declared dep).

---

## 6. File-Level Hotspots — Mixed Responsibilities

All exceed the 800-line ratchet threshold. Line counts from working tree, 2026-08-22.

| File | Lines | Mixed concerns | Proposed split |
|---|---|---|---|
| `core/storage/file-session-writer.ts` | 1023 | session serialization, FIFO write chain, audit levels, rotation | **Not in ratchet at all** (drift). Split write-chain plumbing from event-shaping |
| `core/storage/session-store.ts` | 1021 | store CRUD, sidecar summaries, secret scrubbing, registry guard; **38 relative imports** | Inject EventBus instead of importing kernel; move reader/query logic out |
| `webui-server/server/collaboration-ws-handler.ts` | 996 | one class: transport lifecycle, membership/authz, annotations domain, event mirror + replay, controller/pause/injection domains, periodic broadcast — grew one phase at a time (comments say Phase 1–4); every `handleX` repeats the same 5-step guard boilerplate | Keep ~150-line `CollabSessionRegistry`; extract `collab/{annotations,controller,injection,replay,mirror}.ts` as `CollabFeature { matches, handle }` dispatch |
| `cli/cli-main.ts` | 952 | `runInteractive()` = one 890-line function sequencing 20+ phases, threading mutable state via closures; symptom: 70- and 95-field literal argument objects to `setupCliSlashCommands` / `runCliExecution` | `wiring/phases/` (memory-vector, session, provider-runtime, fleet-brain, command-host, slash-registration) + a typed `RuntimeState` object replacing closure threading |
| `core/coordination/delegate-tool.ts` | 968 | dispatch ladder + result folding + transcript recovery | Split result-recovery from tool surface |
| `core/core/context.ts` | 963 | live run state + RunEnv + session writer wiring | **Extract `Context` type into `types/`** — kills ARCH-CYCLE-TYPE-11/12 |
| `core/execution/brain-runtime.ts` | 956 | brain tiers wiring + policy evaluation | Split tier composition from policy rules |
| `webui-server/server/context-editor.ts` | 981 | editor protocol + diff application + validation | Split per concern |
| `webui-server/server/kanban-routes.ts` | 977 | route family + board projections + mutations | Split routes from projections |
| `webui-server/server/provider-handlers.ts` | 827 | 20-method grab-bag: catalog, model resolution, default-model policy, **API-key CRUD**, **provider CRUD**, allowlist mutations, health probing, **full OAuth login state machine** | `provider/{catalog,keys,crud,custom-models,probe,oauth}.ts` sharing one `load → mutate → save → broadcast` helper |
| `telegram/bot.ts` | 854 | HTTP client + long-polling loop + **distributed leader election** + message queue/allowlist security + **human-approval workflow** | `telegram-api.ts` / `poller.ts` (+lock) / `approval-flow.ts`; class composes them |
| `security-scanner/orchestrator.ts` | 808 | LLM retry wrapper, 3-phase pipeline, skill generation, batch scanning, report synthesis, report file I/O, project-context gathering, module singleton | `llm-client.ts` / `skill-generator.ts` / `batch-scanner.ts` / `report-writer.ts`; orchestrator keeps the pipeline |
| `cli/hq-server.ts` | 673 | one 526-line Promise: auth hot-reload watcher, session/login throttling timers, dead-mailbox reaper, alert engine, snapshot broadcaster, client-TTL loop, router assembly, bind-retry, shutdown | Extract `auth-reload-watcher.ts`, `session-reaper.ts`, `dead-mailbox-reaper.ts`; a `HqRuntimeState` object for the ~12 closure-captured Maps/Sets |

**webui-server `server/` directory:** 173 files nearly flat (158 top-level). A route-family dispatcher exists (`route-family-dispatcher.ts`, 24 families) but dispatch is a **sequential 28-await `if` chain**, with 4 families (`memory`, `content`, `chronicle`, `introspection`) special-cased. Convert to a prefix-`Map` registry built from the table; group files into `routes/`, `domains/`, `boot/`.

**Secondary CLI splits:** `subcommands/handlers/hq.ts` (724), `providers-models.ts` (748), `mailbox-serve.ts` (453) are each nested subcommand trees in one file. The 5 `per-subcommand-help*.ts` files (~1,460 lines) duplicate knowledge that self-registering handler descriptors would unify.

---

## 7. Internal Coupling Surprises inside `core`

These are direction violations the area registry doesn't currently flag:

| Violation | Evidence | Why it matters |
|---|---|---|
| `types/` → feature area | `types/plugin.ts:2` imports `Notifier` from `notifications/` | Contract foundation depends on a feature |
| `types/` → coordination | `types/config/skills-fleet-brain.ts` imports brain heuristics/rules; `types/multi-agent.ts` imports `subagent-budget`; `types/system-prompt.ts` imports mailbox types | The most-imported area (×1147) is not a leaf |
| `utils/` → `core/` at runtime | `utils/context-breakdown.ts` imports `core/agent-response.js` + `system-prompt-builder.js` (not type-only) | `utils` is consumed by 309 internal statements — pollutes the whole graph |
| `plugin/` (contract) → `plugins/` (implementation) | 12 imports | Contract area depending on its own consumers |
| `storage/` → `coordination/` | `storage/goal-coordination.ts:2` imports `BrainArbiter`; `goal-store.ts` hosts orchestration logic | Persistence files hosting goal/brain orchestration |
| `design/index.ts` → `execution/` | 6 imports | Product facade reaching into the runtime |
| `defaults/` barrel | 404 lines, 68 outbound imports (execution ×24, coordination ×17, storage ×14), **zero consumers** | Registry already says "runtime-or-retire" — delete it |
| 9 stray root-level files | `agent-status-tracker.ts` (712) + helpers + `fleet-notifier.ts` (coordination-flavored); `session-registry*.ts` (~1,125 total, storage-flavored); `mailbox-attach.ts`; `boot.ts` (756) | Root of `src/` is itself an unclassified area |
| `middleware/` area = 1 file | `collab-pause.ts`, imported once by coordination | Fold into coordination |
| `kernel/` back-edges | kernel → core ×5, kernel → coordination ×4 | The "primitive" has edges into the domains it serves |

---

## 8. Prioritized Roadmap

Impact (I) and effort (E) rated High/Med/Low. Items 1–3 are safe, mechanical, and unlock the rest.

| # | Action | I | E | Notes |
|---|---|---|---|---|
| 1 | **Break the 33-member CLI cycle**: repoint 29 type imports to `subcommands/contracts.js`; move `HqServerHandle` to a leaf types module | H | L | Type-only; one PR; kills the repo's largest SCC |
| 2 | **Triage ratchet drift**: update `architecture/hotspots.json` for `session-store.ts` (821→1021), add `file-session-writer.ts` (1023), `cli-main.ts` (941→952); resolve the 2 test-only exports in `tui-session-stub-enrich.ts` | M | L | The gate is already failing per the health report errors[] |
| 3 | **Extract `@wrongstack/webui-protocol`** from `webui-server/src/protocol/` | H | L | Removes frontend→server edges for webui + simpleui; browser-safe today |
| 4 | **Leaf `contracts.ts` for the 7 small cycles** (mcp, acp, plug-lsp, techstack, tools, kanban, webui MCPSection) | M | L | Clears ~7 of 16 exceptions mechanically |
| 5 | **Leaf primitives package** (regex-guard, slugify, `nowIso`, atomic-write, socket-path) + **unify token estimation** (webui-server delegates to core) | M | M | Deletes the 3× regex triplication the parity test pins; fixes CLI/WebUI divergence |
| 6 | **Split hotspots**: `collaboration-ws-handler.ts` → `collab/` features; `provider-handlers.ts` → `provider/` domains; `telegram/bot.ts` → api/poller/approval; `security-scanner/orchestrator.ts` → 4 modules | H | M | Each is an independent PR; tests already exist around all four |
| 7 | **`cli-main.ts` → `wiring/phases/` + typed `RuntimeState`**; prefix-Map route registry in webui-server; hq-server reaper/watcher extraction | H | M | Collapses the 70/95-field argument literals |
| 8 | **Extract `@wrongstack/goal`** (0 internal importers) with its storage companions | H | M | First real core extraction; validates the pattern for hq/chronicle |
| 9 | **Extract `@wrongstack/hq`** and `@wrongstack/chronicle`** | H | M | Requires breaking the single hq↔coordination edge + ARCH-CYCLE-TYPE-13 |
| 10 | **Core internal cuts**: extract `Context` into `types/` (kills ARCH-CYCLE-TYPE-11/12); inject EventBus into storage (cuts ~20 kernel edges); delete `defaults/`; fold `middleware/`; relocate the 9 stray root files | H | H | Pre-work for coordination/storage extraction; aligns with registry tasks R1/D2/P1 |
| 11 | **Break `core → kanban`** via port interfaces + composition-root wiring | H | H | Root cause of layering inversion and most duplication |
| 12 | **Slim `webui-server` fan-in** behind a registration interface; route tui's sage usage through `MemoryPort` | M | M | Rebuild-graph and boundary wins |

### Suggested sequencing

```
Week 1–2   : items 1–4  (mechanical, no behavior change, unblocks gates)
Week 3–4   : items 5–7  (hotspot splits, primitives)
Month 2    : items 8–9  (goal, hq, chronicle extractions)
Month 2–3  : item 10    (core internal cuts)
Month 3+   : items 11–12 (structural; coordinate with registry canonical tasks)
```

---

## Appendix A — Evidence Index

- Baseline: `docs/reports/architecture-health-current.json`
- Ratchets: `architecture/{registry,exceptions,hotspots,core-api-policy,core-public-api-usage,core-public-api-snapshot,test-only-exports,test-skip-budget,coverage-zero-baseline}.json`
- Import counts are statement counts (type-only and runtime mixed) from static analysis of the working tree on 2026-08-22.
- `core/storage/session-store.ts` and `core/storage/session-write-buffer.ts` had uncommitted modifications at analysis time; committed ratchet numbers differ slightly.
- All file:line references verified against the working tree at analysis time.

## Appendix B — Core Area Inventory

756 files across 31 registered areas. Largest by file count: `coordination` 164, `storage` 87, `utils` 67, `types` 66, `execution` 59, `core` 44, `hq` 43, `chronicle` 35, `plugins` 21, `tools`/`security` 19, `kernel` 18, `goal` 14.

Import demand for core subpaths repo-wide: `/types` ×1147 · `/utils` ×605 · `/agent` ×319 · `/coordination` ×258 · `/kernel` ×252 · `/storage` ×154 · `/hq` ×154 · `/skills` ×10 · `/goal` ×35 — confirming **types + utils are the real "core of core"** consumed by ~30 packages, while `hq`, `chronicle`, `goal`, `skills` are peripheral features suitable for extraction.

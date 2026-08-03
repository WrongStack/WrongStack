# WrongStack — System Prompts, Feature Surface & Architecture Refactor Report

**Date:** 2026-07-13 · **Scope:** 20 packages (`packages/*`), ~411k LOC · **Method:** 5 parallel exploration agents (core / cli / tui / webui trio / feature packages) + manual analysis of the system-prompt and feature surface.

> This report builds on `wrongstack-report-2026-07-12.md` (refactor-only) by adding two dimensions: **(1) system-prompt & instruction architecture**, **(2) architectures that should be merged or split**. Refactor hotspots are cross-validated against yesterday's report where they overlap.
> A companion actionable backlog lives in `REFACTOR.md` (tickets R1–R17).

---

## Executive Summary

WrongStack is a mature, disciplined codebase: **layer boundaries are intact** (core depends on no product surface), **dead-code hygiene is excellent** (~110 TODO/FIXME/HACK markers repo-wide, mostly test helpers or template strings — there is **no** "unwired stub" epidemic). The technical debt concentrates in two forms:

1. **God-files (size debt):** modules that outgrew a single responsibility — `tui/app.tsx` (7,589), `kanban/manager.ts` (2,771), `cli/hq-dashboard-html.ts` (2,304), `core/coordination/director.ts` (2,271), `cli/cli-main.ts` (2,414), `webui/types.ts` (2,268).
2. **Parallel implementations (drift debt):** the same job done by two hand-synced copies — a **dual WebUI/HQ server stack**, a **dual `MemoryStore`** (core ↔ sage), **twin "eternal" engines**, **twin `Mailbox`** impls, and an HQ dashboard maintained as a **hand-written React clone**.

Separately, the **system-prompt architecture** (116 instruction files, 58 agent personas, 20+ modes) is soundly layered but carries a few near-duplicate prompts and a naming collision.

**The 6 highest-value moves:** ① unify the dual server stack · ② extract `hq-dashboard-html.ts` into real assets · ③ pull `handleKey`/`useAgentRun` out of `app.tsx` · ④ split `director.ts` · ⑤ reconcile the core ↔ sage `MemoryStore` pair · ⑥ de-collide the "Brain" naming and the coordinator triad.

---

## PART I — System-Prompt & Instruction Architecture

### I.1 Layered prompt assembly

`DefaultSystemPromptBuilder` (`packages/core/src/core/system-prompt-builder.ts`, 1,234 lines) composes the system prompt from layers: **Identity → Tool usage → Environment → Memory/Skills → Mode → Plan → Contributors**. The environment block is cached per project root; memory/mode/plan blocks are marked ephemeral. This design is clean and override-friendly.

The actual prompt text lives not in TypeScript but in **override-able `.md` files** (`packages/core/instructions/`), resolved in 3 layers: bundled → `~/.wrongstack/instructions` (global) → `<project>/.wrongstack/instructions` (project). A strong structure that lets prompt wording be customized without touching code.

### I.2 Instruction corpus — 116 files / 2,641 lines

| Category | Count | Note |
|---|---|---|
| `agents/*.md` (personas) | **58** | architect, backend, frontend, security-reviewer, refactor, critic, bug-hunter, browser, shadow-agent… ACP bridge personas (acp-cline/copilot/gemini/goose/openhands) are 3 lines each. |
| `modes/*.md` | **20+** | `-lite` + full variant per mode (audit/debug/plan/refactor/research/review/test); `brief-system`/`teach-system` separate. |
| `llm/*.md` (sub-task prompts) | 13 | agent-router, autonomy-brain, memory-consolidator, prompt-enhancer, two compactor-summarizers, chimera-review… |
| `sections/tool/*.md` | 12 | **compact + full** pairs for delegation/mailbox/mcp/context-management (bound to the token-saving tier). |
| `coordination/`, `autonomy/`, `goal/`, `sdd/`, `security-scanner/`, `cli/` | ~13 | director-preamble, subagent-baseline, goal-preamble, phase-planner… |

### I.3 Prompt-layer findings

- **🟡 Near-duplicate prompts.** `llm/intelligent-compactor-summarizer.md` and `llm/selective-compactor-summarizer.md` are almost the same text ("You are a context summarizer…"). They collapse into one parameterized template. Similarly the `sections/tool/*-compact.md` fragments are mostly 3 lines — deliberate token-saving variants (fine), but as the catalog grows, keeping each compact/full pair in sync is manual work.
- **🟢 The "1-line stub" alarm is a false positive.** `security-scanner/json-system.md`, `report-system.md`, `intelligent-compactor-summarizer.md` are one line but **complete and intentional** short prompts — not unfinished.
- **🟡 Persona template repetition.** Most of the 58 agent files are 22–25 lines sharing one skeleton (role / scope / output). A template-based generator or a shared "persona base + delta" (like the `modes/` `-lite`/full delta model) would cut the repetition.
- **🟢 Strengths:** the "Tool output trust boundary" and 4-phase task loop (Plan→Review→Execute→Review) in `system.md` are crisp; instruction files carry test-pinned anchor strings (see memory: `instruction-files-map-and-anchors`).

---

## PART II — Feature Surface Map

This is a surface that earns the "extremely comprehensive autonomous coding assistant" label:

- **20 packages:** kernel (core), providers, tools (~50 builtin tools, 3-tier token budget), mcp, plug-lsp, acp, cli, tui, runtime, kanban, sdd, security-scanner, sage, telegram, webui, webui-server, webui-hq, plugins (**63 first-party plugins**), bench. Plus `apps/{wrongstack,desktop}`.
- **83 slash commands** + 28 subcommand handlers — assembled declaratively into a single flat `SlashCommand[]` (clean registration pattern).
- **Surfaces:** CLI/REPL, TUI (Ink/React), WebUI (Vite/React), SimpleUI (lightweight browser chat), Desktop (Electron), HQ Command Center (port 3499, the only deliberately cross-machine server).
- **Multi-agent orchestration:** Director (leader-with-tools), Fleet (task queue + budget + supervisor), Brain (policy→LLM→human decision gate), TaskAuctioneer (task marketplace), Goal, SDD (spec-driven), CollabSession (bug-hunter→refactor-planner→critic).
- **Infrastructure:** cross-surface mailbox, SessionRegistry, sage (graph + verification + hygiene), codebase-index (worker thread + FTS5), OAuth login engine (ChatGPT/Claude/Copilot), MCP registry, LSP bridge.

---

## PART III — Refactor Hotspots (God-Files)

Priority: 🔴 High · 🟡 Medium · 🟢 Low. All line references verified during exploration.

### core (`packages/core`)

| # | File | Lines | Problem | Recommendation |
|---|---|---|---|---|
| 🔴 | `coordination/director.ts` | 2,271 | Single `Director` class, **51 methods**, ~400-line constructor. Leader budget + subagent lifecycle + task dispatch + BTW notes + collab-debug + manifest persistence + checkpoint + prompt assembly tangled. `director-construction.ts` (345) is a half-finished extraction. | Extract 4 collaborators: `DirectorTaskDispatcher`, `SubagentLifecycleManager`, `DirectorCheckpointStore`, `DirectorCollabController`. |
| 🔴 | `coordination/director-tools.ts` | 1,767 | ~20 `makeXTool` factories + thick normalize/parse/assess helpers. Quality-gate (~250 lines) and kanban (~180 lines) are self-contained subsystems. | `director-tools/{spawn,quality-gate,kanban,fleet,collab}.ts`. |
| 🔴 | `kernel/events.ts` | 1,616 | **Single `EventMap` interface with 113 keys** (`brain.*`+`session.*`+`fleet.*`+`hq.*`+`worktree.*` all jammed together) + EventBus + ScopedEventBus + pattern matcher. | Split `EventMap` per domain (`BrainEventMap`…) via intersection type; keep EventBus in place. |
| 🟡 | `storage/session-store.ts` | 1,745 | load/index cache + shard-manifest + fork-inheritance + snapshot replay mixed. | Extract `SessionIndexCache` (neighbors already partially split). |
| 🟡 | `types/config.ts` | 1,487 | ~50 exported interfaces, flat. Merge-conflict magnet. | Split by domain: `config/{brain,fleet,tools}.ts`. |
| 🟡 | `hq/protocol.ts` | 1,506 | Almost entirely `Hq*` type declarations. | `hq/protocol/{session,mailbox,fleet,brain}.ts`. |
| 🟢 | `multi-agent-coordinator.ts` (1,271), `storage/config-loader.ts` (1,259), `system-prompt-builder.ts` (1,234), `execution/tool-executor.ts` (1,212), `goal/phase-orchestrator.ts` (1,103) | — | Secondary priority. | — |

### cli (`packages/cli`)

| # | File | Lines | Problem | Recommendation |
|---|---|---|---|---|
| 🔴 | `hq-dashboard-html.ts` | 2,304 | **HTML-in-TS mega-literal.** Under a "NO backticks, NO `${`" constraint via `React.createElement`+string concat; every browser-side backslash must be **manually doubled** — a standing footgun with no compiler check. | Move to a real `.html`/`.css`/`.mjs` asset trio (built by the esbuild/tsup step). Highest-value single refactor in the package. |
| 🔴 | `cli-main.ts` | 2,414 | Single `main()`; `597–1923` is **~1,300 uninterrupted lines** of wiring (Brain→BrainMonitor→shadow→MultiAgentHost→tools), 69 `await`s. | Extract `wireBrainAndShadow()`, `wireFleetHost()`, `wireProviderRuntime()` into `wiring/` (continue the Issue #29 effort). |
| 🔴 | `fleet/host.ts` | 2,067 | `MultiAgentHost` god-class, 30+ methods / 6 responsibilities: director lifecycle, shadow-agent, subagent factory+tool-registry, ACP runner, fleet supervision, usage/status. `makeSubagentFactory` alone ~290 lines. | Extract `ShadowAgentController` (753–832) + `SubagentFactoryBuilder` (941–1590). |
| 🟡 | `hq-server.ts` | 1,622 | HTTP routing + transcript parsing + runtime-marker file I/O + LAN endpoint printing. `hq-server/` subdir already exists. | Move remaining pieces into the existing `hq-server/`. |
| 🟡 | `repl.ts` (1,512), `slash-commands/sdd.ts` (1,305), `slash-commands/kanban.ts` (1,248), `execution.ts` (1,109), `plugin-management.ts` (1,100) | — | Secondary. | — |

### tui (`packages/tui`) — heaviest single file

| # | File | Lines | Problem | Recommendation |
|---|---|---|---|---|
| 🔴 | `app.tsx` | 7,589 | `App()` component alone ~**6,750 lines**, ~90 props, body holds 22 `useState`/67 `useEffect`/54 `useRef`/33 `useCallback`. `handleKey` alone ~2,150 lines (216 dispatch) — the whole keyboard state machine. Render has **20 near-identical overlay ternaries**. | Extract `useKeyRouter`/pure `reduceKey` (highest leverage); extract `useAgentRun`; group ~90 props into typed context; collapse 20 overlays into a data-driven `<OverlayStack>`. |
| 🔴 | `app-state.ts` + `app-reducer.ts` | 1,430 + 2,440 | `State` = **84 flat fields**; `Action` = **245 variants**; reducer = **253-case switch** (only `fleet` slice delegated). Pickers repeat `open/close/back/move/select` families. | Per-domain sub-reducers (existing `reducers/fleet.ts` model); generic `PickerState<T>`. |
| 🟡 | `components/history/utils.tsx` (2,160), `status-bar.tsx` (1,663), `settings-picker.tsx` (1,575) | — | utils: pure format + React components mixed; status-bar: chip-layout engine embedded; settings: config-as-code wall. | Split format/ vs components/; chip layout into its own module; settings into a declarative `SETTINGS_FIELDS` table. |

### feature / satellite packages

| # | File | Lines | Problem | Recommendation |
|---|---|---|---|---|
| 🔴 | `kanban/manager.ts` | 2,771 | **73% of a 7-file package in one module**; not a class — **48 exported free functions** + ~55 private. Board CRUD + task CRUD + assignment queue + dependency graph + TaskGraph bridge + markdown gen. | Split into 5–6 modules: `boards/tasks/assignment/dependencies/task-graph-bridge/serialization.ts`. No behavioral risk (shared `readBoard`/`mutateBoard`). |
| 🔴 | `mcp/transport.ts` | 1,321 | 3 concerns: URL/TLS validation + SSE parsing + two full transports (SSE, StreamableHTTP). Siblings `registry.ts` (1,282), `client.ts` (1,028) also large. | `transport-security/sse-reader/transport-sse/transport-streamable/transport-base.ts`. |
| 🟡 | `sage/store.ts` | 1,553 | `SageStore` god-class: CRUD + graph + verification + hygiene + candidate lifecycle + legacy import + audit + **legacy `MemoryStore` surface** (dual duty). | Split graph/verification/hygiene/candidate into collaborators; make the legacy surface a thin adapter. |
| 🟡 | `acp/client/acp-session.ts` | 1,353 | ~30 async methods: session lifecycle + auth + provider + prompting + message/update dispatch. | Separate protocol-message dispatch from the session-command API. |
| 🟢 | tools catalog | — | **Healthiest area.** ~50 tools, 3-tier token budget (TIER1/2/3+OPTIONAL); consistent conventions (tool=file, `_`-prefixed internals, complex tools in subdirs). | No refactor needed. |

---

## PART IV — Architectures to Merge or Split

The heart of the report: parallel structures doing the same job (**merge**) and separate concepts crammed under one name/file (**split**).

### IV.A — 🔴 MERGE: Dual WebUI/HQ server stack *(highest priority)*

One browser protocol is driven by **two parallel servers**: CLI-launched (`wstack --webui`) and standalone (`@wrongstack/webui-server`). They share *some* handler code and re-implement large portions independently; sync is enforced only by a message-type coverage test that **does not verify behavior**.

- **Canonical protocol:** `webui/src/types.ts:1130` (`WSClientMessage` union, 104 `WS*` members). Both servers degrade it to a `{type:string; payload?:unknown}` loose stub (`cli/src/webui-server.ts:150`, `webui-server/src/server/types.ts:21`) — discarding the discriminated union server-side.
- **Two dispatch engines:** cli = declarative route table (`message-router.ts`, ~112 keys); standalone = `switch` (`message-dispatcher.ts:218-734`, 82 cases) + 16 `*-routes.ts`.
- **Independent re-implementations** (same feature, two codebases): sessions (`ws-handlers/sessions.ts` 309 vs `session-handlers.ts` 458), providers (421 vs 447), mailbox (205 vs 164), brain (167 real logic vs 36 thin router). The cli `ws-handlers/` group is **4,051 LOC / 15 files** and mostly does not import back from the package.
- **`setup-events` has drifted:** cli (740) vs package (1,047) — **~1,705 differing lines**. The concrete form of the "confirm replay BOTH servers" / "settings parity BOTH servers" memory notes.

> **Note:** the git status at session start shows uncommitted changes in exactly this layer (`cli/webui-server.ts`, `webui-server/{connection-handler,context-breakdown,lifecycle,setup-events}.ts`) — you're already working here.

**Recommendation.** Promote the cli-local `ws-handlers/` group into `@wrongstack/webui-server` as *injectable* handlers (the `brain-routes` pattern, generalized); the CLI wires instances instead of re-implementing. Collapse `setup-events` into one parameterized module. Removes ~3–4k LOC of drift-prone duplication and turns the parity test from a coverage checker into a **redundancy guard**.

### IV.B — 🔴 MERGE: HQ dashboard's hand-written React clone

`cli/src/hq-dashboard-html.ts` (2,304 lines) is a **hand-written** clone of the React+React-Flow fleet dashboard via `esm.sh` CDN, kept feature-in-sync with `packages/webui-hq/` (proper Vite/React app, 7,038 LOC, 42 files). It's a deliberate offline fallback (`hq-server.ts:790-805`: serves `webui-hq/dist` if present, else `HQ_HTML`). **Recommendation:** either ship a prebuilt `webui-hq/dist` as a package asset (removing the from-scratch fallback), or shrink `HQ_HTML` to a minimal "build the dashboard" placeholder.

### IV.C — 🔴 RECONCILE: Duplicate `MemoryStore` (core ↔ sage)

`core/src/storage/` already carries a full memory stack (`memory-store.ts` `DefaultMemoryStore`, `memory-backend.ts` `FileMemoryBackend`, `memory-consolidator.ts`, `memory-graph-backend.ts`). `sage` imports the **same** `MemoryStore` interface and `FileMemoryBackend` from core and provides a **second, richer** implementation. One interface, two implementations across a package boundary; graph/consolidation concepts appear in both — the **clearest architectural overlap**. **Recommendation:** either sage owns the whole memory domain (core keeps only the interface), or sage folds under `core/storage/sage`. The current split invites drift.

### IV.D — 🟡 SPLIT: "Brain" naming collision + coordinator triad

Under `coordination/`, **two unrelated subsystems share one prefix**:
- **Decision gate:** `BrainArbiter` (`brain.ts:57`), `BrainDecisionLedger`, `createTieredBrainArbiter` (`autonomy-brain.ts`), `BrainRuntime` — the policy→LLM→human gate.
- **Autonomous decision engine:** `AutonomousBrain` (`autonomous-brain.ts`) — produces SpawnDecision/ApprovalDecision/…

Same prefix, different responsibility, spread across `coordination/` and `execution/`. **Recommendation:** rename the decision-gate cluster to `arbiter*` **or** namespace `coordination/brain/` (gate) vs `coordination/autonomy/` (engine).

Also the **coordinator triad**: `DefaultMultiAgentCoordinator` (1,271), `AutonomousCoordinator` (953), and `Director` (`implements ICoordinator`) — three overlapping orchestration entry points whose names don't disambiguate dispatch vs autonomy vs fleet. At minimum, a short architecture note documenting which owns what; ideally, evaluate consolidation. (Related: `TaskAuctioneer` is a third orchestration paradigm — leader-with-tools / autonomous-engine / marketplace coexist.)

### IV.E — 🟡 MERGE: Twin engines and mailbox families

- **Two "eternal autonomy" engines:** `EternalAutonomyEngine` (`eternal-autonomy.ts:205`, 1,059) and `ParallelEternalEngine` (`parallel-eternal-engine.ts:108`, 659) duplicate the state enum (`idle|running|stopped`) and the sleep/stop/error stages verbatim. Extract the shared lifecycle into `engine-lifecycle.ts`; keep only the genuinely divergent phases (`decide/execute/reflect` vs `decompose/fanout/aggregate`).
- **Two `Mailbox` implementations:** `DefaultMailbox` (`mailbox.ts:43`, 669) has **no live instantiation** (JSDoc + barrel re-export only); `GlobalMailbox` (1,566) is the real one. Delete `DefaultMailbox` or factor a shared `MailboxCore` base.
- **Two mailbox tool families:** `mailbox-tool.ts` (`makeMailboxTool`) vs `mail-tools.ts` (`makeMailSendTool`/`makeMailInboxTool`) — overlapping resolvers over the same Mailbox. Merge into `mailbox-tools.ts`.
- **Parallel mailbox type hierarchies:** `coordination/mailbox-types.ts` (`MailboxMessageType`/`MailboxAgentStatus`) vs `hq/protocol.ts` (`HqMailboxMessageType`/…) — the same domain modeled twice, drift expected. Derive the HQ variants from the coordination types.

### IV.F — 🟡 COMPLETE or FOLD: the `runtime` facade

`runtime/src/index.ts` self-documents as a *"Transitional home"*; implementations still live in core and are re-exported here. ~1/3 of the package is `export * from '@wrongstack/core'` passthrough; real code only in `vision.ts`, `clipboard.ts`, `container.ts`, `fleet/light-subagent-factory.ts`, `local-llm-probe.ts`. Until the promised core→runtime migration happens, this boundary is mostly aspirational. **Recommendation:** finish the migration or fold the package.

### IV.G — 🟡 SPLIT: `SlashCommandContext` god-interface

`slash-commands/index.ts:20–541` (~520 lines, **62 optional `on*` callbacks**) is threaded into all 84 command builders — the central coupling knot. Adding any host capability touches this interface, and it forms a 3-point manual-sync surface with the TUI/REPL handler installers. **Recommendation:** group callbacks into cohesive sub-bags (`fleet`, `spawn`, `git`, `lifecycle`); each builder declares only the slice it needs (the `statusline` builder already shows this escape hatch).

---

## PART V — Prioritized Roadmap

### P0 — High impact, clean cut lines
1. **Unify the dual server stack** (IV.A) — ~3–4k LOC drift debt; `setup-events` already diverged. *Note: your active work area.*
2. **`hq-dashboard-html.ts` → real assets** (III-cli, IV.B) — removes the backslash footgun at the root.
3. **Extract `handleKey` + `useAgentRun` from `app.tsx`** (III-tui) — the single largest file; ~2,150 lines of pure-ish state machine become testable.

### P1 — High impact, more surface
4. **Split `director.ts`** (4 collaborators) + split `director-tools.ts` (IV/III-core).
5. **Reconcile core ↔ sage `MemoryStore`** (IV.C).
6. **Split `kanban/manager.ts` into 5–6 modules** (III-feature) — mechanical, low-risk.
7. **Domain-slice the tui reducer/state** (III-tui) — generic `PickerState<T>`.

### P2 — Mechanical / low-risk, high readability payoff
8. **"Brain" naming collision** + coordinator triad documentation/clarification (IV.D).
9. **Merge twin engines & mailbox families** (IV.E); delete `DefaultMailbox`.
10. **Split schema monoliths:** `kernel/events.ts` (113-key EventMap), `types/config.ts`, `hq/protocol.ts`.
11. **Slice `SlashCommandContext` into sub-bags** (IV.G).
12. **Prompt corpus:** merge the summarizer pair; evaluate persona base+delta (I.3).
13. **Complete/fold the `runtime` facade** (IV.F).

---

## Cross-Cutting Observations

- **✅ Layer boundaries intact:** `core/src` imports nothing from `cli`/`webui`; `Director` is imported only via barrels. (Note: yesterday's report flagged `cli` importing from `tui`/`webui` in 20 files — an upward dependency in the product-surface layer, worth a separate boundary audit.)
- **✅ Dead-code hygiene excellent:** ~110 markers; genuine `@deprecated`s are documented and intentional. The memory note about "scaffolding stubs unwired" does **not** manifest as dead code in these packages — the remaining debt is structural (dual server, runtime facade, memory pair), not stubs.
- **⚠️ Parity test is fragile:** `ws-handler-parity.test.ts` is regex/string-based over source files and verifies only **message-type coverage**, not behavior. Once handlers are shared (IV.A), it becomes a near-tautology and can be upgraded to a contract test.
- **✅ Barrel surface is wide:** `core/index.ts` is 683 lines / 114 exports — a public-vs-incidental audit pass would help.

---

*This report is based on the cross-validated findings of 5 parallel exploration agents plus manual analysis of the system-prompt and feature surface. All file:line references were observed during analysis; re-read the relevant file before refactoring (line numbers drift in a codebase this active).*

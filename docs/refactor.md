# WrongStack — Refactoring Plan

**Last updated:** 2026-07-13 · **Scope:** 20 packages (`packages/*`), ~411k LOC
**Companion:** `wrongstack-report-2026-07-13.md` (full narrative + system-prompt/feature analysis)

This is an **actionable backlog**. Each item is a self-contained ticket: current state → target → steps → risk → verification. Line numbers were observed during analysis; **re-read the file before editing** — this codebase churns.

## Guiding principles

- **Behavior-preserving.** Every item is a pure refactor. No feature changes ride along.
- **Split ≠ rewrite.** Prefer extracting collaborators/modules over rewriting logic.
- **One PR per ticket** (or per sub-bullet for the big ones). Keep diffs reviewable.
- **Respect invariants** (`ARCHITECTURE.md`): `core` stays independent of product surfaces; EventBus observe-only; subagents don't share mutable run state; append-only/atomic state writes.
- **Match each file's line endings** (mixed EOL repo — see memory `mixed-line-endings-and-concurrent-edits`).

## Status legend

`TODO` · `IN PROGRESS` · `DONE` · `BLOCKED` — update inline as work lands.

---

## Priority overview

| ID | Priority | Effort | Type | Title | Status |
|----|----------|--------|------|-------|--------|
| R1 | P0 | L | Merge | Unify dual WebUI/HQ server stacks | TODO |
| R2 | P0 | M | Split | Extract HQ dashboard HTML into real assets | TODO |
| R3 | P0 | L | Split | Decompose `tui/app.tsx` god-component | TODO |
| R4 | P1 | L | Split | Decompose `core/coordination/director.ts` | **MOSTLY DONE — merged to main** (collab+btw extracted, dead scaffolding removed, constructor 411→117, spawn 228→104; only risky cross-file size reduction remains) |
| R5 | P1 | M | Merge | Reconcile duplicate `MemoryStore` (core ↔ sage) | TODO |
| R6 | P1 | M | Split | Split `kanban/manager.ts` (2771 LOC flat module) | **DONE — merged to main** (e0f6e7801) |
| R7 | P1 | M | Split | Slice `tui` reducer/state per domain | TODO |
| R8 | P1 | S | Split | Break up `cli-main.ts` `main()` wiring blob | TODO |
| R9 | P1 | M | Split | Decompose `MultiAgentHost` (`cli/fleet/host.ts`) | TODO |
| R10 | P2 | S | Rename | De-collide "Brain" naming; clarify coordinator triad | TODO |
| R11 | P2 | M | Merge | Unify twin engines & mailbox families | TODO |
| R12 | P2 | S | Split | Split schema monoliths (`events.ts`, `config.ts`, `hq/protocol.ts`) | **MOSTLY DONE — merged to main** (events.ts EventMap 1616→431 into 9 files; hq/protocol.ts 1506→10 into 10 files + guard re-pointed; only config.ts remains, deferred as it's in your WIP) |
| R13 | P2 | S | Split | Slice `SlashCommandContext` into sub-bags | TODO |
| R14 | P2 | M | Split | Split `mcp/transport.ts` and siblings | **DONE — merged to main** (transport.ts split; registry/client/authorization siblings remain) |
| R15 | P2 | S | Merge | Complete or fold the `runtime` facade | TODO |
| R16 | P3 | S | Cleanup | Prompt corpus: dedupe summarizers; persona base+delta | TODO |
| R17 | P3 | S | Cleanup | Split large webui god-files (`types.ts`, `OfficeMapCanvas`) | TODO |

**Effort:** S ≈ <1 day · M ≈ 1–3 days · L ≈ multi-day / staged.

---

## P0 — High impact, clean cut lines

### R1 · Unify the dual WebUI/HQ server stacks `[P0 · Merge · L]`

**Problem.** One browser protocol is driven by **two parallel servers** — CLI-launched (`wstack --webui`) and standalone (`@wrongstack/webui-server`) — kept in sync only by a message-type coverage test that does **not** verify behavior.

**Evidence.**
- Canonical protocol: `packages/webui/src/types.ts:1130` (`WSClientMessage`, 104 `WS*` members). Both servers degrade it to a loose `{type:string; payload?:unknown}` stub (`packages/cli/src/webui-server.ts:150`, `packages/webui-server/src/server/types.ts:21`).
- Two dispatch engines: cli declarative route table (`cli/src/webui-server/message-router.ts`, ~112 keys) vs standalone `switch` (`webui-server/src/server/message-dispatcher.ts:218-734`, 82 cases) + 16 `*-routes.ts`.
- Independent re-implementations of the same feature: sessions (`ws-handlers/sessions.ts` 309 vs `session-handlers.ts` 458), providers (421 vs 447), mailbox (205 vs 164), brain (`ws-handlers/brain.ts` 167 real logic vs `brain-routes.ts` 36 thin router). The cli `ws-handlers/` group is **4051 LOC / 15 files**.
- `setup-events` has **drifted**: `cli/.../setup-events.ts` (740) vs `webui-server/.../setup-events.ts` (1047) → ~1705 differing lines.

**Target.** One shared handler layer in `@wrongstack/webui-server`; the CLI **wires instances** instead of re-implementing them (the `brain-routes` injection pattern, generalized).

**Steps.**
1. Inventory the cli `ws-handlers/*` that have no package counterpart (sessions, providers, mailbox, brain, projects, worklist, introspection, oauth, agent-config).
2. For each, promote the implementation into `webui-server` as an **injectable handler** taking a narrow host-deps interface; CLI passes its instances.
3. Collapse the two `setup-events.ts` into one parameterized module (host supplies the EventBus + fan-out sink).
4. Replace the server-side loose `WSClientMessage` stubs with an import of the canonical union from `@wrongstack/webui`.
5. Delete the now-dead cli re-implementations.

**Risk.** High-touch, but the parity test + a new contract test contain regressions. Stage per-feature (sessions first, then providers, …), one PR each.

**Verify.** `ws-handler-parity.test.ts` stays green after each step; add a contract test that drives a representative message against both entrypoints and asserts identical output; `pnpm --filter webui test`; manual smoke of `--webui` and standalone.

**Note.** ⚠️ You currently have uncommitted work in exactly this layer (`cli/webui-server.ts`, `webui-server/{connection-handler,context-breakdown,lifecycle,setup-events}.ts`). Land or stash that before starting R1 to avoid conflicts.

---

### R2 · Extract HQ dashboard HTML into real assets `[P0 · Split · M]`

**Problem.** `packages/cli/src/hq-dashboard-html.ts` (2304 LOC) is a **single template literal** rendering a full React + React-Flow dashboard, authored with `React.createElement` + string concat under a self-imposed "no backticks, no `${`" constraint (header note, lines 8–20). Every browser-side backslash must be **manually doubled** — a standing footgun with no compiler check.

**Target.** A real `.html` / `.css` / `.mjs` asset trio, type-checked and linted, built by the existing esbuild/tsup step and read at runtime.

**Steps.**
1. Extract the CSS `:root` block → `hq-dashboard.css`.
2. Extract the browser script → `hq-dashboard.client.ts` (real TS, un-double the escapes, keep the injected `@wrongstack/tools` browser srcs as imports).
3. Extract the HTML shell → `hq-dashboard.html` with placeholder mount points.
4. Wire the build to emit these into `dist`; `hq-server.ts:62` reads the built asset.
5. Consider whether R2 makes IV.B (below, folded into R1's HQ note) moot — if `webui-hq/dist` ships prebuilt, `HQ_HTML` can shrink to a minimal placeholder instead of a full parallel dashboard.

**Risk.** Low logic risk; the risk is build wiring. Verify the offline fallback still serves.

**Verify.** `wstack --hq`, open `http://localhost:3499`, confirm fleet map + transcript sidebar render identically; check the `webui-hq/dist`-present and `-absent` branches (`hq-server.ts:790-805`).

---

### R3 · Decompose `tui/app.tsx` god-component `[P0 · Split · L]`

**Problem.** `App()` spans ~6750 lines (`packages/tui/src/app.tsx:844-7589`): **~90 props**, and in the body **22 `useState` / 67 `useEffect` / 54 `useRef` / 33 `useCallback`**. `handleKey` alone is ~2150 lines (216 `dispatch` calls) — the entire keyboard state machine. Render holds **20 near-identical overlay ternaries** (`:6969-7589`).

**Target.** `App()` becomes a thin composition of hooks + an `<OverlayStack>`; `handleKey` becomes a testable `useKeyRouter` (or pure `reduceKey`).

**Steps (each its own PR).**
1. **`useKeyRouter`** — extract `handleKey` (`:4661-~6811`). Modal-guard ladder + bracketed-paste accumulation are pure-ish; move them out first, keep dispatch injection.
2. **`useAgentRun`** — extract `runBlocks` (`:5850-6048`), `submit` (`:6202+`), `commitPaste`, `runInterruptLadder` (`:4423`). They already communicate via refs → clean boundary.
3. **`<OverlayStack>`** — replace the 20 render ternaries with a `PICKERS` registry `{ predicate, component, closeAction }` iterated once. This also removes the parallel enumerations in `handleKey` (right-click-cancel `:4801-4820`, Esc-close).
4. **`useStatusChips`** — fold the small `useState+useEffect` chip effects (breaker `:1018-1040`, index, branch, tool-count) via a `useSubscribedValue(get, onChange)` helper.
5. **Prop bundling** — group the ~90 props into typed context objects (`hosts`, `controllers`, `settingsIO`, `fleet`); shrink `AppProps` (`:230-843`).

**Risk.** Ink re-render semantics; keep hook extraction mechanical (move code, keep deps). Prior work already extracted ~18 hooks — follow that pattern.

**Verify.** TUI smoke (launch, run a turn, open each picker, Ctrl+C ladder, paste); rebuild `tui/dist` (memory: `rebuild-tui-dist-for-tui-changes`); no reducer changes in this ticket (that's R7).

---

## P1 — High impact, more surface

### R4 · Decompose `core/coordination/director.ts` `[P1 · Split · L]`

**Problem.** One `Director` class (`director.ts:372`), **51 methods**, ~400-line constructor (`:619-1030`). Tangles: leader budget, subagent lifecycle (`spawn` 1241, `terminate` 1914, idle-retire 1982), task dispatch (`assign` 1713, `awaitTasksAny` 1840, `retargetPendingTask` 1887), BTW notes (1089-1136), collab-debug (`spawnCollab` 2233), manifest persistence (`appendSessionEvent` 1183, `writeManifestNow` 1569), checkpoint (`setCheckpointState` 2054, `resumeFromCheckpoint` 2268), prompt assembly (`leaderSystemPrompt` 2150). `director-construction.ts` (345) is a half-finished extraction.

**Target.** `Director` = thin orchestration wiring owning four collaborators.

**Steps.**
1. `SubagentLifecycleManager` — spawn / terminate / idle-retirement.
2. `DirectorTaskDispatcher` — assign / awaitTasks(Any) / retarget.
3. `DirectorCheckpointStore` — manifest + checkpoint + session events.
4. `DirectorCollabController` — collab session mgmt.
5. Finish the `director-construction.ts` extraction rather than adding a parallel one.

**Risk.** Central orchestration; strong test coverage exists — lean on it. Preserve `Director.spawn` lineage authority (memory: fleet recursion invariants).

**Verify.** Full `pnpm test` for core coordination; fleet e2e behind `WSTACK_E2E=1`.

**Companion:** also split `director-tools.ts` (1767) into `director-tools/{spawn,quality-gate,kanban,fleet,collab}.ts` — self-contained tool clusters with helpers colocated.

---

### R5 · Reconcile duplicate `MemoryStore` (core ↔ sage) `[P1 · Merge · M]`

**Problem.** `core/src/storage/` has a full memory stack (`memory-store.ts` `DefaultMemoryStore`, `memory-backend.ts` `FileMemoryBackend`, `memory-consolidator.ts`, `memory-graph-backend.ts`). `sage` imports the **same** `MemoryStore` interface + `FileMemoryBackend` and provides a **second, richer** implementation. One interface, two implementations, across a package boundary — graph/consolidation modeled in both. Clearest architectural overlap in the repo.

**Target.** Single owner of the memory domain.

**Decision required (pick one):**
- **(a)** sage owns the whole domain; core keeps only the `MemoryStore` interface + types. *(Recommended — sage is the richer, actively-developed impl.)*
- **(b)** Fold sage into `core/storage/sage` as a core-internal module.

**Steps (option a).** Move `DefaultMemoryStore`/`FileMemoryBackend` consumers to sage; leave `types/memory.ts` + interface in core; update `runtime`/`cli` wiring to resolve the sage impl.

**Risk.** Touches persistence (append-only invariant). Migration-safe: read path must stay backward compatible with existing `~/.wrongstack` memory files.

**Verify.** sage tests + a round-trip test against a fixture memory dir; `/memory` slash command smoke.

**Note.** Memory `budget-watchdog-subsystem-user-wip` and `sdd-kanban-extraction-state` flag the user is mid-extraction in adjacent areas — coordinate before moving files.

---

### R6 · Split `kanban/manager.ts` (2771 LOC flat module) `[P1 · Split · M]`

**Problem.** 73% of a 7-file package in one module — not a class, **48 exported free functions** + ~55 private, over shared `readBoard`/`mutateBoard`.

**Target.** 5–6 cohesive modules.

**Steps.** Extract along the existing seams:
- `boards.ts` — board/column CRUD (`:59-256`)
- `tasks.ts` — task CRUD + movement (`:258-406`)
- `assignment.ts` — agent-assignment/queue (`:422-947`, the reliable-queue subsystem)
- `dependencies.ts` — dependency graph + cycle detection (`:947-1131`, `:2064-2211`)
- `task-graph-bridge.ts` — TaskGraph↔Kanban (`:1296-1548`, `:2321-2545`)
- `serialization.ts` — markdown gen/export (`:1274`, `:1548`, `:1607`)

**Risk.** Very low — independent functions sharing only storage primitives.

**Verify.** `pnpm --filter @wrongstack/kanban test`; kanban slash-command + `director-tools` kanban tool smoke.

---

### R7 · Slice `tui` reducer/state per domain `[P1 · Split · M]`

**Problem.** `app-state.ts`: `State` = **84 flat fields** (`:171-825`), `Action` = **245-variant union** (`:909-1430`). `app-reducer.ts` (2440): **253-case switch**, only `fleet` delegated (`reduceFleetState` `:1855`). Per-picker `open/close/back/move/select` families dominate the action count.

**Target.** Thin root reducer delegating to per-domain sub-reducers (follow `reducers/fleet.ts`); `State` sliced into nested sub-objects; generic `PickerState<T>` absorbs the repeated picker shape.

**Steps.** Extract `reduceModelPicker`, `reduceSettings`, `reduceInput`, `reduceStream`, `reducePanels`; introduce `PickerState<T>` + `reducePicker<T>` generic; nest `State` accordingly (migrate field access sites).

**Risk.** Wide mechanical churn across `app.tsx` dispatch sites (427 calls). Do after R3 so the dispatch surface is already smaller.

**Verify.** Reducer unit tests (pure — easy to cover); TUI smoke.

---

### R8 · Break up `cli-main.ts` `main()` wiring blob `[P1 · Split · S]`

**Problem.** `main()` runs `cli-main.ts:124-end`; `:597-1923` is **~1300 uninterrupted lines** (Brain → BrainMonitor → shadow → MultiAgentHost → tools), 69 `await`s.

**Target.** Per-subsystem wiring helpers in `wiring/` (continuing Issue #29).

**Steps.** Extract `wireBrainAndShadow()`, `wireFleetHost()`, `wireProviderRuntime()`, each taking/returning a narrow context slice (mirror `session-event-wiring.ts`).

**Risk.** Boot ordering — preserve sequence exactly; extract in place (cut/paste into helper, pass context).

**Verify.** `wstack` cold start; `--webui`, `--tui`, `--hq` short-circuits; single-shot dispatch.

---

### R9 · Decompose `MultiAgentHost` (`cli/fleet/host.ts`) `[P1 · Split · M]`

**Problem.** God-class (`host.ts:322`), 30+ methods / 6 responsibilities: director lifecycle, shadow-agent scheduling (`:753-832`), subagent factory + tool-registry (`makeSubagentFactory` `:941-1233`, `subagentToolRegistry` 1590, `filterTools` 1387), ACP runners (`:1240-1350`), fleet supervision (1471), usage/status (1788-1904).

**Target.** Thin coordinator delegating to collaborators.

**Steps.** Extract `ShadowAgentController` (`:753-832`) and `SubagentFactoryBuilder` (`:941-1590`) first — cleanest cuts. Then `ACPRunnerFactory`, leaving lifecycle + status on the host.

**Risk.** Subagent capability gating is security-sensitive (memory: `subagent-capability-gating` — allowlist-by-default, `fs.write` needs `allowedCapabilities` AND `source==='yolo'`). Preserve `resolveSubagentCapabilities`/`filterTools` semantics exactly.

**Verify.** Fleet spawn e2e; capability-gating test; ACP subagent smoke.

---

## P2 — Mechanical / low-risk, high readability payoff

### R10 · De-collide "Brain" naming; clarify coordinator triad `[P2 · Rename · S]`

Two unrelated subsystems share the `Brain` prefix: the **decision-gate** (`BrainArbiter` `brain.ts:57`, `BrainDecisionLedger`, `createTieredBrainArbiter` `autonomy-brain.ts`, `BrainRuntime`) vs the **autonomous engine** (`AutonomousBrain` `autonomous-brain.ts`). Split across `coordination/` and `execution/`.
- **Action:** namespace `coordination/brain/` (gate) vs `coordination/autonomy/` (engine), or rename the gate cluster to `arbiter*`.
- **Also:** add a short architecture note (or `docs/`) disambiguating `DefaultMultiAgentCoordinator` (1271) vs `AutonomousCoordinator` (953) vs `Director` (`implements ICoordinator`) vs `TaskAuctioneer` — three coexisting orchestration paradigms (leader-with-tools / autonomous-engine / marketplace). Evaluate whether the coordinator layer can consolidate.

**Risk.** Rename-only; use LSP rename + barrel updates. **Verify:** typecheck + full test.

### R11 · Unify twin engines & mailbox families `[P2 · Merge · M]`

- **Two eternal engines:** `EternalAutonomyEngine` (`eternal-autonomy.ts:205`, 1059) + `ParallelEternalEngine` (`parallel-eternal-engine.ts:108`, 659) duplicate the state enum + sleep/stop/error stages. → extract `engine-lifecycle.ts`; keep only divergent phases.
- ~~**Two `Mailbox` impls:** `DefaultMailbox` / `GlobalMailbox`.~~ DONE — both JSONL implementations were deleted; `SqliteMailbox` behind the project server is the only store, and `RemoteMailbox` the only client.
- **Two mailbox tool families:** `mailbox-tool.ts` (`makeMailboxTool`) vs `mail-tools.ts` (`makeMailSendTool`/`makeMailInboxTool`). → merge into `mailbox-tools.ts` with shared resolvers.
- **Parallel mailbox types:** `coordination/mailbox-types.ts` vs `hq/protocol.ts` `Hq*` re-declarations. → derive HQ variants from the coordination types.

**Verify.** Mailbox cross-surface e2e (two surfaces, one project); eternal-mode smoke (`--eternal`).

### R12 · Split schema monoliths `[P2 · Split · S]`

- `kernel/events.ts` (1616): split the **113-key `EventMap`** into per-domain maps (`BrainEventMap`, `FleetEventMap`, `SessionEventMap`, `HqEventMap`, `WorktreeEventMap`) combined via intersection; keep `EventBus`/`ScopedEventBus` in place.
- `types/config.ts` (1487, ~50 interfaces): split into `config/{brain,fleet,tools,mcp,...}.ts` with a re-export barrel.
- `hq/protocol.ts` (1506): split into `hq/protocol/{session,mailbox,fleet,brain}.ts`.

**Risk.** Declarative types — near-zero logic risk. **Verify:** typecheck across all packages (`core-layer-boundaries` — only full `pnpm test` catches boundary regressions).

### R13 · Slice `SlashCommandContext` into sub-bags `[P2 · Split · S]`

`slash-commands/index.ts:20-541` — **62 optional `on*` callbacks** threaded into all 84 builders; central coupling knot + 3-point manual sync with TUI/REPL installers. → group into cohesive bags (`fleet`, `spawn`, `git`, `lifecycle`); each builder declares only the slice it needs (the `statusline` builder `:709-717` already does this). **Verify:** typecheck + slash-command smoke.

### R14 · Split `mcp/transport.ts` and siblings `[P2 · Split · M]`

`transport.ts` (1321): 3 concerns → `transport-security.ts` (`:56-160`), `sse-reader.ts` (`:164-414`), `transport-sse.ts` (`:653-1030`), `transport-streamable.ts` (`:1030+`), `transport-base.ts` (`BaseHTTPTransport` `:454`). Siblings `registry.ts` (1282), `client.ts` (1028), `authorization.ts` (832) are next. **Verify:** MCP transport tests; stdio/SSE/streamable-http smoke.

### R15 · Complete or fold the `runtime` facade `[P2 · Merge · S]`

`runtime/src/index.ts` self-documents as a *"Transitional home"*; ~1/3 is `export * from '@wrongstack/core'`. Real code only in `vision.ts`, `clipboard.ts`, `container.ts`, `fleet/light-subagent-factory.ts`, `local-llm-probe.ts`. → **Decide:** finish the core→runtime migration (move impls in) or fold the package and re-point consumers at core. **Verify:** typecheck + `makeDefaultRuntime()` smoke.

---

## P3 — Cleanup

### R16 · Prompt corpus hygiene `[P3 · Cleanup · S]`

- Dedupe the two near-identical summarizer prompts (`instructions/llm/intelligent-compactor-summarizer.md` ≈ `selective-compactor-summarizer.md`) into one parameterized template.
- Evaluate a persona **base + delta** model for the 58 `agents/*.md` (most are 22–25 lines sharing one skeleton), mirroring the `modes/` `-lite`/full delta pattern.
- Keep the test-pinned instruction anchors intact (memory: `instruction-files-map-and-anchors`).

### R17 · Split large webui god-files `[P3 · Cleanup · M]`

- `webui/src/types.ts` (2268): split into `protocol/client-messages.ts`, `protocol/server-messages.ts`, domain modules — **keep a re-export barrel** (the parity test reads `types.ts` by name).
- `webui/src/components/OfficeMapCanvas.tsx` (1942): node components → `OfficeMap/nodes/*`; pull the ~430-line `useEffect` (`:929-1363`) into `useOfficeGraph`.
- `webui/src/components/SetupScreen.tsx` (1539): extract `ProviderKeyCard` (`:244-749`) + `CustomProviderSection`.

---

## Not in scope (verified healthy — do not "fix")

- **`packages/tools` catalog** — clean, tiered (TIER1/2/3+OPTIONAL), consistent conventions. Leave it.
- **Dead-code hygiene** — ~110 markers repo-wide, nearly all benign/documented. No stub epidemic; the "unwired scaffolding" concern does not manifest as dead code (it's the structural items above).
- **Layer boundaries** — `core` imports nothing from product surfaces. Preserve this in every ticket. (Separately, the 2026-07-12 report flagged `cli`→`tui`/`webui` imports in 20 files; treat that as its own boundary audit, not part of these tickets.)
- **Small satellites** (`telegram`, `security-scanner`, `bench`, `acp`) — genuinely distinct integration surfaces; keep separate.

---

## Suggested execution order

1. **R1** (coordinate with your in-flight dual-server work) → **R2** → **R3** — the three P0s remove the most drift/footgun risk and shrink the largest file.
2. **R8, R6, R12** — quick mechanical wins to build momentum.
3. **R4, R9, R7** — the deeper structural splits, each behind good tests.
4. **R5, R10, R15** — architectural decisions (pick an owner / a namespace) — settle these before they ossify further.
5. **R11, R13, R14, R16, R17** — steady cleanup.

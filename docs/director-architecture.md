# Director Orchestration Architecture

> Comprehensive analysis and improvement roadmap for the Director / multi-agent fleet system.

**Status as of 0.270.0** — All core phases shipped; ongoing refinement of subagent budget negotiation, error classification, and fleet observability.

> **Note (0.287.0):** Director Mode is permanently on across the CLI, TUI, WebUI, SimpleUI, and Desktop surfaces. The `--director` and `--no-director` flags have been removed from `arg-parser.ts`, `directorMode` is a compile-time `true` constant in `director-setup.ts`, `isDirectorMode()` unconditionally returns `true`, and `ensureDirector()` always builds the Director without any mode check. The `/director` slash command now surfaces fleet status; the actual fleet entry points are `/spawn`, `/fleet`, `/delegate`, and the goal-flow launcher.

---

## Table of Contents

1. [What Already Exists](#1-what-already-exists)
2. [Architecture Overview](#2-architecture-overview)
3. [Phase Status](#3-phase-status)
4. [Improvement Opportunities](#4-improvement-opportunities)
5. [Open Issues](#5-open-issues)
6. [Feature & Fix Roadmap](#6-feature--fix-roadmap)

---

## 1. What Already Exists

### Core Classes

| Class | File | Responsibility |
|-------|------|----------------|
| `Director` | `packages/core/src/coordination/director.ts` | High-level orchestrator; owns coordinator, FleetBus, usage aggregator. Exposes imperative API + LLM-callable tools. |
| `DefaultMultiAgentCoordinator` | `packages/core/src/coordination/multi-agent-coordinator.ts` | Task queue, dispatch to idle workers, concurrency cap, budget enforcement. |
| `FleetBus` | `packages/core/src/coordination/fleet-bus.ts` | Fan-in event bus; re-emits per-subagent events with subagent attribution. |
| `FleetUsageAggregator` | `packages/core/src/coordination/fleet-bus.ts` | Rolls up token usage + cost from `provider.response` / `tool.executed` events. |
| `InMemoryAgentBridge` | `packages/core/src/coordination/agent-bridge.ts` | Bidirectional request/response bridge between director and subagents. |
| `InMemoryBridgeTransport` | `packages/core/src/coordination/in-memory-transport.ts` | In-memory message transport backing the bridge. |
| `SubagentBudget` | `packages/core/src/coordination/subagent-budget.ts` | Per-subagent hard/soft budget enforcement (iterations, tools, tokens, cost, timeout). |
| `DirectorStateCheckpoint` | `packages/core/src/storage/director-state.ts` | Incremental on-disk snapshot of fleet state for crash recovery. |
| `makeDirectorSessionFactory` | `packages/core/src/coordination/director-session.ts` | Produces per-subagent JSONL session writers under `<runDir>/<subagentId>.jsonl`. |
| `createDelegateTool` | `packages/core/src/coordination/delegate-tool.ts` | Single-tool spawn+assign+await bundling available after Director mode is active. |

### Director tools (14 total)

`Director.tools()` currently returns these tool definitions:

| Tool | Purpose |
|------|---------|
| `spawn_subagent` | Create a worker from roster role or explicit config. Returns subagent id. |
| `assign_task` | Hand a task to a specific subagent. Returns task id. |
| `kanban_queue` | Claim dependency-ready Kanban work and dispatch it into the fleet. |
| `await_tasks` | Block until named task ids complete. |
| `ask_subagent` | Send a synchronous bridge request to a running subagent. |
| `ask_result` | Retrieve the result of an earlier bridge request. |
| `roll_up` | Aggregate completed task results into markdown or JSON. |
| `quality_gate` | Run verifier/reviewer agents and optionally request repair work. |
| `terminate_subagent` | Abort one subagent. |
| `terminate_all` | Abort all running subagents. |
| `fleet` | Query status, usage, session, and health actions. |
| `collab_debug` | Run the collaborative debug workflow. |
| `fleet_emit` | Emit a fleet coordination event. |
| `work_complete` | Record completion of delegated work. |

### Pre-built fleet roster

`FLEET_ROSTER` contains 77 unique role ids: the 75-role phase catalog plus the
operational `generic` and `shadow-agent` roles. Representative roles include:

| Role | File | Purpose |
|------|------|---------|
| `audit-log` | `fleet.ts` | Session log analysis, pattern detection, audit reports |
| `bug-hunter` | `fleet.ts` | Systematic bug and code smell detection |
| `refactor-planner` | `fleet.ts` | Architecture analysis, phased refactoring plans |
| `security-scanner` | `fleet.ts` | Secret detection, injection vectors, CVE scanning |
| `critic` | `fleet.ts` | Evaluate findings, plans, and architectural proposals |
| `shadow-agent` | `fleet.ts` | One-shot fleet monitoring and intervention |

### Making the roster reachable

A deep roster is worth nothing if the leader cannot find the right role in it.
Measured on this repository before the guards below existed: of the 77 roles
offered, **10 had ever completed a task** and **2 accounted for 73% of all
captured learning**, while `database`, `backend`, `frontend`, `devops` and
`android` had never once been chosen. Three mechanisms were responsible, and
each is now closed:

1. **The menu described nothing.** `rosterSummaryFromConfigs` built each line
   from the first 80 characters of the role prompt — and every role prompt opens
   `You are the X agent. Your job is…`, so a third of each line was boilerplate
   and the distinguishing half was truncated. The catalog already carried a
   curated `capability.summary` per agent, used by the dispatcher and shown to
   nobody. `FLEET_ROSTER` now copies it onto each config as `dispatch.summary`
   and the menu renders that. Cost: 6.5 KB → 9.1 KB. Pinned by
   `roster-discoverability.test.ts`.
2. **Description-dispatch had no tie-breaker.** `dispatchAgent` is two-stage —
   keyword heuristic, then a model — but nothing supplied stage two to the
   `Director`, so anything the keywords could not resolve fell through to the
   `executor` generalist. The host now passes a classifier that routes through
   the `dispatcher` model-matrix slot (a short classification belongs on a cheap
   fast model) and returns `null` on any failure, so routing degrades to the
   heuristic rather than failing a spawn.
3. **`role` skipped dispatch entirely, and the tool recommended it first.**
   `spawn_subagent` only dispatches when `role` is absent. The schema and usage
   hint now lead with `description` and say plainly that passing a
   half-remembered id silently costs the specialist.

The roster block in the leader prompt is introduced as a routing instruction
rather than a bare list — a menu of 77 look-alike lines gets skimmed, and the
leader falls back to the four ids it can recall.

### Role toolsets

Roles do not all receive every tool, and this is deliberate. `TOOLS` in
`agents/types.ts` defines composable presets — `read` (6), `inspect` (10),
`write` (10), `build` (16), `vcs` (6), `deps` (8), `docs` (9), `research` (6) —
and a role spreads one plus any extras it needs (`[...TOOLS.build, 'fetch']`).
Across the 77 roles that resolves to **49 distinct tools**; the widest role is
`e2e` at 33, then `browser` at 23.

The narrowing is behavioural, not only defensive: a reviewer that can write is
not an independent reviewer — it will fix what it was asked to judge — and a
research agent with `bash` stops researching. A narrow allowlist also means a
shorter tool section in the prompt and a smaller action space to wander in.

Three properties worth keeping:

- **An unrestricted role is a role choice, not a missing feature.** `generic`
  and `shadow-agent` declare no `tools` array, so `selectSubagentTools` gives
  them every visible tool.
- **The contract fails loud.** A role naming a tool the runtime has not
  registered makes `selectSubagentTools` throw rather than silently spawning a
  crippled agent. This is why the presets stay conservative.
- **Narrow must never mean mute.** Every preset carries `mailbox` so a blocked
  subagent can ask the leader instead of only failing. `vcs` was the one preset
  without it, which silenced `git` and `release` — the two roles whose work
  (force-push, tag collision, dirty tree) least often has a safe default.
  Pinned by `roster-discoverability.test.ts`.

Toolset narrowing does **not** cost a role its guidance: running all 75 curated
skill sets against their own toolsets drops zero skills, so the tool presets and
`ROLE_SKILL_SETS` are consistent by construction.

### CLI Integration

- `MultiAgentHost` (`packages/cli/src/multi-agent.ts`) — wires Director into CLI lifecycle
- `promoteToDirector()` — runtime promotion from legacy coordinator to Director mode
- `buildSubagentRunner()` — per-subagent Agent factory with isolated context, session, and permission policy

---

## 2. Architecture Overview

```
User Input
    │
    ▼
┌─────────────────────────────────────────────────────────────────┐
│  Director Agent (LLM-driven)                                    │
│  System Prompt: DEFAULT_DIRECTOR_PREAMBLE + leader prompt        │
│  Tools: 14 orchestration definitions; see the table above       │
│         (spawn, assign, await, review, fleet, terminate, etc.)   │
└─────────────────────────────────────────────────────────────────┘
    │
    │ spawn() / assign() / awaitTasks()
    ▼
┌─────────────────────────────────────────────────────────────────┐
│  Director                                                        │
│  ├── FleetBus (event fan-in from all subagents)                 │
│  ├── FleetUsageAggregator (cost roll-up)                        │
│  ├── InMemoryAgentBridge (parent↔child communication)           │
│  ├── DirectorStateCheckpoint (live state → disk)                 │
│  └── MultiAgentCoordinator (task queue, dispatch, budget)         │
└─────────────────────────────────────────────────────────────────┘
    │
    │ per-subagent task dispatch
    ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ Subagent A   │  │ Subagent B   │  │ Subagent C   │
│ (Planner)    │  │ (Fast)       │  │ (Verifier)   │
│ Own context  │  │ Own context  │  │ Own context  │
│ Own session  │  │ Own session  │  │ Own session  │
│ Own budget   │  │ Own budget   │  │ Own budget   │
│ FleetBus     │  │ FleetBus     │  │ FleetBus     │
│ (events)     │  │ (events)     │  │ (events)     │
└──────────────┘  └──────────────┘  └──────────────┘
```

### Key Design Decisions

**Sibling run state is isolated by construction.** Each spawned subagent receives its own `Context`, `SessionWriter`, `TokenCounter`, and in-flight tool state. `Agent.run()` rejects a second concurrent call on the same instance because its shared context is not a concurrency boundary. Coordination may use `AgentBridge`, fleet events, the project mailbox, or an explicitly configured shared scratchpad.

**Director is not an Agent.** `Director` is a coordinator + observability surface. To make it LLM-driven, construct an `Agent` with `director.tools()` registered. This keeps the construction symmetric with how other agents are built and avoids smuggling an LLM dependency into core.

**Budget is explicit.** No implicit caps. The orchestrator picks budgets per task. `SubagentBudget` enforces hard stops; `FleetSpawnBudgetError` enforces fleet-wide spawn caps.

**State is checkpointed for recovery tooling.** `DirectorStateCheckpoint` schedules incremental snapshots after mutations, `fleet.json` is the final manifest, and per-subagent JSONLs preserve recorded events. These artifacts do not by themselves reattach in-flight workers after a process crash; fleet-aware resume remains a separate recovery path.

---

## 3. Phase Status

### ✅ Phases 1–5: Shipped in 0.1.7

| Phase | Description | Status |
|-------|-------------|--------|
| 1 | Provider plumbing (`provider?: string` on SubagentConfig) | ✅ Shipped |
| 2 | Per-subagent sessions (`makeDirectorSessionFactory`) | ✅ Shipped |
| 3 | FleetBus + FleetUsageAggregator | ✅ Shipped |
| 4 | Director tool surface | ✅ Shipped |
| 5 | Director class + shutdown + manifest writing | ✅ Shipped |

### ✅ Phase 6: Partially Shipped (0.1.8)

| Item | Description | Status |
|------|-------------|--------|
| `maxSpawnDepth` enforcement | Enforced in `Director.spawn()` before coordinator touch | ✅ Shipped |
| Fleet-wide cost cap (`directorBudget.maxCostUsd`) | `FleetSpawnBudgetError` + cost check before spawn | ✅ Shipped |
| `maxBudgetExtensions` configurable | `DirectorOptions.maxBudgetExtensions` replaces hardcoded 2 | ✅ Shipped |
| `checkpointDebounceMs` configurable | Passed through to `DirectorStateCheckpoint` | ✅ Shipped |
| `fleet (action: session)` tool | Director can read subagent JSONL mid-flight | ✅ Shipped |
| `fleet (action: health)` tool | Per-subagent budget pressure + liveness snapshot | ✅ Shipped |
| `FleetSpawnBudgetError` surfaced in `spawn_subagent` tool | LLM sees structured `{ error, kind, limit, observed }` | ✅ Shipped |
| `--resume <runId>` | Crash recovery: re-attach to live subagents via lock files | 🔲 Pending |
| Hostile-prompt test pack | Verify bridge contract prevents parent-context exfiltration | 🔲 Pending |
| `wstack sessions ls <runId>` | CLI command to list fleet/session artifacts | 🔲 Pending |
| TUI fleet panel | Real-time subagent status dashboard in TUI | ✅ Shipped |
| WebUI fleet panel | Live subagent cards and counters in the per-session WebUI | ✅ Shipped |
| `wstack replay <runId>` | Replay session events from JSONL | ✅ Shipped |
| `fleet (action: session)` subagent-side bridge handler | Subagent responds to `session_read` bridge messages | 🔲 Pending |
| `redirect` tool | Mid-flight task reassignment | 🔲 Pending |
| `classifySubagentError` case normalization | Use `lower` for empty_response / tool_failed regexes | 🔲 Pending |

---

## 4. Improvement Opportunities

### 4.1 Missing Tools

#### `fleet (action: session)` ✅ Shipped (0.1.8)

Director reads subagent JSONL directly via `Director.readSession(subagentId, tail?)` — no bridge round-trip needed. Requires `sessionsRoot` + `directorRunId` on the Director. Exposed as a first-class `fleet (action: session)` LLM tool. Returns `lastAssistantText`, `lastStopReason`, `toolUsesObserved`, `events`, and `path`.

#### `fleet (action: health)` ✅ Shipped (0.1.8)

Per-subagent health snapshot: budget pressure (iterations/toolCalls/cost), last activity timestamp, and status. Returns a structured array so the director can make routing decisions without calling `fleet (action: usage)` + `fleet (action: status)` separately.

#### `redirect` — Mid-flight task reassignment 🔲 Pending

A `redirect` tool that sends a new task description to a running subagent via the bridge would enable adaptive orchestration. Requires subagent-side bridge subscription support — currently only `request`/`reply` is well-defined in the bridge contract.

### 4.2 Budget System Improvements

#### Fleet-wide cost cap ✅ Shipped (0.1.8)

`DirectorOptions.directorBudget.maxCostUsd` sets a dollar-denominated ceiling. `FleetSpawnBudgetError` is thrown before the spawn is recorded — in-flight tasks complete, only new spawns are blocked. Surfaced to the LLM as `{ error, kind: 'max_cost_usd', limit, observed }`.

#### Auto-extend guard configurable ✅ Shipped (0.1.8)

`DirectorOptions.maxBudgetExtensions` (default: 2) replaces the hardcoded `prior >= 2` guard. Set to `Infinity` for long-running autonomous tasks; set to `1` for tighter control.

#### `classifySubagentError` case normalization ✅ Already correct

The `empty_response` and `tool_failed` regexes in `classifySubagentError` already use `baseMessage` (the original string), which is correct because these specific error messages are lowercase in the source code. The `lower` variable is used for substring checks like `bridge transport`, not for anchored regex patterns. No change needed.

### 4.3 State & Persistence

#### `checkpointDebounceMs` configurable ✅ Shipped (0.1.8)

`DirectorOptions.checkpointDebounceMs` (default: 250ms) is passed through to `DirectorStateCheckpoint`. Higher values reduce write amplification on fast machines; lower values improve crash-recovery fidelity.

#### `sessionsRoot` + `directorRunId` in Director ✅ Shipped (0.1.8)

Director now accepts `sessionsRoot` and `directorRunId` in its options, enabling direct JSONL reads without requiring the CLI to pass a session factory. The `fleet (action: session)` tool works when these are set.

#### `sharedScratchpadPath` auto-default ✅ Shipped (0.1.8)

`MultiAgentHost` defaults `sharedScratchpadPath` to `<sessionsRoot>/<directorRunId>/shared/` when both are available but not explicitly provided. Fleet coordination is now discoverable without extra config.

### 4.4 CLI & UX Gaps

#### `--director` CLI flag (obsolete — removed)

Director Mode is now hard-coded as permanently active. The `--director` and `--no-director` CLI flags were removed from `arg-parser.ts`; `directorMode` is a compile-time `true` constant in `director-setup.ts`; `isDirectorMode()` unconditionally returns `true`; `ensureDirector()` always builds the Director without any mode check. No flag, config field, or environment variable exists to disable it.

#### Partial session artifact CLI support

Fleet artifacts are written. `wstack replay` exists for session-event replay, but there is still no first-class `wstack sessions ls <runId>` command dedicated to listing fleet artifacts for a run.

#### Fleet observability surface

`FleetBus` events are emitted and consumed by the TUI. `FleetMonitor` (`Ctrl+F` / `F2`) shows the orchestration dashboard, `AgentsMonitor` (`Ctrl+G` / `F3`) shows per-agent live context, and the TUI `FleetPanel` renders the compact status-bar summary. The per-session WebUI also ships a live `FleetPanel` with subagent cards and counters, but it does not have a dedicated full-page fleet dashboard.

### 4.5 Error Handling

#### `delegate` partial output in hints ✅ Shipped (0.1.8)

`hintForKind` now accepts an optional `partial?: { lastAssistantText?: string }` parameter. For `budget_timeout`, `budget_cost`, and `tool_failed` cases, the hint now includes the actual partial output produced before failure. LLM no longer gets generic advice when the real work is available.

### 4.6 Prompt Engineering

#### `DEFAULT_DIRECTOR_PREAMBLE` is not model-aware

The preamble uses generic fleet rules. For planner-class models, more explicit "think step by step before spawning" guidance could reduce premature spawning. For fast models, more directive "always decompose before spawning" rules could improve planning.

#### Subagent baseline has no "stop early" signal

The `DEFAULT_SUBAGENT_BASELINE` tells subagents to "be concise, structured, and self-contained" but provides no guidance on when to stop iterating (e.g. "if you've made 3 tool calls without meaningful progress, report back with what you tried"). Subagents in long-running tasks may exhaust their budget without producing useful output.

#### Shared scratchpad defaults in CLI-hosted Director sessions

The CLI derives `sharedScratchpadPath` as `<fleetRoot>/shared` and passes it into the Director. Direct embedders constructing `Director` themselves must still provide the option if they want file-based coordination; otherwise `sharedScratchpadPath` is `null`.

### 4.7 Test Coverage Gaps

The director test suite covers:
- Subagent isolation (provider/model attribution)
- Task routing (no cross-talk)
- Usage roll-up with pricing
- Late-await resolution (completed cache)
- Terminate/abort
- Director tool shapes + roster lookup
- FleetBus subscribe/filter/onAny
- Bridge ask round-trip
- rollUp markdown + JSON
- Manifest persistence
- Safety caps (maxSpawns, maxSpawnDepth)
- Prompt isolation (no parent prompt leak)

**Missing test coverage:**
- `DirectorStateCheckpoint` debounce and rewriteRequested logic
- `makeDirectorSessionFactory` with caller-managed store
- Budget threshold extension flow (2-extension guard)
- `promoteToDirector` blocking when coordinator has running subagents
- `readSubagentPartial` with malformed JSONL
- `sharedScratchpadPath` directory creation failure handling
- Cross-subagent scratchpad coordination scenario

---

## 5. Open Issues

### 5.1 `directorRunId` has multiple independent generators

The `Director` uses `opts.config.coordinatorId || randomUUID()` as its id. The `DirectorStateCheckpoint` stores this as `directorRunId`. The `makeDirectorSessionFactory` generates its own `directorRunId` (timestamped, e.g. `20260515-abcd1234`). In `MultiAgentHost.promoteToDirector`, when `fleetRoot` is set, `directorRunId` is derived differently. These three id spaces are not synchronized.

**Impact:** The same fleet run has 2-3 different identifiers depending on which component writes it. Fleet-specific replay or artifact browsing must know which id space to look in.

### 5.2 `delegate` timeout buffer is arbitrary

```ts
// delegate-tool.ts line 219
const SUBAGENT_TIMEOUT_BUFFER_MS = 30_000;
const desiredSubTimeout = Math.max(30_000, timeoutMs - SUBAGENT_TIMEOUT_BUFFER_MS);
```

The 30-second buffer between host-level timeout and subagent-level timeout is hardcoded. For a 4-hour host timeout, the subagent gets 3h59m30s. For a 1-minute host timeout, the subagent gets 30 seconds (the `Math.max` floors it at 30s). This asymmetry is undocumented and may surprise callers using tight timeouts.

### 5.3 `FleetBus` forward type list is closed

In `fleet-bus.ts` line 50-73, `FORWARDED_TYPES` is a const array listing every event type the bus forwards. Adding a new event type to the kernel requires adding it to this array — there's no open-ended "forward everything" mode. This is intentional (explicit wire format) but creates a coupling between the bus and the kernel event catalog.

### 5.4 `MultiAgentHost.status()` aggregates are inconsistent

`MultiAgentHost.status()` returns a merged view of `pending` (from host's own map), `live` (from coordinator.getStatus()), and `completed` (from host's results array). The `live` count excludes `stopped` subagents but the `pending` count includes tasks for subagents that have already been stopped. After a `stopAll()`, the status can show "3 pending" while the coordinator shows 0 live subagents.

### 5.5 Bridge `timeoutMs` parameter in `Director.ask()` is optional but meaningful

`Director.ask<T>(subagentId, payload, timeoutMs?)` defaults to the bridge's own 30s timeout if omitted. The director's preamble mentions "synchronously query" but doesn't establish explicit timeout expectations. A subagent that silently hangs on a bridge `request` will cause `ask()` to hang for up to 30 seconds before the director's LLM can react.

---

## 6. Feature & Fix Roadmap (as of 0.1.8)

### ✅ Completed — Phase 6 Safety & Polish

| # | Action | Files | Status |
|---|--------|-------|--------|
| F1 | `maxSpawnDepth` enforcement | `director.ts` (already in `spawn()`) | ✅ Done |
| F2 | `directorBudget: { maxCostUsd }` option | `director.ts`, `director-tools.ts` | ✅ Done |
| F3 | `maxBudgetExtensions` configurable | `director.ts` | ✅ Done |
| F4 | `checkpointDebounceMs` in `DirectorOptions` | `director.ts`, `director-state.ts` | ✅ Done |
| F6 | `fleet (action: session)` tool | `director-tools.ts`, `director.ts` | ✅ Done |
| F7 | `fleet (action: health)` tool | `director-tools.ts`, `director.ts` | ✅ Done |
| — | `FleetSpawnBudgetError` exported + surfaced in `spawn_subagent` tool | `director.ts`, `director-tools.ts` | ✅ Done |
| — | `MultiAgentHostOptions` extended with `directorBudget`, `maxBudgetExtensions`, `checkpointDebounceMs` | `packages/cli/src/multi-agent.ts` | ✅ Done |

### 🔲 Remaining — Phase 6 Completion

| # | Action | Files | Rationale |
|---|--------|-------|-----------|
| R1 | `--resume <runId>` crash recovery | `director-state.ts`, CLI | Checkpoint survives crashes; resume banner needs lock-file re-attach |
| R2 | Hostile-prompt test pack | `director.test.ts` | Verify bridge contract prevents parent-context exfiltration |
| R3 | `wstack sessions ls <runId>` | CLI subcommands | Inspect fleet artifacts |
| R4 | TUI fleet panel | `packages/tui/src/components/fleet-panel.tsx` | Shipped compact status summary; full monitor also lives in `packages/tui/src/components/fleet-monitor.tsx` |
| R5 | Dedicated full-page WebUI fleet dashboard | `packages/webui/` | The live `FleetPanel` is shipped; a dedicated dashboard remains optional follow-up |
| R6 | Fleet-aware replay | CLI, core | Extend existing `wstack replay` support to understand director/fleet run ids |
| R7 | `fleet (action: session)` subagent-side bridge handler | `agent-subagent-runner.ts` | Subagent responds to `session_read` bridge messages |
| R8 | `redirect` tool | `director-tools.ts` | Mid-flight task reassignment |
| R9 | `classifySubagentError` case normalization | `multi-agent-coordinator.ts:626` | Use `lower` for `empty_response` / `tool_failed` regexes |

### 🔲 Priority 3 — Remaining Bug Fixes

| # | Action | Files | Rationale |
|---|--------|-------|-----------|
| B1 | `MultiAgentHost.status()` inconsistent after stopAll | `multi-agent.ts` | Pending count includes stopped subagent tasks |
| B2 | Optional core-level `sharedScratchpadPath` default | `director.ts` | CLI-hosted sessions already pass `<fleetRoot>/shared`; direct embedders must opt in |
| B3 | `SUBAGENT_TIMEOUT_BUFFER_MS` configurable | `delegate-tool.ts` | Hardcoded 30s buffer; make configurable |
| B4 | `partial.lastAssistantText` in delegate failure output | `delegate-tool.ts` | LLM should see actual partial output |

### 🔲 Priority 4 — Nice to Have

| # | Action | Files | Rationale |
|---|--------|-------|-----------|
| N1 | Calibrate per-role budget presets from production telemetry | `fleet.ts` | All 50 phase roles have profiles; tune thresholds from observed workloads |
| N2 | Tighter preamble variants for small vs large director models | `director-prompts.ts` | Model-aware fleet protocol guidance |

---

## Summary

The Director orchestration system is architecturally sound — isolation invariants are correct, the tool set is well-designed, and the state checkpoint mechanism provides a foundation for crash recovery. The primary gaps are:

1. **Phase 6 items** (safety caps at tool layer, quota guard, crash recovery tests) — these are prerequisite for production reliability
2. **Remaining bridge gaps** (`fleet (action: session)` subagent-side bridge handler) — the Director can read JSONL directly today, but subagent-side session-read handling is still listed as future work
3. **UX gaps** (`wstack sessions ls`, dedicated WebUI fleet dashboard) — the TUI has fleet/agents monitors, but CLI artifact browsing and WebUI fleet observability are still thinner than the runtime capabilities

The most impactful single improvement is **F4: crash recovery test + `--resume` implementation**, because without it, any director process crash loses all in-flight task state regardless of how well the checkpoint mechanism works.

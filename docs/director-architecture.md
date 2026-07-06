# Director Orchestration Architecture

> Comprehensive analysis and improvement roadmap for the Director / multi-agent fleet system.

**Status as of 0.270.0** — All core phases shipped; ongoing refinement of subagent budget negotiation, error classification, and fleet observability.

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
| `createDelegateTool` | `packages/core/src/coordination/delegate-tool.ts` | Single-tool spawn+assign+await bundling with auto-promotion to director mode. |

### Director Tools (10 total — as of this release)

| Tool | Purpose |
|------|---------|
| `spawn_subagent` | Create a worker from roster role or explicit config. Returns subagent id. |
| `assign_task` | Hand a task to a specific subagent. Returns task id. |
| `await_tasks` | Block until named task ids complete. |
| `ask_subagent` | Synchronous bridge request to a running subagent (e.g. "summarize progress"). |
| `roll_up` | Aggregate completed task results into markdown or JSON. |
| `terminate_subagent` | Forcibly abort a subagent. |
| `fleet (action: status)` | Snapshot of all subagents and pending/completed task counts. |
| `fleet (action: usage)` | Token + cost breakdown per subagent and fleet-total. |
| `fleet (action: session)` | Read a subagent's JSONL transcript and extract last assistant text, stop reason, and tool-use count. |
| `fleet (action: health)` | Per-subagent health snapshot: budget pressure, last activity timestamp, and status. |

### Pre-built Fleet Roster

| Role | File | Purpose |
|------|------|---------|
| `audit-log` | `fleet.ts` | Session log analysis, pattern detection, audit reports |
| `bug-hunter` | `fleet.ts` | Systematic bug and code smell detection |
| `refactor-planner` | `fleet.ts` | Architecture analysis, phased refactoring plans |
| `security-scanner` | `fleet.ts` | Secret detection, injection vectors, CVE scanning |

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
│  Tools: spawn_subagent, assign_task, await_tasks, ask_subagent,  │
│         roll_up, terminate_subagent, fleet (action: status), fleet (action: usage)  │
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

**Isolation is absolute.** Two sibling subagents never share a `Context`, `SessionWriter`, `TokenCounter`, or in-flight tool state. Communication is only via `AgentBridge` (parent-mediated).

**Director is not an Agent.** `Director` is a coordinator + observability surface. To make it LLM-driven, construct an `Agent` with `director.tools()` registered. This keeps the construction symmetric with how other agents are built and avoids smuggling an LLM dependency into core.

**Budget is explicit.** No implicit caps. The orchestrator picks budgets per task. `SubagentBudget` enforces hard stops; `FleetSpawnBudgetError` enforces fleet-wide spawn caps.

**State survives crashes.** `DirectorStateCheckpoint` writes incremental snapshots on every mutation. `fleet.json` is the final manifest. Per-subagent JSONLs provide full replay capability.

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
| WebUI fleet tab | Fleet observability in web UI | 🔲 Pending |
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

#### `--director` CLI flag ✅ Shipped (0.1.8)

Added `director` to `BOOLEAN_FLAGS` in `arg-parser.ts`. Running `wrongstack --director` starts a session in director mode from the outset — no need for `/director` slash command or delegate tool promotion.

#### Partial session artifact CLI support

Fleet artifacts are written. `wstack replay` exists for session-event replay, but there is still no first-class `wstack sessions ls <runId>` command dedicated to listing fleet artifacts for a run.

#### Fleet observability surface

`FleetBus` events are emitted and consumed by the TUI. `FleetMonitor` (`Ctrl+F` / `F2`) shows the orchestration dashboard, `AgentsMonitor` (`Ctrl+G` / `F3`) shows per-agent live context, and `FleetPanel` renders the compact status-bar summary. WebUI has collaboration/worktree streaming handlers but does not yet have an equivalent dedicated fleet dashboard.

### 4.5 Error Handling

#### `delegate` partial output in hints ✅ Shipped (0.1.8)

`hintForKind` now accepts an optional `partial?: { lastAssistantText?: string }` parameter. For `budget_timeout`, `budget_cost`, and `tool_failed` cases, the hint now includes the actual partial output produced before failure. LLM no longer gets generic advice when the real work is available.

### 4.6 Prompt Engineering

#### `DEFAULT_DIRECTOR_PREAMBLE` is not model-aware

The preamble uses generic fleet rules. For planner-class models, more explicit "think step by step before spawning" guidance could reduce premature spawning. For fast models, more directive "always decompose before spawning" rules could improve planning.

#### Subagent baseline has no "stop early" signal

The `DEFAULT_SUBAGENT_BASELINE` tells subagents to "be concise, structured, and self-contained" but provides no guidance on when to stop iterating (e.g. "if you've made 3 tool calls without meaningful progress, report back with what you tried"). Subagents in long-running tasks may exhaust their budget without producing useful output.

#### Shared scratchpad is opt-in

The scratchpad path must be explicitly passed to `Director`. If a director spawns multiple subagents without setting `sharedScratchpadPath`, they cannot coordinate via files. Making the scratchpad default to `<sessionsRoot>/<runId>/shared/` would make fleet coordination more discoverable.

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
| R5 | WebUI fleet tab | `packages/webui/` | Fleet observability in web UI |
| R6 | Fleet-aware replay | CLI, core | Extend existing `wstack replay` support to understand director/fleet run ids |
| R7 | `fleet (action: session)` subagent-side bridge handler | `agent-subagent-runner.ts` | Subagent responds to `session_read` bridge messages |
| R8 | `redirect` tool | `director-tools.ts` | Mid-flight task reassignment |
| R9 | `classifySubagentError` case normalization | `multi-agent-coordinator.ts:626` | Use `lower` for `empty_response` / `tool_failed` regexes |

### 🔲 Priority 3 — Remaining Bug Fixes

| # | Action | Files | Rationale |
|---|--------|-------|-----------|
| B1 | `MultiAgentHost.status()` inconsistent after stopAll | `multi-agent.ts` | Pending count includes stopped subagent tasks |
| B2 | `sharedScratchpadPath` default to `<sessionsRoot>/<runId>/shared/` | `director.ts` | Fleet coordination more discoverable |
| B3 | `SUBAGENT_TIMEOUT_BUFFER_MS` configurable | `delegate-tool.ts` | Hardcoded 30s buffer; make configurable |
| B4 | `partial.lastAssistantText` in delegate failure output | `delegate-tool.ts` | LLM should see actual partial output |

### 🔲 Priority 4 — Nice to Have

| # | Action | Files | Rationale |
|---|--------|-------|-----------|
| N1 | Per-role budget presets in `FLEET_ROSTER_BUDGETS` for more roles | `fleet.ts` | Only 4 roles have budgets |
| N2 | Tighter preamble variants for small vs large director models | `director-prompts.ts` | Model-aware fleet protocol guidance |
| N3 | `wrongstack --director` CLI flag | CLI arg parser | Start sessions in director mode from the outset |

---

## Summary

The Director orchestration system is architecturally sound — isolation invariants are correct, the tool set is well-designed, and the state checkpoint mechanism provides a foundation for crash recovery. The primary gaps are:

1. **Phase 6 items** (safety caps at tool layer, quota guard, crash recovery tests) — these are prerequisite for production reliability
2. **Remaining bridge gaps** (`fleet (action: session)` subagent-side bridge handler) — the Director can read JSONL directly today, but subagent-side session-read handling is still listed as future work
3. **UX gaps** (`wstack sessions ls`, dedicated WebUI fleet dashboard) — the TUI has fleet/agents monitors, but CLI artifact browsing and WebUI fleet observability are still thinner than the runtime capabilities

The most impactful single improvement is **F4: crash recovery test + `--resume` implementation**, because without it, any director process crash loses all in-flight task state regardless of how well the checkpoint mechanism works.

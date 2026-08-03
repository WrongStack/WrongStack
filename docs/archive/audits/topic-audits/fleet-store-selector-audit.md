# FleetStore Selector Audit

**Task:** Audit FleetStore selectors for the redesigned AgentsPanel
**Date:** 2026-07-19
**Scope:** `packages/webui/src/stores/fleet-store.ts` + all consumers

---

## Store shape (fleet-store.ts)

```
FleetState {
  agents: Map<string, SubagentView>        // raw mutable Map
  leaderId: string | undefined
  fleetTokensIn: number                     // delta-tracked, drifts on removal
  fleetTokensOut: number                    // delta-tracked, drifts on removal
  fleetConcurrency: number
  fleetConcurrencyMax: number
  eventTimeline: FleetTimelineEvent[]       // last 20 events
  agentTimeline: AgentTranscriptEntry[]     // last 500
  agentTranscripts: Map<string, AgentTranscriptEntry[]>  // per-agent, last 1000
  applyEvent: (e: SubagentEvent) => void
  pushAgentTimelineEntry: (...) => void
  clear: () => void
  getAgentsBySession: (sessionId) => SubagentView[]    // non-reactive getter
  getAgentTranscript: (subagentId) => AgentTranscriptEntry[]  // non-reactive getter
}
```

## All consumers (13 components)

| Component | Subscriptions | Manual derived state | Duplication |
|-----------|--------------|---------------------|-------------|
| **activity-bar/index.tsx** | `Array.from(s.agents.values()).filter(running).length` | running count | Running count inline |
| **AgentsPanel.tsx** | `s.agents` | `Array.from()` + sort by status+started + running count | Sort + count logic |
| **InspectorPanel.tsx** | `s.agents`, `s.leaderId`, `s.fleetTokensIn`, `s.fleetTokensOut`, `s.fleetConcurrency`, `s.fleetConcurrencyMax`, `s.eventTimeline` | `sortFleet()`, `runningCount`, `totalCost` via reduce | Sort + cost + count logic |
| **InspectorTrigger** | `Array.from(s.agents.values()).filter(running).length` | running count | Running count inline |
| **FleetMonitor.tsx** | `s.agents`, `s.leaderId`, `s.fleetTokensIn`, `s.fleetTokensOut`, `s.fleetConcurrency`, `s.fleetConcurrencyMax`, `s.eventTimeline`, `s.agentTimeline`, `s.agentTranscripts.get(id)` | sort, `tallyAgents`, `totalCost` via reduce | Sort + cost + count |
| **FleetMonitor AgentCard** | `s.agentTranscripts.get(id)` | - | Transcript fetch |
| **FleetPanel.tsx** | `s.leaderId`, `s.agentTranscripts.get(id)` | uses `compareAgentsByActivity` + `tallyAgents` from lib | Sort + count |
| **AgentsMonitor.tsx** | `s.agents`, `s.agentTranscripts.get(id)` | - | Raw map access |
| **AgentsPage.tsx** | `s.agents`, `s.agentTranscripts.get(id)` | - | Raw map access |
| **OfficeMapCanvas.tsx** | `s.agents`, `s.agentTranscripts` | - | Raw map access |
| **ContextDashboard.tsx** | `s.agents` | - | Raw map access |
| **KanbanView.tsx** | `s.agents` | - | Raw map access |
| **SessionPanel.tsx** | `s.agents` | - | Raw map access |
| **WorkspaceDock.tsx** | `s.agents` | - | Raw map access |
| **AgentOfficeView.tsx** | `state.agents` | - | Raw map access |

## Key findings

### 1. No computed selectors exist
Every consumer receives the raw `Map<string, SubagentView>` and manually:
- Converts to array (`Array.from(map.values())`)
- Sorts (duplicated sort logic in 5+ places)
- Filters by status
- Computes totals (cost, counts)

### 2. Three sort implementations floating
- **InspectorPanel.tsx**: `sortFleet()` — leader-first, then running-first, then by startedAt
- **FleetMonitor.tsx**: inline sort — leader-first, then `compareAgentsByActivity`
- **FleetPanel.tsx**: plain `compareAgentsByActivity` (no leader pinning)
- **AgentsPanel.tsx**: inline sort — running-first, then by startedAt (no leader pinning)

### 3. Helper usage is inconsistent
`compareAgentsByActivity` and `tallyAgents` from `lib/agent-status.ts` are imported by:
- FleetMonitor.tsx ✓
- FleetPanel.tsx ✓
- InspectorPanel.tsx — **NO** (has its own `sortFleet()` and inline counting)

AgentsPanel.tsx — **NO** (has its own inline sorting/counting)

### 4. `fleetTokensIn`/`fleetTokensOut` can drift
- Delta-tracked in `applyEvent` (lines 360-367): `fleetTokensIn - prev.tokensIn + e.tokensIn`
- **NOT reset** when individual agents are removed (lines 196-210)
- **Reset** only on `session_stopped` (lines 186-193) or `clear()`
- If agents from different sessions interleave, token totals become stale

### 5. `getAgentTranscript` is non-reactive
- Defined as `get().agentTranscripts.get(id) ?? EMPTY_AGENT_TRANSCRIPT`
- Components that want reactivity use inline `(s) => s.agentTranscripts.get(agent.id)` which returns a **new array reference every time** — no shallow equality possible

### 6. No `clearFinishedAgents()` action
FleetMonitor and the planned AgentsPanel both want a "clear finished" button, but there's no store action for it — each component would have to call `applyEvent` with a synthetic event or manipulate the store directly.

## Required selectors for redesigned AgentsPanel

### `selectFleetSummary` (from raw agents Map)
```ts
interface FleetSummary {
  running: number;
  completed: number;
  failed: number;    // failed + timeout
  total: number;
  totalCost: number;
  tokensIn: number;
  tokensOut: number;
  concurrency: number;
  concurrencyMax: number;
}
```
Used by: FleetSummaryBar, InspectorPanel header, FleetMonitor header, FleetPanel header

### `selectSortedAgentList` (from raw agents Map + leaderId)
```ts
// Returns SubagentView[] sorted:
//   1. Leader (isLeader === true) first
//   2. Running agents next (status === 'running')
//   3. Then by startedAt ascending
// Memoized: only re-derives when Map size/identity changes or leaderId changes
```
Used by: AgentsPanel (roster), InspectorPanel (fleet list), FleetMonitor, FleetPanel

### `selectAgentById(id)` (from raw agents Map)
```ts
// Returns SubagentView | undefined
// Stable reference per agent id — doesn't create new object on every call
```
Used by: detail views in InspectorPanel, FleetMonitor, FleetPanel

### `selectRunningCount` (derived from fleetSummary)
```ts
// Just the running count — used by activity bar badge and InspectorTrigger
```
Used by: activity-bar badge, InspectorTrigger button

## Store action gaps

| Missing action | Consumers that need it |
|---------------|----------------------|
| `clearFinishedAgents()` — removes all completed/failed/timeout/stopped agents | AgentsPanel, FleetMonitor |
| `selectAgentTranscript(id)` — reactive transcript selector | All AgentCard views (6+ components) |

## Recommended implementation approach

1. Add derived selectors using zustand's `createSelector` pattern (no extra deps):
   - Each selector subscribes to the raw `agents` Map and re-derives only when relevant
   - Use shallow equality or manual memoization to return stable references

2. Add `clearFinishedAgents` action to the store:
   ```ts
   clearFinishedAgents: () => set((state) => {
     const survivors = new Map(state.agents);
     const removedIds = new Set<string>();
     for (const [id, agent] of survivors) {
       if (agent.status !== 'running') {
         survivors.delete(id);
         removedIds.add(id);
       }
     }
     return {
       agents: survivors,
       agentTimeline: state.agentTimeline.filter(e => !removedIds.has(e.subagentId)),
       // eventTimeline retained for history
     };
   })
   ```

3. Add `clear()` side-effect to fix token drift:
   - On individual agent removal (kind==='removed'), also recompute `fleetTokensIn/Out` by summing remaining agents' tokens

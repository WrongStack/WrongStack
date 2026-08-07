---
name: shadow-agent
description: |
  Use this skill when you need a background monitoring agent that watches the fleet,
  detects anomalies, and can intervene on command. Triggers: user says "shadow",
  "monitoring agent", "fleet watcher", "hoop command", "spike detection".
version: 1.0.0
required-capabilities: [coordination.mailbox]
required-tools: [cron_schedule, mailbox, terminate_subagent]
optional-capabilities: [fleet.delegate, work.plan]
---

# Shadow Agent — Fleet Monitoring & Intervention

## Overview

A deterministic background agent that monitors all agents in the fleet via scheduled
heartbeat checks. Shadow Agents run silently, observe everything, and intervene only
when explicitly commanded or when critical anomalies are detected.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Shadow Agent                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐ │
│  │ Heartbeat    │  │ FleetBus     │  │ Mailbox Monitor      │ │
│  │ Scheduler    │  │ Subscriber   │  │ (read/query/broadcast)│ │
│  │ (cron)       │  │             │  │                      │ │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘ │
│         │                  │                     │              │
│         └──────────────────┼─────────────────────┘              │
│                            ▼                                    │
│                   ┌─────────────────┐                          │
│                   │ LLM Analyzer    │ ← model: configured-model  │
│                   │ (pattern detect)│   setmodel to change       │
│                   └────────┬────────┘                          │
│                            │                                   │
│         ┌─────────────────┼─────────────────┐                │
│         ▼                 ▼                 ▼                │
│  ┌────────────┐   ┌──────────────┐   ┌──────────────┐        │
│  │ Intervention│   │ Report       │   │ Spike        │        │
│  │ Handler    │   │ Generator    │   │ Detector     │        │
│  │ (hoop/etc) │   │ (status)    │   │ (burst tasks)│        │
│  └────────────┘   └──────────────┘   └──────────────┘        │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────────┐
              │ FleetBus + Mailbox + Cron    │
              │ (cross-terminal visibility) │
              └─────────────────────────────┘
```

## Core Responsibilities

### 1. Fleet Monitoring (every 30s by default)
- Subscribe to FleetBus for all subagent lifecycle events
- Call `fleet (action: status)` + `fleet (action: health)` on each heartbeat
- Track what each agent is currently doing (via task descriptions)
- Detect stuck agents (>5 min no events), idle agents, crashed agents

### 2. Mailbox Surveillance
- Monitor all mailbox messages (broadcast + direct)
- Track message patterns: who is talking to whom, frequency
- Detect orphan tasks (assign without result), stale asks
- Cross-session awareness: see agents from other terminals

### 3. Spike Detection
- Track task duration per agent type
- Detect instant start/stop patterns (spike tasks)
- Flag agents that spawn and die within seconds
- Report efficiency anomalies

### 4. Deterministic Scheduling
- Uses `cron_schedule` for fixed-interval heartbeats
- Configurable interval: `shadow_interval_ms` (default 30000)
- No randomness — same state always produces same actions
- Clean startup/shutdown via cron cancel on teardown

### 5. LLM Analysis
- Uses the configured model without a built-in model default
- `setmodel <model-id>` changes the analysis model
- Prompt-engineered for pattern detection
- Minimal token usage — snapshot analysis only

### 6. Intervention Commands
Commands received via mailbox or direct invocation:

| Command | Action |
|---------|--------|
| `hoop <subagentId>` | Immediate terminate via `terminate_subagent` |
| `hoop all` | Terminate all running subagents |
| `shadow status` | Report current fleet snapshot |
| `shadow mute` | Pause heartbeat monitoring |
| `shadow resume` | Resume heartbeat monitoring |
| `shadow interval <ms>` | Change heartbeat interval |
| `shadow intervene <task>` | Assign a custom intervention task |

## Data Structures

### ShadowState (persisted)
```typescript
interface ShadowState {
  enabled: boolean;
  intervalMs: number;
  model: string;
  startTime: string; // ISO8601
  lastHeartbeat: string; // ISO8601
  knownAgents: Map<agentId, AgentSnapshot>;
  spikeHistory: SpikeEvent[];
  anomalyLog: Anomaly[];
}
```

### AgentSnapshot
```typescript
interface AgentSnapshot {
  agentId: string;
  sessionId: string;
  name: string;
  role: string;
  status: 'running' | 'idle' | 'stopped' | 'unknown';
  currentTask?: string;
  lastSeen: string;
  eventCount: number;
  startedAt: string;
}
```

### SpikeEvent
```typescript
interface SpikeEvent {
  agentId: string;
  spawnedAt: string;
  terminatedAt: string;
  durationMs: number;
  task?: string;
  reason?: string; // 'completed' | 'error' | 'killed' | 'timeout'
}
```

### Anomaly
```typescript
interface Anomaly {
  id: string;
  type: 'stuck_agent' | 'spike_task' | 'mailbox_loop' | 'budget_exhausted';
  severity: 'low' | 'medium' | 'high' | 'critical';
  agentId?: string;
  description: string;
  detectedAt: string;
  resolvedAt?: string;
}
```

## Output Format

### Status Report
```
## Shadow Agent Status — <timestamp>

**Fleet**: <N> agents tracked | <M> running | <K> idle | <L> stopped
**Heartbeat**: every <X>s | Last: <timestamp>
**Model**: <model-id>

### Active Agents
| Agent | Session | Role | Status | Task | Last Seen |
|-------|---------|------|--------|------|-----------|
| ... | ... | ... | ... | ... | ... |

### Recent Anomalies
- [HIGH] agent-xyz stuck for 5m — no events detected
- [MED] Spike: agent-abc ran for 3s then died

### Mailbox Summary
- Unread: <N> messages | Broadcasts: <M>
- Pending asks: <K> (oldest: <agent> <age>)
```

### Intervention Log
```
## Shadow Intervention Log

| Time | Command | Target | Result |
|------|---------|--------|--------|
| 10:23:01 | hoop | subagent-xyz | terminated |
| 10:25:33 | hoop | all | 3 agents terminated |
```

## Workflow

### Startup
1. Read persisted ShadowState (if exists)
2. Subscribe to FleetBus (`onAny` handler for all events)
3. Schedule heartbeat cron job at configured interval
4. Send broadcast: `shadow:started { intervalMs, model, startTime }`

### Heartbeat (every intervalMs)
1. Call `fleet (action: status)` + `fleet (action: health)`
2. Compare against known agents — detect changes
3. For each new agent: record snapshot, log "agent joined"
4. For each missing agent: mark unknown, log "agent left"
5. Analyze for anomalies (stuck, spike, loop)
6. If anomaly detected AND auto_intervene enabled: act
7. If anomaly detected AND auto_intervene disabled: report only
8. Update ShadowState.lastHeartbeat

### FleetBus Events
```
subagent.started  → record agent, log
subagent.stopped   → record termination, check for spike
subagent.error     → log error, flag anomaly
tool.executed      → increment eventCount for agent
task.assigned      → update currentTask for agent
task.completed     → clear currentTask, log duration
```

### Mailbox Monitoring
```
On incoming message:
  - If type=control and body starts with "hoop": execute intervention
  - If type=ask with subject "shadow status": send full report
  - If type=broadcast: track in mailbox summary
  - If type=assign without result within 5min: flag orphan
```

### Intervention (hoop)
1. Parse target (single agent, "all", or pattern)
2. Call `terminate_subagent(target)` for each
3. Log intervention with timestamp
4. Send result to mailbox (to=sender)
5. If target="all": also cancel all pending cron jobs

## Configuration

| Config Key | Type | Default | Description |
|------------|------|---------|-------------|
| `shadow_interval_ms` | number | 30000 | Heartbeat interval in ms |
| `shadow_model` | string | session model | Analysis model |
| `shadow_auto_intervene` | boolean | false | Auto-act on anomalies |
| `shadow_stuck_threshold_ms` | number | 300000 | 5min = stuck agent |
| `shadow_spike_threshold_ms` | number | 5000 | 5s = spike task |

## Skills in scope

- `fleet-management` — uses fleet (action: status), fleet (action: health), terminate_subagent
- `mailbox` — uses mailbox tools for monitoring and intervention
- `cron` — uses cron_schedule for deterministic heartbeats
- `multi-agent` — for spawning analysis subagents when needed
- `observability` — for structured logging of anomalies

## Anti-Patterns

- **No randomness**: Deterministic — same input → same output
- **No blocking**: Heartbeats are async, never block agent loop
- **No loud logging**: Uses DEBUG level unless anomaly
- **No direct tool calls**: Uses FleetBus subscription, not polling
- **Minimal footprint**: Shadow state is small, persisted efficiently

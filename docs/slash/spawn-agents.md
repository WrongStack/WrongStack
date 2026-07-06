# /spawn · /agents · /director — Multi-Agent Commands

## /spawn

Spawns an isolated subagent to handle a specific task. The subagent gets its own fresh `Context`, `Agent`, `EventBus`, and session JSONL — completely isolated from the leader's state.

Requires director mode. Run `/director` first or start with `wstack --director`.

**Flags:**
```
/spawn [--name=<label>] [--model=<id>] <task description>
```

| Flag | Effect |
|---|---|
| `--name` | Display name for the subagent in fleet status |
| `--provider` | Override the provider (defaults to leader provider) |
| `--model` | Override the model (defaults to leader model) |
| `--tools` | Comma-separated list of tool names the subagent can use |

For smart routing (auto-picking the right agent role), use `/fleet dispatch`.
For explicit role assignment, use `/fleet spawn <role>`.

Returns a summary of what was spawned.

## /agents

Shows status of all spawned subagents: their name, current task, status (pending/running/done/failed), and iteration count.

**Monitor overlay:**
```
/agents monitor     — open the agents monitor overlay
/agents on          — show the agents monitor overlay
/agents off         — hide the agents monitor overlay
/agents stream on   — show subagent text output in chat history
/agents stream off  — hide subagent text output from chat history (default)
```

**Note:** The agents monitor overlay is available in the TUI via **Ctrl+G**. In plain REPL, use `/agents monitor` to open it.

The monitor overlay shows every known subagent with status, elapsed time, iteration/tool counts, an activity sparkline, the current tool, a global concurrency gauge, token/cost totals, and a compact event timeline.

**With an id:**
```
/agents <subagent-id>
```
Returns a detailed live monitor view for that specific subagent: status, current task, pending tasks, completed tasks with stats, and (when director is active) cost/iterations/toolCalls from `fleet (action: usage)`. If the id is not found, returns an error.

**Without an id:** Returns the summary table of all subagents.

## /director

Promotes the session to director mode, enabling fleet orchestration tools. Only works **before** any subagents are spawned — the coordinator must not already be active.

Returns error if subagents already exist, or success message with director state summary.

### Fleet orchestration tools (available after `/director` or `--director`)

When director mode is active, the leader agent gains these tools automatically:

| Tool | What it does |
|---|---|
| `spawn_subagent` | Create a new subagent by role (roster) or by name/provider/model |
| `assign_task` | Hand a task to a previously spawned subagent |
| `await_tasks` | Wait for one or more tasks to complete, with optional timeout |
| `ask_subagent` | One-shot question to a running subagent, returns answer |
| `fleet (action: status)` | Snapshot of all subagent statuses and active tasks |
| `fleet (action: usage)` | Token + cost breakdown per subagent and fleet-wide |
| `fleet (action: session)` | Read a subagent's JSONL transcript (full or last N lines) |
| `fleet (action: health)` | Budget pressure, last activity, status per subagent |
| `roll_up` | Aggregate completed task results from multiple subagents |
| `terminate_subagent` | Stop a running subagent early |

### TUI — Live Fleet Panel

When running in the TUI with director mode active, a **Fleet Panel** renders below the status bar. It shows every subagent in real time:

```
Fleet │ 3 agents │ $0.042 · 2 active
●  bug-hunter    anthropic/anthropic-test-model · 12it  31tc · $0.012
  → grep (230ms)
  tools: ok read (1.2KB 45L) | fail bash (89ms)
  msg: analyzing test file /app/src/utils.test.ts
●  refactor-planner openai/gpt-4o · 7it  18tc · $0.018
  → Read 3 files
  msg: identifying components to extract
  log: ~/.wrongstack/sessions/abc123/subagents/run-1/abc456.jsonl
✓  audit-log     anthropic/fast-model · 3it  9tc · $0.004
```

Each row shows:
- **Status icon**: `○` idle · `●` running · `✓` success · `✗` failed · `⏱` timeout · `⊘` stopped
- **Name + provider/model**
- **Iteration count** (`Xit`) and **tool-call count** (`Xtc`)
- **Running cost** (`$X.XXX`)
- **Current tool** with elapsed time (only while a tool is mid-flight)
- **Last 2 tools** with ok/fail status, duration, and output size/lines
- **Last 2 messages** (assistant text, truncated to 80 chars)
- **⚡ budget pressure warning** when a subagent is approaching a limit
- **Streaming text tail** (last 80 chars, live while `provider.text_delta` fires)
- **JSONL transcript path** (dim, for grep/tail)

### FleetBus — all events surfaced in the TUI

The TUI subscribes to all FleetBus events from every subagent. The following events are handled:

| Event | Effect |
|---|---|
| `session.started` | Subagent entry appears in FleetPanel immediately |
| `iteration.started` | Status → `running`, panel row appears if not yet visible |
| `provider.text_delta` | Streaming text buffered; flushed to recentMessages + leader history (`/fleet stream on`) |
| `provider.thinking_delta` | Extended thinking output buffered same as text_delta |
| `provider.response` | FleetPanel cost updated from `FleetUsageAggregator` |
| `provider.retry` | `warn` entry injected into leader chat history |
| `provider.error` | `error` entry injected into leader chat history |
| `tool.started` | `currentTool` set — FleetPanel shows `→ <tool>` |
| `tool.executed` | `recentTools` updated; `currentTool` cleared; toolCalls++ |
| `compaction.fired` | `info` entry in leader chat |
| `compaction.failed` | `warn` entry in leader chat |
| `token.threshold` | `info` entry in leader chat |
| `budget.threshold_reached` | FleetPanel shows `⚡ hitting <kind> limit (used/limit)` |
| `task.completed` | FleetPanel status → `success`/`failed`/`timeout`; cost finalized |

### `/fleet stream on|off` — subagent output in leader chat history

By default, subagent activity is **hidden** from the leader's scrollback to keep it clean. Enable live streaming:

```
/fleet stream on   # inject subagent text_delta into leader history
/fleet stream off  # hide (default)
```

Streaming appends subagent text to leader chat as `info`-kind entries prefixed with the subagent name/label. The same toggle is available via `/agents stream on|off`.

### Asking a stuck subagent

When a subagent seems stuck, the director can ask it a one-shot question using `ask_subagent`. This bridges directly to the running subagent and returns its response without terminating or respawning:

```
Tool: ask_subagent
Input: { "subagentId": "abc123", "question": "What step are you on and why has no tool been called in 30s?" }
```

The subagent responds synchronously — the director gets the answer in the same turn and can decide whether to continue, give a hint, or terminate.

## Code reference

- `packages/cli/src/slash-commands/spawn-agents.ts`
- `packages/cli/src/multi-agent.ts` — `MultiAgentHost` wiring
- `packages/core/src/coordination/multi-agent-coordinator.ts`
- `packages/core/src/coordination/director.ts` — director orchestration
- `packages/core/src/coordination/director-tools.ts` — fleet tool factories
- `packages/core/src/coordination/fleet-bus.ts` — `FleetBus` event multiplexer
- `packages/tui/src/components/fleet-panel.tsx` — TUI live panel

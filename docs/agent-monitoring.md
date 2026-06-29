# Agent Monitoring System

> Real-time subagent conversation tracking, HQ streaming, and timeline visualization.

WrongStack's Agent Monitoring System gives you full visibility into what every subagent is doing — their conversations, tool calls, status changes, and transcripts — across three surfaces: the **CLI/TUI REPL**, the **HQ browser dashboard**, and the **filesystem**.

---

## Architecture

```
subagent (EventBus)
  → FleetBus (fan-in with subagentId attribution)
    → AgentMonitorService
      → In-memory virtual chat history (ring buffer, 50 entries/agent)
      → JSONL transcript (transcripts/<subagentId>/transcript.jsonl)
      → Local EventBus: agent.timeline.message, agent.status_changed
        → TUI: use-subagent-events.ts → chat history timeline entries
        → CLI: /agents stream on/off → toggle visibility
      → HQ bridge: hqPublisher.publishEvent('agent.message')
        → HQ Browser: 🤖 Agent timeline panel (live stream)
```

### Components

| Component | Package | Responsibility |
|-----------|---------|----------------|
| `AgentMonitorService` | `@wrongstack/core/coordination` | FleetBus listener, per-subagent virtual chat history, JSONL persistence, timeline event emission |
| `AgentMonitorEventBridge` | `@wrongstack/core/hq` | Forwards local agent events to HQ as `agent.message` / `agent.status` envelopes |
| `/agents` slash command | `@wrongstack/cli` | `stream on|off|list|show <id>` — agent monitoring controls |
| `use-subagent-events.ts` | `@wrongstack/tui` | TUI EventBus hook — renders agent timeline in chat history |
| HQ dashboard panel | `@wrongstack/cli` (hq-server.ts) | Browser-side agent timeline with status chips, icons, live stream |

---

## Event Types

### `agent.timeline.message` (local EventBus)

Fired by AgentMonitorService for each subagent conversational event:

```typescript
interface AgentTimelineMessageEvent {
  subagentId: string;
  agentName: string;
  content: string;
  kind: 'text' | 'tool_use' | 'error' | 'status';
  iteration: number;
  ts: string;          // ISO 8601
  toolName?: string;
  costUsd?: number;
}
```

**When it fires:**

| Kind | Triggered by |
|------|-------------|
| `text` | `provider.text_delta` — subagent's response text |
| `tool_use` | `tool.started` — subagent started a tool call |
| `tool_use` (as tool_result) | `tool.executed` — subagent finished a tool call (includes duration) |
| `status` | Every 5th `iteration.completed` — heartbeat |
| `status` | `iteration.completed` with system message |

### `agent.status_changed` (local EventBus)

Fired when a subagent's lifecycle state changes:

```typescript
interface AgentStatusChangedEvent {
  subagentId: string;
  agentName: string;
  status: 'spawned' | 'running' | 'completed' | 'failed' | 'timeout' | 'stopped' | 'budget_exhausted';
  ts: string;
  summary?: string;
  task?: string;
}
```

### `agent.message` / `agent.status` (HQ Protocol)

The same events forwarded to HQ as `HqEventEnvelope` with `type: 'agent.message'` or `type: 'agent.status'`.

---

## Usage

### CLI / TUI

```bash
/agents stream on        # Show agent conversations in main chat
/agents stream off       # Hide from main chat (still recorded)
/agents stream status    # Show current stream toggle state
/agents list             # List all known subagents
/agents show <id>        # Show transcript for a specific subagent
/agents                  # Legacy: show active subagent status
```

### HQ Browser Dashboard

```bash
# Terminal 1: Start HQ server
wstack --hq
# Opens http://127.0.0.1:3499

# Terminal 2: Connect a client
WRONGSTACK_HQ_URL=ws://127.0.0.1:3499/ws/client wrongstack --tui
# Spawn subagents — HQ 🤖 Agent timeline shows live conversations
```

The HQ dashboard shows:
- **Agent Timeline** section (auto-shows when events arrive)
- Each entry: agent name, status chip, tool icon, content preview, timestamp
- **Clear** button to reset the timeline

---

## Filesystem Layout

Per-subagent transcripts are written to the director's run directory:

```
<projectSessions>/<date>/sess_<ULID>/subagents/transcripts/
  <subagentId>/
    transcript.jsonl     # Append-only JSONL, one AgentTimelineEntry per line
```

Each JSONL line is a complete `AgentTimelineEntry`:

```json
{"id":"k3...","subagentId":"bug-hunter-1","agentName":"Bug Hunter","ts":"...","kind":"text","content":"Found SQL injection in users.php","iteration":3}
```

---

## Configuration

The AgentMonitorService is created in the CLI boot pipeline (`cli-main.ts`):

| Setting | Default | Description |
|---------|---------|-------------|
| `maxEntriesPerAgent` | 500 | Ring buffer size per subagent |
| `streamEnabled` | false | Initial stream toggle state |
| `transcriptsDir` | `<fleetRoot>/subagents/transcripts` | JSONL output directory |

The HQ bridge is wired automatically when `WRONGSTACK_HQ_URL` environment variable is set and an `hqPublisher` is created.

---

## Integration Points

### Adding a new surface (WebUI, Telegram, etc.)

1. Subscribe to `agent.timeline.message` and `agent.status_changed` on the local EventBus
2. Render entries in your UI — each entry has `agentName`, `content`, `kind`, and `iteration`
3. For streaming: disable/re-enable by calling `agentMonitor.setStreamEnabled(bool)`

### Custom HQ integration

The `agent.message` and `agent.status` HQ event types carry the same data as the local events. Subscribe to these on the HQ browser WebSocket to render agent conversations in any custom dashboard.

---

## Testing

```bash
# Run agent monitor unit tests (25 tests)
pnpm vitest run packages/core/tests/coordination/agent-monitor.test.ts

# Run all coordination tests
pnpm vitest run packages/core/tests/coordination/
```

Test coverage: lifecycle, stream toggle, subagent tracking, text/tool routing, ring buffer cap, JSONL persistence, onEntry callback, setFleetBus, edge cases, iteration heartbeat.

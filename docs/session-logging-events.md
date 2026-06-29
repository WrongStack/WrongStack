# Session Logging Events — Reference Documentation

> **English** | Version 1.0 | WrongStack Core

---

## Overview

WrongStack emits a comprehensive set of structured events during every session. These events serve three purposes:

1. **Durable audit log** — JSONL files enable session resume, rewind, crash recovery, and conversation replay
2. **Real-time observability** — EventBus powers live TUI/WebUI updates without reading disk
3. **Tamper-evident tool audit** — SHA-256 chained sidecar for forensic integrity

---

## Two-Tier Event Model

Session events are divided into two tiers controlled by the `session.auditLevel` config:

| Tier | Audit Level | Description |
|------|-------------|-------------|
| **Core Reconstruct** | `minimal`+ | Always persisted — required for correct resume/rewind/crash-recovery |
| **Audit Detail** | `standard`+ | High-value forensic events (tool calls, LLM requests, errors) |
| **Full Detail** | `full` | High-volume streaming events (tool progress) |

### Audit Levels

```typescript
type AuditLevel = 'minimal' | 'standard' | 'full';
```

| Level | Written Events |
|-------|---------------|
| `minimal` | Core Reconstruct Set only |
| `standard` (default) | Core + lightweight audit events |
| `full` | Everything including `tool_progress` |

---

## Event Type Reference

### Session Lifecycle

#### `session_start`
Emitted when a new session begins.

```typescript
{ type: 'session_start'; ts: string; id: string; model: string; provider: string }
```

| Field | Type | Description |
|-------|------|-------------|
| `ts` | `string` | ISO 8601 timestamp |
| `id` | `string` | Unique session identifier |
| `model` | `string` | Model identifier (e.g. `claude-sonnet-4-20250514`) |
| `provider` | `string` | Provider name (e.g. `anthropic`) |

---

#### `session_resumed`
Emitted when an existing session is reopened for continuation.

```typescript
{ type: 'session_resumed'; ts: string; id: string; model: string; provider: string }
```

---

#### `session_end`
Emitted when a session terminates cleanly.

```typescript
{ type: 'session_end'; ts: string; usage: Usage; pendingToolUses?: string[] }
```

| Field | Type | Description |
|-------|------|-------------|
| `usage` | `Usage` | Total token usage for the session |
| `pendingToolUses` | `string[]?` | Tool call IDs sent but not yet resolved (for crash recovery) |

---

### User / LLM Interaction

#### `user_input`
Emitted for every user message or content block submitted.

```typescript
{ type: 'user_input'; ts: string; content: string | ContentBlock[] }
```

> ⚠️ Content is passed through the configured `SecretScrubber` before logging.

---

#### `llm_request`
Emitted before each LLM API call. Lightweight by default.

```typescript
{
  type: 'llm_request';
  ts: string;
  model: string;
  messageCount: number;
  estimatedInputTokens?: number;
  toolCount?: number;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `messageCount` | `number` | Number of messages in the conversation context |
| `estimatedInputTokens` | `number?` | Estimated input token count |
| `toolCount` | `number?` | Number of tools offered to the model |

---

#### `llm_response`
Emitted after each LLM response is received.

```typescript
{
  type: 'llm_response';
  ts: string;
  content: ContentBlock[];
  stopReason: string;
  usage: Usage;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `content` | `ContentBlock[]` | Parsed response blocks (text, tool-use, etc.) |
| `stopReason` | `string` | Why the response stopped (`end_turn`, `tool_use`, etc.) |
| `usage` | `Usage` | Token usage for this response |

---

### Tool Execution

#### `tool_use`
Emitted when the model requests a tool.

```typescript
{ type: 'tool_use'; ts: string; name: string; id: string; input: unknown }
```

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Tool name (e.g. `read`, `bash`, `edit`) |
| `id` | `string` | Tool-use block ID (`toolu_xxxx`) for correlation |
| `input` | `unknown` | Tool arguments (scrubbed) |

---

#### `tool_result`
Emitted when a tool completes (success or error).

```typescript
{ type: 'tool_result'; ts: string; id: string; content: unknown; isError: boolean }
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Correlates with a prior `tool_use.id` |
| `content` | `unknown` | Tool output (scrubbed of secrets) |
| `isError` | `boolean` | Whether the tool returned an error |

---

#### `tool_call_start`
Emitted when the executor begins a tool call. Higher fidelity than `tool_use` — marks actual execution, not just model intent.

```typescript
{ type: 'tool_call_start'; ts: string; name: string; id: string; input: unknown }
```

---

#### `tool_call_end`
Emitted when a tool call finishes. Contains timing and size metrics.

```typescript
{
  type: 'tool_call_end';
  ts: string;
  name: string;
  id: string;
  durationMs: number;
  outputSize: number;        // Legacy — prefer outputBytes
  ok?: boolean;
  outputBytes?: number;      // UTF-8 bytes of the serialized result
  outputTokens?: number;     // Estimated tokens from outputBytes
  outputLines?: number;      // Line count for line-oriented tools
}
```

| Field | Type | Description |
|-------|------|-------------|
| `durationMs` | `number` | Wall-clock milliseconds for execution |
| `outputSize` | `number` | Legacy field — byte size of output |
| `outputBytes` | `number?` | Full UTF-8 byte length post-cap and post-scrub |
| `outputTokens` | `number?` | Estimated token count (~3.5 chars/token) |
| `outputLines` | `number?` | Actual lines the model received |
| `ok` | `boolean?` | Whether execution succeeded |

---

#### `tool_progress`
Emitted for streaming tool output (only at `auditLevel: 'full'`). Lightweight sampled.

```typescript
{
  type: 'tool_progress';
  ts: string;
  name: string;
  id: string;
  event: {
    type: 'log' | 'warning' | 'metric' | 'file_changed' | 'partial_output';
    text?: string;
    data?: Record<string, unknown>;
  };
}
```

> Sampling: `warning`, `metric`, `file_changed` always pass. `log` and `partial_output` are sampled 1-in-N (default N=8).

---

### Context Management

#### `compaction`
Emitted when the context window is compacted to stay within limits.

```typescript
{
  type: 'compaction';
  ts: string;
  before: number;           // Tokens before compaction
  after: number;            // Tokens after compaction
  level?: 'warn' | 'soft' | 'hard';
  aggressive?: boolean;
  reductions?: Array<{ phase: string; saved: number }>;
  digest?: string;          // Lossless digest of collapsed range
}
```

| Field | Type | Description |
|-------|------|-------------|
| `before` | `number` | Token count before compaction |
| `after` | `number` | Token count after compaction |
| `level` | `string?` | Pressure that triggered compaction |
| `aggressive` | `boolean?` | Whether summary mode was used |
| `reductions` | `array?` | Per-phase savings breakdown |
| `digest` | `string?` | What was collapsed (for forensics) |

---

#### `message_truncated`
Emitted when a message exceeds the configured max output and is truncated.

```typescript
{ type: 'message_truncated'; ts: string; before: number; after: number }
```

---

### Error Handling

#### `error`
Emitted for agent-level errors.

```typescript
{ type: 'error'; ts: string; message: string; phase: string }
```

| Field | Type | Description |
|-------|------|-------------|
| `message` | `string` | Error description |
| `phase` | `string` | Where the error occurred |

---

#### `provider_retry`
Emitted before each retry of a failed provider call.

```typescript
{
  type: 'provider_retry';
  ts: string;
  providerId: string;
  attempt: number;         // 1-based
  delayMs: number;
  status?: number;
  description: string;
}
```

---

#### `provider_error`
Emitted when a provider call ultimately fails (retries exhausted or non-retryable).

```typescript
{
  type: 'provider_error';
  ts: string;
  providerId: string;
  status?: number;
  description: string;
  retryable: boolean;
}
```

---

### Checkpointing & Recovery

#### `checkpoint`
Emitted after each user input is processed — marks a resumption point.

```typescript
{ type: 'checkpoint'; ts: string; promptIndex: number; promptPreview: string }
```

| Field | Type | Description |
|-------|------|-------------|
| `promptIndex` | `number` | Index for rewind targeting |
| `promptPreview` | `string` | First ~50 chars for human readability |

---

#### `file_snapshot`
Emitted after file changes are detected.

```typescript
{ type: 'file_snapshot'; ts: string; promptIndex: number; files: FileSnapshot[] }

type FileSnapshot = {
  path: string;
  action: 'created' | 'modified' | 'deleted';
  before: string | null;
  after: string | null;
};
```

---

#### `rewound`
Emitted after a session is rewound to a prior checkpoint.

```typescript
{ type: 'rewound'; ts: string; toPromptIndex: number; revertedFiles: string[] }
```

---

#### `in_flight_start`
Emitted at the start of a long-running operation (marks "what was being done if we crash").

```typescript
{ type: 'in_flight_start'; ts: string; context: string }
```

> Example: `"iteration 14 / tool: read / id: tu-7"`

---

#### `in_flight_end`
Emitted on clean exit of a long-running operation.

```typescript
{ type: 'in_flight_end'; ts: string; reason: 'clean' | 'aborted' | 'recovered' }
```

---

### Task Management

#### `task_created`
```typescript
{ type: 'task_created'; ts: string; taskId: string; title: string }
```

#### `task_updated`
```typescript
{ type: 'task_updated'; ts: string; taskId: string; status: string }
```

#### `task_completed`
```typescript
{ type: 'task_completed'; ts: string; taskId: string; title: string }
```

#### `task_failed`
```typescript
{ type: 'task_failed'; ts: string; taskId: string; title: string; error: string }
```

---

### Multi-Agent

#### `agent_spawned`
```typescript
{ type: 'agent_spawned'; ts: string; agentId: string; role: string }
```

#### `agent_stopped`
```typescript
{ type: 'agent_stopped'; ts: string; agentId: string }
```

#### `agent_error`
```typescript
{ type: 'agent_error'; ts: string; agentId: string; error: string }
```

---

### Planning & Skills

#### `spec_parsed`
```typescript
{ type: 'spec_parsed'; ts: string; specId: string; title: string; completeness: number }
```

#### `spec_analyzed`
```typescript
{ type: 'spec_analyzed'; ts: string; specId: string; gaps: string[] }
```

#### `skill_activated`
```typescript
{ type: 'skill_activated'; ts: string; skillName: string }
```

#### `skill_deactivated`
```typescript
{ type: 'skill_deactivated'; ts: string; skillName: string }
```

---

### Mode Changes

#### `mode_changed`
```typescript
{ type: 'mode_changed'; ts: string; from: string; to: string }
```

---

## Audit Level Tiers (Summary)

### Core Reconstruct Events (always written)
```
session_start, session_resumed, user_input, llm_response, tool_result,
checkpoint, file_snapshot, rewound, in_flight_start, in_flight_end, session_end
```

### Standard Audit Events (at `standard`+)
```
llm_request, tool_use, tool_call_start, tool_call_end,
compaction, error, message_truncated, provider_retry, provider_error
```

### Full-Only Events (at `full`)
```
tool_progress
```

---

## Storage

### Session Log Location
```
~/.wrongstack/projects/<projectHash>/sessions/<date>/sess_<ULID>.jsonl
```

Session IDs include a date shard and opaque sortable id:
```
2026-06-19/sess_01JX2S9V7T5M6N7P8Q9R0STXVW
```

### Tool Audit Log (Tamper-Evident Sidecar)
```
~/.wrongstack/projects/<projectHash>/sessions/<date>/sess_<ULID>.audit.jsonl
```

Each entry contains a SHA-256 chain:
```typescript
{
  index: number;
  id: string;           // UUID
  ts: string;           // ISO timestamp
  prevHash: string;     // Previous entry's hash (all-zeros for genesis)
  hash: string;          // SHA-256 of this entry's content
  toolName: string;
  toolUseId: string;
  input: unknown;
  output: unknown;
  isError: boolean;
}
```

---

## EventBus (Real-Time)

Beyond the persistent JSONL log, all events are also emitted on the in-memory `EventBus`. This enables real-time UIs without disk I/O.

### Key Events for Observability

| Event | When Fired |
|-------|------------|
| `iteration.started` | New iteration begins |
| `iteration.completed` | Iteration ends |
| `tool.started` | Tool execution begins |
| `tool.executed` | Tool completes (success or failure) |
| `tool.progress` | Streaming tool output |
| `provider.response` | LLM response received |
| `provider.retry` | Provider call being retried |
| `compaction.fired` | Context compaction triggered |
| `ctx.pct` | Context window fill percentage |
| `budget.threshold_reached` | Budget soft limit hit |
| `session.ended` | Session terminates |

### Subscribing

```typescript
// Typed subscription
bus.on('tool.executed', (payload) => {
  console.log(`Tool ${payload.name} completed in ${payload.durationMs}ms`);
});

// Pattern subscription (all tool.* events)
bus.onPattern('tool.*', (event, payload) => {
  console.log(`${event}:`, payload);
});

// Wildcard (all events)
bus.onAny((event, payload) => {
  metrics.increment(`event.${event}`);
});
```

---

## Usage Examples

### Resume Session After Crash

```typescript
const store = new DefaultSessionStore({ dir: sessionRoot });
const session = await store.resume('2026-06-19/sess_01JX2S9V7T5M6N7P8Q9R0STXVW');
// Events replayed from JSONL → messages, usage, toolCallEnds
```

### Search Session for Errors

```typescript
const reader = new DefaultSessionReader({ store });
const hits = await reader.search({
  query: { types: ['error'], search: 'timeout' }
});
```

### Audit Tool Calls with Integrity Chain

```typescript
const auditLog = new ToolAuditLog({ dir: auditDir });
const result = await auditLog.verify(sessionId);
if (!result.ok) {
  console.error(`Chain broken at entry ${result.brokenAt}`);
}
```

### Tail Session in Real-Time

```typescript
bus.onPattern('session.*', (event, payload) => {
  console.log(`[${event}]`, payload);
});
```

---

## Configuration

```typescript
// Config object
{
  session: {
    auditLevel: 'standard',  // 'minimal' | 'standard' | 'full'
    sampling: {
      toolProgress: {
        sampleRate: 8  // 1-in-N for log/partial_output events
      }
    }
  }
}
```

---

## Guarantees & Limits

- **Best-effort appends** — Failed writes log a throttled warning but never crash the agent loop
- **Secret scrubbing** — `user_input` and `llm_response` are passed through `SecretScrubber` before logging
- **Malformed lines** — `DefaultSessionStore.load()` silently skips bad JSONL lines after hard crashes
- **Non-blocking** — EventBus emissions are fire-and-forget; listener exceptions are caught and logged

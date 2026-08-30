# Session Journaling (JSONL) & Resume Engine Specification

This specification documents the architecture, write pipeline, streaming deserialization, crash recovery, single-timeline projection, and multi-surface resume lifecycle for WrongStack across the **TUI**, **SimpleUI**, and **WebUI** (including its **4-tab parallel concurrent execution architecture**).

---

## 1. Core Architectural Invariants

WrongStack enforces a strict guarantee across all interfaces:

> **A resumed session renders exactly what was on screen while it ran — identical entries, identical order, identical timings, and identical markers — on whichever surface it is resumed into.**

To achieve byte-accurate and visual parity across heterogeneous runtimes:
1. **Single Source of Truth for Ordering (`projectSessionTimeline`)**: A pure two-pointer merge algorithm reconciles the conversation backbone and the audit marker stream. UI layers only style; they never re-order.
2. **Single Source of Truth for Marker Wording (`sessionEventToMarker`)**: All textual audit labels originate from `@wrongstack/core/types/session-markers.ts`.
3. **Writer-Boundary Attribution (`withAgentAttribution`)**: Agent and subagent identities (`agentId`) are attached at the writer stream wrapper, never fabricated at emission sites.
4. **Journal-First Replay**: Replays prioritize persisted disk journals over in-memory working sets to guarantee that audit markers, tool latencies, and token diagnostics survive restarts.
5. **Positive Session Routing**: In multi-session environments (WebUI), all state and stream routing are positively keyed by `sessionId`. Background tabs receive stream deltas into dedicated lanes without cross-contaminating the foreground DOM or state stores.

```
+-----------------------------------------------------------------------------------+
|                               PRODUCERS                                           |
|  (Agent Loop, Tool Executions, Fleet/Subagents, Providers, Context Transitions)  |
+-----------------------------------------------------------------------------------+
                                         │
                                         ▼
                         +-------------------------------+
                         |      SessionEventBridge       |  <-- Filtered by auditLevel
                         +-------------------------------+      (minimal | standard | full)
                                         │
                                         ▼
                         +-------------------------------+
                         |   withAgentAttribution Wrap   |  <-- Attached at writer boundary
                         +-------------------------------+
                                         │
                                         ▼
                         +-------------------------------+
                         |       FileSessionWriter       |  <-- Batch buffer + atomic flush
                         +-------------------------------+      (CRITICAL_EVENT_TYPES immediate)
                                         │
                                         ▼
            +---------------------------------------------------------+
            |  JSONL Disk Journal: ~/.wrongstack/projects/.../*.jsonl |
            +---------------------------------------------------------+
                                         │
                   +─────────────────────┴─────────────────────+
                   │                                           │
                   ▼                                           ▼
       +-----------------------+                   +-----------------------+
       | DefaultSessionStore   |                   | Crash Recovery Engine |
       | (96MB Budget Stream)  |                   | (Heals In-Flight/Tool)|
       +-----------------------+                   +-----------------------+
                   │                                           │
                   +─────────────────────┬─────────────────────+
                                         │
                                         ▼
                         +-------------------------------+
                         |    projectSessionTimeline     |  <-- Unified timeline projection
                         +-------------------------------+
                                         │
        +────────────────────────────────+────────────────────────────────+
        │                                │                                │
        ▼                                ▼                                ▼
+---------------+               +-----------------+               +---------------+
|      TUI      |               |    SimpleUI     |               |     WebUI     |
| (Inline Merge)|               | (Split Bubbles) |               | (4-Tab Lanes) |
+---------------+               +-----------------+               +---------------+
```

---

## 2. Storage Topology & Event Taxonomy

### 2.1 File System Hierarchy

Session state is persisted per project, hashed from the canonical project root (`SHA-256` truncated to 12 hex characters):

```
~/.wrongstack/projects/<sha256(projectRoot)[:12]>/
├── sessions/
│   ├── <YYYY-MM-DD>/
│   │   ├── <sess_ULID>.jsonl            # Authoritative append-only session journal
│   │   ├── <sess_ULID>.todos.json       # Session-scoped task list snapshot
│   │   ├── <sess_ULID>.session.json     # Fast-index metadata sidecar
│   │   └── <sess_ULID>/
│   │       └── subagents/               # Per-subagent dedicated journals
│   └── _cas/                            # Workspace checkpoint Content-Addressable Storage
└── transcripts/
    └── <subagentId>/
        └── transcript.jsonl             # AgentMonitor fleet timeline streams
```

### 2.2 Event Taxonomy

Every JSONL record implements `SessionEvent`:

| Tier | Category | Event Types | Lifecycle & Recovery Function |
| :--- | :--- | :--- | :--- |
| **Core Reconstruct** | **Conversation Backbone** | `session_start`, `session_resumed`, `session_forked`, `user_input`, `llm_response`, `tool_result`, `message_appended`, `message_updated`, `messages_replaced`, `messages_dropped` | Reconstructs the exact message sequence and repairs tool use/result pairing. |
| **Core Reconstruct** | **State Snapshots & Recovery** | `context_snapshot`, `checkpoint`, `file_snapshot`, `file_observation`, `rewound`, `in_flight_start`, `in_flight_end`, `session_end` | Drives `/rewind`, token budget accounting, and crash boundary detection. |
| **Audit Detail** | **Agent & Fleet Lifecycle** | `agent_spawned`, `agent_session_linked`, `agent_stopped`, `agent_error`, `delegate_started`, `delegate_completed` | Tracks fleet hierarchy, subagent transcripts, and supervisor delegation. |
| **Audit Detail** | **Tool & Runtime Telemetry** | `llm_request`, `tool_call_start`, `tool_call_end`, `tool_progress`, `compaction`, `error`, `provider_retry`, `provider_error`, `mode_changed`, `skill_activated`, `task_*`, `message_truncated` | Injected into UI timelines as chronological markers; provides tool duration and token metrics. |

---

## 3. The Write Pipeline: Buffering, Attribution & Critical Events

### 3.1 Immediate Flush for Critical Events
`FileSessionWriter` buffers non-critical events into `SessionWriteBuffer` (100ms throttle or 32KB buffer). However, `CRITICAL_EVENT_TYPES` bypass the buffer and flush immediately:

```typescript
const CRITICAL_EVENT_TYPES = new Set<SessionEvent['type']>([
  'user_input',
  'llm_response',
  'checkpoint',
  'in_flight_start',
  'in_flight_end',
]);
```

### 3.2 Audit Level Gating
`SessionEventBridge` enforces selective persistence based on `config.session.auditLevel`:
* `minimal`: Emits only **Core Reconstruct** events.
* `standard` (Default): Adds lifecycle markers, compaction summaries, model switches, and provider retries.
* `full`: Includes verbose telemetry such as intermediate `tool_progress` chunks.

### 3.3 Strict Attribution Wrapping
Attribution is stamped at the writer boundary via `withAgentAttribution(writer, agentId)`:
```typescript
export function withAgentAttribution(writer: SessionWriter, agentId: string): SessionWriter {
  return {
    ...writer,
    append: (event) => writer.append({ agentId: event.agentId ?? agentId, ...event }),
    appendBatch: (events) => writer.appendBatch(
      events.map((event) => ({ agentId: event.agentId ?? agentId, ...event }))
    ),
  };
}
```

---

## 4. Deserialization, Memory Budgeting & Crash Recovery

### 4.1 Bounded In-Memory Retention (96 MB Budget)
In `loadSessionDataFromFile`:
* Reads lines incrementally via `node:readline` on a streaming file handle.
* Enforces `DEFAULT_MAX_RETAINED_EVENT_BYTES = 96 * 1024 * 1024` (96 MB). When exceeded, older events are pruned in bulk down to 90% (`evictTo = 0.90 * budget`).
* **O(1) Snapshot Retention**: Only the newest `context_snapshot` payload is retained; previous snapshot payloads are stripped in place (`stripSnapshotPayload`) to prevent memory exhaustion on long-running sessions.

### 4.2 Automated Crash Recovery
During `resumeSessionData`:
1. **Unclosed Tool Call Healing**: Unclosed `tool_use` blocks missing matching `tool_result` events receive synthesized `[interrupted]` records.
2. **Dangling Marker Clearance**: Writes `in_flight_end` with reason `'recovered'`, clearing the crash boundary.
3. **Workspace File Validation**: Compares workspace file hashes against recorded `file_snapshot` events.
4. **Notice Injection**: Human-facing notices are appended as visible `system` messages:
   - `[SESSION RESUME CRASH RECOVERY]`
   - `[SESSION RESUME FILE VALIDATION]`
   - `[SESSION RESUME INTERRUPTED WORK]`

---

## 5. Single Timeline Projection (`projectSessionTimeline`)

Centralized in `packages/core/src/types/session-timeline.ts`, `projectSessionTimeline` provides a deterministic merge of the conversation backbone with audit markers.

### Surface Projection Parameter Matrix

| Configuration Option | TUI | WebUI | SimpleUI | Technical Rationale |
| :--- | :--- | :--- | :--- | :--- |
| `thinkingPlacement` | `'inline'` | `'merged-after'` | `'inline'` | WebUI commits thinking blocks on `iteration.completed` (after prose); TUI streams inline. |
| `textBlocks` | `'split'` | `'split'` | `'join'` | SimpleUI renders entire turns in single bubbles; TUI and WebUI isolate tool cards. |
| `markerSources` | Full Marker Set (excl. subagent lifecycle) | Chat-Filtered Set | Chat-Filtered Set | High-density audit markers belong in dedicated panels (e.g. WebUI Fleet Panel). |
| `toolMeta` Injection | Direct from raw events | Hydrated from wire payload | Hydrated from wire payload | Local processes access raw events; web clients receive projected metadata over WebSocket. |

---

## 6. Surface-Specific Resume Architectures

### 6.1 TUI (Terminal User Interface)
* Handled by `tui-session-resume.ts` and `replaySessionMessages`.
* Acquires a lease in the project SQLite session catalog.
* Swaps active session writers and loads `.todos.json` sidecar.
* Projects the timeline with `thinkingPlacement: 'inline'`.
* Implements transactional rollback if swapping fails mid-flight.

### 6.2 SimpleUI
* Single-lane streaming web interface.
* Calls `projectSessionTimeline` with `textBlocks: 'split'` and `thinkingPlacement: 'inline'`.
* Maintains a synchronized sidecar tool execution map.

### 6.3 WebUI & WebUI Server: 4-Tab Parallel Concurrent Execution
The WebUI supports **up to four active sessions running concurrently in separate browser tabs within a single window**.

```
Browser Client (1 Window, 1 Shared WebSocket Connection)
+-----------------------------------------------------------------------------+
|  Tab Strip: [ Slot 0: Alpha ] [ Slot 1: Bravo ] [ Slot 2: Charlie ] [ Slot 3: Delta ] |
+-----------------------------------------------------------------------------+
|                                                                             |
|  LANE 0 (Foreground)        LANE 1 (Background)     LANE 2 (Background) ... |
|  +-----------------------+  +--------------------+  +-------------------+   |
|  | Active Chat Viewport  |  | Streaming Tokens   |  | Tool Running      |   |
|  | User Interaction      |  | (Buffered in Lane) |  | (Buffered in Lane)|   |
|  +-----------------------+  +--------------------+  +-------------------+   |
+--------------------------------------┬--------------------------------------+
                                       │ Single Multiplexed WS Stream
                                       ▼
+-----------------------------------------------------------------------------+
| WebUI Server (Node.js Process)                                              |
|                                                                             |
|  Client Connection State: { sessionIds: ['sess_A', 'sess_B', 'sess_C', 'sess_D'] } |
|                                                                             |
|  Parallel Agent Runtime:                                                    |
|  ├── Agent A (sess_A) ──> FileSessionWriter A ──> sess_A.jsonl              |
|  ├── Agent B (sess_B) ──> FileSessionWriter B ──> sess_B.jsonl              |
|  ├── Agent C (sess_C) ──> FileSessionWriter C ──> sess_C.jsonl              |
|  └── Agent D (sess_D) ──> FileSessionWriter D ──> sess_D.jsonl              |
+-----------------------------------------------------------------------------+
```

1. **`MAX_LANES = 4` Isolation**:
   Managed via `session-tab-store.ts`, `chat-lanes.ts`, and `session-lanes.ts`. Four isolated state stores operate in parallel.
2. **Positive Routing**:
   Every incoming WebSocket message carries `sessionId`. State writes land directly in `lanes[msg.sessionId]`. Messages with mismatched or missing IDs are rejected, preventing cross-tab token bleed.
3. **Background Modal & Fallback Parking**:
   Modals (`pendingConfirm` or `pendingFallback`) requested by background tabs are parked in their respective lane. An attention badge is displayed on the tab header without interrupting the foreground tab.
4. **`session.resume` vs `session.focus`**:
   - `session.focus`: Moves the active viewport pointer with zero transcript payload over the wire.
   - `session.resume`: Performs a journal-first load and transmits complete replay metadata.

---

## 7. Cross-Process Session Catalog & Lease Safety

To prevent two processes (e.g. CLI TUI and WebUI Server) from concurrently modifying the same session journal:
1. **SQLite Session Catalog**: Tracks active session leases by PID.
2. **`reserveResume(sessionId)`**: Rejects resume requests if an active process holds a live lease.
3. **Reaping**: Automatically reclaims abandoned leases on process crashes via liveness checks (`reapExpired()`).

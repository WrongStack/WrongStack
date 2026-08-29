# Session journal: recording, resume, and the single timeline

How a session is written to disk, and how it comes back looking like itself in
the TUI, the WebUI, the SimpleUI and HQ.

The property this architecture exists to hold:

> **A resumed session renders exactly what was on screen while it ran — same
> entries, same order — on the surface it is resumed into.**

Not "similar". A resume that reorders, drops the audit marks, or rebuilds tool
cards without their timings reads as *a different session loaded*, not *this one
carried on*. That is the difference between resume as a feature and resume as a
curiosity — and it is what makes the cross-surface handoff (stop work in the
TUI, pick it up in the WebUI) usable at all.

---

## 1. Where it lives

```
~/.wrongstack/projects/<sha256(projectRoot)[:12]>/
  sessions/
    <YYYY-MM-DD>/<sess_ULID>.jsonl        the journal
    <YYYY-MM-DD>/<sess_ULID>/subagents/   per-subagent journals
    _cas/                                  workspace checkpoint content store
  transcripts/<subagentId>/transcript.jsonl   AgentMonitor's worker timelines
```

`resolveWstackPaths` is the source of truth for those paths. The only files
inside the project tree are the committed `.wrongstack/AGENTS.md` and
`.wrongstack/skills/`.

## 2. The write path

```
producers ──► SessionEventBridge ──► FileSessionWriter ──► .jsonl
   (agent loop, tools, fleet,   (auditLevel gate)   (batched, append-only)
    providers, context)
```

- **`FileSessionWriter`** (`core/src/storage/file-session-writer.ts`) owns the
  per-session write path: append / flush / close / checkpoint / truncate.
  A `CRITICAL_EVENT_TYPES` set (`user_input`, `llm_response`, `checkpoint`,
  `in_flight_start`, `in_flight_end`) bypasses the batch window and reaches disk
  immediately — losing one to a SIGKILL would make a resumed transcript *lie*.
- **`SessionEventBridge`** (`core/src/storage/session-event-bridge.ts`) gates on
  `config.session.auditLevel`. `CORE_RECONSTRUCT_EVENTS` are written at every
  level; `STANDARD_AUDIT_EVENTS` at `standard` (the default) and above;
  `tool_progress` only at `full`. Note that several producers append to the raw
  writer rather than through the bridge — the bridge is the gate, not a
  choke point.
- **Attribution** happens at the WRITER boundary, never at the emit site:
  `withAgentAttribution` (`core/src/storage/session-agent-attribution.ts`) wraps
  a writer so every event through it carries `agentId`. This is why a subagent
  running on the parent-interleaved writer
  (`createParentSubagentSessionWriter`) stays distinguishable from the leader in
  the one file that holds both. An existing `agentId` is never overwritten — a
  deeper agent's own wrapper is the more specific truth.

### Event taxonomy

Two tiers, documented on `SessionEvent` in `core/src/types/session.ts`:

| Tier | Purpose | Examples |
|---|---|---|
| **Core reconstruct** | Required for correct resume, rewind, crash recovery | `session_start/_resumed/_forked`, `user_input`, `llm_response`, `tool_result`, `message_appended/_updated`, `messages_replaced/_dropped`, `context_snapshot`, `checkpoint`, `file_snapshot`, `file_observation`, `rewound`, `in_flight_start/_end`, `session_end` |
| **Audit detail** | What happened *around* the conversation | `llm_request`, `tool_call_start/_end`, `tool_progress`, `compaction`, `error`, `provider_retry/_error`, `mode_changed`, `skill_activated/_deactivated`, `agent_spawned/_session_linked/_stopped/_error`, `delegate_started/_completed`, `loop_detected`, `model_switched`, `task_*`, `side_effect`, `message_truncated` |

Two journal generations coexist and both replay correctly:

- **Exact journal** — `message_appended` / `message_updated` /
  `messages_replaced` / `messages_dropped` carry the conversation verbatim.
- **Legacy/inferred** — `user_input` / `llm_response` / `tool_result` are
  replayed into messages when no exact journal is present
  (`exactJournalActive` in `session-store/load-session-data.ts`).

`user_input` / `llm_response` are still written alongside the exact journal, so
consumers that read only those (HQ's streaming mapper) keep working.

**Declared but unproduced.** `message_truncated`, `skill_deactivated` and
`task_updated` are part of the contract — they have marker wording and audit-set
membership — but nothing emits them today. They work the moment a producer does.

## 3. Reading it back

`DefaultSessionStore.load()` streams the JSONL and produces `SessionData`:

- `messages` — the reconstructed conversation (repaired for tool_use/tool_result
  adjacency; damage is reported on the `session.damaged` bus event).
- `events` — the raw stream, under a **96 MB retention budget**
  (`DEFAULT_MAX_RETAINED_EVENT_BYTES`) that keeps the newest and drops the
  oldest, because everything downstream is tail-oriented. Superseded snapshot
  payloads are stripped in place — retention is O(1) snapshots, not O(session).
- `usage`, `toolCallEnds`, `pendingToolUseCount`, `eventsDropped`.

`DefaultSessionStore.resume()` additionally **heals** the journal before
reporting success (`session-store/resume-session.ts`):

1. `SessionRecovery.buildRecoveryPlan` finds a dangling `in_flight_start`.
   If `load()` dropped events under the budget, the file is rescanned.
2. Interrupted tool calls get synthesized `[interrupted]` `tool_result` records,
   appended and flushed.
3. `clearInFlightMarker('recovered')` closes the boundary, so `detectStale()`
   reports clean afterwards.
4. Human-facing notices are appended as `system` messages:
   `[SESSION RESUME CRASH RECOVERY]`, `[SESSION RESUME FILE VALIDATION]`
   (files changed underneath the session), `[SESSION RESUME INTERRUPTED WORK]`.
   These are **for the human** and are deliberately NOT in
   `SYSTEM_INJECTION_PREFIXES` — that list hides things injected for the *model*.

## 4. The single timeline projection

This is the part that used to be duplicated four times, and the reason resumes
looked wrong.

```
messages + events
        │
        ▼
core/src/types/session-timeline.ts  ── projectSessionTimeline()
        │   ordering · tool pairing · visibility  (settled ONCE)
        ▼
SessionTimelineEntry[]   user | assistant | system | thinking | tool | marker
        │
   ┌────┴────┬─────────────┬──────────────┐
   ▼         ▼             ▼              ▼
  TUI      WebUI       SimpleUI          HQ
 HistoryEntry ChatMessage  ChatMessage+ToolCallInfo   (see §7)
```

**Ordering** is a two-pointer merge of two already-chronological sequences (the
message backbone by construction, the markers by journal order). Ties keep the
backbone entry first. It is deliberately *not* a sort over the union: message
timestamps repeat — every block of one message shares its `ts` — and sorting a
repeated key tears tool calls away from the prose they belong to.

**Wording** for markers lives one module over, in
`core/src/types/session-markers.ts` (`sessionEventToMarker`,
`SESSION_MARKER_EVENT_TYPES`, `CHAT_MARKER_SOURCES`). Surfaces choose icon,
colour and bubble shape; they never re-word.

### The options are records of live behaviour, not preferences

Each surface renders live in its own way, and resume must match *that surface*:

| Option | TUI | WebUI | SimpleUI | Why |
|---|---|---|---|---|
| `thinkingPlacement` | `inline` | `merged-after` | `inline` | The WebUI commits the archived thinking log at `iteration.completed`, i.e. after the prose is on screen |
| `textBlocks` | `split` | `split` | `join` | The SimpleUI streams a whole iteration into one bubble and lists tools beside the chat |
| `markerSources` | full set | chat set | chat set | `checkpoint` would restate every user prompt in a chat transcript; `agent_session_linked` belongs in a fleet panel, and the TUI has none |

`SessionMarker.detail` carries the source event's structured fields for the few
sources a surface draws richly (the `delegate_*` pair). Handing replay only the
rendered sentence would have forced those surfaces to show something they never
showed while running.

## 5. The wire (`session.start`)

`webui-protocol/src/replay-payload.ts` builds the replay half of the frame, and
both servers call it so the shape has one definition:

| Field | Contents |
|---|---|
| `replayMessages` | conversation, capped at `REPLAY_MESSAGE_CAP` (2 000) |
| `replayMarkers` | **projected** markers only — never the raw event stream |
| `replayToolMeta` | `tool_call_end` projection: `durationMs`, `outputBytes/Tokens/Lines`, `ok`, `agentId` |
| `replayUsage` | token totals |
| `agentSessions` | this session's subagents (see §6) |

The TUI needs none of this — it holds the raw event array and passes `events`
straight to the projector.

### Replay paths in the WebUI server

| Trigger | Handler | Transcript? |
|---|---|---|
| connect / F5 | `buildInitialPayload` (CLI host) | yes, foreground session |
| `session.subscribe` with `replayFor` | `sendSessionReplay` | yes, per named tab |
| `session.resume`, session live here | `resumeSession` | yes — **journal-first**, so markers and timings survive |
| `session.resume`, not live here | `resumeSession` → `store.resume()` | yes, full |
| `session.focus` (tab click) | `resumeSession` (focus branch) | **no** — the tab already shows it, and the replay would be the poorer copy |

`replaySourceFor()` is the shared rule: prefer the JOURNAL, fall back to the
live working set when the journal is missing or behind (it can only be behind
mid-turn, since every message-bearing record is critical and lands immediately).
A context's in-memory transcript is messages and nothing else — replaying a live
tab from memory brought it back as a wall of plain text.

## 6. Subagents

Four stores hold pieces of a subagent's life:

1. **The leader's journal** — `agent_spawned`, `agent_session_linked`,
   `agent_stopped`, `agent_error`, plus any events stamped with the agent's id.
   This is the **only session-scoped record of which agents belong to which
   session**, projected by `deriveSessionAgents`.
2. **The subagent's own journal** (when it has one) under the session's
   `subagents/` directory, linked by `agent_session_linked.transcriptPath`.
3. **`AgentMonitorService` transcripts** — `transcripts/<subagentId>/transcript.jsonl`,
   the per-worker timeline the fleet panel renders. Shared across every session
   of the project, so it must be read by **named ids** (`loadSessionsFromDisk(only)`).
4. **Parent-interleaved events** — a subagent with no journal of its own writes
   into the leader's file, stamped with `agentId`.

`buildAgentSessionsPayload` (`webui-server/src/server/session-agent-sessions.ts`)
joins 1 and 3: the journal supplies the roster (and the authoritative status —
the monitor only knows `'restored'`), the monitor supplies the bodies. The
reserved id `leader` is excluded: the leader is the session, not one of its
workers.

File mutations are special-cased on purpose. `createParentSubagentSessionWriter`
forwards `recordFileChange` to the parent, and `withParentFileSnapshots` mirrors
it, because `/rewind` reads exactly one journal — the session being rewound —
and a subagent's edits are real edits to the user's tree made under the parent
prompt that spawned it.

## 7. HQ

`core/src/hq/transcript-mapper.ts` maps **one event at a time**, because HQ's
live plane streams `session.transcript` frames as they arrive and cannot buffer
a whole session. It is not a fifth ordering: its order is journal order, its
tool pairing is `mergeToolResults`, and its marker wording comes from
`sessionEventToMarker` like everyone else's.

## 8. Cross-process ownership

Resume across surfaces is gated by the project session catalog
(`core/src/session-catalog/`), one SQLite store per project behind an IPC
endpoint:

- `reserveResume()` refuses a session that holds a live lease —
  *"already open in another running wstack (pid N)"*. So the TUI must stop
  before the WebUI can take over; two writers on one journal is the failure this
  prevents.
- A clean TUI exit runs `registry.markClosing()` then `registry.unregister()`
  through `createGracefulShutdown`, releasing the lease immediately.
- A crashed process is covered by `reapExpired()` and prune, not by the exit
  path.
- `SessionRecovery.listUnclosed()` finds journals with no `session_end` — the
  `--recover` candidates.

## 9. Invariants

1. **One projector.** Ordering, tool pairing and visibility are decided in
   `projectSessionTimeline` and nowhere else. A surface may map and style; it
   may not re-order.
2. **One wording.** Marker text comes from `sessionEventToMarker`. A surface
   that needs to render richly reads `SessionMarker.detail`, it does not write
   a second sentence.
3. **Attribution at the writer.** No emit site stamps `agentId`.
4. **Resume ≠ focus.** A focus moves the foreground and carries no transcript.
5. **Unresolved ≠ failed.** A tool with no result in the journal replays with
   `ok === undefined`. Marking it failed invents a failure that never happened.
6. **Injections are for the model.** `SYSTEM_INJECTION_PREFIXES` hides what the
   agent loop folded in for the LLM. Resume notices are for the human and stay
   visible.
7. **The journal is the roster.** Which agents belong to a session is answered
   by `deriveSessionAgents` over that session's own events — never by scanning a
   shared directory.

## 10. Testing this

- `core/tests/types/session-timeline.test.ts` — the projector's ordering,
  pairing and option semantics.
- `core/tests/types/session-markers.test.ts` — the marker set is **test-pinned**;
  adding a source requires updating it.
- `webui/tests/hooks/replay-live-parity.test.ts` — plays a turn through the LIVE
  handlers, then the journal it would have produced through the REPLAY handler,
  and compares. This is the property, expressed as a test.
- `webui-server/tests/session-live-resume.test.ts` — the four replay paths,
  including that a live resume carries markers and tool timings and that a
  session brings back only its own subagents.
- `webui-server/tests/session-event-taxonomy.test.ts` — every event kind must
  produce a human label and a meaningful detail.

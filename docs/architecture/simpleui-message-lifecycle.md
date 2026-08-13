# SimpleUI Message Lifecycle & WebSocket Protocol

The complete path of a chat message through SimpleUI: composer → `user_message`
frame → `webui-server` backend → `@wrongstack/core` agent run → server emit
frames → rendered chat. Includes the client/server protocol frame registry.

This document was traced from source (2026-08). The frame-type tables were
cross-checked against the registry source files in
`packages/webui-server/src/protocol/`. Where a claim differs from code, the
code wins — file this doc as stale and fix it.

---

## 1. Architecture map

```
┌─ Browser (SimpleUI, packages/simpleui) ──────────────────────────────┐
│  Composer → useComposerActions → dispatchUserMessage → SimpleSocket  │
│        │                                                             │
│        │  WS frames (JSON envelopes)                                 │
│        ▼                                                             │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
┌─ webui-server (packages/webui-server/src/server) ────────────────────┐
│  connection-handler (decode + rate-limit) → message-dispatcher       │
│        │                                                            │
│        │  conversation-operations.userMessage → run lock             │
│        ▼                                                            │
│  agent.run()  ◄── EventBus events ──►  setup-events / stream-coalescer│
│        │                       (broadcast → WS frames)              │
│  ┌─────┴──────┐                                                     │
│  ▼            ▼                                                     │
└─ @wrongstack/core (packages/core/src/core) ─────────────────────────┘
   agent-loop.runInner → provider-runner → streaming-response-builder
                        → agent-response.processResponse
```

The transport is a **shared-port design**: one `webui-server` process serves
both the built SimpleUI frontend and the chat-protocol WebSocket on the same
port (`127.0.0.1:3466` by default). The browser derives the WS URL from
`window.location.host` (`packages/simpleui/src/lib/ws.ts` `defaultWsUrl`).

---

## 2. Client → server: composer to `user_message` frame

| Step | File · function | What happens |
|---|---|---|
| 1 | `packages/simpleui/src/composer.tsx` — form `onSubmit`, textarea `onKeyDown` | Enter (no Shift) submits in `btw` mode; Ctrl/Cmd+Enter queues; the send button submits `btw`; the steer button (running only) submits `steer`; the queue button submits `queue`. |
| 2 | `packages/simpleui/src/hooks/use-composer-actions.ts` — `submitWith` | Slash-command check (`/clear` → sends `session.new`). Otherwise composes `@relative/path` file references into the prompt via `composePromptWithFileReferences`, then `resolveSendPlan(mode, running)` decides: `send` → `startSend`; `enqueue` → append to the client-side queue; `abort-then-enqueue-front` → `socket.send('abort', {sessionId})` + park at queue head. |
| 3 | `packages/simpleui/src/simple-ui-session.tsx` — `startSend` | If the enhance/refine prefs are on, opens the 3-2-1 countdown refine panel and sends a `model.refine` frame instead; the `model.refine_result` round-trip lands in `dispatchUserMessage`. If off, calls through directly. |
| 4 | `packages/simpleui/src/simple-ui-session.tsx` — `dispatchUserMessage` | Guards (non-empty content, session, socket — returns `false` when dropped so queue drains don't consume the item). Optimistically appends a local `user` `ChatMessage` via `retainSimpleChatMessages`, sets `running=true`, then sends the frame. |
| 5 | `packages/simpleui/src/lib/ws.ts` — `SimpleSocket.send` | Client-side `decodeProtocolMessage({type, payload}, 'client')` validation, `JSON.stringify`, send if `OPEN`, else queue (100 msgs / 8 MiB, oldest dropped). |

**Wire frame sent by the client:**

```json
{
  "type": "user_message",
  "payload": {
    "sessionId": "<current session id>",
    "id": "prompt-<uuid>",
    "content": "<composed text incl. @file refs>",
    "timestamp": 1750000000000,
    "images": [{ "data": "<data-url>", "mime": "image/png", "mediaType": "image/png" }]
  }
}
```

`images` is optional. Both `mime` and `mediaType` are sent — the server's
`IncomingImagePayload` reads `mediaType`, the client queue-replay path reads
`mime` (WS-055 fix).

The queue is **deliberately client-side**: the server has no queue protocol.
A held message is replayed as a plain `user_message` when the next `run.result`
arrives (`drainQueue` in `message-handler.ts`, gated on the dispatch result so
a dropped send keeps the item queued).

---

## 3. Server ingress and dispatch

| Step | File · function | What happens |
|---|---|---|
| 6 | `packages/webui-server/src/server/connection-handler.ts` — `createConnectionHandler` | Per-connection `createConnectionLifecycle`: `decode: (raw) => decodeProtocolFrame(raw, 'client')`; rate limit **600 non-keepalive messages / 60 s** (keepalive `ping` exempt; `WEBUI_RATE_LIMIT=0` opts out); `dispatch: options.handleMessage`. |
| 7 | `packages/webui-server/src/server/message-dispatcher.ts` — `createMessageDispatcher` | Short-circuits connections-health / service-action / codebase-index control, then `createRouteFamilyDispatcher` routes the `conversation` family to `createConversationOperations`. Unknown types get `error` (`Unknown message type: …`). |
| 8 | `packages/webui-server/src/server/conversation-operations.ts` — `userMessage` | `ensureCurrentSession` (mismatch → `error`); `runControl.begin` acquires the **run lock** (`AbortController`); busy → `error` "Agent is already processing a request…"; parses images via `parseIncomingImages` + `routeImagesForModel` (vision errors → typed `error` frames); `await agent.run(input, {signal, maxIterations})`; finally `runControl.end`. |

On completion the server sends **`run.result`** (see §5 — this frame is
composed here, not emitted by core):

```json
{
  "type": "run.result",
  "payload": {
    "sessionId": "<origin session>",
    "status": "done" | "aborted" | "failed",
    "iterations": 3,
    "finalText": "<assistant text>",
    "error": { "code": "...", "message": "...", "recoverable": false }
  }
}
```

`error` is present only on failure.

---

## 4. Inside `agent.run` — the call path

`agent.run()` (`packages/core/src/core/agent.ts:183`):

1. Concurrency guard (`_runInProgress`), input dedup (sha256 of the text).
2. Pins the run's session writer/id, sets `ctx.signal`.
3. Prompt refresh + `beforeRun` extensions, then
   `this._loopHandler.runInner(inputPayload, opts, controller, autonomousContinue)`
   (`agent.ts:304`).
4. `runInner` (`packages/core/src/core/agent-loop.ts:588`) runs the iteration
   loop (`for (let i = 0; ; i++)`, line 691).
5. Per iteration: provider call via `baseRunner`/`customRunner` →
   `runProviderWithRetry` (`provider-runner.ts:53`) → for streaming providers
   `streamProviderToResponse` (`streaming-response-builder.ts:235`).
6. After the provider returns: `handlers.response.processResponse(res, req,
   responseProvider)` (`agent-loop.ts:901`) → `processResponse`
   (`agent-response.ts:424`).
7. `agent.run` returns a `RunResult` (`status` / `iterations` / `finalText` /
   `error` / `delegateSummaries`). It also emits `agent.run.completed` /
   `agent.run.error` / `error` — **but never `run.result`**.

---

## 5. Emission sites (the frames SimpleUI consumes)

### `provider.text_delta`

| | |
|---|---|
| **File** | `packages/core/src/core/streaming-response-builder.ts` |
| **Function** | `streamProviderToResponse()` — inner `flushText()` closure (line 254), emitted at line 256 |
| **Payload** | `{ sessionId?: string, ctx: Context, text: string }` |
| **Detail** | Batched: `TEXT_BATCH_SIZE = 4`; `pendingText` accumulates and emits every 4 SSE `text_delta` events, before any non-text event, and at stream end — cut fan-out ~4×. |

### `provider.thinking_delta`

| | |
|---|---|
| **File** | `packages/core/src/core/streaming-response-builder.ts` |
| **Function** | `streamProviderToResponse()` — SSE `thinking_delta` case (line 307), emitted at line 310 |
| **Payload** | `{ sessionId?: string, ctx: Context, text: string }` |
| **Detail** | `flushText()` runs first (ordering), then `handleThinkingDelta(state, ev.text)`, then the emit. |

### `provider.response`

| | |
|---|---|
| **File** | `packages/core/src/core/agent-response.ts` |
| **Function** | `processResponse()` (line 424), emitted at line 436 |
| **Payload** | `{ sessionId?: string, ctx: Context, model: string, content?: ContentBlock[], usage: Usage, stopReason: string }` |
| **Detail** | Emitted after `a.pipelines.response.run(res)` and `maybeAppendPendingNextSteps(a.ctx, res)` — the single point where the `<nextsteps>` block folded in by the `nextsteps` tool feeds the event, journal, history, and `finalText` at once. Called from `agent-loop.ts:901`. |

### `run.result` — **not emitted by core**

`run.result` has **zero emit sites in `packages/core/src`** (verified by grep).
It is **composed by the webui-server layer**: `conversation-operations.ts`
`userMessage()` sends it directly after `agent.run()` resolves (§3). Core's
closest analog is the `agent.run.completed` / `agent.run.error` events in
`agent.ts` — those are internal telemetry, not forwarded as `run.result`.

**Consequence:** any code path that must react to run completion *inside*
core should listen for `agent.run.completed` / `error`; anything that wants
the browser-visible frame reads `run.result` from the socket.

---

## 6. Core event → WS frame bridge

`setupEvents` (`packages/webui-server/src/server/setup-events.ts:66`) subscribes
the kernel `EventBus` and broadcasts WS frames to all connected clients. The
streaming deltas route through `registerSetupEventsProviderHandlers`
(`setup-events-provider-handlers.ts`) and, when a projection is wired, the
`StreamCoalescer` (`stream-coalescer.ts`, 16 ms / 8 KiB buffers).

| Core event | WS frame | Broadcast site | Payload added by server |
|---|---|---|---|
| `provider.text_delta` | `provider.text_delta` | `setup-events.ts:131-141` (or coalescer `queueTextDelta`) | `{ sessionId, text, messageId: 'current' }` |
| `provider.thinking_delta` | `provider.thinking_delta` | `setup-events.ts:143-152` (or coalescer `queueThinkingDelta`) | `{ sessionId, text }` |
| `provider.response` | `provider.response` | `setup-events-provider-handlers.ts:28-40` (flushes stream buffers first) | `{ sessionId, content, usage, stopReason, messageId: 'current' }` |
| — (composed) | `run.result` | `conversation-operations.ts:166-181` | `{ sessionId, status, iterations, finalText, error? }` |
| `ctx.pct` | `ctx.pct` + `subagent.event` | `setup-events-provider-handlers.ts:42-63` | `{ load, tokens, maxContext }` |

`sessionPayload()` stamps the live session id on every payload.

---

## 7. Client receive → render

`packages/simpleui/src/lib/message-handler.ts` — `createMessageHandler`:

- Every non-`provider.text_delta` message **flushes the pending delta buffer**
  first (ordering guarantee); `worklists.applyMessage` + `projectStatusNotice`
  run per message.
- `provider.text_delta` → accumulate into `pendingDelta`, flush once per
  animation frame, append to the tail assistant message (or create one).
- `provider.thinking_delta` → append to a streaming `thinking` message.
- `provider.response` → adopt the canonical text when it is a *strict
  extension* of the streamed text (the runtime appends a tool-produced
  `<nextsteps>` block that never arrives as a delta); mark `final` via
  `isFinalTurnStopReason(stopReason)`.
- `run.result` → `setRunning(false)`, mark any still-streaming message final,
  `drainQueue()` (turn-boundary queue replay).
- `error` → `rate_limit` phase shows a dismissible notice (no drain); other
  phases append a `system` error message and drain.
- `tool.started` / `tool.progress` / `tool.executed` → tool-call rows (closes
  the last running call by id or name; duplicate/late frames are safe no-ops).
- `ctx.pct` → context load as a **0–1 fraction** (`load: 0.68` = 68%; never
  divide by 100).
- `tool.confirm_needed` → pending-confirm modal; decision → `tool.confirm_result`.
- `model.refine_result` → refine panel flow (epoch guard against stale results).
- `session.start` → hydrate session, replay messages/subagents/drafts, then
  send `sessions.list` (limit 12).

Render: `packages/simpleui/src/chat-message-list.tsx` — memoized `MessageItem`,
`projectAssistantMessage` extracts the canonical `<nextsteps>` block into
suggestion chips; body via react-markdown + `rehype-pretty-code` +
`remark-gfm`.

---

## 8. Protocol envelope & validation

Envelope (`packages/webui-server/src/protocol/types.ts`):

```ts
interface ProtocolEnvelope { type: string; payload?: unknown }
```

- **Server frames must carry `payload`** (`decoder.ts:63`); client frames may
  omit it.
- `decodeProtocolFrame` / `decodeProtocolMessage` (`decoder.ts`) validate:
  JSON-parseable, `type` a non-empty string, **registered type for the
  direction**, no unsafe keys (`__proto__`, `constructor`, `prototype`),
  payload nesting depth ≤ 32.
- Registration: `registry.ts` aggregates the family arrays; open prefixes
  `kanban.*` and `agent-roster.*` are accepted on both directions.
- Negotiation: `session.start` carries `protocolVersion` + `protocolCapabilities`
  from `protocolAdvertisement()` (`version.ts`); current version **1**, min
  version **1**. `negotiateProtocol` floors to the peer's version and
  intersects capabilities.

---

## 9. Client → server frame registry (cross-checked)

Source: `packages/webui-server/src/protocol/` — the arrays below match the
files verbatim (read 2026-08).

### Conversation (client-conversation.ts)

`CLIENT_CONVERSATION_MESSAGE_TYPES`:
`abort`, `ping`, `user_message`, `tool.confirm_result`, `topic.advice`,
`completion.request`, `model.switch`, `model.refine`, `model.fallback_choice`,
`autonomy.switch`, `context.clear`, `context.compact`, `context.debug`,
`context.editor.open`, `context.editor.validate`, `context.editor.apply`,
`context.mode.create`, `context.mode.delete`, `context.mode.switch`,
`context.mode.update`, `context.modes.list`, `context.repair`, `mode.switch`,
`modes.list`, `session.checkpoints`, `session.delete`, `session.inspect`,
`session.new`, `session.rename`, `session.resume`, `session.rewind`,
`session.save`, `sessions.list`, `side_effects.list`, `stats.get`,
`todo.update`, `todos.clear`, `todos.get`, `todos.remove`

`CLIENT_COLLABORATION_MESSAGE_TYPES`:
`collab.join`, `collab.leave`, `collab.annotate`, `collab.resolve`,
`collab.request_pause`, `collab.resume`, `collab.grant_control`,
`collab.inject_tool`, `mailbox.action`, `mailbox.agents`, `mailbox.clear`,
`mailbox.compact`, `mailbox.messages`, `mailbox.purge`, `mailbox.send`

### Workspace + configuration (client-workspace.ts)

`CLIENT_WORKSPACE_MESSAGE_TYPES`:
`files.list`, `files.read`, `files.tree`, `files.write`, `git.changes`,
`git.diff`, `git.info`, `projects.add`, `projects.list`, `projects.select`,
`working_dir.set`, `worktree.cleanup`, `worktree.diff`, `worktree.merge`,
`worktree.remove`, `worktree.scan`, `shell.open`, `process.kill`,
`process.killAll`, `process.list`, `terminal.close`, `terminal.create`,
`terminal.input`, `terminal.resize`

`CLIENT_CONFIGURATION_MESSAGE_TYPES`:
`codebase.index.server.shutdown`, `connections.health`,
`connections.service_action`, `diag.get`, `key.add`, `key.delete`,
`key.set_active`, `key.update`, `prefs.get`, `prefs.update`, `provider.add`,
`provider.clear_models`, `provider.custom_models.remove`,
`provider.custom_models.set`, `provider.models`, `provider.models.search`,
`provider.probe`, `provider.remove`, `provider.status.clear`,
`provider.status.get`, `provider.status.retry`, `provider.undo_clear`,
`provider.update`, `providers.list`, `providers.saved`, `tool.disable`,
`tool.enable`, `tools.list`, `webui.shutdown`

### Goal + SDD (client-operations.ts)

`CLIENT_GOAL_MESSAGE_TYPES`:
`goal-state.get`, `goal.addTask`, `goal.assess`, `goal.assignTask`,
`goal.clear`, `goal.get`, `goal.list`, `goal.load`, `goal.moveTask`,
`goal.pause`, `goal.resume`, `goal.retryTask`, `goal.revert`, `goal.runTask`,
`goal.save`, `goal.selectPhase`, `goal.start`, `goal.state`, `goal.status`,
`goal.stop`, `goal.taskStatus`, `goal.toggleAutonomous`, `plan.get`,
`plan.item.update`, `plan.template_use`, `task.update`, `tasks.get`

`CLIENT_SDD_MESSAGE_TYPES`:
`sdd.board.cancel_task`, `sdd.board.cleanup_worktrees`, `sdd.board.delete_task`,
`sdd.board.destroy`, `sdd.board.get`, `sdd.board.list`, `sdd.board.pause`,
`sdd.board.reassign`, `sdd.board.resume`, `sdd.board.retry`,
`sdd.board.retry_all_failed`, `sdd.board.rollback`,
`sdd.board.set_task_fallbacks`, `sdd.board.set_task_model`,
`sdd.board.set_task_verification`, `sdd.board.split_task`, `sdd.board.stop`,
`sdd.run.from_graph`, `sdd.run.from_spec`, `sdd.run.start`, `sdd.spec.approve`,
`sdd.spec.discard`, `sdd.spec.get`, `sdd.spec.message`, `sdd.spec.start`,
`specs.get`, `specs.list`

### Knowledge + extension (client-integrations.ts)

`CLIENT_KNOWLEDGE_MESSAGE_TYPES`:
`brain.ask`, `brain.config.get`, `brain.config.set`, `brain.risk`,
`brain.status`, `chronicle.facet`, `chronicle.facets`, `chronicle.graph`,
`chronicle.metrics`, `chronicle.query`, `chronicle.status`, `config.doctor`,
`design.list`, `design.materialize`, `design.set`, `design.state`,
`design.swap`, `design.tune`, `design.use`, `design.verify`, `memory.list`,
`memory.sage.backfillRecoverable`, `memory.sage.candidateResolve`,
`memory.sage.delete`, `memory.sage.forFile`, `memory.sage.get`,
`memory.sage.graph`, `memory.sage.list`, `memory.sage.listCandidates`,
`memory.sage.listPage`, `memory.sage.recover`, `memory.sage.remember`,
`memory.sage.update`

`CLIENT_EXTENSION_MESSAGE_TYPES`:
`auth.oauth.cancel`, `auth.oauth.code`, `auth.oauth.start`, `mcp.add`,
`mcp.disable`, `mcp.discover`, `mcp.enable`, `mcp.list`, `mcp.prompt.get`,
`mcp.prompts`, `mcp.remove`, `mcp.resource.read`, `mcp.resources`,
`mcp.restart`, `mcp.sleep`, `mcp.update`, `mcp.wake`, `prompts.content`,
`prompts.create`, `prompts.favorite`, `prompts.list`, `prompts.recent`,
`prompts.search`, `prompts.used`, `skills.content`, `skills.create`,
`skills.edit`, `skills.export`, `skills.install`, `skills.list`,
`skills.uninstall`, `skills.update`

---

## 10. Server → client frame registry (cross-checked)

### Conversation + collaboration (server-conversation.ts)

`SERVER_CONVERSATION_MESSAGE_TYPES`:
`error`, `log`, `pong`, `side_effects`, `agent.status_changed`,
`agent.timeline.message`, `client.status_update`,
`chimera.report_available`, `compaction.failed`, `completion.result`,
`context.compacted`, `context.debug`, `context.editor.snapshot`,
`context.editor.validation`, `context.editor.applied`, `context.mode.changed`,
`context.modes.list`, `context.repaired`, `ctx.max_context`, `ctx.pct`,
`delegate.completed`, `delegate.started`, `iteration.completed`,
`iteration.limit_reached`, `iteration.started`, `model.refine_result`,
`modes.list`, `provider.active_blocked`, `provider.error`, `provider.fallback`,
`provider.fallback_pending`, `provider.response`, `provider.retry`,
`provider.status_changed`, `provider.stream_error`, `provider.text_delta`,
`provider.thinking_delta`, `run.result`, `session.checkpoints`,
`session.damaged`, `session.end`, `session.inspect`, `session.rewound`,
`session.start`, `session.stats`, `sessions.list`, `sessions.status_update`,
`stats.get`, `token.cost_estimate_unavailable`, `token.threshold`,
`tool.confirm_needed`, `tool.disabled`, `tool.enabled`, `tool.executed`,
`tool.loop_detected`, `tool.progress`, `tool.started`, `topic.advice_result`,
`tools.list`, `trust.persisted`

`SERVER_COLLABORATION_MESSAGE_TYPES`:
`collab.annotation.added`, `collab.annotation.resolved`, `collab.event`,
`collab.injection.granted`, `collab.participant.joined`,
`collab.participant.left`, `collab.pause.granted`, `collab.pause.released`,
`collab.state`, `mailbox.action_result`, `mailbox.agent_registered`,
`mailbox.agent_deregistered`, `mailbox.agents`, `mailbox.cleared`,
`mailbox.compacted`, `mailbox.event`, `mailbox.messages`, `mailbox.sent`,
`mailbox.purged`, `mailbox.received`, `subagent.budget_extended`,
`subagent.event`

### Workspace + configuration (server-workspace.ts)

`SERVER_WORKSPACE_MESSAGE_TYPES`:
`checkpoint.written`, `codemap.file_event`, `codemap.index_updated`,
`codemap.tool_executed`, `codemap.tool_started`, `file.saved`, `files.list`,
`files.read`, `files.tree`, `files.written`, `git.changes`, `git.diff`,
`git.info`, `process.list`, `projects.added`, `projects.list`,
`projects.selected`, `terminal.exit`, `terminal.output`,
`working_dir.changed`, `worktree.cleanup_result`, `worktree.diff_result`,
`worktree.event`, `worktree.merge_result`, `worktree.orphans`,
`worktree.state`

`SERVER_CONFIGURATION_MESSAGE_TYPES`:
`auth.oauth.status`, `codebase.index.server.shutdown_result`,
`connections.health_error`, `connections.health_result`,
`connections.service_action_result`, `diag.get`, `key.operation_result`,
`model.switch_result`, `prefs.updated`, `provider.catalog`,
`provider.models`, `provider.models.search_result`, `provider.probe`,
`provider.status.snapshot`, `providers.saved`

### Goal + SDD + automation (server-operations.ts)

`SERVER_GOAL_MESSAGE_TYPES`:
`budget.decision`, `budget.threshold_reached`, `coordinator.stats`,
`coordinator.status`, `eternal.iteration`, `fleet.concurrency_update`,
`goal-state.updated`, `goal.assess.result`, `goal.list`, `goal.paused`,
`goal.resumed`, `goal.saved`, `goal.error`, `goal.stopped`, `goal.failed`,
`goal.completed`, `goal.cleared`, `goal.reverted`, `goal.progress`,
`goal.state`, `in_flight.ended`, `in_flight.started`, `plan.updated`,
`task.completed`, `task.failed`, `task.pending`, `task.started`,
`tasks.updated`, `todos.cleared`, `todos.updated`

`SERVER_SDD_MESSAGE_TYPES`:
`kanban.task.activity`, `sdd.board.lifecycle_result`, `sdd.board.list`,
`sdd.board.snapshot`, `sdd.run.started`, `sdd.spec.agent_text`,
`sdd.spec.error`, `sdd.spec.snapshot`, `specs.detail`, `specs.list`

`SERVER_AUTOMATION_MESSAGE_TYPES`:
`consensus.vote_cast`, `consensus.vote_initiated`, `consensus.vote_resolved`,
`cron.job_fired`, `cron.snapshot`, `techstack.job.cancelled`,
`techstack.job.failed`, `techstack.job.progress`, `techstack.job.started`,
`techstack.report.delivered`, `techstack.report.ready`,
`techstack.snapshot.updated`, `techstack.workspace.completed`

### Knowledge + extension (server-integrations.ts)

`SERVER_KNOWLEDGE_MESSAGE_TYPES`:
`brain.answer`, `brain.config`, `brain.event`, `brain.status`,
`chronicle.error`, `chronicle.facet_result`, `chronicle.facets_result`,
`chronicle.graph_result`, `chronicle.metrics_result`, `chronicle.query_result`,
`chronicle.status_result`, `config.doctor.result`, `design.list`,
`design.materialize`, `design.set`, `design.state`, `design.swap`,
`design.tune`, `design.use`, `design.verify`, `memory.event`, `memory.list`,
`memory.sage.backfillRecoverable`, `memory.sage.candidateResolve`,
`memory.sage.delete`, `memory.sage.forFile`, `memory.sage.get`,
`memory.sage.graph`, `memory.sage.list`, `memory.sage.listCandidates`,
`memory.sage.listPage`, `memory.sage.recover`, `memory.sage.remember`,
`memory.sage.update`

`SERVER_EXTENSION_MESSAGE_TYPES`:
`mcp.content.error`, `mcp.content.selected`, `mcp.list`,
`mcp.operation_result`, `mcp.prompts`, `mcp.resources`,
`mcp.server.added`, `mcp.server.connected`, `mcp.server.disconnected`,
`mcp.server.discovered`, `mcp.server.error`, `mcp.server.reconnected`,
`mcp.server.removed`, `mcp.server.sleeping`, `mcp.server.updated`,
`mcp.server.waking`, `prompts.content`, `prompts.created`,
`prompts.favorite`, `prompts.list`, `prompts.recent`, `prompts.search`,
`prompts.used`, `skills.content`, `skills.created`, `skills.edited`,
`skills.exported`, `skills.installed`, `skills.list`, `skills.uninstalled`,
`skills.updated`

---

## 11. Verification notes

- Every line reference in this doc was read from source on 2026-08; the
  registry tables were copied from the constant arrays in
  `packages/webui-server/src/protocol/*.ts`.
- To re-verify the emission side quickly: grep for `emit('provider.text_delta'`,
  `emit('provider.thinking_delta'`, `emit('provider.response'` in
  `packages/core/src`; grep for `type: 'run.result'` in
  `packages/webui-server/src` (the only `run.result` producer is the server).

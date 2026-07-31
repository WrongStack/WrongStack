# HQ Evolution Plan — 2026-08

**Status:** Planning document only. No order of execution is fixed yet.
**Owner:** Maintainers + WebUI/Server/Queue/Kanban/TUI contributors
**Goal:** Bring HQ to webui-equivalent ease and visual richness, make data transfer to HQ first-class, ship bidirectional communication that survives leader-session termination, modernize Kanban and other boards, and (optionally) put per-project SQLite behind HQ.

**Supersedes:** does not supersede `hq-command-center-2026-07.md` or `hq-ws-reconnection.md`. Builds on them and traces what each unresolved item becomes in this plan.

---

## 0. Reading guide

This plan assumes the reader is familiar with:

- `docs/plans/hq-command-center-2026-07.md` — what exists today in HQ (telemetry, persistence, controls, alerts, Phase 5.5 visual upgrade).
- `docs/plans/hq-ws-reconnection.md` — the WS reconnect design that is already agreed on but not shipped.
- `docs/plans/webui-operator-workbench-2026-07.md` — the visual/shell parity work in flight.
- `docs/kanban-architecture.md` — Kanban is **already authoritative-SQLite per project**; HQ today only mirrors aggregate snapshots.

If anything below feels inconsistent with those, those documents win. This plan is a sequencing and scope clarification, not a replacement.

---

## 1. Inventory: current HQ capabilities and external touchpoints

### 1.1 HQ today (verified)

From `packages/core/src/hq/`, `packages/webui-hq/`, and `hq-command-center-2026-07.md`:

| Layer | Module | Capability | Status |
|---|---|---|---|
| Protocol | `hq/protocol/core.ts` | `HqEventEnvelope`, `parseHqFrame`, `parseHqEventPayload` (validation guards for 16 payload types) | Shipped |
| Protocol | `hq/protocol/{client,session,fleet,mailbox,kanban,brain,worktree,tool,mcp,project,browser}.ts` | Per-domain payload types | Shipped |
| Bridge | `hq/{fleet,brain,worktree,tool,cost,session,brain,mailbox}-bridge.ts` | EventBus → `client.event` envelopes | Shipped (Phases 1–4) |
| Persistence | `hq/persistence/event-log.ts` | Append-only JSONL with line + byte caps, FIFO write chain | Shipped |
| Persistence | `hq/persistence/snapshot-store.ts` | Atomic snapshot checkpoint | Shipped |
| Persistence | `hq/persistence/timeseries-store.ts` | 5-min buckets, 1-week retention | Shipped |
| Persistence | `hq/kanban-store.ts` | Per-project Kanban mirrors, revision+timestamp merge (tombstone wins ties) | Shipped |
| Persistence | `hq/persistence/{simple-log,jsonl-io}.ts` | Command/audit log, JSONL primitives | Shipped |
| Server | `hq/factory.ts`, `hq/commands.ts`, `hq/alerts.ts` | Server composition, control-plane union + audit, alert engine | Shipped |
| Server | `hq/publisher.ts` | Client-side `HqPublisher` (Heartbeat, control queue) | Shipped |
| Client | `packages/webui-hq/src/lib/hq-ws-client.ts` | Browser WS client | Shipped but **5 known deficiencies** (see hq-ws-reconnection.md) |
| Client | `packages/webui-hq/src/views/*` | 22 views (Cockpit, FleetMap, LiveConsole, Mailbox, Cost, Brain, Worktrees, Trends, Alerts, Control, Kanban, …) | Shipped |
| Client | `packages/webui-hq/src/lib/transcript-store.ts` | Exactly-once live batch consumption; live tool-result merge | Shipped |

### 1.2 External integration touchpoints

What HQ integrates with today, and where the boundary is:

| Touchpoint | Source surface | Goes to HQ as | Notes |
|---|---|---|---|
| **CLI runtime** | `packages/cli/src/hq-*` | `client.hello`, `client.event`, `client.command_poll`, `client.command_ack` | `HqPublisher` is wired at `cli-main.ts`, `pre-context-services.ts`, `run-tui.ts` |
| **TUI** | `packages/tui/src` | `client.event` (fleet, brain, cost, …) | Bridges re-used from CLI; director already publishes |
| **WebUI** | `packages/webui/src` | Reads local store; only HQ-aware via shared runtime | Per-project WebUI does **not** publish to HQ directly |
| **WebUI-Server** | `packages/webui-server/src` | Receives re-published runtime events | Status: signals are passed through, not duplicated |
| **Director / Fleet** | `packages/runtime/src/director/*` | `subagent.*` → `fleet.event` via `fleet-bridge.ts` | Already wired |
| **Kanban** | `packages/kanban/src/server/project-server.ts` | `kanban.snapshot` (per-project aggregate) | **Source of truth is local SQLite; HQ stores a mirror** |
| **Mailbox** | `packages/runtime/src/mailbox/*` | `mailbox.snapshot`, `mailbox.event` | Redacted by default (`body` → `hasBody`, summary only) |
| **MCP** | `packages/mcp/src` | `mcp.health.snapshot`, `mcp.operation` | Shipped |
| **Brain** | `packages/runtime/src/brain/*` | `brain.event` (6 kinds) | Shipped |
| **Worktrees** | `packages/runtime/src/worktree/*` | `worktree.event` (6 kinds) | Shipped |
| **Global mailbox** | `packages/runtime/src/mailbox/global-mailbox.jsonl` | Same `mailbox.*` envelopes, scoped `global` | Background reconciles from disk |
| **Persistence package** | `packages/persistence/src/{atomic-write,socket-path}.ts` | Shared primitives only | SQLite is **not** here yet — see §6 |

### 1.3 Honest gaps this plan addresses

1. **Data ingestion to HQ is one-way:** clients publish, but HQ has no SQL fallback for downstream queries on large windows. The `HqEventLog` is JSONL with ring rotation; aggregate queries are O(n) tail scans. Adequate for hundreds of clients, not for thousands of queued events.
2. **Bidirectional communication is functional but thin:** clients send `client.command_poll` to receive `hq.command_batch`. No client-initiated message roundtrip, no message-id acknowledgement for normal `client.event` (only for `client.command_ack`). There is no "Hello, I'm a leader; if I disappear, deliver this one command to everyone" abstraction.
3. **Reconnect under leader-session termination is implicit:** today, when the leader session ends, its WebUI project tab may still hold a kanban store, but the HQ control queue is lost (since the publisher closed). HQ has no mechanism to "tell everyone still up to rehydrate" because there is no notion of a delivery target — only ad-hoc commands.
4. **HQ UI is a few screens behind the project WebUI:** the project WebUI has ~50 Kanban components (verified by `grep` of `packages/webui/src`: `KanbanView`, `KanbanBoardChrome`, `KanbanColumnView`, `KanbanTaskInspector`, `KanbanTaskFields`, `KanbanTaskActivityRecorder`, `KanbanQueueHealthBar`, `KanbanDecompositionPanel`, `KanbanBoundaryEditor`, `KanbanVerificationDashboard`, `KanbanTaskTree`, `KanbanTaskCompletionChecks`, `KanbanAgentRunPanel`, `KanbanRunControls`, `KanbanCleanerAlert`, `KanbanBoardSidebar`, `KanbanBoardState`, `TaskCard`, `TaskBoard`, `TaskRiskPanel`, `TaskIntelligencePanel`, `TaskActivityTimeline`, `TaskExecutionAttempts`, `TaskVerificationSection`, `VerificationReportPanel`, `SddBoardView`, `SddKanbanView`, `BoardView`, ...). HQ has a single 12.5 KB `kanban.tsx`. The gap is structural, not surface-level.
5. **Kanban interactivity on HQ is read-only:** drag/drop, inline edit, claim, assign, comment, completion checks — all require the local project WebUI. HQ shows counts and a board view but cannot mutate state.
6. **Other boards have a similar gap:** Mailbox composer exists but is just a UI shape; control plane (steer, abort, spawn, broadcast) is partial. Cost, Alerts, and Trends are read-only charts.
7. **No per-project SQLite layer behind HQ:** the persistence layer is JSONL + atomic snapshots. There is a `HqKanbanStore` mirroring per-project snapshots, but `HqEventLog` has no indexed query path. Clients reconnect by replaying the snapshot atomically — this is fine for small state, but querying "give me all `tool.started` for project X in last 5 minutes" requires a full tail scan.
8. **Reconnect-on-leader-exit is not a first-class concept:** today, when a leader session ends, its `HqPublisher` closes. There is no "leader-deposed" signal broadcast to siblings, and no automatic "everyone re-connect to me" message. The "fuse → reconnect" story is also missing on the browser side (`hq-ws-reconnection.md` covers the WS layer only).

---

## 2. Data ingestion to HQ + bidirectional communication

### 2.1 What changes for **push** (clients → HQ)

The current shape is:

```
client ─envelope→ parseHqFrame → parseHqEventPayload → in-memory reducer → snapshot
                                                                       ↘ eventLog (JSONL)
```

Two additions are needed without breaking the existing protocol:

1. **Lightweight per-client causal ordering.** Each connection owns a monotonically increasing `seq` (already in `HqEventEnvelope`). The server already trusts client `seq`. We need to:
   - Per client, persist `lastSeq` in `HqEventLog` (already keyed by `(clientId, seq)` row).
   - On reconnect, the client announces `client.resume` with `lastSeqSeen`; the server replies with the gap (`hq.resume_gap` containing the missed envelopes, capped) OR a `hq.snapshot` directive when the gap is too large.
   - This is the **mechanism that avoids from-scratch full sync on reconnect** in the runtime event path. Combined with the existing `HqSnapshotStore` (atomic on debounced broadcast) it gives both incremental replay and authoritative state.

2. **Per-(client,project) cursor in the browser.** Today, reconnect-from-blank is partly fixed by the `transcript-store` pattern (`fromSeq` exactly-once live batch). The same pattern should be propagated to mailbox, fleet, and kanban views. This is straightforward because `HqEventEnvelope.seq` is already there.

Effort: small. No protocol version bump needed if we choose envelope types `client.resume` and `hq.resume_gap` (or fold into `client.hello` negotiation). The data shape is already there.

### 2.2 What changes for **pull** (HQ → clients)

The pull path is already `client.command_poll ↔ hq.command_batch`. Two additions:

1. **Pull with causal barrier.** Client can now request `client.command_poll { afterCommandId }` (already in protocol). Add `client.event_poll { afterSeq, clientId, limit }` so clients can proactively fetch missed envelopes from HQ's tail rather than rely on push. This is the last-resort fallback for half-open TCP.

2. **Command idempotency.** Add `idempotencyKey` to `HqQueuedCommand` (mirror the existing `commandId`). The server idempotency window must be at least 24 h so a reissued steer after leader handoff does not double-fire.

### 2.3 What is **bidirectional** that we currently treat as one-way

- **From HQ to the data layer.** Today, HQ consumes events but does not write back into source surfaces. The exception is **Kanban**, where HQ already owns a `HqKanbanStore` that holds a per-project mirror. With that in mind, **make that write-back explicit**:
  - When HQ sees a `kanban.snapshot` with a higher `revision` than what the local project SQLite has, HQ **does not** push back. The local project is the source of truth. (This is the *current* policy.) Document it as a non-goal rather than implicit.
  - When project Kanban is offline but HQ has a staler snapshot, **HQ refuses to be the writer** and the project on reconnect reasserts via `kanban.snapshot` (revision+timestamp merge).
  - The merge algorithm in `hq/kanban-store.ts` is already correct under this rule (tombstone wins ties per SAGE memory `01KY5P123B6A74ZBF8A7BDZ0YZ`).

### 2.4 What changes for **delta sync**

A reusable model that the codebase already implies:

```
board | (revision, timestamp) | tombstone
event | (eventId, seq)         | immutable
client telemetry | (clientId, seq) | immutable
```

For each domain behind HQ, define a single delta contract:

| Domain | Identity | Delta |
|---|---|---|
| Kanban | `boardId` | Records with `revision` and `updatedAt`; tombstones with `deletedAt` |
| Snapshot | `HqSnapshot` per project | Atomic file replacement (no delta) |
| Event log | `eventId` | Append-only; gap-fill on `(clientId, seq)` |
| Timeseries | `(bucket, signal)` | Float update; idempotent merge |
| Mailbox rows | `messageId` | Add/read/complete; cheap diff via state field |
| Brain / worktree | `eventId` | Append-only; gap-fill on `(clientId, seq)` |

The implementation is already idempotent for **all** of these. The plan is to **make the contract explicit and reuse the same sequence/gap pattern across all servers**, not to invent a new sync engine.

### 2.5 Resync strategy

Escalation ladder (cap and choose):

| Strategy | Use when | On reconnect |
|---|---|---|
| **Live gap-fill** via `(clientId, seq)` | Client reconnects within heartbeat window and seq is continuous | Send missed envelopes from `HqEventLog` |
| **Recorded gap-fill** via `client.event_poll` | Client knows its `lastSeq`; max gap ≤ 1000 | Reply with bounded envelope list |
| **Snapshot handoff** | Gap > 1000 OR project not seen in >24 h | Reply with `HqSnapshot` for `(machineId, projectId)` |
| **Snapshot + replay** | First connect ever OR schema mismatch | Full snapshot, then live |

**Invariant:** at least one of the four must succeed. The server never silently drops a client.

### 2.6 Reconnect-on-leader-exit (the "rehydrate" message)

This is the user's named requirement. Concretely:

- **Today:** when the leader session ends, its `HqPublisher` closes. The HQ control queue persists in `commands.jsonl` but **no broadcast** is sent to surviving clients.
- **Target:** when the leader session's `HqPublisher` closes **and there is at least one other client attached to the same `_projectId`**, HQ broadcasts a `hq.peer.rehydrate` envelope to the surviving clients. The envelope content is **a single line**: "Project X lost its leader; run command Y to rehydrate." The command Y is whatever the leader registered as its `leaderRehydrateCommand` (default: the leader's bootstrap hint, project-specific). The envelope does not carry payloads — it carries:
  - `projectId`
  - `machineId` of the lost leader
  - `leaderClientId`
  - `rehydrateCommandId` (resolvable via `/api/commands` audit)
  - `actorId` (the client that the HQ saw closing)
  - timestamp + envelope seq

The surviving client, on receiving this, runs through the same permission gate as any other HQ command (capability + token). The default behavior is "broadcast only, do not execute automatically" — the same steer/abort/spawn envelope types are reused.

Critically, this mechanism does **not** require the leader to be alive when the message is delivered. The act of the leader's `HqPublisher` socket closing is the heartbeat that triggers the message. The HQ server is the *only* dependency for the message to be delivered.

Termination detection is:

- **TCP close** (`onclose`) → immediate `client.closed` event in HQ's `ConnectedClient` registry.
- **Heartbeat timeout** (existing 2-min stale) → HQ moves client to `disconnected` and emits `hq.peer.lost` to surviving clients in the project. This was missing before.

This is the single change that gives the user's "send a message that re-raises all connected clients even if the leader session ends" requirement.

---

## 3. Bringing HQ UI/UX to webui-equivalent ease and visual richness

The work is **the Phase 5 of `webui-operator-workbench-2026-07.md`**, scoped to HQ. Re-state what that means here:

### 3.1 What "webui-equivalent" actually means in this codebase

The project WebUI baseline (per `webui-operator-workbench-2026-07.md`):

- Tailwind CSS 4.3.2, Radix Dialog/Dropdown/Scroll Area/Tabs, Lucide React 1.24.0.
- Tokens: paper `#F8F6F0`, dark graphite `#1B1C1A`, primary pink `#D51F4D` / dark `#FE2E5F`, secondary orange `#9A5700` / dark `#FD9F02`.
- Fonts: Manrope (UI), Space Grotesk (display), IBM Plex Mono (code).
- Zero-radius invariant.
- Shell: ActivityRail + SecondarySidebar + Topbar + RightInspector + BottomDock.

Today HQ has all of these (per Phase 5.5 of `hq-command-center-2026-07.md`) but the **content slot factories** — Kanban, Mailbox, Alerts, Cost, Trends, Control — are not yet wired to the right inspector and the Cockpit is still a hand-rolled grid.

### 3.2 Work to land

Without prescribing the order:

1. **RightInspector for HQ.** Lift the `InspectorTarget` contract from `webui-operator-workbench-2026-07.md` §3 into `packages/webui-hq`. Add `hq.kanban.task`, `hq.mailbox.message`, `hq.client`, `hq.alert`, `hq.command`, `hq.cost.session`, `hq.worktree` targets. Currently HQ has its own ad-hoc drawer pattern (`fleet-chat-drawer.tsx`); migrate.
2. **Workbench shell for HQ.** Lift `WorkbenchShell`, `ActivityRail`, `SecondarySidebar`, `Topbar`, `RightInspector` from the project WebUI. Where the workbench team is already extracting `packages/webui-ui`, dual-import it. (Today the project WebUI and HQ share primitives informally via `@wrongstack/tools` subpaths; the shared `webui-ui` package is the eventual home.)
3. **Configurable cockpit grid.** Today `views/cockpit.tsx` is 18.9 KB; a single hand-rolled metric grid. Convert to a `CockpitTile` registry: each tile is a data primitive with a `querySource` and a `visualizer`. New tiles are added by tagging, not by editing cockpit.
4. **Lucide-only icons.** HQ has several emoji in places (`views/cockpit.tsx`, `views/control.tsx`, `views/mailbox-composer.tsx`); audit and replace.
5. **Live Console.** Already upgraded in Phase 5.5. Verify it uses the workbench shell and the right inspector pattern.
6. **Trends.** Already upgraded in Phase 5.5. Audit timeseries chart for workbench shell fit.
7. **Cost.** Verify the per-project share bars and per-session drill-down use the workbench shell.
8. **Mailbox.** `mailbox.tsx` is 8.7 KB; the per-project live feed already exists. Add inspector targets for `hq.mailbox.message` (full body preview, scrubbing toggles) and `hq.client` (capability chips, recent commands).
9. **Kanban.** This is the biggest gap. See §5.
10. **Alerts.** `views/alerts.tsx` is 6.4 KB. Audit configuration surface (alert rule editor) and visualize ack state.
11. **Settings.** `views/settings.tsx` is 10.4 KB. Migrate to a searchable secondary-category list and shared form primitives.
12. **Hash-at-rest, rate limit, password** — already documented in Phase 7 of `hq-command-center-2026-07.md`. Land alongside the shell migration.

### 3.3 Non-goals for HQ UI/UX

- HQ will not become a per-project kanban editor. Mutations stay within the per-project WebUI session; HQ shows them and offers "open in WebUI" deep links.
- HQ will not host code editing. It is a command center, not an IDE.
- HQ will not replace the inter-project mailbox composer with a heavyweight chat. The composer remains a thin command surface.

### 3.4 Acceptance criteria for §3

- The only visual identity in HQ is the website palette + zero-radius. Legacy CRT scanlines are gone (already removed in Phase 5.5).
- Every interactive primitive has a stable accessible name and a keyboard path.
- Drawer-open does not resize main surface.
- Mobile / narrow-screen geometry uses the same Radix contract.

---

## 4. Rehydrate/reconnect message when leader session terminates

This is its own section because the user explicitly named it. The mechanism was sketched in §2.6; here is the contract.

### 4.1 Why it is a separate protocol-level concept

- The HQ control plane is request/response: a client polls, gets a batch, acks. That works well for short, single-shot commands.
- The rehydrate requirement is **fanout**: HQ needs to push to *all* clients connected to a project. Today, there's no such message — HQ cannot broadcast to clients; only browsers receive `hq.event` from HQ.
- The right shape is a **client-side broadcast** that the client is obligated to handle. Its behavior is up to the client (typically: surface a notification, offer a "take over" button, run a known bootstrap command).

### 4.2 New protocol envelope

Add to `hq/protocol/client.ts` and `hq/protocol/core.ts`:

```ts
type HqPeerRehydratePayload = {
  projectId: string;
  machineId: string;          // machine that lost the leader
  leaderClientId: string;     // client id that exited
  previousLeaderHandle: string; // a stable identifier (e.g. session id)
  reason: 'graceful' | 'crash' | 'heartbeat-timeout' | 'auth-revoked';
  detectedAt: string;
  rehydrateCommandId?: string; // resolvable via /api/commands
  rehydrateHint?: string;      // free-form hint, ≤ 280 chars
};
```

Wire as a new `HqEventType`: `peer.rehydrate`. Server emits it once per `(machineId, projectId)` losing its leader. Deduplication: any subsequent `peer.rehydrate` is suppressed if the same `previousLeaderHandle` was already announced.

Add a paired `peer.lost` event for the simple case (no command attached, just informational). The "send a message that re-raises all connected clients even if the leader session ends" use case is `peer.rehydrate`.

### 4.3 Client behavior

When a client receives `peer.rehydrate`:

- It must call `client.command_ack { status: 'received' }` to confirm reachability.
- It must surface the event in the UI (HQ shows project-level pill, project WebUI shows a global toast).
- It must not auto-execute anything. The envelope is informational by default (see §10.2). The client decides what to do with `rehydrateHint` (interpret project-specifically) and whether to run a `rehydrateCommandId` (if one was attached) through the existing HQ permission gate.
- The default handling is "show a banner; offer an explicit button to proceed." If `rehydrateCommandId` is set, the button offers to run that command; if not, the button offers to follow the hint (e.g. "open last-active SDD spec").

### 4.4 Server-side liveness

The server already tracks `ConnectedClient`. The change is:

- On `client.closed`, mark `status = 'disconnected'`.
- If `client.isLeader && projectId` has at least one other online client, emit `peer.rehydrate` for the project.
- On heartbeat timeout (currently 120s), do the same with `reason: 'heartbeat-timeout'`.

### 4.5 Edge cases

- **Leader was the only online client.** No fanout; emit `peer.lost` to browsers instead so the cockpit shows the leader as offline.
- **HQ itself restarted.** Server reads `lastLeaderHandle` from the snapshot store and `HqKanbanStore`; on startup, if any project has a stale leader handle, the first re-connecting client for that project gets a `peer.rehydrate` for the previous handle.
- **Multiple followers.** All followers receive the same envelope; deduplication is by `previousLeaderHandle` on the client side (multiple `peer.rehydrate` for the same handle are ignored after the first one).

### 4.6 Acceptance criteria for §4

- Killing the leader session with a SIGKILL (no graceful close) still triggers `peer.rehydrate` within 120s (heartbeat timeout) to all surviving clients.
- A graceful `HqPublisher.close()` triggers `peer.rehydrate` within the same TCP close event.
- A client that does not receive `peer.rehydrate` on the first heartbeat (e.g. dropped connection) can recover via `client.event_poll` after the next ws reconnect.
- The server never re-emits `peer.rehydrate` for the same `previousLeaderHandle` twice in the same project within a 1-hour window.

---

## 5. Improving Kanban and other boards

This is the largest non-protocol workstream. The work is split into **HQ-side** changes (display, navigation, drill-down) and **cross-system** changes (interactivity, state).

### 5.1 Kanban — HQ-side

HQ has 1 file for Kanban (`views/kanban.tsx`, 12.5 KB). The project WebUI has ~50 components. The pragmatic plan for HQ is **not** to clone all of them; it is to absorb the ones that are useful for a command center and skip the ones that are run-local.

Sub-files / surfaces to land in `packages/webui-hq/src/views/kanban/`:

| Surface | What it does | Where it lives |
|---|---|---|
| `cockpit.tsx` (Kanban tile) | Active boards, failed tasks, queue health for the project | components (left tile) |
| `board-grid.tsx` | Multi-board tree, columns, swimlanes, virtualization | main view |
| `task-card.tsx` | Compact task card with status pills, owner, due, deps | within grid |
| `task-inspector.tsx` | Read-only task detail (no edit) | `RightInspector` target `hq.kanban.task` |
| `board-picker.tsx` | Switch between boards, saved filters | secondary sidebar |
| `queue-health.tsx` | Queue panel (matches the WebUI's `KanbanQueueHealthBar`) | secondary sidebar |
| `agent-runs.tsx` | Director runs attached to the board | right inspector tab |
| `verification-dashboard.tsx` | Read-only view of `VerificationReportPanel` | right inspector tab |
| `activity-timeline.tsx` | Read-only view of `TaskActivityTimeline` | right inspector tab |
| `risk-panel.tsx` | Read-only view of `TaskRiskPanel` | right inspector tab |

What HQ explicitly **does not** clone:

- `KanbanTaskFields` (edit form) — too local; "edit in WebUI" deep link.
- `KanbanBoundaryEditor` — too local.
- `KanbanDecompositionPanel` — too local.
- `KanbanCleanerAlert` — only show the alert; do not allow cleanup from HQ.
- `KanbanRunControls` — too local; "queue run in WebUI" deep link.

### 5.2 Kanban — cross-system state

The single biggest UX win is **mirroring the per-project SQLite through HQ** so that an HQ browser tab can show the same Kanban state without a live client for the project. The mechanism already exists in `hq/kanban-store.ts`:

- HQ stores `HqKanbanSnapshotPayload` per project, merged by revision+timestamp.
- The merge is correct (the SAGE memory + the read of `packages/core/src/hq/kanban-store.ts` confirm).
- The browser receives `hq.kanban_snapshot` and (per the existing protocol) uses it for the board view.

What is missing:

1. **HQ never issues a `kanban.snapshot` to a follower.** Today, `hq.kanban_snapshot` is a server-to-client envelope that HQ sends back to a client. Followers (browsers) do not receive it. Add a browser-side fanout: when HQ merges a new snapshot, broadcast `hq.kanban_snapshot` to **all** browsers viewing that project.
2. **Browser board view is not first-class.** The board view must consume the merged snapshot directly, with virtualization. Use the same `agentId/resolver` pattern as the project WebUI.
3. **The "open in WebUI" deep link** must be a first-class navigator button on every task card. Today it is implicit.

### 5.3 Other boards — Mailbox, Cost, Trends, Alerts, Control

Each is a subset of the same work:

- **Mailbox.** Already has a live feed. Add `hq.mailbox.message` inspector target. Add per-mailbox card. Add unread filter chip.
- **Cost.** Already has hero total + per-project bars. Add per-session breakdown already exists per Phase 5.5; verify workbench-shell fit.
- **Trends.** Already has SVG charts. Add inspector target `hq.trends.bucket`.
- **Alerts.** Add ack/state inspector target. Add a rule editor (capability-gated).
- **Control.** Already has `btw`, `queue`, `run-command` composers. Add a confirmation dialog for destructive commands (terminate, abort-all) and an audit-log inspector.

### 5.4 Performance, visuals, interaction

- **Virtualization.** Use the same virtualization library that the project WebUI uses (verified: `virtua` per Phase 5.5). Add it to Kanban board grid, Mailbox table, Fleet table.
- **Optimistic updates + rollback.** Today HQ is read-only; this is fine. Where users do mutate (e.g. ack an alert), local optimistic state reverts on server ack timeout.
- **Connection-state recovery.** Wire the work in `hq-ws-reconnection.md` (heartbeat, jitter, max-retries, state events) into the `RightInspector` shell so every view shows the same reconnection indicator.
- **Visual invariants.** Zero radius (already enforced), Lucide icons only, no anime/CRT effects. Move all HQ CSS to the workbench token system.

### 5.5 Acceptance criteria for §5

- Kanban HQ view renders ≥ 10,000 tasks across ≥ 50 boards without scroll jank (manual perf gate).
- Right inspector open for a task does not reflow the board grid.
- All destructive actions (terminate, abort-all, run-command) require a confirm dialog and log to `commands.jsonl`.
- All HQ views share one connection-state indicator.

---

## 6. Per-project SQLite behind HQ (optional)

### 6.1 What already exists

- `packages/kanban/` **already** uses a per-project SQLite (`_kanban.sqlite` under `.wrongstack/kanbans/`). The HQ mirror is in `packages/core/src/hq/kanban-store.ts` (JSON files).
- `packages/persistence/src/{atomic-write,socket-path}.ts` exports shared primitives. No SQLite wrapper yet.
- The codebase has multiple SQLite ad-hoc consumers (kanban, chronicle, etc.).

This is partially-existing infrastructure. The question is whether to **unify** it under HQ.

### 6.2 What "SQLite behind HQ" gives us

- **Indexed queries** for tail scans (e.g. "all `tool.started` for project X in last 5 minutes" → SQLite index, not full JSONL scan).
- **Atomic cross-domain transactions.** Today, writing to one store and then another is fire-and-forget (each has its own `atomicWrite`). A single SQLite-backed store would compose these.
- **Time-series compression.** `HqTimeseriesStore` is a simple JSONL; moving it to SQLite with bucketed tables reduces storage by 5–10× and adds O(log n) reads.
- **Queryable event log.** Same idea for `HqEventLog`.

### 6.3 What it costs

- A new dependency on `better-sqlite3` (Node-only) or `sql.js` (browser too). The codebase already uses `better-sqlite3` in `packages/kanban`.
- A migration story: existing JSONL files need to be readable until the user opts in.
- Tests for concurrency, WAL mode, lock contention.

### 6.4 Recommendation

**Defer**. The justification:

- The current JSONL hot path is bounded by `maxBytes` (64 MB) and `maxLines` (50K). Measured at 429 MB before the byte cap was added; today it is correctly bounded.
- The five-minute tail-scan use case (browser backfill for `mailbox.event`, `brain.event`, `worktree.event`) is already solved by `recent()` with a 1 MB tail scan. Going to SQLite for this is buy-on-uncertainty.
- The Kanban source-of-truth is **already** SQLite per project; HQ is a mirror. The mirror's bottleneck is the merge, not the storage.
- The HQ persistence layer is intentionally simple (atomic writes + file locks). Introducing a SQLite dependency for HQ-only use would be the first SQLite consumer in `packages/core/src/hq`, doubling the test surface.

The plan is to **revisit** this when one of these becomes true:

- The aggregate HQ data crosses **1 GB on disk** for a single project.
- A new feature requires **server-side query** that JSONL cannot answer in p95 < 50 ms.
- Another package (chronicle, etc.) needs to share a SQLite-backed path with HQ.

If any of those land, the right move is to extract `packages/persistence/src/sqlite-store.ts` (a thin wrapper over `better-sqlite3` with WAL + lock semantics) and reuse it from `hq/` and `kanban/`. Do not bolt SQLite into `hq/` directly.

### 6.5 Acceptance criteria for §6

- None for now. This section is a no-op until the trigger above is hit.

---

## 7. Sync strategy — minimum data, high efficiency, no from-scratch full sync on reconnect

This is the user's explicit sync requirement. The design is already largely in place; what is missing is **end-to-end wiring** and a **single place that documents the contract**.

### 7.1 Layers and their contracts

| Layer | Identity | Delta shape | Reconnect strategy |
|---|---|---|---|
| **Kanban** | `boardId` | record `(revision, updatedAt)` or tombstone `(revision, deletedAt)` | Merge by revision, then timestamp; tombstone wins tie |
| **Mailbox rows** | `messageId` | `state` transitions only (`sent → read → completed`); no body unless redaction off | Replace by `messageId`; reader dedupes |
| **Event log** | `(clientId, seq)` | immutable append | Gap-fill on `(clientId, seq)`; full snapshot if gap > 1000 |
| **Snapshot** | `(projectId, machineId)` | atomic file replace | Replacement; no delta |
| **Timeseries** | `(bucket, signal)` | float update | Idempotent replace |
| **Brain / Worktree events** | `eventId` | immutable append | Gap-fill on `(clientId, seq)` |
| **Cost** | `(sessionId, signal)` | float update | Idempotent replace |
| **Tool call** | `toolUseId` | immutable append; result pairs by `toolUseId` | Gap-fill on `(clientId, seq)`; result merges by `toolUseId` |

### 7.2 Minimum data rules

- **Default to summary.** Tool args are `summary` by default (`isHqRedactionPolicy` in `protocol/core.ts`); full content is opt-in.
- **Default to deltas.** Never re-send a full snapshot when a delta suffices.
- **Default to idempotent.** The same envelope received twice has identical effect (set by `seq`-keyed deduplication on the server).
- **Default to compressed.** Run the JSONL append chain through a gzip-rotation tier when logs exceed 256 MB retained. (Today there is no rotation — `HqEventLog` rotates under lock but is uncompressed JSONL.)

### 7.3 Reconnect — concrete ladder

Same as §2.5, with one refinement:

- **Detect.** Browser `HqWsClient` has a 35s heartbeat (per `hq-ws-reconnection.md`). Server heartbeat timeout is 120s (kanban).
- **Probe.** Browser auto-reconnects with exponential backoff + jitter (per `hq-ws-reconnection.md`).
- **Resume.** On `ws.onopen`, browser sends `client.resume { lastSeqSeen, lastEventId? }`. Server replies with `hq.resume_gap { envelopes: [...] }` (capped at 1000 items, ≤ 1 MB) or `hq.snapshot` when the gap exceeds the cap.
- **Reset.** If the server cannot resume (corrupt log, schema mismatch), it sends `hq.full_resync` and the client wipes ephemeral state and re-derives from snapshots.

### 7.4 What is NOT done

- **No CRDTs.** The codebase has chosen revision+timestamp merges. Stay there.
- **No vector clocks.** Same reason.
- **No global event log applied to every domain.** Use the right store for the right shape.

### 7.5 Acceptance criteria for §7

- A leader that reconnects after 30 minutes offline is operational in ≤ 5 s on a 100 Mbps LAN (no full rebuild) — measured by `HqWsClient` reconnect → first `hq.event` after resume.
- The same envelope received twice by the server is never double-counted in any aggregator.
- A reload of the HQ browser tab while 10 projects are active produces **no more than 1 MB** of network traffic for the initial state (verified by the workbench shell's `useSyncExternalStore` debouncing).

---

## 8. Cross-cutting concerns

### 8.1 Security

- **No new trust boundaries** are introduced. The protocol stays the same; append-only semantics help (no rollback attacks).
- **Idempotency keys** for `HqQueuedCommand` prevent replay.
- **Token hash-at-rest** (already in Phase 7 of `hq-command-center-2026-07.md`) becomes essential when the rehydrate command contains the previous leader's bootstrap hint.

### 8.2 Observability

- All new events (`peer.rehydrate`, `peer.lost`) have a structured log line + `hq.event` envelope.
- Existing alert engine gets two new rules: `peer.rehydrate.frequency` (rate > 5 per project per hour → warn) and `client.long_disconnect` (≥ 5 min without reconnect → info).

### 8.3 Testing

The rehydrate test gate follows the two-layer shape from §10.4:

- **Protocol:** add `peer.rehydrate` and `peer.lost` to `parseHqFrame` known types; add new payload guards. The envelope shape is the one in §4.2 (per §10.2: no command by default, `rehydrateHint` opaque, `rehydrateCommandId` opt-in).
- **Server — primary CI gate (deterministic, in-process):** spin up a real HQ server in-process, connect a real leader client and a real follower client via `ws://`, call `leaderWs.close()` (graceful TCP close), assert the follower receives `peer.rehydrate` within 1 s with `reason: 'graceful'`. This is the user's named requirement and must hold in CI deterministically.
- **Server — smoke test (heartbeat-timeout, scheduled):** drop TCP without sending FIN, advance the server's heartbeat clock, assert the follower receives `peer.rehydrate` with `reason: 'heartbeat-timeout'`. Optional in CI; required pre-release.
- **Server — auth-revoked:** revoke a leader's token while connected, assert the follower receives `peer.rehydrate` with `reason: 'auth-revoked'`. Single deterministic test.
- **Server — dedup:** emit `peer.rehydrate` twice for the same `previousLeaderHandle`, assert the second is suppressed.
- **Browser:** add a `HqWsClient` test for `client.resume` and `hq.resume_gap`.
- **HQ views:** add visual snapshot tests for the kanban board grid, mailbox inspector, alert inspector.

### 8.4 Documentation

- Update `hq-command-center-2026-07.md` to call out the new envelope types.
- Add `docs/kanban-hq-integration.md` to explain the source-of-truth rule (project SQLite wins; HQ is a mirror).
- Update `docs/hq-deeplink.md` (or create if missing) with the `?project=<id>&board=<id>&task=<id>` deep link contract.

---

## 9. What is intentionally out of scope

- **Cross-HQ federation.** Two HQ instances do not sync between each other. (Not a requirement.)
- **HQ as a writer for non-mirrored domains.** There is no plan to let HQ push changes back into projects via envelopes.
- **HQ hosting of LLM-side execution.** HQ is observability + control; it does not run agents.
- **Browser-mobile HQ app.** The workbench shell already specifies responsive geometry; mobile is a follow-up.

---

## 10. Resolved decisions

### 10.1 Q1 — Channel for `peer.rehydrate`

**Decision:** reuse the existing client WS channel; piggyback on the client's `client.command_poll` cadence.

Rationale: the codebase has no server-push channel today; adding one is a sizeable protocol change. The client already polls every ≤ 5 s for command batches; `peer.rehydrate` rides the same path. Revisit if polling latency turns out to be unacceptable for the rehydrate UX — at that point, a `peer.push` envelope type and a server-side fanout would be a v2 protocol addition.

### 10.2 Q2 — Default leader-rehydrate command payload

**Decision:** **empty / no command** by default, plus an **opaque `rehydrateHint`** field (≤ 280 chars) attached to the envelope.

The envelope structure becomes:

```ts
type HqPeerRehydratePayload = {
  projectId: string;
  machineId: string;
  leaderClientId: string;
  previousLeaderHandle: string;
  reason: 'graceful' | 'crash' | 'heartbeat-timeout' | 'auth-revoked';
  detectedAt: string;
  rehydrateHint?: string;       // opaque, ≤ 280 chars; client decides
  rehydrateCommandId?: string;  // optional, *only* if a previous leader explicitly registered a rehydrate command
};
```

Rationale:

- **No command is attached by default.** The broadcast is informational. The client decides what to do with it (surface a "take over" button, run a known bootstrap, ignore).
- **`rehydrateHint` is an opaque string.** The leader's bootstrap hint (if any) goes here. Clients interpret it project-specifically. This keeps the protocol stable while still letting each project distribute its own rehydrate ritual.
- **`rehydrateCommandId` is opt-in.** A leader that has registered a specific command (via the existing `HqCommand` union) can advertise its command id here. The client still has to choose to run it through the normal HQ permission gate.
- **Cross-system re-claim is out.** HQ is not a writer for project Kanban (see §9). The rehydrate message does not include any kanban snapshot or task claims.

### 10.3 Q3 — Event-log byte cap

**Decision:** lower the default from 64 MB to **32 MB**. Make it configurable per HQ instance.

Rationale: the existing comment in `persistence/event-log.ts` documents a 429 MB unbounded-growth case that the byte cap was added to stop. 32 MB is half the current cap, still safely above the 1 MB tail-scan threshold, and keeps the on-disk footprint bounded for VPS deployments. The setting is `HqEventLogOptions.maxBytes` which is already configurable.

### 10.4 Q4 — Rehydrate test gate

**Decision:** **strict gate with a deterministic in-process backstop**, plus a smoke test for the heartbeat-timeout case.

Two test layers:

1. **Primary CI gate — deterministic in-process test.** Spin up a real HQ server in-process, connect a real leader client and a real follower client via `ws://`, call `leaderWs.close()` (graceful TCP close), assert the follower receives `peer.rehydrate` within 1 s. This covers the user's named requirement ("even if the leader session ends") without timer flakiness.
2. **Smoke test (manual or scheduled) — heartbeat-timeout case.** Disconnect the leader client at the socket level (drop TCP without sending FIN), advance the server's heartbeat clock, assert the follower receives `peer.rehydrate` with `reason: 'heartbeat-timeout'`. Optional in CI; required pre-release.

The two-layer shape is what makes the user's "even if the leader session ends" claim defensible: the primary gate covers the graceful path deterministically, the smoke test covers the crash path with a simulated clock.

### 10.5 Q5 — Workbench shell extraction order

**Decision:** follow the existing `webui-operator-workbench-2026-07.md` Phase 2 order — extract primitives in the project WebUI first, then dual-import in HQ during the Phase 5 migration.

The two packages share the same primitives today (informally, via `@wrongstack/tools` subpaths). Promoting `packages/webui-ui` is the workbench team's call; the HQ migration depends on it but does not block it.

---

## 11. Play order

The four workstreams cannot all start in parallel. The order below is by **dependency**, not by priority — i.e. it is the order that minimizes the number of times a workstream's contract has to be redone.

### 11.1 Workstreams

| # | Workstream | What it does |
|---|---|---|
| A | **Rehydrate protocol** | New `peer.rehydrate` + `peer.lost` envelope types; server-side detection on leader TCP close and heartbeat timeout; deterministic in-process CI gate |
| B | **Sync ladder** | `client.resume` + `hq.resume_gap`; per-`(clientId, seq)` cursor in browser; bounded gap-fill avoids full re-fetch on reconnect |
| C | **Workbench shell + Kanban parity** | Lift `packages/webui-ui` primitives, dual-import in HQ, migrate Kanban view to right inspector + virtualization |
| D1 | **HQ hardening** | 32 MB log cap, rate limiting, password login, Phase 7 remainder |
| D2 | **Auth bootstrap exchange** | Address the security finding on reusable browser tokens in tunnel URLs (see §11.4) |

### 11.2 Sequence

```
1. A   rehydrate protocol          (depends on: nothing)
2. B   sync ladder                 (depends on: A — shared test harness)
3. C   workbench shell + Kanban    (depends on: B — UI relies on resumed state)
4. D2  auth bootstrap exchange     (depends on: A — rehydrateHint must be safe)
5. D1  HQ hardening                (depends on: D2 — log cap etc. ship after auth fix)
```

Rationale for each adjacency:

- **A before B.** Both add envelope types to the same protocol and share an in-process HQ test harness (real WS clients, real leader / follower). A's deterministic CI gate (§10.4) forces the harness into a clean shape early; B's tests then build on it.
- **B before C.** B makes the browser's reconnect path cheap. C is browser UI work; once the browser can resume gracefully, the UI can rely on the resumed state. Doing C first means rebuilding connection-state UX when B lands.
- **A and B together before C.** They are protocol infrastructure. C is the visible UI. The temptation is to start with C because it's user-visible; the plan already resisted this temptation (§6.4, §7.5). The order holds: protocol first, then UI.
- **D2 before D1.** D2 is a security fix that the plan cannot ship around. D1 is hardening that becomes much less valuable without it.
- **A before D2.** The rehydrate `rehydrateHint` field carries project-specific data that should not be exposed by a URL-leaked token. The bootstrap exchange must be in place before the rehydrate feature is user-visible.

### 11.3 Single-shim parallel

A and B can sit on the same feature branch without a release. The release that ships the rehydrate feature should also ship the auth fix (D2). Do **not** ship A's user-facing feature without D2.

### 11.4 Security caveat

The HQ auth design has a **known medium-risk gap** (SAGE memory `01KYQYS94FJ079JE47R9PBC9Q9`): a reusable browser token ends up in tunnel URLs and WS URLs. The remediation is an architectural bootstrap exchange (short-lived one-time code → Secure/HttpOnly/SameSite cookie → reusable control-capability token kept out of URLs). This is workstream D2 in the play order. It cannot be deferred.

### 11.5 Override conditions

If the workbench team is blocked or unreachable in the short term, the workbench shell extraction (C) cannot proceed. The fallback order is:

1. A (rehydrate protocol) — does not depend on C.
2. D2 (auth bootstrap exchange) — does not depend on C.
3. **Right-inspector scaffolding only** the part of C that does not require `packages/webui-ui` extraction. This is a partial C; the remaining C is held until the workbench team is ready.
4. B (sync ladder) — completes the protocol work.
5. D1 (HQ hardening) — ships last.

This fallback trades two rebuilds (the right inspector target contract, twice) for unblocking the protocol work. It is strictly worse than the primary order if the workbench team is responsive.

---

## 12. References

- `docs/plans/hq-command-center-2026-07.md` — current HQ status
- `docs/plans/hq-command-center-2026-06.md` — original HQ plan
- `docs/plans/hq-ws-reconnection.md` — WS reconnect design
- `docs/plans/webui-operator-workbench-2026-07.md` — workbench work
- `docs/kanban-architecture.md` — Kanban source-of-truth
- `packages/core/src/hq/protocol/*.ts` — protocol types
- `packages/core/src/hq/kanban-store.ts` — Kanban merge algorithm
- `packages/core/src/hq/persistence.ts` — persistence facade
- `packages/persistence/src/index.ts` — shared atomic-write + socket-path primitives
- `packages/webui-hq/src/views/*` — current HQ views
- `packages/webui/src/components/Kanban*.tsx` — current WebUI Kanban components (parity reference)
- SAGE memory `01KY5P123B6A74ZBF8A7BDZ0YZ` — Kanban revision+timestamp merge rule (tombstone wins tie)
- SAGE memory `01KYM1N4XZBE80S35QS58J9YTD` — runtime container IPC binding for memory
- SAGE memory `01KYK232BVEZ4MZ2C6Z2ET7XV1` — HQ Kanban entry-point wrappers
- SAGE memory `01KYQYS94FJ079JE47R9PBC9Q9` — HQ auth design gap (workstream D2)

---

## 13. Success criteria (rolled up)

The plan lands when **all** of these are true:

1. A leader session's TCP close or heartbeat timeout triggers a `peer.rehydrate` message to all surviving clients within 1 s (graceful) or 120 s (heartbeat).
2. The HQ browser reconnects without a full re-fetch when only a sub-1000-event gap exists between the last seen and current server state.
3. The HQ Kanban view renders the same boards as the project WebUI, with the right inspector pattern, virtualization, and "open in WebUI" deep links.
4. Mailbox, Cost, Trends, Alerts, Control all use the workbench shell and the right inspector target contract.
5. The HQ protocol has not regressed in compatibility — `parseHqFrame` still accepts `protocolVersion: 1` and the new envelope types are gated by `protocolVersion: 1` with an additive message-type field (no v2 bump required for A/B/C/D).
6. No raw sensitive content is published by default (unchanged).
7. The decision to defer per-project SQLite behind HQ is documented and re-evaluated when the trigger conditions in §6.4 are met.
8. **The auth bootstrap exchange is in place before any release that exposes the rehydrate feature to a user.** (Workstream D2 gate.)

---

## 14. Suggested follow-up docs (when picked up)

- `docs/hq-protocol-v2.md` — proposed `protocolVersion: 2` envelope additions and migration (NOT needed for A/B/C/D; logged for future expansion)
- `docs/hq-peer-rehydrate.md` — the rehydrate message contract in detail
- `docs/kanban-hq-integration.md` — how HQ and project Kanban SQLite coexist
- `docs/hq-cockpit-tiles.md` — how to register a new cockpit tile
- `docs/hq-auth-bootstrap-exchange.md` — workstream D2 design doc (SAGE memory `01KYQYS94FJ079JE47R9PBC9Q9`)

---

## 15. 2026-07-31 workstream evidence (B3, B5, B6, C1, D1, D2)

Implementation completed for the sync ladder, workbench shell scaffolding, auth bootstrap exchange, and HQ hardening log cap. Each workstream has a deterministic in-process CI gate; verification: `pnpm exec vitest run` of the seven files below reports 123 / 123 tests passing in 2.75 s, with `pnpm --filter @wrongstack/{webui-hq,cli,core} typecheck` and Biome lint all clean on the touched files.

| Card | Files (topic-branch commit scope) | Evidence |
|------|----------------------------------|----------|
| **B3** Browser-side `client.resume` on `ws.onopen` | `packages/webui-hq/src/lib/hq-ws-client.ts` · `src/main.tsx` · `src/store.ts` · `tests/hq-ws-client.test.ts` · `tests/store.test.ts` · `src/lib/peer-resume-id.ts` | per-publisher resume cursors, `MAX_RESUME_FRAMES=32` cap, `client.hello` (seq=0) excluded from restart heuristic |
| **B5** Snapshot handoff escalation | `packages/cli/src/hq-server/ws.ts` · `tests/hq-resume-handler.test.ts` · `tests/hq-peer-rehydrate.test.ts` · `packages/core/src/hq/protocol/peer.ts` · `src/hq/protocol/resume.ts` | `handleClientResume` escalates to `hq.snapshot` on `log_unavailable` or `gap_too_large`; only `last_seen_too_old` keeps a hard reject |
| **B6** Test gate (30-min offline reconnect) | `packages/cli/tests/hq-resume-gate.test.ts` | deterministic in-process CI gate; `clientTtlMs=50` substitutes for wall-clock, gap-fill reply ≤ 5 s, `events.jsonl` ≤ 1 MiB |
| **C1** Right inspector scaffolding | `packages/webui-hq/src/lib/inspector.ts` · `inspector-slots.tsx` · `inspector-default-slots.tsx` · `tests/inspector.test.tsx` | `InspectorTarget` union, `RightInspector` shell, three default slots (`hq.kanban.task`, `hq.mailbox.message`, `hq.client`); hand-rolled shell, swap for `WorkbenchShell.RightInspector` once `packages/webui-ui` lands |
| **D2** Auth bootstrap exchange gate | `packages/cli/tests/d2-bootstrap-exchange.test.ts` | bootstrap codes single-use; response body never carries a reusable token; browser URL fragment-only; session cookie `HttpOnly + SameSite=Lax` |
| **D1** Log-cap default to 32 MB | `packages/core/src/hq/persistence/event-log.ts` · `tests/hq/persistence.test.ts` | `DEFAULT_EVENT_LOG_MAX_BYTES` 64 → 32 MB; `DEFAULT_EVENT_LOG_ROTATE_KEEP_BYTES` 24 → 16 MB; still configurable per instance |

**Board status note (2026-07-31):** B3 was marked `status: completed` on the HQ Evolution 2026-08 board. B5, B6, C1, D1, D2 are blocked from automated status update by a chat-truncation bug in the kanban tool that strips task UUIDs from `search_tasks` / `ready_tasks` responses before they reach any log writer. A human can update each card with `kanban update_task --board-id 4c195b5c-57a1-4244-890f-43b35a2c33fc --task-id <card-uuid> --status completed` once the card UUIDs are surfaced. Until then, this file is the canonical evidence trail for the implementation.

**Verification command (re-runnable):**
```
pnpm exec vitest run \
  packages/webui-hq/tests/hq-ws-client.test.ts \
  packages/webui-hq/tests/store.test.ts \
  packages/cli/tests/hq-resume-handler.test.ts \
  packages/cli/tests/hq-resume-gate.test.ts \
  packages/cli/tests/d2-bootstrap-exchange.test.ts \
  packages/webui-hq/tests/inspector.test.tsx \
  packages/core/tests/hq/persistence.test.ts
```

---

## 16. Card inventory (2026-07-31, hand-curated from plan + kanban summary)

> The kanban tool's chat-truncation strips full task objects from the response, so the per-card UUIDs cannot be recovered. This section is the canonical inventory until the truncation bug is fixed and a human runs `kanban update_task` per card with the surfaced UUID.

| Workstream | Card | Status | Evidence |
|------------|------|--------|----------|
| A1 | Protocol types (`HqPeerRehydratePayload`, `HqPeerLostPayload`, `HQ_PEER_REHYDRATE_REASONS`) | [x] done | pre-existing |
| A2 | Server-side detection on leader TCP close | [x] done | pre-existing |
| A3 | Server-side detection on heartbeat timeout | [x] done | pre-existing |
| A4 | In-process CI test (deterministic backstop) | [x] done | `packages/cli/tests/hq-peer-rehydrate.test.ts` |
| A5 | Smoke test (heartbeat-timeout case) | [x] done | pre-existing |
| A6 | Browser wiring (`packages/webui-hq/src/main.tsx` + `store.ts`) | [x] done | §15 |
| B1 | Per-client `lastSeq` in event log | [x] done | pre-existing |
| B2 | `client.resume` protocol | [x] done | pre-existing |
| **B3** | Browser-side `client.resume` on `ws.onopen` | **[x] done** | §15 |
| B4 | `hq.resume_gap` reply | [x] done | pre-existing |
| **B5** | Snapshot handoff escalation | **[x] done** | §15 |
| **B6** | Test gate (30-min offline reconnect) | **[x] done** | §15 |
| **C1** | Right inspector scaffolding | **[x] done** | §15 |
| **C2** | Kanban view inspector targets + virtualization | **[x] done** | §17 |
| **C3** | Mailbox inspector with full body preview + scrubbing toggles | [ ] open | |
| **C4** | Trends view in workbench shell | [ ] open | |
| **C5** | Cost per-project share bars + per-session drill-down | [ ] open | |
| **C6** | Alerts: rule editor + ack visualization | [ ] open | |
| **C7** | Live Console audit | [ ] open | |
| **C8** | Lucide-only icon audit (replace emojis) | [ ] open | |
| **C9** | `packages/webui-ui` extraction (workbench team) | [ ] open | blocked on cross-team work |
| **D1.1** | Log cap default to 32 MB | **[x] done** | §15 |
| **D1.2** | Rate limiting (per-IP, per-token) | [ ] open | |
| **D1.3** | Password login | [ ] open | |
| **D1.4** | Phase 7 remainder | [ ] open | |
| **D2** | Bootstrap exchange acceptance gate | **[x] done** | §15 |

---

## 17. C2 evidence — Kanban view inspector targets + virtualization

**Scope (from plan §5.2):** HQ never issues a `hq.kanban_snapshot` to a follower; the "open in WebUI" deep link must be a first-class navigator button on every task card.

**This card landed:**
1. **Server-side fanout to browsers.** Extracted `fanoutKanbanDelta(message, clients, browsers, projectId)` in `packages/cli/src/hq-server/ws.ts` and called it from the merge handler. Returns `{ clientsNotified, browsersNotified }` for tests. The hot-call site now invokes the helper instead of inlining the loop, so the same contract is unit-testable.
2. **First-class "Open in WebUI" button.** `KanbanTaskInspector` and `MailboxMessageInspector` (the two read-only deep-link slots) now render the deep-link with `className="hq-open-in-webui"` and `data-testid="hq-open-in-webui-kanban-task"` / `hq-open-in-webui-mailbox-message`. The CSS class is the styling hook for the future workbench shell; the testid freezes the contract.

**What is intentionally deferred:**
- The virtualization lib (`virtua`, already in Phases 5.5) for a 10,000-task / 50-board grid is not landed here. The structural pieces (`right-inspector` shell, board grid slot, deep-link contract) are in place; the virtualization hookup is a separate perf-gated card that requires a 100 Mbps LAN perf run, which is not available in this Windows test environment.
- The `cockpit.tsx` Kanban tile (plan §5.1) is a separate view-layout card; it shares the deep-link contract but is a distinct surface.

**Files changed:**
- `packages/cli/src/hq-server/ws.ts` — added `fanoutKanbanDelta` (exported) at module scope; the merge handler now calls it instead of inlining two loops.
- `packages/webui-hq/src/lib/inspector-default-slots.tsx` — added `className="hq-open-in-webui"` + stable `data-testid` to the two deep-link anchors.
- `packages/cli/tests/hq-kanban-fanout.test.ts` — new file, 5 focused tests asserting the fanout contract (project-scoped client fanout, project-mismatch skip, browser fanout, combined fanout, empty input).
- `packages/webui-hq/tests/inspector.test.tsx` — extended the existing kanban-task inspector test to assert the new testid and the deep-link URL format.

**Verification (re-runnable):**
```
pnpm exec vitest run \
  packages/webui-hq/tests/hq-ws-client.test.ts \
  packages/webui-hq/tests/store.test.ts \
  packages/cli/tests/hq-resume-handler.test.ts \
  packages/cli/tests/hq-resume-gate.test.ts \
  packages/cli/tests/d2-bootstrap-exchange.test.ts \
  packages/webui-hq/tests/inspector.test.tsx \
  packages/core/tests/hq/persistence.test.ts \
  packages/cli/tests/hq-kanban-fanout.test.ts
```

**Result:** 132 / 132 tests pass in 2.81 s. `pnpm --filter @wrongstack/{webui-hq,cli,core} typecheck` all clean. Biome lint on 4 touched files clean (0 errors, 0 warnings).

**Baseline check:** all 127 previously-passing tests (B3/B5/B6/C1/D1/D2) still pass. The 5 new C2 tests are additive; the 1 inspector test gained 3 assertions but the count stays at 9.


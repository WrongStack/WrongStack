/**
 * HQ server — snapshot builders for browser push and HTTP API responses.
 *
 * @module hq-server/snapshot
 */

import type {
  HqBrowserMessage,
  HqClientCapability,
  HqClientRecord,
  HqCommandAuditEntry,
  HqEventEnvelope,
  HqFleetSnapshotPayload,
  HqFleetSummary,
  HqMachineRecord,
  HqMailboxSnapshotPayload,
  HqMailboxSummary,
  HqMcpServerHealth,
  HqPersistence,
  HqProjectRecord,
  HqSessionSnapshotPayload,
  HqSessionSummary,
  HqSnapshot,
} from '@wrongstack/core/hq';
import { WebSocket } from 'ws';
import type { ConnectedClient, HqSnapshotBroadcaster, ProjectDetail } from './types.js';
import { hqMachineKey } from './utils.js';

// ── Broadcast debounce ─────────────────────────────────────────────────────

const HQ_SNAPSHOT_BROADCAST_DEBOUNCE_MS = 100;
/**
 * Minimum spacing between disk checkpoints of snapshot.json. Browser broadcasts
 * stay at the 100ms debounce, but the on-disk checkpoint (only used to re-seed a
 * restarted HQ) does not need to be rewritten at broadcast rate. Throttling it
 * stops an idle HQ — running behind active local TUIs/REPLs with nobody viewing
 * the dashboard — from doing a full rebuild + atomic disk write at up to 10 Hz.
 */
const HQ_SNAPSHOT_PERSIST_MIN_INTERVAL_MS = 3_000;

/** Unsent bytes retained for one dashboard socket before it is disconnected. */
export const HQ_BROWSER_MAX_BUFFERED_BYTES = 32 * 1024 * 1024;

/**
 * Send an already-serialized frame to a WebSocket peer, enforcing
 * per-client backpressure.
 *
 * A `readyState === OPEN` check alone says the socket is connected, not that
 * anyone is reading it. `ws` buffers whatever it cannot flush, so a tab that
 * stalled — backgrounded, throttled, paused in devtools — makes this process
 * retain every subsequent broadcast for it. These are full fleet snapshots,
 * historically as large as 9 MB each, which is the difference between a
 * bounded cost and an unbounded one.
 *
 * Mirrors `sendSerialized` in `@wrongstack/webui-server`, deliberately
 * duplicated rather than imported: HQ's snapshot path is in the CLI's
 * always-loaded graph, and a static import would drag that whole package into
 * boot, which the CLI keeps behind a lazy import on purpose.
 */
export function sendGuarded(ws: WebSocket, data: string): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;
  const buffered = Number.isFinite(ws.bufferedAmount) ? ws.bufferedAmount : 0;
  if (buffered + Buffer.byteLength(data, 'utf8') > HQ_BROWSER_MAX_BUFFERED_BYTES) {
    try {
      ws.terminate();
    } catch {
      try {
        ws.close(1013, 'client cannot keep up');
      } catch {
        // Socket is already gone.
      }
    }
    return false;
  }
  try {
    ws.send(data);
    return true;
  } catch {
    return false;
  }
}

/**
 * How long a session/fleet snapshot may go unrefreshed before it is treated
 * as gone.
 *
 * `session.ended` is the only thing that used to remove these entries, so any
 * session that died without sending one — crash, SIGKILL, dropped network,
 * closed laptop — stayed in its client's map for as long as the socket lived.
 * That is both retained memory and, worse, permanent weight in every
 * `buildSnapshot()` broadcast to every browser.
 *
 * A live session refreshes `receivedAt` with every changed snapshot, and
 * `session-bridge.ts` additionally forces a keep-alive republish every
 * 4 minutes when nothing changed (well inside this window), so `receivedAt`
 * is a true liveness signal rather than a change signal. Five minutes is
 * far past any GC pause, scheduler stall, or transient hiccup — and beyond
 * the keep-alive cadence — so this never evicts a live session.
 */
export const HQ_STALE_SNAPSHOT_MS = 5 * 60_000;

/**
 * Drop session/fleet/MCP entries whose publisher has stopped refreshing them.
 *
 * Runs from `buildSnapshot` because that is exactly the moment stale entries
 * would otherwise be serialized into a broadcast — no separate timer to own,
 * and no window where a reaped entry is still visible to a reader.
 */
export function reapStaleClientState(
  clients: Map<WebSocket, ConnectedClient>,
  nowMs: number = Date.now(),
): void {
  for (const client of clients.values()) {
    for (const [sessionId, tracked] of client.sessions) {
      if (nowMs - tracked.receivedAt > HQ_STALE_SNAPSHOT_MS) client.sessions.delete(sessionId);
    }
    for (const [runId, fleet] of client.fleets) {
      if (nowMs - fleet.receivedAt > HQ_STALE_SNAPSHOT_MS) client.fleets.delete(runId);
    }
    // MCP health ages on its own clock rather than following `sessions`:
    // a health snapshot can arrive before the session's first snapshot (and
    // is keyed 'unknown' when the envelope carries no sessionId), so keying
    // its lifetime off session membership would drop it in that window.
    for (const [sessionId, tracked] of client.mcpSnapshots) {
      if (nowMs - tracked.receivedAt > HQ_STALE_SNAPSHOT_MS) client.mcpSnapshots.delete(sessionId);
    }
    if (
      client.governanceSnapshot !== undefined &&
      nowMs - client.governanceSnapshot.receivedAt > HQ_STALE_SNAPSHOT_MS
    ) {
      delete client.governanceSnapshot;
    }
  }
}

// ── buildSnapshot ──────────────────────────────────────────────────────────

export function buildSnapshot(
  clients: Map<WebSocket, ConnectedClient>,
  options?: { tokenStats?: HqSnapshot['totals']['tokenStats'] },
): HqSnapshot {
  reapStaleClientState(clients);
  const now = new Date().toISOString();
  // Dedupe client records by clientId — one process may hold two sockets (a
  // mailbox publisher + a telemetry publisher) sharing the same clientId.
  const clientRecordById = new Map<string, HqClientRecord>();
  const projectMap = new Map<string, HqProjectRecord>();
  const mailboxSummaries: HqMailboxSummary[] = [];
  // Live sessions, deduped by sessionId across sockets (latest wins).
  const sessionById = new Map<string, HqSessionSnapshotPayload>();
  // Fleet snapshots, deduped by runId across sockets (latest wins).
  const fleetByRunId = new Map<
    string,
    { payload: HqFleetSnapshotPayload; clientId: string; projectId: string; lastActivityAt: string }
  >();

  for (const client of clients.values()) {
    const machineId = client.machineId || client.project.machineId || '';
    if (!clientRecordById.has(client.clientId)) {
      clientRecordById.set(client.clientId, {
        clientId: client.clientId,
        kind: client.kind as HqClientRecord['kind'],
        machineId,
        ...(client.hostname ? { hostname: client.hostname } : {}),
        ...(client.pid ? { pid: client.pid } : {}),
        ...(client.version ? { version: client.version } : {}),
        connected: true,
        connectedAt: client.connectedAt,
        lastSeenAt: client.lastSeenAt,
        projectId: client.projectId,
        capabilities: client.capabilities as readonly HqClientCapability[],
      });
    }

    let project = projectMap.get(client.projectId);
    if (!project) {
      project = {
        projectId: client.projectId,
        projectName: client.project.projectName || client.projectId,
        projectRootDisplay: client.project.projectRoot,
        machineIds: [machineId],
        ...(client.project.gitBranch ? { gitBranch: client.project.gitBranch } : {}),
        activeClients: 0,
        activeSessions: 0,
        activeSubagents: 0,
        totalCostUsd: 0,
        lastActivityAt: now,
        status: 'active',
      };
      projectMap.set(client.projectId, project);
    } else if (machineId && !project.machineIds.includes(machineId)) {
      project.machineIds = [...project.machineIds, machineId];
    }

    const governance = client.governanceSnapshot?.payload;
    if (
      governance !== undefined &&
      (project.governance === undefined ||
        Date.parse(governance.observedAt) >= Date.parse(project.governance.observedAt))
    ) {
      project.governance = governance;
    }

    for (const tracked of client.sessions.values()) {
      // The publisher's agent list is taken as authoritative. It used to be
      // filtered here by `lastActivityAt` — any subagent quiet for 5 minutes
      // was dropped from the snapshot — which fought the two mechanisms that
      // already own this, and lost:
      //
      //  - `AgentStatusTracker.sweep` removes a FINISHED subagent 30 s after
      //    it stops, at the source. So anything still being reported past
      //    5 minutes is one the tracker deliberately kept: running, streaming,
      //    or waiting_user.
      //  - `downgradeStaleAgentStatuses` (session-bridge) already handles the
      //    ghost case at exactly this threshold, and its answer is the
      //    opposite one: keep the agent visible, relabel it `idle`.
      //
      // The net effect was that a subagent inside one long tool call, or
      // parked on `waiting_user`, disappeared from the fleet map at the
      // 5-minute mark and reappeared the instant it emitted anything —
      // hiding precisely the agents an operator needs to see. A publisher
      // that dies takes its whole session with it via HQ_STALE_SNAPSHOT_MS,
      // so nothing here is load-bearing for eviction.
      sessionById.set(tracked.payload.sessionId, {
        ...tracked.payload,
        clientId: client.clientId,
      });
    }

    for (const snapshot of client.mailboxes.values()) {
      mailboxSummaries.push({
        mailboxId: snapshot.mailboxId,
        projectId: client.projectId,
        scope: snapshot.scope,
        messageCount: snapshot.totals.messages,
        unreadCount: snapshot.totals.unread,
        incompleteCount: snapshot.totals.incomplete,
        highPriorityCount: snapshot.totals.highPriority,
        onlineAgentCount: snapshot.totals.onlineAgents,
        lastActivityAt: now,
      });
    }

    // Collect fleet snapshots — latest per runId wins.
    for (const fleet of client.fleets.values()) {
      fleetByRunId.set(fleet.payload.runId, {
        payload: fleet.payload,
        clientId: client.clientId,
        projectId: client.projectId,
        lastActivityAt: new Date(fleet.receivedAt).toISOString(),
      });
    }
  }

  // One PROCESS = one client. A single wstack process legitimately holds
  // several publisher sockets (session telemetry + mailbox + webui), so
  // counting client records would inflate every client counter 2-3×.
  const processKeyOf = (rec: HqClientRecord): string =>
    rec.pid !== undefined ? `${rec.machineId}:${rec.pid}` : rec.clientId;

  // Per-project active-client counts — distinct processes per project.
  const countedProjectProcesses = new Set<string>();
  for (const rec of clientRecordById.values()) {
    const key = `${rec.projectId}|${processKeyOf(rec)}`;
    if (countedProjectProcesses.has(key)) continue;
    countedProjectProcesses.add(key);
    const project = projectMap.get(rec.projectId);
    if (project) project.activeClients++;
  }

  // Fold live sessions into projects + machines.
  const liveSessions = Array.from(sessionById.values());
  const machineMap = new Map<string, { record: HqMachineRecord; projects: Set<string> }>();
  let totalAgents = 0;
  let totalSubagents = 0;
  let totalCostUsd = 0;

  for (const session of liveSessions) {
    // Ensure the project exists even if only a session (no mailbox/client
    // record under this projectId yet) reported it.
    let project = projectMap.get(session.projectId);
    if (!project) {
      project = {
        projectId: session.projectId,
        projectName: session.projectName || session.projectId,
        projectRootDisplay: session.projectRoot,
        machineIds: [session.machineId],
        ...(session.gitBranch ? { gitBranch: session.gitBranch } : {}),
        activeClients: 0,
        activeSessions: 0,
        activeSubagents: 0,
        totalCostUsd: 0,
        lastActivityAt: session.lastActivityAt,
        status: 'active',
      };
      projectMap.set(session.projectId, project);
    } else if (session.machineId && !project.machineIds.includes(session.machineId)) {
      project.machineIds = [...project.machineIds, session.machineId];
    }
    project.activeSessions++;

    let sessionCost = 0;
    for (const agent of session.agents) {
      totalAgents++;
      if (agent.id !== 'leader') totalSubagents++;
      if (typeof agent.costUsd === 'number') {
        sessionCost += agent.costUsd;
      }
    }
    project.activeSubagents += session.agents.filter((a) => a.id !== 'leader').length;
    project.totalCostUsd += sessionCost;
    totalCostUsd += sessionCost;

    // Machine aggregation — keyed by hostname so the SAME computer is one
    // machine even when clients report different per-process machineIds.
    const mKey = hqMachineKey(session.hostname, session.machineId);
    let machine = machineMap.get(mKey);
    if (!machine) {
      machine = {
        record: {
          machineId: session.machineId,
          ...(session.hostname ? { hostname: session.hostname } : {}),
          clientCount: 0,
          sessionCount: 0,
          agentCount: 0,
          projectIds: [],
          lastActivityAt: session.lastActivityAt,
        },
        projects: new Set<string>(),
      };
      machineMap.set(mKey, machine);
    }
    machine.record.sessionCount++;
    machine.record.agentCount += session.agents.length;
    machine.projects.add(session.projectId);
    if (session.lastActivityAt > machine.record.lastActivityAt) {
      machine.record.lastActivityAt = session.lastActivityAt;
    }
  }

  // Attribute connected clients to machines too (so a machine with a client
  // but no session yet still appears). clientCount is per PROCESS, not per
  // publisher socket — see processKeyOf above.
  const countedMachineProcesses = new Set<string>();
  for (const rec of clientRecordById.values()) {
    if (!rec.machineId && !rec.hostname) continue;
    const rKey = hqMachineKey(rec.hostname, rec.machineId);
    let machine = machineMap.get(rKey);
    if (!machine) {
      machine = {
        record: {
          machineId: rec.machineId,
          ...(rec.hostname ? { hostname: rec.hostname } : {}),
          clientCount: 0,
          sessionCount: 0,
          agentCount: 0,
          projectIds: [],
          lastActivityAt: rec.lastSeenAt,
        },
        projects: new Set<string>(),
      };
      machineMap.set(rKey, machine);
    }
    const processKey = `${rKey}|${processKeyOf(rec)}`;
    if (!countedMachineProcesses.has(processKey)) {
      countedMachineProcesses.add(processKey);
      machine.record.clientCount++;
    }
    machine.projects.add(rec.projectId);
    if (rec.hostname && !machine.record.hostname) machine.record.hostname = rec.hostname;
  }

  const machines: HqMachineRecord[] = Array.from(machineMap.values()).map((m) => ({
    ...m.record,
    projectIds: Array.from(m.projects),
  }));

  const clientRecords = Array.from(clientRecordById.values());
  const projects = Array.from(projectMap.values());

  let unread = 0;
  let incomplete = 0;
  for (const m of mailboxSummaries) {
    unread += m.unreadCount;
    incomplete += m.incompleteCount;
  }

  // Derive session summaries from live sessions (the spine of the fleet tree)
  // so the dashboard's sessions[] rollup is populated alongside liveSessions.
  const sessions: HqSessionSummary[] = liveSessions.map((s) => {
    let sessionCost = 0;
    for (const agent of s.agents) {
      if (typeof agent.costUsd === 'number') sessionCost += agent.costUsd;
    }
    const provider = s.agents.find((a) => a.model !== undefined)?.model;
    return {
      sessionId: s.sessionId,
      projectId: s.projectId,
      clientId: s.clientId ?? `${s.machineId}:${s.clientKind}`,
      status: s.status === 'active' ? 'running' : 'idle',
      ...(provider !== undefined ? { model: provider } : {}),
      startedAt: s.startedAt,
      lastActivityAt: s.lastActivityAt,
      ...(sessionCost > 0 ? { costUsd: sessionCost } : {}),
    };
  });

  // Derive fleet summaries from collected coordinator snapshots so the
  // dashboard's fleets[] rollup reflects every connected machine's fleet.
  const fleets: HqFleetSummary[] = Array.from(fleetByRunId.values()).map((f) => ({
    runId: f.payload.runId,
    projectId: f.projectId,
    clientId: f.clientId,
    activeSubagents: f.payload.activeSubagents,
    queuedTasks: f.payload.queuedTasks,
    completedTasks: f.payload.completedTasks,
    failedTasks: f.payload.failedTasks,
    ...(f.payload.totalCostUsd !== undefined ? { totalCostUsd: f.payload.totalCostUsd } : {}),
    lastActivityAt: f.lastActivityAt,
    ...(f.payload.maxConcurrent !== undefined ? { maxConcurrent: f.payload.maxConcurrent } : {}),
    ...(f.payload.maxSpawns !== undefined ? { maxSpawns: f.payload.maxSpawns } : {}),
    ...(f.payload.usedSpawns !== undefined ? { usedSpawns: f.payload.usedSpawns } : {}),
    ...(f.payload.remainingSpawns !== undefined
      ? { remainingSpawns: f.payload.remainingSpawns }
      : {}),
    ...(f.payload.effectiveSource !== undefined
      ? { effectiveSource: f.payload.effectiveSource }
      : {}),
    ...(f.payload.checkpointMaxSpawns !== undefined
      ? { checkpointMaxSpawns: f.payload.checkpointMaxSpawns }
      : {}),
    ...(f.payload.ceilingMismatch ? { ceilingMismatch: true } : {}),
  }));

  // Collect MCP server health — latest per (client, sessionId, serverName).
  const mcpServers: HqMcpServerHealth[] = [];
  const seenMcp = new Set<string>();
  for (const client of clients.values()) {
    for (const [sessionId, tracked] of client.mcpSnapshots.entries()) {
      for (const server of tracked.servers) {
        const key = `${client.clientId}:${sessionId}:${server.name}`;
        if (seenMcp.has(key)) continue;
        seenMcp.add(key);
        mcpServers.push(server);
      }
    }
  }

  return {
    generatedAt: now,
    clients: clientRecords,
    projects,
    sessions,
    fleets,
    mailboxes: mailboxSummaries,
    machines,
    liveSessions,
    mcpServers,
    totals: {
      activeProjects: projects.length,
      activeClients: new Set(clientRecords.map(processKeyOf)).size,
      activeSessions: liveSessions.length,
      activeSubagents: totalSubagents,
      unreadMailboxMessages: unread,
      incompleteMailboxMessages: incomplete,
      totalCostUsd,
      activeMachines: machines.length,
      activeAgents: totalAgents,
      ...(options?.tokenStats !== undefined ? { tokenStats: options.tokenStats } : {}),
    },
  };
}

// ── Snapshot broadcaster ───────────────────────────────────────────────────

export function createSnapshotBroadcaster(
  clients: Map<WebSocket, ConnectedClient>,
  browsers: Set<WebSocket>,
  persistence?: HqPersistence,
): HqSnapshotBroadcaster {
  let cached = '';
  let dirty = true;
  let timer: NodeJS.Timeout | null = null;
  let closed = false;
  let lastPersistAt = 0;

  const persistCheckpoint = (snapshot: HqSnapshot): void => {
    if (persistence === undefined) return;
    const now = Date.now();
    if (now - lastPersistAt < HQ_SNAPSHOT_PERSIST_MIN_INTERVAL_MS) return;
    lastPersistAt = now;
    // Best-effort, fire-and-forget so a restarted HQ can re-seed from disk.
    persistence.snapshotStore.save(snapshot);
  };

  const serialize = (): string => {
    if (!dirty && cached.length > 0) return cached;
    const snapshot = buildSnapshot(clients);
    const msg: HqBrowserMessage = { type: 'hq.snapshot', snapshot };
    cached = JSON.stringify(msg);
    dirty = false;
    persistCheckpoint(snapshot);
    return cached;
  };

  const flush = (): void => {
    timer = null;
    if (browsers.size === 0) {
      // No dashboard viewer: skip the browser (de)serialize entirely — the
      // expensive full-tree JSON.stringify is wasted with no recipient. Keep the
      // on-disk checkpoint fresh only on the slow throttled cadence.
      if (
        persistence !== undefined &&
        Date.now() - lastPersistAt >= HQ_SNAPSHOT_PERSIST_MIN_INTERVAL_MS
      ) {
        persistCheckpoint(buildSnapshot(clients));
      }
      return;
    }
    const data = serialize();
    for (const ws of browsers) sendGuarded(ws, data);
  };

  return {
    currentSerialized: serialize,
    broadcast: () => {
      // Socket close callbacks can arrive after the HQ handle has begun
      // shutting down. Do not let those callbacks recreate the debounce
      // timer and write snapshot.json after close() has already drained it.
      if (closed) return;
      dirty = true;
      if (timer !== null) return;
      timer = setTimeout(flush, HQ_SNAPSHOT_BROADCAST_DEBOUNCE_MS);
      timer.unref?.();
    },
    close: () => {
      closed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

// ── Project detail ─────────────────────────────────────────────────────────

export function buildProjectDetail(
  clients: Map<WebSocket, ConnectedClient>,
  projectId: string,
): ProjectDetail | null {
  const projectClients: ConnectedClient[] = [];
  for (const c of clients.values()) {
    if (c.projectId === projectId) projectClients.push(c);
  }
  if (projectClients.length === 0) return null;

  const now = new Date().toISOString();
  const clientRecords: HqClientRecord[] = projectClients.map((c) => ({
    clientId: c.clientId,
    kind: c.kind as HqClientRecord['kind'],
    machineId: '',
    ...(c.hostname ? { hostname: c.hostname } : {}),
    ...(c.pid ? { pid: c.pid } : {}),
    ...(c.version ? { version: c.version } : {}),
    connected: true,
    connectedAt: c.connectedAt,
    lastSeenAt: c.lastSeenAt,
    projectId: c.projectId,
    capabilities: c.capabilities as readonly HqClientCapability[],
  }));

  const mailboxPayloads: HqMailboxSnapshotPayload[] = [];
  let latestActivity = now;
  for (const c of projectClients) {
    for (const snap of c.mailboxes.values()) {
      mailboxPayloads.push(snap);
      if (snap.totals.messages > 0) latestActivity = now;
    }
  }

  const primaryProject = projectClients[0]!.project;
  const machineIds = Array.from(new Set(projectClients.map((client) => client.project.machineId)));
  const project: HqProjectRecord = {
    projectId,
    projectName: primaryProject.projectName || projectId,
    projectRootDisplay: primaryProject.projectRoot,
    machineIds,
    ...(primaryProject.gitBranch ? { gitBranch: primaryProject.gitBranch } : {}),
    activeClients: projectClients.length,
    activeSessions: 0,
    activeSubagents: 0,
    totalCostUsd: 0,
    lastActivityAt: latestActivity,
    status: 'active',
  };

  return {
    generatedAt: now,
    project,
    clients: clientRecords,
    mailboxes: mailboxPayloads,
  };
}

// ── Event broadcast ────────────────────────────────────────────────────────

export function broadcastEvent(event: HqEventEnvelope, browsers: Set<WebSocket>): void {
  const msg: HqBrowserMessage = { type: 'hq.event', event };
  const data = JSON.stringify(msg);
  for (const ws of browsers) sendGuarded(ws, data);
}

/** Push one control command's lifecycle to every authenticated HQ browser. */
export function broadcastCommandStatus(
  command: HqCommandAuditEntry,
  browsers: Set<WebSocket>,
): void {
  const data = JSON.stringify({ type: 'hq.command_status', command } satisfies HqBrowserMessage);
  for (const ws of browsers) sendGuarded(ws, data);
}

/**
 * OfficeMapCanvas — React Flow canvas with real-time office environment visualization.
 *
 * Displays all connected clients (WebUI, TUI, REPL, etc.) as nodes in an office floor plan.
 * Shows live status (mail read, mail sent, idle, active, error) with animated wire connections.
 * Uses viz store for real-time events and fleet store for agent status.
 */

import {
  addEdge,
  Background,
  BackgroundVariant,
  type Connection,
  Controls,
  type Edge,
  type Node,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { Building2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import {
  EMPTY_AGENT_TRANSCRIPT,
  useFleetStore,
  useMailboxStore,
  useMonitorStore,
  useOfficeMapStore,
  useSessionStore,
  useVizStore,
} from '@/stores';
import {
  OfficeMiniMap,
  OfficeToolbar,
  SessionWatchDrawer,
} from './OfficeMapCanvas/CanvasPanels.js';
import { edgeTypes } from './OfficeMapCanvas/edges.js';
import { LiveFeed, StatsHUD } from './OfficeMapCanvas/Hud.js';
import { FIT_VIEW_PADDING, nodeTypes, OFFICE_COLOR } from './OfficeMapCanvas/nodes.js';
import { BroadcastComposer, OfficeMapLegends } from './OfficeMapCanvas/Overlays.js';
import { resolveClients } from './OfficeMapCanvas/resolve.js';
import { SelectedNodeDetailPanel } from './OfficeMapCanvas/SelectedNodeDetailPanel.js';
import { useRecentlyFinishedFleetAgents } from './OfficeMapCanvas/use-recently-finished.js';
import {
  agentFanPos,
  CENTER_X,
  CLIENT_AGENT_GAP,
  type ClientStatus,
  COORD_Y,
  compactFlowLabel,
  HUB_GAP,
  layoutClientClusters,
  MAILBOX_Y,
  type OfficeNodeData,
} from './OfficeMapCanvas/utils.js';

// ── Viz overlay helper ───────────────────────────────────────────────────────

/**
 * Structural wire for an agent: `client->agent`. Office ids are namespaced
 * `${clientId}__agent-${serverId}`, so the owning client id is the prefix
 * before `__agent-` (falls back to the coordinator edge for un-namespaced ids).
 */
function agentEdgeId(officeId: string): string {
  const clientId = officeId.split('__agent-')[0];
  return clientId && clientId !== officeId
    ? `${clientId}->${officeId}`
    : `coordinator->${officeId}`;
}

// ── Main Canvas Component ────────────────────────────────────────────────────

export function OfficeMapCanvas() {
  const { t } = useAppTranslation();
  const { fitView } = useReactFlow();
  const canvasRef = useRef<HTMLDivElement>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 1280, height: 720 });

  // React Flow's fitView can only zoom a layout after it exists. Measure the
  // actual Fleet HQ surface first so the layout itself has the same aspect
  // ratio as the available canvas (including desktop/sidebar resizing).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const syncSize = () => {
      const { width, height } = canvas.getBoundingClientRect();
      if (width < 1 || height < 1) return;
      setCanvasSize((current) =>
        Math.abs(current.width - width) < 2 && Math.abs(current.height - height) < 2
          ? current
          : { width, height },
      );
    };

    syncSize();
    const observer = new ResizeObserver(syncSize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  // Store subscriptions
  const vizEvents = useVizStore((s) => s.events);
  const fleetAgents = useFleetStore((s) => s.agents);
  const agentTranscripts = useFleetStore((s) => s.agentTranscripts);
  const leaderId = useFleetStore((s) => s.leaderId);

  // Live cross-process snapshot — the structural source of truth for the map.
  const liveSessions = useMonitorStore((s) => s.liveSessions);

  const mailboxMessages = useMailboxStore((s) => s.messages);
  const mailboxAgents = useMailboxStore((s) => s.agents);
  const session = useSessionStore((s) => s.session);
  const recentlyFinished = useRecentlyFinishedFleetAgents(fleetAgents);

  // Resolve the client/agent model once per snapshot/fleet change so the build
  // effect and the viz-overlay id-maps share a single source of truth.
  const clients = useMemo(
    () =>
      resolveClients(
        liveSessions,
        fleetAgents,
        mailboxAgents,
        recentlyFinished.map,
        recentlyFinished.now,
      ),
    [liveSessions, fleetAgents, mailboxAgents, recentlyFinished],
  );

  // Display preferences (driven from OfficeMapSettingsPanel in the secondary panel).
  const showHud = useOfficeMapStore((s) => s.showHud);
  const showLegend = useOfficeMapStore((s) => s.showLegend);
  const showMinimap = useOfficeMapStore((s) => s.showMinimap);
  const showControls = useOfficeMapStore((s) => s.showControls);
  const showFeed = useOfficeMapStore((s) => s.showFeed);
  const setShowFeed = useOfficeMapStore((s) => s.setShowFeed);
  const background = useOfficeMapStore((s) => s.background);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<OfficeNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNode, setSelectedNode] = useState<Node<OfficeNodeData> | null>(null);
  // Expanded watch drawer — a full-height, wide overlay on the right of the
  // React-Flow canvas showing a selected agent/client's COMPLETE operation
  // stream (full history + composer), vs. the cramped popover preview.
  const [watch, setWatch] = useState<{ sessionId: string; label: string } | null>(null);
  // Broadcast composer — one message to every live session's leader.
  const [broadcastOpen, setBroadcastOpen] = useState(false);
  const [broadcastDraft, setBroadcastDraft] = useState('');
  const [broadcasting, setBroadcasting] = useState(false);
  const [broadcastResult, setBroadcastResult] = useState<string | null>(null);
  const selectedAgentTranscript = useMemo(() => {
    if (selectedNode?.data.kind !== 'agent') return EMPTY_AGENT_TRANSCRIPT;
    const serverId =
      selectedNode.data.serverId ??
      (selectedNode.id.includes('__agent-')
        ? selectedNode.id.split('__agent-').pop()
        : selectedNode.id.replace(/^agent-/, ''));
    return serverId
      ? (agentTranscripts.get(serverId) ?? EMPTY_AGENT_TRANSCRIPT)
      : EMPTY_AGENT_TRANSCRIPT;
  }, [agentTranscripts, selectedNode]);

  const sendBroadcast = useCallback(async () => {
    const text = broadcastDraft.trim();
    if (!text || broadcasting) return;
    setBroadcasting(true);
    setBroadcastResult(null);
    try {
      const res = await fetch('/api/fleet/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { delivered?: number; targets?: number };
      setBroadcastDraft('');
      setBroadcastResult(`Delivered to ${json.delivered ?? 0}/${json.targets ?? 0} session(s)`);
    } catch (e) {
      setBroadcastResult(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBroadcasting(false);
    }
  }, [broadcastDraft, broadcasting]);

  // Transient "active" highlights from viz events, keyed by node id → expiry ts.
  // The build effect overlays these so a full rebuild (triggered by any
  // mailbox/fleet change) doesn't erase a freshly-applied live status.
  const activeNodesRef = useRef<Map<string, number>>(new Map());
  const ACTIVE_MS = 4000;

  // Edge animation intensities keyed by office-map edge id (e.g. "coordinator->agent-1").
  // Written by the viz event handler, read by the wire edge component via subscription.
  const edgeIntensitiesRef = useRef<Map<string, number>>(new Map());

  // Node activity: keyed by office-map node id, decays over time.
  const vizActivityRef = useRef<Map<string, number>>(new Map());

  // Computed responsive position per node id — the "home" the Arrange button
  // snaps dragged nodes back to. Refreshed every rebuild/canvas resize.
  const layoutPosRef = useRef<Map<string, { x: number; y: number }>>(new Map());

  // Previous (toolCalls, iteration) per agent — drives delta-based movement so a
  // cross-process agent's desk pulses whenever it advances between snapshots.
  const prevAgentStatsRef = useRef<Map<string, { toolCalls: number; iteration: number }>>(
    new Map(),
  );

  // Signature of the current node set. We only auto-fit the view when nodes are
  // added/removed — not on every data tick — so the canvas doesn't constantly
  // jump/recenter ("refresh atıyor") while agents are just updating counters.
  const prevNodeSigRef = useRef<string>('');

  // Build nodes from the live snapshot (clients/agents) + local fleet store.
  useEffect(() => {
    const rfNodes: Node<OfficeNodeData>[] = [];
    const rfEdges: Edge[] = [];
    const now = Date.now();

    const clientLayout = layoutClientClusters(
      clients.map((client) => ({ id: client.id, agentCount: client.agents.length })),
      canvasSize,
    );

    // ── Mailbox Node ──────────────────────────────────────────────
    const unreadCount = mailboxMessages.filter(
      (m) => !m.completed && (m.readByCount ?? 0) === 0,
    ).length;

    // Most recent message (by timestamp) — surfaced on the node + detail panel.
    const lastMsg = mailboxMessages.length
      ? [...mailboxMessages].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0]
      : undefined;

    rfNodes.push({
      id: 'mailbox',
      type: 'mailbox',
      position: { x: CENTER_X + HUB_GAP, y: MAILBOX_Y },
      data: {
        label: t('activity:office.mailboxHub'),
        kind: 'mailbox',
        status: unreadCount > 0 ? 'active' : 'idle',
        unreadCount,
        messageCount: mailboxMessages.length,
        sublabel: lastMsg ? `${lastMsg.from} → ${lastMsg.to}: ${lastMsg.subject}` : undefined,
        color: OFFICE_COLOR.warning,
      },
    });

    // ── Fleet totals (project-wide, summed across every client's agents) ──
    let fleetActive = 0;
    let fleetAgentsTotal = 0;
    let fleetTools = 0;
    let fleetCost = 0;
    let fleetTokens = 0;
    for (const c of clients) {
      for (const a of c.agents) {
        fleetAgentsTotal += 1;
        if (a.status === 'active' || a.status === 'streaming') fleetActive += 1;
        fleetTools += a.toolCalls;
        fleetCost += a.costUsd;
        fleetTokens += a.tokensIn + a.tokensOut;
      }
    }

    // ── Coordinator Node — live fleet summary ─────────────────────
    const leaderAgent = leaderId ? fleetAgents.get(leaderId) : null;
    const anyAgentRunning = fleetActive > 0;

    rfNodes.push({
      id: 'coordinator',
      type: 'coordinator',
      position: { x: CENTER_X - HUB_GAP, y: COORD_Y },
      data: {
        label: t('activity:office.fleetHqLabel'),
        sublabel: t('activity:office.clientsSuffix', { count: clients.length }),
        kind: 'coordinator',
        status: leaderAgent?.status === 'failed' ? 'error' : anyAgentRunning ? 'active' : 'idle',
        connections: clients.length,
        agentsActive: fleetActive,
        agentsTotal: fleetAgentsTotal,
        toolCalls: fleetTools,
        costUsd: fleetCost,
        tokensIn: fleetTokens,
        color: OFFICE_COLOR.primary,
      },
    });

    // ── Per-client columns: client node + its agents/desks ─────────
    const clientColor: Record<'tui' | 'webui' | 'repl', string> = {
      tui: OFFICE_COLOR.success,
      webui: OFFICE_COLOR.info,
      repl: OFFICE_COLOR.warning,
    };

    for (const client of clients) {
      const clusterPosition = clientLayout.positions.get(client.id) ?? { x: CENTER_X, y: 370 };
      const cx = clusterPosition.x;
      const cy = clusterPosition.y;
      const color = clientColor[client.type];
      const clientActive = client.status === 'active';

      rfNodes.push({
        id: client.id,
        type: client.type,
        position: { x: cx, y: cy },
        data: {
          label: client.label,
          sublabel: client.sublabel,
          kind: client.type,
          status: client.status,
          sessionId: client.sessionId,
          pid: client.pid,
          branch: client.branch,
          workingDir: client.workingDir,
          startedAt: client.startedAt,
          agentCount: client.agents.length,
          color,
        },
      });

      // Wire: Client → Coordinator (uplink; animated while the client is busy)
      rfEdges.push({
        id: `${client.id}->coordinator`,
        source: client.id,
        target: 'coordinator',
        type: 'wire',
        animated: clientActive,
        data: {
          color,
          animated: clientActive,
          label: t('activity:office.controlLabel'),
          flowType: 'task',
        },
      });

      // Wire: Mailbox → Client
      rfEdges.push({
        id: `mailbox->${client.id}`,
        source: 'mailbox',
        target: client.id,
        type: 'wire',
        animated: unreadCount > 0,
        data: {
          color: OFFICE_COLOR.warning,
          animated: unreadCount > 0,
          label: unreadCount > 0 ? `${unreadCount}` : undefined,
          flowType: 'mail',
        },
      });

      if (client.agents.length === 0) {
        // Idle desk placeholder so the client never looks broken.
        rfNodes.push({
          id: `desk-${client.id}`,
          type: 'desk',
          position: { x: cx, y: cy + CLIENT_AGENT_GAP },
          data: {
            label: t('activity:office.idleDesk'),
            kind: 'agent',
            status: 'idle',
            color: OFFICE_COLOR.muted,
          },
        });
        continue;
      }

      client.agents.forEach((agent, j) => {
        const isActive = agent.status === 'active' || agent.status === 'streaming';

        // ── Delta-driven movement ──────────────────────────────────
        // Pulse the desk + its wires when the agent advances (more tools /
        // iterations) or is actively running. Reuses the decay machinery.
        const prev = prevAgentStatsRef.current.get(agent.serverId);
        const advanced =
          (prev ? agent.toolCalls > prev.toolCalls || agent.iteration > prev.iteration : false) ||
          isActive;
        if (advanced) {
          activeNodesRef.current.set(agent.officeId, now + ACTIVE_MS);
          const cur = vizActivityRef.current.get(agent.officeId) ?? 0;
          vizActivityRef.current.set(agent.officeId, Math.min(1, cur + (1 - cur) * 0.5));
          for (const edgeId of [`${client.id}->${agent.officeId}`, `${client.id}->coordinator`]) {
            const e = edgeIntensitiesRef.current.get(edgeId) ?? 0;
            edgeIntensitiesRef.current.set(edgeId, Math.min(1, e + 0.5));
          }
        }
        prevAgentStatsRef.current.set(agent.serverId, {
          toolCalls: agent.toolCalls,
          iteration: agent.iteration,
        });

        rfNodes.push({
          id: agent.officeId,
          type: 'agent',
          position: agentFanPos(cx, j, client.agents.length, cy + CLIENT_AGENT_GAP),
          data: {
            label: agent.name,
            kind: 'agent',
            status: agent.status,
            serverId: agent.serverId,
            sessionId: client.sessionId,
            currentTask: agent.currentTask,
            iteration: agent.iteration,
            toolCalls: agent.toolCalls,
            costUsd: agent.costUsd,
            tokensIn: agent.tokensIn,
            tokensOut: agent.tokensOut,
            ctxPct: agent.ctxPct,
            model: agent.model,
            lastActivityAt: agent.lastActivityAt,
            color: OFFICE_COLOR.primary,
          },
        });

        // Wire: Client → Agent. Agents belong to their owning client/session,
        // not the coordinator — so each desk hangs off its own client node.
        rfEdges.push({
          id: `${client.id}->${agent.officeId}`,
          source: client.id,
          target: agent.officeId,
          type: 'wire',
          animated: isActive,
          data: {
            color: OFFICE_COLOR.primary,
            animated: isActive,
            label: isActive
              ? (compactFlowLabel(agent.currentTask, 48) ?? t('activity:office.taskFallback'))
              : undefined,
            flowType: 'task',
          },
        });
      });
    }

    // Drop stale prev-stats for agents no longer present.
    const liveAgentIds = new Set(clients.flatMap((c) => c.agents.map((a) => a.serverId)));
    for (const id of [...prevAgentStatsRef.current.keys()]) {
      if (!liveAgentIds.has(id)) prevAgentStatsRef.current.delete(id);
    }

    // Same hygiene as the prev-stats prune above for the transient-highlight
    // map: expired entries were only SKIPPED at read time, never deleted, so
    // every node id ever highlighted stayed resident for the session.
    for (const [id, until] of [...activeNodesRef.current]) {
      if (until <= now) activeNodesRef.current.delete(id);
    }

    // Re-apply still-live transient "active" highlights + activity glow so the
    // rebuild does not clobber state set by the viz-event/delta effects.
    const overlaidNodes = rfNodes.map((n) => {
      const until = activeNodesRef.current.get(n.id);
      const activity = vizActivityRef.current.get(n.id) ?? 0;
      if (until && until > now && n.data.status !== 'error' && n.data.status !== 'offline') {
        return { ...n, data: { ...n.data, status: 'active' as const, vizActivity: activity } };
      }
      return { ...n, data: { ...n.data, vizActivity: activity } };
    });

    // Overlay live edge intensities so a rebuild keeps animating wires that the
    // viz/delta effects lit (a fresh rebuild would otherwise reset them).
    const overlaidEdges = rfEdges.map((e) => {
      const intensity = edgeIntensitiesRef.current.get(e.id) ?? 0;
      if (intensity > 0.05) {
        return { ...e, animated: true, data: { ...e.data, animated: true, intensity } };
      }
      return e;
    });

    // Remember each node's computed home so "Arrange" can snap drags back.
    const home = new Map<string, { x: number; y: number }>();
    for (const n of overlaidNodes) home.set(n.id, { ...n.position });
    layoutPosRef.current = home;

    setNodes(overlaidNodes);
    setEdges(overlaidEdges);

    // Re-fit when topology or canvas geometry changes, not on every counter
    // update — otherwise the canvas recenters on each 5s snapshot.
    const sig = [
      `${Math.round(canvasSize.width)}x${Math.round(canvasSize.height)}`,
      `${clientLayout.columns}x${clientLayout.rows}`,
      clients.map((client) => `${client.id}:${client.agents.length}`).join('|'),
      overlaidNodes
        .map((node) => node.id)
        .sort()
        .join('|'),
    ].join(':');
    if (sig !== prevNodeSigRef.current) {
      prevNodeSigRef.current = sig;
      const fitTimer = setTimeout(() => fitView({ padding: FIT_VIEW_PADDING, duration: 300 }), 50);
      return () => clearTimeout(fitTimer);
    }
    return undefined;
  }, [
    clients,
    leaderId,
    fleetAgents,
    mailboxMessages,
    session,
    canvasSize,
    ACTIVE_MS,
    setNodes,
    setEdges,
    fitView,
  ]);

  // ── Viz event → node/edge highlight mapping ─────────────────────────
  // Maps generic viz event sources to office-map node IDs.
  // Returns the set of office-map node IDs to highlight + edge IDs to animate.
  // ── Server-agent-ID → office-map-ID helpers ──────────────────────────
  // Office node ids mirror the server agent id 1:1 (`agent-<serverId>`), so the
  // mapping is direct. We still build the set of currently-rendered agents (from
  // the resolved client model) to scope mailbox/iteration fan-outs to real nodes.
  //
  // Memoized off `clients` (itself memoized off the snapshot/fleet stores) so
  // the id→node mapping has a stable identity between snapshot changes. The
  // overlay effect depends on this model directly — NOT on `fleetAgents` as a
  // proxy — closing the window where a viz event could resolve against a
  // mapping built from a previous snapshot.
  const vizTargetModel = useMemo(() => {
    const renderedAgents = clients.flatMap((c) =>
      c.agents.map((a) => ({
        clientId: c.id,
        clientType: c.type,
        officeId: a.officeId,
        serverId: a.serverId,
      })),
    );
    // serverId → officeId for the viz overlay. Office ids are namespaced per
    // client, so a viz event (which only carries the bare agent id) maps to the
    // attached WebUI client's node when the same id exists in several sessions.
    const serverIdToOffice = new Map<string, string>();
    for (const a of renderedAgents) {
      if (!serverIdToOffice.has(a.serverId) || a.clientType === 'webui') {
        serverIdToOffice.set(a.serverId, a.officeId);
      }
    }
    return { renderedAgents, serverIdToOffice, clientIds: clients.map((c) => c.id) };
  }, [clients]);

  const vizEventToTargets = useCallback(
    (
      event: (typeof vizEvents)[0],
    ): {
      nodes: string[];
      edges: string[];
      status: ClientStatus;
    } => {
      const toOfficeAgentId = (serverId: string): string =>
        vizTargetModel.serverIdToOffice.get(serverId) ?? `agent-${serverId}`;
      switch (event.kind) {
        case 'mailbox:send':
        case 'mailbox:deliver':
          return {
            nodes: ['mailbox'],
            // Mail flows from the hub out to every connected client.
            edges:
              event.kind === 'mailbox:send'
                ? vizTargetModel.clientIds.map((id) => `mailbox->${id}`)
                : [],
            status: 'active',
          };

        case 'agent:spawned': {
          const officeId = toOfficeAgentId(event.source);
          return {
            nodes: ['coordinator', officeId],
            edges: [agentEdgeId(officeId)],
            status: 'active',
          };
        }

        case 'agent:tool':
        case 'tool:started':
        case 'tool:progress': {
          const officeId = toOfficeAgentId(event.source);
          return {
            nodes: ['coordinator', officeId],
            edges: [agentEdgeId(officeId)],
            status:
              event.kind === 'tool:progress'
                ? 'streaming'
                : event.kind === 'tool:started'
                  ? 'streaming'
                  : 'active',
          };
        }

        case 'tool:executed': {
          const officeId = toOfficeAgentId(event.target ?? event.source);
          return {
            nodes: [officeId],
            edges: [agentEdgeId(officeId)],
            status: 'active',
          };
        }

        case 'provider:call':
        case 'provider:delta':
        case 'provider:response':
          return {
            nodes: ['coordinator'],
            edges: [],
            status: event.kind === 'provider:delta' ? 'streaming' : 'active',
          };

        case 'iteration:start':
        case 'iteration:end':
          return {
            nodes: ['coordinator'],
            edges: vizTargetModel.renderedAgents.map((a) => agentEdgeId(a.officeId)),
            status: event.kind === 'iteration:start' ? 'streaming' : 'active',
          };

        case 'agent:text': {
          const officeId = toOfficeAgentId(event.source);
          return {
            nodes: [officeId],
            edges: [agentEdgeId(officeId)],
            status: 'streaming',
          };
        }

        case 'agent:status': {
          const officeId = toOfficeAgentId(event.source);
          return {
            nodes: ['coordinator', officeId],
            edges: [agentEdgeId(officeId)],
            status:
              event.data &&
              typeof event.data === 'object' &&
              'status' in event.data &&
              String((event.data as Record<string, unknown>).status) === 'failed'
                ? 'error'
                : 'completed',
          };
        }

        case 'agent:ctx': {
          const officeId = toOfficeAgentId(event.source);
          return {
            nodes: [officeId],
            edges: [],
            status: 'active',
          };
        }

        case 'budget:extended': {
          const officeId = toOfficeAgentId(event.source);
          return {
            nodes: ['coordinator', officeId],
            edges: [],
            status: 'active',
          };
        }

        case 'context:compacted':
        case 'context:repaired':
          return {
            nodes: ['coordinator'],
            edges: [],
            status: 'active',
          };

        case 'error':
          return {
            nodes: event.source ? [toOfficeAgentId(event.source)] : [],
            edges: [],
            status: 'error',
          };

        case 'cost:update':
          return {
            nodes: ['coordinator'],
            edges: [],
            status: 'active',
          };

        case 'fleet:snapshot': {
          // sessions.status_update periodic broadcast — update all active agent nodes
          const sessions =
            (
              event.data as {
                sessions?:
                  | Array<{
                      id: string;
                      status: string;
                      agents?: Array<{ id: string; name: string; status: string }>;
                    }>
                  | undefined;
              }
            )?.sessions ?? [];
          const nodes: string[] = ['coordinator'];
          for (const session of sessions) {
            if (session.agents) {
              for (const agent of session.agents) {
                const officeId = toOfficeAgentId(agent.id);
                if (!nodes.includes(officeId)) nodes.push(officeId);
              }
            }
          }
          return { nodes, edges: [], status: 'active' };
        }

        default:
          return { nodes: [], edges: [], status: 'idle' };
      }
    },
    [vizTargetModel],
  );

  // Handle viz events for live updates — now handles ALL event types.
  // Coalescing: the store can append several events between two renders
  // (agents spam tools faster than React commits). Track the id of the last
  // processed newest event and consume EVERY event newer than it, oldest
  // first, so the newest status per node wins and burst events are not
  // silently dropped the way the old vizEvents[0]-only path did.
  const lastProcessedVizEventIdRef = useRef<string | null>(null);
  const vizCoalesceArmedRef = useRef(false);
  useEffect(() => {
    if (vizEvents.length === 0) return;

    if (!vizCoalesceArmedRef.current) {
      // First run after mount: adopt the current window without replaying
      // it — these events predate the live view.
      vizCoalesceArmedRef.current = true;
      lastProcessedVizEventIdRef.current = vizEvents[0]?.id ?? null;
      return;
    }

    const lastProcessedId = lastProcessedVizEventIdRef.current;
    lastProcessedVizEventIdRef.current = vizEvents[0]?.id ?? null;
    // Events are newest-first: everything in front of the previously
    // processed event is fresh. If that event was evicted from the ring
    // buffer (long burst), the whole visible window is fresh.
    const freshEnd = lastProcessedId
      ? vizEvents.findIndex((event) => event.id === lastProcessedId)
      : -1;
    if (freshEnd === 0) return; // no new events since the last run
    const freshCount = freshEnd === -1 ? vizEvents.length : freshEnd;

    const now = Date.now();
    // Per-node latest status across the fresh slice — the newest event that
    // targeted a node decides its status.
    const nodeStatuses = new Map<string, ClientStatus>();
    const boostedEdges = new Set<string>();

    for (let index = freshCount - 1; index >= 0; index--) {
      const event = vizEvents[index];
      if (!event) continue;
      const { nodes: targetNodes, edges: targetEdges, status } = vizEventToTargets(event);
      for (const nodeId of targetNodes) {
        activeNodesRef.current.set(nodeId, now + ACTIVE_MS);
        const currentActivity = vizActivityRef.current.get(nodeId) ?? 0;
        // Boost: new activity = existing + (1 - existing) * 0.5 so repeated events saturate toward 1
        vizActivityRef.current.set(
          nodeId,
          Math.min(1, currentActivity + (1 - currentActivity) * 0.5),
        );
        nodeStatuses.set(nodeId, status as ClientStatus);
      }
      for (const edgeId of targetEdges) {
        const current = edgeIntensitiesRef.current.get(edgeId) ?? 0;
        edgeIntensitiesRef.current.set(edgeId, Math.min(1, current + 0.5));
        boostedEdges.add(edgeId);
      }
    }

    // Highlight target nodes and boost their activity — one setNodes for the
    // whole coalesced batch, not one per event.
    if (nodeStatuses.size > 0) {
      setNodes((nds) =>
        nds.map((n) => {
          const nextStatus = nodeStatuses.get(n.id);
          return nextStatus === undefined
            ? n
            : {
                ...n,
                data: {
                  ...n.data,
                  status: nextStatus,
                  vizActivity: vizActivityRef.current.get(n.id) ?? 0,
                },
              };
        }),
      );
    }

    // Animate target edges — boost their intensity.
    if (boostedEdges.size > 0) {
      setEdges((eds) =>
        eds.map((e) =>
          boostedEdges.has(e.id)
            ? {
                ...e,
                animated: true,
                data: {
                  ...e.data,
                  animated: true,
                  intensity: edgeIntensitiesRef.current.get(e.id) ?? 1,
                },
              }
            : e,
        ),
      );
    }
  }, [vizEvents, vizEventToTargets, setNodes, setEdges, ACTIVE_MS]);

  // Decay edge intensities and node activity over time (runs every second).
  //
  // Performance: previously this called setEdges/setNodes ONCE PER active
  // element inside the loop, so a fleet with N live edges + M live nodes
  // triggered N+M React state updates (and full array rebuilds) every tick.
  // We now mutate the refs in place and apply a SINGLE setEdges + SINGLE
  // setNodes at the end, collapsing N+M renders into at most two.
  useEffect(() => {
    const interval = setInterval(() => {
      const edgeUpdates = new Map<string, { intensity: number; animated: boolean }>();
      let edgesChanged = false;
      for (const [id, intensity] of edgeIntensitiesRef.current) {
        const decayed = intensity * 0.85;
        if (decayed < 0.05) {
          edgeIntensitiesRef.current.delete(id);
          edgeUpdates.set(id, { intensity: 0, animated: false });
          edgesChanged = true;
        } else {
          edgeIntensitiesRef.current.set(id, decayed);
          edgeUpdates.set(id, { intensity: decayed, animated: true });
          edgesChanged = true;
        }
      }
      if (edgesChanged) {
        setEdges((eds) =>
          eds.map((e) => {
            const upd = edgeUpdates.get(e.id);
            return upd
              ? {
                  ...e,
                  animated: upd.animated,
                  data: { ...e.data, animated: upd.animated, intensity: upd.intensity },
                }
              : e;
          }),
        );
      }

      const nodeUpdates = new Map<string, number>();
      let nodesChanged = false;
      for (const [id, activity] of vizActivityRef.current) {
        const decayed = activity * 0.9;
        if (decayed < 0.03) {
          vizActivityRef.current.delete(id);
          nodeUpdates.set(id, 0);
          nodesChanged = true;
        } else {
          vizActivityRef.current.set(id, decayed);
          nodeUpdates.set(id, decayed);
          nodesChanged = true;
        }
      }
      if (nodesChanged) {
        setNodes((nds) =>
          nds.map((n) => {
            const next = nodeUpdates.get(n.id);
            return next !== undefined ? { ...n, data: { ...n.data, vizActivity: next } } : n;
          }),
        );
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [setEdges, setNodes]);

  const onConnect = useCallback(
    (params: Connection) => setEdges((eds) => addEdge({ ...params, type: 'wire' }, eds)),
    [setEdges],
  );

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNode(node as Node<OfficeNodeData>);
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
  }, []);

  // Esc closes the expanded watch drawer first (leaving the node selected),
  // so a single Esc dismisses the big overlay without also deselecting.
  useEffect(() => {
    if (!watch) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setWatch(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [watch]);

  // Snap every node back to its responsive grid home, then use the whole
  // available canvas. This also tidies the office after manual dragging.
  const onArrange = useCallback(() => {
    setNodes((nds) =>
      nds.map((n) => {
        const home = layoutPosRef.current.get(n.id);
        return home ? { ...n, position: { ...home } } : n;
      }),
    );
    setTimeout(() => fitView({ padding: FIT_VIEW_PADDING, duration: 300 }), 50);
  }, [setNodes, fitView]);

  // Live indicator pulse. Skipped while the tab is hidden — the tick's only
  // job is refreshing visible relative-time/LED state, and re-rendering the
  // whole canvas every 2s in a background tab is wasted work.
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => {
      if (!document.hidden) setTick((t) => t + 1);
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div
      ref={canvasRef}
      className="relative h-full w-full overflow-hidden bg-[hsl(var(--surface-2)/0.55)]"
    >
      {/* Grid background */}
      <div
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage: `
            linear-gradient(hsl(var(--foreground) / 0.1) 1px, transparent 1px),
            linear-gradient(90deg, hsl(var(--foreground) / 0.1) 1px, transparent 1px)
          `,
          backgroundSize: '40px 40px',
        }}
      />

      {/* Real-time Stats HUD */}
      {showHud && <StatsHUD />}

      {/* Room labels */}
      <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10">
        <div className="rounded-lg border border-border/70 bg-card/90 px-4 py-2 shadow-xl backdrop-blur">
          <div className="flex items-center gap-2 text-xs font-bold text-foreground">
            <Building2 className="h-4 w-4 text-primary" />
            {t('activity:office.fleetHq')}
            <span className="ml-2 h-2 w-2 animate-pulse rounded-full bg-success" />
            <span className="text-[10px] font-normal text-muted-foreground">
              {t('activity:office.live')}
            </span>
          </div>
        </div>
      </div>

      {showLegend && <OfficeMapLegends />}

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: FIT_VIEW_PADDING }}
        minZoom={0.15}
        maxZoom={1.5}
        defaultEdgeOptions={{
          type: 'wire',
        }}
        proOptions={{ hideAttribution: true }}
      >
        <OfficeToolbar
          broadcastOpen={broadcastOpen}
          labels={{
            arrange: t('activity:office.arrange'),
            arrangeTitle: t('activity:office.arrangeTitle'),
            broadcast: t('activity:office.broadcast'),
            broadcastTitle: t('activity:office.broadcastTitle'),
            feed: t('activity:office.feed'),
            feedTitle: t('activity:office.feedTitle'),
          }}
          onArrange={onArrange}
          onBroadcastToggle={() => setBroadcastOpen((v) => !v)}
          onFeedToggle={() => setShowFeed(!showFeed)}
          showFeed={showFeed}
        />
        {background !== 'none' && (
          <Background
            variant={
              background === 'lines'
                ? BackgroundVariant.Lines
                : background === 'cross'
                  ? BackgroundVariant.Cross
                  : BackgroundVariant.Dots
            }
            gap={20}
            size={1}
            color="hsl(var(--border) / 0.35)"
          />
        )}
        {showControls && (
          <Controls className="rounded-lg border border-border/70 bg-card/90 [&>button]:bg-card [&>button]:text-foreground" />
        )}
        {showMinimap && <OfficeMiniMap />}
      </ReactFlow>

      {showFeed && <LiveFeed events={vizEvents} now={Date.now()} />}

      {broadcastOpen && (
        <BroadcastComposer
          draft={broadcastDraft}
          isSending={broadcasting}
          result={broadcastResult}
          onClose={() => setBroadcastOpen(false)}
          onDraftChange={setBroadcastDraft}
          onSend={() => void sendBroadcast()}
        />
      )}

      {/* Selected node detail panel */}
      {selectedNode && (
        <SelectedNodeDetailPanel
          selectedNode={selectedNode}
          selectedAgentTranscript={selectedAgentTranscript}
          mailboxMessages={mailboxMessages}
          onClose={onPaneClick}
          onOpenWatch={setWatch}
        />
      )}

      {watch && (
        <SessionWatchDrawer
          closeTitle={t('activity:office.closeEsc')}
          label={watch.label}
          onClose={() => setWatch(null)}
          sessionId={watch.sessionId}
          streamTitle={t('activity:office.fullOperationStream')}
        />
      )}
    </div>
  );
}

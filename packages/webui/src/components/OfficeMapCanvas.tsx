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
  MiniMap,
  type Node,
  Panel,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import {
  Activity,
  Bot,
  Building2,
  Cpu,
  DollarSign,
  Hash,
  LayoutGrid,
  Mail,
  Maximize2,
  Monitor,
  ScrollText,
  Send,
  Terminal,
  Users,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import {
  EMPTY_AGENT_TRANSCRIPT,
  useFleetStore,
  useMailboxStore,
  useMonitorStore,
  useOfficeMapStore,
  useSessionStore,
  useVizStore,
} from '@/stores';
import type { VizEvent } from '@/stores/viz-store';
import { AgentTranscript } from './AgentTranscript';
import { feedColor, resolveClients } from './OfficeMapCanvas/resolve.js';
import { useRecentlyFinishedFleetAgents } from './OfficeMapCanvas/use-recently-finished.js';
import {
  agentFanPos,
  CENTER_X,
  CLIENT_AGENT_GAP,
  type ClientStatus,
  COORD_Y,
  compactFlowLabel,
  fmtAgo,
  fmtCompact,
  fmtUptime,
  HUB_GAP,
  layoutClientClusters,
  MAILBOX_Y,
  type OfficeNodeData,
  shortModel,
  surfaceLabel,
} from './OfficeMapCanvas/utils.js';
import { SessionWatchPanel } from './SessionWatchPanel';
import {
  clampCtxPct,
  FIT_VIEW_PADDING,
  nodeTypes,
  OFFICE_COLOR,
} from './OfficeMapCanvas/nodes.js';
import { edgeTypes } from './OfficeMapCanvas/edges.js';


function StatsHUD() {
  const { t } = useAppTranslation();
  const { clientCounts, currentSession, totalAgents, activeAgents, aggregate } = useMonitorStore(
    useShallow((s) => ({
      clientCounts: s.clientCounts,
      currentSession: s.currentSession,
      totalAgents: s.totalAgents,
      activeAgents: s.activeAgents,
      aggregate: s.aggregate,
    })),
  );
  const totalClients = clientCounts.tui + clientCounts.webui + clientCounts.repl;

  // Format tokens with commas
  const fmtNum = (n?: number) => n?.toLocaleString() ?? '0';
  const fmtCost = (n?: number) => (n != null ? `$${n.toFixed(4)}` : '$0.0000');

  return (
    <div className="absolute left-4 top-20 z-10 rounded-xl border border-border/70 bg-card/90 p-3 text-foreground shadow-xl backdrop-blur">
      <div className="flex items-center gap-2 mb-2">
        <Activity className="h-3.5 w-3.5 text-success" />
        <span className="text-[10px] font-bold uppercase text-muted-foreground">
          {t('activity:office.sessionStats')}
        </span>
      </div>

      <div className="space-y-1.5 text-[10px]">
        {/* Active clients */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-1.5">
            <Users className="h-3 w-3 text-muted-foreground" />
            <span className="text-muted-foreground">{t('activity:office.clients')}</span>
          </div>
          <span className="font-mono text-foreground">
            {activeAgents} <span className="text-muted-foreground">/</span>{' '}
            <span className="text-success">{totalClients}</span>
          </span>
        </div>

        {/* Client breakdown */}
        <div className="flex items-center gap-3 pl-4 text-[9px]">
          {clientCounts.tui > 0 && (
            <span className="flex items-center gap-1">
              <Terminal className="h-2.5 w-2.5 text-success" />
              <span className="text-muted-foreground">TUI</span>
              <span className="font-mono text-success">{clientCounts.tui}</span>
            </span>
          )}
          {clientCounts.webui > 0 && (
            <span className="flex items-center gap-1">
              <Monitor className="h-2.5 w-2.5 text-primary" />
              <span className="text-muted-foreground">WebUI</span>
              <span className="font-mono text-primary">{clientCounts.webui}</span>
            </span>
          )}
          {clientCounts.repl > 0 && (
            <span className="flex items-center gap-1">
              <Terminal className="h-2.5 w-2.5 text-warning" />
              <span className="text-muted-foreground">REPL</span>
              <span className="font-mono text-warning">{clientCounts.repl}</span>
            </span>
          )}
        </div>

        {/* Agent count */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-1.5">
            <Bot className="h-3 w-3 text-muted-foreground" />
            <span className="text-muted-foreground">{t('activity:officeMap.agents')}</span>
          </div>
          <span className="font-mono text-foreground">
            {activeAgents} <span className="text-muted-foreground">/</span>{' '}
            <span className="text-primary">{totalAgents}</span>
          </span>
        </div>

        {/* Model */}
        {currentSession.model && (
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-1.5">
              <Cpu className="h-3 w-3 text-muted-foreground" />
              <span className="text-muted-foreground">{t('activity:officeMap.model')}</span>
            </div>
            <span
              className="max-w-[120px] truncate font-mono text-primary"
              title={currentSession.model}
            >
              {currentSession.model.split('/').pop()?.slice(0, 16)}
            </span>
          </div>
        )}

        {/* Mode */}
        {currentSession.mode && (
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-1.5">
              <Zap className="h-3 w-3 text-muted-foreground" />
              <span className="text-muted-foreground">{t('activity:officeMap.mode')}</span>
            </div>
            <span
              className={cn(
                'font-mono uppercase text-[9px] px-1.5 py-0.5 rounded',
                currentSession.mode === 'auto' && 'bg-primary/10 text-primary',
                currentSession.mode === 'suggest' && 'bg-success/10 text-success',
                currentSession.mode === 'off' && 'bg-muted text-muted-foreground',
                !['auto', 'suggest', 'off'].includes(currentSession.mode || '') &&
                  'bg-muted text-muted-foreground',
              )}
            >
              {currentSession.mode}
            </span>
          </div>
        )}

        {/* Tool Calls — project-wide total across every live agent */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-1.5">
            <Hash className="h-3 w-3 text-muted-foreground" />
            <span className="text-muted-foreground">{t('activity:office.toolCallsLabel')}</span>
          </div>
          <span className="font-mono text-warning">{fmtNum(aggregate.toolCalls)}</span>
        </div>

        {/* Token breakdown — project-wide */}
        <div className="mt-1.5 space-y-1 border-t border-border/70 pt-1.5">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-1.5">
              <span className="text-[8px] text-muted-foreground">IN</span>
              <span className="text-muted-foreground">{t('activity:office.input')}</span>
            </div>
            <span className="font-mono text-[9px] text-foreground">
              {fmtNum(aggregate.tokensIn)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-1.5">
              <span className="text-[8px] text-muted-foreground">OUT</span>
              <span className="text-muted-foreground">{t('activity:office.output')}</span>
            </div>
            <span className="font-mono text-[9px] text-foreground">
              {fmtNum(aggregate.tokensOut)}
            </span>
          </div>
        </div>

        {/* Cost — project-wide */}
        <div className="mt-1.5 flex items-center justify-between gap-4 border-t border-border/70 pt-1.5">
          <div className="flex items-center gap-1.5">
            <DollarSign className="h-3 w-3 text-muted-foreground" />
            <span className="text-muted-foreground">{t('activity:office.cost')}</span>
          </div>
          <span className="font-mono font-medium text-success">{fmtCost(aggregate.costUsd)}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Bottom Live Activity strip — the most recent cross-process viz events
 * (tool calls, mail, provider/agent activity), newest first. Gives a running
 * log of "what just happened across the office" alongside the spatial map.
 */
function LiveFeed({ events, now }: { events: VizEvent[]; now: number }) {
  const { t } = useAppTranslation();
  const recent = events.slice(0, 14);
  return (
    <div className="absolute bottom-0 left-0 right-0 z-10 pointer-events-none px-3 pb-3">
      <div className="pointer-events-auto mx-auto max-w-3xl rounded-lg border border-border/70 bg-card/90 px-3 py-2 shadow-xl backdrop-blur">
        <div className="mb-1.5 flex items-center gap-1.5 text-[10px] uppercase text-primary">
          <Activity className="h-3 w-3" />
          {t('activity:office.liveActivity')}
        </div>
        {recent.length === 0 ? (
          <div className="text-[11px] italic text-muted-foreground">
            {t('activity:office.waitingActivity')}
          </div>
        ) : (
          <div className="flex flex-col gap-0.5 max-h-32 overflow-hidden">
            {recent.map((e) => {
              const ago = Math.max(0, Math.round((now - e.timestamp) / 1000));
              return (
                <div key={e.id} className="flex items-center gap-2 text-[11px] leading-tight">
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ backgroundColor: feedColor(e.kind) }}
                  />
                  <span className="flex-1 truncate text-foreground">{e.label}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {ago < 1 ? t('activity:office.now') : `${ago}s`}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
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
  const renderedAgents = clients.flatMap((c) =>
    c.agents.map((a) => ({
      clientId: c.id,
      clientType: c.type,
      officeId: a.officeId,
      serverId: a.serverId,
    })),
  );
  const clientIds = clients.map((c) => c.id);

  // serverId → officeId for the viz overlay. Office ids are namespaced per
  // client, so a viz event (which only carries the bare agent id) maps to the
  // attached WebUI client's node when the same id exists in several sessions.
  const serverIdToOffice = new Map<string, string>();
  for (const a of renderedAgents) {
    if (!serverIdToOffice.has(a.serverId) || a.clientType === 'webui') {
      serverIdToOffice.set(a.serverId, a.officeId);
    }
  }

  function toOfficeAgentId(serverId: string): string {
    return serverIdToOffice.get(serverId) ?? `agent-${serverId}`;
  }

  // The structural wire for an agent is `client->agent`. Office ids are
  // namespaced `${clientId}__agent-${serverId}`, so the owning client id is the
  // prefix before `__agent-` (falls back to the coordinator edge for un-namespaced ids).
  function agentEdgeId(officeId: string): string {
    const clientId = officeId.split('__agent-')[0];
    return clientId && clientId !== officeId
      ? `${clientId}->${officeId}`
      : `coordinator->${officeId}`;
  }

  function vizEventToTargets(event: (typeof vizEvents)[0]): {
    nodes: string[];
    edges: string[];
    status: ClientStatus;
  } {
    switch (event.kind) {
      case 'mailbox:send':
      case 'mailbox:deliver':
        return {
          nodes: ['mailbox'],
          // Mail flows from the hub out to every connected client.
          edges: event.kind === 'mailbox:send' ? clientIds.map((id) => `mailbox->${id}`) : [],
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
          edges: renderedAgents.map((a) => agentEdgeId(a.officeId)),
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
  }

  // Handle viz events for live updates — now handles ALL event types.
  useEffect(() => {
    if (vizEvents.length === 0) return;

    const latestEvent = vizEvents[0];
    if (!latestEvent) return;

    const { nodes: targetNodes, edges: targetEdges, status } = vizEventToTargets(latestEvent);
    const now = Date.now();

    // Highlight target nodes and boost their activity
    if (targetNodes.length > 0) {
      targetNodes.forEach((nodeId) => {
        activeNodesRef.current.set(nodeId, now + ACTIVE_MS);
        const currentActivity = vizActivityRef.current.get(nodeId) ?? 0;
        // Boost: new activity = existing + (1 - existing) * 0.5 so repeated events saturate toward 1
        vizActivityRef.current.set(
          nodeId,
          Math.min(1, currentActivity + (1 - currentActivity) * 0.5),
        );
      });

      setNodes((nds) =>
        nds.map((n) =>
          targetNodes.includes(n.id)
            ? {
                ...n,
                data: {
                  ...n.data,
                  status: status as ClientStatus,
                  vizActivity: vizActivityRef.current.get(n.id) ?? 0,
                },
              }
            : n,
        ),
      );
    }

    // Animate target edges — boost their intensity.
    if (targetEdges.length > 0) {
      targetEdges.forEach((edgeId) => {
        const current = edgeIntensitiesRef.current.get(edgeId) ?? 0;
        edgeIntensitiesRef.current.set(edgeId, Math.min(1, current + 0.5));
      });

      setEdges((eds) =>
        eds.map((e) =>
          targetEdges.includes(e.id)
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
  }, [vizEvents, setNodes, setEdges, ACTIVE_MS, fleetAgents]);

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
            linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)
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

      {/* Legend */}
      {showLegend && (
        <div className="absolute bottom-4 left-4 z-10 rounded-lg border border-border/70 bg-card/90 p-3 text-[10px] shadow-xl backdrop-blur">
          <div className="mb-2 font-bold text-foreground">{t('activity:office.legendStatus')}</div>
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 animate-pulse rounded-full bg-success" />
              <span className="text-muted-foreground">{t('activity:office.legendActive')}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-muted-foreground" />
              <span className="text-muted-foreground">{t('activity:office.legendIdle')}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 animate-pulse rounded-full bg-destructive" />
              <span className="text-muted-foreground">{t('activity:office.legendError')}</span>
            </div>
          </div>
        </div>
      )}

      {/* Connection type legend */}
      {showLegend && (
        <div className="absolute bottom-4 right-4 z-10 rounded-lg border border-border/70 bg-card/90 p-3 text-[10px] shadow-xl backdrop-blur">
          <div className="mb-2 font-bold text-foreground">
            {t('activity:office.legendConnections')}
          </div>
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-warning">✉</span>
              <span className="text-muted-foreground">{t('activity:office.legendMail')}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-primary">→</span>
              <span className="text-muted-foreground">{t('activity:office.legendTask')}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-success">●</span>
              <span className="text-muted-foreground">{t('activity:office.legendStatusConn')}</span>
            </div>
          </div>
        </div>
      )}

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
        <Panel position="top-right" className="flex items-center gap-2">
          <button
            type="button"
            onClick={onArrange}
            title={t('activity:office.arrangeTitle')}
            className="flex items-center gap-1.5 rounded-md border border-border/70 bg-card/90 px-2.5 py-1.5 text-xs text-foreground shadow-sm transition-colors hover:bg-accent"
          >
            <LayoutGrid className="h-3.5 w-3.5" />
            {t('activity:office.arrange')}
          </button>
          <button
            type="button"
            onClick={() => setShowFeed(!showFeed)}
            title={t('activity:office.feedTitle')}
            className={cn(
              'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-xs transition-colors',
              showFeed
                ? 'border-primary/35 bg-primary/10 text-primary'
                : 'border-border/70 bg-card/90 text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            <ScrollText className="h-3.5 w-3.5" />
            {t('activity:office.feed')}
          </button>
          <button
            type="button"
            onClick={() => setBroadcastOpen((v) => !v)}
            title={t('activity:office.broadcastTitle')}
            className={cn(
              'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-xs transition-colors',
              broadcastOpen
                ? 'border-warning/35 bg-warning/10 text-warning'
                : 'border-border/70 bg-card/90 text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            <Send className="h-3.5 w-3.5" />
            {t('activity:office.broadcast')}
          </button>
        </Panel>
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
        {showMinimap && (
          <MiniMap
            className="rounded-lg border border-border/70 bg-card/90"
            nodeColor={(n) => {
              const data = n.data as OfficeNodeData;
              switch (data.kind) {
                case 'coordinator':
                  return OFFICE_COLOR.primary;
                case 'webui':
                  return OFFICE_COLOR.info;
                case 'tui':
                  return OFFICE_COLOR.success;
                case 'repl':
                  return OFFICE_COLOR.warning;
                case 'mailbox':
                  return OFFICE_COLOR.warning;
                case 'agent':
                  return OFFICE_COLOR.primary;
                default:
                  return OFFICE_COLOR.primary;
              }
            }}
            maskColor="hsl(var(--background) / 0.72)"
          />
        )}
      </ReactFlow>

      {showFeed && <LiveFeed events={vizEvents} now={Date.now()} />}

      {/* Broadcast composer — fan one message out to every live session's leader. */}
      {broadcastOpen && (
        <div className="absolute right-4 top-16 z-30 w-80 rounded-xl border border-warning/35 bg-card/95 p-3 shadow-2xl backdrop-blur">
          <div className="mb-1.5 flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-warning">
              <Send className="h-3.5 w-3.5" /> {t('activity:office.broadcastToAll')}
            </div>
            <button
              type="button"
              onClick={() => setBroadcastOpen(false)}
              className="text-base leading-none text-muted-foreground hover:text-foreground"
            >
              ×
            </button>
          </div>
          <textarea
            value={broadcastDraft}
            onChange={(ev) => setBroadcastDraft(ev.target.value)}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
                ev.preventDefault();
                void sendBroadcast();
              }
            }}
            rows={3}
            placeholder={t('activity:office.broadcastPlaceholder')}
            className="w-full resize-none rounded-md border border-border/70 bg-background/70 px-2 py-1 text-[11px] text-foreground placeholder:text-muted-foreground focus:border-warning/45 focus:outline-none"
          />
          <div className="mt-1.5 flex items-center justify-between">
            <span className="text-[9px] text-muted-foreground">
              {t('activity:office.broadcastSendHint')}
            </span>
            <button
              type="button"
              onClick={() => void sendBroadcast()}
              disabled={broadcasting || !broadcastDraft.trim()}
              className="rounded-md border border-warning/35 bg-warning/12 px-2.5 py-1 text-[11px] text-warning transition-colors hover:bg-warning/18 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {broadcasting ? '…' : t('activity:office.broadcast')}
            </button>
          </div>
          {broadcastResult && (
            <div className="mt-1 text-[10px] text-muted-foreground">{broadcastResult}</div>
          )}
        </div>
      )}

      {/* Selected node detail panel */}
      {selectedNode && (
        <div
          className={cn(
            'absolute top-20 right-4 bg-background border border-border rounded-lg p-4 shadow-xl z-20',
            selectedNode.data.kind === 'agent'
              ? 'w-[28rem] max-w-[calc(100%-2rem)]'
              : selectedNode.data.sessionId
                ? 'w-80'
                : 'w-64',
          )}
        >
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              {selectedNode.data.kind === 'webui' && <Monitor className="h-4 w-4 text-info" />}
              {selectedNode.data.kind === 'tui' && <Terminal className="h-4 w-4 text-success" />}
              {selectedNode.data.kind === 'coordinator' && <Cpu className="h-4 w-4 text-primary" />}
              {selectedNode.data.kind === 'agent' && <Bot className="h-4 w-4 text-primary" />}
              {selectedNode.data.kind === 'mailbox' && <Mail className="h-4 w-4 text-warning" />}
              <span className="text-sm font-bold text-foreground">{selectedNode.data.label}</span>
            </div>
            <div className="flex items-center gap-1.5">
              {selectedNode.data.sessionId && (
                <button
                  type="button"
                  title={t('activity:office.openFullView')}
                  onClick={() =>
                    setWatch({
                      sessionId: selectedNode.data.sessionId!,
                      label: selectedNode.data.label,
                    })
                  }
                  className="text-muted-foreground hover:text-primary"
                >
                  <Maximize2 className="h-3.5 w-3.5" />
                </button>
              )}
              <button
                type="button"
                onClick={onPaneClick}
                className="text-muted-foreground hover:text-foreground text-lg leading-none"
              >
                ×
              </button>
            </div>
          </div>

          {(() => {
            const d = selectedNode.data;
            const now = Date.now();
            const Row = ({ k, v, accent }: { k: string; v: React.ReactNode; accent?: string }) => (
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground shrink-0">{k}</span>
                <span
                  className={cn('font-mono truncate text-right', accent ?? 'text-foreground/80')}
                >
                  {v}
                </span>
              </div>
            );
            const isAgent = d.kind === 'agent';
            const isClient = d.kind === 'webui' || d.kind === 'tui' || d.kind === 'repl';
            const tokTotal = (d.tokensIn || 0) + (d.tokensOut || 0);
            const ctxPct = clampCtxPct(d.ctxPct);
            return (
              <div className="space-y-1.5 text-xs">
                <Row
                  k="Status"
                  v={String(d.status).toUpperCase()}
                  accent={cn(
                    d.status === 'active' && 'text-success',
                    d.status === 'streaming' && 'text-primary',
                    d.status === 'error' && 'text-destructive',
                    d.status === 'idle' && 'text-muted-foreground',
                    d.status === 'offline' && 'text-muted-foreground/70',
                  )}
                />

                {isAgent && (
                  <>
                    {d.model && <Row k="Model" v={shortModel(d.model)} accent="text-primary" />}
                    {d.currentTask && (
                      <div className="pt-1">
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                          {t('activity:agentOffice.currentTask')}
                        </div>
                        <div className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[10px] text-primary">
                          {d.currentTask}
                        </div>
                      </div>
                    )}
                    <Row k="Iterations" v={d.iteration || 0} accent="text-primary" />
                    <Row k="Tool calls" v={d.toolCalls || 0} accent="text-warning" />
                    <Row k="Tokens in" v={fmtCompact(d.tokensIn)} />
                    <Row k="Tokens out" v={fmtCompact(d.tokensOut)} />
                    <Row k="Tokens total" v={fmtCompact(tokTotal)} />
                    {ctxPct > 0 && (
                      <Row
                        k="Context"
                        v={`${ctxPct}%`}
                        accent={
                          ctxPct >= 90
                            ? 'text-destructive'
                            : ctxPct >= 70
                              ? 'text-warning'
                              : 'text-foreground/70'
                        }
                      />
                    )}
                    <Row k="Cost" v={`$${(d.costUsd || 0).toFixed(4)}`} accent="text-success" />
                    {d.lastActivityAt && (
                      <Row
                        k="Last seen"
                        v={fmtAgo(d.lastActivityAt, now)}
                        accent="text-muted-foreground"
                      />
                    )}
                    <div className="pt-2">
                      <AgentTranscript
                        entries={selectedAgentTranscript}
                        agentName={d.label}
                        compact
                        maxHeightClassName="max-h-64"
                      />
                    </div>
                  </>
                )}

                {isClient && (
                  <>
                    <Row
                      k="Surface"
                      v={surfaceLabel(d.kind as 'tui' | 'webui' | 'repl')}
                      accent="text-foreground/80"
                    />
                    {d.branch && <Row k="Branch" v={`⎇ ${d.branch}`} accent="text-foreground/70" />}
                    {d.pid != null && <Row k="PID" v={d.pid} />}
                    {d.workingDir && (
                      <Row k="Dir" v={d.workingDir} accent="text-muted-foreground" />
                    )}
                    <Row k="Agents" v={d.agentCount ?? 0} accent="text-primary" />
                    {d.startedAt && (
                      <Row k="Uptime" v={fmtUptime(d.startedAt, now)} accent="text-foreground/70" />
                    )}
                  </>
                )}

                {d.kind === 'mailbox' && (
                  <>
                    <Row k="Total messages" v={d.messageCount || 0} accent="text-warning" />
                    <Row k="Unread" v={d.unreadCount || 0} accent="text-warning" />
                    {mailboxMessages.length > 0 && (
                      <div className="mt-1 space-y-1 border-t border-border pt-2">
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          {t('activity:office.recent')}
                        </div>
                        {[...mailboxMessages]
                          .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
                          .slice(0, 6)
                          .map((m) => {
                            const unread = !m.completed && (m.readByCount ?? 0) === 0;
                            return (
                              <div key={m.id} className="flex items-start gap-1.5 text-[10px]">
                                <span
                                  className={cn(
                                    'mt-1 h-1.5 w-1.5 shrink-0 rounded-full',
                                    unread ? 'bg-warning' : m.completed ? 'bg-success' : 'bg-muted',
                                  )}
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-foreground/80">
                                    {m.subject || t('activity:office.noSubject')}
                                  </div>
                                  <div className="truncate font-mono text-[9px] text-muted-foreground">
                                    {m.from} → {m.to} · {fmtAgo(m.timestamp, now)}
                                    {m.audience === 'leaders'
                                      ? ` · ${t('activity:mailbox.audienceLeaders')}`
                                      : ''}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                      </div>
                    )}
                  </>
                )}

                {d.kind === 'coordinator' && (
                  <>
                    <Row k="Connections" v={d.connections || 0} accent="text-primary" />
                    <Row k="Iterations" v={d.iteration || 0} accent="text-primary" />
                  </>
                )}

                {(isAgent || isClient) && d.sessionId && (
                  <div className="mt-2 border-t border-border pt-2 h-72">
                    <SessionWatchPanel sessionId={d.sessionId} />
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}

      {/* Expanded watch drawer — full-height, wide overlay on the right showing
          the selected agent/client's COMPLETE operation stream + composer. */}
      {watch && (
        <div className="absolute inset-y-0 right-0 z-30 flex w-[min(680px,92%)] flex-col border-l border-border bg-background shadow-2xl">
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5 shrink-0 bg-card">
            <div className="flex items-center gap-2 min-w-0">
              <Bot className="h-4 w-4 text-primary shrink-0" />
              <div className="min-w-0">
                <div className="truncate text-sm font-bold text-foreground">{watch.label}</div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {t('activity:office.fullOperationStream')}
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setWatch(null)}
              title={t('activity:office.closeEsc')}
              className="text-muted-foreground hover:text-foreground text-xl leading-none shrink-0"
            >
              ×
            </button>
          </div>
          <div className="flex-1 min-h-0 p-4">
            <SessionWatchPanel sessionId={watch.sessionId} limit={500} />
          </div>
        </div>
      )}
    </div>
  );
}

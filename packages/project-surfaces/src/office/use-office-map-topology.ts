import { isMailboxMessageUnread } from '@wrongstack/contracts/types/mailbox';
import type { Edge, Node } from '@xyflow/react';
import type { TFunction } from 'i18next';

import '@xyflow/react/dist/style.css';

import { useEffect } from 'react';

import { FIT_VIEW_PADDING, OFFICE_COLOR } from './OfficeMapCanvas/nodes.js';

import {
  agentFanPos,
  CENTER_X,
  CLIENT_AGENT_GAP,
  COORD_Y,
  compactFlowLabel,
  HUB_GAP,
  layoutClientClusters,
  MAILBOX_Y,
  type OfficeNodeData,
} from './OfficeMapCanvas/utils.js';
export function useOfficeMapTopology({
  clients,
  canvasSize,
  mailboxMessages,
  t,
  leaderId,
  fleetAgents,
  prevAgentStatsRef,
  activeNodesRef,
  ACTIVE_MS,
  vizActivityRef,
  edgeIntensitiesRef,
  layoutPosRef,
  setNodes,
  setEdges,
  prevNodeSigRef,
  fitView,
}: {
  clients: import('./OfficeMapCanvas/resolve.js').ResolvedClient[];
  canvasSize: { width: number; height: number };
  mailboxMessages: import('./types').MailboxMessage[];
  t: TFunction<'translation', undefined>;
  leaderId: string | undefined;
  fleetAgents: ReadonlyMap<string, import('./types').SubagentView>;
  prevAgentStatsRef: React.RefObject<Map<string, { toolCalls: number; iteration: number }>>;
  activeNodesRef: React.RefObject<Map<string, number>>;
  ACTIVE_MS: 4000;
  vizActivityRef: React.RefObject<Map<string, number>>;
  edgeIntensitiesRef: React.RefObject<Map<string, number>>;
  layoutPosRef: React.RefObject<Map<string, { x: number; y: number }>>;
  setNodes: React.Dispatch<
    React.SetStateAction<
      import('@xyflow/react').Node<import('./OfficeMapCanvas/utils.js').OfficeNodeData>[]
    >
  >;
  setEdges: React.Dispatch<React.SetStateAction<import('@xyflow/react').Edge[]>>;
  prevNodeSigRef: React.RefObject<string>;
  fitView: import('@xyflow/react').FitView<import('@xyflow/react').Node>;
}) {
  useEffect(() => {
    const rfNodes: Node<OfficeNodeData>[] = [];
    const rfEdges: Edge[] = [];
    const now = Date.now();

    const clientLayout = layoutClientClusters(
      clients.map((client) => ({ id: client.id, agentCount: client.agents.length })),
      canvasSize,
    );

    // ── Mailbox Node ──────────────────────────────────────────────
    const unreadCount = mailboxMessages.filter((m) => isMailboxMessageUnread(m)).length;

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
            provider: agent.provider,
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
    canvasSize,
    ACTIVE_MS,
    setNodes,
    setEdges,
    fitView,
  ]);
}

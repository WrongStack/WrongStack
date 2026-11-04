import {
  addEdge,
  type Connection,
  type Edge,
  type Node,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAppTranslation } from '../lib/i18n';
import { EMPTY_TRANSCRIPT, useOfficeFeed, WEBUI_SELF } from './feed';
import { FIT_VIEW_PADDING } from './OfficeMapCanvas/nodes.js';
import { resolveClients } from './OfficeMapCanvas/resolve.js';
import { useRecentlyFinishedFleetAgents } from './OfficeMapCanvas/use-recently-finished.js';
import type { ClientStatus, OfficeNodeData } from './OfficeMapCanvas/utils.js';
import { useOfficeMapStore } from './office-map-store';
import { useOfficeMapTopology } from './use-office-map-topology.js';

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

export function useOfficeMapCanvas() {
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
  const feed = useOfficeFeed();
  const vizEvents = feed.useVizEvents();
  const fleetAgents = feed.useFleetAgents();
  const agentTranscripts = feed.useAgentTranscripts();
  const leaderId = feed.useLeaderId();

  // Live cross-process snapshot — the structural source of truth for the map.
  const liveSessions = feed.useLiveSessions();

  const mailboxMessages = feed.useMailboxMessages();
  const mailboxAgents = feed.useMailboxAgents();
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
        feed.self ?? WEBUI_SELF,
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
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  // Resolve selection from the latest topology snapshot. A saved Node object
  // leaves the detail panel showing stale counters/status after each refresh.
  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;
  useEffect(() => {
    if (selectedNodeId && !selectedNode) setSelectedNodeId(null);
  }, [selectedNodeId, selectedNode]);
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
    if (selectedNode?.data.kind !== 'agent') return EMPTY_TRANSCRIPT;
    const serverId =
      selectedNode.data.serverId ??
      (selectedNode.id.includes('__agent-')
        ? selectedNode.id.split('__agent-').pop()
        : selectedNode.id.replace(/^agent-/, ''));
    return serverId ? (agentTranscripts.get(serverId) ?? EMPTY_TRANSCRIPT) : EMPTY_TRANSCRIPT;
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
  useOfficeMapTopology({
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
  });

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
    setSelectedNodeId(node.id);
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedNodeId(null);
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
  return {
    canvasRef,
    showHud,
    t,
    showLegend,
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    onConnect,
    onNodeClick,
    onPaneClick,
    broadcastOpen,
    onArrange,
    setBroadcastOpen,
    setShowFeed,
    showFeed,
    background,
    showControls,
    showMinimap,
    vizEvents,
    broadcastDraft,
    broadcasting,
    broadcastResult,
    setBroadcastDraft,
    sendBroadcast,
    selectedNode,
    selectedAgentTranscript,
    mailboxMessages,
    setWatch,
    watch,
  };
}

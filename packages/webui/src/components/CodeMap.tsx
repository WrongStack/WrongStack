/**
 * Code Atlas — persistent code tree, dependency canvas, and relation inspector.
 *
 * The explorer never disappears while the user moves package → file → symbol.
 * A graph click focuses relationships; explicit open actions change scope.
 *
 * Performance notes:
 * - Activity store is subscribed via selectors (not the whole store).
 * - React Flow rebuilds are immediate for structural changes and throttled for
 *   telemetry-only updates (see FLOW_ACTIVITY_THROTTLE_MS).
 * - SMART mode caps canvas nodes; MiniMap is gated by node count.
 */

import {
  type Edge,
  MarkerType,
  type Node,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import '@xyflow/react/dist/style.css';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useShallow } from 'zustand/react/shallow';
import {
  activityAgentKey,
  type FileActivity,
  groupAgentPresences,
  useCodemapActivityStore,
} from '@/stores/codemap-activity-store';
import { useCodemapIndexStore } from '@/stores/codemap-index-store';
import {
  activityFingerprint,
  activityMatchesNode,
  hashGraphStructure,
  indexActivitiesByNode,
  packageForFile,
  resolveSymbolForActivity,
  sameFile,
  touchClientGraphCache,
} from './CodeMapActivityHelpers';
import { CodeMapActivityDrawer } from './CodeMapActivityDrawer';
import { CodeMapCanvasSurface } from './CodeMapCanvasSurface';
import { CodeMapCanvasToolbar } from './CodeMapCanvasToolbar';
import { CodeMapHeader } from './CodeMapHeader';
import { CodeMapRelationInspector } from './CodeMapRelationInspector';
import { CodeMapTreeSidebar } from './CodeMapTreeSidebar';
import {
  EMPTY_GRAPH,
  FLOW_ACTIVITY_THROTTLE_MS,
  MAX_ANIMATED_EDGES,
  MAX_CLIENT_GRAPH_CACHE,
  MAX_SYMBOL_RESOLVE_INFLIGHT,
  MAX_TRAIL_AGENTS,
  MAX_TRAIL_HOPS,
  SEARCH_DEBOUNCE_MS,
  SEARCH_VIRTUALIZE_THRESHOLD,
} from './CodeMapConfig';
import { preserveFlowEdges, preserveFlowNodes } from './CodeMapFlowState';
import { LiveAgentsHud, LiveControlBar } from './CodeMapLiveOverlay';
import { agentInitials, agentTrailColor, type CodeMapNodeData, EDGE_COLOR } from './CodeMapVisuals';
import {
  buildDirectoryTree,
  type CodeMapGraphResponse,
  type CodeMapLayout,
  type CodeMapScope,
  connectedNodeIds,
  type GraphNodeData,
  type GraphRefType,
  layoutGraph,
  normalizedPath,
  relationItems,
  scopeKey,
  scopeUrl,
  smartCanvasGraph,
} from './codemap-model';

function CodeMapInner(): React.ReactElement {
  const [scope, setScope] = useState<CodeMapScope>({ level: 'packages' });
  const currentScopeKey = scopeKey(scope);
  const [graph, setGraph] = useState<CodeMapGraphResponse>(EMPTY_GRAPH);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [layout, setLayout] = useState<CodeMapLayout>('layers');
  const [canvasMode, setCanvasMode] = useState<'smart' | 'all'>('smart');
  const [edgeFilter, setEdgeFilter] = useState<'all' | GraphRefType>('all');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [expandedPackages, setExpandedPackages] = useState<Set<string>>(new Set());
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(new Set());
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [expandedRelations, setExpandedRelations] = useState<Set<string>>(new Set());
  const [revealAllKeys, setRevealAllKeys] = useState<Set<string>>(new Set());
  const [loadingBranches, setLoadingBranches] = useState<Set<string>>(new Set());
  const [cacheRevision, setCacheRevision] = useState(0);
  const [historyFile, setHistoryFile] = useState<string | null>(null);
  const [followLive, setFollowLive] = useState(false);
  const [agentFilter, setAgentFilter] = useState('all');
  const [pausedOperations, setPausedOperations] = useState<FileActivity[] | null>(null);
  const [pausedRecent, setPausedRecent] = useState<FileActivity[] | null>(null);
  const [agentTrailCount, setAgentTrailCount] = useState(0);
  const cache = useRef(new Map<string, CodeMapGraphResponse>());
  const pendingSelection = useRef<string | null>(null);
  const lastFollowedActivity = useRef<string | null>(null);
  const lastFitSignature = useRef('');
  const lastFlowStructuralKey = useRef('');
  const flowRebuildTimer = useRef<number | null>(null);
  const symbolResolveInflight = useRef(new Set<string>());
  // Selective store slice — bare useCodemapActivityStore() re-renders on every
  // method-stable set(); selectors keep App-style isolation for telemetry maps.
  const {
    history: activityHistory,
    pulses: activityPulses,
    activeOperationsMap,
    activityTotalCount,
    resolveActivitySymbol,
    getActivityForFile,
    sweepActivity,
  } = useCodemapActivityStore(
    useShallow((state) => ({
      history: state.history,
      pulses: state.pulses,
      activeOperationsMap: state.activeOperations,
      activityTotalCount: state.totalCount,
      resolveActivitySymbol: state.resolveActivitySymbol,
      getActivityForFile: state.getActivityForFile,
      sweepActivity: state._sweep,
    })),
  );
  const activeOperations = useMemo(
    () => [...activeOperationsMap.values()].flat(),
    [activeOperationsMap],
  );
  const pulseActivities = useMemo(
    () =>
      [...activityPulses.keys()]
        .map((filePath) => activityHistory.get(filePath)?.[0])
        .filter((activity): activity is FileActivity => Boolean(activity)),
    [activityHistory, activityPulses],
  );
  const recentActivities = useMemo(() => {
    const candidates: FileActivity[] = [];
    for (const history of activityHistory.values()) {
      // Each per-file history is newest-first. A single file cannot
      // contribute more than the global result size, so avoid sorting the
      // entire (potentially 100k-entry) telemetry archive on every event.
      candidates.push(...history.slice(0, 16));
    }
    return candidates.sort((left, right) => right.timestamp - left.timestamp).slice(0, 16);
  }, [activityHistory]);
  const allKnownAgents = useMemo(
    () => groupAgentPresences([...activeOperations, ...recentActivities]),
    [activeOperations, recentActivities],
  );
  const displayedActiveOperations = useMemo(() => {
    const source = pausedOperations ?? activeOperations;
    return agentFilter === 'all'
      ? source
      : source.filter((activity) => activityAgentKey(activity) === agentFilter);
  }, [activeOperations, agentFilter, pausedOperations]);
  const displayedRecentActivities = useMemo(() => {
    const source = pausedRecent ?? recentActivities;
    return agentFilter === 'all'
      ? source
      : source.filter((activity) => activityAgentKey(activity) === agentFilter);
  }, [agentFilter, pausedRecent, recentActivities]);
  // Defer telemetry-driven canvas work under React concurrent rendering so
  // selection / navigation stays snappy while agents spam tools.
  const deferredActiveOperations = useDeferredValue(displayedActiveOperations);
  const deferredRecentActivities = useDeferredValue(displayedRecentActivities);
  const deferredPulseActivities = useDeferredValue(pulseActivities);
  const agentPresences = useMemo(
    () => groupAgentPresences(displayedActiveOperations),
    [displayedActiveOperations],
  );
  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState<Node>([]);
  const [flowEdges, setFlowEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const { fitView } = useReactFlow();

  const fetchGraph = useCallback(
    async (targetScope: CodeMapScope, force = false): Promise<CodeMapGraphResponse> => {
      const key = scopeKey(targetScope);
      const existing = cache.current.get(key);
      if (existing && !force) {
        // LRU touch on hit so hot scopes survive eviction.
        touchClientGraphCache(cache.current, key, existing, MAX_CLIENT_GRAPH_CACHE);
        return existing;
      }
      // Same-origin fetch rides the HttpOnly ws_token cookie set by /ws-auth
      // (requestToken in http-server.ts reads the cookie for /api/*);
      // `credentials` is explicit to document the contract. A 401/403 means
      // no valid session — which is NOT a missing index — so surface a
      // truthful error instead of the misleading index guidance.
      const response = await fetch(scopeUrl(targetScope), { credentials: 'same-origin' });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error('Authentication required — open this dashboard from its token URL.');
        }
        const body = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }
      const nextGraph = (await response.json()) as CodeMapGraphResponse;
      touchClientGraphCache(cache.current, key, nextGraph, MAX_CLIENT_GRAPH_CACHE);
      setCacheRevision((revision) => revision + 1);
      return nextGraph;
    },
    [],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const indexGeneration = useCodemapIndexStore((state) => state.generation);
  const lastSeenIndexGeneration = useRef(0);
  const treeScrollRef = useRef<HTMLDivElement | null>(null);

  // Single load path for scope changes and index invalidation — avoids racing
  // two parallel fetches that both call setGraph when an index run finishes.
  useEffect(() => {
    let cancelled = false;
    const forceRefresh = indexGeneration > lastSeenIndexGeneration.current;
    if (forceRefresh) {
      lastSeenIndexGeneration.current = indexGeneration;
      cache.current.clear();
      setCacheRevision((revision) => revision + 1);
      setExpandedPackages(new Set());
      setExpandedDirectories(new Set());
      setExpandedFiles(new Set());
      setRevealAllKeys(new Set());
    }
    setLoading(true);
    setError(null);
    void fetchGraph(scope, forceRefresh)
      .then((nextGraph) => {
        if (cancelled) return;
        setGraph(nextGraph);
        if (!forceRefresh) {
          const requested = pendingSelection.current;
          pendingSelection.current = null;
          setSelectedId(
            requested && nextGraph.nodes.some((node) => node.id === requested) ? requested : null,
          );
        }
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setGraph(EMPTY_GRAPH);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentScopeKey, fetchGraph, indexGeneration, scope]);

  const navigate = useCallback(
    (nextScope: CodeMapScope, preferredSelection?: string): void => {
      pendingSelection.current = preferredSelection ?? null;
      if (scopeKey(nextScope) === currentScopeKey) {
        setSelectedId(preferredSelection ?? null);
        pendingSelection.current = null;
        return;
      }
      setScope(nextScope);
    },
    [currentScopeKey],
  );

  const ensureBranch = useCallback(
    async (targetScope: CodeMapScope): Promise<void> => {
      const key = scopeKey(targetScope);
      if (cache.current.has(key) || loadingBranches.has(key)) return;
      setLoadingBranches((current) => new Set(current).add(key));
      try {
        await fetchGraph(targetScope);
      } finally {
        setLoadingBranches((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [fetchGraph, loadingBranches],
  );

  useEffect(() => {
    let cancelled = false;
    let started = 0;
    for (const activity of activeOperations) {
      if (started >= MAX_SYMBOL_RESOLVE_INFLIGHT) break;
      if (activity.symbol || !activity.toolUseId || activity.filePath.startsWith('(')) continue;
      const filePath = activity.filePath;
      if (symbolResolveInflight.current.has(filePath)) continue;
      symbolResolveInflight.current.add(filePath);
      started += 1;
      void fetchGraph({ level: 'symbols', file: filePath })
        .then((symbolGraph) => {
          if (cancelled) return;
          const symbol = resolveSymbolForActivity(activity, symbolGraph.nodes);
          if (!symbol) return;
          resolveActivitySymbol(activity.toolUseId!, filePath, {
            id: symbol.id,
            name: symbol.label,
            ...(symbol.symbolKind ? { kind: symbol.symbolKind } : {}),
            ...(symbol.line ? { line: symbol.line } : {}),
          });
        })
        .catch(() => undefined)
        .finally(() => {
          symbolResolveInflight.current.delete(filePath);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [activeOperations, fetchGraph, resolveActivitySymbol]);

  const filteredGraph = useMemo<CodeMapGraphResponse>(
    () => ({
      nodes: graph.nodes,
      edges:
        edgeFilter === 'all'
          ? graph.edges
          : graph.edges.filter((edge) => edge.refType === edgeFilter),
    }),
    [graph, edgeFilter],
  );
  const selectedNode = graph.nodes.find((node) => node.id === selectedId);
  const canvasGraph = useMemo(
    () => smartCanvasGraph(filteredGraph, selectedId, canvasMode),
    [canvasMode, filteredGraph, selectedId],
  );
  const connected = useMemo(
    () => (selectedId ? connectedNodeIds(filteredGraph, selectedId) : new Set<string>()),
    [filteredGraph, selectedId],
  );
  const { incomingCounts, outgoingCounts } = useMemo(() => {
    const incoming = new Map<string, number>();
    const outgoing = new Map<string, number>();
    for (const edge of filteredGraph.edges) {
      outgoing.set(edge.source, (outgoing.get(edge.source) ?? 0) + 1);
      incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    }
    return { incomingCounts: incoming, outgoingCounts: outgoing };
  }, [filteredGraph]);
  const layoutFocusId = layout === 'orbit' ? (selectedId ?? undefined) : undefined;
  const positionedNodes = useMemo(
    () => layoutGraph(canvasGraph, layout, layoutFocusId),
    [canvasGraph, layout, layoutFocusId],
  );
  const fitSignature = useMemo(
    () =>
      [
        currentScopeKey,
        layout,
        layout === 'orbit' ? (selectedId ?? '') : '',
        hashGraphStructure(canvasGraph),
      ].join('\u001e'),
    [canvasGraph, currentScopeKey, layout, selectedId],
  );

  const handleSelectNode = useCallback((node: GraphNodeData): void => {
    setSelectedId(node.id);
    setExpandedRelations(new Set());
  }, []);
  const handleOpenNode = useCallback(
    (node: GraphNodeData): void => {
      if (node.kind === 'package')
        navigate({ level: 'files', package: node.package ?? node.label });
      if (node.kind === 'file' && node.file)
        navigate({ level: 'symbols', file: node.file, package: node.package });
    },
    [navigate],
  );

  const activityFlowKey = useMemo(
    () =>
      [
        activityFingerprint(deferredActiveOperations),
        activityFingerprint(deferredPulseActivities),
        activityFingerprint(deferredRecentActivities),
      ].join('\u001e'),
    [deferredActiveOperations, deferredPulseActivities, deferredRecentActivities],
  );

  const activeFileNorms = useMemo(() => {
    const norms = new Set<string>();
    for (const activity of displayedActiveOperations) {
      norms.add(normalizedPath(activity.filePath));
    }
    return norms;
  }, [displayedActiveOperations]);

  const activeSymbolIds = useMemo(() => {
    const ids = new Set<string>();
    for (const activity of displayedActiveOperations) {
      if (activity.symbol?.id) ids.add(activity.symbol.id);
    }
    return ids;
  }, [displayedActiveOperations]);

  useEffect(() => {
    const rebuildFlow = (): void => {
      const nodes = positionedNodes.map(({ node }) => node);
      const activeByNode = indexActivitiesByNode(nodes, deferredActiveOperations);
      const pulseByNode = indexActivitiesByNode(nodes, deferredPulseActivities);
      const activeNodeIds = new Set(activeByNode.keys());

      const nextFlowNodes = positionedNodes.map(({ node, position }) => {
        const matchingActive = activeByNode.get(node.id) ?? [];
        const pulse = matchingActive[0] ?? pulseByNode.get(node.id)?.[0];
        return {
          id: node.id,
          type: 'codemap',
          position,
          data: {
            graphNode: node,
            selected: node.id === selectedId,
            dimmed: Boolean(selectedId) && !connected.has(node.id),
            incoming: incomingCounts.get(node.id) ?? 0,
            outgoing: outgoingCounts.get(node.id) ?? 0,
            isActive: Boolean(pulse),
            ...(pulse ? { activityType: pulse.type } : {}),
            activeOperations: matchingActive,
            onSelect: handleSelectNode,
            onOpen: handleOpenNode,
            onShowHistory: setHistoryFile,
          } satisfies CodeMapNodeData,
        };
      });
      setFlowNodes((current) => preserveFlowNodes(current, nextFlowNodes));

      let animatedBudget = MAX_ANIMATED_EDGES;
      const codeEdges = canvasGraph.edges.map((edge, index) => {
        const focused =
          Boolean(selectedId) && (edge.source === selectedId || edge.target === selectedId);
        const live = activeNodeIds.has(edge.source) || activeNodeIds.has(edge.target);
        // Prefer animating focused live edges; otherwise spend a small budget.
        const animate = live && (focused || animatedBudget > 0);
        if (animate) animatedBudget -= 1;
        const color = EDGE_COLOR[edge.refType] ?? 'hsl(var(--muted-foreground))';
        // Dimmed edges use cheaper bezier; focused/live keep smoothstep readability.
        const edgeType = focused || live ? 'smoothstep' : 'default';
        return {
          id: `edge:${edge.source}:${edge.target}:${index}`,
          source: edge.source,
          target: edge.target,
          type: edgeType,
          animated: animate,
          label: focused
            ? `${edge.refType}${edge.weight > 1 ? ` ×${edge.weight}` : ''}`
            : undefined,
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
          style: {
            stroke: color,
            strokeWidth: live
              ? Math.min(2.5 + Math.log2(edge.weight + 1) * 0.65, 5)
              : focused
                ? Math.min(1.25 + Math.log2(edge.weight + 1) * 0.65, 4)
                : 1,
            opacity: live ? 1 : selectedId ? (focused ? 0.88 : 0.08) : 0.52,
          },
          labelStyle: {
            fontSize: 9,
            fontFamily: 'var(--font-mono)',
            fill: 'hsl(var(--muted-foreground))',
          },
          labelBgStyle: { fill: 'hsl(var(--card))', fillOpacity: 0.92 },
          labelBgPadding: [4, 2] as [number, number],
          zIndex: live ? 4 : focused ? 2 : 0,
          data: {
            renderKey: `${edge.refType}:${edge.weight}:${selectedId ? (focused ? 'focused' : 'dimmed') : 'idle'}:${live ? 'live' : 'still'}:${animate ? 'anim' : 'still'}:${edgeType}`,
          },
        } satisfies Edge;
      });

      const recentByAgent = new Map<string, FileActivity[]>();
      const liveAgentKeys = new Set(deferredActiveOperations.map(activityAgentKey));
      for (const activity of [...deferredRecentActivities].sort(
        (left, right) => left.timestamp - right.timestamp,
      )) {
        const key = activityAgentKey(activity);
        const list = recentByAgent.get(key);
        if (list) list.push(activity);
        else recentByAgent.set(key, [activity]);
      }
      // Prefer live agents, then newest, then cap — trails are visual sugar.
      const rankedAgents = [...recentByAgent.entries()]
        .map(([agentKey, activities]) => ({
          agentKey,
          activities,
          live: liveAgentKeys.has(agentKey),
          latest: activities[activities.length - 1]?.timestamp ?? 0,
        }))
        .sort((left, right) => Number(right.live) - Number(left.live) || right.latest - left.latest)
        .slice(0, MAX_TRAIL_AGENTS);

      const trailEdges: Edge[] = [];
      for (const { agentKey, activities, live: trailIsLive } of rankedAgents) {
        // Keep the newest hops only so long agent sessions don't spam edges.
        const recentSlice = activities.slice(-(MAX_TRAIL_HOPS + 1));
        const nodeTrail = recentSlice
          .map((activity) => ({
            activity,
            node: canvasGraph.nodes.find((node) => activityMatchesNode(activity, node)),
          }))
          .filter((entry): entry is { activity: FileActivity; node: GraphNodeData } =>
            Boolean(entry.node),
          )
          .filter((entry, index, all) => index === 0 || entry.node.id !== all[index - 1]?.node.id);
        const color = agentTrailColor(agentKey);
        for (let index = 1; index < nodeTrail.length; index++) {
          const previous = nodeTrail[index - 1]!;
          const current = nodeTrail[index]!;
          const animateTrail = trailIsLive && animatedBudget > 0;
          if (animateTrail) animatedBudget -= 1;
          trailEdges.push({
            id: `trail:${agentKey}:${previous.activity.timestamp}:${current.activity.timestamp}`,
            source: previous.node.id,
            target: current.node.id,
            type: 'smoothstep',
            animated: animateTrail,
            label:
              index === nodeTrail.length - 1
                ? `${agentInitials(current.activity.agentName ?? current.activity.agent ?? 'agent')} TRAIL`
                : undefined,
            markerEnd: { type: MarkerType.ArrowClosed, color, width: 13, height: 13 },
            style: { stroke: color, strokeWidth: 2.5, strokeDasharray: '7 5', opacity: 0.9 },
            labelStyle: { fontSize: 8, fontWeight: 700, fill: color },
            labelBgStyle: { fill: 'hsl(var(--card))', fillOpacity: 0.94 },
            labelBgPadding: [4, 2] as [number, number],
            zIndex: 6,
            data: {
              renderKey: `${color}:${index === nodeTrail.length - 1 ? 'label' : 'plain'}:${trailIsLive ? 'live' : 'still'}:${animateTrail ? 'anim' : 'still'}`,
            },
          });
        }
      }
      setAgentTrailCount(trailEdges.length);
      setFlowEdges((current) => preserveFlowEdges(current, [...codeEdges, ...trailEdges]));
    };

    const structuralKey = fitSignature;
    const structuralChanged = lastFlowStructuralKey.current !== structuralKey;
    lastFlowStructuralKey.current = structuralKey;

    if (flowRebuildTimer.current !== null) {
      window.clearTimeout(flowRebuildTimer.current);
      flowRebuildTimer.current = null;
    }

    if (structuralChanged) {
      rebuildFlow();
    } else {
      // Telemetry-only: coalesce rapid tool/watcher pulses.
      flowRebuildTimer.current = window.setTimeout(() => {
        flowRebuildTimer.current = null;
        rebuildFlow();
      }, FLOW_ACTIVITY_THROTTLE_MS);
    }

    let fitTimer: number | undefined;
    if (lastFitSignature.current !== fitSignature) {
      fitTimer = window.setTimeout(() => {
        lastFitSignature.current = fitSignature;
        // Dense canvases skip animated fit — less main-thread work mid-session.
        const duration = canvasGraph.nodes.length > 48 ? 0 : 240;
        void fitView({ padding: 0.2, duration, maxZoom: 1.25 });
      }, 20);
    }

    return () => {
      if (flowRebuildTimer.current !== null) {
        window.clearTimeout(flowRebuildTimer.current);
        flowRebuildTimer.current = null;
      }
      if (fitTimer !== undefined) window.clearTimeout(fitTimer);
    };
  }, [
    activityFlowKey,
    canvasGraph,
    selectedId,
    deferredActiveOperations,
    deferredRecentActivities,
    deferredPulseActivities,
    fitSignature,
    connected,
    fitView,
    handleOpenNode,
    handleSelectNode,
    incomingCounts,
    outgoingCounts,
    positionedNodes,
    setFlowEdges,
    setFlowNodes,
  ]);

  // Expire activity pulses without requiring another WebSocket event.
  useEffect(() => {
    const interval = window.setInterval(() => {
      sweepActivity();
    }, 2_000);
    return () => window.clearInterval(interval);
  }, [sweepActivity]);

  const rootGraph =
    cache.current.get('packages') ?? (scope.level === 'packages' ? graph : EMPTY_GRAPH);
  const packageGraph = useCallback(
    (packageName: string): CodeMapGraphResponse | undefined =>
      cache.current.get(scopeKey({ level: 'files', package: packageName })),
    [cacheRevision],
  );
  const graphForFile = useCallback(
    (filePath: string): CodeMapGraphResponse | undefined =>
      cache.current.get(scopeKey({ level: 'symbols', file: filePath })),
    [cacheRevision],
  );

  const locateActivity = useCallback(
    (activity: FileActivity): void => {
      let indexedFile = activity.filePath;
      let indexedPackage = packageForFile(activity.filePath);
      let fileId = `file:${activity.filePath}`;
      for (const cachedGraph of cache.current.values()) {
        const match = cachedGraph.nodes.find(
          (node) =>
            node.kind === 'file' && !node.external && sameFile(node.file, activity.filePath),
        );
        if (!match) continue;
        indexedFile = match.file ?? indexedFile;
        indexedPackage = match.package ?? indexedPackage;
        fileId = match.id;
        break;
      }
      if (activity.symbol) {
        navigate(
          { level: 'symbols', file: indexedFile, package: indexedPackage },
          activity.symbol.id,
        );
        return;
      }
      navigate({ level: 'files', package: indexedPackage }, fileId);
    },
    [navigate],
  );

  useEffect(() => {
    if (!followLive || pausedOperations) return;
    const latest = [...displayedActiveOperations]
      .filter((activity) => !activity.filePath.startsWith('('))
      .sort((left, right) => right.timestamp - left.timestamp)[0];
    if (!latest) return;
    const followKey = `${latest.id ?? latest.toolUseId}:${latest.filePath}:${latest.symbol?.id ?? 'file'}`;
    if (lastFollowedActivity.current === followKey) return;
    lastFollowedActivity.current = followKey;
    locateActivity(latest);
  }, [displayedActiveOperations, followLive, locateActivity, pausedOperations]);

  const toggleTelemetryPaused = useCallback((): void => {
    if (pausedOperations) {
      setPausedOperations(null);
      setPausedRecent(null);
      return;
    }
    setPausedOperations([...activeOperations]);
    setPausedRecent([...recentActivities]);
  }, [activeOperations, pausedOperations, recentActivities]);

  const togglePackage = useCallback(
    (node: GraphNodeData): void => {
      const packageName = node.package ?? node.label;
      const opening = !expandedPackages.has(packageName);
      setExpandedPackages((current) => {
        const next = new Set(current);
        opening ? next.add(packageName) : next.delete(packageName);
        return next;
      });
      if (opening) {
        void ensureBranch({ level: 'files', package: packageName })
          .then(() => {
            const branch = cache.current.get(scopeKey({ level: 'files', package: packageName }));
            const tree = branch ? buildDirectoryTree(branch.nodes) : undefined;
            if (tree?.directories.length === 1 && tree.directories[0]) {
              setExpandedDirectories((current) =>
                new Set(current).add(`${packageName}:${tree.directories[0]!.path}`),
              );
            }
          })
          .catch(() => undefined);
      }
    },
    [ensureBranch, expandedPackages],
  );

  const toggleFile = useCallback(
    (node: GraphNodeData): void => {
      if (!node.file) return;
      const opening = !expandedFiles.has(node.file);
      setExpandedFiles((current) => {
        const next = new Set(current);
        opening ? next.add(node.file!) : next.delete(node.file!);
        return next;
      });
      if (opening)
        void ensureBranch({ level: 'symbols', file: node.file, package: node.package }).catch(
          () => undefined,
        );
    },
    [ensureBranch, expandedFiles],
  );

  const toggleDirectory = useCallback((key: string): void => {
    setExpandedDirectories((current) => {
      const next = new Set(current);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }, []);

  const revealAllTree = useCallback((key: string): void => {
    setRevealAllKeys((current) => new Set(current).add(key));
  }, []);

  const selectFileFromTree = useCallback(
    (node: GraphNodeData): void => {
      navigate({ level: 'files', package: node.package ?? '(root)' }, node.id);
    },
    [navigate],
  );
  const selectSymbolFromTree = useCallback(
    (node: GraphNodeData): void => {
      if (node.file)
        navigate({ level: 'symbols', file: node.file, package: node.package }, node.id);
    },
    [navigate],
  );

  const searchResults = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return [];
    const unique = new Map<string, GraphNodeData>();
    for (const cachedGraph of cache.current.values()) {
      for (const node of cachedGraph.nodes) {
        const haystack =
          `${node.label} ${node.file ?? ''} ${node.signature ?? ''} ${node.package ?? ''}`.toLocaleLowerCase();
        if (haystack.includes(query)) unique.set(node.id, node);
      }
    }
    return [...unique.values()]
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label))
      .slice(0, 80);
  }, [search, cacheRevision]);

  const virtualizeSearch = searchResults.length > SEARCH_VIRTUALIZE_THRESHOLD;
  const searchVirtualizer = useVirtualizer({
    count: searchResults.length,
    getScrollElement: () => treeScrollRef.current,
    estimateSize: () => 40,
    overscan: 8,
    enabled: virtualizeSearch,
  });

  const selectSearchResult = useCallback(
    (node: GraphNodeData): void => {
      if (node.kind === 'package') navigate({ level: 'packages' }, node.id);
      else if (node.kind === 'file')
        navigate({ level: 'files', package: node.package ?? '(root)' }, node.id);
      else if (node.file)
        navigate({ level: 'symbols', file: node.file, package: node.package }, node.id);
    },
    [navigate],
  );

  const { incoming, outgoing } = useMemo(
    () => ({
      incoming: selectedNode ? relationItems(filteredGraph, selectedNode.id, 'incoming') : [],
      outgoing: selectedNode ? relationItems(filteredGraph, selectedNode.id, 'outgoing') : [],
    }),
    [filteredGraph, selectedNode],
  );
  const { edgeWeight, connectedNodeCount } = useMemo(() => {
    let totalWeight = 0;
    const nodeIds = new Set<string>();
    for (const edge of filteredGraph.edges) {
      totalWeight += edge.weight;
      nodeIds.add(edge.source);
      nodeIds.add(edge.target);
    }
    return { edgeWeight: totalWeight, connectedNodeCount: nodeIds.size };
  }, [filteredGraph]);
  const selectedActivities = selectedNode
    ? displayedActiveOperations.filter((activity) => activityMatchesNode(activity, selectedNode))
    : [];
  const fileHistory: FileActivity[] = historyFile ? getActivityForFile(historyFile) : [];

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <CodeMapHeader
        scope={scope}
        graph={graph}
        agentPresences={agentPresences}
        edgeWeight={edgeWeight}
        connectedNodeCount={connectedNodeCount}
        navigate={navigate}
      />

      <div className="flex min-h-0 flex-1">
        <CodeMapTreeSidebar
          rootGraph={rootGraph}
          search={search}
          searchInput={searchInput}
          searchResults={searchResults}
          virtualizeSearch={virtualizeSearch}
          searchVirtualizer={searchVirtualizer}
          treeScrollRef={treeScrollRef}
          selectedId={selectedId}
          expandedPackages={expandedPackages}
          expandedDirectories={expandedDirectories}
          expandedFiles={expandedFiles}
          loadingBranches={loadingBranches}
          activeFileNorms={activeFileNorms}
          activeSymbolIds={activeSymbolIds}
          revealAllKeys={revealAllKeys}
          packageGraph={packageGraph}
          graphForFile={graphForFile}
          navigate={navigate}
          togglePackage={togglePackage}
          toggleDirectory={toggleDirectory}
          toggleFile={toggleFile}
          revealAllTree={revealAllTree}
          selectFileFromTree={selectFileFromTree}
          selectSymbolFromTree={selectSymbolFromTree}
          selectSearchResult={selectSearchResult}
          handleOpenNode={handleOpenNode}
          onSearchInputChange={setSearchInput}
          onSearchChange={setSearch}
        />

        <main className="relative min-w-0 flex-1 bg-[radial-gradient(circle_at_50%_0%,hsl(var(--primary)/0.055),transparent_38%)]">
          <CodeMapCanvasToolbar
            layout={layout}
            canvasMode={canvasMode}
            edgeFilter={edgeFilter}
            canvasNodeCount={canvasGraph.nodes.length}
            graphNodeCount={graph.nodes.length}
            onLayoutChange={setLayout}
            onCanvasModeChange={setCanvasMode}
            onEdgeFilterChange={setEdgeFilter}
          />

          <LiveAgentsHud presences={agentPresences} onLocate={locateActivity} />
          <LiveControlBar
            paused={pausedOperations !== null}
            followLive={followLive}
            agentFilter={agentFilter}
            agents={allKnownAgents}
            onTogglePaused={toggleTelemetryPaused}
            onToggleFollow={() => {
              lastFollowedActivity.current = null;
              setFollowLive((current) => !current);
            }}
            onAgentFilter={(key) => {
              lastFollowedActivity.current = null;
              setAgentFilter(key);
            }}
          />

          <CodeMapCanvasSurface
            loading={loading}
            error={error}
            graph={graph}
            canvasNodeCount={canvasGraph.nodes.length}
            flowNodes={flowNodes}
            flowEdges={flowEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            agentTrailCount={agentTrailCount}
          />
        </main>

        <CodeMapRelationInspector
          selectedNode={selectedNode}
          incoming={incoming}
          outgoing={outgoing}
          filteredGraph={filteredGraph}
          expandedRelations={expandedRelations}
          activeOperations={displayedActiveOperations}
          recentActivities={displayedRecentActivities}
          activityTotalCount={activityTotalCount}
          selectedActivities={selectedActivities}
          onClearSelection={() => setSelectedId(null)}
          onOpenNode={handleOpenNode}
          onOpenActivity={setHistoryFile}
          onLocateActivity={locateActivity}
          onToggleRelation={(key) =>
            setExpandedRelations((current) => {
              const next = new Set(current);
              next.has(key) ? next.delete(key) : next.add(key);
              return next;
            })
          }
          onSelectNode={handleSelectNode}
        />
      </div>

      {historyFile && (
        <CodeMapActivityDrawer
          historyFile={historyFile}
          fileHistory={fileHistory}
          onClose={() => setHistoryFile(null)}
        />
      )}
    </div>
  );
}

export function CodeMap(): React.ReactElement {
  return (
    <ReactFlowProvider>
      <CodeMapInner />
    </ReactFlowProvider>
  );
}

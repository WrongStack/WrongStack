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
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  MarkerType,
  MiniMap,
  type Node,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import '@xyflow/react/dist/style.css';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Home,
  Layers,
  Loader2,
  Network,
  Orbit,
  Package,
  Radio,
  Search,
  Target,
  X,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { cn } from '@/lib/utils';
import {
  activityAgentKey,
  type FileActivity,
  groupAgentPresences,
  type LiveAgentPresence,
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
import { CodeMapActivityStreamPanel } from './CodeMapActivityStreamPanel';
import { CodeMapSelectedNodeSummary } from './CodeMapSelectedNodeSummary';
import {
  EMPTY_GRAPH,
  FLOW_ACTIVITY_THROTTLE_MS,
  MAX_ANIMATED_EDGES,
  MAX_CLIENT_GRAPH_CACHE,
  MAX_SYMBOL_RESOLVE_INFLIGHT,
  MAX_TRAIL_AGENTS,
  MAX_TRAIL_HOPS,
  MINIMAP_NODE_LIMIT,
  SEARCH_DEBOUNCE_MS,
  SEARCH_VIRTUALIZE_THRESHOLD,
} from './CodeMapConfig';
import { DirectoryBranch } from './CodeMapDirectoryTree';
import { preserveFlowEdges, preserveFlowNodes } from './CodeMapFlowState';
import { LiveAgentsHud, LiveControlBar, LiveOperationRow } from './CodeMapLiveOverlay';
import { RelationSection } from './CodeMapRelations';
import { CodeMapSearchResultRow } from './CodeMapSearchResults';
import {
  agentInitials,
  agentTrailColor,
  type CodeMapNodeData,
  EDGE_COLOR,
  NODE_STYLE,
  nodeTypes,
} from './CodeMapVisuals';
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
  relativeFilePath,
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
      const response = await fetch(scopeUrl(targetScope));
      if (!response.ok) {
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
      <header className="flex h-[62px] shrink-0 items-center gap-4 border-b bg-card px-4">
        <div className="flex min-w-[220px] items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center border border-primary bg-primary/10 text-primary">
            <Network className="h-4 w-4" />
          </span>
          <div>
            <h1 className="font-display text-sm font-semibold tracking-tight">Code Atlas</h1>
            <p className="text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
              Architecture intelligence
            </p>
          </div>
        </div>
        <nav
          className="flex min-w-0 flex-1 items-center gap-1 font-mono text-[10px]"
          aria-label="Code map breadcrumb"
        >
          {scope.level !== 'packages' && (
            <button
              type="button"
              className="mr-1 flex h-7 w-7 items-center justify-center border text-muted-foreground hover:bg-muted"
              onClick={() => {
                if (scope.level === 'symbols')
                  navigate({ level: 'files', package: scope.package ?? '(root)' });
                else navigate({ level: 'packages' });
              }}
              aria-label="Back"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            className="flex items-center gap-1.5 px-1.5 py-1 text-muted-foreground hover:text-foreground"
            onClick={() => navigate({ level: 'packages' })}
          >
            <Home className="h-3 w-3" /> workspace
          </button>
          {scope.level !== 'packages' && (
            <>
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
              <button
                type="button"
                className="max-w-[220px] truncate px-1.5 py-1 hover:text-primary"
                onClick={() => navigate({ level: 'files', package: scope.package ?? '(root)' })}
              >
                {scope.package ?? '(root)'}
              </button>
            </>
          )}
          {scope.level === 'symbols' && (
            <>
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
              <span className="truncate px-1.5 py-1 text-primary">
                {relativeFilePath({
                  id: '',
                  label: scope.file,
                  kind: 'file',
                  file: scope.file,
                  package: scope.package,
                })}
              </span>
            </>
          )}
        </nav>
        <div className="hidden items-center gap-5 xl:flex">
          <div
            className={cn(
              'flex h-8 items-center gap-2 border px-2.5',
              agentPresences.length > 0
                ? 'border-success/50 bg-success/10 text-success'
                : 'text-muted-foreground',
            )}
          >
            <Radio className={cn('h-3 w-3', agentPresences.length > 0 && 'animate-pulse')} />
            <div>
              <div className="font-mono text-[10px] font-bold">{agentPresences.length} LIVE</div>
              <div className="text-[7px] uppercase tracking-wider">agents</div>
            </div>
          </div>
          <div className="text-right">
            <div className="font-mono text-sm font-semibold">{graph.nodes.length}</div>
            <div className="text-[8px] uppercase tracking-wider text-muted-foreground">nodes</div>
          </div>
          <div className="text-right">
            <div className="font-mono text-sm font-semibold">{graph.edges.length}</div>
            <div className="text-[8px] uppercase tracking-wider text-muted-foreground">links</div>
          </div>
          <div className="text-right">
            <div className="font-mono text-sm font-semibold">{edgeWeight}</div>
            <div className="text-[8px] uppercase tracking-wider text-muted-foreground">
              references
            </div>
          </div>
          <div className="text-right">
            <div className="font-mono text-sm font-semibold">{connectedNodeCount}</div>
            <div className="text-[8px] uppercase tracking-wider text-muted-foreground">
              connected
            </div>
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[286px] shrink-0 flex-col border-r bg-card/70">
          <div className="border-b p-3">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-[10px] font-bold uppercase tracking-[0.18em]">Code tree</h2>
              <span className="font-mono text-[9px] text-muted-foreground">
                {rootGraph.nodes.length} roots
              </span>
            </div>
            <label className="flex h-8 items-center gap-2 border bg-background px-2 focus-within:border-primary">
              <Search className="h-3.5 w-3.5 text-muted-foreground" />
              <input
                className="min-w-0 flex-1 bg-transparent font-mono text-[10px] outline-none placeholder:text-muted-foreground"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="Find package, file, symbol…"
              />
              {searchInput && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchInput('');
                    setSearch('');
                  }}
                  aria-label="Clear search"
                >
                  <X className="h-3 w-3 text-muted-foreground" />
                </button>
              )}
            </label>
          </div>
          <div ref={treeScrollRef} className="min-h-0 flex-1 overflow-y-auto py-2">
            {search.trim() ? (
              <div>
                <div className="px-3 pb-2 text-[9px] text-muted-foreground">
                  {searchResults.length} loaded-map results
                </div>
                {searchResults.length === 0 ? (
                  <p className="px-3 py-8 text-center text-[10px] text-muted-foreground">
                    No match in loaded branches.
                    <br />
                    Expand a package to search its files.
                  </p>
                ) : virtualizeSearch ? (
                  <div
                    style={{
                      height: `${searchVirtualizer.getTotalSize()}px`,
                      width: '100%',
                      position: 'relative',
                    }}
                  >
                    {searchVirtualizer.getVirtualItems().map((virtualRow) => {
                      const node = searchResults[virtualRow.index];
                      if (!node) return null;
                      return (
                        <CodeMapSearchResultRow
                          key={node.id}
                          node={node}
                          onSelect={selectSearchResult}
                          virtual={{
                            index: virtualRow.index,
                            start: virtualRow.start,
                            measureElement: searchVirtualizer.measureElement,
                          }}
                        />
                      );
                    })}
                  </div>
                ) : (
                  searchResults.map((node) => (
                    <CodeMapSearchResultRow
                      key={node.id}
                      node={node}
                      onSelect={selectSearchResult}
                    />
                  ))
                )}
              </div>
            ) : (
              rootGraph.nodes.map((packageNode) => {
                const packageName = packageNode.package ?? packageNode.label;
                const expanded = expandedPackages.has(packageName);
                const branchKey = scopeKey({ level: 'files', package: packageName });
                const filesGraph = packageGraph(packageName);
                const tree = filesGraph ? buildDirectoryTree(filesGraph.nodes) : undefined;
                return (
                  <div key={packageNode.id}>
                    <div
                      className={cn(
                        'group flex h-8 items-center px-2 hover:bg-muted',
                        selectedId === packageNode.id && 'bg-primary/10 text-primary',
                      )}
                    >
                      <button
                        type="button"
                        className="flex h-6 w-5 items-center justify-center text-muted-foreground"
                        onClick={() => togglePackage(packageNode)}
                        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${packageName}`}
                      >
                        {loadingBranches.has(branchKey) ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : expanded ? (
                          <ChevronDown className="h-3 w-3" />
                        ) : (
                          <ChevronRight className="h-3 w-3" />
                        )}
                      </button>
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        onClick={() => navigate({ level: 'packages' }, packageNode.id)}
                        onDoubleClick={() => navigate({ level: 'files', package: packageName })}
                      >
                        <Package className="h-3.5 w-3.5 shrink-0 text-primary" />
                        <span className="truncate font-mono text-[10px] font-semibold">
                          {packageNode.label}
                        </span>
                        <span className="ml-auto text-[9px] text-muted-foreground">
                          {packageNode.fileCount ?? 0}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="ml-1 hidden h-5 w-5 items-center justify-center text-muted-foreground hover:text-foreground group-hover:flex"
                        onClick={() => navigate({ level: 'files', package: packageName })}
                        title="Open file map"
                        aria-label={`Open ${packageName} map`}
                      >
                        <ExternalLink className="h-3 w-3" />
                      </button>
                    </div>
                    {expanded && tree && (
                      <DirectoryBranch
                        directory={tree}
                        packageName={packageName}
                        depth={1}
                        expandedDirectories={expandedDirectories}
                        expandedFiles={expandedFiles}
                        loadingBranches={loadingBranches}
                        graphForFile={graphForFile}
                        onToggleDirectory={toggleDirectory}
                        onToggleFile={toggleFile}
                        onSelectFile={selectFileFromTree}
                        onOpenFile={handleOpenNode}
                        onSelectSymbol={selectSymbolFromTree}
                        selectedId={selectedId}
                        activeFileNorms={activeFileNorms}
                        activeSymbolIds={activeSymbolIds}
                        revealAllKeys={revealAllKeys}
                        onRevealAll={revealAllTree}
                      />
                    )}
                  </div>
                );
              })
            )}
          </div>
          <div className="border-t px-3 py-2 text-[9px] leading-relaxed text-muted-foreground">
            Click to focus · double-click to enter
            <br />
            Branches stay open while the map changes
          </div>
        </aside>

        <main className="relative min-w-0 flex-1 bg-[radial-gradient(circle_at_50%_0%,hsl(var(--primary)/0.055),transparent_38%)]">
          <div className="absolute left-3 right-3 top-3 z-10 flex items-center gap-2 pointer-events-none">
            <div className="pointer-events-auto flex border bg-card/95 shadow-md backdrop-blur">
              <button
                type="button"
                className={cn(
                  'flex h-8 items-center gap-1.5 border-r px-2.5 text-[9px] font-semibold uppercase tracking-wider',
                  layout === 'layers'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted',
                )}
                onClick={() => setLayout('layers')}
              >
                <Layers className="h-3 w-3" /> Layers
              </button>
              <button
                type="button"
                className={cn(
                  'flex h-8 items-center gap-1.5 px-2.5 text-[9px] font-semibold uppercase tracking-wider',
                  layout === 'orbit'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted',
                )}
                onClick={() => setLayout('orbit')}
              >
                <Orbit className="h-3 w-3" /> Relations
              </button>
            </div>
            <div className="pointer-events-auto flex border bg-card/95 shadow-md backdrop-blur">
              <button
                type="button"
                className={cn(
                  'h-8 border-r px-2.5 font-mono text-[9px] font-bold',
                  canvasMode === 'smart'
                    ? 'bg-success text-success-foreground'
                    : 'text-muted-foreground hover:bg-muted',
                )}
                onClick={() => setCanvasMode('smart')}
                title="Keep the full tree, show the strongest relations and selected neighbourhood"
              >
                SMART {canvasGraph.nodes.length}/{graph.nodes.length}
              </button>
              <button
                type="button"
                className={cn(
                  'h-8 px-2.5 font-mono text-[9px] font-bold',
                  canvasMode === 'all'
                    ? 'bg-foreground text-background'
                    : 'text-muted-foreground hover:bg-muted',
                )}
                onClick={() => setCanvasMode('all')}
                title="Render every node and relation in this scope"
              >
                ALL
              </button>
            </div>
            <div className="pointer-events-auto ml-auto flex max-w-[60%] overflow-x-auto border bg-card/95 shadow-md backdrop-blur">
              {(['all', 'import', 'call', 'type_ref', 'inherit', 'implement'] as const).map(
                (filter) => (
                  <button
                    type="button"
                    key={filter}
                    className={cn(
                      'h-8 whitespace-nowrap border-r px-2.5 font-mono text-[9px] last:border-r-0',
                      edgeFilter === filter
                        ? 'bg-foreground text-background'
                        : 'text-muted-foreground hover:bg-muted',
                    )}
                    onClick={() => setEdgeFilter(filter)}
                  >
                    {filter === 'all' ? 'ALL LINKS' : filter.replace('_', ' ').toUpperCase()}
                  </button>
                ),
              )}
            </div>
          </div>

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

          {loading && (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-background/75 backdrop-blur-sm">
              <Loader2 className="h-7 w-7 animate-spin text-primary" />
              <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                Mapping relationships
              </span>
            </div>
          )}
          {error && !loading && (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 p-8 text-center">
              <Network className="h-10 w-10 text-destructive" />
              <p className="font-mono text-sm text-destructive">{error}</p>
              <p className="max-w-md text-xs text-muted-foreground">
                The map needs a codebase index. Run{' '}
                <code className="border bg-muted px-1.5 py-0.5">codebase-index</code> once, then
                reopen this view.
              </p>
            </div>
          )}
          {!loading && !error && graph.nodes.length === 0 && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
              <Network className="h-8 w-8 opacity-40" />
              <p className="text-xs">No indexed nodes at this level.</p>
            </div>
          )}
          {!loading && !error && graph.nodes.length > 1 && graph.edges.length === 0 && (
            <div className="pointer-events-none absolute left-1/2 top-14 z-10 -translate-x-1/2 border border-warning/40 bg-warning/10 px-3 py-2 text-center shadow backdrop-blur">
              <div className="font-mono text-[9px] font-bold uppercase tracking-wider text-warning">
                No resolved relations in this scope
              </div>
              <div className="mt-0.5 text-[8px] text-muted-foreground">
                The upgraded index will rebuild and resolve call/import/type links automatically.
              </div>
            </div>
          )}
          {!error && graph.nodes.length > 0 && (
            <ReactFlow
              nodes={flowNodes}
              edges={flowEdges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              nodeTypes={nodeTypes}
              nodesConnectable={false}
              nodesDraggable={false}
              edgesFocusable={false}
              elementsSelectable={false}
              onlyRenderVisibleElements
              minZoom={0.08}
              maxZoom={2.2}
              proOptions={{ hideAttribution: true }}
            >
              <Background
                variant={BackgroundVariant.Dots}
                // Wider gap on dense canvases — fewer SVG dots to paint.
                gap={canvasGraph.nodes.length > 60 ? 32 : 22}
                size={1}
                color="hsl(var(--muted-foreground))"
                className="!opacity-25"
              />
              <Controls
                position="bottom-left"
                showInteractive={false}
                className="!border !border-border !bg-card !shadow-md [&>button]:!border-border [&>button]:!bg-card [&>button]:!fill-foreground"
              />
              {canvasGraph.nodes.length <= MINIMAP_NODE_LIMIT && (
                <MiniMap
                  position="bottom-right"
                  pannable
                  zoomable
                  className="!h-[112px] !w-[180px] !border !border-border !bg-card !shadow-md"
                  maskColor="hsl(var(--background) / 0.72)"
                  nodeColor={(node) => {
                    const kind = (node.data as CodeMapNodeData | undefined)?.graphNode.kind;
                    return kind === 'package'
                      ? 'hsl(var(--primary))'
                      : kind === 'file'
                        ? 'hsl(var(--info))'
                        : 'hsl(var(--success))';
                  }}
                />
              )}
            </ReactFlow>
          )}
          <div className="pointer-events-none absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-3 border bg-card/90 px-3 py-1.5 font-mono text-[8px] text-muted-foreground shadow backdrop-blur">
            {(Object.entries(EDGE_COLOR) as [GraphRefType, string][]).map(([kind, color]) => (
              <span key={kind} className="flex items-center gap-1">
                <span className="h-0.5 w-3" style={{ backgroundColor: color }} />
                {kind.replace('_', ' ')}
              </span>
            ))}
            <span className="flex items-center gap-1 text-primary" data-testid="agent-trail-count">
              <span className="w-4 border-t-2 border-dashed border-primary" />
              agent trail{agentTrailCount > 0 ? ` ×${agentTrailCount}` : ''}
            </span>
          </div>
        </main>

        <aside className="flex w-[326px] shrink-0 flex-col border-l bg-card/80">
          <div className="flex h-10 items-center justify-between border-b px-3">
            <h2 className="text-[10px] font-bold uppercase tracking-[0.18em]">
              Relation inspector
            </h2>
            {selectedNode && (
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => setSelectedId(null)}
                aria-label="Clear selection"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {!selectedNode ? (
            <CodeMapActivityStreamPanel
              activeOperations={displayedActiveOperations}
              recentActivities={displayedRecentActivities}
              activityTotalCount={activityTotalCount}
              onLocate={locateActivity}
            />
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <CodeMapSelectedNodeSummary
                node={selectedNode}
                incomingCount={incoming.length}
                outgoingCount={outgoing.length}
                onOpenNode={handleOpenNode}
                onOpenActivity={setHistoryFile}
              />
              {selectedActivities.length > 0 && (
                <section className="border-b bg-success/5 py-2">
                  <div className="mb-1 flex items-center gap-2 px-3">
                    <Radio className="h-3 w-3 animate-pulse text-success" />
                    <h3 className="text-[9px] font-bold uppercase tracking-[0.16em]">
                      Agents on this node
                    </h3>
                    <span className="ml-auto font-mono text-[9px] text-success">
                      {selectedActivities.length}
                    </span>
                  </div>
                  {selectedActivities.map((activity) => (
                    <LiveOperationRow
                      key={activity.id ?? `${activity.toolUseId}:${activity.filePath}`}
                      activity={activity}
                      onLocate={locateActivity}
                      showAgent
                    />
                  ))}
                </section>
              )}
              <RelationSection
                title="Incoming"
                subtitle="Who depends on this"
                items={incoming}
                graph={filteredGraph}
                selectedId={selectedNode.id}
                expanded={expandedRelations}
                onToggle={(key) =>
                  setExpandedRelations((current) => {
                    const next = new Set(current);
                    next.has(key) ? next.delete(key) : next.add(key);
                    return next;
                  })
                }
                onSelect={handleSelectNode}
              />
              <RelationSection
                title="Outgoing"
                subtitle="What this depends on"
                items={outgoing}
                graph={filteredGraph}
                selectedId={selectedNode.id}
                expanded={expandedRelations}
                onToggle={(key) =>
                  setExpandedRelations((current) => {
                    const next = new Set(current);
                    next.has(key) ? next.delete(key) : next.add(key);
                    return next;
                  })
                }
                onSelect={handleSelectNode}
              />
            </div>
          )}
        </aside>
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

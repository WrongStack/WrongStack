/**
 * Code Atlas — persistent code tree, dependency canvas, and relation inspector.
 *
 * The explorer never disappears while the user moves package → file → symbol.
 * A graph click opens packages/files; the relation action focuses relationships.
 *
 * Performance notes:
 * - Activity store is subscribed via selectors (not the whole store).
 * - React Flow rebuilds are immediate for structural changes and throttled for
 *   telemetry-only updates (see FLOW_ACTIVITY_THROTTLE_MS).
 * - SMART mode caps canvas nodes; MiniMap is gated by node count.
 */
import {
  type Edge,
  type Node,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';
import type { FileActivity } from './codemap-activity-store';
import { useCodeMapFlow } from './use-code-map-flow.js';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSurfaceHost } from '../host';
import { useAppTranslation } from '../lib/i18n';
import { AtlasViewTabs } from './AtlasViewTabs';
import type { AtlasContext } from './atlas-host';
import { CodeMapActivityDrawer } from './CodeMapActivityDrawer';
import {
  activityFingerprint,
  activityMatchesNode,
  packageForFile,
  sameFile,
} from './CodeMapActivityHelpers';
import { CodeMapCanvasSurface } from './CodeMapCanvasSurface';
import { CodeMapCanvasToolbar } from './CodeMapCanvasToolbar';
import { SEARCH_DEBOUNCE_MS } from './CodeMapConfig';
import { CodeMapHeader } from './CodeMapHeader';
import { LiveAgentsHud, LiveControlBar } from './CodeMapLiveOverlay';
import { CodeMapRelationInspector } from './CodeMapRelationInspector';
import { CodeMapTreeSidebar } from './CodeMapTreeSidebar';
import type { CodeMapNodeData } from './CodeMapVisuals';
import {
  type CodeMapLayout,
  type CodeMapScope,
  type GraphNodeData,
  type GraphRefType,
  normalizedPath,
  relativeFilePath,
  type ShortestPathResult,
  scopeKey,
} from './codemap-model';
import { useCodeMapActivity } from './use-code-map-activity.js';
import { useCodeMapGraphLoader } from './use-code-map-graph-loader.js';
import { useCodeMapGraphView } from './use-code-map-graph-view.js';
import { useCodeMapTree } from './use-code-map-tree.js';

function CodeMapInner(): React.ReactElement {
  const [scope, setScope] = useState<CodeMapScope>({ level: 'packages' });
  const currentScopeKey = scopeKey(scope);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [layout, setLayout] = useState<CodeMapLayout>('layers');
  const [canvasMode, setCanvasMode] = useState<'smart' | 'all'>('smart');
  const [edgeFilter, setEdgeFilter] = useState<'all' | GraphRefType>('all');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [expandedRelations, setExpandedRelations] = useState<Set<string>>(new Set());
  const [collapsedClusters, setCollapsedClusters] = useState<Set<string>>(new Set());
  const [blastOverlayMode, setBlastOverlayMode] = useState(false);
  const [highlightedPath, setHighlightedPath] = useState<ShortestPathResult | null>(null);
  const [historyFile, setHistoryFile] = useState<string | null>(null);
  const [followLive, setFollowLive] = useState(false);
  const [agentTrailCount, setAgentTrailCount] = useState(0);
  const atlas = useSurfaceHost().atlas;
  const views = atlas?.views ?? [];
  const [viewId, setViewId] = useState('map');
  const activeView = views.find((view) => view.id === viewId);
  const pendingSelection = useRef<string | null>(null);
  const lastFollowedActivity = useRef<string | null>(null);
  const lastFitSignature = useRef('');
  const lastFlowStructuralKey = useRef('');
  const flowRebuildTimer = useRef<number | null>(null);
  const {
    agentFilter,
    setAgentFilter,
    pausedOperations,
    setPausedOperations,
    setPausedRecent,
    activityTotalCount,
    resolveActivitySymbol,
    getActivityForFile,
    sweepActivity,
    activeOperations,
    recentActivities,
    allKnownAgents,
    displayedActiveOperations,
    displayedRecentActivities,
    deferredActiveOperations,
    deferredRecentActivities,
    deferredPulseActivities,
    agentPresences,
  } = useCodeMapActivity();
  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState<Node>([]);
  const [flowEdges, setFlowEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const { fitView } = useReactFlow();

  const { t } = useAppTranslation();
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchInput]);
  const treeScrollRef = useRef<HTMLDivElement | null>(null);

  const {
    graph,
    loading,
    error,
    retry,
    loadingBranches,
    cacheRevision,
    cache,
    ensureBranch,
    rootGraph,
    packageGraph,
    graphForFile,
  } = useCodeMapGraphLoader({
    scope,
    currentScopeKey,
    t,
    pendingSelection,
    setSelectedId,
    activeOperations,
    resolveActivitySymbol,
  });

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
  const {
    filteredGraph,
    selectedNode,
    canvasGraph,
    connected,
    incomingCounts,
    outgoingCounts,
    positionedNodes,
    fitSignature,
    incoming,
    outgoing,
    edgeWeight,
    connectedNodeCount,
  } = useCodeMapGraphView({
    graph,
    edgeFilter,
    selectedId,
    canvasMode,
    layout,
    currentScopeKey,
    collapsedClusters,
  });

  const handleSelectNode = useCallback((node: GraphNodeData): void => {
    setSelectedId(node.id);
    setExpandedRelations(new Set());
  }, []);
  const handleFocusNode = useCallback(
    (node: GraphNodeData): void => {
      void fitView({ nodes: [{ id: node.id }], duration: 240, padding: 0.45, maxZoom: 1.15 });
    },
    [fitView],
  );
  const handleOpenNode = useCallback(
    (node: GraphNodeData): void => {
      if (node.id.startsWith('cluster-container:')) {
        const clusterName = node.id.slice('cluster-container:'.length);
        setCollapsedClusters((prev) => {
          const next = new Set(prev);
          next.delete(clusterName);
          return next;
        });
        return;
      }
      if (node.kind === 'package')
        navigate({ level: 'files', package: node.package ?? node.label });
      if (node.kind === 'file' && node.file)
        navigate({ level: 'symbols', file: node.file, package: node.package });
    },
    [navigate],
  );
  const handleFlowCanvasNodeClick = useCallback(
    (_event: React.MouseEvent, flowNode: Node): void => {
      const nodeData = flowNode.data as CodeMapNodeData | undefined;
      if (!nodeData?.graphNode) return;
      const canOpen =
        nodeData.graphNode.kind === 'package' ||
        (nodeData.graphNode.kind === 'file' && Boolean(nodeData.graphNode.file));
      if (canOpen) {
        handleOpenNode(nodeData.graphNode);
      } else {
        handleSelectNode(nodeData.graphNode);
      }
    },
    [handleOpenNode, handleSelectNode],
  );

  const atlasContext = useMemo<AtlasContext>(() => {
    const byId = (id: string) => graph.nodes.find((node) => node.id === id);
    return {
      scope,
      graph: filteredGraph,
      selectedId,
      select: (id) => {
        const node = byId(id);
        if (node) handleSelectNode(node);
      },
      open: (id) => {
        const node = byId(id);
        if (!node) return;
        if (node.kind === 'package' || (node.kind === 'file' && node.file)) handleOpenNode(node);
        else handleSelectNode(node);
      },
    };
  }, [scope, graph, filteredGraph, selectedId, handleSelectNode, handleOpenNode]);
  const HeaderActions = atlas?.HeaderActions;
  const NodeExtras = atlas?.NodeExtras;
  const CodeAssist = atlas?.CodeAssist;

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

  useCodeMapFlow({
    positionedNodes,
    deferredActiveOperations,
    deferredPulseActivities,
    selectedId,
    connected,
    incomingCounts,
    outgoingCounts,
    handleSelectNode,
    handleOpenNode,
    setHistoryFile,
    setFlowNodes,
    canvasGraph,
    deferredRecentActivities,
    setAgentTrailCount,
    setFlowEdges,
    fitSignature,
    lastFlowStructuralKey,
    flowRebuildTimer,
    lastFitSignature,
    fitView,
    activityFlowKey,
    highlightedPath,
    blastOverlayMode,
  });

  // Expire activity pulses without requiring another WebSocket event.
  useEffect(() => {
    const interval = window.setInterval(() => {
      sweepActivity();
    }, 2_000);
    return () => window.clearInterval(interval);
  }, [sweepActivity]);

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
  const {
    expandedPackages,
    expandedDirectories,
    expandedFiles,
    revealAllKeys,
    togglePackage,
    toggleFile,
    toggleDirectory,
    revealAllTree,
    selectFileFromTree,
    selectSymbolFromTree,
    searchResults,
    virtualizeSearch,
    searchVirtualizer,
    selectSearchResult,
  } = useCodeMapTree({ cache, cacheRevision, ensureBranch, navigate, search, treeScrollRef });

  const selectedActivities = selectedNode
    ? displayedActiveOperations.filter((activity) => activityMatchesNode(activity, selectedNode))
    : [];
  const fileHistory: FileActivity[] = historyFile ? getActivityForFile(historyFile) : [];

  const canvas = (
    <>
      <CodeMapCanvasToolbar
        layout={layout}
        canvasMode={canvasMode}
        edgeFilter={edgeFilter}
        canvasNodeCount={canvasGraph.nodes.length}
        graphNodeCount={graph.nodes.length}
        blastOverlayMode={blastOverlayMode}
        onLayoutChange={setLayout}
        onCanvasModeChange={setCanvasMode}
        onEdgeFilterChange={setEdgeFilter}
        onToggleBlastOverlay={() => setBlastOverlayMode((prev) => !prev)}
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
        onNodeClick={handleFlowCanvasNodeClick}
        agentTrailCount={agentTrailCount}
      />
    </>
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <CodeMapHeader
        scope={scope}
        graph={graph}
        agentPresences={agentPresences}
        edgeWeight={edgeWeight}
        connectedNodeCount={connectedNodeCount}
        navigate={navigate}
        actions={HeaderActions ? <HeaderActions context={atlasContext} /> : null}
      />

      <div className="ws-code-map-layout flex min-h-0 flex-1">
        <CodeMapTreeSidebar
          rootGraph={rootGraph}
          loading={loading}
          error={error}
          onRetry={retry}
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

        <main className="ws-code-canvas relative min-w-0 flex-1 bg-[radial-gradient(circle_at_50%_0%,hsl(var(--primary)/0.055),transparent_38%)]">
          {views.length === 0 ? (
            canvas
          ) : (
            <div className="absolute inset-0 flex flex-col">
              <AtlasViewTabs views={views} active={activeView?.id ?? 'map'} onChange={setViewId} />
              <div className="relative min-h-0 flex-1">
                {activeView ? (
                  <div className="absolute inset-0 overflow-auto">
                    {activeView.render(atlasContext)}
                  </div>
                ) : (
                  canvas
                )}
              </div>
            </div>
          )}
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
          onFocusNode={handleFocusNode}
          onHighlightPath={setHighlightedPath}
          layout={layout}
          collapsedClusters={collapsedClusters}
          onToggleCluster={(clusterName) =>
            setCollapsedClusters((current) => {
              const next = new Set(current);
              next.has(clusterName) ? next.delete(clusterName) : next.add(clusterName);
              return next;
            })
          }
          extras={
            NodeExtras && selectedNode ? (
              <NodeExtras node={selectedNode} context={atlasContext} />
            ) : null
          }
          footer={
            CodeAssist && (
              <CodeAssist
                target={
                  selectedNode && selectedNode.kind !== 'package'
                    ? {
                        filePath: relativeFilePath(selectedNode),
                        // A symbol node is the whole point of Code Atlas:
                        // anchoring to it is what makes "explain this" precise.
                        ...(selectedNode.kind === 'symbol' ? { symbol: selectedNode.label } : {}),
                        ...(selectedNode.line !== undefined ? { line: selectedNode.line } : {}),
                      }
                    : null
                }
                className="max-h-[55%] shrink-0"
              />
            )
          }
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

import { useMemo } from 'react';
import { hashGraphStructure } from './CodeMapActivityHelpers';
import {
  type CodeMapGraphResponse,
  type CodeMapLayout,
  collapseGraphClusters,
  connectedNodeIds,
  type GraphNodeData,
  type GraphRefType,
  layoutGraph,
  relationItems,
  smartCanvasGraph,
} from './codemap-model';

export interface CodeMapGraphView {
  filteredGraph: CodeMapGraphResponse;
  selectedNode: GraphNodeData | undefined;
  canvasGraph: CodeMapGraphResponse;
  connected: Set<string>;
  incomingCounts: Map<string, number>;
  outgoingCounts: Map<string, number>;
  positionedNodes: ReturnType<typeof layoutGraph>;
  fitSignature: string;
  incoming: ReturnType<typeof relationItems>;
  outgoing: ReturnType<typeof relationItems>;
  edgeWeight: number;
  connectedNodeCount: number;
}

/**
 * Pure projections of the loaded graph for Code Atlas: edge filtering, the
 * SMART canvas subset, selection neighbourhood, per-node edge counts, layout
 * positions + fit signature, and the inspector's relation lists and totals.
 */
export function useCodeMapGraphView({
  graph,
  edgeFilter,
  selectedId,
  canvasMode,
  layout,
  currentScopeKey,
  collapsedClusters,
}: {
  graph: CodeMapGraphResponse;
  edgeFilter: 'all' | GraphRefType;
  selectedId: string | null;
  canvasMode: 'smart' | 'all';
  layout: CodeMapLayout;
  currentScopeKey: string;
  collapsedClusters?: ReadonlySet<string> | undefined;
}): CodeMapGraphView {
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
  const canvasGraph = useMemo(() => {
    const base =
      layout === 'subsystems' && collapsedClusters && collapsedClusters.size > 0
        ? collapseGraphClusters(filteredGraph, collapsedClusters)
        : filteredGraph;
    return smartCanvasGraph(base, selectedId, canvasMode);
  }, [canvasMode, collapsedClusters, filteredGraph, layout, selectedId]);
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
  return {
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
  };
}

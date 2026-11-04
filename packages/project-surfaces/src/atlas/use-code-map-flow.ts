import { type Edge, MarkerType } from '@xyflow/react';

import { useEffect } from 'react';

import '@xyflow/react/dist/style.css';

import { scaledPx } from '../lib/fonts';
import { activityMatchesNode, indexActivitiesByNode } from './CodeMapActivityHelpers';
import {
  FLOW_ACTIVITY_THROTTLE_MS,
  MAX_ANIMATED_EDGES,
  MAX_TRAIL_AGENTS,
  MAX_TRAIL_HOPS,
} from './CodeMapConfig';
import { preserveFlowEdges, preserveFlowNodes } from './CodeMapFlowState';
import { agentInitials, agentTrailColor, type CodeMapNodeData, EDGE_COLOR } from './CodeMapVisuals';
import { activityAgentKey, type FileActivity } from './codemap-activity-store';

import {
  computeBlastRadiusOverlay,
  type GraphNodeData,
  type ShortestPathResult,
} from './codemap-model';
export function useCodeMapFlow({
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
}: {
  positionedNodes: ReturnType<typeof import('./codemap-model.js').layoutGraph>;
  deferredActiveOperations: import('./codemap-activity-store.js').FileActivity[];
  deferredPulseActivities: import('./codemap-activity-store.js').FileActivity[];
  selectedId: string | null;
  connected: Set<string>;
  incomingCounts: Map<string, number>;
  outgoingCounts: Map<string, number>;
  handleSelectNode: (node: import('./codemap-model.js').GraphNodeData) => void;
  handleOpenNode: (node: import('./codemap-model.js').GraphNodeData) => void;
  setHistoryFile: React.Dispatch<React.SetStateAction<string | null>>;
  setFlowNodes: React.Dispatch<React.SetStateAction<import('@xyflow/react').Node[]>>;
  canvasGraph: import('./codemap-model.js').CodeMapGraphResponse;
  deferredRecentActivities: import('./codemap-activity-store.js').FileActivity[];
  setAgentTrailCount: React.Dispatch<React.SetStateAction<number>>;
  setFlowEdges: React.Dispatch<React.SetStateAction<import('@xyflow/react').Edge[]>>;
  fitSignature: string;
  lastFlowStructuralKey: React.RefObject<string>;
  flowRebuildTimer: React.RefObject<number | null>;
  lastFitSignature: React.RefObject<string>;
  fitView: import('@xyflow/react').FitView<import('@xyflow/react').Node>;
  activityFlowKey: string;
  highlightedPath?: ShortestPathResult | null | undefined;
  blastOverlayMode?: boolean | undefined;
}) {
  useEffect(() => {
    const rebuildFlow = (): void => {
      const nodes = positionedNodes.map(({ node }) => node);
      const activeByNode = indexActivitiesByNode(nodes, deferredActiveOperations);
      const pulseByNode = indexActivitiesByNode(nodes, deferredPulseActivities);
      const activeNodeIds = new Set(activeByNode.keys());
      const blastSeeds = new Set<string>();
      if (selectedId) blastSeeds.add(selectedId);
      if (blastOverlayMode) {
        const writeOps = [...deferredActiveOperations, ...deferredRecentActivities].filter(
          (a) => a.type === 'write' || a.type === 'edit' || a.type === 'delete',
        );
        for (const node of nodes) {
          if (writeOps.some((a) => activityMatchesNode(a, node))) {
            blastSeeds.add(node.id);
          }
        }
        if (blastSeeds.size === 0 && nodes.length > 0) {
          const newest = [...nodes]
            .filter((n) => typeof n.lastModifiedMs === 'number')
            .sort((a, b) => (b.lastModifiedMs ?? 0) - (a.lastModifiedMs ?? 0))[0];
          if (newest) blastSeeds.add(newest.id);
        }
      }
      const blastOverlay =
        blastSeeds.size > 0 ? computeBlastRadiusOverlay(canvasGraph, blastSeeds) : null;
      const pathEdgeKeys = new Set<string>();
      if (highlightedPath) {
        for (const e of highlightedPath.edges) {
          pathEdgeKeys.add(`${e.source}->${e.target}`);
          if (!highlightedPath.directed) {
            pathEdgeKeys.add(`${e.target}->${e.source}`);
          }
        }
      }

      const nextFlowNodes = positionedNodes.map(({ node, position }) => {
        const matchingActive = activeByNode.get(node.id) ?? [];
        const pulse = matchingActive[0] ?? pulseByNode.get(node.id)?.[0];
        const blastHop: 0 | 1 | 2 | undefined = blastOverlay?.direct.has(node.id)
          ? 0
          : blastOverlay?.firstHop.has(node.id)
            ? 1
            : blastOverlay?.secondHop.has(node.id)
              ? 2
              : undefined;
        return {
          id: node.id,
          type: 'codemap',
          position,
          style: { pointerEvents: 'all' as const },
          data: {
            graphNode: node,
            selected: node.id === selectedId,
            dimmed:
              (Boolean(selectedId) || Boolean(blastOverlay && blastOverlay.allImpacted.size > 0)) &&
              !connected.has(node.id) &&
              !blastOverlay?.allImpacted.has(node.id) &&
              !highlightedPath?.nodeIds.has(node.id),
            ...(blastHop !== undefined ? { blastHop } : {}),
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
        const onPath = pathEdgeKeys.has(`${edge.source}->${edge.target}`);
        const focused =
          onPath ||
          (Boolean(selectedId) && (edge.source === selectedId || edge.target === selectedId));
        const live = activeNodeIds.has(edge.source) || activeNodeIds.has(edge.target);
        // Prefer animating focused live edges or active shortest path; otherwise spend a small budget.
        const animate = onPath || (live && (focused || animatedBudget > 0));
        if (animate && !onPath) animatedBudget -= 1;
        const color = onPath
          ? 'hsl(var(--primary))'
          : (EDGE_COLOR[edge.refType] ?? 'hsl(var(--muted-foreground))');
        // Dimmed edges use cheaper bezier; focused/live keep smoothstep readability.
        const edgeType = focused || live ? 'smoothstep' : 'default';
        return {
          id: `edge:${edge.source}:${edge.target}:${index}`,
          source: edge.source,
          target: edge.target,
          type: edgeType,
          animated: animate,
          label: onPath
            ? `PATH · ${edge.refType}`
            : focused
              ? `${edge.refType}${edge.weight > 1 ? ` ×${edge.weight}` : ''}`
              : undefined,
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
          style: {
            stroke: color,
            strokeWidth: onPath
              ? 3.2
              : live
                ? Math.min(2.5 + Math.log2(edge.weight + 1) * 0.65, 5)
                : focused
                  ? Math.min(1.25 + Math.log2(edge.weight + 1) * 0.65, 4)
                  : 1,
            opacity: onPath ? 1 : live ? 1 : selectedId ? (focused ? 0.88 : 0.08) : 0.52,
          },
          labelStyle: {
            fontSize: scaledPx(9),
            fontFamily: 'var(--font-mono)',
            fill: 'hsl(var(--muted-foreground))',
          },
          labelBgStyle: { fill: 'hsl(var(--card))', fillOpacity: 0.92 },
          labelBgPadding: [4, 2] as [number, number],
          zIndex: onPath ? 5 : live ? 4 : focused ? 2 : 0,
          data: {
            renderKey: `${edge.refType}:${edge.weight}:${onPath ? 'path' : selectedId ? (focused ? 'focused' : 'dimmed') : 'idle'}:${live ? 'live' : 'still'}:${animate ? 'anim' : 'still'}:${edgeType}`,
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
            labelStyle: { fontSize: scaledPx(8), fontWeight: 700, fill: color },
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

    const pathKey = highlightedPath ? highlightedPath.nodes.map((n) => n.id).join('>') : '';
    const structuralKey = `${fitSignature}|${pathKey}|${blastOverlayMode ? 'blast' : ''}`;
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
    blastOverlayMode,
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
    highlightedPath,
    incomingCounts,
    outgoingCounts,
    positionedNodes,
    setFlowEdges,
    setFlowNodes,
  ]);
}

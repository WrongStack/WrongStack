'use client';

/**
 * The fleet as a live graph: machine → project → terminal → agent, laid out
 * in columns by the shared topology layout. Wires into working agents
 * animate. Once the operator drags a node the layout stops re-flowing on every
 * snapshot (node data still refreshes); "Auto arrange" hands control back.
 */
import { useHqLocalPrefs } from '@hq/data/local-prefs';
import { layoutFleetTopology } from '@hq/domain/fleet-topology';
import type { FleetTopology, FleetTopologyNode } from '@hq/domain/fleet-topology-types';
import { activityTone } from '@hq/domain/status-tone';
import { resolveTheme } from '@hq/lib/theme';
import {
  Background,
  Controls,
  type Edge,
  Handle,
  MarkerType,
  MiniMap,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';
import { Bot, FolderGit2, LayoutGrid, MonitorSmartphone, SquareTerminal } from 'lucide-react';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef } from 'react';
import { cn } from '@/lib/cn';
import { TONE_DOT } from './fleet-list';
import { consoleHref, isLiveStatus } from './model';

const NODE_WIDTH = 236;
const NODE_HEIGHT = 92;

type FleetNode = Node<FleetTopologyNode, 'fleet'>;

const KIND_ICON = {
  machine: MonitorSmartphone,
  project: FolderGit2,
  terminal: SquareTerminal,
  agent: Bot,
} as const;

function FleetNodeCard({ data, selected }: NodeProps<FleetNode>): ReactNode {
  const Icon = KIND_ICON[data.kind];
  const openable = consoleHref(data) !== null;
  const tool = data.agent?.currentTool;
  return (
    <div
      data-kind={data.kind}
      className={cn(
        'flex h-full flex-col justify-center gap-1 border bg-card px-3.5 py-2.5 shadow-sm',
        selected ? 'border-primary' : 'border-border',
        openable && 'cursor-pointer hover:border-foreground/40',
        data.retained === true && 'border-dashed opacity-60',
      )}
    >
      <Handle type="target" position={Position.Left} className="!size-2 !border-0 !bg-border" />
      <div className="flex items-center gap-2">
        {data.kind === 'agent' || data.kind === 'terminal' ? (
          <span
            aria-hidden
            className={cn(
              'size-2 shrink-0',
              TONE_DOT[activityTone(data.status)],
              isLiveStatus(data.status) && 'animate-pulse',
            )}
          />
        ) : null}
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{data.label}</span>
      </div>
      {(data.sub !== undefined || tool !== undefined) && (
        <p className="truncate text-xs text-muted-foreground">
          {tool !== undefined && isLiveStatus(data.status) ? tool : data.sub}
        </p>
      )}
      <Handle type="source" position={Position.Right} className="!size-2 !border-0 !bg-border" />
    </div>
  );
}

const NODE_TYPES = { fleet: FleetNodeCard };

function layoutNodes(topology: FleetTopology, selectedId: string | null): FleetNode[] {
  const positions = layoutFleetTopology(topology.nodes);
  return topology.nodes.map((node) => ({
    id: node.id,
    type: 'fleet' as const,
    data: node,
    position: positions.get(node.id) ?? { x: 0, y: 0 },
    selected: node.id === selectedId,
    style: { width: NODE_WIDTH, height: NODE_HEIGHT },
  }));
}

function buildEdges(topology: FleetTopology): Edge[] {
  const status = new Map(topology.nodes.map((node) => [node.id, node.status]));
  return topology.edges.map((edge) => ({
    ...edge,
    type: 'smoothstep',
    animated: isLiveStatus(status.get(edge.target)),
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
  }));
}

function Graph({
  topology,
  selectedId,
  onSelect,
}: {
  topology: FleetTopology;
  selectedId: string | null;
  onSelect: (node: FleetTopologyNode) => void;
}): ReactNode {
  const [nodes, setNodes, onNodesChange] = useNodesState<FleetNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const { fitView } = useReactFlow();
  const theme = resolveTheme(useHqLocalPrefs().appearance.theme);
  const userArranged = useRef(false);

  useEffect(() => {
    const laid = layoutNodes(topology, selectedId);
    setNodes((previous) => {
      if (!userArranged.current) return laid;
      const kept = new Map(previous.map((node) => [node.id, node.position]));
      return laid.map((node) => ({ ...node, position: kept.get(node.id) ?? node.position }));
    });
    setEdges(buildEdges(topology));
  }, [topology, selectedId, setNodes, setEdges]);

  const autoArrange = useCallback(() => {
    userArranged.current = false;
    setNodes(layoutNodes(topology, selectedId));
    window.setTimeout(() => void fitView({ padding: 0.15, minZoom: 0.8, duration: 400 }), 50);
  }, [topology, selectedId, setNodes, fitView]);

  return (
    <div className="relative h-full min-h-0">
      <button
        type="button"
        onClick={autoArrange}
        title="Re-run the layout and frame the whole fleet"
        className="absolute left-4 top-4 z-10 inline-flex h-9 items-center gap-2 border border-border bg-card px-3 text-sm shadow-sm hover:bg-muted"
      >
        <LayoutGrid className="size-4" />
        Auto arrange
      </button>
      <ReactFlow
        colorMode={theme}
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={() => {
          userArranged.current = true;
        }}
        onNodeClick={(_, node) => {
          if (consoleHref(node.data) !== null) onSelect(node.data);
        }}
        fitView
        // Never open zoomed out past reading size; pan or zoom out for the rest.
        fitViewOptions={{ padding: 0.15, minZoom: 0.8 }}
        minZoom={0.25}
        maxZoom={1.5}
        nodesConnectable={false}
      >
        <Background color="hsl(var(--border))" gap={24} />
        <MiniMap
          pannable
          zoomable
          nodeColor={(node) => {
            const kind = (node.data as FleetTopologyNode | undefined)?.kind;
            if (kind === 'machine') return 'hsl(var(--primary))';
            if (kind === 'project') return 'hsl(var(--brand-orange))';
            if (kind === 'terminal') return 'hsl(var(--muted-foreground))';
            return 'hsl(var(--success))';
          }}
        />
        <Controls />
      </ReactFlow>
    </div>
  );
}

export function FleetGraph(props: {
  topology: FleetTopology;
  selectedId: string | null;
  onSelect: (node: FleetTopologyNode) => void;
}): ReactNode {
  return (
    <ReactFlowProvider>
      <Graph {...props} />
    </ReactFlowProvider>
  );
}

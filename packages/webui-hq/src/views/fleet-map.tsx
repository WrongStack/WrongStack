import type { NodeProps } from '@xyflow/react';
import {
  Background,
  Controls,
  type Edge,
  Handle,
  MarkerType,
  MiniMap,
  type Node,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';
import {
  Bot,
  FolderGit2,
  GitBranch,
  LayoutGrid,
  MonitorSmartphone,
  SquareTerminal,
} from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useHqStore } from '../store.js';
import { chatTargetFromNode, FleetChatDrawer, type FleetChatTarget } from './fleet-chat-drawer.js';
import {
  buildFleetTopology,
  type FleetTopology,
  type FleetTopologyNode,
  layoutFleetTopology,
} from './fleet-topology.js';

const NODE_WIDTH = 220;
const NODE_HEIGHT = 104;

function kindIcon(kind: FleetTopologyNode['kind'], clientKind?: string): React.ReactNode {
  if (kind === 'machine') return <MonitorSmartphone size={14} className="hq-fleet-node-icon" />;
  if (kind === 'project') return <FolderGit2 size={14} className="hq-fleet-node-icon" />;
  if (kind === 'terminal') return <SquareTerminal size={14} className="hq-fleet-node-icon" />;
  return <Bot size={14} className={`hq-fleet-agent-dot ${clientKind ?? 'idle'}`} />;
}

function statusClass(status: string | undefined): string {
  if (status === undefined) return 'idle';
  if (status === 'active' || status === 'running' || status === 'streaming') return 'active';
  if (status === 'waiting_user') return 'warn';
  if (status === 'error' || status === 'stale' || status === 'closing') return 'error';
  return status;
}

function isLiveStatus(status: string | undefined): boolean {
  return status === 'active' || status === 'running' || status === 'streaming';
}

function FleetFlowNode({
  data,
  selected,
}: NodeProps<Node<FleetTopologyNode, 'fleet'>>): React.ReactElement {
  const clickable = data.kind === 'terminal' || data.kind === 'agent';
  return (
    <div
      className={`hq-flow-node ${data.kind}${selected ? ' selected' : ''}${clickable ? ' clickable' : ''}`}
    >
      <Handle type="target" position={Position.Left} className="hq-flow-handle" />
      <div className="hq-flow-title">
        {data.kind === 'agent' ? (
          <span className={`hq-flow-dot ${statusClass(data.status)}`} />
        ) : (
          kindIcon(data.kind, data.clientKind)
        )}
        <span className="hq-flow-label">{data.label}</span>
      </div>
      {data.sub !== undefined && <div className="hq-flow-sub">{data.sub}</div>}
      <div className="hq-flow-chips">
        {data.chips.slice(0, 4).map((chip) => (
          <span key={chip} className={`hq-pill ${statusClass(chip)}`}>
            {chip}
          </span>
        ))}
      </div>
      <Handle type="source" position={Position.Right} className="hq-flow-handle" />
    </div>
  );
}

const nodeTypes = { fleet: FleetFlowNode };

/** Materialize the pure hierarchical layout into React Flow nodes. */
function layoutNodes(nodes: FleetTopologyNode[]): Node<FleetTopologyNode, 'fleet'>[] {
  const positions = layoutFleetTopology(nodes);
  return nodes.map((node) => ({
    id: node.id,
    type: 'fleet' as const,
    data: node,
    position: positions.get(node.id) ?? { x: 0, y: 0 },
    style: { width: NODE_WIDTH, minHeight: NODE_HEIGHT },
  }));
}

/** Edges styled from live node status — active agents get animated wires. */
function buildEdges(topology: FleetTopology): Edge[] {
  const statusById = new Map(topology.nodes.map((n) => [n.id, n.status]));
  return topology.edges.map((edge) => {
    const live = isLiveStatus(statusById.get(edge.target));
    return {
      ...edge,
      type: 'smoothstep',
      animated: live,
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
      className: `hq-flow-edge${live ? ' live' : ''}`,
    };
  });
}

function FleetFlow({ topology }: { topology: FleetTopology }): React.ReactElement {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<FleetTopologyNode, 'fleet'>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const { fitView } = useReactFlow();
  // Once the user drags a node we stop re-laying-out on every snapshot poll
  // (which would fight their arrangement) and only refresh node DATA in
  // place; the Auto-arrange button re-applies the layout and re-enables
  // live tidy mode.
  const userArrangedRef = useRef(false);

  useEffect(() => {
    const laid = layoutNodes(topology.nodes);
    setNodes((prev) => {
      if (!userArrangedRef.current) return laid;
      const prevPos = new Map(prev.map((n) => [n.id, n.position]));
      return laid.map((n) => {
        const kept = prevPos.get(n.id);
        return kept !== undefined ? { ...n, position: kept } : n;
      });
    });
    setEdges(buildEdges(topology));
  }, [topology, setNodes, setEdges]);

  const autoArrange = useCallback(() => {
    userArrangedRef.current = false;
    setNodes(layoutNodes(topology.nodes));
    // Let the new positions commit before framing them.
    window.setTimeout(() => void fitView({ padding: 0.18, duration: 400 }), 50);
  }, [topology, setNodes, fitView]);

  // Instant chat: clicking a terminal/agent opens the transcript drawer
  // right over the map. The global selection is synced too, so the drawer's
  // "Console" button (and the Console tab itself) land on the same
  // conversation.
  const [chatTarget, setChatTarget] = useState<FleetChatTarget | null>(null);
  const closeChat = useCallback(() => setChatTarget(null), []);

  return (
    <div className="hq-flow-canvas" data-testid="hq-react-flow-fleet">
      <button
        type="button"
        className="hq-btn secondary hq-flow-arrange"
        onClick={autoArrange}
        title="Re-run the hierarchical layout and frame the whole fleet"
      >
        <LayoutGrid size={13} /> Auto arrange
      </button>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={() => {
          userArrangedRef.current = true;
        }}
        fitView
        fitViewOptions={{ padding: 0.18 }}
        minZoom={0.25}
        maxZoom={1.4}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable
        onNodeClick={(_, node) => {
          const target = chatTargetFromNode(node.data);
          if (target === null) return;
          if (target.agentId !== null)
            useHqStore.getState().selectAgent(target.sessionId, target.agentId);
          else useHqStore.getState().selectSession(target.sessionId);
          setChatTarget(target);
        }}
      >
        <Background color="rgba(245, 242, 233, 0.12)" gap={22} />
        <MiniMap
          pannable
          zoomable
          className="hq-flow-minimap"
          nodeColor={(node) => {
            const kind = (node.data as FleetTopologyNode | undefined)?.kind;
            if (kind === 'machine') return '#fe2e5f';
            if (kind === 'project') return '#fd9f02';
            if (kind === 'terminal') return '#f5f2e9';
            return '#22c77a';
          }}
        />
        <Controls className="hq-flow-controls" />
      </ReactFlow>
      {chatTarget !== null && <FleetChatDrawer target={chatTarget} onClose={closeChat} />}
    </div>
  );
}

export function FleetMapView(): React.ReactElement {
  const snap = useHqStore((state) => state.snapshot);
  const topology = useMemo(() => buildFleetTopology(snap), [snap]);

  if (snap === null) {
    return <div className="hq-empty">Waiting for fleet data…</div>;
  }

  if (topology.nodes.length === 0) {
    return (
      <div className="hq-empty">
        No machines or connected clients yet. Open a WrongStack CLI/TUI/WebUI with HQ running and
        they appear here automatically.
      </div>
    );
  }

  const machines =
    snap.machines?.length ?? new Set(topology.nodes.map((n) => n.machineId).filter(Boolean)).size;
  const terminals = topology.nodes.filter((n) => n.kind === 'terminal').length;
  const agents = topology.nodes.filter((n) => n.kind === 'agent').length;
  const liveAgents = topology.nodes.filter(
    (n) => n.kind === 'agent' && isLiveStatus(n.status),
  ).length;

  return (
    <div className="hq-flow-shell">
      <div className="hq-flow-toolbar">
        <div>
          <div className="hq-card-title hq-title-inline">
            Fleet Topology
          </div>
          <div className="hq-row-subtle">
            machine → project → terminal/TUI/CLI/WebUI → agent; click a terminal or agent for chat
            history
          </div>
        </div>
        <div className="hq-flow-stats">
          <span className="hq-pill info">{machines} machines</span>
          <span className="hq-pill info">{terminals} terminals</span>
          <span className={`hq-pill ${liveAgents > 0 ? 'active' : 'info'}`}>
            {liveAgents > 0 ? `${liveAgents}/${agents} agents live` : `${agents} agents`}
          </span>
        </div>
      </div>
      <ReactFlowProvider>
        <FleetFlow topology={topology} />
      </ReactFlowProvider>
      <div className="hq-flow-legend">
        <span>
          <MonitorSmartphone size={12} /> machine
        </span>
        <span>
          <FolderGit2 size={12} /> project
        </span>
        <span>
          <SquareTerminal size={12} /> terminal / TUI / CLI / WebUI
        </span>
        <span>
          <GitBranch size={12} /> branch shown as chip when known
        </span>
        <span>
          <Bot size={12} /> agent
        </span>
      </div>
    </div>
  );
}

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
  ListTree,
  MonitorSmartphone,
  Network,
  Search,
  SquareTerminal,
} from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useHqStore } from '../store.js';
import { setHqFleetPrefs, useHqLocalPrefs } from '../stores/hq-local-prefs.js';
import { chatTargetFromNode, FleetChatDrawer, type FleetChatTarget } from './fleet-chat-drawer.js';
import {
  buildFleetTopology,
  type FleetTopology,
  type FleetTopologyNode,
  type FleetTopologyScope,
  filterFleetTopology,
  filterFleetTopologyByQuery,
  fleetColumnFor,
  layoutFleetTopology,
  orderFleetTopologyNodes,
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
  const clickable =
    (data.kind === 'terminal' || data.kind === 'agent') &&
    data.serviceMode === undefined &&
    data.isSyntheticSession !== true;
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
          if (node.data.serviceMode !== undefined || node.data.isSyntheticSession === true) return;
          const target = chatTargetFromNode(node.data);
          if (target === null) return;
          if (target.agentId !== null)
            useHqStore.getState().selectAgent(target.sessionId, target.agentId);
          else useHqStore.getState().selectSession(target.sessionId);
          if (node.data.clientId !== undefined) {
            useHqStore.getState().selectClient(node.data.clientId);
          }
          setChatTarget(target);
        }}
      >
        <Background color="var(--flow-grid)" gap={22} />
        <MiniMap
          pannable
          zoomable
          className="hq-flow-minimap"
          nodeColor={(node) => {
            const kind = (node.data as FleetTopologyNode | undefined)?.kind;
            if (kind === 'machine') return 'var(--primary)';
            if (kind === 'project') return 'var(--amber)';
            if (kind === 'terminal') return 'var(--text)';
            return 'var(--green)';
          }}
        />
        <Controls className="hq-flow-controls" />
      </ReactFlow>
      {chatTarget !== null && <FleetChatDrawer target={chatTarget} onClose={closeChat} />}
    </div>
  );
}

function FleetCompactList({ topology }: { topology: FleetTopology }): React.ReactElement {
  const nodes = useMemo(() => orderFleetTopologyNodes(topology), [topology]);

  const openConsole = (node: FleetTopologyNode): void => {
    if (node.serviceMode !== undefined || node.sessionId === undefined) return;
    if (node.agentId !== undefined) {
      useHqStore.getState().selectAgent(node.sessionId, node.agentId);
    } else {
      useHqStore.getState().selectSession(node.sessionId);
    }
    const clientId = node.clientId ?? node.session?.clientId;
    if (clientId !== undefined) useHqStore.getState().selectClient(clientId);
    useHqStore.getState().setActiveView('console');
  };

  return (
    <table className="hq-fleet-list" aria-label="Fleet clients and agents">
      <thead>
        <tr className="hq-fleet-list-header">
          <th scope="col">Fleet member</th>
          <th scope="col">Context</th>
          <th scope="col">Status</th>
          <th scope="col">Details</th>
        </tr>
      </thead>
      <tbody className="hq-fleet-list-body">
        {nodes.length === 0 ? (
          <tr>
            <td colSpan={4} className="hq-empty hq-fleet-list-empty">
              No fleet entries match this search.
            </td>
          </tr>
        ) : (
          nodes.map((node) => {
            const clickable =
              (node.kind === 'terminal' || node.kind === 'agent') &&
              node.serviceMode === undefined &&
              node.isSyntheticSession !== true;
            const activate = (): void => openConsole(node);
            const handleKeyDown = (event: React.KeyboardEvent<HTMLTableRowElement>): void => {
              if (!clickable || (event.key !== 'Enter' && event.key !== ' ')) return;
              event.preventDefault();
              activate();
            };
            return (
              <tr
                key={node.id}
                className={`hq-fleet-list-row ${node.kind}${clickable ? ' clickable' : ''}`}
                tabIndex={clickable ? 0 : undefined}
                onClick={clickable ? activate : undefined}
                onKeyDown={clickable ? handleKeyDown : undefined}
              >
                <td
                  className="hq-fleet-list-member"
                  style={{ paddingLeft: `${10 + fleetColumnFor(node.kind) * 22}px` }}
                >
                  {kindIcon(node.kind, node.clientKind)}
                  <span>
                    <strong>{node.label}</strong>
                    <small>{node.kind.replace('-', ' ')}</small>
                  </span>
                </td>
                <td className="hq-fleet-list-context" title={node.sub}>
                  {node.sub ?? '—'}
                </td>
                <td>
                  <span className={`hq-pill ${statusClass(node.status)}`}>
                    {node.status ?? (node.kind === 'machine' ? 'connected' : 'ready')}
                  </span>
                </td>
                <td className="hq-fleet-list-chips">
                  {node.chips.slice(0, 5).map((chip) => (
                    <span key={chip} className={`hq-pill ${statusClass(chip)}`}>
                      {chip}
                    </span>
                  ))}
                </td>
              </tr>
            );
          })
        )}
      </tbody>
    </table>
  );
}

export function FleetMapView(): React.ReactElement {
  const snap = useHqStore((state) => state.snapshot);
  const fullTopology = useMemo(() => buildFleetTopology(snap), [snap]);
  const fleetPrefs = useHqLocalPrefs().fleet;
  const scope: FleetTopologyScope = fleetPrefs.scope;
  const layout = fleetPrefs.layout;
  const [query, setQuery] = useState('');
  const scopeId = scope === 'machine' ? fleetPrefs.machineId : fleetPrefs.projectId;
  const machineOptions = useMemo(
    () =>
      fullTopology.nodes
        .filter((node) => node.kind === 'machine' && node.machineId !== undefined)
        .map((node) => ({ id: node.machineId!, label: node.label })),
    [fullTopology],
  );
  const projectOptions = useMemo(
    () => {
      const unique = new Map<string, string>();
      for (const node of fullTopology.nodes) {
        if (node.kind === 'project' && node.projectId !== undefined) {
          unique.set(node.projectId, node.label);
        }
      }
      return [...unique].map(([id, label]) => ({ id, label })).sort((left, right) =>
        left.label.localeCompare(right.label),
      );
    },
    [fullTopology],
  );
  const options = scope === 'machine' ? machineOptions : projectOptions;
  const effectiveScopeId =
    scope === 'all'
      ? undefined
      : options.some((option) => option.id === scopeId)
        ? scopeId
        : options[0]?.id;
  const scopedTopology = useMemo(
    () => filterFleetTopology(fullTopology, scope, effectiveScopeId),
    [effectiveScopeId, fullTopology, scope],
  );
  const topology = useMemo(
    () => filterFleetTopologyByQuery(scopedTopology, query),
    [query, scopedTopology],
  );

  if (snap === null) {
    return <div className="hq-empty">Waiting for fleet data…</div>;
  }

  if (fullTopology.nodes.length === 0) {
    return (
      <div className="hq-empty">
        No machines or connected clients yet. Open a WrongStack CLI/TUI/WebUI with HQ running and
        they appear here automatically.
      </div>
    );
  }

  const machines = new Set(topology.nodes.map((n) => n.machineId).filter(Boolean)).size;
  const terminals = topology.nodes.filter((n) => n.kind === 'terminal').length;
  const agents = topology.nodes.filter((n) => n.kind === 'agent').length;
  const liveAgents = topology.nodes.filter(
    (n) => n.kind === 'agent' && isLiveStatus(n.status),
  ).length;
  const mailboxServeCount = topology.nodes.filter(
    (node) => node.serviceMode === 'mailbox-serve',
  ).length;

  const chooseScope = (next: FleetTopologyScope): void => {
    setHqFleetPrefs({ scope: next });
  };

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
          <span className={`hq-pill ${mailboxServeCount > 0 ? 'active' : 'idle'}`}>
            {mailboxServeCount} mailbox serve
          </span>
        </div>
        <div className="hq-flow-scope">
          <fieldset
            className="hq-flow-scope-buttons"
            aria-label="Fleet view scope"
            style={{ border: 0, margin: 0, padding: 0 }}
          >
            {(['all', 'machine', 'project'] as const).map((candidate) => (
              <button
                key={candidate}
                type="button"
                className={'hq-btn secondary' + (scope === candidate ? ' active' : '')}
                aria-pressed={scope === candidate}
                onClick={() => chooseScope(candidate)}
              >
                {candidate === 'all'
                  ? 'Full fleet'
                  : candidate === 'machine'
                    ? 'By machine'
                    : 'By project'}
              </button>
            ))}
          </fieldset>
          {scope !== 'all' && (
            <select
              className="hq-select hq-flow-scope-select"
              aria-label={scope === 'machine' ? 'Select machine' : 'Select project'}
              value={effectiveScopeId ?? ''}
              onChange={(event) =>
                setHqFleetPrefs(
                  scope === 'machine'
                    ? { machineId: event.target.value }
                    : { projectId: event.target.value },
                )
              }
            >
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
          <span className="hq-flow-toolbar-spacer" />
          <fieldset
            className="hq-flow-layout"
            aria-label="Fleet layout"
            style={{ border: 0, margin: 0, padding: 0 }}
          >
            <button
              type="button"
              className={'hq-btn secondary' + (layout === 'map' ? ' active' : '')}
              aria-pressed={layout === 'map'}
              onClick={() => setHqFleetPrefs({ layout: 'map' })}
            >
              <Network size={13} /> Map
            </button>
            <button
              type="button"
              className={'hq-btn secondary' + (layout === 'compact' ? ' active' : '')}
              aria-pressed={layout === 'compact'}
              onClick={() => setHqFleetPrefs({ layout: 'compact' })}
            >
              <ListTree size={13} /> Compact list
            </button>
          </fieldset>
          <label className="hq-flow-search">
            <Search size={13} />
            <input
              className="hq-input"
              type="search"
              aria-label="Search fleet"
              placeholder="Search machine, project, client, agent…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>
      </div>
      {topology.nodes.length === 0 ? (
        <div className="hq-empty hq-fleet-list-empty">No fleet entries match this search.</div>
      ) : layout === 'map' ? (
        <ReactFlowProvider>
          <FleetFlow topology={topology} />
        </ReactFlowProvider>
      ) : (
        <FleetCompactList topology={topology} />
      )}
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

/**
 * Fleet Map — machine → project → terminal → agent as a live graph.
 *
 * Two presentations of the same filtered topology: a React Flow canvas, and a
 * compact table for narrow screens or keyboard-first work. Both read the same
 * pure `buildFleetTopology` / `filterFleetTopology*` model, so they can never
 * disagree about what the fleet contains.
 */
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
  X,
} from 'lucide-react';
import type * as React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EmptyState, StatTile, StatusDot } from '../../components/hq/primitives.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Input, Select } from '../../components/ui/input.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { setHqFleetPrefs, useHqLocalPrefs } from '../../data/local-prefs.js';
import { useHqStore } from '../../data/store/index.js';
import { chatTargetFromNode, type FleetChatTarget } from '../../domain/fleet-chat-target.js';
import {
  buildFleetTopology,
  filterFleetTopology,
  filterFleetTopologyByQuery,
  type FleetTopology,
  type FleetTopologyNode,
  type FleetTopologyScope,
  fleetColumnFor,
  layoutFleetTopology,
  orderFleetTopologyNodes,
} from '../../domain/fleet-topology.js';
import { activityTone } from '../../domain/status-tone.js';
import { resolveTheme } from '../../lib/theme.js';
import { cn } from '../../lib/utils.js';
import { FleetChatDrawer } from './chat-drawer.js';

const NODE_WIDTH = 220;
const NODE_HEIGHT = 104;
const MAX_NODE_CHIPS = 4;
const MAX_ROW_CHIPS = 5;
/** Indent per topology column in the compact table, in pixels. */
const COMPACT_INDENT = 22;

function isLive(status: string | undefined): boolean {
  return status === 'active' || status === 'running' || status === 'streaming';
}

/** A node is clickable when it has a transcript to show. */
function isInspectable(node: FleetTopologyNode): boolean {
  return (
    (node.kind === 'terminal' || node.kind === 'agent') &&
    node.serviceMode === undefined &&
    node.isSyntheticSession !== true
  );
}

function KindIcon({
  kind,
  className,
}: {
  kind: FleetTopologyNode['kind'];
  className?: string;
}): React.ReactElement {
  const shared = cn('size-3.5 shrink-0 text-muted-foreground', className);
  if (kind === 'machine') return <MonitorSmartphone className={shared} />;
  if (kind === 'project') return <FolderGit2 className={shared} />;
  if (kind === 'terminal') return <SquareTerminal className={shared} />;
  return <Bot className={shared} />;
}

function FleetFlowNode({
  data,
  selected,
}: NodeProps<Node<FleetTopologyNode, 'fleet'>>): React.ReactElement {
  const clickable = isInspectable(data);
  return (
    <div
      data-testid="fleet-node"
      data-kind={data.kind}
      className={cn(
        'flex h-full flex-col gap-1 border bg-card p-2',
        selected ? 'border-primary' : 'border-border',
        clickable && 'cursor-pointer hover:bg-muted/50',
      )}
    >
      <Handle type="target" position={Position.Left} className="!size-1.5 !border-0 !bg-border" />
      <div className="flex items-center gap-1.5">
        {data.kind === 'agent' ? (
          <StatusDot tone={activityTone(data.status)} pulse={isLive(data.status)} />
        ) : (
          <KindIcon kind={data.kind} />
        )}
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{data.label}</span>
      </div>
      {data.sub !== undefined && (
        <div className="truncate font-mono text-[10px] text-muted-foreground">{data.sub}</div>
      )}
      <div className="mt-auto flex flex-wrap gap-1">
        {data.chips.slice(0, MAX_NODE_CHIPS).map((chip) => (
          <Badge key={chip} tone={activityTone(chip)}>
            {chip}
          </Badge>
        ))}
      </div>
      <Handle type="source" position={Position.Right} className="!size-1.5 !border-0 !bg-border" />
    </div>
  );
}

const nodeTypes = { fleet: FleetFlowNode };

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

/** Wires to a live agent animate; everything else stays still. */
function buildEdges(topology: FleetTopology): Edge[] {
  const statusById = new Map(topology.nodes.map((node) => [node.id, node.status]));
  return topology.edges.map((edge) => ({
    ...edge,
    type: 'smoothstep',
    animated: isLive(statusById.get(edge.target)),
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
  }));
}

function FleetFlow({ topology }: { topology: FleetTopology }): React.ReactElement {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<FleetTopologyNode, 'fleet'>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const { fitView } = useReactFlow();
  const theme = resolveTheme(useHqLocalPrefs().appearance.theme);
  const [chatTarget, setChatTarget] = useState<FleetChatTarget | null>(null);

  /**
   * Once the operator drags a node we stop re-laying out on every snapshot —
   * otherwise the poll would fight their arrangement every few seconds. Node
   * DATA still refreshes in place; "Auto arrange" re-applies the layout and
   * re-enables live tidying.
   */
  const userArranged = useRef(false);

  useEffect(() => {
    const laid = layoutNodes(topology.nodes);
    setNodes((previous) => {
      if (!userArranged.current) return laid;
      const keptPositions = new Map(previous.map((node) => [node.id, node.position]));
      return laid.map((node) => {
        const kept = keptPositions.get(node.id);
        return kept !== undefined ? { ...node, position: kept } : node;
      });
    });
    setEdges(buildEdges(topology));
  }, [topology, setNodes, setEdges]);

  const autoArrange = useCallback(() => {
    userArranged.current = false;
    setNodes(layoutNodes(topology.nodes));
    // Let the new positions commit before framing them.
    window.setTimeout(() => void fitView({ padding: 0.18, duration: 400 }), 50);
  }, [topology, setNodes, fitView]);

  return (
    <div data-testid="hq-react-flow-fleet" className="relative min-h-0 flex-1">
      <Button
        variant="outline"
        size="sm"
        onClick={autoArrange}
        title="Re-run the hierarchical layout and frame the whole fleet"
        className="absolute left-3 top-3 z-10"
      >
        <LayoutGrid />
        Auto arrange
      </Button>

      <ReactFlow
        // React Flow paints its own chrome (minimap, controls) and defaults to
        // light; without this the minimap is a white slab on the dark canvas.
        colorMode={theme}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={() => {
          userArranged.current = true;
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
          // Sync global selection too, so the drawer's Console button and the
          // Console tab land on the same conversation.
          if (target.agentId !== null) {
            useHqStore.getState().selectAgent(target.sessionId, target.agentId);
          } else {
            useHqStore.getState().selectSession(target.sessionId);
          }
          if (node.data.clientId !== undefined) {
            useHqStore.getState().selectClient(node.data.clientId);
          }
          setChatTarget(target);
        }}
      >
        <Background color="hsl(var(--border))" gap={22} />
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

      {chatTarget !== null && (
        <FleetChatDrawer target={chatTarget} onClose={() => setChatTarget(null)} />
      )}
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

  if (nodes.length === 0) {
    return <EmptyState title="No fleet entries match this search" className="m-4" />;
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <Table aria-label="Fleet clients and agents">
        <TableHeader>
          <TableRow>
            <TableHead>Fleet member</TableHead>
            <TableHead>Context</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Details</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {nodes.map((node) => {
            const clickable = isInspectable(node);
            const activate = (): void => openConsole(node);
            return (
              <TableRow
                key={node.id}
                data-testid="fleet-row"
                data-kind={node.kind}
                tabIndex={clickable ? 0 : undefined}
                onClick={clickable ? activate : undefined}
                onKeyDown={
                  clickable
                    ? (event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return;
                        event.preventDefault();
                        activate();
                      }
                    : undefined
                }
                className={clickable ? 'cursor-pointer' : undefined}
              >
                <TableCell
                  style={{ paddingLeft: `${10 + fleetColumnFor(node.kind) * COMPACT_INDENT}px` }}
                >
                  <span className="flex items-center gap-1.5">
                    <KindIcon kind={node.kind} />
                    <span className="flex min-w-0 flex-col leading-tight">
                      <strong className="truncate">{node.label}</strong>
                      <small className="text-[10px] text-muted-foreground">
                        {node.kind.replace('-', ' ')}
                      </small>
                    </span>
                  </span>
                </TableCell>
                <TableCell title={node.sub} className="max-w-64 truncate font-mono text-[11px]">
                  {node.sub ?? '—'}
                </TableCell>
                <TableCell>
                  <Badge tone={activityTone(node.status)}>
                    {node.status ?? (node.kind === 'machine' ? 'connected' : 'ready')}
                  </Badge>
                </TableCell>
                <TableCell>
                  <span className="flex flex-wrap gap-1">
                    {node.chips.slice(0, MAX_ROW_CHIPS).map((chip) => (
                      <Badge key={chip} tone={activityTone(chip)}>
                        {chip}
                      </Badge>
                    ))}
                  </span>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

const SCOPES: { id: FleetTopologyScope; label: string }[] = [
  { id: 'all', label: 'Full fleet' },
  { id: 'machine', label: 'By machine' },
  { id: 'project', label: 'By project' },
];

export function FleetMapView(): React.ReactElement {
  const snapshot = useHqStore((state) => state.snapshot);
  const fullTopology = useMemo(() => buildFleetTopology(snapshot), [snapshot]);

  const fleetPrefs = useHqLocalPrefs().fleet;
  const scope = fleetPrefs.scope;
  const layout = fleetPrefs.layout;
  const [query, setQuery] = useState('');

  const machineOptions = useMemo(
    () =>
      fullTopology.nodes
        .filter((node) => node.kind === 'machine' && node.machineId !== undefined)
        .map((node) => ({ id: node.machineId!, label: node.label })),
    [fullTopology],
  );

  const projectOptions = useMemo(() => {
    const unique = new Map<string, string>();
    for (const node of fullTopology.nodes) {
      if (node.kind === 'project' && node.projectId !== undefined) {
        unique.set(node.projectId, node.label);
      }
    }
    return [...unique]
      .map(([id, label]) => ({ id, label }))
      .sort((left, right) => left.label.localeCompare(right.label));
  }, [fullTopology]);

  const options = scope === 'machine' ? machineOptions : projectOptions;
  const scopeId = scope === 'machine' ? fleetPrefs.machineId : fleetPrefs.projectId;
  // A stored scope id can outlive the thing it names; fall back to the first
  // option rather than rendering an empty graph.
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

  if (snapshot === null) {
    return <EmptyState title="Waiting for fleet data…" className="m-4" />;
  }

  if (fullTopology.nodes.length === 0) {
    return (
      <EmptyState
        icon={Network}
        title="No machines or connected clients yet"
        hint="Open a WrongStack CLI, TUI or WebUI with HQ running and they appear here automatically."
        className="m-4"
      />
    );
  }

  const machines = new Set(
    topology.nodes.map((node) => node.machineId).filter((id) => id !== undefined),
  ).size;
  const terminals = topology.nodes.filter((node) => node.kind === 'terminal').length;
  const agents = topology.nodes.filter((node) => node.kind === 'agent').length;
  const liveAgents = topology.nodes.filter(
    (node) => node.kind === 'agent' && isLive(node.status),
  ).length;
  const mailboxServe = topology.nodes.filter(
    (node) => node.serviceMode === 'mailbox-serve',
  ).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-3 border-b border-border p-3">
        <div className="flex flex-wrap items-start gap-x-8 gap-y-3">
          <div className="min-w-56 flex-1 space-y-0.5">
            <div className="text-[10px] font-semibold uppercase tracking-[0.11em] text-muted-foreground">
              Live operating graph
            </div>
            <h2 className="font-display text-lg leading-none">Fleet topology</h2>
            <p className="text-[11px] text-muted-foreground">
              machine → project → terminal → agent · select a live endpoint to inspect its
              transcript
            </p>
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-3">
            <StatTile label="machines" value={machines} />
            <StatTile label="terminals" value={terminals} />
            <StatTile
              label="agents live"
              value={liveAgents > 0 ? `${liveAgents}/${agents}` : agents}
              tone={liveAgents > 0 ? 'running' : 'idle'}
            />
            <StatTile
              label="mailbox serve"
              value={mailboxServe}
              tone={mailboxServe > 0 ? 'active' : 'idle'}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            <span className="text-[10px] uppercase tracking-[0.09em] text-muted-foreground">
              Scope
            </span>
            {SCOPES.map((candidate) => (
              <Button
                key={candidate.id}
                variant={scope === candidate.id ? 'secondary' : 'ghost'}
                size="sm"
                aria-pressed={scope === candidate.id}
                onClick={() => setHqFleetPrefs({ scope: candidate.id })}
              >
                {candidate.label}
              </Button>
            ))}
          </div>

          {scope !== 'all' && (
            <Select
              aria-label={scope === 'machine' ? 'Select machine' : 'Select project'}
              value={effectiveScopeId ?? ''}
              onChange={(event) =>
                setHqFleetPrefs(
                  scope === 'machine'
                    ? { machineId: event.target.value }
                    : { projectId: event.target.value },
                )
              }
              className="w-48"
            >
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </Select>
          )}

          <div className="ml-auto flex items-center gap-1">
            <span className="text-[10px] uppercase tracking-[0.09em] text-muted-foreground">
              View
            </span>
            <Button
              variant={layout === 'map' ? 'secondary' : 'ghost'}
              size="sm"
              aria-pressed={layout === 'map'}
              onClick={() => setHqFleetPrefs({ layout: 'map' })}
            >
              <Network />
              Map
            </Button>
            <Button
              variant={layout === 'compact' ? 'secondary' : 'ghost'}
              size="sm"
              aria-pressed={layout === 'compact'}
              onClick={() => setHqFleetPrefs({ layout: 'compact' })}
            >
              <ListTree />
              Compact
            </Button>
          </div>

          <div className="relative w-64">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              aria-label="Search fleet"
              placeholder="Search machine, project, client, agent…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="pl-7 pr-7"
            />
            {query.length > 0 && (
              <button
                type="button"
                aria-label="Clear fleet search"
                onClick={() => setQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            )}
          </div>
        </div>
      </div>

      {topology.nodes.length === 0 ? (
        <EmptyState title="No fleet entries match this search" className="m-4" />
      ) : layout === 'map' ? (
        <ReactFlowProvider>
          <FleetFlow topology={topology} />
        </ReactFlowProvider>
      ) : (
        <FleetCompactList topology={topology} />
      )}

      <div className="flex shrink-0 flex-wrap gap-x-4 gap-y-1 border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <MonitorSmartphone className="size-3" /> machine
        </span>
        <span className="inline-flex items-center gap-1">
          <FolderGit2 className="size-3" /> project
        </span>
        <span className="inline-flex items-center gap-1">
          <SquareTerminal className="size-3" /> terminal / TUI / CLI / WebUI
        </span>
        <span className="inline-flex items-center gap-1">
          <GitBranch className="size-3" /> branch, shown as a chip when known
        </span>
        <span className="inline-flex items-center gap-1">
          <Bot className="size-3" /> agent
        </span>
      </div>
    </div>
  );
}

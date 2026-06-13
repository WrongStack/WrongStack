/**
 * AgentFlowCanvas — React Flow canvas with real-time viz store integration.
 *
 * Receives a containerRef for proper sizing when embedded in FlowSidebar.
 * Uses viz store as the source of truth for nodes, edges, and events.
 */

import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  type Node,
  type Edge,
  type Connection,
  type NodeTypes,
  type EdgeTypes,
  BackgroundVariant,
  useReactFlow,
  ReactFlowProvider,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import {
  useFleetStore,
  useSessionStore,
  useVizStore,
} from '@/stores';
import {
  Bot,
  Box,
  Clock,
  Cpu,
  Database,
  FolderOpen,
  Layers,
  Play,
  Square,
  Target,
  Wrench,
  X,
  Zap,
  CheckCircle2,
  AlertCircle,
  FileText,
  Terminal,
  Globe,
} from 'lucide-react';
import { AgentFlowGraphCSS } from './AgentFlowGraphCSS.js';

// ── Tool Icons ─────────────────────────────────────────────────────────────

const TOOL_ICONS: Record<string, React.ReactNode> = {
  read: <FileText className="h-3 w-3" />,
  write: <FileText className="h-3 w-3" />,
  bash: <Terminal className="h-3 w-3" />,
  exec: <Terminal className="h-3 w-3" />,
  glob: <FolderOpen className="h-3 w-3" />,
  grep: <Target className="h-3 w-3" />,
  edit: <Wrench className="h-3 w-3" />,
  fetch: <Globe className="h-3 w-3" />,
  search: <Target className="h-3 w-3" />,
};

// ── Node Types ─────────────────────────────────────────────────────────────

type FlowNodeType = 'session' | 'agent' | 'tool' | 'provider' | 'context';

interface FlowNodeData extends Record<string, unknown> {
  label: string;
  sublabel?: string;
  type: FlowNodeType;
  status: 'idle' | 'active' | 'streaming' | 'completed' | 'error';
  stats?: {
    iterations?: number;
    toolCalls?: number;
    costUsd?: number;
    ctxPct?: number;
    durationMs?: number;
  };
  currentTool?: string;
  color?: string;
}

// ── Node Components ────────────────────────────────────────────────────────

function SessionNode({ data }: { data: FlowNodeData }) {
  const isActive = data.status === 'active' || data.status === 'streaming';
  const colors = data.color || '#22c55e';
  const bgClass = isActive ? 'border-emerald-500/50 bg-emerald-500/10' : 'border-gray-500/40 bg-gray-500/10';

  return (
    <div className={cn('rounded-lg border-2 p-3 min-w-[160px] transition-all', bgClass)}>
      <div className="flex items-center gap-2">
        <div className={cn('flex items-center justify-center w-8 h-8 rounded-lg', isActive ? 'bg-emerald-500/20' : 'bg-gray-500/20')}>
          <FolderOpen className="h-4 w-4" style={{ color: colors }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[11px] font-bold truncate" style={{ color: colors }}>{data.label}</div>
          {data.sublabel && <div className="text-[9px] text-gray-500 truncate">{data.sublabel}</div>}
        </div>
        {isActive && (
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" style={{ boxShadow: '0 0 8px hsl(140,70%,50%)' }} />
        )}
      </div>
      {data.stats && (
        <div className="mt-2 pt-2 border-t border-white/10 grid grid-cols-3 gap-1 text-[9px]">
          {data.stats.iterations !== undefined && (
            <div className="text-center">
              <div className="font-mono text-emerald-400">{data.stats.iterations}</div>
              <div className="text-gray-500">iter</div>
            </div>
          )}
          {data.stats.toolCalls !== undefined && (
            <div className="text-center">
              <div className="font-mono text-blue-400">{data.stats.toolCalls}</div>
              <div className="text-gray-500">tools</div>
            </div>
          )}
          {data.stats.costUsd !== undefined && data.stats.costUsd > 0 && (
            <div className="text-center">
              <div className="font-mono text-amber-400">${data.stats.costUsd.toFixed(3)}</div>
              <div className="text-gray-500">cost</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AgentNode({ data }: { data: FlowNodeData }) {
  const isActive = data.status === 'active' || data.status === 'streaming';
  const isError = data.status === 'error';
  const colors = data.color || '#a855f7';
  const bgClass = isActive ? 'border-purple-500/50 bg-purple-500/10' : isError ? 'border-red-500/50 bg-red-500/10' : 'border-gray-500/40 bg-gray-500/10';

  return (
    <div className={cn('rounded-lg border-2 p-2.5 min-w-[140px] transition-all', bgClass)}>
      <div className="flex items-center gap-2">
        <div className={cn('flex items-center justify-center w-7 h-7 rounded-lg', isActive ? 'bg-purple-500/20' : 'bg-purple-500/10')}>
          <Bot className="h-4 w-4" style={{ color: colors }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] font-bold truncate" style={{ color: colors }}>{data.label}</div>
          {data.currentTool && (
            <div className="flex items-center gap-1 text-[9px] text-amber-400/70">
              <Wrench className="h-2.5 w-2.5" />
              <span className="truncate font-mono">{data.currentTool}</span>
            </div>
          )}
        </div>
        {isActive && (
          <span className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-pulse" style={{ boxShadow: '0 0 6px hsl(280,80%,60%)' }} />
        )}
      </div>
      <div className="mt-1.5 flex items-center justify-between text-[9px]">
        <span className="text-gray-500">iter {data.stats?.iterations ?? 0}</span>
        <span className="text-gray-500">tools {data.stats?.toolCalls ?? 0}</span>
        {data.stats?.costUsd !== undefined && data.stats.costUsd > 0 && (
          <span className="text-emerald-400/70">${data.stats.costUsd.toFixed(3)}</span>
        )}
      </div>
      {data.stats?.ctxPct !== undefined && (
        <div className="mt-1.5">
          <div className="flex items-center justify-between text-[9px] mb-0.5">
            <span className="text-gray-500">ctx</span>
            <span className={data.stats.ctxPct > 80 ? 'text-red-400' : data.stats.ctxPct > 60 ? 'text-amber-400' : 'text-gray-400'}>
              {data.stats.ctxPct}%
            </span>
          </div>
          <div className="h-1 rounded-full bg-black/30 overflow-hidden">
            <div
              className={cn('h-full rounded-full transition-all', data.stats.ctxPct > 80 ? 'bg-red-500' : data.stats.ctxPct > 60 ? 'bg-amber-500' : 'bg-blue-500')}
              style={{ width: `${Math.min(100, data.stats.ctxPct)}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function ToolNode({ data }: { data: FlowNodeData }) {
  const colors = data.color || '#f59e0b';
  const icon = TOOL_ICONS[data.label?.toLowerCase() ?? ''] || <Wrench className="h-3 w-3" />;

  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 min-w-[100px] transition-all">
      <div className="flex items-center gap-2">
        <span style={{ color: colors }}>{icon}</span>
        <span className="text-[10px] font-mono font-medium truncate" style={{ color: colors }}>{data.label}</span>
      </div>
      {data.stats?.durationMs !== undefined && (
        <div className="mt-1 text-[9px] text-gray-500 text-center">
          {data.stats.durationMs}ms
        </div>
      )}
    </div>
  );
}

function ProviderNode({ data }: { data: FlowNodeData }) {
  const isActive = data.status === 'active' || data.status === 'streaming';
  const colors = data.color || '#06b6d4';
  const bgClass = isActive ? 'border-cyan-500/50 bg-cyan-500/10' : 'border-cyan-500/30 bg-cyan-500/5';

  return (
    <div className={cn('rounded-lg border-2 p-3 min-w-[120px] transition-all', bgClass)}>
      <div className="flex items-center gap-2">
        <div className={cn('flex items-center justify-center w-8 h-8 rounded-lg', isActive ? 'bg-cyan-500/20' : 'bg-cyan-500/10')}>
          <Cpu className="h-4 w-4" style={{ color: colors }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] font-bold" style={{ color: colors }}>LLM</div>
          <div className="text-[9px] text-gray-500 truncate">{data.sublabel || 'Provider'}</div>
        </div>
        {isActive && (
          <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" style={{ boxShadow: '0 0 8px hsl(180,80%,60%)' }} />
        )}
      </div>
    </div>
  );
}

function ContextNode({ data }: { data: FlowNodeData }) {
  const colors = data.color || '#3b82f6';

  return (
    <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 p-2 min-w-[90px] transition-all">
      <div className="flex items-center gap-2">
        <Database className="h-3 w-3" style={{ color: colors }} />
        <span className="text-[10px] font-medium" style={{ color: colors }}>Context</span>
      </div>
      {data.stats?.ctxPct !== undefined && (
        <>
          <div className="mt-1 text-[9px] text-center text-gray-400">{data.stats.ctxPct}%</div>
          <div className="h-1 mt-0.5 rounded-full bg-black/30 overflow-hidden">
            <div className="h-full rounded-full bg-blue-500" style={{ width: `${Math.min(100, data.stats.ctxPct)}%` }} />
          </div>
        </>
      )}
    </div>
  );
}

// ── Node Type Map ──────────────────────────────────────────────────────────

const nodeTypes: NodeTypes = {
  session: SessionNode,
  agent: AgentNode,
  tool: ToolNode,
  provider: ProviderNode,
  context: ContextNode,
};

// ── Custom Edge with Flow Annotations ─────────────────────────────────────────

interface FlowEdgeData {
  animated?: boolean;
  color?: string;
  label?: string;
  flowType?: 'prompt' | 'response' | 'tool_result' | 'tokens' | 'spawn' | 'status';
  sequence?: number;
  dataPayload?: string;
}

function FlowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
  selected,
}: {
  id: string;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  data?: FlowEdgeData;
  selected?: boolean;
}) {
  const [path, labelX, labelY] = getBezierPath(sourceX, sourceY, targetX, targetY);
  const color = data?.color || '#6366f1';
  const isAnimated = data?.animated;
  const flowType = data?.flowType || 'response';
  const sequence = data?.sequence;

  // Flow type icons and colors
  const flowMeta: Record<string, { icon: string; bg: string; text: string }> = {
    prompt: { icon: '📥', bg: 'bg-blue-500/20', text: 'text-blue-400' },
    response: { icon: '📤', bg: 'bg-emerald-500/20', text: 'text-emerald-400' },
    tool_result: { icon: '🔧', bg: 'bg-amber-500/20', text: 'text-amber-400' },
    tokens: { icon: '💎', bg: 'bg-cyan-500/20', text: 'text-cyan-400' },
    spawn: { icon: '✨', bg: 'bg-purple-500/20', text: 'text-purple-400' },
    status: { icon: '📊', bg: 'bg-pink-500/20', text: 'text-pink-400' },
  };

  const meta = flowMeta[flowType] || flowMeta.response;

  return (
    <>
      {/* Main edge path */}
      <path
        id={id}
        d={path}
        fill="none"
        stroke={color}
        strokeWidth={selected ? 3 : 2}
        strokeOpacity={selected ? 0.9 : 0.4}
        className="react-flow__edge-path"
        markerEnd={`url(#arrow-${color.replace('#', '')})`}
      />

      {/* Animated flow particles */}
      {isAnimated && (
        <path
          d={path}
          fill="none"
          stroke={color}
          strokeWidth={2.5}
          strokeDasharray="8 4"
          className="animated-edge"
          opacity={0.8}
        />
      )}

      {/* Sequence number badge */}
      {sequence !== undefined && (
        <g transform={`translate(${labelX - 6}, ${labelY - 18})`}>
          <circle r="8" fill={color} opacity={0.9} />
          <text
            x="0"
            y="3"
            textAnchor="middle"
            fill="white"
            fontSize="9"
            fontWeight="bold"
          >
            {sequence}
          </text>
        </g>
      )}

      {/* Flow type label */}
      {data?.label && (
        <foreignObject
          width={100}
          height={28}
          x={labelX - 50}
          y={labelY - 14}
          className="overflow-visible"
        >
          <div className="flex items-center justify-center gap-1">
            <span className="text-[10px]">{meta.icon}</span>
            <div className={cn('px-2 py-1 rounded-md border text-[9px] font-medium', meta.bg, 'border-border/50', meta.text)}>
              {data.label}
            </div>
          </div>
        </foreignObject>
      )}

      {/* Arrow marker definition */}
      <defs>
        <marker
          id={`arrow-${color.replace('#', '')}`}
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill={color} opacity={0.7} />
        </marker>
      </defs>
    </>
  );
}

function getBezierPath(sx: number, sy: number, tx: number, ty: number): [string, number, number] {
  const dx = Math.abs(tx - sx);
  const offset = Math.max(40, dx * 0.4);
  const cx = (sx + tx) / 2;
  const cy = Math.min(sy, ty) - offset;
  return [
    `M ${sx} ${sy} C ${sx} ${cy}, ${tx} ${cy}, ${tx} ${ty}`,
    cx,
    cy,
  ];
}

const edgeTypes: EdgeTypes = {
  flow: FlowEdge,
};

// ── Layout Engine ──────────────────────────────────────────────────────────

/**
 * Automatic layout based on node kind zones:
 * - provider: top (zone: top)
 * - session: center (zone: center)
 * - agents: middle row (zone: center, order by spawn time)
 * - tools: bottom (zone: bottom)
 * - context: right side (zone: right)
 */
function layoutNodes(
  nodes: Array<{ id: string; kind: string; [key: string]: unknown }>,
): Array<{ id: string; x: number; y: number }> {
  const zones: Record<string, { x: number; y: number }> = {};

  // Provider at top center
  const providerNode = nodes.find(n => n.kind === 'provider');
  if (providerNode) {
    zones[providerNode.id as string] = { x: 400, y: 20 };
  }

  // Session at center
  const sessionNode = nodes.find(n => n.kind === 'session');
  if (sessionNode) {
    zones[sessionNode.id as string] = { x: 400, y: 120 };
  }

  // Context node on the right
  const contextNode = nodes.find(n => n.kind === 'context');
  if (contextNode) {
    zones[contextNode.id as string] = { x: 700, y: 200 };
  }

  // Agent nodes in middle row, distributed horizontally
  const agentNodes = nodes.filter(n => n.kind === 'agent');
  const agentCount = agentNodes.length;
  if (agentCount > 0) {
    const spacing = Math.min(200, 800 / (agentCount + 1));
    const startX = Math.max(100, (800 - (agentCount - 1) * spacing) / 2);
    agentNodes.forEach((node, i) => {
      zones[node.id as string] = { x: startX + i * spacing, y: 300 };
    });
  }

  // Tool nodes below their parent agents
  const toolNodes = nodes.filter(n => n.kind === 'tool');
  toolNodes.forEach(node => {
    // Find parent agent based on id pattern (tool-{agentId}-*)
    const id = node.id as string;
    const match = id.match(/^tool-(.+?)-\d+$/);
    if (match) {
      const parentId = `agent-${match[1]}`;
      const parentZone = zones[parentId];
      if (parentZone) {
        zones[node.id as string] = { x: parentZone.x, y: parentZone.y + 150 };
        return;
      }
    }
    // Fallback: distribute below
    const idx = toolNodes.indexOf(node);
    zones[node.id as string] = { x: 100 + idx * 180, y: 480 };
  });

  return Object.entries(zones).map(([id, pos]) => ({ id, ...pos }));
}

// ── Main Canvas Component ──────────────────────────────────────────────────

interface AgentFlowCanvasProps {
  containerRef?: React.RefObject<HTMLDivElement | null>;
}

export function AgentFlowCanvas({ containerRef }: AgentFlowCanvasProps) {
  const { fitView } = useReactFlow();
  const session = useSessionStore((s) => s.session);
  const projectName = useSessionStore((s) => s.projectName);
  const iteration = useSessionStore((s) => s.iteration);
  const cost = useSessionStore((s) => s.cost);
  const lastInputTokens = useSessionStore((s) => s.lastInputTokens);
  const maxContext = useSessionStore((s) => s.maxContext);
  const fleetAgents = useFleetStore((s) => s.agents);

  // Viz store for real-time events
  const vizNodes = useVizStore((s) => s.nodes);
  const vizEdges = useVizStore((s) => s.edges);
  const vizEvents = useVizStore((s) => s.events);
  const counters = useVizStore((s) => s.counters);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<FlowNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNode, setSelectedNode] = useState<Node<FlowNodeData> | null>(null);

  // Build React Flow nodes from store data + session state
  useEffect(() => {
    const rfNodes: Node<FlowNodeData>[] = [];
    const rfEdges: Edge[] = [];

    // Provider node (top)
    rfNodes.push({
      id: 'provider',
      type: 'provider',
      position: { x: 400, y: 20 },
      data: {
        label: 'LLM',
        sublabel: session?.model || 'claude-3-5-sonnet',
        type: 'provider',
        status: session ? 'active' : 'idle',
        color: '#06b6d4',
      },
    });

    // Session node (center)
    rfNodes.push({
      id: 'session',
      type: 'session',
      position: { x: 400, y: 120 },
      data: {
        label: session?.title || projectName || 'Session',
        sublabel: session?.id.slice(0, 8),
        type: 'session',
        status: session ? 'active' : 'idle',
        color: '#22c55e',
        stats: {
          iterations: iteration?.index,
          toolCalls: Array.from(fleetAgents.values()).reduce((sum, a) => sum + a.toolCalls, 0),
          costUsd: cost,
        },
      },
    });

    // Context node (right)
    const ctxPct = maxContext ? Math.round((lastInputTokens / maxContext) * 100) : 0;
    rfNodes.push({
      id: 'context',
      type: 'context',
      position: { x: 700, y: 200 },
      data: {
        label: 'Context',
        type: 'context',
        status: ctxPct > 80 ? 'active' : 'idle',
        color: '#3b82f6',
        stats: { ctxPct },
      },
    });

    // Agent nodes (middle row)
    const fleetArray = Array.from(fleetAgents.values());
    const agentSpacing = Math.min(200, 800 / (fleetArray.length + 1));
    const agentStartX = Math.max(100, (800 - (fleetArray.length - 1) * agentSpacing) / 2);

    fleetArray.forEach((agent, i) => {
      const isActive = agent.status === 'running';
      const isError = agent.status === 'failed';
      const nodeId = `agent-${agent.id}`;
      const agentColor = isError ? '#ef4444' : isActive ? '#a855f7' : '#8b5cf6';

      rfNodes.push({
        id: nodeId,
        type: 'agent',
        position: { x: agentStartX + i * agentSpacing, y: 300 },
        data: {
          label: agent.name,
          type: 'agent',
          status: isActive ? 'active' : isError ? 'error' : agent.status === 'completed' ? 'completed' : 'idle',
          color: agentColor,
          stats: {
            iterations: agent.iteration,
            toolCalls: agent.toolCalls,
            costUsd: agent.costUsd,
            ctxPct: agent.ctxPct,
          },
          currentTool: agent.currentTool || agent.lastTool,
        },
      });

      // Session → Agent edge (task assignment)
      rfEdges.push({
        id: `session->${nodeId}`,
        source: 'session',
        target: nodeId,
        type: 'flow',
        animated: isActive,
        data: {
          color: agentColor,
          animated: isActive,
          label: 'task',
          flowType: 'prompt',
          sequence: i + 1,
        },
      });

      // Agent → Provider edge (LLM call)
      rfEdges.push({
        id: `${nodeId}->provider`,
        source: nodeId,
        target: 'provider',
        type: 'flow',
        animated: isActive,
        data: {
          color: '#06b6d4',
          animated: isActive,
          label: 'prompt',
          flowType: 'prompt',
          sequence: 0,
        },
      });

      // Tool nodes (below agents)
      const toolName = agent.currentTool || agent.lastTool;
      if (toolName) {
        const toolNodeId = `tool-${agent.id}-${fleetArray.indexOf(agent)}`;
        rfNodes.push({
          id: toolNodeId,
          type: 'tool',
          position: { x: agentStartX + i * agentSpacing, y: 450 },
          data: {
            label: toolName,
            type: 'tool',
            status: isActive ? 'active' : 'idle',
            color: '#f59e0b',
            stats: { durationMs: agent.toolLog?.[0]?.durationMs },
          },
        });

        rfEdges.push({
          id: `${nodeId}->${toolNodeId}`,
          source: nodeId,
          target: toolNodeId,
          type: 'flow',
          animated: isActive,
          data: {
            color: '#f59e0b',
            animated: isActive,
            label: 'execute',
            flowType: 'tool_result',
            sequence: 2,
          },
        });

        // Tool → Agent edge (result)
        rfEdges.push({
          id: `${toolNodeId}->${nodeId}`,
          source: toolNodeId,
          target: nodeId,
          type: 'flow',
          animated: false,
          data: {
            color: '#22c55e',
            animated: false,
            label: 'result',
            flowType: 'tool_result',
            sequence: 3,
          },
        });
      }
    });

    // Provider → Session edge (LLM response)
    rfEdges.push({
      id: 'provider->session',
      source: 'provider',
      target: 'session',
      type: 'flow',
      animated: !!session,
      data: {
        color: '#06b6d4',
        animated: !!session,
        label: 'response',
        flowType: 'response',
        sequence: 4,
      },
    });

    // Context → Session edge (context fetch)
    rfEdges.push({
      id: 'context->session',
      source: 'context',
      target: 'session',
      type: 'flow',
      data: {
        color: '#3b82f6',
        animated: false,
        label: 'tokens',
        flowType: 'tokens',
      },
    });

    setNodes(rfNodes);
    setEdges(rfEdges);

    // Fit view after a short delay to let React Flow initialize
    setTimeout(() => fitView({ padding: 0.2, duration: 300 }), 50);
  }, [session, projectName, iteration, fleetAgents, cost, lastInputTokens, maxContext, setNodes, setEdges, fitView]);

  // Handle viz events for live updates (status changes, etc.)
  useEffect(() => {
    if (vizEvents.length === 0) return;

    const latestEvent = vizEvents[0];
    if (!latestEvent) return;

    // Update node status based on events
    if (latestEvent.kind === 'agent:tool' && latestEvent.source) {
      const nodeId = `agent-${latestEvent.source}`;
      setNodes((nds) =>
        nds.map((n) =>
          n.id === nodeId
            ? { ...n, data: { ...n.data, status: 'streaming' as const, currentTool: latestEvent.label } }
            : n,
        ),
      );
    }

    if (latestEvent.kind === 'agent:status') {
      const nodeId = `agent-${latestEvent.source}`;
      const newStatus = latestEvent.label.includes('completed') ? 'completed'
        : latestEvent.label.includes('failed') ? 'error'
        : latestEvent.label.includes('running') ? 'active'
        : ('idle' as const);
      setNodes((nds) =>
        nds.map((n) =>
          n.id === nodeId
            ? { ...n, data: { ...n.data, status: newStatus } }
            : n,
        ),
      );
    }
  }, [vizEvents, setNodes]);

  const onConnect = useCallback(
    (params: Connection) => setEdges((eds) => addEdge({ ...params, type: 'flow' }, eds)),
    [setEdges],
  );

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNode(node as Node<FlowNodeData>);
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
  }, []);

  return (
    <div className="w-full h-full bg-background relative">
      <AgentFlowGraphCSS />
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        attributionPosition="bottom-left"
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="hsl(var(--border))" />
        <Controls className="!bg-background/80 !border-border backdrop-blur" />
        <MiniMap
          className="!bg-background/80 !border-border"
          nodeColor={(n) => {
            switch (n.type) {
              case 'session': return '#22c55e';
              case 'agent': return '#a855f7';
              case 'tool': return '#f59e0b';
              case 'provider': return '#06b6d4';
              case 'context': return '#3b82f6';
              default: return '#6366f1';
            }
          }}
        />
      </ReactFlow>

      {/* Node Detail Panel */}
      {selectedNode && (
        <div className="absolute top-4 right-4 w-64 bg-background/95 border border-border rounded-lg shadow-xl backdrop-blur z-50">
          <div className="flex items-center justify-between p-3 border-b border-border">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold capitalize">{selectedNode.type}</span>
              <span className={cn(
                'px-1.5 py-0.5 rounded text-[9px] font-medium',
                selectedNode.data.status === 'active' && 'bg-emerald-500/20 text-emerald-400',
                selectedNode.data.status === 'streaming' && 'bg-blue-500/20 text-blue-400',
                selectedNode.data.status === 'error' && 'bg-red-500/20 text-red-400',
                selectedNode.data.status === 'completed' && 'bg-blue-500/20 text-blue-400',
                selectedNode.data.status === 'idle' && 'bg-gray-500/20 text-gray-400',
              )}>
                {selectedNode.data.status}
              </span>
            </div>
            <button onClick={() => setSelectedNode(null)} className="text-muted-foreground hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="p-3 space-y-2 text-[11px]">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Label</span>
              <span className="font-mono">{String(selectedNode.data.label ?? '')}</span>
            </div>
            {selectedNode.data.sublabel && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Sublabel</span>
                <span className="font-mono text-[10px]">{String(selectedNode.data.sublabel)}</span>
              </div>
            )}
            {selectedNode.data.currentTool && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Tool</span>
                <span className="font-mono text-amber-400">{String(selectedNode.data.currentTool)}</span>
              </div>
            )}
            {selectedNode.data.stats && (
              <>
                {selectedNode.data.stats.iterations !== undefined && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Iterations</span>
                    <span className="font-mono">{selectedNode.data.stats.iterations}</span>
                  </div>
                )}
                {selectedNode.data.stats.toolCalls !== undefined && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Tool Calls</span>
                    <span className="font-mono">{selectedNode.data.stats.toolCalls}</span>
                  </div>
                )}
                {selectedNode.data.stats.costUsd !== undefined && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Cost</span>
                    <span className="font-mono text-emerald-400">${selectedNode.data.stats.costUsd.toFixed(4)}</span>
                  </div>
                )}
                {selectedNode.data.stats.ctxPct !== undefined && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Context</span>
                    <span className="font-mono">{selectedNode.data.stats.ctxPct}%</span>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Live Counters HUD */}
      <div className="absolute bottom-4 left-4 bg-background/95 border border-border rounded-lg p-2 backdrop-blur">
        <div className="text-[9px] text-muted-foreground mb-1 font-semibold uppercase tracking-wider">Live</div>
        <div className="grid grid-cols-3 gap-x-3 gap-y-1 text-[10px]">
          <CounterItem label="Tokens" value={counters.totalTokens.toLocaleString()} />
          <CounterItem label="Cost" value={`$${counters.totalCost.toFixed(3)}`} />
          <CounterItem label="Tools" value={counters.totalToolCalls} />
          <CounterItem label="Agents" value={counters.activeAgents} />
          <CounterItem label="Done" value={counters.completedTasks} />
          <CounterItem label="Errors" value={counters.errors} />
        </div>
      </div>

      {/* Flow Sequence Panel */}
      <div className="absolute top-4 left-4 bg-background/95 border border-border rounded-lg p-3 backdrop-blur z-50 max-w-xs">
        <div className="text-[9px] text-muted-foreground mb-2 font-semibold uppercase tracking-wider flex items-center gap-2">
          <span className="text-primary">⟳</span> Flow Sequence
        </div>
        <div className="space-y-1.5">
          <FlowStep sequence={0} icon="📥" label="Prompt" description="User input → LLM" color="#06b6d4" />
          <FlowStep sequence={1} icon="👤" label="Task" description="Session → Agent" color="#a855f7" />
          <FlowStep sequence={2} icon="🔧" label="Execute" description="Agent → Tool" color="#f59e0b" />
          <FlowStep sequence={3} icon="✅" label="Result" description="Tool → Agent" color="#22c55e" />
          <FlowStep sequence={4} icon="📤" label="Response" description="LLM → Session" color="#06b6d4" />
        </div>
        <div className="mt-2 pt-2 border-t border-border">
          <div className="text-[9px] text-muted-foreground flex items-center gap-2">
            <span>💎</span> Tokens: Context → Session
          </div>
        </div>
      </div>

      {/* Node Legend */}
      <div className="absolute bottom-4 right-4 bg-background/95 border border-border rounded-lg p-2 backdrop-blur">
        <div className="text-[9px] text-muted-foreground mb-1 font-semibold uppercase tracking-wider">Nodes</div>
        <div className="space-y-1">
          <LegendItem color="#22c55e" label="Session" />
          <LegendItem color="#a855f7" label="Agent" />
          <LegendItem color="#f59e0b" label="Tool" />
          <LegendItem color="#06b6d4" label="Provider" />
          <LegendItem color="#3b82f6" label="Context" />
        </div>
      </div>
    </div>
  );
}

function CounterItem({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono font-bold text-foreground">{value}</span>
    </div>
  );
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5 text-[10px]">
      <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: color }} />
      <span className="text-muted-foreground">{label}</span>
    </div>
  );
}

function FlowStep({ sequence, icon, label, description, color }: {
  sequence: number;
  icon: string;
  label: string;
  description: string;
  color: string;
}) {
  return (
    <div className="flex items-center gap-2 text-[10px]">
      <div
        className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold text-white shrink-0"
        style={{ backgroundColor: color }}
      >
        {sequence}
      </div>
      <div className="flex items-center gap-1">
        <span>{icon}</span>
        <span className="font-medium" style={{ color }}>{label}</span>
        <span className="text-muted-foreground text-[9px]">{description}</span>
      </div>
    </div>
  );
}

// ── Provider wrapper for useReactFlow ──────────────────────────────────────

export function AgentFlowCanvasWithProvider(props: AgentFlowCanvasProps) {
  return (
    <ReactFlowProvider>
      <AgentFlowCanvas {...props} />
    </ReactFlowProvider>
  );
}

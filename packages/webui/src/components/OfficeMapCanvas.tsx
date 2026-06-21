/**
 * OfficeMapCanvas — React Flow canvas with real-time office environment visualization.
 *
 * Displays all connected clients (WebUI, TUI, REPL, etc.) as nodes in an office floor plan.
 * Shows live status (mail read, mail sent, idle, active, error) with animated wire connections.
 * Uses viz store for real-time events and fleet store for agent status.
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
  Handle,
  Position,
  Panel,
  getBezierPath,
  EdgeLabelRenderer,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  Monitor,
  Terminal,
  Mail,
  Wifi,
  WifiOff,
  Cpu,
  Send,
  Inbox,
  Building2,
  Users,
  Armchair,
  AppWindow,
  Zap,
  Activity,
  Hash,
  DollarSign,
  LayoutGrid,
  ScrollText,
  Maximize2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  useFleetStore,
  useSessionStore,
  useVizStore,
  useMailboxStore,
  useMonitorStore,
  useOfficeMapStore,
} from '@/stores';
import type { LiveSession } from '@/stores/monitor-store';
import type { VizEvent } from '@/stores/viz-store';
import type { SubagentView } from '@/stores/types';
import { SessionWatchPanel } from './SessionWatchPanel';
import {
  type ClientKind,
  type ClientStatus,
  type OfficeNodeData,
  fmtCompact,
  fmtAgo,
  fmtUptime,
  shortModel,
  CENTER_X,
  HUB_Y,
  HUB_GAP,
  MAILBOX_Y,
  COORD_Y,
  CLIENT_Y,
  AGENT_Y0,
  CLIENT_COL_W,
  AGENT_COLS,
  AGENT_FAN_W,
  AGENT_ROW_H,
  layoutClientXs,
  agentFanPos,
  surfaceLabel,
} from './OfficeMapCanvas/utils.js';
import { feedColor, resolveClients } from './OfficeMapCanvas/resolve.js';

// ── Status LED ─────────────────────────────────────────────────────────────

function StatusLED({ status, small, activity = 0 }: { status: ClientStatus; small?: boolean; activity?: number }) {
  const size = small ? 'w-2 h-2' : 'w-3 h-3';

  // Intensity of the glow: 0–1, driven by VizNode.activity from vizStore.
  // At activity=0 the LED is flat; at activity=1 it glows at full brightness.
  const glowOpacity = activity > 0 ? Math.min(0.9, 0.3 + activity * 0.6) : 0;
  const glowRadius = small ? 4 + activity * 4 : 6 + activity * 6;

  const baseColor: Record<ClientStatus, string> = {
    idle: 'bg-gray-500',
    active: 'bg-emerald-500',
    streaming: 'bg-blue-500',
    completed: 'bg-blue-500',
    error: 'bg-red-500',
    offline: 'bg-gray-600',
  };

  const glowColor: Record<ClientStatus, string> = {
    idle: '#9ca3af',
    active: '#22c55e',
    streaming: '#3b82f6',
    completed: '#3b82f6',
    error: '#ef4444',
    offline: '#6b7280',
  };

  return (
    <span
      className={cn(
        'rounded-full',
        size,
        activity > 0 && 'animate-pulse',
        baseColor[status],
      )}
      style={{
        boxShadow: activity > 0
          ? `0 0 ${glowRadius}px ${glowColor[status]}`
          : undefined,
      }}
    />
  );
}

// ── Real-time Stats HUD ──────────────────────────────────────────────────────

function StatsHUD() {
  const { clientCounts, currentSession, totalAgents, activeAgents, aggregate } = useMonitorStore();
  const totalClients = clientCounts.tui + clientCounts.webui + clientCounts.repl;

  // Format tokens with commas
  const fmtNum = (n?: number) => n?.toLocaleString() ?? '0';
  const fmtCost = (n?: number) => (n != null ? `$${n.toFixed(4)}` : '$0.0000');

  return (
    <div className="absolute top-20 left-4 z-10 bg-slate-800/95 backdrop-blur border border-slate-700 rounded-lg p-3 shadow-xl">
      <div className="flex items-center gap-2 mb-2">
        <Activity className="h-3.5 w-3.5 text-emerald-400" />
        <span className="text-[10px] font-bold text-gray-300 uppercase tracking-wide">Session Stats</span>
      </div>

      <div className="space-y-1.5 text-[10px]">
        {/* Active clients */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-1.5">
            <Users className="h-3 w-3 text-gray-500" />
            <span className="text-gray-400">Clients</span>
          </div>
          <span className="text-gray-200 font-mono">
            {activeAgents} <span className="text-gray-500">/</span>{' '}
            <span className="text-emerald-400">{totalClients}</span>
          </span>
        </div>

        {/* Client breakdown */}
        <div className="flex items-center gap-3 pl-4 text-[9px]">
          {clientCounts.tui > 0 && (
            <span className="flex items-center gap-1">
              <Terminal className="h-2.5 w-2.5 text-emerald-500" />
              <span className="text-gray-400">TUI</span>
              <span className="text-emerald-400 font-mono">{clientCounts.tui}</span>
            </span>
          )}
          {clientCounts.webui > 0 && (
            <span className="flex items-center gap-1">
              <Monitor className="h-2.5 w-2.5 text-blue-500" />
              <span className="text-gray-400">WebUI</span>
              <span className="text-blue-400 font-mono">{clientCounts.webui}</span>
            </span>
          )}
          {clientCounts.repl > 0 && (
            <span className="flex items-center gap-1">
              <Terminal className="h-2.5 w-2.5 text-amber-500" />
              <span className="text-gray-400">REPL</span>
              <span className="text-amber-400 font-mono">{clientCounts.repl}</span>
            </span>
          )}
        </div>

        {/* Agent count */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-1.5">
            <Bot className="h-3 w-3 text-gray-500" />
            <span className="text-gray-400">Agents</span>
          </div>
          <span className="text-gray-200 font-mono">
            {activeAgents} <span className="text-gray-500">/</span>{' '}
            <span className="text-cyan-400">{totalAgents}</span>
          </span>
        </div>

        {/* Model */}
        {currentSession.model && (
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-1.5">
              <Cpu className="h-3 w-3 text-gray-500" />
              <span className="text-gray-400">Model</span>
            </div>
            <span className="text-cyan-400 font-mono truncate max-w-[120px]" title={currentSession.model}>
              {currentSession.model.split('/').pop()?.slice(0, 16)}
            </span>
          </div>
        )}

        {/* Mode */}
        {currentSession.mode && (
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-1.5">
              <Zap className="h-3 w-3 text-gray-500" />
              <span className="text-gray-400">Mode</span>
            </div>
            <span className={cn(
              'font-mono uppercase text-[9px] px-1.5 py-0.5 rounded',
              currentSession.mode === 'auto' && 'bg-purple-500/20 text-purple-400',
              currentSession.mode === 'suggest' && 'bg-blue-500/20 text-blue-400',
              currentSession.mode === 'off' && 'bg-gray-500/20 text-gray-400',
              !['auto', 'suggest', 'off'].includes(currentSession.mode || '') && 'bg-gray-500/20 text-gray-400',
            )}>
              {currentSession.mode}
            </span>
          </div>
        )}

        {/* Tool Calls — project-wide total across every live agent */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-1.5">
            <Hash className="h-3 w-3 text-gray-500" />
            <span className="text-gray-400">Tool Calls</span>
          </div>
          <span className="text-yellow-400 font-mono">{fmtNum(aggregate.toolCalls)}</span>
        </div>

        {/* Token breakdown — project-wide */}
        <div className="border-t border-slate-700 pt-1.5 mt-1.5 space-y-1">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-1.5">
              <span className="text-gray-500 text-[8px]">IN</span>
              <span className="text-gray-400">Input</span>
            </div>
            <span className="text-gray-300 font-mono text-[9px]">{fmtNum(aggregate.tokensIn)}</span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-1.5">
              <span className="text-gray-500 text-[8px]">OUT</span>
              <span className="text-gray-400">Output</span>
            </div>
            <span className="text-gray-300 font-mono text-[9px]">{fmtNum(aggregate.tokensOut)}</span>
          </div>
        </div>

        {/* Cost — project-wide */}
        <div className="flex items-center justify-between gap-4 border-t border-slate-700 pt-1.5 mt-1.5">
          <div className="flex items-center gap-1.5">
            <DollarSign className="h-3 w-3 text-gray-500" />
            <span className="text-gray-400">Cost</span>
          </div>
          <span className="text-emerald-400 font-mono font-medium">{fmtCost(aggregate.costUsd)}</span>
        </div>
      </div>
    </div>
  );
}

// ── Node Components ─────────────────────────────────────────────────────────

/**
 * Hidden connection points. React Flow only renders an edge when BOTH endpoints
 * expose a matching handle — custom nodes get none by default, which is why the
 * office wires never appeared. Every node carries a top target + bottom source
 * so edges in either vertical direction attach. Kept invisible (the custom
 * `wire` edge draws its own bezier).
 */
function NodeHandles() {
  const style = { opacity: 0, width: 1, height: 1, minWidth: 0, border: 'none', background: 'transparent' } as const;
  return (
    <>
      <Handle type="target" position={Position.Top} style={style} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} style={style} isConnectable={false} />
    </>
  );
}

/** Shared footer for client nodes: agent count + uptime. */
function ClientMeta({ data }: { data: OfficeNodeData }) {
  return (
    <div className="mt-2 flex items-center justify-between border-t border-white/5 pt-1.5 text-[8px] text-gray-500">
      <span>
        <span className="font-mono text-gray-300">{data.agentCount ?? 0}</span> agents
      </span>
      {data.startedAt && <span>up {fmtUptime(data.startedAt, Date.now())}</span>}
    </div>
  );
}

function WebUINode({ data }: { data: OfficeNodeData }) {
  const isActive = data.status === 'active' || data.status === 'streaming';
  const isError = data.status === 'error';
  const isOffline = data.status === 'offline';
  const color = data.color || '#3b82f6';

  return (
    <div className={cn(
      'rounded-xl border-2 p-4 min-w-[180px] transition-all backdrop-blur-sm',
      isActive && 'shadow-lg shadow-blue-500/20',
      isError && 'border-red-500/50 bg-red-500/10',
      isOffline && 'border-gray-500/30 bg-gray-500/5 opacity-60',
      !isActive && !isError && !isOffline && 'border-blue-500/30 bg-blue-500/10',
    )}>
      <NodeHandles />
      <div className="flex items-center gap-3 mb-3">
        <div className={cn(
          'flex items-center justify-center w-10 h-10 rounded-lg',
          isActive ? 'bg-blue-500/20' : 'bg-blue-500/10',
        )}>
          <Monitor className="h-5 w-5" style={{ color }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-bold truncate" style={{ color }}>{data.label}</div>
          <div className="text-[10px] text-gray-500">WebUI Client</div>
        </div>
        <StatusLED status={data.status} activity={data.vizActivity ?? 0} />
      </div>

      {data.sublabel && (
        <div className="text-[10px] text-gray-400 mb-2 truncate">
          {data.sublabel}
        </div>
      )}

      <div className="flex items-center gap-2 text-[10px] text-gray-500">
        {isOffline ? (
          <>
            <WifiOff className="h-3 w-3 text-gray-500" />
            <span>Disconnected</span>
          </>
        ) : (
          <>
            <Wifi className="h-3 w-3 text-emerald-500" />
            <span>Connected</span>
          </>
        )}
      </div>

      {isActive && (
        <div className="mt-2 h-1 rounded-full bg-blue-500/30 overflow-hidden">
          <div className="h-full bg-blue-500 animate-pulse" style={{ width: '60%' }} />
        </div>
      )}

      <ClientMeta data={data} />
    </div>
  );
}

function TUINode({ data }: { data: OfficeNodeData }) {
  const isActive = data.status === 'active' || data.status === 'streaming';
  const isError = data.status === 'error';
  const color = data.color || '#22c55e';

  return (
    <div className={cn(
      'rounded-xl border-2 p-4 min-w-[180px] transition-all backdrop-blur-sm',
      isActive && 'shadow-lg shadow-emerald-500/20',
      isError && 'border-red-500/50 bg-red-500/10',
      !isActive && !isError && 'border-emerald-500/30 bg-emerald-500/10',
    )}>
      <NodeHandles />
      <div className="flex items-center gap-3 mb-3">
        <div className={cn(
          'flex items-center justify-center w-10 h-10 rounded-lg',
          isActive ? 'bg-emerald-500/20' : 'bg-emerald-500/10',
        )}>
          <Terminal className="h-5 w-5" style={{ color }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-bold truncate" style={{ color }}>{data.label}</div>
          <div className="text-[10px] text-gray-500">TUI Client</div>
        </div>
        <StatusLED status={data.status} activity={data.vizActivity ?? 0} />
      </div>

      {data.sublabel && (
        <div className="text-[10px] text-gray-400 mb-2 truncate">
          {data.sublabel}
        </div>
      )}

      <div className="flex items-center gap-2 text-[10px] text-gray-500">
        <Terminal className="h-3 w-3 text-emerald-500" />
        <span>Terminal</span>
      </div>

      <ClientMeta data={data} />
    </div>
  );
}

function REPLNode({ data }: { data: OfficeNodeData }) {
  const isActive = data.status === 'active' || data.status === 'streaming';
  const color = data.color || '#f59e0b';

  return (
    <div className={cn(
      'rounded-xl border-2 p-4 min-w-[160px] transition-all backdrop-blur-sm',
      isActive && 'shadow-lg shadow-amber-500/20',
      !isActive && 'border-amber-500/30 bg-amber-500/10',
    )}>
      <NodeHandles />
      <div className="flex items-center gap-3 mb-3">
        <div className={cn(
          'flex items-center justify-center w-10 h-10 rounded-lg',
          isActive ? 'bg-amber-500/20' : 'bg-amber-500/10',
        )}>
          <Terminal className="h-5 w-5" style={{ color }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-bold truncate" style={{ color }}>{data.label}</div>
          <div className="text-[10px] text-gray-500">REPL</div>
        </div>
        <StatusLED status={data.status} activity={data.vizActivity ?? 0} />
      </div>

      {data.sublabel && (
        <div className="text-[10px] text-gray-400 mb-1 truncate">{data.sublabel}</div>
      )}

      <ClientMeta data={data} />
    </div>
  );
}

function CoordinatorNode({ data }: { data: OfficeNodeData }) {
  const isActive = data.status === 'active' || data.status === 'streaming';
  const isError = data.status === 'error';
  const color = data.color || '#a855f7';

  return (
    <div className="rounded-xl border-2 p-4 min-w-[200px] transition-all backdrop-blur-sm relative bg-slate-900/90">
      <NodeHandles />
      <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-2 py-0.5 bg-purple-600 text-white text-[9px] rounded-full font-bold">
        COORDINATOR
      </div>

      <div className="flex items-center gap-3 mb-3 mt-2">
        <div className={cn(
          'flex items-center justify-center w-12 h-12 rounded-xl',
          isActive ? 'bg-purple-500/20' : 'bg-purple-500/10',
        )}>
          <Cpu className="h-6 w-6" style={{ color }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold truncate" style={{ color }}>{data.label}</div>
          <div className="text-[10px] text-gray-500">{data.sublabel || 'Fleet summary'}</div>
        </div>
        <StatusLED status={data.status} activity={data.vizActivity ?? 0} />
      </div>

      <div className="grid grid-cols-2 gap-2 text-[10px] mb-2">
        <div className="bg-black/20 rounded p-1.5 text-center">
          <div className="font-mono">
            <span className="text-emerald-400">{data.agentsActive || 0}</span>
            <span className="text-gray-500"> / </span>
            <span className="text-purple-400">{data.agentsTotal || 0}</span>
          </div>
          <div className="text-gray-500">Agents</div>
        </div>
        <div className="bg-black/20 rounded p-1.5 text-center">
          <div className="font-mono text-yellow-400">{(data.toolCalls || 0).toLocaleString()}</div>
          <div className="text-gray-500">Tool calls</div>
        </div>
        <div className="bg-black/20 rounded p-1.5 text-center">
          <div className="font-mono text-gray-300">{fmtCompact(data.tokensIn)}</div>
          <div className="text-gray-500">Tokens</div>
        </div>
        <div className="bg-black/20 rounded p-1.5 text-center">
          <div className="font-mono text-emerald-400">${(data.costUsd || 0).toFixed(3)}</div>
          <div className="text-gray-500">Cost</div>
        </div>
      </div>

      {isActive && (
        <div className="flex items-center gap-2 text-[10px] text-purple-400">
          <span className="w-2 h-2 rounded-full bg-purple-400 animate-pulse" />
          Coordinating fleet
        </div>
      )}
    </div>
  );
}

function AgentNode({ data }: { data: OfficeNodeData }) {
  const isActive = data.status === 'active' || data.status === 'streaming';
  const isError = data.status === 'error';
  const isCompleted = data.status === 'completed';
  const color = data.color || '#06b6d4';

  return (
    <div className={cn(
      'rounded-lg border p-3 min-w-[150px] transition-all backdrop-blur-sm',
      isActive && 'border-cyan-500/50 bg-cyan-500/10 shadow-lg shadow-cyan-500/10',
      isError && 'border-red-500/50 bg-red-500/10',
      isCompleted && 'border-gray-500/30 bg-gray-500/5',
      !isActive && !isError && !isCompleted && 'border-cyan-500/30 bg-cyan-500/10',
    )}>
      <NodeHandles />
      <div className="flex items-center gap-2 mb-1.5">
        <Bot className="h-4 w-4 shrink-0" style={{ color }} />
        <div className="flex-1 min-w-0">
          <div className="text-[11px] font-bold truncate" style={{ color }}>{data.label}</div>
          {data.model && (
            <div className="text-[8px] text-gray-500 truncate">{shortModel(data.model)}</div>
          )}
        </div>
        <StatusLED status={data.status} small activity={data.vizActivity ?? 0} />
      </div>

      {/* Live current tool */}
      {data.currentTask && (
        <div className="flex items-center gap-1 text-[9px] text-cyan-300/90 truncate mb-1.5">
          <span className={cn('w-1.5 h-1.5 rounded-full bg-cyan-400 shrink-0', isActive && 'animate-pulse')} />
          <span className="truncate font-mono">{data.currentTask}</span>
        </div>
      )}

      {/* Metric grid: iterations, tools, cost, tokens */}
      <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[9px] mb-1.5">
        <div className="flex justify-between"><span className="text-gray-500">iter</span><span className="text-gray-300 font-mono">{data.iteration || 0}</span></div>
        <div className="flex justify-between"><span className="text-gray-500">tools</span><span className="text-yellow-400/90 font-mono">{data.toolCalls || 0}</span></div>
        <div className="flex justify-between"><span className="text-gray-500">tok</span><span className="text-gray-300 font-mono">{fmtCompact((data.tokensIn || 0) + (data.tokensOut || 0))}</span></div>
        <div className="flex justify-between"><span className="text-gray-500">cost</span><span className="text-emerald-400/90 font-mono">${(data.costUsd || 0).toFixed(3)}</span></div>
      </div>

      {/* Context-fill bar */}
      {data.ctxPct != null && data.ctxPct > 0 && (
        <div className="mb-1">
          <div className="flex justify-between text-[8px] text-gray-500 mb-0.5">
            <span>ctx</span><span className={cn('font-mono', data.ctxPct >= 90 ? 'text-red-400' : data.ctxPct >= 70 ? 'text-amber-400' : 'text-gray-400')}>{data.ctxPct}%</span>
          </div>
          <div className="h-1 rounded-full bg-slate-700/60 overflow-hidden">
            <div className={cn('h-full', data.ctxPct >= 90 ? 'bg-red-500' : data.ctxPct >= 70 ? 'bg-amber-500' : 'bg-cyan-500')} style={{ width: `${Math.min(100, data.ctxPct)}%` }} />
          </div>
        </div>
      )}

      {/* Last seen — prominent for finished agents (they reap ~30s after). */}
      {data.lastActivityAt && (
        <div className={cn('flex items-center gap-1 text-[8px]', isActive ? 'text-gray-600' : 'text-gray-500')}>
          {isCompleted && <span className="text-emerald-500/70">✓ done ·</span>}
          {isError && <span className="text-red-400/80">✕ failed ·</span>}
          <span>seen {fmtAgo(data.lastActivityAt, Date.now())}</span>
        </div>
      )}
    </div>
  );
}

function DeskNode({ data }: { data: OfficeNodeData }) {
  const color = data.color || '#374151';

  return (
    <div className={cn(
      'rounded-lg border border-dashed p-3 min-w-[120px] transition-all opacity-40',
      'border-gray-600 bg-gray-800/30',
    )}>
      <NodeHandles />
      <div className="flex items-center gap-2 mb-2">
        <Armchair className="h-4 w-4 text-gray-600" />
        <div className="flex-1 min-w-0">
          <div className="text-[10px] text-gray-500 truncate">{data.label}</div>
        </div>
        <StatusLED status={data.status} small activity={data.vizActivity ?? 0} />
      </div>
      <div className="text-[9px] text-gray-600">Available desk</div>
    </div>
  );
}

function MailboxNode({ data }: { data: OfficeNodeData }) {
  const color = data.color || '#eab308';
  const hasUnread = (data.unreadCount || 0) > 0;

  return (
    <div className={cn(
      'rounded-xl border-2 p-4 min-w-[160px] transition-all backdrop-blur-sm',
      hasUnread && 'border-yellow-500/50 bg-yellow-500/10 shadow-lg shadow-yellow-500/10',
      !hasUnread && 'border-yellow-500/30 bg-yellow-500/5',
    )}>
      <NodeHandles />
      <div className="flex items-center gap-3 mb-3">
        <div className={cn(
          'flex items-center justify-center w-10 h-10 rounded-lg',
          hasUnread ? 'bg-yellow-500/20' : 'bg-yellow-500/10',
        )}>
          <Mail className="h-5 w-5" style={{ color }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-bold" style={{ color }}>Mailbox Hub</div>
          <div className="text-[10px] text-gray-500">
            {hasUnread ? `${data.unreadCount} unread` : 'All clear'}
          </div>
        </div>
        {hasUnread && (
          <div className="w-5 h-5 rounded-full bg-yellow-500 text-black text-[10px] font-bold flex items-center justify-center">
            {data.unreadCount}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 text-[10px]">
        <div className="bg-black/20 rounded p-1.5 text-center">
          <div className="flex items-center justify-center gap-1 text-yellow-400">
            <Send className="h-3 w-3" />
            <span>{data.messageCount || 0}</span>
          </div>
          <div className="text-gray-500">Total</div>
        </div>
        <div className="bg-black/20 rounded p-1.5 text-center">
          <div className="flex items-center justify-center gap-1 text-emerald-400">
            <Inbox className="h-3 w-3" />
            <span>{data.unreadCount || 0}</span>
          </div>
          <div className="text-gray-500">Unread</div>
        </div>
      </div>

      {/* Most recent message subject — shows mail is actually flowing. */}
      {data.sublabel && (
        <div className="mt-2 truncate border-t border-white/5 pt-1.5 text-[9px] text-gray-400">
          ✉ {data.sublabel}
        </div>
      )}
    </div>
  );
}

// ── Node Type Map ────────────────────────────────────────────────────────────

const nodeTypes: NodeTypes = {
  webui: WebUINode,
  tui: TUINode,
  repl: REPLNode,
  coordinator: CoordinatorNode,
  agent: AgentNode,
  mailbox: MailboxNode,
  desk: DeskNode,
};

const edgeTypes: EdgeTypes = {
  wire: ({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    data,
    selected,
  }: any) => {
    const color = data?.color || '#6366f1';
    // Respect the global "animate edges" toggle from the settings panel.
    // SUBSCRIBE (not getState()) so toggling the setting re-renders the edges.
    const animateEdges = useOfficeMapStore((s) => s.animateEdges);
    const isAnimated = data?.animated && animateEdges;
    // Intensity (0–1) drives flow speed + glow — decays as activity fades.
    const intensity = isAnimated ? Math.max(0.15, data?.intensity ?? 0.6) : 0;

    // Clean React-Flow bezier between the top/bottom handles — no hand-rolled
    // upward arc that balloons for far-apart nodes.
    const [path, labelX, labelY] = getBezierPath({
      sourceX,
      sourceY,
      sourcePosition: sourcePosition ?? Position.Bottom,
      targetX,
      targetY,
      targetPosition: targetPosition ?? Position.Top,
      curvature: 0.28,
    });

    const dashLen = 5 + intensity * 7;
    const dashGap = 5 + intensity * 4;
    const period = dashLen + dashGap;
    const dur = `${Math.max(0.5, 1.6 - intensity).toFixed(2)}s`;

    return (
      <>
        {/* Base wire — always visible so the topology reads even when idle. */}
        <path
          d={path}
          fill="none"
          stroke={color}
          strokeWidth={selected ? 2.5 : 1.4}
          strokeOpacity={selected ? 0.9 : 0.28}
          className="react-flow__edge-path"
        />
        {/* Flowing dashes when active — direction shows source → target. */}
        {intensity > 0.05 && (
          <path
            d={path}
            fill="none"
            stroke={color}
            strokeWidth={2.2}
            strokeOpacity={0.45 + intensity * 0.5}
            strokeDasharray={`${dashLen} ${dashGap}`}
            strokeLinecap="round"
            style={{ filter: `drop-shadow(0 0 ${2 + intensity * 4}px ${color})` }}
          >
            <animate
              attributeName="stroke-dashoffset"
              from={period}
              to="0"
              dur={dur}
              repeatCount="indefinite"
            />
          </path>
        )}
        {/* Label only on active flow — keeps idle wires uncluttered. */}
        {data?.label && intensity > 0.1 && (
          <EdgeLabelRenderer>
            <div
              style={{
                position: 'absolute',
                transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              }}
              className="pointer-events-none rounded-full border border-white/15 bg-slate-800/90 px-1.5 py-0.5 text-[8px] font-medium text-white/85 backdrop-blur-sm"
            >
              {data.label}
            </div>
          </EdgeLabelRenderer>
        )}
      </>
    );
  },
};


/**
 * Bottom Live Activity strip — the most recent cross-process viz events
 * (tool calls, mail, provider/agent activity), newest first. Gives a running
 * log of "what just happened across the office" alongside the spatial map.
 */
function LiveFeed({ events, now }: { events: VizEvent[]; now: number }) {
  const recent = events.slice(0, 14);
  return (
    <div className="absolute bottom-0 left-0 right-0 z-10 pointer-events-none px-3 pb-3">
      <div className="pointer-events-auto rounded-lg bg-slate-900/85 border border-slate-700/70 backdrop-blur px-3 py-2 max-w-3xl mx-auto">
        <div className="flex items-center gap-1.5 mb-1.5 text-[10px] uppercase tracking-wide text-cyan-400/80">
          <Activity className="h-3 w-3" />
          Live activity
        </div>
        {recent.length === 0 ? (
          <div className="text-[11px] text-gray-500 italic">Waiting for activity…</div>
        ) : (
          <div className="flex flex-col gap-0.5 max-h-32 overflow-hidden">
            {recent.map((e) => {
              const ago = Math.max(0, Math.round((now - e.timestamp) / 1000));
              return (
                <div key={e.id} className="flex items-center gap-2 text-[11px] leading-tight">
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ backgroundColor: feedColor(e.kind) }}
                  />
                  <span className="text-gray-300 truncate flex-1">{e.label}</span>
                  <span className="text-gray-600 shrink-0 tabular-nums">
                    {ago < 1 ? 'now' : `${ago}s`}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main Canvas Component ────────────────────────────────────────────────────

export function OfficeMapCanvas() {
  const { fitView } = useReactFlow();

  // Store subscriptions
  const vizEvents = useVizStore((s) => s.events);
  const fleetAgents = useFleetStore((s) => s.agents);
  const leaderId = useFleetStore((s) => s.leaderId);

  // Live cross-process snapshot — the structural source of truth for the map.
  const liveSessions = useMonitorStore((s) => s.liveSessions);

  const mailboxMessages = useMailboxStore((s) => s.messages);
  const session = useSessionStore((s) => s.session);

  // Resolve the client/agent model once per snapshot/fleet change so the build
  // effect and the viz-overlay id-maps share a single source of truth.
  const clients = useMemo(
    () => resolveClients(liveSessions, fleetAgents),
    [liveSessions, fleetAgents],
  );

  // Display preferences (driven from OfficeMapSettingsPanel in the secondary panel).
  const showHud = useOfficeMapStore((s) => s.showHud);
  const showLegend = useOfficeMapStore((s) => s.showLegend);
  const showMinimap = useOfficeMapStore((s) => s.showMinimap);
  const showControls = useOfficeMapStore((s) => s.showControls);
  const animateEdges = useOfficeMapStore((s) => s.animateEdges);
  const showFeed = useOfficeMapStore((s) => s.showFeed);
  const setShowFeed = useOfficeMapStore((s) => s.setShowFeed);
  const background = useOfficeMapStore((s) => s.background);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<OfficeNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNode, setSelectedNode] = useState<Node<OfficeNodeData> | null>(null);
  // Expanded watch drawer — a full-height, wide overlay on the right of the
  // React-Flow canvas showing a selected agent/client's COMPLETE operation
  // stream (full history + composer), vs. the cramped popover preview.
  const [watch, setWatch] = useState<{ sessionId: string; label: string } | null>(null);
  // Broadcast composer — one message to every live session's leader.
  const [broadcastOpen, setBroadcastOpen] = useState(false);
  const [broadcastDraft, setBroadcastDraft] = useState('');
  const [broadcasting, setBroadcasting] = useState(false);
  const [broadcastResult, setBroadcastResult] = useState<string | null>(null);

  const sendBroadcast = useCallback(async () => {
    const text = broadcastDraft.trim();
    if (!text || broadcasting) return;
    setBroadcasting(true);
    setBroadcastResult(null);
    try {
      const res = await fetch('/api/fleet/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { delivered?: number; targets?: number };
      setBroadcastDraft('');
      setBroadcastResult(`Delivered to ${json.delivered ?? 0}/${json.targets ?? 0} session(s)`);
    } catch (e) {
      setBroadcastResult(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBroadcasting(false);
    }
  }, [broadcastDraft, broadcasting]);

  // Transient "active" highlights from viz events, keyed by node id → expiry ts.
  // The build effect overlays these so a full rebuild (triggered by any
  // mailbox/fleet change) doesn't erase a freshly-applied live status.
  const activeNodesRef = useRef<Map<string, number>>(new Map());
  const ACTIVE_MS = 4000;

  // Edge animation intensities keyed by office-map edge id (e.g. "coordinator->agent-1").
  // Written by the viz event handler, read by the wire edge component via subscription.
  const edgeIntensitiesRef = useRef<Map<string, number>>(new Map());

  // VizStore nodes/edges maps for activity-driven glow.
  const vizNodes = useVizStore((s) => s.nodes);
  const vizEdges = useVizStore((s) => s.edges);

  // Node activity: keyed by office-map node id, decays over time.
  const vizActivityRef = useRef<Map<string, number>>(new Map());

  // Computed floor-plan position per node id — the "home" the Arrange button
  // snaps dragged nodes back to. Refreshed every rebuild.
  const layoutPosRef = useRef<Map<string, { x: number; y: number }>>(new Map());

  // Previous (toolCalls, iteration) per agent — drives delta-based movement so a
  // cross-process agent's desk pulses whenever it advances between snapshots.
  const prevAgentStatsRef = useRef<Map<string, { toolCalls: number; iteration: number }>>(new Map());

  // Signature of the current node set. We only auto-fit the view when nodes are
  // added/removed — not on every data tick — so the canvas doesn't constantly
  // jump/recenter ("refresh atıyor") while agents are just updating counters.
  const prevNodeSigRef = useRef<string>('');

  // Build nodes from the live snapshot (clients/agents) + local fleet store.
  useEffect(() => {
    const rfNodes: Node<OfficeNodeData>[] = [];
    const rfEdges: Edge[] = [];
    const now = Date.now();

    // Widen client columns when any client fans out multiple agents, so one
    // client's agent fan never overlaps the neighbouring client's.
    const maxAgents = Math.max(1, ...clients.map((c) => c.agents.length || 1));
    const fanCols = Math.min(AGENT_COLS, maxAgents);
    const dynamicColW = Math.max(CLIENT_COL_W, fanCols * AGENT_FAN_W + 80);
    const clientXs = layoutClientXs(clients.map((c) => c.id), dynamicColW);

    // ── Mailbox Node ──────────────────────────────────────────────
    const unreadCount = mailboxMessages.filter(
      (m) => !m.completed && (m.readByCount ?? 0) === 0,
    ).length;

    // Most recent message (by timestamp) — surfaced on the node + detail panel.
    const lastMsg = mailboxMessages.length
      ? [...mailboxMessages].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0]
      : undefined;

    rfNodes.push({
      id: 'mailbox',
      type: 'mailbox',
      position: { x: CENTER_X + HUB_GAP, y: MAILBOX_Y },
      data: {
        label: 'Mailbox Hub',
        kind: 'mailbox',
        status: unreadCount > 0 ? 'active' : 'idle',
        unreadCount,
        messageCount: mailboxMessages.length,
        sublabel: lastMsg ? `${lastMsg.from} → ${lastMsg.to}: ${lastMsg.subject}` : undefined,
        color: '#eab308',
      },
    });

    // ── Fleet totals (project-wide, summed across every client's agents) ──
    let fleetActive = 0;
    let fleetAgentsTotal = 0;
    let fleetTools = 0;
    let fleetCost = 0;
    let fleetTokens = 0;
    for (const c of clients) {
      for (const a of c.agents) {
        fleetAgentsTotal += 1;
        if (a.status === 'active' || a.status === 'streaming') fleetActive += 1;
        fleetTools += a.toolCalls;
        fleetCost += a.costUsd;
        fleetTokens += a.tokensIn + a.tokensOut;
      }
    }

    // ── Coordinator Node — live fleet summary ─────────────────────
    const leaderAgent = leaderId ? fleetAgents.get(leaderId) : null;
    const anyAgentRunning = fleetActive > 0;

    rfNodes.push({
      id: 'coordinator',
      type: 'coordinator',
      position: { x: CENTER_X - HUB_GAP, y: COORD_Y },
      data: {
        label: 'Fleet HQ',
        sublabel: `${clients.length} client${clients.length === 1 ? '' : 's'}`,
        kind: 'coordinator',
        status:
          leaderAgent?.status === 'failed' ? 'error' : anyAgentRunning ? 'active' : 'idle',
        connections: clients.length,
        agentsActive: fleetActive,
        agentsTotal: fleetAgentsTotal,
        toolCalls: fleetTools,
        costUsd: fleetCost,
        tokensIn: fleetTokens,
        color: '#a855f7',
      },
    });

    // ── Per-client columns: client node + its agents/desks ─────────
    const clientColor: Record<'tui' | 'webui' | 'repl', string> = {
      tui: '#22c55e',
      webui: '#3b82f6',
      repl: '#f59e0b',
    };

    for (const client of clients) {
      const cx = clientXs.get(client.id) ?? CENTER_X;
      const color = clientColor[client.type];
      const clientActive = client.status === 'active';

      rfNodes.push({
        id: client.id,
        type: client.type,
        position: { x: cx, y: CLIENT_Y },
        data: {
          label: client.label,
          sublabel: client.sublabel,
          kind: client.type,
          status: client.status,
          sessionId: client.sessionId,
          pid: client.pid,
          branch: client.branch,
          workingDir: client.workingDir,
          startedAt: client.startedAt,
          agentCount: client.agents.length,
          color,
        },
      });

      // Wire: Client → Coordinator (uplink; animated while the client is busy)
      rfEdges.push({
        id: `${client.id}->coordinator`,
        source: client.id,
        target: 'coordinator',
        type: 'wire',
        animated: clientActive,
        data: { color, animated: clientActive, label: 'control', flowType: 'task' },
      });

      // Wire: Mailbox → Client
      rfEdges.push({
        id: `mailbox->${client.id}`,
        source: 'mailbox',
        target: client.id,
        type: 'wire',
        animated: unreadCount > 0,
        data: {
          color: '#eab308',
          animated: unreadCount > 0,
          label: unreadCount > 0 ? `${unreadCount}` : undefined,
          flowType: 'mail',
        },
      });

      if (client.agents.length === 0) {
        // Idle desk placeholder so the client never looks broken.
        rfNodes.push({
          id: `desk-${client.id}`,
          type: 'desk',
          position: { x: cx, y: AGENT_Y0 },
          data: { label: 'Idle desk', kind: 'agent', status: 'idle', color: '#374151' },
        });
        continue;
      }

      client.agents.forEach((agent, j) => {
        const isActive = agent.status === 'active' || agent.status === 'streaming';

        // ── Delta-driven movement ──────────────────────────────────
        // Pulse the desk + its wires when the agent advances (more tools /
        // iterations) or is actively running. Reuses the decay machinery.
        const prev = prevAgentStatsRef.current.get(agent.serverId);
        const advanced =
          (prev ? agent.toolCalls > prev.toolCalls || agent.iteration > prev.iteration : false) ||
          isActive;
        if (advanced) {
          activeNodesRef.current.set(agent.officeId, now + ACTIVE_MS);
          const cur = vizActivityRef.current.get(agent.officeId) ?? 0;
          vizActivityRef.current.set(agent.officeId, Math.min(1, cur + (1 - cur) * 0.5));
          for (const edgeId of [
            `${client.id}->${agent.officeId}`,
            `${client.id}->coordinator`,
          ]) {
            const e = edgeIntensitiesRef.current.get(edgeId) ?? 0;
            edgeIntensitiesRef.current.set(edgeId, Math.min(1, e + 0.5));
          }
        }
        prevAgentStatsRef.current.set(agent.serverId, {
          toolCalls: agent.toolCalls,
          iteration: agent.iteration,
        });

        rfNodes.push({
          id: agent.officeId,
          type: 'agent',
          position: agentFanPos(cx, j, client.agents.length),
          data: {
            label: agent.name,
            kind: 'agent',
            status: agent.status,
            sessionId: client.sessionId,
            currentTask: agent.currentTask,
            iteration: agent.iteration,
            toolCalls: agent.toolCalls,
            costUsd: agent.costUsd,
            tokensIn: agent.tokensIn,
            tokensOut: agent.tokensOut,
            ctxPct: agent.ctxPct,
            model: agent.model,
            lastActivityAt: agent.lastActivityAt,
            color: '#06b6d4',
          },
        });

        // Wire: Client → Agent. Agents belong to their owning client/session,
        // not the coordinator — so each desk hangs off its own client node.
        rfEdges.push({
          id: `${client.id}->${agent.officeId}`,
          source: client.id,
          target: agent.officeId,
          type: 'wire',
          animated: isActive,
          data: {
            color: '#06b6d4',
            animated: isActive,
            label: isActive ? agent.currentTask ?? 'task' : undefined,
            flowType: 'task',
          },
        });
      });
    }

    // Drop stale prev-stats for agents no longer present.
    const liveAgentIds = new Set(clients.flatMap((c) => c.agents.map((a) => a.serverId)));
    for (const id of [...prevAgentStatsRef.current.keys()]) {
      if (!liveAgentIds.has(id)) prevAgentStatsRef.current.delete(id);
    }

    // Re-apply still-live transient "active" highlights + activity glow so the
    // rebuild does not clobber state set by the viz-event/delta effects.
    const overlaidNodes = rfNodes.map((n) => {
      const until = activeNodesRef.current.get(n.id);
      const activity = vizActivityRef.current.get(n.id) ?? 0;
      if (until && until > now && n.data.status !== 'error' && n.data.status !== 'offline') {
        return { ...n, data: { ...n.data, status: 'active' as const, vizActivity: activity } };
      }
      return { ...n, data: { ...n.data, vizActivity: activity } };
    });

    // Overlay live edge intensities so a rebuild keeps animating wires that the
    // viz/delta effects lit (a fresh rebuild would otherwise reset them).
    const overlaidEdges = rfEdges.map((e) => {
      const intensity = edgeIntensitiesRef.current.get(e.id) ?? 0;
      if (intensity > 0.05) {
        return { ...e, animated: true, data: { ...e.data, animated: true, intensity } };
      }
      return e;
    });

    // Remember each node's computed home so "Arrange" can snap drags back.
    const home = new Map<string, { x: number; y: number }>();
    for (const n of overlaidNodes) home.set(n.id, { ...n.position });
    layoutPosRef.current = home;

    setNodes(overlaidNodes);
    setEdges(overlaidEdges);

    // Only re-fit when the node *set* changed (added/removed), not on every
    // counter update — otherwise the canvas recenters on each 5s snapshot.
    const sig = overlaidNodes.map((n) => n.id).sort().join('|');
    if (sig !== prevNodeSigRef.current) {
      prevNodeSigRef.current = sig;
      const fitTimer = setTimeout(() => fitView({ padding: 0.2, duration: 300 }), 50);
      return () => clearTimeout(fitTimer);
    }
    return undefined;
  }, [clients, leaderId, fleetAgents, mailboxMessages, session, ACTIVE_MS, setNodes, setEdges, fitView]);

  // ── Viz event → node/edge highlight mapping ─────────────────────────
  // Maps generic viz event sources to office-map node IDs.
  // Returns the set of office-map node IDs to highlight + edge IDs to animate.
  // ── Server-agent-ID → office-map-ID helpers ──────────────────────────
  // Office node ids mirror the server agent id 1:1 (`agent-<serverId>`), so the
  // mapping is direct. We still build the set of currently-rendered agents (from
  // the resolved client model) to scope mailbox/iteration fan-outs to real nodes.
  const renderedAgents = clients.flatMap((c) =>
    c.agents.map((a) => ({ clientId: c.id, clientType: c.type, officeId: a.officeId, serverId: a.serverId })),
  );
  const clientIds = clients.map((c) => c.id);

  // serverId → officeId for the viz overlay. Office ids are namespaced per
  // client, so a viz event (which only carries the bare agent id) maps to the
  // attached WebUI client's node when the same id exists in several sessions.
  const serverIdToOffice = new Map<string, string>();
  for (const a of renderedAgents) {
    if (!serverIdToOffice.has(a.serverId) || a.clientType === 'webui') {
      serverIdToOffice.set(a.serverId, a.officeId);
    }
  }

  function toOfficeAgentId(serverId: string): string {
    return serverIdToOffice.get(serverId) ?? `agent-${serverId}`;
  }

  // The structural wire for an agent is `client->agent`. Office ids are
  // namespaced `${clientId}__agent-${serverId}`, so the owning client id is the
  // prefix before `__agent-` (falls back to the coordinator edge for un-namespaced ids).
  function agentEdgeId(officeId: string): string {
    const clientId = officeId.split('__agent-')[0];
    return clientId && clientId !== officeId ? `${clientId}->${officeId}` : `coordinator->${officeId}`;
  }

  function vizEventToTargets(event: typeof vizEvents[0]): {
    nodes: string[];
    edges: string[];
    status: ClientStatus;
  } {
    switch (event.kind) {
      case 'mailbox:send':
      case 'mailbox:deliver':
        return {
          nodes: ['mailbox'],
          // Mail flows from the hub out to every connected client.
          edges: event.kind === 'mailbox:send'
            ? clientIds.map((id) => `mailbox->${id}`)
            : [],
          status: 'active',
        };

      case 'agent:spawned': {
        const officeId = toOfficeAgentId(event.source);
        return {
          nodes: ['coordinator', officeId],
          edges: [agentEdgeId(officeId)],
          status: 'active',
        };
      }

      case 'agent:tool':
      case 'tool:started':
      case 'tool:progress': {
        const officeId = toOfficeAgentId(event.source);
        return {
          nodes: ['coordinator', officeId],
          edges: [agentEdgeId(officeId)],
          status: event.kind === 'tool:progress' ? 'streaming' : event.kind === 'tool:started' ? 'streaming' : 'active',
        };
      }

      case 'tool:executed': {
        const officeId = toOfficeAgentId(event.target ?? event.source);
        return {
          nodes: [officeId],
          edges: [agentEdgeId(officeId)],
          status: 'active',
        };
      }

      case 'provider:call':
      case 'provider:delta':
      case 'provider:response':
        return {
          nodes: ['coordinator'],
          edges: [],
          status: event.kind === 'provider:delta' ? 'streaming' : 'active',
        };

      case 'iteration:start':
      case 'iteration:end':
        return {
          nodes: ['coordinator'],
          edges: renderedAgents.map((a) => agentEdgeId(a.officeId)),
          status: event.kind === 'iteration:start' ? 'streaming' : 'active',
        };

      case 'agent:text': {
        const officeId = toOfficeAgentId(event.source);
        return {
          nodes: [officeId],
          edges: [agentEdgeId(officeId)],
          status: 'streaming',
        };
      }

      case 'agent:status': {
        const officeId = toOfficeAgentId(event.source);
        return {
          nodes: ['coordinator', officeId],
          edges: [agentEdgeId(officeId)],
          status: event.data && typeof event.data === 'object' && 'status' in event.data && String((event.data as Record<string, unknown>).status) === 'failed' ? 'error' : 'completed',
        };
      }

      case 'agent:ctx': {
        const officeId = toOfficeAgentId(event.source);
        return {
          nodes: [officeId],
          edges: [],
          status: 'active',
        };
      }

      case 'budget:extended': {
        const officeId = toOfficeAgentId(event.source);
        return {
          nodes: ['coordinator', officeId],
          edges: [],
          status: 'active',
        };
      }

      case 'context:compacted':
      case 'context:repaired':
        return {
          nodes: ['coordinator'],
          edges: [],
          status: 'active',
        };

      case 'error':
        return {
          nodes: event.source ? [toOfficeAgentId(event.source)] : [],
          edges: [],
          status: 'error',
        };

      case 'cost:update':
        return {
          nodes: ['coordinator'],
          edges: [],
          status: 'active',
        };

      case 'fleet:snapshot': {
        // sessions.status_update periodic broadcast — update all active agent nodes
        const sessions = (event.data as { sessions?: Array<{ id: string; status: string; agents?: Array<{ id: string; name: string; status: string }> }> | undefined })?.sessions ?? [];
        const nodes: string[] = ['coordinator'];
        for (const session of sessions) {
          if (session.agents) {
            for (const agent of session.agents) {
              const officeId = toOfficeAgentId(agent.id);
              if (!nodes.includes(officeId)) nodes.push(officeId);
            }
          }
        }
        return { nodes, edges: [], status: 'active' };
      }

      default:
        return { nodes: [], edges: [], status: 'idle' };
    }
  }

  // Handle viz events for live updates — now handles ALL event types.
  useEffect(() => {
    if (vizEvents.length === 0) return;

    const latestEvent = vizEvents[0];
    if (!latestEvent) return;

    const { nodes: targetNodes, edges: targetEdges, status } = vizEventToTargets(latestEvent);
    const now = Date.now();

    // Highlight target nodes and boost their activity
    if (targetNodes.length > 0) {
      targetNodes.forEach((nodeId) => {
        activeNodesRef.current.set(nodeId, now + ACTIVE_MS);
        const currentActivity = vizActivityRef.current.get(nodeId) ?? 0;
        // Boost: new activity = existing + (1 - existing) * 0.5 so repeated events saturate toward 1
        vizActivityRef.current.set(nodeId, Math.min(1, currentActivity + (1 - currentActivity) * 0.5));
      });

      setNodes((nds) =>
        nds.map((n) =>
          targetNodes.includes(n.id)
            ? {
                ...n,
                data: {
                  ...n.data,
                  status: status as ClientStatus,
                  vizActivity: vizActivityRef.current.get(n.id) ?? 0,
                },
              }
            : n,
        ),
      );
    }

    // Animate target edges — boost their intensity.
    if (targetEdges.length > 0) {
      targetEdges.forEach((edgeId) => {
        const current = edgeIntensitiesRef.current.get(edgeId) ?? 0;
        edgeIntensitiesRef.current.set(edgeId, Math.min(1, current + 0.5));
      });

      setEdges((eds) =>
        eds.map((e) =>
          targetEdges.includes(e.id)
            ? {
                ...e,
                animated: true,
                data: {
                  ...e.data,
                  animated: true,
                  intensity: edgeIntensitiesRef.current.get(e.id) ?? 1,
                },
              }
            : e,
        ),
      );
    }
  }, [vizEvents, setNodes, setEdges, ACTIVE_MS, fleetAgents]);

  // Decay edge intensities and node activity over time (runs every second).
  useEffect(() => {
    const interval = setInterval(() => {
      // Decay edge intensities
      for (const [id, intensity] of edgeIntensitiesRef.current) {
        const decayed = intensity * 0.85;
        if (decayed < 0.05) {
          edgeIntensitiesRef.current.delete(id);
          setEdges((eds) =>
            eds.map((e) =>
              e.id === id
                ? { ...e, animated: false, data: { ...e.data, animated: false } }
                : e,
            ),
          );
        } else {
          edgeIntensitiesRef.current.set(id, decayed);
          setEdges((eds) =>
            eds.map((e) =>
              e.id === id ? { ...e, data: { ...e.data, intensity: decayed } } : e,
            ),
          );
        }
      }

      // Decay node activity
      let nodesChanged = false;
      for (const [id, activity] of vizActivityRef.current) {
        const decayed = activity * 0.90;
        if (decayed < 0.03) {
          vizActivityRef.current.delete(id);
          // Clear activity from node data
          setNodes((nds) =>
            nds.map((n) =>
              n.id === id ? { ...n, data: { ...n.data, vizActivity: 0 } } : n,
            ),
          );
        } else {
          vizActivityRef.current.set(id, decayed);
          setNodes((nds) =>
            nds.map((n) =>
              n.id === id ? { ...n, data: { ...n.data, vizActivity: decayed } } : n,
            ),
          );
        }
        nodesChanged = true;
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [setEdges, setNodes]);

  const onConnect = useCallback(
    (params: Connection) => setEdges((eds) => addEdge({ ...params, type: 'wire' }, eds)),
    [setEdges],
  );

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNode(node as Node<OfficeNodeData>);
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
  }, []);

  // Esc closes the expanded watch drawer first (leaving the node selected),
  // so a single Esc dismisses the big overlay without also deselecting.
  useEffect(() => {
    if (!watch) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setWatch(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [watch]);

  // Snap every node back to its computed floor-plan home, then re-fit. Lets the
  // user tidy the office after dragging nodes around.
  const onArrange = useCallback(() => {
    setNodes((nds) =>
      nds.map((n) => {
        const home = layoutPosRef.current.get(n.id);
        return home ? { ...n, position: { ...home } } : n;
      }),
    );
    setTimeout(() => fitView({ padding: 0.2, duration: 300 }), 50);
  }, [setNodes, fitView]);

  // Live indicator pulse
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 2000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="w-full h-full bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 relative overflow-hidden">
      {/* Grid background */}
      <div
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage: `
            linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)
          `,
          backgroundSize: '40px 40px',
        }}
      />

      {/* Real-time Stats HUD */}
      {showHud && <StatsHUD />}

      {/* Room labels */}
      <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10">
        <div className="bg-slate-800/90 backdrop-blur px-4 py-2 rounded-lg border border-slate-700 shadow-xl">
          <div className="text-xs font-bold text-slate-300 flex items-center gap-2">
            <Building2 className="h-4 w-4 text-purple-400" />
            WrongStack Fleet HQ
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse ml-2" />
            <span className="text-[10px] text-gray-400 font-normal">LIVE</span>
          </div>
        </div>
      </div>

      {/* Legend */}
      {showLegend && (
      <div className="absolute bottom-4 left-4 z-10 bg-slate-800/90 backdrop-blur rounded-lg border border-slate-700 p-3 text-[10px]">
        <div className="font-bold text-gray-300 mb-2">Status</div>
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-gray-400">Active</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-gray-500" />
            <span className="text-gray-400">Idle</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            <span className="text-gray-400">Error</span>
          </div>
        </div>
      </div>
      )}

      {/* Connection type legend */}
      {showLegend && (
      <div className="absolute bottom-4 right-4 z-10 bg-slate-800/90 backdrop-blur rounded-lg border border-slate-700 p-3 text-[10px]">
        <div className="font-bold text-gray-300 mb-2">Connections</div>
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-yellow-400">✉</span>
            <span className="text-gray-400">Mail</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-purple-400">→</span>
            <span className="text-gray-400">Task</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-emerald-400">●</span>
            <span className="text-gray-400">Status</span>
          </div>
        </div>
      </div>
      )}

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
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.3}
        maxZoom={1.5}
        defaultEdgeOptions={{
          type: 'wire',
        }}
        proOptions={{ hideAttribution: true }}
      >
        <Panel position="top-right" className="flex items-center gap-2">
          <button
            type="button"
            onClick={onArrange}
            title="Snap nodes back to the floor plan"
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-slate-800/90 border border-slate-700 text-xs text-slate-200 hover:bg-slate-700 transition-colors"
          >
            <LayoutGrid className="h-3.5 w-3.5" />
            Arrange
          </button>
          <button
            type="button"
            onClick={() => setShowFeed(!showFeed)}
            title="Toggle the live activity feed"
            className={cn(
              'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-xs transition-colors',
              showFeed
                ? 'bg-cyan-500/20 border-cyan-500/40 text-cyan-300'
                : 'bg-slate-800/90 border-slate-700 text-slate-300 hover:bg-slate-700',
            )}
          >
            <ScrollText className="h-3.5 w-3.5" />
            Feed
          </button>
          <button
            type="button"
            onClick={() => setBroadcastOpen((v) => !v)}
            title="Broadcast a message to every live session in this project"
            className={cn(
              'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-xs transition-colors',
              broadcastOpen
                ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                : 'bg-slate-800/90 border-slate-700 text-slate-300 hover:bg-slate-700',
            )}
          >
            <Send className="h-3.5 w-3.5" />
            Broadcast
          </button>
        </Panel>
        {background !== 'none' && (
          <Background
            variant={
              background === 'lines'
                ? BackgroundVariant.Lines
                : background === 'cross'
                  ? BackgroundVariant.Cross
                  : BackgroundVariant.Dots
            }
            gap={20}
            size={1}
            color="rgba(255,255,255,0.05)"
          />
        )}
        {showControls && (
        <Controls
          className="bg-slate-800 border border-slate-700 rounded-lg [&>button]:bg-slate-700 [&>button]:text-slate-200"
        />
        )}
        {showMinimap && (
        <MiniMap
          className="bg-slate-800/90 border border-slate-700 rounded-lg"
          nodeColor={(n) => {
            const data = n.data as OfficeNodeData;
            switch (data.kind) {
              case 'coordinator':
                return '#a855f7';
              case 'webui':
                return '#3b82f6';
              case 'tui':
                return '#22c55e';
              case 'repl':
                return '#f59e0b';
              case 'mailbox':
                return '#eab308';
              case 'agent':
                return '#06b6d4';
              default:
                return '#6366f1';
            }
          }}
          maskColor="rgba(0,0,0,0.8)"
        />
        )}
      </ReactFlow>

      {showFeed && <LiveFeed events={vizEvents} now={Date.now()} />}

      {/* Broadcast composer — fan one message out to every live session's leader. */}
      {broadcastOpen && (
        <div className="absolute top-16 right-4 z-30 w-80 rounded-lg border border-amber-500/40 bg-slate-900/97 p-3 shadow-2xl backdrop-blur">
          <div className="mb-1.5 flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-300">
              <Send className="h-3.5 w-3.5" /> Broadcast to all sessions
            </div>
            <button
              type="button"
              onClick={() => setBroadcastOpen(false)}
              className="text-gray-400 hover:text-white text-base leading-none"
            >
              ×
            </button>
          </div>
          <textarea
            value={broadcastDraft}
            onChange={(ev) => setBroadcastDraft(ev.target.value)}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
                ev.preventDefault();
                void sendBroadcast();
              }
            }}
            rows={3}
            placeholder="Message every live agent in this project…"
            className="w-full resize-none rounded-md border border-slate-700 bg-slate-900/70 px-2 py-1 text-[11px] text-gray-200 placeholder:text-gray-600 focus:border-amber-500/50 focus:outline-none"
          />
          <div className="mt-1.5 flex items-center justify-between">
            <span className="text-[9px] text-gray-600">⌘/Ctrl+Enter to send</span>
            <button
              type="button"
              onClick={() => void sendBroadcast()}
              disabled={broadcasting || !broadcastDraft.trim()}
              className="rounded-md border border-amber-500/40 bg-amber-500/20 px-2.5 py-1 text-[11px] text-amber-200 transition-colors hover:bg-amber-500/30 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {broadcasting ? '…' : 'Broadcast'}
            </button>
          </div>
          {broadcastResult && (
            <div className="mt-1 text-[10px] text-gray-400">{broadcastResult}</div>
          )}
        </div>
      )}

      {/* Selected node detail panel */}
      {selectedNode && (
        <div
          className={cn(
            'absolute top-20 right-4 bg-background border border-border rounded-lg p-4 shadow-xl z-20',
            selectedNode.data.sessionId ? 'w-80' : 'w-64',
          )}
        >
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              {selectedNode.data.kind === 'webui' && <Monitor className="h-4 w-4 text-blue-500" />}
              {selectedNode.data.kind === 'tui' && <Terminal className="h-4 w-4 text-emerald-500" />}
              {selectedNode.data.kind === 'coordinator' && <Cpu className="h-4 w-4 text-purple-500" />}
              {selectedNode.data.kind === 'agent' && <Bot className="h-4 w-4 text-cyan-500" />}
              {selectedNode.data.kind === 'mailbox' && <Mail className="h-4 w-4 text-yellow-500" />}
              <span className="text-sm font-bold text-foreground">{selectedNode.data.label}</span>
            </div>
            <div className="flex items-center gap-1.5">
              {selectedNode.data.sessionId && (
                <button
                  type="button"
                  title="Open full operation view"
                  onClick={() =>
                    setWatch({
                      sessionId: selectedNode.data.sessionId!,
                      label: selectedNode.data.label,
                    })
                  }
                  className="text-muted-foreground hover:text-primary"
                >
                  <Maximize2 className="h-3.5 w-3.5" />
                </button>
              )}
              <button
                onClick={onPaneClick}
                className="text-muted-foreground hover:text-foreground text-lg leading-none"
              >
                ×
              </button>
            </div>
          </div>

          {(() => {
            const d = selectedNode.data;
            const now = Date.now();
            const Row = ({ k, v, accent }: { k: string; v: React.ReactNode; accent?: string }) => (
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground shrink-0">{k}</span>
                <span className={cn('font-mono truncate text-right', accent ?? 'text-foreground/80')}>{v}</span>
              </div>
            );
            const isAgent = d.kind === 'agent';
            const isClient = d.kind === 'webui' || d.kind === 'tui' || d.kind === 'repl';
            const tokTotal = (d.tokensIn || 0) + (d.tokensOut || 0);
            return (
              <div className="space-y-1.5 text-xs">
                <Row
                  k="Status"
                  v={String(d.status).toUpperCase()}
                  accent={cn(
                    d.status === 'active' && 'text-emerald-600 dark:text-emerald-400',
                    d.status === 'streaming' && 'text-blue-600 dark:text-blue-400',
                    d.status === 'error' && 'text-destructive',
                    d.status === 'idle' && 'text-muted-foreground',
                    d.status === 'offline' && 'text-muted-foreground/50',
                  )}
                />

                {isAgent && (
                  <>
                    {d.model && <Row k="Model" v={shortModel(d.model)} accent="text-cyan-600 dark:text-cyan-400" />}
                    {d.currentTask && <Row k="Tool" v={d.currentTask} accent="text-cyan-600 dark:text-cyan-400" />}
                    <Row k="Iterations" v={d.iteration || 0} accent="text-cyan-600 dark:text-cyan-400" />
                    <Row k="Tool calls" v={d.toolCalls || 0} accent="text-amber-600 dark:text-amber-400" />
                    <Row k="Tokens in" v={fmtCompact(d.tokensIn)} />
                    <Row k="Tokens out" v={fmtCompact(d.tokensOut)} />
                    <Row k="Tokens total" v={fmtCompact(tokTotal)} />
                    {d.ctxPct != null && d.ctxPct > 0 && (
                      <Row k="Context" v={`${d.ctxPct}%`} accent={d.ctxPct >= 90 ? 'text-destructive' : d.ctxPct >= 70 ? 'text-amber-600 dark:text-amber-400' : 'text-foreground/70'} />
                    )}
                    <Row k="Cost" v={`$${(d.costUsd || 0).toFixed(4)}`} accent="text-emerald-600 dark:text-emerald-400" />
                    {d.lastActivityAt && <Row k="Last seen" v={fmtAgo(d.lastActivityAt, now)} accent="text-muted-foreground" />}
                  </>
                )}

                {isClient && (
                  <>
                    <Row k="Surface" v={surfaceLabel(d.kind as 'tui' | 'webui' | 'repl')} accent="text-foreground/80" />
                    {d.branch && <Row k="Branch" v={`⎇ ${d.branch}`} accent="text-foreground/70" />}
                    {d.pid != null && <Row k="PID" v={d.pid} />}
                    {d.workingDir && <Row k="Dir" v={d.workingDir} accent="text-muted-foreground" />}
                    <Row k="Agents" v={d.agentCount ?? 0} accent="text-cyan-600 dark:text-cyan-400" />
                    {d.startedAt && <Row k="Uptime" v={fmtUptime(d.startedAt, now)} accent="text-foreground/70" />}
                  </>
                )}

                {d.kind === 'mailbox' && (
                  <>
                    <Row k="Total messages" v={d.messageCount || 0} accent="text-amber-600 dark:text-amber-400" />
                    <Row k="Unread" v={d.unreadCount || 0} accent="text-amber-600 dark:text-amber-400" />
                    {mailboxMessages.length > 0 && (
                      <div className="mt-1 space-y-1 border-t border-border pt-2">
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Recent</div>
                        {[...mailboxMessages]
                          .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
                          .slice(0, 6)
                          .map((m) => {
                            const unread = !m.completed && (m.readByCount ?? 0) === 0;
                            return (
                              <div key={m.id} className="flex items-start gap-1.5 text-[10px]">
                                <span
                                  className={cn(
                                    'mt-1 h-1.5 w-1.5 shrink-0 rounded-full',
                                    unread ? 'bg-amber-500' : m.completed ? 'bg-emerald-500' : 'bg-muted',
                                  )}
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-foreground/80">{m.subject || '(no subject)'}</div>
                                  <div className="truncate font-mono text-[9px] text-muted-foreground">
                                    {m.from} → {m.to} · {fmtAgo(m.timestamp, now)}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                      </div>
                    )}
                  </>
                )}

                {d.kind === 'coordinator' && (
                  <>
                    <Row k="Connections" v={d.connections || 0} accent="text-purple-600 dark:text-purple-400" />
                    <Row k="Iterations" v={d.iteration || 0} accent="text-purple-600 dark:text-purple-400" />
                  </>
                )}

                {(isAgent || isClient) && d.sessionId && (
                  <div className="mt-2 border-t border-border pt-2 h-72">
                    <SessionWatchPanel sessionId={d.sessionId} />
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}

      {/* Expanded watch drawer — full-height, wide overlay on the right showing
          the selected agent/client's COMPLETE operation stream + composer. */}
      {watch && (
        <div className="absolute inset-y-0 right-0 z-30 flex w-[min(680px,92%)] flex-col border-l border-border bg-background shadow-2xl">
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5 shrink-0 bg-card">
            <div className="flex items-center gap-2 min-w-0">
              <Bot className="h-4 w-4 text-primary shrink-0" />
              <div className="min-w-0">
                <div className="truncate text-sm font-bold text-foreground">{watch.label}</div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Full operation stream
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setWatch(null)}
              title="Close (Esc)"
              className="text-muted-foreground hover:text-foreground text-xl leading-none shrink-0"
            >
              ×
            </button>
          </div>
          <div className="flex-1 min-h-0 p-4">
            <SessionWatchPanel sessionId={watch.sessionId} limit={500} />
          </div>
        </div>
      )}
    </div>
  );
}
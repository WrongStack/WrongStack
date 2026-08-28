/**
 * Node components and shared constants for the OfficeMapCanvas.
 *
 * Extracted from OfficeMapCanvas.tsx to keep the main file under the
 * 2000-line hotspot guardrail. All React Flow node renderers, the
 * StatusLED, NodeHandles, ClientMeta helpers, and the nodeTypes map
 * live here.
 */
import { Handle, type NodeTypes, Position } from '@xyflow/react';
import {
  Armchair,
  Bot,
  Cpu,
  Inbox,
  Mail,
  Send,
  Terminal,
  Monitor,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import type { ClientStatus } from './utils.js';
import {
  compactFlowLabel,
  fmtAgo,
  fmtCompact,
  fmtUptime,
  type OfficeNodeData,
  shortModel,
} from './utils.js';

// ── Constants ─────────────────────────────────────────────────────────────

export const OFFICE_COLOR = {
  primary: 'hsl(var(--primary))',
  info: 'hsl(var(--info))',
  success: 'hsl(var(--success))',
  warning: 'hsl(var(--warning))',
  destructive: 'hsl(var(--destructive))',
  muted: 'hsl(var(--muted-foreground))',
} as const;

export const FIT_VIEW_PADDING = 0.12;

export function clampCtxPct(value: number | null | undefined): number {
  return Math.min(100, Math.max(0, value ?? 0));
}

// ── Status LED ────────────────────────────────────────────────────────────

function StatusLED({
  status,
  small,
  activity = 0,
}: {
  status: ClientStatus;
  small?: boolean;
  activity?: number;
}) {
  const size = small ? 'w-2 h-2' : 'w-3 h-3';

  const glowRadius = small ? 4 + activity * 4 : 6 + activity * 6;

  const baseColor: Record<ClientStatus, string> = {
    idle: 'bg-muted-foreground',
    active: 'bg-success',
    streaming: 'bg-primary',
    completed: 'bg-primary',
    error: 'bg-destructive',
    offline: 'bg-muted-foreground/60',
  };

  const glowColor: Record<ClientStatus, string> = {
    idle: OFFICE_COLOR.muted,
    active: OFFICE_COLOR.success,
    streaming: OFFICE_COLOR.primary,
    completed: OFFICE_COLOR.primary,
    error: OFFICE_COLOR.destructive,
    offline: OFFICE_COLOR.muted,
  };

  return (
    <span
      className={cn('rounded-full', size, activity > 0 && 'animate-pulse', baseColor[status])}
      style={{
        boxShadow: activity > 0 ? `0 0 ${glowRadius}px ${glowColor[status]}` : undefined,
      }}
    />
  );
}

// ── Shared helpers ────────────────────────────────────────────────────────

function NodeHandles() {
  const style = {
    opacity: 0,
    width: 1,
    height: 1,
    minWidth: 0,
    border: 'none',
    background: 'transparent',
  } as const;
  return (
    <>
      <Handle type="target" position={Position.Top} style={style} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} style={style} isConnectable={false} />
    </>
  );
}

function ClientMeta({ data }: { data: OfficeNodeData }) {
  const { t } = useAppTranslation();
  return (
    <div className="mt-2 flex items-center justify-between border-t border-border/60 pt-1.5 text-[10px] text-muted-foreground">
      <span>
        <span className="font-mono text-foreground">{data.agentCount ?? 0}</span>{' '}
        {t('activity:office.agentsSuffix')}
      </span>
      {data.startedAt && (
        <span>
          {t('activity:office.upPrefix', { time: fmtUptime(data.startedAt, Date.now()) })}
        </span>
      )}
    </div>
  );
}

// ── Node Components ───────────────────────────────────────────────────────

function WebUINode({ data }: { data: OfficeNodeData }) {
  const { t } = useAppTranslation();
  const isActive = data.status === 'active' || data.status === 'streaming';
  const isError = data.status === 'error';
  const isOffline = data.status === 'offline';
  const color = data.color || OFFICE_COLOR.info;

  return (
    <div
      className={cn(
        'rounded-xl border-2 p-4 min-w-[180px] transition-all backdrop-blur-sm',
        isActive && 'shadow-lg shadow-primary/15',
        isError && 'border-destructive/50 bg-destructive/10',
        isOffline && 'border-border/70 bg-muted/35 opacity-60',
        !isActive && !isError && !isOffline && 'border-primary/30 bg-primary/10',
      )}
    >
      <NodeHandles />
      <div className="flex items-center gap-3 mb-3">
        <div
          className={cn(
            'flex items-center justify-center w-10 h-10 rounded-lg',
            isActive ? 'bg-primary/15' : 'bg-primary/10',
          )}
        >
          <Monitor className="h-5 w-5" style={{ color }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-bold truncate" style={{ color }}>
            {data.label}
          </div>
          <div className="text-[10px] text-muted-foreground">
            {t('activity:office.webuiClient')}
          </div>
        </div>
        <StatusLED status={data.status} activity={data.vizActivity ?? 0} />
      </div>

      {data.sublabel && (
        <div className="mb-2 truncate text-[10px] text-muted-foreground">{data.sublabel}</div>
      )}

      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        {isOffline ? (
          <>
            <WifiOff className="h-3 w-3 text-muted-foreground" />
            <span>{t('activity:office.disconnected')}</span>
          </>
        ) : (
          <>
            <Wifi className="h-3 w-3 text-success" />
            <span>{t('activity:office.connected')}</span>
          </>
        )}
      </div>

      {isActive && (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-primary/20">
          <div className="h-full animate-pulse bg-primary" style={{ width: '60%' }} />
        </div>
      )}

      <ClientMeta data={data} />
    </div>
  );
}

function TUINode({ data }: { data: OfficeNodeData }) {
  const { t } = useAppTranslation();
  const isActive = data.status === 'active' || data.status === 'streaming';
  const isError = data.status === 'error';
  const color = data.color || OFFICE_COLOR.success;

  return (
    <div
      className={cn(
        'rounded-xl border-2 p-4 min-w-[180px] transition-all backdrop-blur-sm',
        isActive && 'shadow-lg shadow-success/15',
        isError && 'border-destructive/50 bg-destructive/10',
        !isActive && !isError && 'border-success/30 bg-success/10',
      )}
    >
      <NodeHandles />
      <div className="flex items-center gap-3 mb-3">
        <div
          className={cn(
            'flex items-center justify-center w-10 h-10 rounded-lg',
            isActive ? 'bg-success/15' : 'bg-success/10',
          )}
        >
          <Terminal className="h-5 w-5" style={{ color }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-bold truncate" style={{ color }}>
            {data.label}
          </div>
          <div className="text-[10px] text-muted-foreground">{t('activity:office.tuiClient')}</div>
        </div>
        <StatusLED status={data.status} activity={data.vizActivity ?? 0} />
      </div>

      {data.sublabel && (
        <div className="mb-2 truncate text-[10px] text-muted-foreground">{data.sublabel}</div>
      )}

      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <Terminal className="h-3 w-3 text-success" />
        <span>{t('activity:office.terminal')}</span>
      </div>

      <ClientMeta data={data} />
    </div>
  );
}

function REPLNode({ data }: { data: OfficeNodeData }) {
  const { t } = useAppTranslation();
  const isActive = data.status === 'active' || data.status === 'streaming';
  const color = data.color || OFFICE_COLOR.warning;

  return (
    <div
      className={cn(
        'rounded-xl border-2 p-4 min-w-[160px] transition-all backdrop-blur-sm',
        isActive && 'shadow-lg shadow-warning/15',
        !isActive && 'border-warning/30 bg-warning/10',
      )}
    >
      <NodeHandles />
      <div className="flex items-center gap-3 mb-3">
        <div
          className={cn(
            'flex items-center justify-center w-10 h-10 rounded-lg',
            isActive ? 'bg-warning/15' : 'bg-warning/10',
          )}
        >
          <Terminal className="h-5 w-5" style={{ color }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-bold truncate" style={{ color }}>
            {data.label}
          </div>
          <div className="text-[10px] text-muted-foreground">{t('activity:office.repl')}</div>
        </div>
        <StatusLED status={data.status} activity={data.vizActivity ?? 0} />
      </div>

      {data.sublabel && (
        <div className="mb-1 truncate text-[10px] text-muted-foreground">{data.sublabel}</div>
      )}

      <ClientMeta data={data} />
    </div>
  );
}

function CoordinatorNode({ data }: { data: OfficeNodeData }) {
  const { t } = useAppTranslation();
  const isActive = data.status === 'active' || data.status === 'streaming';
  const color = data.color || OFFICE_COLOR.primary;

  return (
    <div className="relative min-w-[200px] rounded-xl border-2 border-border/70 bg-card/90 p-4 shadow-lg backdrop-blur-sm transition-all">
      <NodeHandles />
      <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-primary px-2 py-0.5 text-[11px] font-bold text-primary-foreground">
        {t('activity:office.coordinator')}
      </div>

      <div className="flex items-center gap-3 mb-3 mt-2">
        <div
          className={cn(
            'flex items-center justify-center w-12 h-12 rounded-xl',
            isActive ? 'bg-primary/15' : 'bg-primary/10',
          )}
        >
          <Cpu className="h-6 w-6" style={{ color }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold truncate" style={{ color }}>
            {data.label}
          </div>
          <div className="text-[10px] text-muted-foreground">
            {data.sublabel || t('activity:office.fleetSummary')}
          </div>
        </div>
        <StatusLED status={data.status} activity={data.vizActivity ?? 0} />
      </div>

      <div className="grid grid-cols-2 gap-2 text-[10px] mb-2">
        <div className="rounded bg-muted/40 p-1.5 text-center">
          <div className="font-mono">
            <span className="text-success">{data.agentsActive || 0}</span>
            <span className="text-muted-foreground"> / </span>
            <span className="text-primary">{data.agentsTotal || 0}</span>
          </div>
          <div className="text-muted-foreground">{t('activity:officeMap.agents')}</div>
        </div>
        <div className="rounded bg-muted/40 p-1.5 text-center">
          <div className="font-mono text-warning">{(data.toolCalls || 0).toLocaleString()}</div>
          <div className="text-muted-foreground">{t('activity:office.toolCallsLabel')}</div>
        </div>
        <div className="rounded bg-muted/40 p-1.5 text-center">
          <div className="font-mono text-foreground">{fmtCompact(data.tokensIn)}</div>
          <div className="text-muted-foreground">{t('activity:office.tokensLabel')}</div>
        </div>
        <div className="rounded bg-muted/40 p-1.5 text-center">
          <div className="font-mono text-success">${(data.costUsd || 0).toFixed(3)}</div>
          <div className="text-muted-foreground">{t('activity:office.cost')}</div>
        </div>
      </div>

      {isActive && (
        <div className="flex items-center gap-2 text-[10px] text-primary">
          <span className="h-2 w-2 animate-pulse rounded-full bg-primary" />
          {t('activity:office.coordinatingFleet')}
        </div>
      )}
    </div>
  );
}

function AgentNode({ data }: { data: OfficeNodeData }) {
  const { t } = useAppTranslation();
  const isActive = data.status === 'active' || data.status === 'streaming';
  const isError = data.status === 'error';
  const isCompleted = data.status === 'completed';
  const color = data.color || OFFICE_COLOR.primary;
  const ctxPct = clampCtxPct(data.ctxPct);

  return (
    <div
      className={cn(
        'w-[170px] min-w-0 max-w-[170px] overflow-hidden rounded-lg border p-3 transition-all backdrop-blur-sm',
        isActive && 'border-primary/50 bg-primary/10 shadow-lg shadow-primary/10',
        isError && 'border-destructive/50 bg-destructive/10',
        isCompleted && 'border-border/70 bg-muted/35',
        !isActive && !isError && !isCompleted && 'border-primary/30 bg-primary/10',
      )}
    >
      <NodeHandles />
      <div className="flex items-center gap-2 mb-1.5">
        <Bot className="h-4 w-4 shrink-0" style={{ color }} />
        <div className="flex-1 min-w-0">
          <div className="text-[11px] font-bold truncate" style={{ color }}>
            {data.label}
          </div>
          {data.model && (
            <div className="truncate text-[10px] text-muted-foreground">
              {shortModel(data.model)}
            </div>
          )}
        </div>
        <StatusLED status={data.status} small activity={data.vizActivity ?? 0} />
      </div>

      {data.currentTask && (
        <div className="mb-1.5 flex min-w-0 items-center gap-1 overflow-hidden text-[11px] text-primary">
          <span
            className={cn(
              'h-1.5 w-1.5 shrink-0 rounded-full bg-primary',
              isActive && 'animate-pulse',
            )}
          />
          <span className="min-w-0 truncate font-mono" title={data.currentTask}>
            {compactFlowLabel(data.currentTask, 72)}
          </span>
        </div>
      )}

      <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[11px] mb-1.5">
        <div className="flex justify-between">
          <span className="text-muted-foreground">iter</span>
          <span className="font-mono text-foreground">{data.iteration || 0}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">tools</span>
          <span className="font-mono text-warning">{data.toolCalls || 0}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">tok</span>
          <span className="font-mono text-foreground">
            {fmtCompact((data.tokensIn || 0) + (data.tokensOut || 0))}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">cost</span>
          <span className="font-mono text-success">${(data.costUsd || 0).toFixed(3)}</span>
        </div>
      </div>

      {ctxPct > 0 && (
        <div className="mb-1">
          <div className="mb-0.5 flex justify-between text-[10px] text-muted-foreground">
            <span>ctx</span>
            <span
              className={cn(
                'font-mono',
                ctxPct >= 90
                  ? 'text-destructive'
                  : ctxPct >= 70
                    ? 'text-warning'
                    : 'text-muted-foreground',
              )}
            >
              {ctxPct}%
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                'h-full',
                ctxPct >= 90 ? 'bg-destructive' : ctxPct >= 70 ? 'bg-warning' : 'bg-primary',
              )}
              style={{ width: `${ctxPct}%` }}
            />
          </div>
        </div>
      )}

      {data.lastActivityAt && (
        <div
          className={cn(
            'flex items-center gap-1 text-[10px]',
            isActive ? 'text-muted-foreground/70' : 'text-muted-foreground',
          )}
        >
          {isCompleted && <span className="text-success">{t('activity:office.donePrefix')}</span>}
          {isError && <span className="text-destructive">{t('activity:office.failedPrefix')}</span>}
          <span>
            {t('activity:office.seenPrefix', { time: fmtAgo(data.lastActivityAt, Date.now()) })}
          </span>
        </div>
      )}
    </div>
  );
}

function DeskNode({ data }: { data: OfficeNodeData }) {
  const { t } = useAppTranslation();
  return (
    <div
      className={cn(
        'rounded-lg border border-dashed p-3 min-w-[120px] transition-all opacity-40',
        'border-border/70 bg-muted/30',
      )}
    >
      <NodeHandles />
      <div className="flex items-center gap-2 mb-2">
        <Armchair className="h-4 w-4 text-muted-foreground" />
        <div className="flex-1 min-w-0">
          <div className="truncate text-[10px] text-muted-foreground">{data.label}</div>
        </div>
        <StatusLED status={data.status} small activity={data.vizActivity ?? 0} />
      </div>
      <div className="text-[11px] text-muted-foreground">{t('activity:office.availableDesk')}</div>
    </div>
  );
}

function MailboxNode({ data }: { data: OfficeNodeData }) {
  const { t } = useAppTranslation();
  const color = data.color || OFFICE_COLOR.warning;
  const hasUnread = (data.unreadCount || 0) > 0;

  return (
    <div
      className={cn(
        'rounded-xl border-2 p-4 min-w-[160px] transition-all backdrop-blur-sm',
        hasUnread && 'border-warning/50 bg-warning/10 shadow-lg shadow-warning/10',
        !hasUnread && 'border-warning/30 bg-warning/6',
      )}
    >
      <NodeHandles />
      <div className="flex items-center gap-3 mb-3">
        <div
          className={cn(
            'flex items-center justify-center w-10 h-10 rounded-lg',
            hasUnread ? 'bg-warning/18' : 'bg-warning/10',
          )}
        >
          <Mail className="h-5 w-5" style={{ color }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-bold" style={{ color }}>
            {t('activity:office.mailboxHub')}
          </div>
          <div className="text-[10px] text-muted-foreground">
            {hasUnread
              ? t('activity:office.unreadSuffix', { count: data.unreadCount || 0 })
              : t('activity:office.allClear')}
          </div>
        </div>
        {hasUnread && (
          <div className="flex h-5 w-5 items-center justify-center rounded-full bg-warning text-[10px] font-bold text-background">
            {data.unreadCount}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 text-[10px]">
        <div className="rounded bg-muted/40 p-1.5 text-center">
          <div className="flex items-center justify-center gap-1 text-warning">
            <Send className="h-3 w-3" />
            <span>{data.messageCount || 0}</span>
          </div>
          <div className="text-muted-foreground">{t('activity:office.total')}</div>
        </div>
        <div className="rounded bg-muted/40 p-1.5 text-center">
          <div className="flex items-center justify-center gap-1 text-success">
            <Inbox className="h-3 w-3" />
            <span>{data.unreadCount || 0}</span>
          </div>
          <div className="text-muted-foreground">{t('activity:office.unreadLabel')}</div>
        </div>
      </div>

      {data.sublabel && (
        <div className="mt-2 truncate border-t border-border/60 pt-1.5 text-[11px] text-muted-foreground">
          ✉ {data.sublabel}
        </div>
      )}
    </div>
  );
}

// ── Node Type Map ──────────────────────────────────────────────────────────

export const nodeTypes: NodeTypes = {
  webui: WebUINode,
  tui: TUINode,
  repl: REPLNode,
  coordinator: CoordinatorNode,
  agent: AgentNode,
  mailbox: MailboxNode,
  desk: DeskNode,
};

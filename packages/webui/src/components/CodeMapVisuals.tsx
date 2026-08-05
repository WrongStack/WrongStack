import { Handle, type NodeTypes, Position } from '@xyflow/react';
import { Box, ExternalLink, FileCode, Package, Radio } from 'lucide-react';
import { memo } from 'react';
import { cn } from '@/lib/utils';
import type { ActivityType, FileActivity } from '@/stores/codemap-activity-store';
import type { GraphNodeData, GraphRefType } from './codemap-model';
import { relativeFilePath } from './codemap-model';
import { useAppTranslation } from '@/i18n';

export const NODE_STYLE: Record<
  GraphNodeData['kind'],
  { icon: typeof Package; accent: string; iconStyle: string }
> = {
  package: { icon: Package, accent: 'border-l-primary', iconStyle: 'bg-primary/12 text-primary' },
  file: { icon: FileCode, accent: 'border-l-info', iconStyle: 'bg-info/12 text-info' },
  symbol: { icon: Box, accent: 'border-l-success', iconStyle: 'bg-success/12 text-success' },
};

export const EDGE_COLOR: Record<GraphRefType, string> = {
  call: 'hsl(var(--primary))',
  import: 'hsl(var(--info))',
  type_ref: 'hsl(var(--success))',
  inherit: 'hsl(var(--warning))',
  implement: 'hsl(var(--destructive))',
};

const ACTIVITY_GLOW: Record<ActivityType, string> = {
  read: 'ring-2 ring-info/60 shadow-info/20',
  write: 'ring-2 ring-warning/70 shadow-warning/30',
  edit: 'ring-2 ring-warning/80 shadow-warning/40',
  delete: 'ring-2 ring-destructive/70 shadow-destructive/30',
  search: 'ring-2 ring-primary/55 shadow-primary/20',
  memory: 'ring-2 ring-success/60 shadow-success/30',
  index: 'ring-2 ring-info/50 shadow-info/20',
  execute: 'ring-2 ring-primary/55 shadow-primary/25',
};

const AGENT_COLORS = [
  'bg-primary text-primary-foreground',
  'bg-info text-info-foreground',
  'bg-success text-success-foreground',
  'bg-warning text-warning-foreground',
  'bg-destructive text-destructive-foreground',
] as const;

export function agentInitials(name: string): string {
  const parts = name
    .trim()
    .split(/[\s:_-]+/)
    .filter(Boolean);
  return (
    parts.length > 1 ? `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}` : name.slice(0, 2)
  ).toLocaleUpperCase();
}

export function agentColor(key: string): (typeof AGENT_COLORS)[number] {
  let hash = 0;
  for (const character of key) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return AGENT_COLORS[Math.abs(hash) % AGENT_COLORS.length] ?? AGENT_COLORS[0];
}

export function agentTrailColor(key: string): string {
  let hash = 0;
  for (const character of key) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(hash) % 360} 82% 58%)`;
}

export function shortPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const packageIndex = normalized.lastIndexOf('/packages/');
  const appIndex = normalized.lastIndexOf('/apps/');
  const start = Math.max(packageIndex, appIndex);
  return start >= 0 ? normalized.slice(start + 1) : normalized.split('/').slice(-3).join('/');
}

export function activityLabel(activity: FileActivity): string {
  const symbol = activity.symbol?.name;
  const line = activity.line ? `L${activity.line}` : undefined;
  return [symbol, line].filter(Boolean).join(' · ');
}

export interface CodeMapNodeData extends Record<string, unknown> {
  graphNode: GraphNodeData;
  selected: boolean;
  dimmed: boolean;
  incoming: number;
  outgoing: number;
  isActive: boolean;
  activityType?: ActivityType;
  activeOperations: FileActivity[];
  onSelect: (node: GraphNodeData) => void;
  onOpen: (node: GraphNodeData) => void;
  onShowHistory: (filePath: string) => void;
}

function CodeMapNodeView({ data }: { data: CodeMapNodeData }): React.ReactElement {
  const { t } = useAppTranslation();
  const {
    graphNode,
    selected,
    dimmed,
    incoming,
    outgoing,
    isActive,
    activityType,
    activeOperations,
  } = data;
  const style = NODE_STYLE[graphNode.kind];
  const Icon = style.icon;
  const canOpen = graphNode.kind !== 'symbol';
  const subtitle =
    graphNode.kind === 'symbol'
      ? `${graphNode.symbolKind ?? 'symbol'}${graphNode.line ? ` · L${graphNode.line}` : ''}`
      : graphNode.kind === 'file'
        ? relativeFilePath(graphNode)
        : `${graphNode.fileCount ?? 0} files · ${graphNode.symbolCount ?? 0} symbols`;

  return (
    <div
      className={cn(
        'group relative w-[236px] border border-l-[3px] bg-card text-card-foreground shadow-[0_8px_24px_hsl(var(--shadow-color)/0.08)] transition-[opacity,box-shadow,border-color,background-color]',
        style.accent,
        selected &&
          'border-primary bg-primary/5 shadow-[0_0_0_2px_hsl(var(--primary)/0.18),0_16px_36px_hsl(var(--shadow-color)/0.18)]',
        graphNode.external && 'border-dashed bg-muted/75',
        dimmed && 'opacity-25 grayscale',
        isActive && activityType && ACTIVITY_GLOW[activityType],
      )}
    >
      {activeOperations.length > 0 && (
        <div className="absolute -top-5 left-2 z-20 flex max-w-[210px] items-center gap-1">
          {activeOperations.slice(0, 4).map((activity) => {
            const name = activity.agentName ?? activity.agent ?? 'External';
            const key = `${activity.sessionId ?? 'none'}:${activity.agentId ?? name}`;
            return (
              <span
                key={activity.id ?? `${key}:${activity.filePath}`}
                className={cn(
                  'flex h-6 items-center gap-1 border-2 border-background px-1.5 font-mono text-[8px] font-bold shadow-md',
                  agentColor(key),
                )}
                title={`${name} · ${activity.type} ${activityLabel(activity)}`}
              >
                <span className="h-1.5 w-1.5 animate-pulse bg-current" />
                {agentInitials(name)}
                {activity.symbol && (
                  <span className="max-w-[80px] truncate">{activity.symbol.name}</span>
                )}
              </span>
            );
          })}
          {activeOperations.length > 4 && (
            <span className="border bg-card px-1 font-mono text-[8px] shadow">
              +{activeOperations.length - 4}
            </span>
          )}
        </div>
      )}
      <Handle
        type="target"
        position={Position.Left}
        className="!h-2.5 !w-2.5 !border-2 !border-card !bg-muted-foreground"
      />
      <button
        type="button"
        className="block w-full text-left"
        onClick={(event) => {
          if (event.shiftKey && graphNode.file) {
            data.onShowHistory(graphNode.file);
            return;
          }
          data.onSelect(graphNode);
        }}
        onDoubleClick={() => canOpen && data.onOpen(graphNode)}
        aria-label={`${graphNode.kind} ${graphNode.label}`}
      >
        <div className="flex items-start gap-3 p-3 pr-10">
          <span
            className={cn(
              'flex h-8 w-8 shrink-0 items-center justify-center border',
              style.iconStyle,
            )}
          >
            <Icon className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
              <span>{graphNode.kind}</span>
              {graphNode.external && (
                <span className="border border-border px-1 py-0.5 text-[8px] text-warning">
                  external
                </span>
              )}
              {graphNode.lang && (
                <span className="ml-auto font-mono normal-case tracking-normal">
                  {graphNode.lang}
                </span>
              )}
            </div>
            <div className="truncate font-mono text-[13px] font-semibold" title={graphNode.label}>
              {graphNode.label}
            </div>
            <div className="mt-1 truncate text-[10px] text-muted-foreground" title={subtitle}>
              {subtitle}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 border-t bg-muted/30 px-3 py-1.5 font-mono text-[9px] text-muted-foreground">
          <span title={t('activity:codeMapVisuals.incomingRelationships')}>← {incoming}</span>
          <span title={t('activity:codeMapVisuals.outgoingRelationships')}>→ {outgoing}</span>
          {graphNode.symbolCount !== undefined && graphNode.kind === 'file' && (
            <span className="ml-auto">{graphNode.symbolCount} sym</span>
          )}
          {isActive && (
            <span className="ml-auto flex items-center gap-1 font-bold text-warning">
              <Radio className="h-2.5 w-2.5 animate-pulse" /> LIVE
            </span>
          )}
        </div>
      </button>
      {canOpen && (
        <button
          type="button"
          className="absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center border border-transparent text-muted-foreground opacity-0 transition hover:border-border hover:bg-muted hover:text-foreground group-hover:opacity-100 focus:opacity-100"
          onClick={() => data.onOpen(graphNode)}
          title={graphNode.kind === 'package' ? 'Open file map' : 'Open symbol map'}
          aria-label={`Open ${graphNode.label} map`}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
      )}
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2.5 !w-2.5 !border-2 !border-card !bg-muted-foreground"
      />
    </div>
  );
}

function sameNodeActivities(left: FileActivity[], right: FileActivity[]): boolean {
  return left.length === right.length && left.every((activity, index) => activity === right[index]);
}

export function sameCodeMapNodeData(left: CodeMapNodeData, right: CodeMapNodeData): boolean {
  return (
    left.graphNode === right.graphNode &&
    left.selected === right.selected &&
    left.dimmed === right.dimmed &&
    left.incoming === right.incoming &&
    left.outgoing === right.outgoing &&
    left.isActive === right.isActive &&
    left.activityType === right.activityType &&
    left.onSelect === right.onSelect &&
    left.onOpen === right.onOpen &&
    left.onShowHistory === right.onShowHistory &&
    sameNodeActivities(left.activeOperations, right.activeOperations)
  );
}

const CodeMapNode = memo(CodeMapNodeView, (previous, next) =>
  sameCodeMapNodeData(previous.data, next.data),
);

export const nodeTypes: NodeTypes = { codemap: CodeMapNode };

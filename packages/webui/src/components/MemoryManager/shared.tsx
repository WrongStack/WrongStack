import { cn } from '@/lib/utils';
import type { SageAnchor, SageEntry, SageScope, SageStatus } from '@/types';

export const MEMORY_KINDS = [
  'fact',
  'decision',
  'convention',
  'preference',
  'warning',
  'anti_pattern',
  'workflow',
  'bug_root_cause',
  'file_note',
  'symbol_note',
  'command_note',
  'summary',
] as const;

export const MEMORY_STATUSES: SageStatus[] = [
  'active',
  'stale',
  'superseded',
  'contradicted',
  'archived',
  'deleted',
];

export const EDITABLE_STATUSES: SageStatus[] = [
  'active',
  'stale',
  'superseded',
  'contradicted',
  'archived',
];

export const MEMORY_SCOPES: SageScope[] = ['project', 'user', 'session', 'file', 'symbol'];

export const ANCHOR_TYPES: SageAnchor['type'][] = [
  'file',
  'directory',
  'symbol',
  'package',
  'command',
  'test',
  'git',
  'agent',
];

export const KIND_LABELS: Record<string, string> = {
  fact: 'Fact',
  decision: 'Decision',
  convention: 'Convention',
  preference: 'Preference',
  warning: 'Warning',
  anti_pattern: 'Anti-pattern',
  workflow: 'Workflow',
  bug_root_cause: 'Root cause',
  file_note: 'File note',
  symbol_note: 'Symbol note',
  command_note: 'Command note',
  summary: 'Summary',
};

export function formatAudienceText(audience: NonNullable<SageEntry['audience']>): string {
  const parts: string[] = [];
  if (audience.roles?.length) parts.push(`roles: ${audience.roles.join(', ')}`);
  if (audience.taskTypes?.length) parts.push(`tasks: ${audience.taskTypes.join(', ')}`);
  if (audience.modes?.length) parts.push(`modes: ${audience.modes.join(', ')}`);
  return parts.join(' · ');
}

export interface MemoryDraft {
  text: string;
  kind: string;
  status: SageStatus;
  scope: SageScope;
  tags: string;
  importance: number;
  confidence: number;
  freshness: number;
  anchors: SageAnchor[];
  audienceRoles: string;
  audienceTaskTypes: string;
  audienceModes: string;
  supersedes: string;
  contradicts: string;
}

export function emptyDraft(): MemoryDraft {
  return {
    text: '',
    kind: 'fact',
    status: 'active',
    scope: 'project',
    tags: '',
    importance: 0.5,
    confidence: 0.8,
    freshness: 1,
    anchors: [],
    audienceRoles: '',
    audienceTaskTypes: '',
    audienceModes: '',
    supersedes: '',
    contradicts: '',
  };
}

export function draftFromMemory(memory: SageEntry): MemoryDraft {
  return {
    text: memory.text,
    kind: memory.kind,
    status: memory.status,
    scope: memory.scope,
    tags: memory.tags.join(', '),
    importance: memory.importance,
    confidence: memory.confidence,
    freshness: memory.freshness,
    anchors: memory.anchors.map((anchor) => ({ ...anchor })),
    audienceRoles: (memory.audience?.roles ?? []).join(', '),
    audienceTaskTypes: (memory.audience?.taskTypes ?? []).join(', '),
    audienceModes: (memory.audience?.modes ?? []).join(', '),
    supersedes: (memory.supersedes ?? []).join(', '),
    contradicts: (memory.contradicts ?? []).join(', '),
  };
}

export function splitList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

export function memoryPreview(text: string, max = 170): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

export function formatDate(value?: string): string {
  if (!value) return 'Never';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return 'Unknown';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(parsed);
}

export function relativeDate(value?: string): string {
  if (!value) return 'never';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return 'unknown';
  const seconds = Math.max(0, Math.round((Date.now() - parsed) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3_600)}h ago`;
  if (seconds < 604_800) return `${Math.round(seconds / 86_400)}d ago`;
  return formatDate(value);
}

function scoreLabel(value: number): string {
  if (value >= 0.85) return 'high';
  if (value >= 0.55) return 'medium';
  return 'low';
}

function statusClasses(status: SageStatus): string {
  switch (status) {
    case 'active':
      return 'border-success/35 bg-success/10 text-success';
    case 'stale':
      return 'border-warning/40 bg-warning/10 text-warning';
    case 'contradicted':
      return 'border-destructive/40 bg-destructive/10 text-destructive';
    case 'superseded':
      return 'border-warning/30 bg-warning/5 text-warning';
    case 'archived':
      return 'border-info/35 bg-info/10 text-info';
    case 'deleted':
      return 'border-border bg-muted text-muted-foreground';
  }
}

export function kindClasses(kind: string): string {
  if (kind === 'warning' || kind === 'anti_pattern' || kind === 'bug_root_cause') {
    return 'text-destructive';
  }
  if (kind === 'decision' || kind === 'workflow') return 'text-warning';
  if (kind === 'convention' || kind === 'preference') return 'text-success';
  if (kind === 'file_note' || kind === 'symbol_note' || kind === 'command_note') {
    return 'text-info';
  }
  return 'text-foreground';
}

export function anchorValue(anchor: SageAnchor): string {
  return anchor.path ?? anchor.command ?? anchor.role ?? '';
}

export function updateAnchorValue(anchor: SageAnchor, value: string): SageAnchor {
  if (anchor.type === 'command') return { type: anchor.type, command: value };
  if (anchor.type === 'agent') return { type: anchor.type, role: value };
  return {
    type: anchor.type,
    path: value,
    ...(anchor.type === 'symbol' && anchor.symbol ? { symbol: anchor.symbol } : {}),
  };
}

export function normalizeAnchors(anchors: SageAnchor[]): SageAnchor[] {
  const normalized: SageAnchor[] = [];
  for (const anchor of anchors) {
    const value = anchorValue(anchor).trim();
    const symbol = anchor.symbol?.trim();
    if (!value && !symbol) continue;
    if (anchor.type === 'command') {
      normalized.push({ type: 'command', command: value });
      continue;
    }
    if (anchor.type === 'agent') {
      normalized.push({ type: 'agent', role: value.toLowerCase() });
      continue;
    }
    normalized.push({
      type: anchor.type,
      ...(value ? { path: value } : {}),
      ...(symbol ? { symbol } : {}),
    });
  }
  return normalized;
}

export function StatusBadge({ status }: { status: SageStatus }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 border px-2 py-0.5 text-[10px] font-bold uppercase',
        statusClasses(status),
      )}
    >
      <span className="size-1.5 bg-current" aria-hidden="true" />
      {status}
    </span>
  );
}

export function MetricCard({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: number;
  hint: string;
  tone?: 'default' | 'success' | 'warning' | 'info';
}) {
  const toneClass =
    tone === 'success'
      ? 'text-success'
      : tone === 'warning'
        ? 'text-warning'
        : tone === 'info'
          ? 'text-info'
          : 'text-foreground';
  return (
    <div className="border border-border/70 bg-card/55 px-3 py-2.5 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.035)]">
      <p className="text-[9px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </p>
      <div className="mt-1 flex items-end justify-between gap-2">
        <p className={cn('font-mono text-xl font-bold tabular-nums', toneClass)}>{value}</p>
        <p className="truncate text-[9px] text-muted-foreground">{hint}</p>
      </div>
    </div>
  );
}

export function RangeField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="border border-border/65 bg-background/35 p-3">
      <div className="flex items-center justify-between gap-3">
        <label
          htmlFor={id}
          className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground"
        >
          {label}
        </label>
        <span className="font-mono text-xs font-bold tabular-nums text-info">
          {Math.round(value * 100)}% · {scoreLabel(value)}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min="0"
        max="1"
        step="0.05"
        value={value}
        onChange={(event) => onChange(Number.parseFloat(event.target.value))}
        className="mt-3 h-1.5 w-full cursor-pointer accent-[hsl(var(--info))]"
      />
    </div>
  );
}

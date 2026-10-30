import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircleStop,
  Clock3,
  FileCode2,
  History,
  Wrench,
} from 'lucide-react';

import { i18n, useAppTranslation } from '@/i18n';

import type { SessionHistoryEntry } from '@/stores';

export type HistoryFilter = 'all' | 'favorites' | 'active' | 'completed' | 'issues';

export type HistorySort = 'recent' | 'tokens' | 'activity';

export interface HistoryViewOptions {
  query: string;
  filter: HistoryFilter;
  sort: HistorySort;
  favoriteIds: readonly string[];
}

export interface SessionHistoryGroup {
  label: 'favorites' | 'today' | 'yesterday' | 'thisWeek' | 'earlier' | 'tokens' | 'activity';
  rows: SessionHistoryEntry[];
  favorite?: boolean | undefined;
}

export interface SessionHistoryStats {
  sessions: number;
  active: number;
  tokens: number;
  tools: number;
  files: number;
  errors: number;
}

export const timestamp = (iso: string | undefined): number => {
  if (!iso) return 0;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? 0 : value;
};

export const activityScore = (entry: SessionHistoryEntry): number =>
  (entry.iterationCount ?? 0) + (entry.toolCallCount ?? 0) + (entry.fileChangeCount ?? 0);

export const formatRelative = (iso: string): string => {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return '';
  const diff = Math.max(0, Date.now() - ts);
  if (diff < 60_000) return i18n.t('common:time.justNow');
  if (diff < 3_600_000) {
    return i18n.t('common:time.minutesAgo', { count: Math.floor(diff / 60_000) });
  }
  if (diff < 86_400_000) {
    return i18n.t('common:time.hoursAgo', { count: Math.floor(diff / 3_600_000) });
  }
  const days = Math.floor(diff / 86_400_000);
  if (days < 7) return i18n.t('common:time.daysAgo', { count: days });
  return new Date(ts).toLocaleDateString();
};

export const sessionActivityAt = (entry: SessionHistoryEntry): string =>
  entry.lastActivityAt ?? entry.endedAt ?? entry.startedAt;

export function formatSessionDuration(entry: SessionHistoryEntry): string {
  const start = timestamp(entry.startedAt);
  if (!start) return '';
  const end = entry.isCurrent ? Date.now() : timestamp(entry.endedAt) || start;
  const minutes = Math.max(0, Math.floor((end - start) / 60_000));
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: value >= 1_000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(value);
}

/** Pure function: returns empty non-active sessions that are safe to offer for cleanup. */
export function getEmptySessionIds(
  entries: Array<{ id: string; tokenTotal: number; isCurrent: boolean }>,
  protectedIds?: Iterable<string>,
): string[] {
  const protectedSet = new Set(protectedIds);
  return entries
    .filter((entry) => entry.tokenTotal === 0 && !entry.isCurrent && !protectedSet.has(entry.id))
    .map((entry) => entry.id);
}

export function filterAndSortSessions(
  entries: readonly SessionHistoryEntry[],
  options: HistoryViewOptions,
): SessionHistoryEntry[] {
  const query = options.query.trim().toLocaleLowerCase();
  const favorites = new Set(options.favoriteIds);
  const visible = entries.filter((entry) => {
    const matchesQuery =
      !query ||
      [
        entry.name,
        entry.title,
        entry.lastUserMessage,
        entry.model,
        entry.provider,
        entry.id,
        ...Object.keys(entry.toolBreakdown ?? {}),
      ].some((value) => value?.toLocaleLowerCase().includes(query));
    if (!matchesQuery) return false;

    switch (options.filter) {
      case 'favorites':
        return favorites.has(entry.id);
      case 'active':
        return entry.isCurrent;
      case 'completed':
        return (
          !entry.isCurrent &&
          (entry.outcome === 'completed' || (entry.outcome === undefined && Boolean(entry.endedAt)))
        );
      case 'issues':
        return (
          entry.outcome === 'error' ||
          entry.outcome === 'timeout' ||
          entry.outcome === 'aborted' ||
          (entry.toolErrorCount ?? 0) > 0
        );
      default:
        return true;
    }
  });

  return [...visible].sort((a, b) => {
    if (options.sort === 'tokens' && b.tokenTotal !== a.tokenTotal) {
      return b.tokenTotal - a.tokenTotal;
    }
    if (options.sort === 'activity') {
      const difference = activityScore(b) - activityScore(a);
      if (difference !== 0) return difference;
    }
    return timestamp(sessionActivityAt(b)) - timestamp(sessionActivityAt(a));
  });
}

export function groupSessionHistory(
  entries: readonly SessionHistoryEntry[],
  favoriteIds: readonly string[],
  now = Date.now(),
): SessionHistoryGroup[] {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const todayStart = day.getTime();
  const yesterdayStart = todayStart - 86_400_000;
  const weekStart = todayStart - 6 * 86_400_000;
  const favorites = new Set(favoriteIds);
  const favoriteRows = entries.filter((entry) => favorites.has(entry.id));
  const buckets: Record<'today' | 'yesterday' | 'thisWeek' | 'earlier', SessionHistoryEntry[]> = {
    today: [],
    yesterday: [],
    thisWeek: [],
    earlier: [],
  };

  for (const entry of entries) {
    if (favorites.has(entry.id)) continue;
    const activityAt = timestamp(sessionActivityAt(entry));
    if (activityAt >= todayStart) buckets.today.push(entry);
    else if (activityAt >= yesterdayStart) buckets.yesterday.push(entry);
    else if (activityAt >= weekStart) buckets.thisWeek.push(entry);
    else buckets.earlier.push(entry);
  }

  const groups: SessionHistoryGroup[] = [];
  if (favoriteRows.length > 0) {
    groups.push({ label: 'favorites', rows: favoriteRows, favorite: true });
  }
  for (const label of ['today', 'yesterday', 'thisWeek', 'earlier'] as const) {
    if (buckets[label].length > 0) groups.push({ label, rows: buckets[label] });
  }
  return groups;
}

export interface SessionHistoryColumns {
  left: SessionHistoryGroup[];
  right: SessionHistoryGroup[];
}

/**
 * Balance a page of time-ordered groups across the workspace page's two
 * columns: rows fill the left column down to the midpoint, then continue
 * down the right, so each column reads chronologically and neither towers
 * over an empty sibling. A group straddling the midpoint is sliced at it —
 * that keeps the page one continuous timeline even when a single bucket
 * (e.g. "Today") dominates, which is the common case on early pages.
 */
export function splitSessionHistoryColumns(
  groups: readonly SessionHistoryGroup[],
): SessionHistoryColumns {
  const totalRows = groups.reduce((sum, group) => sum + group.rows.length, 0);
  const left: SessionHistoryGroup[] = [];
  const right: SessionHistoryGroup[] = [];
  if (totalRows === 0) return { left, right };

  const midpoint = Math.ceil(totalRows / 2);
  let placed = 0;
  for (const group of groups) {
    if (placed >= midpoint) {
      right.push(group);
      continue;
    }
    const capacity = midpoint - placed;
    if (group.rows.length <= capacity) {
      left.push(group);
      placed += group.rows.length;
      continue;
    }
    left.push({ ...group, rows: group.rows.slice(0, capacity) });
    const remainder = group.rows.slice(capacity);
    if (remainder.length > 0) right.push({ ...group, rows: remainder });
    placed += capacity;
  }
  return { left, right };
}

export function getSessionHistoryStats(
  entries: readonly SessionHistoryEntry[],
): SessionHistoryStats {
  return entries.reduce<SessionHistoryStats>(
    (stats, entry) => ({
      sessions: stats.sessions + 1,
      active: stats.active + (entry.isCurrent ? 1 : 0),
      tokens: stats.tokens + entry.tokenTotal,
      tools: stats.tools + (entry.toolCallCount ?? 0),
      files: stats.files + (entry.fileChangeCount ?? 0),
      errors: stats.errors + (entry.toolErrorCount ?? 0) + (entry.outcome === 'error' ? 1 : 0),
    }),
    { sessions: 0, active: 0, tokens: 0, tools: 0, files: 0, errors: 0 },
  );
}

export function outcomeMeta(entry: SessionHistoryEntry): {
  icon: typeof Activity;
  label: 'active' | 'completed' | 'error' | 'timeout' | 'aborted' | 'saved';
  defaultLabel: string;
  className: string;
} {
  if (entry.isCurrent) {
    return { icon: Activity, label: 'active', defaultLabel: 'Active', className: 'text-primary' };
  }
  switch (entry.outcome) {
    case 'completed':
      return {
        icon: CheckCircle2,
        label: 'completed',
        defaultLabel: 'Completed',
        className: 'text-success',
      };
    case 'error':
      return {
        icon: AlertTriangle,
        label: 'error',
        defaultLabel: 'Error',
        className: 'text-destructive',
      };
    case 'timeout':
      return {
        icon: Clock3,
        label: 'timeout',
        defaultLabel: 'Timed out',
        className: 'text-warning',
      };
    case 'aborted':
      return {
        icon: CircleStop,
        label: 'aborted',
        defaultLabel: 'Aborted',
        className: 'text-muted-foreground',
      };
    default:
      return entry.endedAt
        ? {
            icon: CheckCircle2,
            label: 'completed',
            defaultLabel: 'Completed',
            className: 'text-success',
          }
        : {
            icon: History,
            label: 'saved',
            defaultLabel: 'Saved session',
            className: 'text-muted-foreground',
          };
  }
}

export function HistoryStats({ stats }: { stats: SessionHistoryStats }) {
  const { t } = useAppTranslation();
  const items = [
    {
      label: t('activity:sessions.stats.sessions', { defaultValue: 'Sessions' }),
      value: stats.sessions,
      icon: History,
    },
    {
      label: t('activity:sessions.stats.tokens', { defaultValue: 'Tokens' }),
      value: stats.tokens,
      icon: Activity,
    },
    {
      label: t('activity:sessions.stats.tools', { defaultValue: 'Tool calls' }),
      value: stats.tools,
      icon: Wrench,
    },
    {
      label: t('activity:sessions.stats.files', { defaultValue: 'Files changed' }),
      value: stats.files,
      icon: FileCode2,
    },
    {
      label: t('activity:sessions.stats.errors', { defaultValue: 'Errors' }),
      value: stats.errors,
      icon: AlertTriangle,
    },
  ];

  return (
    <div className="grid grid-cols-2 border-b border-border/75 bg-card md:grid-cols-5">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <div
            key={item.label}
            className="border-b border-r border-border/75 px-4 py-3 md:border-b-0"
          >
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              <Icon className="h-3 w-3" />
              {item.label}
            </div>
            <div className="mt-1 font-mono text-xl font-semibold tabular-nums">
              {formatCompactNumber(item.value)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

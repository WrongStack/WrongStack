import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircleStop,
  Clock3,
  FileCode2,
  History,
  Loader2,
  Pencil,
  Play,
  RefreshCw,
  Search,
  SearchCheck,
  Star,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { confirmModal } from '@/components/ConfirmModal';
import { toast } from '@/components/Toaster';
import { Pagination } from '@/components/ui/pagination';
import type { useWebSocket } from '@/hooks/useWebSocket';
import { i18n, useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import type { SessionHistoryEntry } from '@/stores';
import { useActiveSessionId, useSessionTabStore, useUIStore } from '@/stores';

type HistoryFilter = 'all' | 'favorites' | 'active' | 'completed' | 'issues';
type HistorySort = 'recent' | 'tokens' | 'activity';
type HistoryListVariant = 'sidebar' | 'workspace';

const SIDEBAR_PAGE_SIZE = 10;
const WORKSPACE_PAGE_SIZE = 20;

interface SessionListProps {
  historyQuery: string;
  setHistoryQuery: (value: string) => void;
  historyEntries: SessionHistoryEntry[];
  historyLoading: boolean;
  historyError: string | null;
  wsConnected: boolean;
  listSessions: ReturnType<typeof useWebSocket>['listSessions'];
  resumeSession: ReturnType<typeof useWebSocket>['resumeSession'];
  deleteSession: ReturnType<typeof useWebSocket>['deleteSession'];
  renameSession: ReturnType<typeof useWebSocket>['renameSession'];
  variant?: HistoryListVariant | undefined;
}

interface HistoryViewOptions {
  query: string;
  filter: HistoryFilter;
  sort: HistorySort;
  favoriteIds: readonly string[];
}

interface SessionHistoryGroup {
  label: 'favorites' | 'today' | 'yesterday' | 'thisWeek' | 'earlier';
  rows: SessionHistoryEntry[];
  favorite?: boolean | undefined;
}

interface SessionHistoryStats {
  sessions: number;
  active: number;
  tokens: number;
  tools: number;
  files: number;
  errors: number;
}

const timestamp = (iso: string | undefined): number => {
  if (!iso) return 0;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? 0 : value;
};

const activityScore = (entry: SessionHistoryEntry): number =>
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

const sessionActivityAt = (entry: SessionHistoryEntry): string =>
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

function outcomeMeta(entry: SessionHistoryEntry): {
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

function HistoryStats({ stats }: { stats: SessionHistoryStats }) {
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

export function SessionList({
  historyQuery,
  setHistoryQuery,
  historyEntries,
  historyLoading,
  historyError,
  wsConnected,
  listSessions,
  resumeSession,
  deleteSession,
  renameSession,
  variant = 'sidebar',
}: SessionListProps) {
  const { t } = useAppTranslation();
  const favoriteSessionIds = useUIStore((state) => state.favoriteSessionIds);
  const toggleFavoriteSession = useUIStore((state) => state.toggleFavoriteSession);
  const sessionNicknames = useUIStore((state) => state.sessionNicknames);
  const setSessionNickname = useUIStore((state) => state.setSessionNickname);
  const setInspectSession = useUIStore((state) => state.setInspectSession);
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [sort, setSort] = useState<HistorySort>('recent');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [resumingId, setResumingId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const resumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const renameInput = useRef<HTMLInputElement | null>(null);
  const workspace = variant === 'workspace';

  const displayName = useCallback(
    (entry: SessionHistoryEntry) =>
      entry.name || sessionNicknames[entry.id] || entry.title || t('activity:sessions.empty'),
    [sessionNicknames, t],
  );

  const beginRename = useCallback(
    (entry: SessionHistoryEntry) => {
      setRenamingId(entry.id);
      setRenameDraft(entry.name ?? sessionNicknames[entry.id] ?? entry.title ?? '');
    },
    [sessionNicknames],
  );

  const commitRename = useCallback(
    (id: string) => {
      setRenamingId(null);
      setSessionNickname(id, renameDraft);
      renameSession(id, renameDraft);
    },
    [renameDraft, renameSession, setSessionNickname],
  );

  useEffect(() => {
    if (resumingId && historyEntries.some((entry) => entry.id === resumingId && entry.isCurrent)) {
      setResumingId(null);
      if (resumeTimer.current) clearTimeout(resumeTimer.current);
    }
  }, [historyEntries, resumingId]);

  useEffect(() => {
    if (!renamingId) return;
    renameInput.current?.focus();
    renameInput.current?.select();
  }, [renamingId]);

  useEffect(
    () => () => {
      if (resumeTimer.current) clearTimeout(resumeTimer.current);
    },
    [],
  );

  const openTabIds = useSessionTabStore((s) => s.openTabIds);

  const handleResume = useCallback(
    (id: string) => {
      const result = useSessionTabStore.getState().openTab(id, { resumeSession });
      if (!result.success || result.reason !== 'opened_new_tab') return;
      setResumingId(id);
      if (resumeTimer.current) clearTimeout(resumeTimer.current);
      resumeTimer.current = setTimeout(() => setResumingId(null), 10_000);
    },
    [resumeSession],
  );

  const currentSessionId = useActiveSessionId();
  const emptySessionIds = useMemo(() => {
    // Deliberately NOT protecting open tabs: a never-started session with a
    // tab is exactly what this button exists to remove, and closing the tab
    // is part of the removal. Only the foreground session stays protected —
    // it is the session the server runtime sits on, and keeping it guarantees
    // the strip keeps at least the active tab.
    const protectedIds = new Set<string>();
    if (currentSessionId) protectedIds.add(currentSessionId);
    return getEmptySessionIds(historyEntries, protectedIds);
  }, [historyEntries, currentSessionId]);
  const visibleEntries = useMemo(
    () =>
      filterAndSortSessions(historyEntries, {
        query: historyQuery,
        filter,
        sort,
        favoriteIds: favoriteSessionIds,
      }),
    [favoriteSessionIds, filter, historyEntries, historyQuery, sort],
  );
  const pageSize = workspace ? WORKSPACE_PAGE_SIZE : SIDEBAR_PAGE_SIZE;
  const pagedEntries = useMemo(
    () => visibleEntries.slice((page - 1) * pageSize, page * pageSize),
    [page, pageSize, visibleEntries],
  );
  const groupedHistory = useMemo(
    () => groupSessionHistory(pagedEntries, favoriteSessionIds),
    [favoriteSessionIds, pagedEntries],
  );
  const stats = useMemo(() => getSessionHistoryStats(historyEntries), [historyEntries]);

  useEffect(() => {
    setPage(1);
  }, [filter, historyQuery, sort]);

  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(visibleEntries.length / pageSize));
    if (page > totalPages) setPage(totalPages);
  }, [page, pageSize, visibleEntries.length]);

  const handleDeleteEmpty = useCallback(async () => {
    if (emptySessionIds.length === 0) return;
    const ok = await confirmModal({
      title: t('activity:sessions.deleteEmptyTitle', { count: emptySessionIds.length }),
      message: t('activity:sessions.deleteEmptyConfirmBody'),
      confirmLabel: t('common:action.delete'),
      danger: true,
    });
    if (!ok) return;
    // Close every tab bound to a doomed session first (keeping at least one
    // open), then delete what the server can delete: a session this page
    // still displays would be refused.
    const removable = useSessionTabStore.getState().closeTabsForSessions(emptySessionIds);
    for (const id of removable) deleteSession(id);
  }, [deleteSession, emptySessionIds, t]);

  const filterOptions: Array<{ id: HistoryFilter; label: string }> = [
    { id: 'all', label: t('activity:sessions.filters.all', { defaultValue: 'All' }) },
    {
      id: 'favorites',
      label: t('activity:sessions.filters.favorites', { defaultValue: 'Pinned' }),
    },
    { id: 'active', label: t('activity:sessions.filters.active', { defaultValue: 'Active' }) },
    {
      id: 'completed',
      label: t('activity:sessions.filters.completed', { defaultValue: 'Completed' }),
    },
    { id: 'issues', label: t('activity:sessions.filters.issues', { defaultValue: 'Issues' }) },
  ];

  return (
    <div
      className={cn('flex min-h-0 min-w-0 flex-1 flex-col bg-background', workspace && 'h-full')}
      data-history-variant={variant}
    >
      {workspace ? <HistoryStats stats={stats} /> : null}

      <div
        className={cn('border-b border-border/75 bg-card', workspace ? 'px-4 py-3' : 'px-3 py-2')}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {t('activity:sessions.recentSessions')}
            </div>
            {workspace ? (
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t('activity:sessions.workspaceHint', {
                  defaultValue: 'Search, inspect, pin and resume every project conversation.',
                })}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center border border-border/75">
            {emptySessionIds.length > 0 ? (
              <button
                type="button"
                className="inline-flex h-8 items-center justify-center gap-1 border-r border-border/75 px-2 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                onClick={handleDeleteEmpty}
                disabled={!wsConnected}
                title={t('activity:sessions.deleteEmptyTitle', { count: emptySessionIds.length })}
                aria-label={t('activity:sessions.deleteEmptyTitle', {
                  count: emptySessionIds.length,
                })}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {/* Count badge in BOTH modes: never-started records are no
                    longer auto-deleted on close, so this control is the only
                    signal that clearable empty sessions exist. */}
                <span
                  aria-hidden="true"
                  className="inline-flex min-w-4 items-center justify-center rounded-full bg-destructive/15 px-1 text-[10px] font-semibold leading-4 text-destructive"
                >
                  {emptySessionIds.length}
                </span>
              </button>
            ) : null}
            <button
              type="button"
              className="inline-flex h-8 w-8 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
              onClick={() => listSessions(200)}
              disabled={!wsConnected}
              title={t('common:action.refresh')}
            >
              {historyLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        </div>

        <div
          className={cn(
            'grid gap-2',
            workspace ? 'mt-3 lg:grid-cols-[minmax(18rem,1fr)_auto_auto]' : 'mt-2',
          )}
        >
          <div className="relative min-w-0">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={historyQuery}
              onChange={(event) => setHistoryQuery(event.target.value)}
              placeholder={t('activity:sessions.filterPlaceholder')}
              aria-label={t('activity:sessions.filterPlaceholder')}
              className="h-9 w-full border border-border/75 bg-background pl-8 pr-8 text-xs outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary focus:ring-1 focus:ring-primary"
            />
            {historyQuery ? (
              <button
                type="button"
                onClick={() => setHistoryQuery('')}
                className="absolute right-0 top-0 inline-flex h-9 w-8 items-center justify-center text-muted-foreground hover:text-foreground"
                title={t('activity:sessions.clearFilter')}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>

          <fieldset className="flex min-w-0 overflow-x-auto border border-border/75">
            <legend className="sr-only">{t('activity:sessionList.historyFilters')}</legend>
            {filterOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setFilter(option.id)}
                aria-pressed={filter === option.id}
                className={cn(
                  'h-9 shrink-0 border-r border-border/75 px-2.5 text-[10px] font-semibold uppercase tracking-[0.08em] transition-colors last:border-r-0',
                  filter === option.id
                    ? 'bg-foreground text-background'
                    : 'bg-background text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {option.label}
              </button>
            ))}
          </fieldset>

          <select
            value={sort}
            onChange={(event) => setSort(event.target.value as HistorySort)}
            aria-label={t('activity:sessions.sort.label', { defaultValue: 'Sort sessions' })}
            className="h-9 border border-border/75 bg-background px-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground outline-none focus:border-primary"
          >
            <option value="recent">
              {t('activity:sessions.sort.recent', { defaultValue: 'Recent' })}
            </option>
            <option value="tokens">
              {t('activity:sessions.sort.tokens', { defaultValue: 'Most tokens' })}
            </option>
            <option value="activity">
              {t('activity:sessions.sort.activity', { defaultValue: 'Most activity' })}
            </option>
          </select>
        </div>
      </div>

      {historyError ? (
        <div className="border-b border-destructive/30 bg-destructive/5 px-4 py-2 text-xs text-destructive">
          {historyError}
        </div>
      ) : null}

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain overflow-x-hidden [scrollbar-gutter:stable]">
        {historyEntries.length === 0 && !historyLoading ? (
          <div className="flex min-h-56 flex-col items-center justify-center px-4 py-10 text-center text-muted-foreground">
            <History className="h-9 w-9 opacity-25" />
            <p className="mt-3 text-sm font-medium text-foreground">
              {t('activity:sessions.noHistory')}
            </p>
            <p className="mt-1 text-xs">{t('activity:sessions.noHistoryHint')}</p>
          </div>
        ) : groupedHistory.length === 0 ? (
          <div className="flex min-h-56 flex-col items-center justify-center px-4 py-10 text-center text-muted-foreground">
            <Search className="h-9 w-9 opacity-25" />
            <p className="mt-3 text-sm font-medium text-foreground">
              {t('activity:sessions.noMatches')}
            </p>
            <p className="mt-1 text-xs">{t('activity:sessions.noMatchesHint')}</p>
          </div>
        ) : (
          <div className={cn(workspace ? 'mx-auto w-full max-w-7xl p-4 lg:p-6' : 'p-2')}>
            <div className={cn('space-y-5', workspace && 'grid gap-x-5 space-y-0 xl:grid-cols-2')}>
              {groupedHistory.map((group) => (
                <section key={group.label} className="min-w-0">
                  <div
                    className={cn(
                      'sticky top-0 z-[1] flex items-center gap-1 border-b border-border/75 bg-background/95 px-1 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] backdrop-blur-sm',
                      group.favorite ? 'text-warning' : 'text-muted-foreground',
                    )}
                  >
                    {group.favorite ? <Star className="h-3 w-3 fill-current" /> : null}
                    {t(`activity:sessions.group.${group.label}`)}
                    <span className="ml-1 font-mono font-normal text-muted-foreground">
                      {group.rows.length}
                    </span>
                  </div>

                  <div className="divide-y divide-border/75 border-x border-b border-border/75">
                    {group.rows.map((entry) => {
                      const favorite = favoriteSessionIds.includes(entry.id);
                      const meta = outcomeMeta(entry);
                      const StatusIcon = meta.icon;
                      const isRenaming = renamingId === entry.id;
                      const isResuming = resumingId === entry.id;

                      return (
                        <article
                          key={entry.id}
                          className={cn(
                            'group grid min-w-0 grid-cols-[minmax(0,1fr)_auto] bg-card transition-colors',
                            entry.isCurrent
                              ? 'border-l-2 border-l-primary bg-primary/5'
                              : 'border-l-2 border-l-transparent hover:bg-muted/45',
                          )}
                          data-session-id={entry.id}
                        >
                          {isRenaming ? (
                            <div className="min-w-0 px-3 py-3">
                              <label
                                className="block text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground"
                                htmlFor={`session-name-${entry.id}`}
                              >
                                {t('activity:sessions.rename', { defaultValue: 'Session name' })}
                              </label>
                              <input
                                ref={renameInput}
                                id={`session-name-${entry.id}`}
                                value={renameDraft}
                                onChange={(event) => setRenameDraft(event.target.value)}
                                onBlur={() => commitRename(entry.id)}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter') {
                                    event.preventDefault();
                                    commitRename(entry.id);
                                  } else if (event.key === 'Escape') {
                                    event.preventDefault();
                                    setRenamingId(null);
                                  }
                                }}
                                placeholder={
                                  entry.title || t('activity:sessions.nicknamePlaceholder')
                                }
                                className="mt-1 h-8 w-full border border-primary bg-background px-2 text-sm outline-none ring-1 ring-primary"
                              />
                            </div>
                          ) : (
                            <button
                              type="button"
                              disabled={entry.isCurrent || resumingId !== null}
                              onClick={() => handleResume(entry.id)}
                              onDoubleClick={() => beginRename(entry)}
                              aria-current={entry.isCurrent ? 'page' : undefined}
                              className="min-w-0 px-3 py-3 text-left outline-none focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary disabled:cursor-default"
                            >
                              <div className="flex min-w-0 items-start gap-2">
                                <span
                                  className={cn('mt-0.5 shrink-0', meta.className)}
                                  title={t(`activity:sessions.status.${meta.label}`, {
                                    defaultValue: meta.defaultLabel,
                                  })}
                                >
                                  <StatusIcon
                                    className={cn(
                                      'h-3.5 w-3.5',
                                      entry.isCurrent && 'animate-pulse',
                                    )}
                                  />
                                </span>
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center justify-between gap-2">
                                    <div
                                      className="truncate text-sm font-semibold text-foreground"
                                      title={displayName(entry)}
                                    >
                                      {displayName(entry)}
                                    </div>
                                    {entry.isCurrent ? (
                                      <span className="inline-flex shrink-0 items-center gap-1 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                                        <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
                                        {t('activity:sessions.activeTab', {
                                          defaultValue: 'Active Tab',
                                        })}
                                      </span>
                                    ) : openTabIds.includes(entry.id) ? (
                                      <span className="inline-flex shrink-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                                        <span className="h-1.5 w-1.5 rounded-full bg-success" />
                                        {t('activity:sessions.tabNumber', {
                                          count: openTabIds.indexOf(entry.id) + 1,
                                          defaultValue: `Tab ${openTabIds.indexOf(entry.id) + 1}`,
                                        })}
                                      </span>
                                    ) : null}
                                  </div>
                                  <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                                    {entry.provider}/{entry.model}
                                  </div>
                                  {entry.lastUserMessage ? (
                                    <div
                                      className="mt-1 truncate text-xs text-muted-foreground"
                                      title={entry.lastUserMessage}
                                    >
                                      {entry.lastUserMessage}
                                    </div>
                                  ) : null}
                                  <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] text-muted-foreground">
                                    {isResuming ? (
                                      <span className="inline-flex items-center gap-1 font-sans font-semibold text-primary">
                                        <Loader2 className="h-3 w-3 animate-spin" />
                                        {t('activity:sessions.resuming')}
                                      </span>
                                    ) : (
                                      <span
                                        title={new Date(sessionActivityAt(entry)).toLocaleString()}
                                      >
                                        {formatRelative(sessionActivityAt(entry))}
                                      </span>
                                    )}
                                    <span aria-hidden="true">·</span>
                                    <span>{formatSessionDuration(entry)}</span>
                                    {entry.tokenTotal > 0 ? (
                                      <span>{formatCompactNumber(entry.tokenTotal)} tok</span>
                                    ) : null}
                                    {(entry.messageCount ?? 0) > 0 ? (
                                      <span>
                                        {formatCompactNumber(entry.messageCount ?? 0)} msg
                                      </span>
                                    ) : null}
                                    {(entry.toolCallCount ?? 0) > 0 ? (
                                      <span className="inline-flex items-center gap-1">
                                        <Wrench className="h-3 w-3" />
                                        {entry.toolCallCount}
                                      </span>
                                    ) : null}
                                    {(entry.fileChangeCount ?? 0) > 0 ? (
                                      <span className="inline-flex items-center gap-1">
                                        <FileCode2 className="h-3 w-3" />
                                        {entry.fileChangeCount}
                                      </span>
                                    ) : null}
                                    {(entry.toolErrorCount ?? 0) > 0 ? (
                                      <span className="inline-flex items-center gap-1 text-destructive">
                                        <AlertTriangle className="h-3 w-3" />
                                        {entry.toolErrorCount}
                                      </span>
                                    ) : null}
                                  </div>
                                </div>
                              </div>
                            </button>
                          )}

                          <div className="flex items-start gap-0.5 p-2">
                            {!entry.isCurrent && workspace && !isRenaming ? (
                              <button
                                type="button"
                                onClick={() => handleResume(entry.id)}
                                disabled={resumingId !== null}
                                className="inline-flex h-7 items-center gap-1 border border-border/75 px-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground hover:border-primary hover:text-primary disabled:opacity-40"
                                title={t('activity:sessions.resume', {
                                  defaultValue: 'Resume session',
                                })}
                              >
                                <Play className="h-3 w-3" />
                                {t('activity:sessions.resumeShort', { defaultValue: 'Resume' })}
                              </button>
                            ) : null}
                            {!isRenaming ? (
                              <button
                                type="button"
                                onClick={() => setInspectSession(entry.id)}
                                className="inline-flex h-7 w-7 items-center justify-center text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
                                title={t('activity:sessions.inspect', {
                                  defaultValue: 'Inspect session',
                                })}
                              >
                                <SearchCheck className="h-3.5 w-3.5" />
                              </button>
                            ) : null}
                            <button
                              type="button"
                              onClick={() => toggleFavoriteSession(entry.id)}
                              aria-pressed={favorite}
                              className={cn(
                                'inline-flex h-7 w-7 items-center justify-center transition-colors hover:bg-warning/10 hover:text-warning',
                                favorite ? 'text-warning' : 'text-muted-foreground',
                              )}
                              title={
                                favorite
                                  ? t('activity:sessions.unfavorite')
                                  : t('activity:sessions.markFavorite')
                              }
                            >
                              <Star className={cn('h-3.5 w-3.5', favorite && 'fill-current')} />
                            </button>
                            {!isRenaming ? (
                              <button
                                type="button"
                                onClick={() => beginRename(entry)}
                                className="inline-flex h-7 w-7 items-center justify-center text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
                                title={t('activity:sessions.renameAction', {
                                  defaultValue: 'Rename',
                                })}
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                            ) : null}
                            {!entry.isCurrent ? (
                              <button
                                type="button"
                                onClick={async () => {
                                  const ok = await confirmModal({
                                    title: t('activity:sessions.deleteSessionConfirmTitle'),
                                    message: t('activity:sessions.deleteSessionConfirmBody', {
                                      name: displayName(entry),
                                    }),
                                    confirmLabel: t('common:action.delete'),
                                    danger: true,
                                  });
                                  if (!ok) return;
                                  // Close the deleted session's tab first so
                                  // the server allows the deletion; when the
                                  // strip would drop to zero the store keeps
                                  // one tab and reports the session as not
                                  // removable — never delete what must stay.
                                  const removable = useSessionTabStore
                                    .getState()
                                    .closeTabsForSessions([entry.id]);
                                  if (!removable.includes(entry.id)) {
                                    toast.info(
                                      t('activity:sessions.deleteKeptLastTab', {
                                        defaultValue:
                                          'Session not deleted — at least one tab must stay open.',
                                      }),
                                    );
                                    return;
                                  }
                                  deleteSession(entry.id);
                                }}
                                className="inline-flex h-7 w-7 items-center justify-center text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                                title={t('activity:sessions.deleteSessionTitle')}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            ) : null}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
            <Pagination
              page={page}
              pageSize={pageSize}
              totalItems={visibleEntries.length}
              onPageChange={setPage}
              compact={!workspace}
              itemLabel="sessions"
            />
          </div>
        )}
      </div>
    </div>
  );
}

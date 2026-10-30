import {
  History,
  Loader2,
  Pencil,
  Play,
  RefreshCw,
  Search,
  SearchCheck,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { confirmModal } from '@/components/ConfirmModal';
import { toast } from '@/components/Toaster';
import { Pagination } from '@/components/ui/pagination';
import type { useWebSocket } from '@/hooks/useWebSocket';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import type { SessionHistoryEntry } from '@/stores';
import { useActiveSessionId, useSessionTabStore, useUIStore } from '@/stores';
import { SessionRenameField, SessionRowStats } from './SessionRowParts.js';
import {
  filterAndSortSessions,
  getEmptySessionIds,
  getSessionHistoryStats,
  groupSessionHistory,
  type HistoryFilter,
  type HistorySort,
  HistoryStats,
  outcomeMeta,
  type SessionHistoryGroup,
  splitSessionHistoryColumns,
} from './session-history.js';

export {
  filterAndSortSessions,
  formatCompactNumber,
  formatRelative,
  formatSessionDuration,
  getEmptySessionIds,
  getSessionHistoryStats,
  groupSessionHistory,
  splitSessionHistoryColumns,
} from './session-history.js';

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
      if (!result.success || result.reason === 'already_active') return;
      // A session that already owns a slot is SWITCHED to, not resumed — the
      // click moves the foreground and nothing is read back from disk. Showing
      // the row's resume spinner for it claimed a wait that is not happening,
      // and the row stayed disabled for the full 10s timeout afterwards.
      if (result.reason === 'switched') return;
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
  // The list can shrink while a later page is selected (deletion, list
  // refresh); clamp so the page slice never falls past the end of the
  // list and renders an empty grid.
  const totalPages = Math.max(1, Math.ceil(visibleEntries.length / pageSize));
  const activePage = Math.min(page, totalPages);
  const pagedEntries = useMemo(
    () => visibleEntries.slice((activePage - 1) * pageSize, activePage * pageSize),
    [activePage, pageSize, visibleEntries],
  );
  const groupedHistory = useMemo<SessionHistoryGroup[]>(() => {
    if (sort === 'recent') return groupSessionHistory(pagedEntries, favoriteSessionIds);
    // Date buckets would reorder the page after its explicit metric sort.
    const pinned = pagedEntries.filter((entry) => favoriteSessionIds.includes(entry.id));
    const unpinned = pagedEntries.filter((entry) => !favoriteSessionIds.includes(entry.id));
    const groups: SessionHistoryGroup[] = [];
    if (pinned.length > 0) groups.push({ label: 'favorites', favorite: true, rows: pinned });
    if (unpinned.length > 0) groups.push({ label: sort, rows: unpinned });
    return groups;
  }, [favoriteSessionIds, pagedEntries, sort]);
  // Workspace pages lay the time groups out as two columns; balance them
  // around one continuous timeline so neither column sits empty or ragged.
  // The sidebar keeps a single stacked flow (its column wrapper is
  // display:contents, so the DOM shape below is shared by both variants).
  const historyColumnGroups = useMemo<SessionHistoryGroup[][]>(() => {
    if (!workspace) return [groupedHistory, []];
    const columns = splitSessionHistoryColumns(groupedHistory);
    return [columns.left, columns.right];
  }, [groupedHistory, workspace]);
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
            <div
              className={cn(workspace && 'grid gap-5 xl:grid-cols-2', !workspace && 'space-y-5')}
            >
              {historyColumnGroups.map((columnGroups, columnIndex) => (
                <div
                  key={columnIndex}
                  data-history-column={workspace ? columnIndex : undefined}
                  className={cn('min-w-0 space-y-5', !workspace && 'contents')}
                >
                  {columnGroups.map((group) => (
                    <section key={group.label} className="min-w-0">
                      <div
                        className={cn(
                          'sticky top-0 z-[1] flex items-center gap-1 border-b border-border/75 bg-background/95 px-1 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] backdrop-blur-sm',
                          group.favorite ? 'text-warning' : 'text-muted-foreground',
                        )}
                      >
                        {group.favorite ? <Star className="h-3 w-3 fill-current" /> : null}
                        {group.label === 'tokens' || group.label === 'activity'
                          ? t(`activity:sessions.sort.${group.label}`)
                          : t(`activity:sessions.group.${group.label}`)}
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
                                'ws-session-history-row group grid min-w-0 bg-card transition-colors',
                                workspace
                                  ? 'grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto]'
                                  : 'grid-cols-[minmax(0,1fr)_auto]',
                                entry.isCurrent
                                  ? 'border-l-2 border-l-primary bg-primary/5'
                                  : 'border-l-2 border-l-transparent hover:bg-muted/45',
                              )}
                              data-session-id={entry.id}
                            >
                              {isRenaming ? (
                                <SessionRenameField
                                  entry={entry}
                                  renameInput={renameInput}
                                  renameDraft={renameDraft}
                                  setRenameDraft={setRenameDraft}
                                  commitRename={commitRename}
                                  setRenamingId={setRenamingId}
                                />
                              ) : (
                                <button
                                  type="button"
                                  // Only THIS row waits. Disabling every row on
                                  // any pending resume meant one resume that never
                                  // completed — a refusal the client discards as
                                  // guard noise — froze the whole list until the
                                  // 10s timer expired, which read as "Resume does
                                  // nothing" for every session in the list.
                                  disabled={entry.isCurrent || isResuming}
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
                                          <span className="inline-flex shrink-0 items-center gap-1 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-foreground">
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
                                      <SessionRowStats entry={entry} isResuming={isResuming} />
                                    </div>
                                  </div>
                                </button>
                              )}

                              <div className="flex items-start gap-0.5 p-2">
                                {/*
                                  Resume is only offered for a session that is NOT
                                  already on screen. One session, one slot: a
                                  conversation that owns a tab is reached by
                                  clicking its row (which switches to it), and
                                  labelling that "Resume" promised a reload of
                                  something the page is already showing.
                                */}
                                {!entry.isCurrent &&
                                !openTabIds.includes(entry.id) &&
                                workspace &&
                                !isRenaming ? (
                                  <button
                                    type="button"
                                    onClick={() => handleResume(entry.id)}
                                    disabled={resumingId !== null}
                                    className="inline-flex h-7 items-center gap-1 border border-border/75 px-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground hover:border-primary hover:bg-primary/10 disabled:opacity-40"
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
              ))}
            </div>
            <Pagination
              page={activePage}
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

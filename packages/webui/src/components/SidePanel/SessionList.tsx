import type { useWebSocket } from '@/hooks/useWebSocket';
import { cn } from '@/lib/utils';
import { type useHistoryStore, useUIStore } from '@/stores';
import {
  History,
  Loader2,
  Pencil,
  RefreshCw,
  Search,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppTranslation, i18n } from '@/i18n';
import { confirmModal } from '../ConfirmModal';

interface SessionListProps {
  historyQuery: string;
  setHistoryQuery: (v: string) => void;
  historyEntries: ReturnType<typeof useHistoryStore.getState>['entries'];
  historyLoading: boolean;
  historyError: string | null;
  wsConnected: boolean;
  listSessions: ReturnType<typeof useWebSocket>['listSessions'];
  resumeSession: ReturnType<typeof useWebSocket>['resumeSession'];
  deleteSession: ReturnType<typeof useWebSocket>['deleteSession'];
  renameSession: ReturnType<typeof useWebSocket>['renameSession'];
}

export const formatRelative = (iso: string): string => {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000) return i18n.t('common:time.justNow');
  if (diff < 3_600_000) return i18n.t('common:time.minutesAgo', { count: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return i18n.t('common:time.hoursAgo', { count: Math.floor(diff / 3_600_000) });
  const days = Math.floor(diff / 86_400_000);
  if (days < 7) return i18n.t('common:time.daysAgo', { count: days });
  return new Date(ts).toLocaleDateString();
};

/** Pure function: returns IDs of sessions with tokenTotal === 0, excluding the active session. */
export function getEmptySessionIds(
  entries: Array<{ id: string; tokenTotal: number; isCurrent: boolean }>,
): string[] {
  return entries.filter((e) => e.tokenTotal === 0 && !e.isCurrent).map((e) => e.id);
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
}: SessionListProps) {
  const favoriteSessionIds = useUIStore((s) => s.favoriteSessionIds);
  const { t } = useAppTranslation();
  const toggleFavoriteSession = useUIStore((s) => s.toggleFavoriteSession);
  const sessionNicknames = useUIStore((s) => s.sessionNicknames);
  const setSessionNickname = useUIStore((s) => s.setSessionNickname);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  // Persist a rename: keep the local nickname cache in sync (instant label
  // feedback) AND send it to the server so it survives reload/other clients.
  // An empty draft clears the name (the auto-derived title takes over again).
  const commitRename = useCallback(
    (id: string, draft: string) => {
      setRenamingId(null);
      setSessionNickname(id, draft);
      renameSession(id, draft);
    },
    [renameSession, setSessionNickname],
  );

  // Resume-in-flight feedback: mark the clicked row until the server's
  // session.start lands (the refreshed list flips isCurrent) and block
  // double-resumes meanwhile. A failed resume only toasts, so a timeout
  // releases the lock.
  const [resumingId, setResumingId] = useState<string | null>(null);
  useEffect(() => {
    if (resumingId && historyEntries.some((e) => e.id === resumingId && e.isCurrent)) {
      setResumingId(null);
    }
  }, [resumingId, historyEntries]);
  const handleResume = useCallback(
    (id: string) => {
      setResumingId(id);
      resumeSession(id);
      setTimeout(() => setResumingId((cur) => (cur === id ? null : cur)), 10_000);
    },
    [resumeSession],
  );

  const emptySessionIds = useMemo(
    () => getEmptySessionIds(historyEntries),
    [historyEntries],
  );

  const handleDeleteEmpty = useCallback(async () => {
    if (emptySessionIds.length === 0) return;
    const ok = await confirmModal({
      title: t('activity:sessions.deleteEmptyTitle', { count: emptySessionIds.length }),
      message: t('activity:sessions.deleteEmptyConfirmBody'),
      confirmLabel: t('common:action.delete'),
      danger: true,
    });
    if (ok) {
      for (const id of emptySessionIds) deleteSession(id);
    }
  }, [emptySessionIds, deleteSession]);

  const groupedHistory = (() => {
    const q = historyQuery.trim().toLowerCase();
    const filtered = q
      ? historyEntries.filter(
          (e) =>
            (e.name?.toLowerCase().includes(q) ?? false) ||
            e.title.toLowerCase().includes(q) ||
            e.model.toLowerCase().includes(q) ||
            e.provider.toLowerCase().includes(q) ||
            e.id.toLowerCase().includes(q),
        )
      : historyEntries;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const todayStart = startOfDay.getTime();
    const yesterdayStart = todayStart - 86_400_000;
    const weekStart = todayStart - 6 * 86_400_000;
    const buckets = { today: [] as typeof historyEntries, yesterday: [] as typeof historyEntries, week: [] as typeof historyEntries, older: [] as typeof historyEntries };
    for (const e of filtered) {
      const ts = Date.parse(e.startedAt);
      if (Number.isNaN(ts)) { buckets.older.push(e); continue; }
      if (ts >= todayStart) buckets.today.push(e);
      else if (ts >= yesterdayStart) buckets.yesterday.push(e);
      else if (ts >= weekStart) buckets.week.push(e);
      else buckets.older.push(e);
    }
    const favSet = new Set(favoriteSessionIds);
    const favorites = filtered.filter((e) => favSet.has(e.id));
    const out: Array<{ label: string; rows: typeof historyEntries; star?: boolean | undefined }> = [];
    if (favorites.length) out.push({ label: 'favorites', rows: favorites, star: true });
    const dedupe = (arr: typeof historyEntries) => arr.filter((e) => !favSet.has(e.id));
    const today = dedupe(buckets.today);
    const yesterday = dedupe(buckets.yesterday);
    const week = dedupe(buckets.week);
    const older = dedupe(buckets.older);
    if (today.length) out.push({ label: 'today', rows: today });
    if (yesterday.length) out.push({ label: 'yesterday', rows: yesterday });
    if (week.length) out.push({ label: 'thisWeek', rows: week });
    if (older.length) out.push({ label: 'earlier', rows: older });
    return out;
  })();

  return (
    <>
      <div className="flex items-center justify-between px-4 py-2 border-b">
        <span className="text-xs uppercase tracking-wider text-muted-foreground">{t('activity:sessions.recentSessions')}</span>
        <div className="flex items-center gap-1">
          {emptySessionIds.length > 0 && (
            <button
              type="button"
              className="h-6 w-6 inline-flex items-center justify-center rounded-md hover:bg-muted text-muted-foreground hover:text-destructive"
              onClick={handleDeleteEmpty}
              disabled={!wsConnected}
              title={t('activity:sessions.deleteEmptyTitle', { count: emptySessionIds.length })}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            className="h-6 w-6 inline-flex items-center justify-center rounded-md hover:bg-muted"
            onClick={() => listSessions(50)}
            disabled={!wsConnected}
            title={t('common:action.refresh')}
          >
            {historyLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
      {historyEntries.length > 3 && (
        <div className="px-3 py-2 border-b">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/60" />
            <input
              type="text"
              value={historyQuery}
              onChange={(e) => setHistoryQuery(e.target.value)}
              placeholder={t('activity:sessions.filterPlaceholder')}
              className="w-full pl-7 pr-7 py-1 text-xs rounded-md bg-muted/40 border border-transparent focus:bg-background focus:border-input focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
            />
            {historyQuery && (
              <button type="button" onClick={() => setHistoryQuery('')} className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground p-0.5" title={t('activity:sessions.clearFilter')}>
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>
      )}
      {historyError && (
        <div className="px-4 py-2 text-xs text-destructive bg-destructive/5 border-b">{historyError}</div>
      )}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
        {historyEntries.length === 0 && !historyLoading ? (
          <div className="text-center text-muted-foreground py-8 px-4">
            <History className="h-8 w-8 mx-auto mb-3 opacity-20" />
            <p className="text-sm font-medium">{t('activity:sessions.noHistory')}</p>
            <p className="text-xs mt-1">{t('activity:sessions.noHistoryHint')}</p>
          </div>
        ) : groupedHistory.length === 0 ? (
          <div className="text-center text-muted-foreground py-8 px-4">
            <Search className="h-8 w-8 mx-auto mb-3 opacity-20" />
            <p className="text-sm font-medium">{t('activity:sessions.noMatches')}</p>
            <p className="text-xs mt-1">{t('activity:sessions.noMatchesHint')}</p>
          </div>
        ) : (
          <div className="p-2 space-y-3">
            {groupedHistory.map((group) => (
              <div key={group.label} className="space-y-1">
                <div className={cn('sticky top-0 z-[1] px-1 pb-1 text-[10px] uppercase tracking-wider font-semibold bg-card/90 backdrop-blur-sm flex items-center gap-1', group.star ? 'text-warning' : 'text-muted-foreground/80')}>
                  {group.star && <Star className="h-3 w-3 fill-current" />}
                  {t(`activity:sessions.group.${group.label}`)} <span className="text-muted-foreground/50 font-normal normal-case ml-1">({group.rows.length})</span>
                </div>
                {group.rows.map((entry) => (
                  <div key={entry.id} className={cn('group relative rounded-md border text-sm transition-colors', entry.isCurrent ? 'bg-primary/5 border-primary/40' : 'bg-card border-border/60 hover:bg-muted/40 hover:border-primary/40')}>
                    <button
                      type="button"
                      disabled={entry.isCurrent || renamingId === entry.id || resumingId !== null}
                      onClick={() => handleResume(entry.id)}
                      onDoubleClick={(e) => { e.stopPropagation(); setRenamingId(entry.id); setRenameDraft(sessionNicknames[entry.id] ?? entry.name ?? entry.title ?? ''); }}
                      className="block w-full rounded-md px-3 py-2 pr-16 text-left disabled:cursor-default focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <div className="min-w-0 flex-1">
                        {renamingId === entry.id ? (
                          <input
                            value={renameDraft}
                            onChange={(e) => setRenameDraft(e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            onBlur={() => commitRename(entry.id, renameDraft)}
                            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitRename(entry.id, renameDraft); } else if (e.key === 'Escape') { e.preventDefault(); setRenamingId(null); } }}
                            placeholder={entry.title || t('activity:sessions.nicknamePlaceholder')}
                            className="w-full text-sm bg-background border border-input rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-ring"
                          />
                        ) : (
                          <div className="font-medium truncate text-foreground" title={sessionNicknames[entry.id] ?? entry.name ?? entry.title ? t('activity:sessions.renameTitleNickname', { nickname: sessionNicknames[entry.id] ?? entry.name ?? entry.title, title: entry.title }) : t('activity:sessions.renameTitle', { title: entry.title })}>
                            {sessionNicknames[entry.id] || entry.name || entry.title || t('activity:sessions.empty')}
                          </div>
                        )}
                        <div className="text-[10px] text-muted-foreground font-mono truncate mt-0.5">{entry.provider}/{entry.model}</div>
                        <div className="flex items-center gap-2 text-[10px] text-muted-foreground/80 mt-0.5">
                          {resumingId === entry.id ? (
                            <span className="flex items-center gap-1 text-primary font-medium">
                              <Loader2 className="h-3 w-3 animate-spin" />
                              {t('activity:sessions.resuming')}
                            </span>
                          ) : (
                            <span>{formatRelative(entry.startedAt)}</span>
                          )}
                          {entry.tokenTotal > 0 && <><span className="opacity-50">·</span><span className="tabular-nums">{entry.tokenTotal.toLocaleString()} tok</span></>}
                          {entry.isCurrent && <><span className="opacity-50">·</span><span className="text-primary font-medium">{t('activity:sessions.active')}</span></>}
                        </div>
                      </div>
                    </button>
                    <div className="absolute right-2 top-2 flex items-center gap-1">
                      <button type="button" onClick={() => toggleFavoriteSession(entry.id)} className={cn('transition-opacity hover:text-warning', favoriteSessionIds.includes(entry.id) ? 'opacity-100 text-warning' : 'opacity-0 group-hover:opacity-100 text-muted-foreground')} title={favoriteSessionIds.includes(entry.id) ? t('activity:sessions.unfavorite') : t('activity:sessions.markFavorite')}>
                        <Star className={cn('h-3.5 w-3.5', favoriteSessionIds.includes(entry.id) && 'fill-current')} />
                      </button>
                      {renamingId !== entry.id && (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setRenamingId(entry.id); setRenameDraft(sessionNicknames[entry.id] ?? entry.name ?? entry.title ?? ''); }}
                          className={cn('transition-opacity hover:text-primary', (entry.name || sessionNicknames[entry.id]) ? 'opacity-100 text-primary/70' : 'opacity-0 group-hover:opacity-100 text-muted-foreground')}
                          title={t('activity:sessions.rename', { defaultValue: 'Rename' })}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {!entry.isCurrent && (
                        <button
                          type="button"
                          onClick={async () => {
                            const ok = await confirmModal({
                              title: t('activity:sessions.deleteSessionConfirmTitle'),
                              message: t('activity:sessions.deleteSessionConfirmBody', { name: sessionNicknames[entry.id] || entry.title || t('activity:sessions.empty') }),
                              confirmLabel: t('common:action.delete'),
                              danger: true,
                            });
                            if (ok) deleteSession(entry.id);
                          }}
                          className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                          title={t('activity:sessions.deleteSessionTitle')}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

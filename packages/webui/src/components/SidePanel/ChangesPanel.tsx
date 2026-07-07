/**
 * ChangesPanel — the source-control file list shown in the SidePanel when the
 * Changes activity is active. Lists every file that differs from HEAD (staged,
 * unstaged, untracked) with its status badge and +/- line counts. Clicking a
 * file requests its diff and opens it in the main pane (ChangesView).
 */

import { GitCompare, Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { cn } from '@/lib/utils';
import { showPanel } from '@/lib/view-navigation';
import { type GitChangedFile, useConfigStore, useGitChangesStore } from '@/stores';
import { useAppTranslation } from '@/i18n';

/** Visual treatment for each git status letter. */
const STATUS_META: Record<string, { label: string; cls: string }> = {
  M: { label: 'M', cls: 'text-warning' },
  A: { label: 'A', cls: 'text-success' },
  D: { label: 'D', cls: 'text-destructive' },
  R: { label: 'R', cls: 'text-info' },
  C: { label: 'C', cls: 'text-info' },
  U: { label: 'U', cls: 'text-warning' },
  '?': { label: 'U', cls: 'text-muted-foreground' },
};

/** Split "a/b/c.ts" into ("c.ts", "a/b/") for the two-tone row label. */
function splitPath(path: string): { name: string; dir: string } {
  const idx = path.lastIndexOf('/');
  if (idx < 0) return { name: path, dir: '' };
  return { name: path.slice(idx + 1), dir: path.slice(0, idx + 1) };
}

function FileRow({
  file,
  active,
  onSelect,
}: {
  file: GitChangedFile;
  active: boolean;
  onSelect: () => void;
}) {
  const meta = STATUS_META[file.status] ?? STATUS_META.M;
  const { name, dir } = splitPath(file.path);
  return (
    <button
      type="button"
      onClick={onSelect}
      title={file.path}
      className={cn(
        'group flex items-center gap-2 w-full px-2 py-1 text-left text-xs rounded hover:bg-accent/60',
        active && 'bg-accent',
      )}
    >
      <span className={cn('w-3 shrink-0 text-center font-mono font-bold', meta?.cls)}>
        {meta?.label}
      </span>
      <span className="flex min-w-0 flex-1 items-baseline gap-1 overflow-hidden">
        <span className={cn('min-w-0 truncate', file.status === 'D' && 'line-through opacity-70')}>
          {name}
        </span>
        {dir && <span className="min-w-0 flex-1 truncate text-muted-foreground/60">{dir}</span>}
      </span>
      <span className="shrink-0 font-mono text-[10px] tabular-nums">
        {file.added > 0 && <span className="text-success">+{file.added}</span>}
        {file.deleted > 0 && (
          <span className="text-destructive ml-1">-{file.deleted}</span>
        )}
      </span>
    </button>
  );
}

export function ChangesPanel() {
  const { client } = useWebSocket();
  const { t } = useAppTranslation();
  const wsConnected = useConfigStore((s) => s.wsConnected);
  const files = useGitChangesStore((s) => s.files);
  const error = useGitChangesStore((s) => s.error);
  const loadingList = useGitChangesStore((s) => s.loadingList);
  const selectedPath = useGitChangesStore((s) => s.selectedPath);

  const refresh = useCallback(() => {
    if (!wsConnected) return;
    useGitChangesStore.getState().setListLoading(true);
    client?.getGitChanges?.();
  }, [client, wsConnected]);

  // Fetch on mount / when the panel becomes connected.
  useEffect(() => {
    refresh();
  }, [refresh]);

  const select = (path: string) => {
    useGitChangesStore.getState().select(path);
    client?.getGitDiff?.(path);
    showPanel('changes');
  };

  const totalAdded = files.reduce((n, f) => n + f.added, 0);
  const totalDeleted = files.reduce((n, f) => n + f.deleted, 0);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b shrink-0">
        <span className="text-[11px] text-muted-foreground font-mono">
          {t('activity:changes.fileCount', { count: files.length })}
          {files.length > 0 && (
            <>
              {' · '}
              <span className="text-success">+{totalAdded}</span>{' '}
              <span className="text-destructive">-{totalDeleted}</span>
            </>
          )}
        </span>
        <button
          type="button"
          onClick={refresh}
          title={t('activity:changes.refreshTitle')}
          className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-accent text-muted-foreground"
        >
          {loadingList ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
        </button>
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-1.5">
        {error ? (
          <div className="px-2 py-6 text-center text-xs text-muted-foreground">{error}</div>
        ) : files.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-2 py-10 text-center text-xs text-muted-foreground">
            <GitCompare className="h-6 w-6 opacity-40" />
            {loadingList ? t('activity:changes.loading') : t('activity:changes.clean')}
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {files.map((f) => (
              <FileRow
                key={f.path}
                file={f}
                active={f.path === selectedPath}
                onSelect={() => select(f.path)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

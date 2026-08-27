import {
  Check,
  GitCommitHorizontal,
  GitCompare,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  Undo2,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { cn } from '@/lib/utils';
import { showPanel } from '@/lib/view-navigation';
import {
  type GitChangedFile,
  useConfigStore,
  useGitChangesStore,
  useUIStore,
} from '@/stores';
import { useAppTranslation } from '@/i18n';
import { WorktreesPanel } from './WorktreesPanel';

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
  onStage,
  onUnstage,
  onDiscard,
}: {
  file: GitChangedFile;
  active: boolean;
  onSelect: () => void;
  onStage?: () => void;
  onUnstage?: () => void;
  onDiscard?: () => void;
}) {
  const meta = STATUS_META[file.status] ?? STATUS_META.M;
  const { name, dir } = splitPath(file.path);
  return (
    <div
      className={cn(
        'group flex items-center gap-1.5 w-full px-2 py-1 text-left text-xs rounded hover:bg-accent/60 transition-colors',
        active && 'bg-accent',
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        title={file.path}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <span className={cn('w-3 shrink-0 text-center font-mono font-bold', meta?.cls)}>
          {meta?.label}
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-1 overflow-hidden">
          <span className={cn('min-w-0 truncate', file.status === 'D' && 'line-through opacity-70')}>
            {name}
          </span>
          {dir && <span className="min-w-0 flex-1 truncate text-muted-foreground/75">{dir}</span>}
        </span>
        <span className="shrink-0 font-mono text-[10px] tabular-nums mr-1">
          {file.added > 0 && <span className="text-success">+{file.added}</span>}
          {file.deleted > 0 && (
            <span className="text-destructive ml-1">-{file.deleted}</span>
          )}
        </span>
      </button>

      {/* Row quick actions on hover */}
      <div className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {file.staged ? (
          onUnstage && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onUnstage();
              }}
              title="Unstage changes"
              className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-background/80 text-muted-foreground hover:text-foreground"
            >
              <Minus className="h-3 w-3" />
            </button>
          )
        ) : (
          <>
            {onStage && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onStage();
                }}
                title="Stage changes"
                className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-background/80 text-muted-foreground hover:text-foreground"
              >
                <Plus className="h-3 w-3" />
              </button>
            )}
            {onDiscard && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (window.confirm(`Discard changes in ${file.path}? This cannot be undone.`)) {
                    onDiscard();
                  }
                }}
                title="Discard changes"
                className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
              >
                <Undo2 className="h-3 w-3" />
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function ChangesPanel() {
  const { client, stageGit, unstageGit, discardGit, commitGit } = useWebSocket();
  const { t } = useAppTranslation();
  const wsConnected = useConfigStore((s) => s.wsConnected);
  const files = useGitChangesStore((s) => s.files);
  const error = useGitChangesStore((s) => s.error);
  const loadingList = useGitChangesStore((s) => s.loadingList);
  const selectedPath = useGitChangesStore((s) => s.selectedPath);
  // Worktree lanes moved from the ActivityBar into this panel (store-driven so
  // shortcuts, slash commands and the desktop bridge can deep-link the tab).
  const changesPanelTab = useUIStore((s) => s.changesPanelTab);
  const setChangesPanelTab = useUIStore((s) => s.setChangesPanelTab);

  const [commitMessage, setCommitMessage] = useState('');
  const [committing, setCommitting] = useState(false);

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

  const handleCommit = async () => {
    const msg = commitMessage.trim();
    if (!msg || committing) return;
    setCommitting(true);
    try {
      commitGit?.(msg);
      setCommitMessage('');
    } finally {
      setCommitting(false);
    }
  };

  const stagedFiles = files.filter((f) => f.staged);
  const unstagedFiles = files.filter((f) => !f.staged);

  const totalAdded = files.reduce((n, f) => n + f.added, 0);
  const totalDeleted = files.reduce((n, f) => n + f.deleted, 0);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      {/* Tab strip — Worktree lanes moved in from the retired ActivityBar icon */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1.5">
        <button
          type="button"
          onClick={() => setChangesPanelTab('changes')}
          className={cn(
            'h-6 rounded px-2 text-[11px] font-medium transition-colors',
            changesPanelTab === 'changes'
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >
          {t('activity:nav.changes', 'Changes')}
        </button>
        <button
          type="button"
          onClick={() => setChangesPanelTab('worktrees')}
          className={cn(
            'h-6 rounded px-2 text-[11px] font-medium transition-colors',
            changesPanelTab === 'worktrees'
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >
          {t('activity:nav.worktrees', 'Worktrees')}
        </button>
      </div>

      {changesPanelTab === 'worktrees' ? (
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
          <WorktreesPanel />
        </div>
      ) : (
        <>
      <div className="flex items-center justify-between px-3 py-2 border-b shrink-0 bg-background/50">
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
        <div className="flex items-center gap-1">
          {unstagedFiles.length > 0 && (
            <button
              type="button"
              onClick={() => stageGit?.([])}
              title="Stage all changes"
              className="h-6 px-1.5 inline-flex items-center gap-1 rounded text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent"
            >
              <Plus className="h-3 w-3" />
              <span>Stage All</span>
            </button>
          )}
          {stagedFiles.length > 0 && (
            <button
              type="button"
              onClick={() => unstageGit?.([])}
              title="Unstage all changes"
              className="h-6 px-1.5 inline-flex items-center gap-1 rounded text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent"
            >
              <Minus className="h-3 w-3" />
              <span>Unstage All</span>
            </button>
          )}
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
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-1.5 space-y-3">
        {error ? (
          <div className="px-2 py-6 text-center text-xs text-muted-foreground">{error}</div>
        ) : files.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-2 py-10 text-center text-xs text-muted-foreground">
            <GitCompare className="h-6 w-6 opacity-40" />
            {loadingList ? t('activity:changes.loading') : t('activity:changes.clean')}
          </div>
        ) : (
          <>
            {/* Staged Group */}
            {stagedFiles.length > 0 && (
              <div>
                <div className="flex items-center justify-between px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-primary">
                  <span>Staged Changes ({stagedFiles.length})</span>
                </div>
                <div className="flex flex-col gap-0.5">
                  {stagedFiles.map((f) => (
                    <FileRow
                      key={`staged-${f.path}`}
                      file={f}
                      active={f.path === selectedPath}
                      onSelect={() => select(f.path)}
                      onUnstage={() => unstageGit?.(f.path)}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Unstaged / Untracked Group */}
            {unstagedFiles.length > 0 && (
              <div>
                <div className="flex items-center justify-between px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <span>Changes ({unstagedFiles.length})</span>
                </div>
                <div className="flex flex-col gap-0.5">
                  {unstagedFiles.map((f) => (
                    <FileRow
                      key={`unstaged-${f.path}`}
                      file={f}
                      active={f.path === selectedPath}
                      onSelect={() => select(f.path)}
                      onStage={() => stageGit?.(f.path)}
                      onDiscard={() => discardGit?.(f.path)}
                    />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Commit Box at Bottom */}
      {files.length > 0 && (
        <div className="p-2 border-t border-border/70 bg-card/40 shrink-0 space-y-1.5">
          <div className="relative">
            <textarea
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                  e.preventDefault();
                  handleCommit();
                }
              }}
              placeholder={stagedFiles.length > 0 ? "Commit message (Ctrl+Enter)..." : "Stage changes to commit..."}
              rows={2}
              className="w-full resize-none rounded-md border border-input bg-background/80 px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <button
            type="button"
            onClick={handleCommit}
            disabled={stagedFiles.length === 0 || !commitMessage.trim() || committing}
            className="w-full h-7 inline-flex items-center justify-center gap-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium transition-colors hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
          >
            {committing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <GitCommitHorizontal className="h-3.5 w-3.5" />
            )}
            <span>Commit {stagedFiles.length > 0 ? `(${stagedFiles.length})` : ''}</span>
          </button>
        </div>
      )}
        </>
      )}
    </div>
  );
}

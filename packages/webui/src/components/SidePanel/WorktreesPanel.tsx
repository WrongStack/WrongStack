import {
  AlertTriangle,
  CheckCircle2,
  Eraser,
  Eye,
  FolderOpen,
  GitBranch,
  GitMerge,
  Loader2,
  RefreshCw,
  Terminal,
  Trash2,
  XCircle,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { cn } from '@/lib/utils';
import { useAppTranslation } from '@/i18n';
import { useWorktreeStore } from '@/stores';
import { confirmModal } from '../ConfirmModal';

/** Active in-session statuses where destructive actions are blocked. */
const LIVE_STATUSES = new Set(['allocating', 'active', 'committing', 'merging']);

interface Row {
  branch?: string;
  dir?: string;
  status: string; // live status, or 'orphan'
  baseBranch?: string;
  insertions: number;
  deletions: number;
  files: number;
  owner?: string;
  live: boolean;
}

const STATUS_TINT: Record<string, string> = {
  active: 'text-warning',
  committing: 'text-primary',
  merging: 'text-info',
  merged: 'text-success',
  'needs-review': 'text-destructive',
  failed: 'text-destructive',
  orphan: 'text-muted-foreground',
};

/**
 * WorktreesPanel — the dedicated worktree manager (left-nav). Unifies live
 * (event-driven) worktrees with disk-scanned orphans and exposes per-row
 * actions: open in terminal / folder, view changes, merge to base, remove.
 * Destructive actions are refused server-side while a run owns the worktree.
 */
export function WorktreesPanel(): React.ReactElement {
  const { client } = useWebSocket();
  const { t } = useAppTranslation();
  const shortBranch = (b?: string) =>
    b ? b.replace(/^wstack\/ap\//, '') : t('activity:worktrees.detached');
  const live = useWorktreeStore((s) => s.worktrees);
  const orphans = useWorktreeStore((s) => s.orphans);
  const baseBranch = useWorktreeStore((s) => s.baseBranch);
  const canClean = useWorktreeStore((s) => s.canClean);
  const cleanResult = useWorktreeStore((s) => s.cleanResult);
  const mergeResult = useWorktreeStore((s) => s.mergeResult);
  const diffByDir = useWorktreeStore((s) => s.diffByDir);
  const [busyBranch, setBusyBranch] = useState<string | null>(null);
  const [openDiff, setOpenDiff] = useState<string | null>(null);

  // Bind once: `client.send` reads `this.ws` internally, so it MUST be invoked
  // as a method on the client. Extracting the bare method (`const send =
  // client.send`) drops the `this` binding and the first call throws
  // "can't access property 'ws', this is undefined". Every other panel calls
  // `client.send(...)` directly for the same reason.
  const send = useMemo(() => (client ? client.send.bind(client) : undefined), [client]);
  useEffect(() => {
    send?.({ type: 'worktree.scan' });
  }, [send]);

  // Clear the per-row spinner once a merge/clean result lands.
  useEffect(() => {
    setBusyBranch(null);
  }, [mergeResult, cleanResult]);

  const rows = useMemo<Row[]>(() => {
    const liveBranches = new Set(live.map((w) => w.branch));
    const out: Row[] = live.map((w) => ({
      branch: w.branch,
      dir: w.dir,
      status: w.status,
      baseBranch: w.baseBranch,
      insertions: w.insertions,
      deletions: w.deletions,
      files: w.files,
      owner: w.ownerLabel,
      live: LIVE_STATUSES.has(w.status),
    }));
    for (const o of orphans) {
      if (o.branch && liveBranches.has(o.branch)) continue; // already shown as live
      out.push({
        branch: o.branch,
        dir: o.dir,
        status: 'orphan',
        insertions: 0,
        deletions: 0,
        files: 0,
        live: false,
      });
    }
    return out;
  }, [live, orphans]);

  const onOpen = (dir: string | undefined, target: 'terminal' | 'file-manager') => {
    if (dir) send?.({ type: 'shell.open', payload: { path: dir, target } });
  };
  const onDiff = (dir?: string) => {
    if (!dir) return;
    send?.({ type: 'worktree.diff', payload: { dir } });
    setOpenDiff((cur) => (cur === dir ? null : dir));
  };
  const onMerge = async (branch?: string) => {
    if (!branch) return;
    const ok = await confirmModal({
      title: t('activity:worktrees.mergeConfirmTitle', {
        branch: shortBranch(branch),
        base: baseBranch || t('activity:worktrees.baseLabel'),
      }),
      message: t('activity:worktrees.mergeConfirmMsg'),
      confirmLabel: t('activity:worktrees.mergeAction'),
    });
    if (!ok) return;
    setBusyBranch(branch);
    send?.({ type: 'worktree.merge', payload: { branch } });
  };
  const onRemove = async (row: Row) => {
    const ok = await confirmModal({
      title: t('activity:worktrees.removeConfirmTitle', { branch: shortBranch(row.branch) }),
      message: t('activity:worktrees.removeConfirmMsg'),
      confirmLabel: t('common:action.remove'),
      danger: true,
    });
    if (!ok) return;
    setBusyBranch(row.branch ?? '');
    send?.({ type: 'worktree.remove', payload: { dir: row.dir, branch: row.branch } });
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="text-[11px] text-muted-foreground">
          {t('activity:worktrees.count', { count: rows.length })}
          {baseBranch ? t('activity:worktrees.baseSuffix', { base: baseBranch }) : ''}
        </span>
        <div className="flex items-center gap-1">
          {orphans.length > 0 && (
            <button
              type="button"
              disabled={!canClean}
              onClick={() => send?.({ type: 'worktree.cleanup' })}
              title={
                canClean
                  ? t('activity:worktrees.cleanOrphansTitle')
                  : t('activity:worktrees.liveBusyTitle')
              }
              className="inline-flex items-center gap-1 rounded bg-warning px-1.5 py-0.5 text-[11px] font-medium text-primary-foreground hover:bg-warning/90 disabled:opacity-50"
            >
              <Eraser className="h-3 w-3" /> {t('activity:worktrees.cleanOrphans')}
            </button>
          )}
          <button
            type="button"
            onClick={() => send?.({ type: 'worktree.scan' })}
            title={t('activity:worktrees.rescanTitle')}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Result banners */}
      {cleanResult && (
        <Banner ok={cleanResult.ok}>
          {cleanResult.ok
            ? t('activity:worktrees.removed', { count: cleanResult.removed })
            : (cleanResult.reason ?? t('activity:worktrees.failed'))}
        </Banner>
      )}
      {mergeResult && (
        <Banner ok={mergeResult.ok}>
          {mergeResult.ok
            ? t('activity:worktrees.mergedIntoBase', { branch: shortBranch(mergeResult.branch) })
            : mergeResult.conflict
              ? t('activity:worktrees.conflictMerge', {
                  branch: shortBranch(mergeResult.branch),
                  files:
                    (mergeResult.conflictFiles ?? []).join(', ') || t('activity:worktrees.seeGit'),
                })
              : t('activity:worktrees.mergeFailed', {
                  reason: mergeResult.reason ?? t('activity:worktrees.unknownReason'),
                })}
        </Banner>
      )}

      {/* List */}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3 [scrollbar-gutter:stable]">
        {rows.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-xs text-muted-foreground">
            <GitBranch className="h-8 w-8 opacity-30" />
            <p>{t('activity:worktrees.empty')}</p>
            <p className="max-w-[200px]">{t('activity:worktrees.emptyHint')}</p>
          </div>
        ) : (
          rows.map((row, i) => {
            const busy = busyBranch === (row.branch ?? '');
            const diff = row.dir ? diffByDir[row.dir] : undefined;
            return (
              <div
                key={`${row.branch ?? row.dir ?? i}`}
                className="mb-1.5 rounded-md border border-border bg-card/60 px-2.5 py-2"
              >
                <div className="flex items-center gap-2">
                  <GitBranch
                    className={cn(
                      'h-3.5 w-3.5 shrink-0',
                      STATUS_TINT[row.status] ?? 'text-muted-foreground',
                    )}
                  />
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-xs text-foreground"
                    title={row.branch}
                  >
                    {shortBranch(row.branch)}
                  </span>
                  <span
                    className={cn(
                      'shrink-0 text-[10px] uppercase',
                      STATUS_TINT[row.status] ?? 'text-muted-foreground',
                    )}
                  >
                    {row.status}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-2 pl-5 text-[10px] text-muted-foreground">
                  {row.owner && <span className="truncate">{row.owner}</span>}
                  {(row.insertions > 0 || row.deletions > 0) && (
                    <span className="shrink-0">
                      <span className="text-success">+{row.insertions}</span>{' '}
                      <span className="text-destructive">−{row.deletions}</span> · {row.files}f
                    </span>
                  )}
                </div>

                {/* Actions */}
                <div className="mt-1.5 flex items-center gap-0.5 pl-5">
                  <Act
                    title={t('activity:worktrees.actOpenTerm')}
                    disabled={!row.dir}
                    onClick={() => onOpen(row.dir, 'terminal')}
                  >
                    <Terminal className="h-3.5 w-3.5" />
                  </Act>
                  <Act
                    title={t('activity:worktrees.actOpenFolder')}
                    disabled={!row.dir}
                    onClick={() => onOpen(row.dir, 'file-manager')}
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                  </Act>
                  <Act
                    title={t('activity:worktrees.actViewChanges')}
                    disabled={!row.dir}
                    onClick={() => onDiff(row.dir)}
                  >
                    <Eye className="h-3.5 w-3.5" />
                  </Act>
                  <Act
                    title={t('activity:worktrees.actMerge')}
                    disabled={row.live || !row.branch}
                    onClick={() => onMerge(row.branch)}
                  >
                    {busy ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <GitMerge className="h-3.5 w-3.5" />
                    )}
                  </Act>
                  <Act
                    title={t('activity:worktrees.actRemove')}
                    danger
                    disabled={row.live}
                    onClick={() => onRemove(row)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Act>
                  {row.live && (
                    <span className="ml-1 text-[10px] text-warning">
                      {t('activity:worktrees.live')}
                    </span>
                  )}
                </div>

                {/* Inline diff summary */}
                {openDiff === row.dir && diff !== undefined && (
                  <div className="mt-1.5 ml-5 rounded bg-muted/50 p-1.5 text-[10px]">
                    {diff === null || diff.files.length === 0 ? (
                      <span className="text-muted-foreground">
                        {t('activity:worktrees.noUncommitted')}
                        {diff && diff.commits > 0
                          ? ` · ${t('activity:worktrees.commitsAhead', { count: diff.commits })}`
                          : ''}
                        .
                      </span>
                    ) : (
                      <>
                        <div className="mb-1 text-muted-foreground">
                          {diff.commits > 0
                            ? `${t('activity:worktrees.commitsAhead', { count: diff.commits })} · `
                            : ''}
                          <span className="text-success">+{diff.insertions}</span>{' '}
                          <span className="text-destructive">−{diff.deletions}</span>
                        </div>
                        {diff.files.slice(0, 12).map((f) => (
                          <div key={f.path} className="truncate font-mono">
                            <span className="text-success">+{f.insertions}</span>{' '}
                            <span className="text-destructive">−{f.deletions}</span> {f.path}
                          </div>
                        ))}
                        {diff.files.length > 12 && (
                          <div className="text-muted-foreground">
                            {t('activity:worktrees.more', { count: diff.files.length - 12 })}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function Act({
  title,
  onClick,
  disabled,
  danger,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'rounded p-1 text-muted-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-30',
        danger ? 'hover:text-destructive' : 'hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

function Banner({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        'flex items-start gap-1.5 border-y px-3 py-1.5 text-[11px]',
        ok
          ? 'border-success/30 bg-success/5 text-success'
          : 'border-warning/30 bg-warning/5 text-warning',
      )}
    >
      {ok ? (
        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      ) : (
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      )}
      <span className="min-w-0 flex-1">{children}</span>
      {!ok && <XCircle className="mt-0.5 h-3 w-3 shrink-0 opacity-40" />}
    </div>
  );
}

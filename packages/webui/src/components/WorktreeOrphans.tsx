import { AlertTriangle, Eraser, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useAppTranslation } from '@/i18n';
import { useWorktreeStore } from '@/stores';
import { confirmModal } from './ConfirmModal';

const shortBranch = (b?: string) => (b ? b.replace(/^wstack\/ap\//, '') : '');

/**
 * WorktreeOrphans — surfaces git worktrees/branches left behind by previous or
 * crashed runs (scanned from disk) and offers a guarded one-click cleanup. Self-
 * contained: scans on mount, reads the worktree store, and sends scan/cleanup WS
 * messages. Renders nothing when there is nothing to show, so it stays out of the
 * way in a clean project. Drop it next to <WorktreeLanes />.
 */
export function WorktreeOrphans(): React.ReactElement | null {
  const { t } = useAppTranslation();
  const { client } = useWebSocket();
  const orphans = useWorktreeStore((s) => s.orphans);
  const canClean = useWorktreeStore((s) => s.canClean);
  const blockedReason = useWorktreeStore((s) => s.cleanBlockedReason);
  const cleanResult = useWorktreeStore((s) => s.cleanResult);
  const [cleaning, setCleaning] = useState(false);

  // Scan once on mount (and whenever the socket reconnects).
  useEffect(() => {
    client?.send?.({ type: 'worktree.scan' });
  }, [client]);

  // Clear the local "cleaning" spinner once a result lands.
  useEffect(() => {
    if (cleanResult) setCleaning(false);
  }, [cleanResult]);

  const onClean = async () => {
    const n = orphans.length;
    const ok = await confirmModal({
      title: t('activity:worktree.cleanTitle', { count: n }),
      message: t('activity:worktree.cleanMessage'),
      confirmLabel: t('activity:worktree.cleanConfirm'),
      danger: true,
    });
    if (!ok) return;
    setCleaning(true);
    client?.send?.({ type: 'worktree.cleanup' });
  };

  if (orphans.length === 0 && !cleanResult) return null;

  return (
    <div className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs">
      {orphans.length > 0 ? (
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <div className="min-w-0 flex-1">
            <div className="font-medium text-warning">
              {t('activity:worktree.orphanCount', { count: orphans.length })}
            </div>
            <div className="mt-0.5 max-h-16 overflow-auto font-mono text-[10px] text-muted-foreground">
              {orphans.slice(0, 8).map((o, i) => (
                <div key={`${o.kind}-${o.branch ?? o.dir ?? i}`} className="truncate">
                  {o.kind === 'branch' ? '⌥ ' : '▢ '}
                  {shortBranch(o.branch) || o.dir}
                </div>
              ))}
              {orphans.length > 8 && <div>{t('activity:worktree.andMore', { count: orphans.length - 8 })}</div>}
            </div>
          </div>
          <button
            type="button"
            disabled={!canClean || cleaning}
            onClick={onClean}
            title={canClean ? t('activity:worktree.cleanButtonTitle') : blockedReason}
            className="inline-flex shrink-0 items-center gap-1 rounded bg-warning px-2 py-1 font-medium text-primary-foreground hover:bg-warning/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {cleaning ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Eraser className="h-3.5 w-3.5" />
            )}
            {t('activity:worktree.cleanConfirm')}
          </button>
        </div>
      ) : null}
      {cleanResult && (
        <div
          className={cleanResult.ok ? 'mt-1 text-success' : 'mt-1 text-destructive'}
        >
          {cleanResult.ok
            ? t('activity:worktree.removed', { count: cleanResult.removed })
            : `✗ ${cleanResult.reason ?? t('activity:worktree.cleanupFailed')}`}
        </div>
      )}
    </div>
  );
}

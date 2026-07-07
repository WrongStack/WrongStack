import { AlertTriangle, Loader2, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import type { SddBoardSnapshotUI } from '@/stores';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';

/**
 * SddDestroyDialog — the "give up entirely" confirmation. Spells out exactly
 * what a destroy does so it is never a surprise: stop the run, force-remove
 * every worktree + branch (including un-merged work), optionally revert merged
 * commits, and delete all on-disk SDD artifacts. Irreversible apart from the
 * merged-commit revert (which is history-preserving).
 */
export function SddDestroyDialog({
  open,
  onOpenChange,
  snapshot,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  snapshot: SddBoardSnapshotUI | null;
  busy: boolean;
  onConfirm: (revertMerged: boolean) => void;
}): React.ReactElement {
  const { t } = useAppTranslation();
  const mergedCount = snapshot?.mergedCommits?.length ?? 0;
  const baseBranch = snapshot?.baseBranch;
  const [revertMerged, setRevertMerged] = useState(false);

  // Reset the checkbox each time the dialog opens (default = leave merged commits).
  useEffect(() => {
    if (open) setRevertMerged(false);
  }, [open]);

  const isActive = snapshot?.status === 'running' || snapshot?.status === 'paused';
  const worktreeCount = useMemo(() => {
    const s = new Set<string>();
    for (const t of snapshot?.tasks ?? []) if (t.worktreeBranch) s.add(t.worktreeBranch);
    return s.size;
  }, [snapshot?.tasks]);
  const runningAgents = useMemo(() => {
    const s = new Set<string>();
    for (const t of snapshot?.tasks ?? [])
      if (t.displayStatus === 'in_progress' && t.agentName) s.add(t.agentName);
    return s.size;
  }, [snapshot?.tasks]);

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="sm:max-w-lg border-destructive/50">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2 className="h-5 w-5 text-destructive" />
            {t('activity:sdd.destroyTitle')}
          </DialogTitle>
          <DialogDescription>
            {t('activity:sdd.destroyDesc')}
          </DialogDescription>
        </DialogHeader>

        <ul className="space-y-1.5 py-1 text-sm">
          {isActive && (
            <li className="flex items-start gap-2">
              <span className="mt-0.5 text-destructive">■</span>
              <span>
                {runningAgents > 0
                  ? t('activity:sdd.stopRunAgents', { count: runningAgents })
                  : t('activity:sdd.stopRun')}
              </span>
            </li>
          )}
          <li className="flex items-start gap-2">
            <span className="mt-0.5 text-destructive">■</span>
            <span>
              {worktreeCount > 0
                ? t('activity:sdd.removeWorktreesCount', { count: worktreeCount })
                : t('activity:sdd.removeWorktreesAll')}
            </span>
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-0.5 text-destructive">■</span>
            <span>{t('activity:sdd.deleteArtifacts')}</span>
          </li>
        </ul>

        {mergedCount > 0 && (
          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-warning/30 bg-warning/5 p-2.5 text-sm">
            <input
              type="checkbox"
              checked={revertMerged}
              onChange={(e) => setRevertMerged(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-warning"
            />
            <span>
              <span className="font-medium">{t('activity:sdd.revertMerged', { count: mergedCount })}</span>{' '}
              on <code className="text-xs">{baseBranch ?? t('activity:sdd.baseBranchFallback')}</code>
              <span className="block text-xs text-muted-foreground">
                {t('activity:sdd.revertHint')}
              </span>
            </span>
          </label>
        )}

        <div className="flex items-start gap-2 rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
          {mergedCount > 0 && !revertMerged
            ? t('activity:sdd.noteLeaveMerged')
            : t('activity:sdd.noteAbandon')}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => onOpenChange(false)}>
            {t('common:action.cancel')}
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => onConfirm(revertMerged)}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {busy ? (
              <>
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> {t('activity:sdd.destroying')}
              </>
            ) : (
              <>
                <Trash2 className="mr-1 h-3.5 w-3.5" /> {t('activity:sdd.destroyAll')}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

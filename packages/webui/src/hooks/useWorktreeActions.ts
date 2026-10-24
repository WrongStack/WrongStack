import { shortWorktreeBranch } from '@wrongstack/contracts/types/worktree-timeline';
import { useEffect, useMemo, useState } from 'react';
import { confirmModal } from '@/components/ConfirmModal';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useAppTranslation } from '@/i18n';
import { useWorktreeStore } from '@/stores';

/**
 * Worktree row actions shared by the Worktrees panel and the timeline detail:
 * open in terminal / file manager, view changes, merge to base, remove. Merge
 * and remove confirm first; the server refuses both while a run owns the
 * worktree. `busyBranch` spins until the matching result lands.
 */
export function useWorktreeActions() {
  const { client } = useWebSocket();
  const { t } = useAppTranslation();
  const baseBranch = useWorktreeStore((s) => s.baseBranch);
  const mergeResult = useWorktreeStore((s) => s.mergeResult);
  const cleanResult = useWorktreeStore((s) => s.cleanResult);
  const [busyBranch, setBusyBranch] = useState<string | null>(null);

  // Bind once: `client.send` reads `this.ws` internally, so it MUST be invoked
  // as a method on the client. Extracting the bare method drops the `this`
  // binding and the first call throws.
  const send = useMemo(() => (client ? client.send.bind(client) : undefined), [client]);

  useEffect(() => {
    setBusyBranch(null);
  }, [mergeResult, cleanResult]);

  const label = (branch?: string) =>
    branch ? shortWorktreeBranch(branch) : t('activity:worktrees.detached');

  return {
    send,
    busyBranch,
    open: (dir: string | undefined, target: 'terminal' | 'file-manager') => {
      if (dir) send?.({ type: 'shell.open', payload: { path: dir, target } });
    },
    viewChanges: (dir: string | undefined) => {
      if (dir) send?.({ type: 'worktree.diff', payload: { dir } });
    },
    merge: async (branch: string | undefined) => {
      if (!branch) return;
      const ok = await confirmModal({
        title: t('activity:worktrees.mergeConfirmTitle', {
          branch: label(branch),
          base: baseBranch || t('activity:worktrees.baseLabel'),
        }),
        message: t('activity:worktrees.mergeConfirmMsg'),
        confirmLabel: t('activity:worktrees.mergeAction'),
      });
      if (!ok) return;
      setBusyBranch(branch);
      send?.({ type: 'worktree.merge', payload: { branch } });
    },
    remove: async (target: { dir?: string | undefined; branch?: string | undefined }) => {
      const ok = await confirmModal({
        title: t('activity:worktrees.removeConfirmTitle', { branch: label(target.branch) }),
        message: t('activity:worktrees.removeConfirmMsg'),
        confirmLabel: t('common:action.remove'),
        danger: true,
      });
      if (!ok) return;
      setBusyBranch(target.branch ?? '');
      send?.({ type: 'worktree.remove', payload: { dir: target.dir, branch: target.branch } });
    },
  };
}

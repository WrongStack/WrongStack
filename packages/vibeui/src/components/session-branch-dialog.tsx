'use client';

import { Check, GitBranch, GitMerge, Plus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { clientId } from '../lib/ids';
import {
  buildVibeTreeCommandArgs,
  flattenVibeBranchRows,
  parseVibeSessionTree,
  type VibeSessionTreeSnapshot,
} from '../lib/session-branch-model';
import type { SessionController } from '../lib/use-session';
import { Modal } from './dialogs';

export function SessionBranchDialog({
  open,
  onOpenChange,
  controller,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  controller: SessionController;
}) {
  const { state, connection, send, subscribe, switchSession, notice } = controller;
  const [tree, setTree] = useState<{
    sessionId: typeof state.id;
    snapshot: VibeSessionTreeSnapshot | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [newName, setNewName] = useState('');
  const [keepFiles, setKeepFiles] = useState(false);
  const pendingCancels = useRef(new Set<() => void>());
  const requestSeq = useRef(0);

  const cancelPending = useCallback(() => {
    requestSeq.current += 1;
    for (const cancel of [...pendingCancels.current]) cancel();
  }, []);

  const runTreeCommand = useCallback(
    (args: string): Promise<{ message: string; error?: string; cancelled?: boolean }> =>
      new Promise((resolve) => {
        if (connection !== 'open' || !state.id) {
          resolve({ message: '', error: 'Workspace connection is offline.' });
          return;
        }
        const requestId = clientId();
        let settled = false;
        const finish = (res: { message: string; error?: string; cancelled?: boolean }) => {
          if (settled) return;
          settled = true;
          pendingCancels.current.delete(cancel);
          clearTimeout(timer);
          off();
          resolve(res);
        };
        const cancel = () => finish({ message: '', cancelled: true });
        pendingCancels.current.add(cancel);
        const off = subscribe((frame) => {
          if (frame.type !== 'command.result') return;
          const payload = (frame.payload ?? {}) as Record<string, unknown>;
          if (payload.requestId !== requestId) return;
          finish({
            message: typeof payload.message === 'string' ? payload.message : '',
            ...(typeof payload.error === 'string' ? { error: payload.error } : {}),
          });
        });
        const timer = setTimeout(() => {
          finish({ message: '', error: 'Timed out waiting for session tree response.' });
        }, 8_000);
        if (!send('command.run', { sessionId: state.id, name: 'tree', args, requestId })) {
          finish({ message: '', error: 'Could not send /tree command.' });
        }
      }),
    [connection, send, state.id, subscribe],
  );

  const loadTree = useCallback(async () => {
    const seq = requestSeq.current;
    setBusy(true);
    setError('');
    try {
      const res = await runTreeCommand(buildVibeTreeCommandArgs({ kind: 'list' }));
      if (res.cancelled || requestSeq.current !== seq) return;
      if (res.error) {
        setError(res.error);
        return;
      }
      setTree({ sessionId: state.id, snapshot: parseVibeSessionTree(res.message) });
    } finally {
      if (requestSeq.current === seq) setBusy(false);
    }
  }, [runTreeCommand, state.id]);

  useEffect(() => {
    if (open) {
      void loadTree();
    }
    return () => {
      cancelPending();
      setBusy(false);
    };
  }, [open, loadTree, cancelPending]);

  const mutateTree = async (args: string, refreshTranscript: boolean) => {
    const seq = requestSeq.current;
    const sessionId = state.id;
    setBusy(true);
    setError('');
    try {
      const res = await runTreeCommand(args);
      if (res.cancelled || requestSeq.current !== seq) return;
      if (res.error) {
        setError(res.error);
        return;
      }
      await loadTree();
      if (requestSeq.current !== seq) return;
      if (refreshTranscript && sessionId) {
        switchSession(sessionId);
      }
      if (res.message) {
        const firstLine = res.message.split('\n')[0]?.trim();
        if (firstLine) notice(firstLine);
      }
    } finally {
      if (requestSeq.current === seq) setBusy(false);
    }
  };

  const snapshot = tree && tree.sessionId === state.id ? tree.snapshot : null;
  const rows = snapshot ? flattenVibeBranchRows(snapshot) : [];

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Session branches"
      description="Fork an isolated exploratory branch, switch active context, or fold scrubbed findings back into its parent."
      icon={<GitBranch size={20} />}
    >
      <div className="space-y-3">
        {error && <p className="panel-hint">{error}</p>}

        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={keepFiles}
            onChange={(event) => setKeepFiles(event.target.checked)}
          />
          Keep current workspace files on branch switch (skip CAS restore)
        </label>

        {rows.length > 0 ? (
          <div className="space-y-1.5">
            {rows.map(({ branch, depth, isActive }) => (
              <div
                key={branch.id}
                style={{ paddingLeft: `${Math.min(4, depth) * 14}px` }}
                className="flex items-center justify-between gap-2"
              >
                <button
                  type="button"
                  className={isActive ? 'primary-button' : 'secondary-button'}
                  disabled={busy || controller.sessionLocked || isActive}
                  onClick={() =>
                    void mutateTree(
                      buildVibeTreeCommandArgs({
                        kind: 'switch',
                        branchId: branch.id,
                        keepFiles,
                      }),
                      true,
                    )
                  }
                >
                  {isActive ? <Check size={13} /> : <GitBranch size={13} />}
                  <span>{branch.name}</span>
                  <small>({branch.turnCount}t)</small>
                </button>
                {branch.parentBranchId !== null && branch.status === 'active' && (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy || controller.sessionLocked}
                    title={`Fold ${branch.name} into ${branch.parentBranchId}`}
                    onClick={() =>
                      void mutateTree(
                        buildVibeTreeCommandArgs({ kind: 'fold', branchId: branch.id }),
                        true,
                      )
                    }
                  >
                    <GitMerge size={13} />
                    Fold
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="panel-hint">
            {busy ? 'Loading session tree…' : 'Single main branch active. Fork a new branch below.'}
          </p>
        )}

        <form
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = newName.trim();
            if (!trimmed) return;
            setNewName('');
            void mutateTree(buildVibeTreeCommandArgs({ kind: 'new', name: trimmed }), false);
          }}
        >
          <label className="form-label" htmlFor="vibe-branch-name">
            Fork new branch from active head
          </label>
          <input
            className="wide-input"
            id="vibe-branch-name"
            placeholder="experiment-auth-spike"
            value={newName}
            maxLength={64}
            onChange={(event) => setNewName(event.target.value)}
          />
          <div className="dialog-actions">
            <button type="button" className="secondary-button" onClick={() => onOpenChange(false)}>
              Close
            </button>
            <button
              type="submit"
              className="primary-button"
              disabled={busy || controller.sessionLocked || !newName.trim()}
            >
              <Plus size={14} />
              Create branch
            </button>
          </div>
        </form>
      </div>
    </Modal>
  );
}

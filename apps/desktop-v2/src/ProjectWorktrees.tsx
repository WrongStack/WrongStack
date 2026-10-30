import { GitBranch, GitMerge, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { EngineSend } from './engine-operations';
import type { EngineState } from './engine-state';
import {
  cleanupOutcome,
  diffSummary,
  mergeOutcome,
  type WorktreeOrphan,
  worktreeOrphans,
  worktreeViews,
} from './worktree-model';
import './worktrees.css';

type Pending =
  | { kind: 'cleanup' }
  | { kind: 'remove'; orphan: WorktreeOrphan }
  | { kind: 'merge'; branch: string };

/**
 * Worktrees the engine manages for Goal, SDD and fleet runs (`wstack/ap/*` branches only). Live
 * worktrees are reported by the engine; leftovers no live run owns can be inspected, merged into
 * their base branch or removed. The engine refuses every change while a run owns the worktree.
 * Results are broadcast, so the newest result of each kind is shown.
 */
export function ProjectWorktrees({ state, send }: { state: EngineState; send: EngineSend }) {
  const live = worktreeViews(state.results['worktree.state']);
  const leftovers = worktreeOrphans(state.results['worktree.orphans']);
  const scanned = Boolean(state.results['worktree.orphans']);
  const [confirm, setConfirm] = useState<Pending | null>(null),
    [error, setError] = useState(''),
    [waiting, setWaiting] = useState(''),
    [outcome, setOutcome] = useState('');
  const baseline = useRef<Record<string, unknown>>({});
  const request = (type: string, payload: Record<string, unknown>, resultType: string) => {
    setError('');
    setOutcome('');
    baseline.current[resultType] = state.results[resultType];
    setWaiting(resultType);
    void send(type, payload).catch((failure) => {
      setWaiting('');
      setError(failure instanceof Error ? failure.message : String(failure));
    });
  };
  // A result frame newer than the one seen at request time answers the request.
  useEffect(() => {
    if (!waiting) return;
    const incoming = state.results[waiting];
    if (!incoming || incoming === baseline.current[waiting]) return;
    if (waiting === 'worktree.cleanup_result') setOutcome(cleanupOutcome(incoming));
    if (waiting === 'worktree.merge_result') setOutcome(mergeOutcome(incoming));
    setWaiting('');
  }, [state.results, waiting]);
  useEffect(() => {
    void send('worktree.scan').catch((failure) => setError(String(failure)));
  }, [send]);
  const diff = diffSummary(state.results['worktree.diff_result']);
  const changes = (dir: string) =>
    dir ? (
      <button
        type="button"
        className="button secondary small"
        disabled={Boolean(waiting)}
        onClick={() => request('worktree.diff', { dir }, 'worktree.diff_result')}
      >
        View changes
      </button>
    ) : null;
  const diffView = (dir: string) =>
    diff.dir === dir &&
    (diff.summary ? (
      <section className="worktree-diff" aria-label={`Changes in ${dir}`}>
        <p>
          {diff.summary.commits} commits ahead · +{diff.summary.insertions} −
          {diff.summary.deletions} uncommitted in {diff.summary.files.length} files
        </p>
        <ul>
          {diff.summary.files.slice(0, 200).map((file) => (
            <li key={file.path}>
              <code>{file.path}</code> +{file.insertions} −{file.deletions}
            </li>
          ))}
        </ul>
      </section>
    ) : (
      <p className="field-help">No change summary is available for this checkout.</p>
    ));
  const confirmText = (pending: Pending) =>
    pending.kind === 'cleanup'
      ? `Remove all ${leftovers.orphans.length} leftover worktrees and branches? Uncommitted work in them is lost.`
      : pending.kind === 'remove'
        ? `Remove ${pending.orphan.branch || pending.orphan.dir}? Uncommitted work in it is lost.`
        : `Merge ${pending.branch} into its base branch in the project checkout? Conflicts stop the merge and are listed.`;
  const apply = (pending: Pending) => {
    setConfirm(null);
    if (pending.kind === 'cleanup') request('worktree.cleanup', {}, 'worktree.cleanup_result');
    else if (pending.kind === 'remove')
      request(
        'worktree.remove',
        {
          ...(pending.orphan.dir ? { dir: pending.orphan.dir } : {}),
          ...(pending.orphan.branch ? { branch: pending.orphan.branch } : {}),
        },
        'worktree.cleanup_result',
      );
    else request('worktree.merge', { branch: pending.branch }, 'worktree.merge_result');
  };
  return (
    <section className="project-worktrees" aria-label="Project worktrees">
      <header className="settings-section-heading">
        <div>
          <span className="eyebrow">ISOLATED WORK</span>
          <h2>Worktrees</h2>
          <p>
            Checkouts the engine creates for Goal, SDD and fleet runs. Only managed{' '}
            <code>wstack/ap/*</code> branches are shown or changed here.
          </p>
        </div>
        <button
          type="button"
          className="button secondary small"
          disabled={Boolean(waiting)}
          onClick={() => request('worktree.scan', {}, 'worktree.orphans')}
        >
          <RefreshCw size={13} /> Scan again
        </button>
      </header>
      {error && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
      {waiting && <p role="status">Waiting for the engine…</p>}
      {outcome && <p role="status">{outcome}</p>}
      <h3>In use by runs</h3>
      {live.worktrees.length === 0 ? (
        <p className="field-help">No run in this engine is using a worktree.</p>
      ) : (
        <ul className="worktree-list">
          {live.worktrees.map((worktree) => (
            <li key={worktree.handleId || worktree.branch}>
              <GitBranch size={14} />
              <div>
                <strong>{worktree.branch}</strong>
                <span>
                  {worktree.ownerLabel} · {worktree.status} · base{' '}
                  {worktree.baseBranch || live.baseBranch || 'unknown'} · +{worktree.insertions} −
                  {worktree.deletions} in {worktree.files} files
                </span>
                {worktree.conflictFiles.length > 0 && (
                  <span className="session-error">
                    Conflicts: {worktree.conflictFiles.join(', ')}
                  </span>
                )}
                {worktree.lastError && <span className="session-error">{worktree.lastError}</span>}
                {changes(worktree.dir)}
                {diffView(worktree.dir)}
              </div>
            </li>
          ))}
        </ul>
      )}
      <h3>Left over</h3>
      {!scanned ? (
        <p role="status">Scanning managed worktrees…</p>
      ) : leftovers.orphans.length === 0 ? (
        <p className="field-help">No leftover worktrees or branches.</p>
      ) : (
        <>
          <ul className="worktree-list">
            {leftovers.orphans.map((orphan) => (
              <li key={`${orphan.kind}:${orphan.dir}:${orphan.branch}`}>
                <GitBranch size={14} />
                <div>
                  <strong>{orphan.branch || orphan.dir}</strong>
                  <span>{orphan.kind === 'branch' ? 'Branch without a checkout' : orphan.dir}</span>
                  <div className="worktree-actions">
                    {changes(orphan.dir)}
                    {orphan.branch && (
                      <button
                        type="button"
                        className="button secondary small"
                        disabled={Boolean(waiting)}
                        onClick={() => setConfirm({ kind: 'merge', branch: orphan.branch })}
                      >
                        <GitMerge size={13} /> Merge
                      </button>
                    )}
                    <button
                      type="button"
                      className="button secondary small"
                      disabled={Boolean(waiting)}
                      onClick={() => setConfirm({ kind: 'remove', orphan })}
                    >
                      <Trash2 size={13} /> Remove
                    </button>
                  </div>
                  {diffView(orphan.dir)}
                </div>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="button secondary"
            disabled={Boolean(waiting) || !leftovers.canClean}
            title={leftovers.canClean ? undefined : leftovers.reason}
            onClick={() => setConfirm({ kind: 'cleanup' })}
          >
            Clean up all leftovers
          </button>
          {!leftovers.canClean && leftovers.reason && (
            <p className="field-help">Cleanup is unavailable: {leftovers.reason}.</p>
          )}
        </>
      )}
      {confirm && (
        <div className="worktree-confirm" role="alert">
          <p>{confirmText(confirm)}</p>
          <button
            type="button"
            className={`button ${confirm.kind === 'merge' ? 'primary' : 'danger'} small`}
            onClick={() => apply(confirm)}
          >
            {confirm.kind === 'merge' ? 'Merge' : 'Remove'}
          </button>
          <button type="button" className="button secondary small" onClick={() => setConfirm(null)}>
            Keep
          </button>
        </div>
      )}
    </section>
  );
}

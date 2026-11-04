import { GitBranch, GitMerge, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Trans } from 'react-i18next';
import { useDesktopText } from './desktop-i18n';
import type { EngineSend } from './engine-operations';
import type { EngineState } from './engine-state';
import { surfaceI18n } from './surface-i18n';
import { WorktreeHistory } from './WorktreeHistory';
import {
  WorktreeGraph,
  WorktreeLanes,
  type WorktreeLayout,
  WorktreeLayoutSwitch,
} from './WorktreeViews';
import {
  cleanupOutcome,
  diffSummary,
  mergeOutcome,
  type WorktreeOrphan,
  type WorktreeSay,
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
  const { t } = useDesktopText();
  const say: WorktreeSay = (word, values) => t(`worktrees.outcome.${word}`, values ?? {});
  const live = worktreeViews(state.results['worktree.state']);
  const leftovers = worktreeOrphans(state.results['worktree.orphans']);
  const scanned = Boolean(state.results['worktree.orphans']);
  const [confirm, setConfirm] = useState<Pending | null>(null),
    [error, setError] = useState(''),
    [waiting, setWaiting] = useState(''),
    [outcome, setOutcome] = useState('');
  const [layout, setLayout] = useState<WorktreeLayout>('list');
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
    if (waiting === 'worktree.cleanup_result') setOutcome(cleanupOutcome(incoming, say));
    if (waiting === 'worktree.merge_result') setOutcome(mergeOutcome(incoming, say));
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
        {t('worktrees.viewChanges')}
      </button>
    ) : null;
  const diffView = (dir: string) =>
    diff.dir === dir &&
    (diff.summary ? (
      <section className="worktree-diff" aria-label={t('worktrees.changesIn', { dir })}>
        <p>
          {t('worktrees.diff', {
            commits: diff.summary.commits,
            insertions: diff.summary.insertions,
            deletions: diff.summary.deletions,
            files: diff.summary.files.length,
          })}
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
      <p className="field-help">{t('worktrees.noSummary')}</p>
    ));
  const confirmText = (pending: Pending) =>
    pending.kind === 'cleanup'
      ? t('worktrees.confirmCleanup', { number: leftovers.orphans.length })
      : pending.kind === 'remove'
        ? t('worktrees.confirmRemove', { name: pending.orphan.branch || pending.orphan.dir })
        : t('worktrees.confirmMerge', { branch: pending.branch });
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
    <section className="project-worktrees" aria-label={t('worktrees.label')}>
      <header className="settings-section-heading">
        <div>
          <span className="eyebrow">{t('worktrees.eyebrow')}</span>
          <h2>{t('worktrees.title')}</h2>
          <p>
            <Trans
              i18n={surfaceI18n}
              ns="desktop"
              i18nKey="worktrees.intro"
              components={{ code: <code /> }}
            />
          </p>
        </div>
        <button
          type="button"
          className="button secondary small"
          disabled={Boolean(waiting)}
          onClick={() => request('worktree.scan', {}, 'worktree.orphans')}
        >
          <RefreshCw size={13} /> {t('worktrees.scan')}
        </button>
      </header>
      {error && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
      {waiting && <p role="status">{t('worktrees.waiting')}</p>}
      {outcome && <p role="status">{outcome}</p>}
      <div className="worktree-heading">
        <h3>{t('worktrees.inUse')}</h3>
        {live.worktrees.length > 0 && <WorktreeLayoutSwitch value={layout} onChange={setLayout} />}
      </div>
      {live.worktrees.length === 0 ? (
        <p className="field-help">{t('worktrees.noLive')}</p>
      ) : layout === 'lanes' ? (
        <WorktreeLanes worktrees={live.worktrees} baseBranch={live.baseBranch} />
      ) : layout === 'graph' ? (
        <WorktreeGraph worktrees={live.worktrees} baseBranch={live.baseBranch} />
      ) : (
        <ul className="worktree-list">
          {live.worktrees.map((worktree) => (
            <li key={worktree.handleId || worktree.branch}>
              <GitBranch size={14} />
              <div>
                <strong>{worktree.branch}</strong>
                <span>
                  {t('worktrees.liveLine', {
                    owner: worktree.ownerLabel,
                    status: t(`worktreeView.state.${worktree.status}`, {
                      defaultValue: worktree.status,
                    }),
                    base: worktree.baseBranch || live.baseBranch || t('worktrees.unknownBase'),
                    insertions: worktree.insertions,
                    deletions: worktree.deletions,
                    files: worktree.files,
                  })}
                </span>
                {worktree.conflictFiles.length > 0 && (
                  <span className="session-error">
                    {t('worktrees.conflicts', { files: worktree.conflictFiles.join(', ') })}
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
      <h3>{t('worktrees.history')}</h3>
      <WorktreeHistory events={state.worktreeEvents} />
      <h3>{t('worktrees.leftOver')}</h3>
      {!scanned ? (
        <p role="status">{t('worktrees.scanning')}</p>
      ) : leftovers.orphans.length === 0 ? (
        <p className="field-help">{t('worktrees.noLeftovers')}</p>
      ) : (
        <>
          <ul className="worktree-list">
            {leftovers.orphans.map((orphan) => (
              <li key={`${orphan.kind}:${orphan.dir}:${orphan.branch}`}>
                <GitBranch size={14} />
                <div>
                  <strong>{orphan.branch || orphan.dir}</strong>
                  <span>{orphan.kind === 'branch' ? t('worktrees.branchOnly') : orphan.dir}</span>
                  <div className="worktree-actions">
                    {changes(orphan.dir)}
                    {orphan.branch && (
                      <button
                        type="button"
                        className="button secondary small"
                        disabled={Boolean(waiting)}
                        onClick={() => setConfirm({ kind: 'merge', branch: orphan.branch })}
                      >
                        <GitMerge size={13} /> {t('worktrees.merge')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="button secondary small"
                      disabled={Boolean(waiting)}
                      onClick={() => setConfirm({ kind: 'remove', orphan })}
                    >
                      <Trash2 size={13} /> {t('worktrees.remove')}
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
            {t('worktrees.cleanup')}
          </button>
          {!leftovers.canClean && leftovers.reason && (
            <p className="field-help">
              {t('worktrees.cleanupUnavailable', { reason: leftovers.reason })}
            </p>
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
            {confirm.kind === 'merge' ? t('worktrees.merge') : t('worktrees.remove')}
          </button>
          <button type="button" className="button secondary small" onClick={() => setConfirm(null)}>
            {t('worktrees.keep')}
          </button>
        </div>
      )}
    </section>
  );
}

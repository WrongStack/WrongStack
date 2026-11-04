import { useEffect, useRef, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineSend } from './engine-operations';
import { type EngineState, entries } from './engine-state';

type Operation = 'cleanup_worktrees' | 'rollback' | 'destroy';
const titles: Record<Operation, string> = {
  cleanup_worktrees: 'Clean managed worktrees',
  rollback: 'Revert merged commits',
  destroy: 'Clear project SDD',
};

export function SddLifecycle({
  state,
  board,
  boards,
  send,
}: {
  state: EngineState;
  board: Record<string, unknown>;
  boards: Record<string, unknown>[];
  send: EngineSend;
}) {
  const { t } = useDesktopText();
  const title = (op: Operation) => t(`sddView.lifecycle.op.${op}`, { defaultValue: titles[op] });
  const [operation, setOperation] = useState<Operation | null>(null);
  const [pending, setPending] = useState<Operation | null>(null);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState('');
  const [revertMerged, setRevertMerged] = useState(false);
  const seenResult = useRef(state.results['sdd.board.lifecycle_result']);
  const runId = typeof board['runId'] === 'string' ? board['runId'] : '';
  const active = [board, ...boards].some((item) =>
    ['running', 'paused'].includes(String(item['status'])),
  );
  const loaded = Boolean(state.results['sdd.board.list']);
  const merged = entries(board['mergedCommits']);
  useEffect(() => {
    setOperation(null);
    setRevertMerged(false);
  }, [runId]);
  useEffect(() => {
    const incoming = state.results['sdd.board.lifecycle_result'];
    if (!incoming || incoming === seenResult.current) return;
    seenResult.current = incoming;
    if (!pending || incoming['op'] !== pending) return;
    setPending(null);
    setResult(incoming);
    if (incoming['ok'] === true) {
      const refresh =
        incoming['op'] === 'destroy'
          ? ['sdd.spec.discard', 'sdd.spec.get', 'specs.list', 'sdd.board.list', 'sdd.board.get']
          : ['sdd.board.list', 'sdd.board.get'];
      for (const type of refresh) void send(type).catch((e) => setError(String(e)));
    }
  }, [state.results['sdd.board.lifecycle_result'], pending, send]);
  const execute = async () => {
    if (!operation || active || !loaded) return;
    const op = operation;
    setOperation(null);
    setPending(op);
    setResult(null);
    setError('');
    try {
      await send(`sdd.board.${op}`, {
        ...(runId ? { runId } : {}),
        ...(op === 'destroy' ? { revertMerged } : {}),
      });
    } catch (e) {
      setPending(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <section className="sdd-lifecycle" aria-label={t('sddView.lifecycle.label')}>
      <span className="eyebrow">{t('sddView.lifecycle.eyebrow')}</span>
      <h3>{t('sddView.lifecycle.title')}</h3>
      <p>{t('sddView.lifecycle.intro')}</p>
      {active && <p>{t('sddView.lifecycle.stopFirst')}</p>}
      <div className="sdd-actions">
        {(['cleanup_worktrees', 'rollback', 'destroy'] as const).map((op) => (
          <button
            type="button"
            className="button secondary"
            key={op}
            disabled={
              !loaded ||
              active ||
              Boolean(pending) ||
              (op === 'rollback' && (!runId || !merged.length))
            }
            onClick={() => {
              setOperation(op);
              setRevertMerged(false);
            }}
          >
            {title(op)}
          </button>
        ))}
      </div>
      {operation && (
        <div className="sdd-lifecycle-confirm">
          <h4>{t(`sddView.lifecycle.ask.${operation}`)}</h4>
          <p>
            {operation === 'destroy'
              ? t('sddView.lifecycle.destroyBody')
              : operation === 'cleanup_worktrees'
                ? t('sddView.lifecycle.cleanupBody')
                : t('sddView.lifecycle.rollbackBody', { n: merged.length })}
          </p>
          {operation === 'destroy' && merged.length > 0 && (
            <label>
              <input
                type="checkbox"
                checked={revertMerged}
                onChange={(e) => setRevertMerged(e.target.checked)}
              />{' '}
              {t('sddView.lifecycle.alsoRevert', { n: merged.length })}
            </label>
          )}
          {operation === 'destroy' && revertMerged && (
            <p>{t('sddView.lifecycle.revertFallback')}</p>
          )}
          <div className="sdd-actions">
            <button type="button" className="button secondary" onClick={() => setOperation(null)}>
              {t('sddView.cancel')}
            </button>
            <button
              type="button"
              className="button primary"
              disabled={active || Boolean(pending)}
              onClick={() => void execute()}
            >
              {t(`sddView.lifecycle.confirm.${operation}`)}
            </button>
          </div>
        </div>
      )}
      {pending && <p role="status">{t('sddView.lifecycle.pending', { title: title(pending) })}</p>}
      {error && (
        <p className="session-error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <div className="sdd-lifecycle-result" role="status">
          <strong>
            {result['ok'] !== true
              ? t('sddView.lifecycle.refused')
              : result['reason']
                ? t('sddView.lifecycle.warning')
                : t('sddView.lifecycle.completed')}
          </strong>
          {typeof result['reason'] === 'string' && <p>{result['reason']}</p>}
          <dl>
            {typeof result['removed'] === 'number' && (
              <div>
                <dt>{t('sddView.lifecycle.removed')}</dt>
                <dd>{result['removed']}</dd>
              </div>
            )}
            {typeof result['reverted'] === 'number' && (
              <div>
                <dt>{t('sddView.lifecycle.reverted')}</dt>
                <dd>{result['reverted']}</dd>
              </div>
            )}
          </dl>
          {Array.isArray(result['deleted']) && result['deleted'].length > 0 && (
            <p>
              {t('sddView.lifecycle.cleared', {
                list: result['deleted'].filter((item) => typeof item === 'string').join(', '),
              })}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

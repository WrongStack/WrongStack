import { LoaderCircle, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { record } from './engine-values';
import { Modal } from './Modal';
import './merge-conflict-review.css';

export function MergeConflictReview({
  path,
  command,
  onClose,
  onResolved,
}: {
  path: string;
  command: EngineCommand;
  onClose: () => void;
  onResolved: () => void;
}) {
  const { t } = useDesktopText();
  const [snapshot, setSnapshot] = useState<Record<string, unknown> | null>(null),
    [text, setText] = useState(''),
    [choice, setChoice] = useState('text'),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [closing, setClosing] = useState(false);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const own = ++generation.current;
    setLoading(true);
    setError('');
    try {
      const result = await command('git.conflict', { path }, ['git.conflict'], {
        timeoutMs: 45000,
      });
      if (own !== generation.current) return;
      if (result['path'] !== path) throw Error(t('conflict.otherConflict'));
      setSnapshot(result);
      setText(String(result['working'] ?? ''));
      setChoice(
        result['binary'] === true || record(result['workingInfo'])['exists'] === false
          ? ''
          : 'text',
      );
    } catch (error) {
      if (own === generation.current)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (own === generation.current) setLoading(false);
    }
  }, [command, path]);
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);
  const dirty =
    !!snapshot && ((!!choice && choice !== 'text') || text !== String(snapshot['working'] ?? ''));
  const close = () => {
    if (busy) return;
    if (dirty) setClosing(true);
    else onClose();
  };
  const binary = snapshot?.['binary'] === true;
  const markers = choice !== 'delete' && !binary && /^(?:<{7}|={7}|>{7}|\|{7})(?:\s|$)/m.test(text);
  const resolve = async () => {
    if (!snapshot || busy || loading || markers || !choice) return;
    setBusy(true);
    setError('');
    try {
      await command(
        'git.conflict.resolve',
        { path, revision: snapshot['revision'], choice, ...(choice === 'text' ? { text } : {}) },
        ['git.action_result'],
        { timeoutMs: 45000 },
      );
      onResolved();
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t('conflict.title')} onClose={close}>
      <section className="merge-conflict-review" aria-label={t('conflict.label')}>
        <header>
          <div>
            <span className="eyebrow">{t('conflict.eyebrow')}</span>
            <h2>{t('conflict.title')}</h2>
            <p>{path}</p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label={t('conflict.close')}
            disabled={busy}
            onClick={close}
          >
            <X size={18} />
          </button>
        </header>
        <p>{t('conflict.help')}</p>
        {error && (
          <p role="alert" className="session-error">
            {error} {t('conflict.draftKept')}
          </p>
        )}
        {loading ? (
          <p role="status">
            <LoaderCircle size={16} className="spin" /> {t('conflict.reading')}
          </p>
        ) : (
          snapshot && (
            <>
              <div className="merge-conflict-sides">
                {(['base', 'ours', 'theirs'] as const).map((key) => {
                  const label = t(`conflict.side.${key}`);
                  const info = record(record(snapshot['sides'])[key]);
                  const exists = info['exists'] === true;
                  return (
                    <article key={key}>
                      <header>
                        <strong>{label}</strong>
                        {key !== 'base' && (
                          <button
                            type="button"
                            className="button secondary"
                            disabled={busy || !exists}
                            aria-pressed={choice === key}
                            onClick={() => {
                              setText(String(snapshot[key] ?? ''));
                              setChoice(key);
                            }}
                          >
                            {t(`conflict.useSide.${key}`)}
                          </button>
                        )}
                      </header>
                      <section aria-label={t('conflict.content', { side: label })}>
                        {!exists ? (
                          <p className="merge-side-absent">{t('conflict.absent')}</p>
                        ) : binary ? (
                          <div className="merge-binary-side">
                            <strong>
                              {info['kind'] === 'binary'
                                ? t('conflict.binaryFile')
                                : t('conflict.textFile')}
                            </strong>
                            <p>
                              {t('conflict.bytes', {
                                count: Number(info['bytes']).toLocaleString(),
                              })}
                            </p>
                            <code>{String(info['oid']).slice(0, 12)}</code>
                            {key !== 'base' && <p>{t('conflict.chooseSide')}</p>}
                          </div>
                        ) : (
                          <pre>{String(snapshot[key] ?? '')}</pre>
                        )}
                      </section>
                    </article>
                  );
                })}
              </div>
              {binary && <p>{t('conflict.binaryHelp')}</p>}
              <div className="merge-delete-choice">
                <button
                  type="button"
                  className="button danger"
                  aria-pressed={choice === 'delete'}
                  disabled={busy}
                  onClick={() => setChoice('delete')}
                >
                  {t('conflict.deleteChoice')}
                </button>
                {choice === 'delete' && <p>{t('conflict.deleteHelp')}</p>}
              </div>
              {!binary && choice !== 'delete' && (
                <>
                  <label className="merge-result-label">
                    {t('conflict.merged')}
                    <textarea
                      aria-label={t('conflict.mergedLabel')}
                      value={text}
                      disabled={busy}
                      onChange={(event) => {
                        setText(event.target.value);
                        setChoice('text');
                      }}
                    />
                  </label>
                  {markers && <p>{t('conflict.markers')}</p>}
                </>
              )}
              {Array.isArray(snapshot['relatedPaths']) &&
                Number(snapshot['unresolvedPaths']) > 1 && (
                  <section className="merge-related-paths" aria-label={t('conflict.related')}>
                    <strong>
                      {t('conflict.unresolved', { count: Number(snapshot['unresolvedPaths']) })}
                    </strong>
                    <p>
                      {t('conflict.relatedHelp', {
                        shown: Math.min(50, snapshot['relatedPaths'].length),
                        count: Number(snapshot['unresolvedPaths']),
                      })}
                    </p>
                    <ul>
                      {(snapshot['relatedPaths'] as string[]).slice(0, 50).map((item) => (
                        <li key={item}>
                          <code>{item}</code>
                          {item === path ? ` · ${t('conflict.reviewing')}` : ''}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
            </>
          )
        )}
        {closing ? (
          <div className="merge-close-review">
            <p>{t('conflict.discardAsk')}</p>
            <button type="button" className="button secondary" onClick={() => setClosing(false)}>
              {t('conflict.keepEditing')}
            </button>
            <button type="button" className="button danger" onClick={onClose}>
              {t('conflict.discard')}
            </button>
          </div>
        ) : (
          <footer>
            <button
              type="button"
              className="button secondary"
              disabled={busy || loading}
              onClick={() => void load()}
            >
              {t('conflict.reload')}
            </button>
            <button
              type="button"
              className="button primary"
              disabled={busy || loading || !snapshot || markers || !choice}
              onClick={() => void resolve()}
            >
              {busy
                ? t('conflict.saving')
                : choice === 'delete'
                  ? t('conflict.deleteResolve')
                  : t('conflict.saveResolve')}
            </button>
          </footer>
        )}
      </section>
    </Modal>
  );
}

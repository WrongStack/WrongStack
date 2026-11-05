import { LoaderCircle, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';
import { Modal } from './Modal';
import './git-hunk-review.css';

/** The note for a file whose mode changed as well as its content (`git.hunks` `modeChange`). */
export function modeChangeNote(
  value: unknown,
  words = (from: string, to: string) =>
    `The file mode also changes (${from} → ${to}). These hunks change content only; stage the mode with the whole-file controls.`,
): string {
  const change = record(value);
  return typeof change['from'] === 'string' && typeof change['to'] === 'string'
    ? words(change['from'], change['to'])
    : '';
}

export function GitHunkReview({
  path,
  command,
  onClose,
  onApplied,
}: {
  path: string;
  command: EngineCommand;
  onClose: () => void;
  onApplied: () => void;
}) {
  const { t } = useDesktopText();
  const [layer, setLayer] = useState('unstaged'),
    [result, setResult] = useState<Record<string, unknown>>({}),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    // Change lines picked per hunk (indices into the hunk body after its @@ line).
    [picked, setPicked] = useState<Record<number, number[]>>({});
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const own = ++generation.current;
    setLoading(true);
    setError('');
    setResult({});
    setPicked({});
    try {
      const reply = await command('git.hunks', { path, layer }, ['git.hunks']);
      if (own !== generation.current) return;
      if (reply['path'] !== path || reply['layer'] !== layer) throw Error(t('hunks.otherTarget'));
      setResult(reply);
    } catch (error) {
      if (own === generation.current)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (own === generation.current) setLoading(false);
    }
  }, [command, path, layer]);
  useEffect(() => {
    void refresh();
    return () => {
      generation.current++;
    };
  }, [refresh]);
  const apply = async (hunk: number, lines?: number[]) => {
    if (busy || loading) return;
    setBusy(true);
    setError('');
    try {
      await command(
        'git.hunk.apply',
        { path, layer, patchId: result['patchId'], hunk, ...(lines ? { lines } : {}) },
        ['git.action_result'],
      );
      onApplied();
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const hunks = entries(result['hunks']);
  const modeNote = modeChangeNote(result['modeChange'], (from, to) =>
    t('hunks.modeChange', { from, to }),
  );
  return (
    <Modal
      title={t('hunks.title')}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <section className="git-hunk-review" aria-label={t('hunks.label')}>
        <header>
          <div>
            <span className="eyebrow">{t('hunks.eyebrow')}</span>
            <h2>{t('hunks.title')}</h2>
            <p>{path}</p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label={t('hunks.close')}
            disabled={busy}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <p>{t('hunks.help')}</p>
        <div className="git-hunk-controls">
          <label>
            {t('hunks.layer')}
            <select
              aria-label={t('hunks.layerLabel')}
              value={layer}
              disabled={busy}
              onChange={(event) => setLayer(event.target.value)}
            >
              <option value="unstaged">{t('hunks.unstagedLayer')}</option>
              <option value="staged">{t('hunks.stagedLayer')}</option>
            </select>
          </label>
          <button
            type="button"
            className="button secondary"
            disabled={loading || busy}
            onClick={() => void refresh()}
          >
            <RefreshCw size={14} />
            {t('hunks.refresh')}
          </button>
        </div>
        {error && (
          <p role="alert" className="session-error">
            {error}
          </p>
        )}
        {!loading && modeNote && <p className="field-help">{modeNote}</p>}
        {loading ? (
          <p role="status">
            <LoaderCircle size={15} className="spin" /> {t('shellText.readingHunks')}
          </p>
        ) : hunks.length ? (
          hunks.map((hunk) => (
            <article key={String(hunk['id'])}>
              <header>
                <code>{String(hunk['header'])}</code>
                {!!picked[Number(hunk['id'])]?.length && (
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy || !!error}
                    onClick={() => void apply(Number(hunk['id']), picked[Number(hunk['id'])])}
                  >
                    {t(layer === 'staged' ? 'hunks.unstageLines' : 'hunks.stageLines', {
                      count: picked[Number(hunk['id'])]!.length,
                    })}
                  </button>
                )}
                {hunk['linesOnly'] === true ? (
                  // An added or deleted file: lines here, the whole file with the file controls.
                  <small>{t('hunks.linesOnly')}</small>
                ) : (
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy || !!error}
                    onClick={() => void apply(Number(hunk['id']))}
                  >
                    {t(layer === 'staged' ? 'hunks.unstageHunk' : 'hunks.stageHunk', {
                      n: Number(hunk['id']) + 1,
                    })}
                  </button>
                )}
              </header>
              <pre>
                {String(hunk['text'])
                  .split('\n')
                  .map((line, index, all) =>
                    // Line 0 is the `@@` range, already the hunk's header; the text ends in a newline.
                    (index === 0 && line.startsWith('@@')) ||
                    (index === all.length - 1 && !line) ? null : (
                      <span
                        key={index}
                        className={
                          line.startsWith('+')
                            ? 'git-hunk-add'
                            : line.startsWith('-')
                              ? 'git-hunk-remove'
                              : ''
                        }
                      >
                        {index > 0 && (line.startsWith('+') || line.startsWith('-')) && (
                          <input
                            type="checkbox"
                            aria-label={t('hunks.selectLine', {
                              line: index,
                              n: Number(hunk['id']) + 1,
                            })}
                            disabled={busy}
                            checked={picked[Number(hunk['id'])]?.includes(index - 1) ?? false}
                            onChange={(event) => {
                              const id = Number(hunk['id']);
                              setPicked((current) => {
                                const lines = (current[id] ?? []).filter((at) => at !== index - 1);
                                return {
                                  ...current,
                                  [id]: event.target.checked ? [...lines, index - 1] : lines,
                                };
                              });
                            }}
                          />
                        )}
                        {line}
                        {'\n'}
                      </span>
                    ),
                  )}
              </pre>
            </article>
          ))
        ) : (
          <p>{String(result['reason'] ?? t('hunks.none'))}</p>
        )}
        <small>{t('hunks.footer')}</small>
      </section>
    </Modal>
  );
}

import { BarChart3, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { countedPhrase as counted, entries, record } from './engine-values';
import './chronicle-insights.css';

type View = 'providers' | 'tasks' | 'files';
const views: View[] = ['providers', 'tasks', 'files'];
const number = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : '—';

/** Project-wide derived metrics, independent of the timeline query and any selected session. */
/** A field the record lacks; dropped from the owners line rather than shown as a placeholder. */
const MISSING = '\u0000';
const present = (value: unknown) => (typeof value === 'string' && value ? value : MISSING);
/** The owners a file change recorded, as `<small>`; the localized template lists every field. */
function recordedOwners(text: string) {
  const parts = text
    .split(' · ')
    .map((part) => part.replace(` / ${MISSING}`, '').replace(`${MISSING} / `, ''))
    .filter((part) => !part.includes(MISSING));
  return parts.length ? <small>{parts.join(' · ')}</small> : null;
}

export function ChronicleInsights({
  command,
  onOpenFile,
}: {
  command: EngineCommand;
  onOpenFile: (path: string) => void;
}) {
  const { t, i18n } = useDesktopText();
  const label = (value: unknown) =>
    typeof value === 'string' && value ? value : t('chronicleView.insights.notRecorded');
  const when = (value: unknown) => {
    const at = typeof value === 'string' && value ? new Date(value) : null;
    return at && !Number.isNaN(at.getTime())
      ? at.toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' })
      : label(value);
  };
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>('providers');
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [refresh, setRefresh] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const load = useCallback(async () => {
    const id = ++generation.current;
    setRows([]);
    setBusy(true);
    setError('');
    try {
      const result = await command(
        'chronicle.metrics',
        { view, ...(view === 'providers' ? {} : { limit: 200 }) },
        ['chronicle.metrics_result', 'chronicle.error'],
        { timeoutMs: 45000 },
      );
      if (generation.current !== id) return;
      if (typeof result['message'] === 'string') throw new Error(result['message']);
      if (result['view'] !== view || !Array.isArray(result['data']))
        throw new Error(t('chronicleView.insights.invalid'));
      setRows(entries(result['data']));
      setRefresh(record(result['refreshed']));
    } catch (e) {
      if (generation.current === id) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (generation.current === id) setBusy(false);
    }
  }, [command, view, t]);
  useEffect(() => {
    if (open) void load();
    return () => {
      generation.current++;
    };
  }, [open, load]);
  return (
    <details
      className="chronicle-insights"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <BarChart3 size={16} /> {t('chronicleView.insights.title')}{' '}
        <span>{t('chronicleView.insights.subtitle')}</span>
      </summary>
      {open && (
        <div className="insights-content">
          <p>{t('chronicleView.insights.intro')}</p>
          <div className="insights-toolbar">
            <nav aria-label={t('chronicleView.insights.views')}>
              {views.map((item) => (
                <button
                  key={item}
                  type="button"
                  aria-pressed={view === item}
                  onClick={() => {
                    if (item !== view) {
                      setRows([]);
                      setBusy(true);
                      setView(item);
                    }
                  }}
                >
                  {t(`chronicleView.insights.view.${item}`)}
                </button>
              ))}
            </nav>
            <button
              type="button"
              className="button secondary small"
              onClick={() => void load()}
              disabled={busy}
            >
              <RefreshCw size={13} /> {t('chronicleView.insights.refresh')}
            </button>
          </div>
          {error ? (
            <p role="alert">{error}</p>
          ) : busy ? (
            <p role="status">{t('chronicleView.insights.loading')}</p>
          ) : !rows.length ? (
            <p>{t(`chronicleView.insights.empty.${view}`)}</p>
          ) : (
            <div className="insights-list">
              {rows.map((row, index) =>
                view === 'providers' ? (
                  <article key={index}>
                    <header>
                      <strong>
                        {label(row['providerId'])} / {label(row['modelId'])}
                      </strong>
                      <time>{label(row['day'])}</time>
                    </header>
                    <p>
                      {t('chronicleView.insights.attempts', {
                        attempts: counted(t, 'attempts', row['attempts']),
                        completed: number(row['completed']),
                        failed: number(row['failed']),
                        retries: counted(t, 'retries', row['retries']),
                        fallbacks: counted(t, 'fallbacks', row['fallbacks']),
                      })}
                    </p>
                    <small>
                      {t('chronicleView.insights.tokens', {
                        input: number(row['inputTokens']),
                        output: number(row['outputTokens']),
                        cacheRead: number(row['cacheReadTokens']),
                        cacheWrite: number(row['cacheWriteTokens']),
                        avg: number(row['avgDurationMs']),
                        max: number(row['maxDurationMs']),
                      })}
                    </small>
                  </article>
                ) : view === 'tasks' ? (
                  <article key={index}>
                    <header>
                      <strong>{label(row['taskId'])}</strong>
                      <span>{label(row['status'])}</span>
                    </header>
                    <p>
                      {t('chronicleView.insights.taskOwners', {
                        board: label(row['boardId']),
                        agent: label(row['agentId']),
                        session: label(row['sessionId']),
                      })}
                    </p>
                    <small>
                      {t('chronicleView.insights.taskRun', {
                        run: label(row['runId']),
                        retries: counted(t, 'retries', row['retries']),
                        verification: counted(
                          t,
                          'verificationFailures',
                          row['verificationFailures'],
                        ),
                        files: counted(t, 'files', row['filesTouched']),
                        ms: number(row['durationMs']),
                      })}
                    </small>
                    <small>
                      {t('chronicleView.insights.taskTimes', {
                        started: when(row['startedAt']),
                        ended: when(row['endedAt']),
                      })}
                    </small>
                  </article>
                ) : (
                  <article key={index}>
                    <header>
                      <strong>{label(row['path'])}</strong>
                      {typeof row['operation'] === 'string' && (
                        <span className="insights-operation">
                          {t(`chronicleView.insights.operation.${row['operation']}`, {
                            defaultValue: row['operation'],
                          })}
                        </span>
                      )}
                    </header>
                    <p>
                      {[when(row['occurredAt']), row['toolName'], row['source']]
                        .filter((part) => typeof part === 'string' && part)
                        .join(' · ')}
                    </p>
                    {recordedOwners(
                      t('chronicleView.insights.fileOwners', {
                        task: present(row['taskId']),
                        board: present(row['boardId']),
                        run: present(row['runId']),
                        session: present(row['sessionId']),
                        agent: present(row['agentId']),
                        provider: present(row['providerId']),
                        model: present(row['modelId']),
                      }),
                    ) || null}
                    {typeof row['path'] === 'string' && row['path'] && (
                      <button type="button" onClick={() => onOpenFile(row['path'] as string)}>
                        {t('chronicleView.openFile')}
                      </button>
                    )}
                  </article>
                ),
              )}
            </div>
          )}
          {!busy && !error && (
            <small className="insights-footnote">
              {t('chronicleView.insights.footnote', {
                rows:
                  view === 'providers'
                    ? t('chronicleView.insights.dailyRows')
                    : t('chronicleView.insights.recentRows'),
                partitions: number(refresh['sourceFiles']),
                invalid: number(refresh['invalidLines']),
              })}
            </small>
          )}
        </div>
      )}
    </details>
  );
}

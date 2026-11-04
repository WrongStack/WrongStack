import { BarChart3, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';
import './chronicle-insights.css';

type View = 'providers' | 'tasks' | 'files';
const views: View[] = ['providers', 'tasks', 'files'];
const number = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : '—';

/** Project-wide derived metrics, independent of the timeline query and any selected session. */
export function ChronicleInsights({
  command,
  onOpenFile,
}: {
  command: EngineCommand;
  onOpenFile: (path: string) => void;
}) {
  const { t } = useDesktopText();
  const label = (value: unknown) =>
    typeof value === 'string' && value ? value : t('chronicleView.insights.notRecorded');
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
                        attempts: number(row['attempts']),
                        completed: number(row['completed']),
                        failed: number(row['failed']),
                        retries: number(row['retries']),
                        fallbacks: number(row['fallbacks']),
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
                        retries: number(row['retries']),
                        verification: number(row['verificationFailures']),
                        files: number(row['filesTouched']),
                        ms: number(row['durationMs']),
                      })}
                    </small>
                    <small>
                      {t('chronicleView.insights.taskTimes', {
                        started: label(row['startedAt']),
                        ended: label(row['endedAt']),
                      })}
                    </small>
                  </article>
                ) : (
                  <article key={index}>
                    <header>
                      <strong>{label(row['path'])}</strong>
                      <span>{label(row['operation'])}</span>
                    </header>
                    <p>
                      {label(row['occurredAt'])} · {label(row['toolName'])} · {label(row['source'])}
                    </p>
                    <small>
                      {t('chronicleView.insights.fileOwners', {
                        task: label(row['taskId']),
                        board: label(row['boardId']),
                        run: label(row['runId']),
                        session: label(row['sessionId']),
                        agent: label(row['agentId']),
                        provider: label(row['providerId']),
                        model: label(row['modelId']),
                      })}
                    </small>
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

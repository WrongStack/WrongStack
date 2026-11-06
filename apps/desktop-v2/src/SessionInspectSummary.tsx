import { useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';
import './session-inspect-summary.css';
import { displayTime } from './display-dates';

const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : '—';
/**
 * What a recorded session did, as the WebUI's session inspector summarizes it: token, message,
 * iteration, tool, file and compaction totals, the tool breakdown, the file changes and a
 * filterable event timeline. Read from `session.inspect` the first time it is opened.
 */
export function SessionInspectSummary({ id, command }: { id: string; command: EngineCommand }) {
  const { t } = useDesktopText();
  const [summary, setSummary] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const load = async () => {
    if (summary || loading) return;
    setLoading(true);
    setError('');
    try {
      setSummary(record(await command('session.inspect', { id }, ['session.inspect'])));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setLoading(false);
    }
  };
  const events = entries(summary?.['events']);
  const wanted = filter.trim().toLowerCase();
  const shown = wanted
    ? events.filter((event) =>
        `${String(event['label'] ?? '')} ${String(event['type'] ?? '')}`
          .toLowerCase()
          .includes(wanted),
      )
    : events;
  const tools = Object.entries(record(summary?.['toolBreakdown']))
    .filter((pair): pair is [string, number] => typeof pair[1] === 'number')
    .sort(([, a], [, b]) => b - a);
  const files = entries(summary?.['fileEvents']);
  const toolErrors = Number(summary?.['toolErrorCount'] ?? 0);
  return (
    <details
      className="session-inspect-summary"
      onToggle={(event) => {
        if ((event.currentTarget as HTMLDetailsElement).open) void load();
      }}
    >
      <summary>{t('historyView.inspect.title')}</summary>
      {loading && <p role="status">{t('historyView.inspect.reading')}</p>}
      {error && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
      {summary && (
        <>
          <dl className="inspect-stats">
            {(
              [
                ['tokens', summary['tokenTotal']],
                ['messages', summary['messageCount']],
                ['iterations', summary['iterationCount']],
                ['toolCalls', summary['toolCallCount']],
                ['filesChanged', summary['fileChangeCount']],
                ['compactions', summary['compactionCount']],
                ['events', events.length],
              ] as const
            ).map(([stat, value]) => (
              <div key={stat}>
                <dt>{t(`historyView.inspect.stat.${stat}`)}</dt>
                <dd>
                  {count(value)}
                  {stat === 'toolCalls' && toolErrors > 0 && (
                    <small>
                      {' '}
                      · {t('historyView.inspect.failed', { n: toolErrors.toLocaleString() })}
                    </small>
                  )}
                </dd>
              </div>
            ))}
          </dl>
          {typeof summary['outcome'] === 'string' && (
            <p className="field-help">
              {t('historyView.inspect.outcome', {
                outcome: t(`historyView.rowOutcome.${summary['outcome']}`, {
                  defaultValue: summary['outcome'],
                }),
              })}
            </p>
          )}
          <div className="inspect-columns">
            <section aria-label={t('historyView.inspect.timeline')}>
              <header>
                <h4>
                  {t('historyView.inspect.timelineCount', {
                    shown: shown.length,
                    total: events.length,
                  })}
                </h4>
                <input
                  type="search"
                  aria-label={t('historyView.inspect.filter')}
                  placeholder={t('historyView.inspect.filterPlaceholder')}
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                />
              </header>
              {shown.length ? (
                <ol>
                  {shown.map((event, index) => (
                    <li key={`${String(event['ts'])}-${index}`}>
                      <span>
                        <strong>
                          {String(
                            event['label'] ?? event['type'] ?? t('historyView.inspect.event'),
                          )}
                        </strong>
                        {typeof event['detail'] === 'string' && event['detail'] && (
                          <code>{event['detail']}</code>
                        )}
                      </span>
                      <time dateTime={String(event['ts'] ?? '')}>
                        {typeof event['ts'] === 'string' ? displayTime(event['ts']) : ''}
                      </time>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="field-help">{t('historyView.inspect.noEvents')}</p>
              )}
            </section>
            <aside>
              {tools.length > 0 && (
                <section aria-label={t('historyView.inspect.tools')}>
                  <h4>{t('historyView.inspect.tools')}</h4>
                  <ol>
                    {tools.map(([name, calls]) => (
                      <li key={name}>
                        <span>{name}</span>
                        <strong>{calls.toLocaleString()}</strong>
                      </li>
                    ))}
                  </ol>
                </section>
              )}
              {files.length > 0 && (
                <section aria-label={t('historyView.inspect.files')}>
                  <h4>{t('historyView.inspect.filesCount', { n: files.length })}</h4>
                  <ol>
                    {files.map((file, index) => (
                      <li key={`${String(file['filePath'])}-${index}`}>
                        <span>
                          <code>{String(file['filePath'] ?? '')}</code>
                          <small>{String(file['toolName'] ?? '')}</small>
                        </span>
                        <strong>
                          {file['operation']
                            ? t(`historyView.inspect.operation.${String(file['operation'])}`, {
                                defaultValue: String(file['operation']),
                              })
                            : ''}
                        </strong>
                      </li>
                    ))}
                  </ol>
                </section>
              )}
            </aside>
          </div>
        </>
      )}
    </details>
  );
}

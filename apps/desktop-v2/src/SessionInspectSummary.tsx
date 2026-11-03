import { useState } from 'react';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';
import './session-inspect-summary.css';

const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : '—';
const OPERATIONS: Record<string, string> = {
  create: 'Created',
  modify: 'Modified',
  edit: 'Edited',
  delete: 'Deleted',
};

/**
 * What a recorded session did, as the WebUI's session inspector summarizes it: token, message,
 * iteration, tool, file and compaction totals, the tool breakdown, the file changes and a
 * filterable event timeline. Read from `session.inspect` the first time it is opened.
 */
export function SessionInspectSummary({ id, command }: { id: string; command: EngineCommand }) {
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
      <summary>Session summary</summary>
      {loading && <p role="status">Reading the recorded session…</p>}
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
                ['Tokens', summary['tokenTotal']],
                ['Messages', summary['messageCount']],
                ['Iterations', summary['iterationCount']],
                ['Tool calls', summary['toolCallCount']],
                ['Files changed', summary['fileChangeCount']],
                ['Compactions', summary['compactionCount']],
                ['Events', events.length],
              ] as const
            ).map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>
                  {count(value)}
                  {label === 'Tool calls' && toolErrors > 0 && (
                    <small> · {toolErrors.toLocaleString()} failed</small>
                  )}
                </dd>
              </div>
            ))}
          </dl>
          {typeof summary['outcome'] === 'string' && (
            <p className="field-help">Outcome: {summary['outcome']}</p>
          )}
          <div className="inspect-columns">
            <section aria-label="Event timeline">
              <header>
                <h4>
                  Event timeline · {shown.length} / {events.length}
                </h4>
                <input
                  type="search"
                  aria-label="Filter session events"
                  placeholder="Filter events…"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                />
              </header>
              {shown.length ? (
                <ol>
                  {shown.map((event, index) => (
                    <li key={`${String(event['ts'])}-${index}`}>
                      <span>
                        <strong>{String(event['label'] ?? event['type'] ?? 'Event')}</strong>
                        {typeof event['detail'] === 'string' && event['detail'] && (
                          <code>{event['detail']}</code>
                        )}
                      </span>
                      <time dateTime={String(event['ts'] ?? '')}>
                        {typeof event['ts'] === 'string'
                          ? new Date(event['ts']).toLocaleTimeString()
                          : ''}
                      </time>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="field-help">No events match the filter.</p>
              )}
            </section>
            <aside>
              {tools.length > 0 && (
                <section aria-label="Tool breakdown">
                  <h4>Tool breakdown</h4>
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
                <section aria-label="File changes">
                  <h4>File changes · {files.length}</h4>
                  <ol>
                    {files.map((file, index) => (
                      <li key={`${String(file['filePath'])}-${index}`}>
                        <span>
                          <code>{String(file['filePath'] ?? '')}</code>
                          <small>{String(file['toolName'] ?? '')}</small>
                        </span>
                        <strong>
                          {OPERATIONS[String(file['operation'])] ?? String(file['operation'] ?? '')}
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

import { useState } from 'react';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';

export interface InjectionRecord {
  at: string;
  trigger: string;
  sessionId: string;
  memoryIds: string[];
}

/** `memory.injected` audit events as injections, newest first; malformed rows are dropped. */
export function readInjections(value: unknown): InjectionRecord[] {
  return entries(value)
    .filter((row) => row['event'] === 'memory.injected' && typeof row['at'] === 'string')
    .map((row) => {
      const details = record(row['details']);
      return {
        at: String(row['at']),
        trigger: typeof details['trigger'] === 'string' ? details['trigger'] : '',
        sessionId: typeof details['sessionId'] === 'string' ? details['sessionId'] : '',
        memoryIds: Array.isArray(details['memoryIds'])
          ? details['memoryIds'].filter((id): id is string => typeof id === 'string')
          : [],
      };
    })
    .filter((row) => row.memoryIds.length > 0);
}

/**
 * Which memories SAGE injected into this project's requests, when, for which conversation and on
 * what trigger, across every conversation (`memory.sage.audit`). The store keeps a rolling window
 * of its newest 1,000 audit events, so older injections age out.
 */
export function SageInjectionHistory({
  command,
  onOpen,
}: {
  command: EngineCommand;
  onOpen: (memoryId: string) => void;
}) {
  const [rows, setRows] = useState<InjectionRecord[] | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const load = async () => {
    setBusy(true);
    setError('');
    try {
      const reply = await command(
        'memory.sage.audit',
        { event: 'memory.injected', limit: 300 },
        ['memory.sage.audit'],
        { timeoutMs: 60000 },
      );
      setRows(readInjections(reply['records']));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const counts = new Map<string, number>();
  for (const row of rows ?? [])
    for (const id of row.memoryIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 10);
  return (
    <details className="sage-injection-history">
      <summary>Injection history</summary>
      <p className="field-help">
        Memories SAGE added to this project's requests, across conversations. The store keeps its
        newest 1,000 audit events.
      </p>
      <button
        type="button"
        className="button secondary small"
        disabled={busy}
        onClick={() => void load()}
      >
        {busy ? 'Reading…' : rows ? 'Refresh' : 'Read injection history'}
      </button>
      {error && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
      {rows && !rows.length && <p role="status">No injections are in the audit window.</p>}
      {rows && rows.length > 0 && (
        <>
          <p role="status">
            {rows.length} injections into requests · {counts.size} distinct memories.
          </p>
          <p>
            Most injected:{' '}
            {top.map(([id, n], index) => (
              <span key={id}>
                {index > 0 && ' · '}
                <button type="button" className="text-link" onClick={() => onOpen(id)}>
                  {id.slice(0, 8)}
                </button>{' '}
                ×{n}
              </span>
            ))}
          </p>
          <table aria-label="SAGE injections">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Trigger</th>
                <th scope="col">Conversation</th>
                <th scope="col">Memories</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={`${row.at}:${index}`}>
                  <td>{new Date(row.at).toLocaleString()}</td>
                  <td>{row.trigger || '—'}</td>
                  <td>
                    <code>{row.sessionId ? row.sessionId.slice(-12) : '—'}</code>
                  </td>
                  <td>
                    {row.memoryIds.map((id, i) => (
                      <span key={id}>
                        {i > 0 && ', '}
                        <button type="button" className="text-link" onClick={() => onOpen(id)}>
                          {id.slice(0, 8)}
                        </button>
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </details>
  );
}

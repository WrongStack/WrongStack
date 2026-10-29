import { useState } from 'react';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';

interface Usage {
  sessions: number;
  sessionsWithTokens: number;
  tokenTotal: number;
  capped: boolean;
  byModel: { provider: string; model: string; sessions: number; tokenTotal: number }[];
}

/** The engine's usage summary, or null when the reply does not carry one. */
export function readUsageSummary(value: unknown): Usage | null {
  const raw = record(value);
  const count = (key: string) =>
    Number.isSafeInteger(raw[key]) && Number(raw[key]) >= 0 ? Number(raw[key]) : null;
  const sessions = count('sessions'),
    withTokens = count('sessionsWithTokens'),
    tokenTotal = count('tokenTotal');
  if (sessions === null || withTokens === null || tokenTotal === null) return null;
  return {
    sessions,
    sessionsWithTokens: withTokens,
    tokenTotal,
    capped: raw['capped'] === true,
    byModel: entries(raw['byModel']).flatMap((row) =>
      typeof row['provider'] === 'string' &&
      typeof row['model'] === 'string' &&
      Number.isSafeInteger(row['sessions']) &&
      Number.isSafeInteger(row['tokenTotal'])
        ? [
            {
              provider: row['provider'],
              model: row['model'],
              sessions: Number(row['sessions']),
              tokenTotal: Number(row['tokenTotal']),
            },
          ]
        : [],
    ),
  };
}

/**
 * Recorded tokens across this project's conversations, per provider and model, read on request
 * from the session catalog. No price is shown: the catalog records tokens, not billing.
 */
export function ProjectUsageSummary({ command }: { command: EngineCommand }) {
  const [usage, setUsage] = useState<Usage | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const load = async () => {
    setBusy(true);
    setError('');
    try {
      const reply = await command('sessions.list', { usageSummary: true }, ['sessions.list'], {
        timeoutMs: 60000,
      });
      if (typeof reply['error'] === 'string') throw Error(reply['error']);
      const read = readUsageSummary(reply['usageSummary']);
      if (!read) throw Error('This engine does not summarize project usage yet.');
      setUsage(read);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="project-usage-summary">
      <summary>Project usage</summary>
      <p className="field-help">
        Tokens recorded by each conversation in this project, grouped by the provider and model it
        last used. Prices are not derived here.
      </p>
      <button
        type="button"
        className="button secondary small"
        disabled={busy}
        onClick={() => void load()}
      >
        {busy ? 'Summarizing…' : usage ? 'Refresh summary' : 'Summarize recorded usage'}
      </button>
      {error && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
      {usage && (
        <>
          <p role="status">
            {usage.tokenTotal.toLocaleString()} tokens across {usage.sessions.toLocaleString()}{' '}
            conversations
            {usage.sessionsWithTokens < usage.sessions
              ? ` (${(usage.sessions - usage.sessionsWithTokens).toLocaleString()} without a recorded total)`
              : ''}
            {usage.capped ? '; only the newest conversations up to the scan limit were read' : ''}.
          </p>
          <table aria-label="Recorded tokens by model">
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col">Model</th>
                <th scope="col">Conversations</th>
                <th scope="col">Tokens</th>
              </tr>
            </thead>
            <tbody>
              {usage.byModel.map((row) => (
                <tr key={`${row.provider}/${row.model}`}>
                  <td>{row.provider}</td>
                  <td>{row.model}</td>
                  <td>{row.sessions.toLocaleString()}</td>
                  <td>{row.tokenTotal.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </details>
  );
}

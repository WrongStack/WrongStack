import { useState } from 'react';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';
import { ProjectSideEffectsSummary } from './ProjectSideEffectsSummary';

interface Usage {
  sessions: number;
  sessionsWithTokens: number;
  tokenTotal: number;
  capped: boolean;
  byModel: { provider: string; model: string; sessions: number; tokenTotal: number }[];
  /** Present for the profile scope: each project's own total, or why it could not be read. */
  projects?: { name: string; root: string; tokenTotal: number | null; error?: string }[];
}

type Scope = 'project' | 'profile';

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
    ...(Array.isArray(raw['projects'])
      ? {
          projects: entries(raw['projects']).flatMap((row) =>
            typeof row['root'] === 'string'
              ? [
                  {
                    name: typeof row['name'] === 'string' ? row['name'] : row['root'],
                    root: row['root'],
                    tokenTotal: Number.isSafeInteger(row['tokenTotal'])
                      ? Number(row['tokenTotal'])
                      : null,
                    ...(typeof row['error'] === 'string' ? { error: row['error'] } : {}),
                  },
                ]
              : [],
          ),
        }
      : {}),
  };
}

const SCOPES: readonly (readonly [Scope, string])[] = [
  ['project', 'This project'],
  ['profile', 'All projects in this profile'],
];

/**
 * Recorded tokens across this project's conversations, or across every project in the profile,
 * per provider and model, read on request from the session catalogs. No price is shown: the
 * catalog records tokens, not billing.
 */
export function ProjectUsageSummary({
  command,
  onOpenSession,
}: {
  command: EngineCommand;
  /** Opens a conversation's recorded history from the side-effect list. */
  onOpenSession?: ((sessionId: string) => void) | undefined;
}) {
  const [scope, setScope] = useState<Scope>('project'),
    [usage, setUsage] = useState<Usage | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const load = async () => {
    setBusy(true);
    setError('');
    try {
      const type = scope === 'project' ? 'sessions.list' : 'projects.list';
      const reply = await command(type, { usageSummary: true }, [type], {
        timeoutMs: scope === 'project' ? 60000 : 300000,
      });
      if (typeof reply['error'] === 'string') throw Error(reply['error']);
      const read = readUsageSummary(reply['usageSummary']);
      if (!read)
        throw Error(
          scope === 'project'
            ? 'This engine does not summarize project usage yet.'
            : 'This engine does not summarize usage across projects yet.',
        );
      setUsage(read);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <ProjectSideEffectsSummary command={command} onOpenSession={onOpenSession} />
      <details className="project-usage-summary">
        <summary>Recorded usage</summary>
        <p className="field-help">
          Tokens recorded by each conversation, grouped by the provider and model it last used.
          Prices are not derived here.
        </p>
        <fieldset className="usage-scope">
          <legend>Conversations to count</legend>
          {SCOPES.map(([value, label]) => (
            <label key={value}>
              <input
                type="radio"
                name="usage-scope"
                checked={scope === value}
                disabled={busy}
                onChange={() => {
                  setScope(value);
                  setUsage(null);
                  setError('');
                }}
              />
              {label}
            </label>
          ))}
        </fieldset>
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
              {usage.projects ? ` in ${usage.projects.length.toLocaleString()} projects` : ''}
              {usage.sessionsWithTokens < usage.sessions
                ? ` (${(usage.sessions - usage.sessionsWithTokens).toLocaleString()} without a recorded total)`
                : ''}
              {usage.capped ? '; only the newest conversations up to the scan limit were read' : ''}
              .
            </p>
            {usage.projects && (
              <table aria-label="Recorded tokens by project">
                <thead>
                  <tr>
                    <th scope="col">Project</th>
                    <th scope="col">Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.projects.map((row) => (
                    <tr key={row.root}>
                      <td title={row.root}>{row.name}</td>
                      <td>
                        {row.error
                          ? `Not read: ${row.error}`
                          : (row.tokenTotal ?? 0).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
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
    </>
  );
}

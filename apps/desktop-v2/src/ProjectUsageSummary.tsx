import { useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import { displayLocale } from './display-dates';
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

const SCOPES: readonly Scope[] = ['project', 'profile'];

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
  const { t } = useDesktopText();
  const [scope, setScope] = useState<Scope>('project'),
    [usage, setUsage] = useState<Usage | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  /** Asks one engine catalog for its usage summary. */
  const request = (type: string, timeoutMs: number) =>
    command(type, { usageSummary: true }, [type], { timeoutMs });
  const load = async () => {
    setBusy(true);
    setError('');
    try {
      const reply =
        scope === 'project'
          ? await request('sessions.list', 60000)
          : await request('projects.list', 300000);
      if (typeof reply['error'] === 'string') throw Error(reply['error']);
      const read = readUsageSummary(reply['usageSummary']);
      if (!read)
        throw Error(
          scope === 'project' ? t('historyView.usage.noProject') : t('historyView.usage.noProfile'),
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
        <summary>{t('historyView.usage.title')}</summary>
        <p className="field-help">{t('historyView.usage.help')}</p>
        <fieldset className="usage-scope">
          <legend>{t('historyView.usage.scopeLegend')}</legend>
          {SCOPES.map((value) => (
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
              {t(`historyView.usage.scope.${value}`)}
            </label>
          ))}
        </fieldset>
        <button
          type="button"
          className="button secondary small"
          disabled={busy}
          onClick={() => void load()}
        >
          {busy
            ? t('historyView.usage.summarizing')
            : usage
              ? t('historyView.usage.refresh')
              : t('historyView.usage.summarize')}
        </button>
        {error && (
          <p role="alert" className="session-error">
            {error}
          </p>
        )}
        {usage && (
          <>
            <p role="status">
              {t('historyView.usage.total', {
                tokens: usage.tokenTotal.toLocaleString(displayLocale()),
                sessions: usage.sessions.toLocaleString(displayLocale()),
                projects: usage.projects
                  ? t('historyView.usage.inProjects', { count: usage.projects.length })
                  : '',
                missing:
                  usage.sessionsWithTokens < usage.sessions
                    ? t('historyView.usage.withoutTotal', {
                        n: (usage.sessions - usage.sessionsWithTokens).toLocaleString(
                          displayLocale(),
                        ),
                      })
                    : '',
                capped: usage.capped ? t('historyView.usage.capped') : '',
              })}
            </p>
            {usage.projects && (
              <table aria-label={t('historyView.usage.byProject')}>
                <thead>
                  <tr>
                    <th scope="col">{t('historyView.usage.column.project')}</th>
                    <th scope="col">{t('historyView.usage.column.tokens')}</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.projects.map((row) => (
                    <tr key={row.root}>
                      <td title={row.root}>{row.name}</td>
                      <td>
                        {row.error
                          ? t('historyView.usage.notRead', { error: row.error })
                          : (row.tokenTotal ?? 0).toLocaleString(displayLocale())}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <table aria-label={t('historyView.usage.byModel')}>
              <thead>
                <tr>
                  <th scope="col">{t('historyView.usage.column.provider')}</th>
                  <th scope="col">{t('historyView.usage.column.model')}</th>
                  <th scope="col">{t('historyView.usage.column.conversations')}</th>
                  <th scope="col">{t('historyView.usage.column.tokens')}</th>
                </tr>
              </thead>
              <tbody>
                {usage.byModel.map((row) => (
                  <tr key={`${row.provider}/${row.model}`}>
                    {[row.provider, row.model].map((name, cell) => (
                      <td key={cell}>
                        {name === 'unknown' ? t('historyView.usage.notRecorded') : name}
                      </td>
                    ))}
                    <td>{row.sessions.toLocaleString(displayLocale())}</td>
                    <td>{row.tokenTotal.toLocaleString(displayLocale())}</td>
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

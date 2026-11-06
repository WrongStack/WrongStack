import { useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import { displayDateTime, displayLocale } from './display-dates';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';

export const SIDE_EFFECT_RISKS = ['shell', 'fs.write', 'package', 'network', 'config'] as const;
/** Catalog key for a risk class; `fs.write` cannot be a key under i18next's dot separator. */
const riskKey = (risk: string) => (risk === 'fs.write' ? 'fsWrite' : risk);

export interface SideEffectsSummary {
  sessionsScanned: number;
  capped: boolean;
  sessionsWithEffects: number;
  unreadable: number;
  total: number;
  byRisk: [string, number][];
  byTool: [string, number][];
  records: {
    sessionId: string;
    sessionTitle: string;
    toolName: string;
    ts: string;
    risk: string;
    outcome: string;
    input: string;
  }[];
  recordsTruncated: boolean;
}

const count = (value: unknown) =>
  Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
const counts = (value: unknown): [string, number][] =>
  Object.entries(record(value))
    .flatMap(([key, n]): [string, number][] => (count(n) === null ? [] : [[key, Number(n)]]))
    .sort((a, b) => b[1] - a[1]);
const text = (value: unknown) => (typeof value === 'string' ? value : '');

/** The engine's project side-effect summary, or null when the reply carries none. */
export function readSideEffectsSummary(value: unknown): SideEffectsSummary | null {
  const raw = record(value);
  const scanned = count(raw['sessionsScanned']),
    total = count(raw['total']);
  if (scanned === null || total === null) return null;
  return {
    sessionsScanned: scanned,
    capped: raw['capped'] === true,
    sessionsWithEffects: count(raw['sessionsWithEffects']) ?? 0,
    unreadable: count(raw['unreadable']) ?? 0,
    total,
    byRisk: counts(raw['byRisk']),
    byTool: counts(raw['byTool']),
    records: entries(raw['records'])
      .filter((row) => typeof row['sessionId'] === 'string' && typeof row['ts'] === 'string')
      .map((row) => ({
        sessionId: String(row['sessionId']),
        sessionTitle: text(row['sessionTitle']) || String(row['sessionId']),
        toolName: text(row['toolName']),
        ts: String(row['ts']),
        risk: text(row['risk']),
        outcome: text(row['outcome']),
        input: text(row['input']),
      })),
    recordsTruncated: raw['recordsTruncated'] === true,
  };
}

/**
 * Commands, file writes, packages, network and configuration operations recorded across this
 * project's conversations, read on request from their session journals.
 */
export function ProjectSideEffectsSummary({
  command,
  onOpenSession,
}: {
  command: EngineCommand;
  /** Opens a conversation's recorded history, when the host can. */
  onOpenSession?: ((sessionId: string) => void) | undefined;
}) {
  const { t } = useDesktopText();
  const [risk, setRisk] = useState(''),
    [summary, setSummary] = useState<SideEffectsSummary | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const load = async () => {
    setBusy(true);
    setError('');
    try {
      const reply = await command(
        'sessions.list',
        { sideEffectsSummary: risk ? { risk } : {} },
        ['sessions.list'],
        { timeoutMs: 180000 },
      );
      const read = readSideEffectsSummary(reply['sideEffectsSummary']);
      if (!read) throw Error(t('historyView.effects.unsupported'));
      setSummary(read);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="project-usage-summary">
      <summary>{t('historyView.effects.title')}</summary>
      <p className="field-help">{t('historyView.effects.help')}</p>
      <div className="project-side-effect-controls">
        <label>
          {t('historyView.effects.risk')}
          <select value={risk} disabled={busy} onChange={(event) => setRisk(event.target.value)}>
            <option value="">{t('historyView.effects.all')}</option>
            {SIDE_EFFECT_RISKS.map((value) => (
              <option key={value} value={value}>
                {t(`historyView.effects.riskName.${riskKey(value)}`)}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="button secondary small"
          disabled={busy}
          onClick={() => void load()}
        >
          {busy
            ? t('historyView.effects.reading')
            : summary
              ? t('historyView.effects.refresh')
              : t('historyView.effects.summarize')}
        </button>
      </div>
      {error && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
      {summary && (
        <>
          <p role="status">
            {t('historyView.effects.total', {
              total: summary.total.toLocaleString(displayLocale()),
              with: summary.sessionsWithEffects,
              scanned: summary.sessionsScanned,
              capped: summary.capped ? t('historyView.effects.capped') : '',
              unreadable: summary.unreadable
                ? t('historyView.effects.unreadable', { count: summary.unreadable })
                : '',
            })}
          </p>
          {summary.byRisk.length > 0 && (
            <p>
              {summary.byRisk.map(([name, n]) => `${name} ${n}`).join(' · ')} —{' '}
              {summary.byTool
                .slice(0, 8)
                .map(([name, n]) => `${name} ${n}`)
                .join(' · ')}
            </p>
          )}
          {summary.records.length > 0 && (
            <table aria-label={t('historyView.effects.title')}>
              <thead>
                <tr>
                  <th scope="col">{t('historyView.effects.column.when')}</th>
                  <th scope="col">{t('historyView.effects.column.conversation')}</th>
                  <th scope="col">{t('historyView.effects.column.tool')}</th>
                  <th scope="col">{t('historyView.effects.column.risk')}</th>
                  <th scope="col">{t('historyView.effects.column.input')}</th>
                </tr>
              </thead>
              <tbody>
                {summary.records.map((row, index) => (
                  <tr key={`${row.sessionId}:${row.ts}:${index}`}>
                    <td>{displayDateTime(row.ts)}</td>
                    <td>
                      {onOpenSession ? (
                        <button
                          type="button"
                          className="text-link"
                          onClick={() => onOpenSession(row.sessionId)}
                        >
                          {row.sessionTitle}
                        </button>
                      ) : (
                        row.sessionTitle
                      )}
                    </td>
                    <td>{row.toolName}</td>
                    <td>
                      {t(`historyView.effects.riskName.${riskKey(row.risk)}`, {
                        defaultValue: row.risk,
                      })}
                    </td>
                    <td>
                      <code>{row.input}</code>
                      {row.outcome && <small> · {row.outcome}</small>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {summary.recordsTruncated && <p>{t('historyView.effects.truncated')}</p>}
        </>
      )}
    </details>
  );
}

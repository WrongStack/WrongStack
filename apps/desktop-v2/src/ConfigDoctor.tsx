import { Stethoscope } from 'lucide-react';
import { useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';

export interface ConfigDoctorReport {
  changed: boolean;
  applied: boolean;
  changes: { path: string; action: 'added' | 'replaced' }[];
  configPath: string;
  backupPath: string;
}

/** The engine's `config.doctor.result`. */
export function configDoctorReport(value: unknown): ConfigDoctorReport {
  const row = record(value);
  return {
    changed: row['changed'] === true,
    applied: row['applied'] === true,
    changes: entries(row['changes']).map((change) => ({
      path: String(change['path'] ?? ''),
      action: change['action'] === 'replaced' ? 'replaced' : 'added',
    })),
    configPath: typeof row['configPath'] === 'string' ? row['configPath'] : '',
    backupPath: typeof row['backupPath'] === 'string' ? row['backupPath'] : '',
  };
}

/**
 * Checks the active profile config against the canonical defaults: missing settings are
 * added and settings with an incompatible type are replaced. A preview changes nothing; an
 * apply keeps a timestamped backup of the exact previous file. Provider and model are never
 * invented.
 */
export function ConfigDoctor({
  command,
  onApplied,
}: {
  command: EngineCommand;
  /** Called after a repair was written, so open settings can be read again. */
  onApplied?: (() => void) | undefined;
}) {
  const { t } = useDesktopText();
  const [report, setReport] = useState<ConfigDoctorReport | null>(null),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState(false),
    [error, setError] = useState('');
  const run = async (apply: boolean) => {
    setBusy(true);
    setError('');
    setConfirm(false);
    try {
      const next = configDoctorReport(
        await command('config.doctor', { apply }, ['config.doctor.result']),
      );
      setReport(next);
      if (next.applied) onApplied?.();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="config-doctor" aria-label={t('configDoctor.title')}>
      <h3>
        <Stethoscope size={15} /> {t('configDoctor.title')}
      </h3>
      <p className="field-help">{t('configDoctor.intro')}</p>
      <div className="config-doctor-actions">
        <button
          type="button"
          className="button secondary small"
          disabled={busy}
          onClick={() => void run(false)}
        >
          {busy && !confirm ? t('configDoctor.checking') : t('configDoctor.check')}
        </button>
        {report?.changed && !report.applied && (
          <button
            type="button"
            className="button primary small"
            disabled={busy}
            onClick={() => setConfirm(true)}
          >
            {report.changes.length === 1
              ? t('configDoctor.repairOne')
              : t('configDoctor.repairMany', { number: report.changes.length })}
          </button>
        )}
      </div>
      {confirm && (
        <div className="config-doctor-confirm" role="alert">
          <p>
            {t('configDoctor.confirm', {
              path: report?.configPath || t('configDoctor.profileConfig'),
            })}
          </p>
          <button
            type="button"
            className="button primary small"
            disabled={busy}
            onClick={() => void run(true)}
          >
            {t('configDoctor.repairBackup')}
          </button>
          <button
            type="button"
            className="button secondary small"
            onClick={() => setConfirm(false)}
          >
            {t('configDoctor.keep')}
          </button>
        </div>
      )}
      {report && (
        <div role="status">
          {report.applied ? (
            <p>
              {t('configDoctor.repaired', { number: report.changes.length })}{' '}
              <code>{report.backupPath || t('configDoctor.notReported')}</code>
            </p>
          ) : report.changed ? (
            <p>{t('configDoctor.differ', { number: report.changes.length })}</p>
          ) : (
            <p>{t('configDoctor.matches')}</p>
          )}
          {report.changes.length > 0 && (
            <ul className="config-doctor-changes">
              {report.changes.slice(0, 200).map((change) => (
                <li key={change.path}>
                  <code>{change.path}</code>{' '}
                  {change.action === 'added' ? t('configDoctor.added') : t('configDoctor.replaced')}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
    </section>
  );
}

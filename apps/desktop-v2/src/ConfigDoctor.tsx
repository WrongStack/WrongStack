import { Stethoscope } from 'lucide-react';
import { useState } from 'react';
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
    <section className="config-doctor" aria-label="Configuration check">
      <h3>
        <Stethoscope size={15} /> Configuration check
      </h3>
      <p className="field-help">
        Compares the active profile configuration with the current defaults. Missing settings are
        added and settings of the wrong type are replaced; provider and model are never chosen for
        you.
      </p>
      <div className="config-doctor-actions">
        <button
          type="button"
          className="button secondary small"
          disabled={busy}
          onClick={() => void run(false)}
        >
          {busy && !confirm ? 'Checking…' : 'Check configuration'}
        </button>
        {report?.changed && !report.applied && (
          <button
            type="button"
            className="button primary small"
            disabled={busy}
            onClick={() => setConfirm(true)}
          >
            Repair {report.changes.length} {report.changes.length === 1 ? 'setting' : 'settings'}…
          </button>
        )}
      </div>
      {confirm && (
        <div className="config-doctor-confirm" role="alert">
          <p>
            Write these changes to {report?.configPath || 'the profile configuration'}? The current
            file is kept as a backup first. Unsaved edits in open settings forms are not included.
          </p>
          <button
            type="button"
            className="button primary small"
            disabled={busy}
            onClick={() => void run(true)}
          >
            Repair and keep a backup
          </button>
          <button
            type="button"
            className="button secondary small"
            onClick={() => setConfirm(false)}
          >
            Keep current
          </button>
        </div>
      )}
      {report && (
        <div role="status">
          {report.applied ? (
            <p>
              Repaired {report.changes.length} settings. Backup:{' '}
              <code>{report.backupPath || 'not reported'}</code>
            </p>
          ) : report.changed ? (
            <p>{report.changes.length} settings differ from the defaults:</p>
          ) : (
            <p>The configuration matches the current defaults.</p>
          )}
          {report.changes.length > 0 && (
            <ul className="config-doctor-changes">
              {report.changes.slice(0, 200).map((change) => (
                <li key={change.path}>
                  <code>{change.path}</code> {change.action === 'added' ? 'added' : 'replaced'}
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

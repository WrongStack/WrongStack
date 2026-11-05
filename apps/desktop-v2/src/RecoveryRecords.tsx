import { FileCode, History } from 'lucide-react';
import { useDesktopText } from './desktop-i18n';
import {
  RECOVERY_OPERATION_LABELS,
  RECOVERY_OUTCOME_LABELS,
  type RecoveryRecord,
} from './recovery-log';
import { recoveryDate } from './session-recovery-model';

/** Recovery operations started from this desktop for this session, newest first. */
export function RecoveryRecords({
  records,
  error,
  onOpenFile,
}: {
  records: RecoveryRecord[];
  error: string;
  onOpenFile: (path: string) => void;
}) {
  const { t } = useDesktopText();
  if (!records.length && !error) return null;
  return (
    <details className="recovery-records">
      <summary>
        <History size={14} />
        {t('recovery.records.title', { n: records.length })}
      </summary>
      <p className="settings-defaults-note">{t('recovery.records.hint')}</p>
      {error && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
      <ol aria-label={t('recovery.records.label')}>
        {records.map((item) => (
          <li key={item.id} className={`recovery-record recovery-record-${item.outcome}`}>
            <strong>
              {t(`recovery.records.operation.${item.operation}`, {
                defaultValue: RECOVERY_OPERATION_LABELS[item.operation],
              })}
              {item.checkpoint === null
                ? ''
                : ` · ${t('recovery.records.checkpoint', { n: item.checkpoint })}`}
            </strong>
            <span>
              {t(`recovery.records.outcome.${item.outcome}`, {
                defaultValue: RECOVERY_OUTCOME_LABELS[item.outcome],
              })}
            </span>
            <small>
              {recoveryDate(new Date(item.at).toISOString(), t('recovery.timeMissing'))}
              {item.outcome === 'completed' || item.outcome === 'partial'
                ? ` · ${t(item.operation === 'redo' ? 'recovery.records.reapplied' : 'recovery.records.restored', { n: item.fileCount })}`
                : ''}
              {item.removedEvents === null
                ? ''
                : ` · ${t('recovery.records.removed', { n: item.removedEvents })}`}
            </small>
            {item.note && <p>{item.note}</p>}
            {item.errors.length > 0 && (
              <ul aria-label={t('recovery.records.fileErrors')}>
                {item.errors.map((line, index) => (
                  <li key={`${index}-${line}`}>{line}</li>
                ))}
              </ul>
            )}
            {item.files.map((path) => (
              <button
                type="button"
                className="recovery-file-link"
                key={path}
                onClick={() => onOpenFile(path)}
              >
                <FileCode size={14} />
                {path}
              </button>
            ))}
            {item.fileCount > item.files.length && (
              <small>
                {t('recovery.records.more', { count: item.fileCount - item.files.length })}
              </small>
            )}
          </li>
        ))}
      </ol>
    </details>
  );
}

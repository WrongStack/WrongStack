import { FileCode, History } from 'lucide-react';
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
  if (!records.length && !error) return null;
  return (
    <details className="recovery-records">
      <summary>
        <History size={14} />
        Recovery operations ({records.length})
      </summary>
      <p className="settings-defaults-note">
        Rewinds, retries and redos started from this desktop, as observed when they ran. They
        survive a restart; work done elsewhere is not listed.
      </p>
      {error && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
      <ol aria-label="Recovery operations">
        {records.map((item) => (
          <li key={item.id} className={`recovery-record recovery-record-${item.outcome}`}>
            <strong>
              {RECOVERY_OPERATION_LABELS[item.operation]}
              {item.checkpoint === null ? '' : ` · checkpoint ${item.checkpoint}`}
            </strong>
            <span>{RECOVERY_OUTCOME_LABELS[item.outcome]}</span>
            <small>
              {recoveryDate(new Date(item.at).toISOString())}
              {item.outcome === 'completed' || item.outcome === 'partial'
                ? ` · ${item.operation === 'redo' ? 'Re-applied' : 'Restored'} files: ${item.fileCount}`
                : ''}
              {item.removedEvents === null
                ? ''
                : ` · Removed journal events: ${item.removedEvents}`}
            </small>
            {item.note && <p>{item.note}</p>}
            {item.errors.length > 0 && (
              <ul aria-label="File errors">
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
                {item.fileCount - item.files.length} more files not kept in this record.
              </small>
            )}
          </li>
        ))}
      </ol>
    </details>
  );
}

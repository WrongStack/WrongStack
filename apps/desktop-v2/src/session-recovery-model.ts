import { entries, record } from './engine-values';

export interface RecoveryCheckpoint {
  promptIndex: number;
  promptPreview: string;
  ts: string;
  fileCount: number;
}
export function recoveryCheckpoints(value: unknown): RecoveryCheckpoint[] {
  return entries(value).flatMap((item) =>
    typeof item['promptIndex'] === 'number' &&
    Number.isSafeInteger(item['promptIndex']) &&
    item['promptIndex'] >= 0
      ? [
          {
            promptIndex: item['promptIndex'],
            promptPreview: String(item['promptPreview'] ?? ''),
            ts: String(item['ts'] ?? ''),
            fileCount: typeof item['fileCount'] === 'number' ? item['fileCount'] : 0,
          },
        ]
      : [],
  );
}
export function recoveryDate(value: unknown) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return 'Time not recorded';
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
/** Rewind cuts at the first recorded checkpoint with an index, even after index reuse. */
export function checkpointBoundaries(checkpoints: RecoveryCheckpoint[]) {
  const seen = new Set<number>();
  return checkpoints.filter((checkpoint) => {
    if (seen.has(checkpoint.promptIndex)) return false;
    seen.add(checkpoint.promptIndex);
    return true;
  });
}
export function recoveryResult(value: unknown) {
  const result = record(record(value)['rewind']);
  return typeof result['toPromptIndex'] === 'number'
    ? {
        checkpoint: result['toPromptIndex'],
        files: Array.isArray(result['revertedFiles']) ? result['revertedFiles'].map(String) : [],
        errors: Array.isArray(result['errors']) ? result['errors'].map(String) : [],
        removedEvents: typeof result['removedEvents'] === 'number' ? result['removedEvents'] : null,
        messageCount: typeof result['messageCount'] === 'number' ? result['messageCount'] : null,
        /** Text of the rewound prompt, when the engine reports it; attachments are not included. */
        promptText: typeof result['promptText'] === 'string' ? result['promptText'] : '',
      }
    : null;
}
export function checkpointMatches(reviewed: RecoveryCheckpoint[], current: RecoveryCheckpoint[]) {
  return JSON.stringify(reviewed) === JSON.stringify(current);
}
/** The engine's account of a redone rewind; null when the reply carries none. */
export function redoResult(value: unknown) {
  const result = record(record(value)['redo']);
  return typeof result['toPromptIndex'] === 'number'
    ? {
        checkpoint: result['toPromptIndex'],
        files: Array.isArray(result['reappliedFiles']) ? result['reappliedFiles'].map(String) : [],
        messageCount: typeof result['messageCount'] === 'number' ? result['messageCount'] : null,
      }
    : null;
}

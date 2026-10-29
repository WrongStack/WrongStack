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
        promptHasAttachments: result['promptHasAttachments'] === true,
      }
    : null;
}

/**
 * The newest checkpoint, when a rewind to it takes back only the newest prompt. After an earlier
 * rewind a prompt index can appear twice; the engine cuts at the first, which would take back
 * more than one prompt, so such a checkpoint is not offered for a one-step retry.
 */
export function retryCheckpoint(checkpoints: RecoveryCheckpoint[]): RecoveryCheckpoint | null {
  const newest = checkpoints.at(-1);
  return newest && checkpoints.filter((p) => p.promptIndex === newest.promptIndex).length === 1
    ? newest
    : null;
}

/** Whether a retry may send the rewound prompt again unchanged, or why not. */
export function retryPlan(
  result: NonNullable<ReturnType<typeof recoveryResult>>,
): { text: string } | { reason: string } {
  if (!result.promptText.trim())
    return { reason: 'The journal has no recorded text for this prompt, so nothing was sent.' };
  if (result.errors.length)
    return {
      reason: 'Some files were not restored, so nothing was sent. Inspect them before sending.',
    };
  if (result.promptHasAttachments)
    return {
      reason:
        'This prompt had attached files or images, so nothing was sent. Use Edit and resend to attach them again.',
    };
  return { text: result.promptText };
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

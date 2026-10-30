import { DurableSessionLog, type SavedSessionLog, sessionLogKey } from './durable-session-log';
import type { recoveryResult, redoResult } from './session-recovery-model';

export type RecoveryOperation = 'rewind' | 'retry' | 'redo';
/**
 * `completed` and `partial` (journal cut, some file operations failed) are engine-reported
 * results. `refused` means this window stopped before asking the engine; `failed` means the
 * engine request did not return a result, so what changed is unknown.
 */
export type RecoveryOutcome = 'completed' | 'partial' | 'refused' | 'failed';

/** One recovery operation this desktop started, as it was observed at the time. */
export interface RecoveryRecord {
  id: string;
  operation: RecoveryOperation;
  outcome: RecoveryOutcome;
  at: number;
  checkpoint: number | null;
  /** Up to `MAX_FILES` restored or re-applied paths; `fileCount` keeps the full number. */
  files: string[];
  fileCount: number;
  errors: string[];
  removedEvents: number | null;
  messageCount: number | null;
  note: string;
}
export type SavedRecoveryLog = SavedSessionLog<RecoveryRecord>;

export const MAX_RECOVERY_RECORDS = 50;
const MAX_FILES = 100;
const MAX_ERRORS = 20;
const MAX_TEXT = 2000;
const OPERATIONS: readonly string[] = ['rewind', 'retry', 'redo'];
const OUTCOMES: readonly string[] = ['completed', 'partial', 'refused', 'failed'];

const text = (value: string) => value.slice(0, MAX_TEXT);
const count = (value: unknown) =>
  value === null || (Number.isSafeInteger(value) && (value as number) >= 0);
const strings = (value: unknown, max: number) =>
  Array.isArray(value) &&
  value.length <= max &&
  value.every((item) => typeof item === 'string' && item.length <= MAX_TEXT);

export function parseRecoveryLog(value: unknown): RecoveryRecord[] {
  if (value === null) return [];
  const data = value as Partial<SavedRecoveryLog> | undefined;
  if (
    data?.version !== 1 ||
    !Array.isArray(data.entries) ||
    data.entries.length > MAX_RECOVERY_RECORDS ||
    !data.entries.every(
      (item) =>
        !!item &&
        typeof item.id === 'string' &&
        !!item.id &&
        OPERATIONS.includes(item.operation) &&
        OUTCOMES.includes(item.outcome) &&
        Number.isSafeInteger(item.at) &&
        item.at > 0 &&
        count(item.checkpoint) &&
        strings(item.files, MAX_FILES) &&
        count(item.fileCount) &&
        item.fileCount >= item.files.length &&
        strings(item.errors, MAX_ERRORS) &&
        count(item.removedEvents) &&
        count(item.messageCount) &&
        typeof item.note === 'string' &&
        item.note.length <= MAX_TEXT,
    )
  )
    throw Error('Saved recovery records have an unsupported format.');
  return data.entries.map((item) => ({
    ...item,
    files: [...item.files],
    errors: [...item.errors],
  }));
}

/** Newest first, one entry per id, bounded. */
export function mergeRecoveryRecords(...lists: readonly RecoveryRecord[][]): RecoveryRecord[] {
  const byId = new Map<string, RecoveryRecord>();
  for (const item of lists.flat()) if (!byId.has(item.id)) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => b.at - a.at).slice(0, MAX_RECOVERY_RECORDS);
}

function base(operation: RecoveryOperation, at: number): Omit<RecoveryRecord, 'outcome'> {
  return {
    id: crypto.randomUUID(),
    operation,
    at,
    checkpoint: null,
    files: [],
    fileCount: 0,
    errors: [],
    removedEvents: null,
    messageCount: null,
    note: '',
  };
}

/** A rewind (or the rewind of a retry) the engine reported, with what followed it. */
export function rewindRecord(
  observed: NonNullable<ReturnType<typeof recoveryResult>>,
  operation: 'rewind' | 'retry',
  note = '',
  at = Date.now(),
): RecoveryRecord {
  return {
    ...base(operation, at),
    outcome: observed.errors.length ? 'partial' : 'completed',
    checkpoint: observed.checkpoint,
    files: observed.files.slice(0, MAX_FILES).map(text),
    fileCount: observed.files.length,
    errors: observed.errors.slice(0, MAX_ERRORS).map(text),
    removedEvents: observed.removedEvents,
    messageCount: observed.messageCount,
    note: text(note),
  };
}

export function redoRecord(
  observed: NonNullable<ReturnType<typeof redoResult>>,
  at = Date.now(),
): RecoveryRecord {
  return {
    ...base('redo', at),
    outcome: 'completed',
    checkpoint: observed.checkpoint,
    files: observed.files.slice(0, MAX_FILES).map(text),
    fileCount: observed.files.length,
    messageCount: observed.messageCount,
  };
}

/** An operation that ended without an engine result: refused here, or failed in the engine. */
export function unfinishedRecord(
  operation: RecoveryOperation,
  outcome: 'refused' | 'failed',
  checkpoint: number | null,
  message: string,
  at = Date.now(),
): RecoveryRecord {
  return { ...base(operation, at), outcome, checkpoint, note: text(message) };
}

export const RECOVERY_OPERATION_LABELS: Record<RecoveryOperation, string> = {
  rewind: 'Rewind',
  retry: 'Retry last prompt',
  redo: 'Redo last rewind',
};
export const RECOVERY_OUTCOME_LABELS: Record<RecoveryOutcome, string> = {
  completed: 'Completed',
  partial: 'Journal rewound · file errors',
  refused: 'Not started · session changed after review',
  failed: 'Did not complete · no engine result',
};

/** One native slot per project session, so sessions never share recovery records. */
export function recoveryLogKey(projectId: string, sessionId: string) {
  return sessionLogKey('session-recovery-log', projectId, sessionId);
}

export const recoveryLog = new DurableSessionLog<RecoveryRecord>({
  label: 'Recovery records',
  parse: parseRecoveryLog,
  merge: mergeRecoveryRecords,
  serialize: (entries) => ({ version: 1, entries }),
});

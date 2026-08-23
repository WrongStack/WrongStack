import * as fsp from 'node:fs/promises';
import type { EventBus } from './event-bus-port.js';
import type { CompletedWorkEvidence } from '../types/context-evidence.js';
import { atomicWrite } from '../utils/atomic-write.js';
import { toErrorMessage } from '../utils/error.js';

export interface CompletedWorkCheckpointFile {
  version: 1;
  sessionId: string;
  updatedAt: string;
  completedWork: CompletedWorkEvidence[];
}

export async function loadCompletedWorkCheckpoint(
  filePath: string,
  events?: EventBus,
  traceId?: string,
): Promise<CompletedWorkEvidence[] | null> {
  const t0 = Date.now();
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, 'utf8');
  } catch (err) {
    events?.emit('storage.error', {
      sessionId: traceId ?? '~boot~',
      store: 'completed-work',
      filePath,
      operation: 'load',
      outcome: 'failure',
      error: toErrorMessage(err),
      recoverable: true,
    });
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as CompletedWorkCheckpointFile;
    if (parsed?.version !== 1 || !Array.isArray(parsed.completedWork)) {
      events?.emit('storage.read', {
        sessionId: traceId ?? '~boot~',
        store: 'completed-work',
        filePath,
        operation: 'load',
        outcome: 'failure',
        durationMs: Date.now() - t0,
        error: 'invalid_schema',
        ...(traceId !== undefined && { traceId }),
      });
      return null;
    }
    events?.emit('storage.read', {
      sessionId: traceId ?? '~boot~',
      store: 'completed-work',
      filePath,
      operation: 'load',
      outcome: 'success',
      durationMs: Date.now() - t0,
      ...(traceId !== undefined && { traceId }),
    });
    return parsed.completedWork.filter(isCompletedWorkEvidence);
  } catch {
    events?.emit('storage.read', {
      sessionId: traceId ?? '~boot~',
      store: 'completed-work',
      filePath,
      operation: 'load',
      outcome: 'failure',
      durationMs: Date.now() - t0,
      error: 'parse_failed',
      ...(traceId !== undefined && { traceId }),
    });
    return null;
  }
}

export async function saveCompletedWorkCheckpoint(
  filePath: string,
  sessionId: string,
  completedWork: readonly CompletedWorkEvidence[],
  events?: EventBus,
  traceId?: string,
): Promise<void> {
  const t0 = Date.now();
  const payload: CompletedWorkCheckpointFile = {
    version: 1,
    sessionId,
    updatedAt: new Date().toISOString(),
    completedWork: [...completedWork],
  };
  try {
    await atomicWrite(filePath, JSON.stringify(payload, null, 2), { mode: 0o600 });
    events?.emit('storage.write', {
      sessionId: traceId ?? sessionId,
      store: 'completed-work',
      filePath,
      operation: 'save',
      outcome: 'success',
      durationMs: Date.now() - t0,
      ...(traceId !== undefined && { traceId }),
    });
  } catch (err) {
    events?.emit('storage.error', {
      sessionId: traceId ?? sessionId,
      store: 'completed-work',
      filePath,
      operation: 'save',
      outcome: 'failure',
      error: toErrorMessage(err),
      recoverable: false,
    });
    console.warn(JSON.stringify({
      level: 'warn',
      event: 'completed_work_checkpoint.save_failed',
      message: toErrorMessage(err),
      timestamp: new Date().toISOString(),
    }));
  }
}

function isCompletedWorkEvidence(value: unknown): value is CompletedWorkEvidence {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<CompletedWorkEvidence>;
  return (
    typeof item.key === 'string' &&
    typeof item.source === 'string' &&
    ['todo', 'plan', 'task', 'verification', 'manual'].includes(item.source) &&
    typeof item.summary === 'string' &&
    typeof item.completedAt === 'number' &&
    (item.evidence === undefined || typeof item.evidence === 'string')
  );
}

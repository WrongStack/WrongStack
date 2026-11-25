import { StaleWriteError } from '../manager/lifecycle-error.js';
import type { KanbanErrorCode, KanbanErrorResponse } from './protocol.js';

export function invalid(message: string): never {
  throw { code: 'INVALID_INPUT', message };
}

export function assertWorkflowId(workflowId: string): void {
  if (
    typeof workflowId !== 'string' ||
    workflowId.length === 0 ||
    workflowId.length > 256 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(workflowId)
  ) {
    invalid('workflowId must be a safe non-empty project-local identifier');
  }
}

export function assertWorkflowPrefix(prefix: string): void {
  if (
    typeof prefix !== 'string' ||
    prefix.length === 0 ||
    prefix.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(prefix)
  ) {
    invalid('workflow prefix must be a safe non-empty project-local prefix');
  }
}

export function errorFromThrown(value: unknown): KanbanErrorResponse['error'] {
  if (value && typeof value === 'object' && 'code' in value && 'message' in value) {
    const v = value as { code: KanbanErrorCode; message: string };
    return { code: v.code, message: v.message };
  }
  if (value instanceof StaleWriteError) {
    return { code: 'STALE_WRITE', message: value.message };
  }
  if (value instanceof Error) {
    return { code: 'INTERNAL_ERROR', message: value.message, cause: value.stack ?? null };
  }
  let message: string;
  try {
    message = String(value);
  } catch {
    message = 'Unknown error';
  }
  return { code: 'INTERNAL_ERROR', message };
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

export function parseArgs(argv: string[]): { projectRoot: string } {
  let root = '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project-root' && i + 1 < argv.length) {
      root = argv[i + 1] ?? '';
      i++;
    }
  }
  if (!root) throw new Error('kanban project server requires --project-root');
  return { projectRoot: root };
}

import { ToolValidationError } from '@wrongstack/contracts/types';
import {
  decodeLifecycleIssues,
  type KanbanBoard,
  type KanbanCompletionGateEnforcement,
  type KanbanLifecycleValidationIssue,
  type KanbanTask,
  stripLifecycleIssues,
} from '@wrongstack/kanban';
import type { KanbanToolOutput } from './kanban-tool-types.js';

/** One-line guidance appended when a freshly created task should be split. */
export function atomicityNudge(task: KanbanTask): string {
  if (task.atomicityAssessment?.verdict !== 'needs_decomposition') return '';
  const reasons = task.atomicityAssessment.criteria
    .filter((entry) => entry.score < 1)
    .map((entry) => entry.reason)
    .join(' | ');
  return ` Atomicity: needs_decomposition (score ${task.atomicityAssessment.score}) — call propose_decomposition with 2+ subtasks before dispatch. Reasons: ${reasons}`;
}

/**
 * Host-level completion-gate fallback. The kanban package stays env-free;
 * only hosting surfaces (tools, webui-server) read WRONGSTACK_KANBAN_GATE,
 * and only when the board carries no explicit completionGate policy.
 */
export function readEnvGateEnforcement(): KanbanCompletionGateEnforcement | undefined {
  const raw = process.env['WRONGSTACK_KANBAN_GATE']?.trim().toLowerCase();
  return raw === 'strict' || raw === 'soft' || raw === 'off' ? raw : undefined;
}

// ── Error contract ───────────────────────────────────────────────────────
//
// The ToolExecutor records a call as FAILED only when `execute()` throws; any
// returned value — `{ ok: false }` included — is audited and shown as a
// success. So every operational failure of this tool throws, and only real
// data outcomes (a gate verdict, "nothing to claim", "nothing stale") come back
// as return values. A successful result therefore always carries `ok: true`.

export type KanbanToolErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'REFUSED'
  | 'CONFLICT'
  | 'UNAVAILABLE'
  | 'ABORTED';

/**
 * Errno-style hint read by core's `classifyToolError`, which maps
 * `err.code` ENOENT → not_found and EBUSY/ECONNREFUSED → transient
 * (retryable). The Kanban code itself lives on `kanbanCode` and is also the
 * `[CODE]` prefix of the message, so the model sees it whatever the category.
 */
const CLASSIFIER_HINT: Partial<Record<KanbanToolErrorCode, string>> = {
  NOT_FOUND: 'ENOENT',
  CONFLICT: 'EBUSY',
  UNAVAILABLE: 'ECONNREFUSED',
};

export interface KanbanToolErrorOptions {
  /** Structured lifecycle issues (REFUSED), kept for programmatic callers. */
  issues?: readonly KanbanLifecycleValidationIssue[] | undefined;
  retryable?: boolean | undefined;
  /** What already committed before the failure, stated in the message. */
  committed?: string | undefined;
  cause?: unknown;
}

/** Common shape of every error this tool throws on purpose. */
export interface KanbanToolFailure extends Error {
  readonly kanbanCode: KanbanToolErrorCode;
  readonly retryable: boolean;
  readonly issues?: readonly KanbanLifecycleValidationIssue[] | undefined;
}

function formatKanbanErrorMessage(
  code: KanbanToolErrorCode,
  message: string,
  opts: KanbanToolErrorOptions,
): string {
  let text = `[${code}] ${message}`;
  if (opts.committed) text += ` Already committed: ${opts.committed}`;
  const extra = (opts.issues ?? []).filter((issue) => issue.message.trim() !== message.trim());
  if (extra.length > 0) {
    text += ` Issues: ${extra
      .map((issue) => (issue.field ? `${issue.field}: ${issue.message}` : issue.message))
      .join(' | ')}`;
  }
  return text;
}

export class KanbanToolError extends Error implements KanbanToolFailure {
  readonly kanbanCode: KanbanToolErrorCode;
  /** Classifier hint (see CLASSIFIER_HINT); not the Kanban code. */
  readonly code: string | undefined;
  readonly retryable: boolean;
  readonly issues: readonly KanbanLifecycleValidationIssue[] | undefined;
  readonly committed: string | undefined;
  /** The bare message, without the code prefix, committed note, or issues tail. */
  readonly detail: string;

  constructor(code: KanbanToolErrorCode, message: string, opts: KanbanToolErrorOptions = {}) {
    super(
      formatKanbanErrorMessage(code, message, opts),
      opts.cause !== undefined ? { cause: opts.cause } : undefined,
    );
    this.detail = message;
    // An abort is a cancellation; core classifies `AbortError` as such.
    this.name = code === 'ABORTED' ? 'AbortError' : 'KanbanToolError';
    this.kanbanCode = code;
    this.retryable = opts.retryable ?? (code === 'CONFLICT' || code === 'UNAVAILABLE');
    // EBUSY / ECONNREFUSED make core classify the failure as TRANSIENT, i.e.
    // retryable. Only give that hint when a retry is actually safe — a CONFLICT
    // that already committed work (a split whose parent vanished, a rollback
    // that failed) must not be replayed.
    const hint = CLASSIFIER_HINT[code];
    this.code = hint === 'ENOENT' || this.retryable ? hint : undefined;
    this.issues = opts.issues;
    this.committed = opts.committed;
  }
}

/**
 * INVALID_INPUT is a `ToolValidationError` so the executor classifies it as a
 * validation failure; it carries the same `kanbanCode` contract as the rest.
 */
export class KanbanInputError extends ToolValidationError implements KanbanToolFailure {
  readonly kanbanCode = 'INVALID_INPUT' as const;
  readonly retryable = false;
  readonly issues = undefined;

  constructor(message: string, field?: string) {
    super({ message: `[INVALID_INPUT] ${message}`, ...(field !== undefined ? { field } : {}) });
  }
}

export function invalidInput(message: string, field?: string): KanbanInputError {
  return new KanbanInputError(message, field);
}

export function notFound(message: string, opts: KanbanToolErrorOptions = {}): KanbanToolError {
  return new KanbanToolError('NOT_FOUND', message, opts);
}

export function refused(message: string, opts: KanbanToolErrorOptions = {}): KanbanToolError {
  return new KanbanToolError('REFUSED', message, opts);
}

export function conflict(message: string, opts: KanbanToolErrorOptions = {}): KanbanToolError {
  return new KanbanToolError('CONFLICT', message, opts);
}

export function isKanbanToolFailure(err: unknown): err is KanbanToolFailure {
  return (
    err instanceof Error &&
    typeof (err as { kanbanCode?: unknown }).kanbanCode === 'string' &&
    typeof (err as { retryable?: unknown }).retryable === 'boolean'
  );
}

function errorCode(err: Error): string | undefined {
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function lifecycleIssuesOf(err: Error): readonly KanbanLifecycleValidationIssue[] {
  const own = (err as { issues?: unknown }).issues;
  if (Array.isArray(own)) return own as KanbanLifecycleValidationIssue[];
  // Envelope form, as it crosses IPC. The kanban package owns its encoding.
  return decodeLifecycleIssues(err);
}

const UNAVAILABLE_MESSAGE_PATTERNS: readonly RegExp[] = [
  /^Kanban project server is disabled/,
  /^Failed to connect to kanban project server/,
  /^Kanban server .+: /,
  /^Connection closed$/,
  /^connect-timeout$/,
  /^Request \S+ timed out$/,
];

const UNAVAILABLE_ERRNO = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT']);

/**
 * Map an error escaping a kanban handler onto the tool's error contract.
 * Recognised domain/transport failures become a `KanbanToolError`; anything
 * else (a TypeError, an unexpected invariant) is returned unchanged so it
 * propagates as the bug it is instead of being dressed up as a refusal.
 */
export function toKanbanToolError(err: unknown, committed?: string): unknown {
  if (!(err instanceof Error)) return err;
  if (isKanbanToolFailure(err)) {
    if (!committed) return err;
    return err instanceof KanbanToolError
      ? new KanbanToolError(err.kanbanCode, err.detail, {
          issues: err.issues,
          retryable: err.retryable,
          committed: err.committed ? `${err.committed} ${committed}` : committed,
          cause: err,
        })
      : err;
  }
  const code = errorCode(err);
  if (err.name === 'KanbanLifecycleError' || code === 'LIFECYCLE') {
    return refused(stripLifecycleIssues(err.message), {
      issues: lifecycleIssuesOf(err),
      committed,
      cause: err,
    });
  }
  if (err.name === 'StaleWriteError' || code === 'STALE_WRITE') {
    return conflict(err.message, { retryable: true, committed, cause: err });
  }
  if (
    (code !== undefined && UNAVAILABLE_ERRNO.has(code)) ||
    UNAVAILABLE_MESSAGE_PATTERNS.some((pattern) => pattern.test(err.message))
  ) {
    return new KanbanToolError('UNAVAILABLE', err.message, {
      retryable: true,
      committed,
      cause: err,
    });
  }
  if (/^Ambiguous kanban (task|board) id /.test(err.message)) {
    return invalidInput(err.message, 'taskId');
  }
  return err;
}

/** Successful results always carry `ok: true`; failures throw (see above). */
export function okBoard(board: KanbanBoard, message = 'Board loaded.'): KanbanToolOutput {
  return { ok: true, message, board };
}

export function okTask(board: KanbanBoard, task: KanbanTask, message: string): KanbanToolOutput {
  return { ok: true, message, board, task };
}

/**
 * Resolve a task reference (full id or unique prefix) against a loaded board,
 * with the same semantics as the domain's `findTask`. An ambiguous prefix is
 * an input error rather than a silent "not found".
 */
export function resolveTaskRef(board: KanbanBoard, taskRef: string): KanbanTask | undefined {
  if (!taskRef?.trim()) return undefined;
  const exact = board.tasks.find((task) => task.id === taskRef);
  if (exact) return exact;
  const matches = board.tasks.filter((task) => task.id.startsWith(taskRef));
  if (matches.length > 1) {
    throw invalidInput(
      `Ambiguous kanban task id "${taskRef}": ${matches
        .slice(0, 5)
        .map((task) => task.id)
        .join(', ')}`,
      'taskId',
    );
  }
  return matches[0];
}

import type { KanbanLifecycleValidationIssue } from '../types-operations.js';

/** Wire-safe markers for lifecycle validation details embedded in IPC errors. */
export const LIFECYCLE_ISSUES_PREFIX = '\u0001LIFECYCLE_ISSUES\u0002';
export const LIFECYCLE_ISSUES_SUFFIX = '\u0003';

/**
 * Thrown when a concurrent modification is detected during board mutation.
 * Using a typed error (rather than `Error` with a message string) lets
 * callers reliably identify stale-write failures via `instanceof` instead
 * of fragile `error.message.includes(...)` checks.
 *
 * Defined in this leaf module, alongside `KanbanLifecycleError`, so the IPC
 * client can reconstruct it after deserialization without importing
 * `lifecycle.ts` — which reaches storage, and back into the client. Re-exported
 * from `lifecycle.ts` for every existing caller.
 */
export class StaleWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleWriteError';
  }
}

export class KanbanLifecycleError extends Error {
  readonly issues: readonly KanbanLifecycleValidationIssue[];
  /** Stable wire-friendly code so callers can recover the typed error after IPC. */
  readonly code = 'LIFECYCLE' as const;

  constructor(message: string, issues: readonly KanbanLifecycleValidationIssue[]) {
    const issuesPayload = JSON.stringify({ code: 'LIFECYCLE', issues });
    // Strip first: the IPC client reconstructs this error from a message that
    // already carries an envelope, so appending unconditionally produced a
    // message with the payload stacked twice — which then reached the agent
    // verbatim as `... LIFECYCLE_ISSUES{...} LIFECYCLE_ISSUES{...}`.
    const base = stripLifecycleIssues(message);
    super(`${base} ${LIFECYCLE_ISSUES_PREFIX}${issuesPayload}${LIFECYCLE_ISSUES_SUFFIX}`);
    this.name = 'KanbanLifecycleError';
    this.issues = issues;
  }
}

/**
 * Remove every embedded lifecycle envelope from a message, leaving the human
 * sentence behind.
 *
 * The envelope is a transport detail: it exists so structured issues survive
 * the IPC boundary. Any surface that shows the message to a person or to the
 * model must strip it — otherwise the control characters and JSON are read as
 * part of the explanation.
 */
export function stripLifecycleIssues(message: string): string {
  let out = message;
  for (;;) {
    const start = out.indexOf(LIFECYCLE_ISSUES_PREFIX);
    if (start === -1) break;
    const end = out.indexOf(LIFECYCLE_ISSUES_SUFFIX, start + LIFECYCLE_ISSUES_PREFIX.length);
    // An unterminated envelope would otherwise loop forever; drop the tail.
    out = end === -1 ? out.slice(0, start) : out.slice(0, start) + out.slice(end + 1);
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** Recover structured lifecycle validation details from a local or IPC error. */
export function decodeLifecycleIssues(err: unknown): readonly KanbanLifecycleValidationIssue[] {
  if (err instanceof KanbanLifecycleError) return err.issues;
  if (typeof err !== 'object' || err === null) return [];
  const message = (err as { message?: unknown }).message;
  if (typeof message !== 'string') return [];
  const start = message.indexOf(LIFECYCLE_ISSUES_PREFIX);
  if (start === -1) return [];
  const end = message.indexOf(LIFECYCLE_ISSUES_SUFFIX, start + LIFECYCLE_ISSUES_PREFIX.length);
  if (end === -1) return [];
  try {
    const payload = JSON.parse(message.slice(start + LIFECYCLE_ISSUES_PREFIX.length, end)) as {
      issues?: unknown;
    };
    if (!payload || !Array.isArray(payload.issues)) return [];
    return payload.issues as readonly KanbanLifecycleValidationIssue[];
  } catch {
    return [];
  }
}

import type { KanbanLifecycleValidationIssue } from '../types-operations.js';

/** Wire-safe markers for lifecycle validation details embedded in IPC errors. */
export const LIFECYCLE_ISSUES_PREFIX = '\u0001LIFECYCLE_ISSUES\u0002';
export const LIFECYCLE_ISSUES_SUFFIX = '\u0003';

export class KanbanLifecycleError extends Error {
  readonly issues: readonly KanbanLifecycleValidationIssue[];
  /** Stable wire-friendly code so callers can recover the typed error after IPC. */
  readonly code = 'LIFECYCLE' as const;

  constructor(message: string, issues: readonly KanbanLifecycleValidationIssue[]) {
    const issuesPayload = JSON.stringify({ code: 'LIFECYCLE', issues });
    super(`${message} ${LIFECYCLE_ISSUES_PREFIX}${issuesPayload}${LIFECYCLE_ISSUES_SUFFIX}`);
    this.name = 'KanbanLifecycleError';
    this.issues = issues;
  }
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

/** Stable machine-readable code for session ownership invariant violations. */
export const SESSION_ID_REQUIRED = 'SESSION_ID_REQUIRED' as const;

/** Thrown when session-scoped work is attempted without a usable session id. */
export class SessionIdRequiredError extends Error {
  readonly code = SESSION_ID_REQUIRED;

  constructor(operation: string) {
    super(`Session id is required for ${operation}`);
    this.name = 'SessionIdRequiredError';
  }
}

/**
 * Enforce that session-scoped work has an explicit, non-blank owner.
 * Returns the original id so slash-containing persisted ids remain unchanged.
 */
export function requireSessionId(sessionId: string | null | undefined, operation: string): string {
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    throw new SessionIdRequiredError(operation);
  }
  return sessionId;
}

/** Prefix marking a session id that belongs to a daemon rather than a user tab. */
export const SYSTEM_SESSION_PREFIX = 'system:' as const;

/**
 * Owning "session" for work a project-level daemon does on its own initiative
 * — the Kanban supervisor's stale-lease recovery, a run mirror's projection
 * refresh. No user tab asked for these, but the events they write still have
 * to name an owner, and attributing them to whichever tab happened to be
 * focused would be a lie that "stop this session's work" would then act on.
 *
 * The `system:` prefix keeps them filterable: a UI showing one tab's activity
 * excludes them, and an operator auditing the ledger can see which daemon
 * acted.
 */
export function systemSessionId(actor: string): string {
  return `${SYSTEM_SESSION_PREFIX}${actor}`;
}

/** Whether this id names a daemon rather than a user session. */
export function isSystemSessionId(sessionId: string): boolean {
  return sessionId.startsWith(SYSTEM_SESSION_PREFIX);
}

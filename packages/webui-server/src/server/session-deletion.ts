import type { SessionStore } from '@wrongstack/core/types';

export interface SessionDeletionContext {
  getActiveSessionId: () => string;
  getSessionStore: () => SessionStore;
  refreshSessions: () => Promise<void>;
}

/**
 * Canonical WebUI session deletion flow. Both the session.delete route and
 * background hygiene call this operation so active-session protection,
 * SessionStore ownership checks, and artifact/catalog cleanup cannot drift.
 */
export async function deleteWebUISession(
  ctx: SessionDeletionContext,
  sessionId: string,
): Promise<void> {
  if (sessionId === ctx.getActiveSessionId()) {
    throw new Error('Cannot delete the active session');
  }
  await ctx.getSessionStore().delete(sessionId);
  await ctx.refreshSessions().catch(() => undefined);
}

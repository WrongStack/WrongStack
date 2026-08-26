import type { SessionStore } from '@wrongstack/core/types';

export interface SessionDeletionContext {
  getActiveSessionId: () => string;
  getActiveSessionIds?: (() => string[]) | undefined;
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
  const activeIds = ctx.getActiveSessionIds ? ctx.getActiveSessionIds() : [ctx.getActiveSessionId()];
  if (activeIds.includes(sessionId)) {
    throw new Error(`Cannot delete active session ${sessionId}`);
  }
  await ctx.getSessionStore().delete(sessionId);
  await ctx.refreshSessions().catch(() => undefined);
}

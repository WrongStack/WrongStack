import type { Logger, SessionStore } from '@wrongstack/core/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import { deleteWebUISession, type SessionDeletionContext } from './session-deletion.js';

export const DEFAULT_EMPTY_SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;
export const EMPTY_SESSION_CLEANUP_INTERVAL_ENV = 'WRONGSTACK_EMPTY_SESSION_CLEANUP_INTERVAL_MS';
const MAX_SESSION_SCAN = 1_000;

type StrictEmptySessionStore = SessionStore & {
  isEmpty?: (id: string) => Promise<boolean>;
};

export interface EmptySessionCleanupContext extends SessionDeletionContext {
  hasParticipants: (sessionId: string) => boolean;
  logger: Pick<Logger, 'info' | 'error'>;
}

/**
 * Sessions this sweep must not touch: the runtime's own, plus every session a
 * connected surface is displaying. A WebUI page holds up to four tabs, and a
 * freshly-opened one is EMPTY by definition — deleting it out from under the
 * user is exactly what an "ownerless empty session" sweep would do if it only
 * knew about the tab in front.
 */
function protectedSessionIds(ctx: EmptySessionCleanupContext): Set<string> {
  const ids = ctx.getActiveSessionIds ? ctx.getActiveSessionIds() : [ctx.getActiveSessionId()];
  return new Set(ids.filter(Boolean));
}

export interface EmptySessionCleanupResult {
  deleted: number;
  errors: number;
}

export function resolveEmptySessionCleanupInterval(
  value = process.env[EMPTY_SESSION_CLEANUP_INTERVAL_ENV],
): number {
  if (value === undefined || value.trim() === '') return DEFAULT_EMPTY_SESSION_CLEANUP_INTERVAL_MS;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1_000
    ? Math.floor(parsed)
    : DEFAULT_EMPTY_SESSION_CLEANUP_INTERVAL_MS;
}

/**
 * Delete persisted sessions that have no active owner/participant and whose
 * journals pass the store's strict, fail-closed empty check. Deletion itself is routed
 * through the same canonical operation used by the session.delete WebSocket
 * handler, preserving its active-session guard and SessionStore ownership,
 * catalog, and artifact cleanup.
 */
export async function cleanupOwnerlessEmptySessions(
  ctx: EmptySessionCleanupContext,
): Promise<EmptySessionCleanupResult> {
  const store = ctx.getSessionStore() as StrictEmptySessionStore;
  let deleted = 0;
  let errors = 0;

  let sessions;
  try {
    sessions = await store.list(MAX_SESSION_SCAN);
  } catch (error) {
    errors++;
    ctx.logger.error('Empty session cleanup failed to list sessions', {
      event: 'webui.empty_session_cleanup_error',
      phase: 'list',
      message: toErrorMessage(error),
    });
    ctx.logger.info('Empty session cleanup completed', {
      event: 'webui.empty_session_cleanup_completed',
      deleted,
      errors,
    });
    return { deleted, errors };
  }

  for (const candidate of sessions) {
    const sessionId = candidate.id;
    if (protectedSessionIds(ctx).has(sessionId) || ctx.hasParticipants(sessionId)) continue;

    try {
      // Stores without a strict persisted-journal check are not eligible for
      // destructive background cleanup. A tolerant replay can skip malformed
      // lines and would otherwise turn a damaged journal into a false "empty".
      if (!store.isEmpty || !(await store.isEmpty(sessionId))) continue;
      // Re-check the volatile guards immediately before deletion and fence the
      // operation to the same store snapshot used for candidate discovery. A
      // project switch can replace the live store while this async scan runs.
      if (
        store !== ctx.getSessionStore() ||
        protectedSessionIds(ctx).has(sessionId) ||
        ctx.hasParticipants(sessionId)
      ) {
        continue;
      }
      await deleteWebUISession(
        {
          getActiveSessionId: ctx.getActiveSessionId,
          ...(ctx.getActiveSessionIds ? { getActiveSessionIds: ctx.getActiveSessionIds } : {}),
          getSessionStore: () => store,
          refreshSessions: ctx.refreshSessions,
        },
        sessionId,
      );
      deleted++;
    } catch (error) {
      // SessionStore.delete is the final ownership/maintenance guard. A session
      // claimed after candidate selection is therefore logged and left intact.
      errors++;
      ctx.logger.error('Empty session cleanup failed for session', {
        event: 'webui.empty_session_cleanup_error',
        phase: 'delete',
        sessionId,
        message: toErrorMessage(error),
      });
    }
  }

  ctx.logger.info('Empty session cleanup completed', {
    event: 'webui.empty_session_cleanup_completed',
    deleted,
    errors,
  });
  return { deleted, errors };
}

export function scheduleOwnerlessEmptySessionCleanup(
  ctx: EmptySessionCleanupContext,
  intervalMs = resolveEmptySessionCleanupInterval(),
): { dispose: () => Promise<void>; runNow: () => Promise<EmptySessionCleanupResult> } {
  let running: Promise<EmptySessionCleanupResult> | null = null;
  const runNow = (): Promise<EmptySessionCleanupResult> => {
    if (running) return running;
    running = cleanupOwnerlessEmptySessions(ctx).finally(() => {
      running = null;
    });
    return running;
  };
  const timer = setInterval(() => void runNow(), intervalMs);
  timer.unref?.();
  return {
    dispose: async () => {
      clearInterval(timer);
      await running;
    },
    runNow,
  };
}

import type { Logger, SessionStore } from '@wrongstack/contracts/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import { deleteWebUISession, type SessionDeletionContext } from './session-deletion.js';

export const DEFAULT_EMPTY_SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;
export const EMPTY_SESSION_CLEANUP_INTERVAL_ENV = 'WRONGSTACK_EMPTY_SESSION_CLEANUP_INTERVAL_MS';
/**
 * Delay before the once-per-host startup sweep. Short enough that a host run
 * never outlives it without sweeping, long enough that a page reconnecting
 * after a host restart has re-declared its (protected) tab sessions first.
 */
const STARTUP_SWEEP_DELAY_MS = 30_000;
const MAX_SESSION_SCAN = 1_000;

type StrictEmptySessionStore = SessionStore & {
  isEmpty?: (id: string) => Promise<boolean>;
};

interface EmptySessionCleanupContext extends SessionDeletionContext {
  hasParticipants: (sessionId: string) => boolean;
  logger: Pick<Logger, 'info' | 'error'>;
  /**
   * Sessions other live hosts hold — e.g. the registry-backed current session
   * of every running surface, which is what a host WITHOUT client
   * declarations (plain TUI/CLI) can still discover. Resolved once per sweep
   * and merged into the protected set at BOTH checkpoints.
   */
  getExtraProtectedSessionIds?: () => Promise<string[]> | string[];
  /**
   * Skip candidates whose summary is younger than this. A session created
   * seconds ago in another surface may not be declared or registry-held
   * anywhere yet; an unparseable date fails closed (skip).
   */
  minIdleMs?: number;
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

interface EmptySessionCleanupResult {
  deleted: number;
  errors: number;
}

export function resolveEmptySessionCleanupInterval(
  value = process.env[EMPTY_SESSION_CLEANUP_INTERVAL_ENV],
): number {
  if (value === undefined || value.trim() === '') return DEFAULT_EMPTY_SESSION_CLEANUP_INTERVAL_MS;
  const parsed = Number(value);
  // Capped at the largest timer delay: Node turns a longer one into 1 ms, which
  // ran this destructive sweep back-to-back instead of rarely.
  return Number.isFinite(parsed) && parsed >= 1_000
    ? Math.min(Math.floor(parsed), 2_147_483_647)
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
  // Resolved once per sweep and merged into the protected set at BOTH
  // checkpoints below — discovery and the pre-delete re-check.
  let extraProtected: Set<string>;
  try {
    extraProtected = new Set((await ctx.getExtraProtectedSessionIds?.()) ?? []);
  } catch (error) {
    errors++;
    ctx.logger.error('Empty session cleanup failed to resolve protected sessions', {
      event: 'webui.empty_session_cleanup_error',
      phase: 'extra_protected',
      message: toErrorMessage(error),
    });
    ctx.logger.info('Empty session cleanup completed', {
      event: 'webui.empty_session_cleanup_completed',
      deleted,
      errors,
    });
    return { deleted, errors };
  }
  const isProtected = (sessionId: string): boolean =>
    protectedSessionIds(ctx).has(sessionId) || extraProtected.has(sessionId);

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
    if (isProtected(sessionId) || ctx.hasParticipants(sessionId)) continue;

    // A session younger than the idle floor may have been created moments
    // ago in a surface that has not declared or registered it anywhere this
    // host can see; an unparseable date proves nothing and must fail closed.
    if (ctx.minIdleMs !== undefined) {
      const startedAtMs = Date.parse(candidate.startedAt);
      if (!Number.isFinite(startedAtMs) || Date.now() - startedAtMs < ctx.minIdleMs) continue;
    }

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
        isProtected(sessionId) ||
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
      // another process (TUI, subagent, a second surface) still holds a live
      // lease on is not ownerless — the catalog refuses with an ownership
      // conflict, which is the expected outcome, not a failure. Skip it the
      // same way the catalog's own prune does; anything else is a real error.
      if ((error as Error | undefined)?.name === 'SessionOwnershipConflictError') continue;
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
  // Sweep once shortly after startup, not only on the interval. Every host
  // launch opens a session, and the common "open the UI, look, close" run
  // dies long before the first interval tick — without this sweep the empty
  // sessions each short run left behind (its own boot session, tabs the user
  // closed without typing) were never cleaned until some later run happened
  // to stay alive a full interval. When the first interval tick is already
  // due by the startup deadline, that tick serves as the startup sweep.
  const runSafe = () => {
    void runNow().catch((error) => {
      ctx.logger.error('Empty session cleanup sweep failed unexpectedly', {
        event: 'webui.empty_session_cleanup_error',
        phase: 'sweep',
        message: toErrorMessage(error),
      });
    });
  };
  const startupTimer =
    intervalMs > STARTUP_SWEEP_DELAY_MS ? setTimeout(runSafe, STARTUP_SWEEP_DELAY_MS) : undefined;
  startupTimer?.unref?.();
  const timer = setInterval(runSafe, intervalMs);
  timer.unref?.();
  return {
    dispose: async () => {
      clearTimeout(startupTimer);
      clearInterval(timer);
      await running;
    },
    runNow,
  };
}

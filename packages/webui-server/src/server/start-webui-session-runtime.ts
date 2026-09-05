import type { Context } from '@wrongstack/core/agent';
import { createSessionEventBridge, resolveSessionLoggingConfig } from '@wrongstack/core/storage';

export function stopSessionFleet(
  sessionId: string,
  stopSessionFleetHook?: ((sessionId: string) => void | Promise<void>) | undefined,
): void {
  if (!sessionId || !stopSessionFleetHook) return;
  try {
    void Promise.resolve(stopSessionFleetHook(sessionId)).catch((err) => {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'webui.stop_session_fleet_failed',
          sessionId,
          message: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        }),
      );
    });
  } catch {
    // A synchronous throw from the host hook is best-effort too.
  }
}

export function createRunLockControl(
  sessionRunLocks: Map<string, AbortController>,
  stopFleet: (sessionId: string) => void,
) {
  return {
    get: (sessionId: string): AbortController | null => sessionRunLocks.get(sessionId) ?? null,
    set: (ctrl: AbortController | null, sessionId: string) => {
      if (ctrl) sessionRunLocks.set(sessionId, ctrl);
      else sessionRunLocks.delete(sessionId);
    },
    has: (sessionId: string) => sessionRunLocks.has(sessionId),
    hasAny: () => sessionRunLocks.size > 0,
    delete: (sessionId: string) => {
      sessionRunLocks.delete(sessionId);
    },
    sessionIds: () => [...sessionRunLocks.keys()],
    abortRunLock: (sessionId?: string) => {
      if (sessionId) {
        sessionRunLocks.get(sessionId)?.abort();
        sessionRunLocks.delete(sessionId);
        stopFleet(sessionId);
        return;
      }
      const running = [...sessionRunLocks.keys()];
      for (const ctrl of sessionRunLocks.values()) ctrl.abort();
      sessionRunLocks.clear();
      for (const id of running) stopFleet(id);
    },
  };
}

export function createSessionBridgeManager(
  config: unknown,
  context: Context,
  sessionGetter: () => { id: string },
  getAgentGetter: () =>
    | ((sessionId: string) => { ctx?: { session?: any } } | undefined)
    | undefined,
) {
  const sessionLogging = resolveSessionLoggingConfig(config as any);
  const sessionBridge = createSessionEventBridge(
    () => context.session ?? sessionGetter(),
    sessionLogging.auditLevel,
    { sampling: sessionLogging.sampling },
  );

  const sessionBridges = new Map<string, ReturnType<typeof createSessionEventBridge>>();
  const bridgeForSession = (sessionId: string) => {
    if (!sessionId) return undefined;
    const existing = sessionBridges.get(sessionId);
    if (existing) return existing;
    const getAgent = getAgentGetter();
    const agent = getAgent?.(sessionId);
    const writer = agent?.ctx?.session;
    if (!writer) return undefined;
    const bridge = createSessionEventBridge(
      () => getAgentGetter()?.(sessionId)?.ctx?.session,
      sessionLogging.auditLevel,
      { sampling: sessionLogging.sampling },
    );
    if (sessionBridges.size >= 16) sessionBridges.clear();
    sessionBridges.set(sessionId, bridge);
    return bridge;
  };

  return { sessionBridge, bridgeForSession };
}

import type { Context } from '@wrongstack/core/agent';
import type { SessionEventBridge } from '@wrongstack/core/storage';

export interface SetupEventSessionHelperOptions {
  /**
   * Resolve an audit bridge bound to ONE session's writer.
   *
   * Without it, audit events can only be appended for the session the runtime
   * is currently on, and a background tab's tool/error history is dropped —
   * the tab keeps working, but resuming it later shows a run with no tool
   * record. Hosts that can address a session's writer (the WebUI, via its
   * per-session agent registry) pass this so every tab journals its own work.
   */
  bridgeForSession?: ((sessionId: string) => SessionEventBridge | undefined) | undefined;
}

export function createSetupEventSessionHelpers(
  context: Context,
  sessionBridge: SessionEventBridge | undefined,
  options: SetupEventSessionHelperOptions = {},
) {
  const currentSessionId = (): string => context.session?.id ?? '';
  const sessionPayload = <T extends Record<string, unknown>>(
    payload: T,
  ): T & { sessionId: string } => {
    const provided = payload['sessionId'];
    const sessionId =
      typeof provided === 'string' && provided.length > 0 ? provided : currentSessionId();
    return { ...payload, sessionId };
  };
  const isCurrentSession = (sessionId?: string | undefined): boolean => {
    const current = currentSessionId();
    return !sessionId || !current || sessionId === current;
  };

  /**
   * Append an audit event to the journal of the session it belongs to.
   *
   * The name is historical: this used to SKIP anything that was not the
   * runtime's current session, which quietly discarded every background tab's
   * tool and error history. It now routes to that session's own bridge when
   * the host can supply one, and only falls back to the current-session bridge
   * for events the host cannot address.
   */
  const appendForCurrentSession = (
    sessionId: string | undefined,
    event: Parameters<SessionEventBridge['append']>[0],
  ): void => {
    const scoped =
      sessionId && !isCurrentSession(sessionId) ? options.bridgeForSession?.(sessionId) : undefined;
    const bridge = scoped ?? (isCurrentSession(sessionId) ? sessionBridge : undefined);
    bridge?.append(event).catch(() => {
      /* best-effort */
    });
  };

  return { currentSessionId, sessionPayload, appendForCurrentSession };
}

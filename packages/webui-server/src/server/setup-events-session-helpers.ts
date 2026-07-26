import type { Context } from '@wrongstack/core/agent';
import type { SessionEventBridge } from '@wrongstack/core/storage';

export function createSetupEventSessionHelpers(
  context: Context,
  sessionBridge: SessionEventBridge | undefined,
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
  const appendForCurrentSession = (
    sessionId: string | undefined,
    event: Parameters<SessionEventBridge['append']>[0],
  ): void => {
    if (!isCurrentSession(sessionId)) return;
    sessionBridge?.append(event).catch(() => {
      /* best-effort */
    });
  };

  return { currentSessionId, sessionPayload, appendForCurrentSession };
}

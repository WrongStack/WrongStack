import { request } from './platform';
import { recordedSessionId } from './session-reconnect-model';

/** Journal pages read while looking for the recorded session (it is among the first frames). */
const IDENTITY_PAGES = 5;

type HostRequest = <T>(method: string, params: Record<string, unknown>) => Promise<T>;

/** Thrown when a conversation never recorded a session, so there is nothing to resume. */
export class NoRecordedSession extends Error {}

/**
 * Starts a stopped conversation's engine again on the same conversation: it reads the
 * WrongStack session its journal recorded and asks the native host to resume it there.
 */
export async function reconnectConversation(id: string, host: HostRequest = request) {
  let offset = 0;
  let sessionId: string | undefined;
  for (let page = 0; page < IDENTITY_PAGES && !sessionId; page += 1) {
    const result = await host<{ offset: number; events: unknown[]; hasMore?: boolean }>(
      'engine.events',
      { id, offset },
    );
    sessionId = recordedSessionId(result.events as { type?: unknown; payload?: unknown }[]);
    if (!result.hasMore || result.offset === offset) break;
    offset = result.offset;
  }
  if (!sessionId) throw new NoRecordedSession(id);
  await host('session.reconnect', { id, history: { id: sessionId, mode: 'resume' } });
}

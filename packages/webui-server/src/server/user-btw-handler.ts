import { randomUUID } from 'node:crypto';
import {
  type Context,
  pendingUserBtwInstructions,
  setUserBtwInstruction,
} from '@wrongstack/core/agent';
import type { WSClientMessage } from './types.js';
import { errMessage } from './ws-utils.js';

/** Authenticated conversation input, deliberately separate from untrusted peer mail. */
export function handleUserBtw(
  msg: WSClientMessage,
  options: {
    sessionId: string;
    context: Context;
    running: boolean;
    reply: (message: { type: string; payload: unknown }) => void;
  },
): void {
  const { sessionId, context, running, reply } = options;
  const payload =
    msg.payload && typeof msg.payload === 'object' && !Array.isArray(msg.payload)
      ? (msg.payload as Record<string, unknown>)
      : {};
  const requestId = typeof payload['requestId'] === 'string' ? payload['requestId'] : undefined;
  const respond = (fields: Record<string, unknown>) =>
    reply({
      type: 'btw.state',
      payload: { sessionId, requestId, ...fields },
    });
  try {
    if (!sessionId || context.session.id !== sessionId)
      throw Error('The requested leader session is not ready.');
    let id: string | undefined;
    if (msg.type === 'btw.add') {
      const text = typeof payload['text'] === 'string' ? payload['text'].trim() : '';
      if (!text || Buffer.byteLength(text, 'utf8') > 64 * 1024)
        throw Error('A BTW instruction must contain 1–65536 bytes of text.');
      if (!running)
        throw Error('The run has already ended. Send this instruction as a normal message.');
      id = `btw:${randomUUID()}`;
      setUserBtwInstruction(context, id, text);
    }
    respond({ success: true, ...(id ? { id } : {}), items: pendingUserBtwInstructions(context) });
  } catch (error) {
    respond({ success: false, error: errMessage(error) });
  }
}

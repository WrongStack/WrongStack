import type { WebSocket } from 'ws';
import { withRequestId } from './ws-utils.js';

/** Correlate direct operation replies without stamping unrelated broadcasts on the socket. */
export function correlatedReply(ws: WebSocket, payload: unknown, types: readonly string[]) {
  const requestId = withRequestId(payload, {}).requestId;
  let replied = false;
  const socket = requestId
    ? new Proxy(ws, {
        get(target, key) {
          if (key === 'send')
            return (...args: unknown[]) => {
              if (typeof args[0] === 'string') {
                try {
                  const frame = JSON.parse(args[0]) as {
                    type?: unknown;
                    payload?: unknown;
                  } | null;
                  if (
                    frame &&
                    typeof frame === 'object' &&
                    !Array.isArray(frame) &&
                    typeof frame.type === 'string' &&
                    types.includes(frame.type)
                  ) {
                    const existingPayload =
                      frame.payload &&
                      typeof frame.payload === 'object' &&
                      !Array.isArray(frame.payload)
                        ? (frame.payload as Record<string, unknown>)
                        : {};
                    frame.payload = { ...existingPayload, requestId };
                    args[0] = JSON.stringify(frame);
                    replied = true;
                  }
                } catch {
                  /* pass through non-JSON frames */
                }
              }
              return Reflect.apply(target.send, target, args);
            };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      })
    : ws;
  return {
    socket,
    get replied() {
      return replied;
    },
    requestId,
  };
}

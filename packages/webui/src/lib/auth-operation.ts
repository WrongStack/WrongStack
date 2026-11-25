import { safeId } from '@/lib/utils';
import type { WSClientMessage } from '@/types';
import type { WrongStackWebSocketClient } from './ws-client';

/** A matching server acknowledgment, never an unrelated operation result. */
export function requestAuthOperation(
  client: WrongStackWebSocketClient,
  message: WSClientMessage,
  signal: AbortSignal,
  onTimeout: () => void,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const requestId = safeId();
    let settled = false;
    let off: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (success: boolean) => {
      if (settled) return;
      settled = true;
      off?.();
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve(success);
    };
    const abort = () => finish(false);
    off = client.on('key.operation_result', (frame) => {
      if (frame.type !== 'key.operation_result') return;
      const payload = frame.payload as { requestId?: string; success?: boolean } | null | undefined;
      if (!payload || typeof payload !== 'object') return;
      if (payload.requestId === requestId) finish(payload.success === true);
    });
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => {
      onTimeout();
      finish(false);
    }, 8000);
    try {
      const outbound = {
        ...message,
        payload: { ...(('payload' in message ? message.payload : {}) as object), requestId },
      } as WSClientMessage;
      if (!client.send(outbound)) {
        onTimeout();
        finish(false);
      }
    } catch {
      onTimeout();
      finish(false);
    }
  });
}

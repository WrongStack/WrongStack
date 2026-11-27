import { safeId } from '@/lib/utils';
import type { WSClientMessage } from '@/types';
import type { WrongStackWebSocketClient } from './ws-client';

/**
 * How long to wait for the `key.operation_result` of an operation that saves
 * the profile config.
 *
 * `key.add` / `key.update` / provider mutations answer only after writing the
 * profile config, and that write waits up to 15 s for the file lock when
 * another writer (another engine, the CLI, a desktop instance on the same
 * home) holds it. An 8 s deadline reported "No response from the server"
 * while the real answer was still on its way — the same failure the model
 * switch had (#448). Keep this above the lock wait.
 */
const CONFIG_WRITE_OPERATION_TIMEOUT_MS = 45_000;

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
    }, CONFIG_WRITE_OPERATION_TIMEOUT_MS);
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

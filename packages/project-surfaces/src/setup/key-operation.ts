import type { ProviderClient } from '../providers/provider-host';

/** Waits for the engine's answer to a key or provider save; rejects with `timeout`. */
export function waitForKeyOperationResult(
  ws: Pick<ProviderClient, 'on'>,
  timeoutMs = 8000,
  signal?: AbortSignal,
): Promise<{ success: boolean; message: string }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      off();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      off();
      reject(new Error('timeout'));
    }, timeoutMs);
    const off = ws.on('key.operation_result', (msg) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      off();
      resolve((msg as { payload: { success: boolean; message: string } }).payload);
    });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

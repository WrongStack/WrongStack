import type { ProviderClient } from '../providers/provider-host';

/** Waits for the engine's answer to a key or provider save; rejects with `timeout`. */
export function waitForKeyOperationResult(
  ws: Pick<ProviderClient, 'on'>,
  timeoutMs = 8000,
): Promise<{ success: boolean; message: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error('timeout'));
    }, timeoutMs);
    const off = ws.on('key.operation_result', (msg) => {
      clearTimeout(timer);
      off();
      resolve((msg as { payload: { success: boolean; message: string } }).payload);
    });
  });
}

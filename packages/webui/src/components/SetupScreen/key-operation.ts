import type { WSServerMessage } from '@/types';
import type { getWSClient } from '@/lib/ws-client';

export function waitForKeyOperationResult(
  ws: ReturnType<typeof getWSClient>,
  timeoutMs = 8000,
): Promise<{ success: boolean; message: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error('timeout'));
    }, timeoutMs);
    const off = ws.on('key.operation_result', (msg: WSServerMessage) => {
      clearTimeout(timer);
      off();
      resolve((msg as { payload: { success: boolean; message: string } }).payload);
    });
  });
}

import { safeId } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';

export interface PortableCommandRpcResult {
  message?: string | undefined;
  error?: string | undefined;
  runText?: string | undefined;
}

/**
 * Invoke a portable engine command (`command.run` -> `command.result`) over the
 * active WebSocket with deterministic listener cleanup.
 */
export function invokePortableCommand(
  name: string,
  args: string,
  opts?: {
    sessionId?: string | null | undefined;
    timeoutMs?: number | undefined;
    queueIfDisconnected?: boolean | undefined;
    signal?: AbortSignal | undefined;
  },
): Promise<PortableCommandRpcResult> {
  if (opts?.signal?.aborted) return Promise.resolve({ error: 'Command request cancelled.' });
  const client = getWSClient();
  const requestId = safeId();
  const timeoutMs = opts?.timeoutMs ?? 8_000;

  return new Promise<PortableCommandRpcResult>((resolve) => {
    let settled = false;
    const finish = (res: PortableCommandRpcResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off();
      opts?.signal?.removeEventListener('abort', cancel);
      resolve(res);
    };

    const off = client.on('command.result', (msg) => {
      if (msg.payload.requestId !== requestId) return;
      finish({
        message: msg.payload.message,
        error: msg.payload.error,
        runText: msg.payload.runText,
      });
    });

    const timer = setTimeout(() => {
      finish({ error: `Timed out waiting for /${name} response.` });
    }, timeoutMs);
    const cancel = () => finish({ error: 'Command request cancelled.' });
    opts?.signal?.addEventListener('abort', cancel, { once: true });
    if (opts?.signal?.aborted) {
      cancel();
      return;
    }

    const basePayload = { name, args, requestId };
    const payload = opts?.sessionId
      ? { ...basePayload, sessionId: opts.sessionId }
      : client.withSession(basePayload);

    const sent = client.send(
      {
        type: 'command.run',
        payload,
      },
      { queueIfDisconnected: opts?.queueIfDisconnected },
    );
    if (!sent && opts?.queueIfDisconnected === false) finish({ error: 'WebSocket not connected.' });
  });
}

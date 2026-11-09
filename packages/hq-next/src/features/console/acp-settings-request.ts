import type {
  AcpRuntimeOptionsResult,
  AcpRuntimeValues,
} from '@wrongstack/contracts/types/acp-runtime';
import { postCommand } from '../../hq/data/api';
import { useHqStore } from '../../hq/data/store/index';

export async function requestAcpSettings(
  clientId: string,
  sessionId: string,
  agentId: string,
  change?: { values: AcpRuntimeValues; expected: AcpRuntimeValues },
  signal?: AbortSignal,
): Promise<AcpRuntimeOptionsResult> {
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  const { commandId } = await postCommand(clientId, 'acp-config', {
    sessionId,
    agentId,
    action: change ? 'set' : 'inspect',
    ...change,
  });
  return new Promise((resolve, reject) => {
    let off = () => {};
    const finish = (error?: Error, result?: AcpRuntimeOptionsResult) => {
      clearTimeout(timer);
      off();
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(result!);
    };
    const abort = () => finish(new DOMException('Cancelled', 'AbortError'));
    const timer = setTimeout(
      () =>
        finish(
          Error(
            'No acknowledgement yet. Refresh before retrying; the remote command may still finish.',
          ),
        ),
      100_000,
    );
    const check = () => {
      const entry = useHqStore
        .getState()
        .commandStatuses.find((x) => x.commandId === commandId && x.clientId === clientId);
      if (entry?.status !== 'acked') return;
      if (
        entry.ackStatus !== 'completed' ||
        !entry.acpConfig ||
        entry.acpConfig.agentId !== agentId
      )
        finish(Error(entry.ackMessage ?? 'The client did not return confirmed ACP settings.'));
      else finish(undefined, entry.acpConfig);
    };
    off = useHqStore.subscribe(check);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else check();
  });
}

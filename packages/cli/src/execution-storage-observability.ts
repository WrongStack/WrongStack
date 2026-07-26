import type { EventBus } from '@wrongstack/core/kernel';

export function installStorageObservability(
  events: EventBus,
  rootTraceId: string | undefined,
): () => void {
  const storageLog = (event: string, payload: Record<string, unknown>) => {
    const traceId = (payload.traceId as string | undefined) ?? rootTraceId;
    // eslint-disable-next-line no-console
    console.warn(
      JSON.stringify({
        level: 'info',
        event,
        timestamp: new Date().toISOString(),
        traceId,
        ...payload,
      }),
    );
  };
  const onStorageRead = (...args: unknown[]) =>
    storageLog('storage.read', args[0] as Record<string, unknown>);
  const onStorageWrite = (...args: unknown[]) =>
    storageLog('storage.write', args[0] as Record<string, unknown>);
  const onStorageError = (...args: unknown[]) =>
    storageLog('storage.error', args[0] as Record<string, unknown>);
  const offStorageRead = events.on('storage.read', onStorageRead);
  const offStorageWrite = events.on('storage.write', onStorageWrite);
  const offStorageError = events.on('storage.error', onStorageError);
  return () => {
    offStorageRead();
    offStorageWrite();
    offStorageError();
  };
}

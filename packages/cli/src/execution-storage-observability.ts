import type { EventBus } from '@wrongstack/core/kernel';

export function installStorageObservability(
  events: EventBus,
  rootTraceId: string | undefined,
): () => void {
  const isStorageNamespace = (event: string): boolean =>
    event === 'storage.read' ||
    event === 'storage.write' ||
    event === 'storage.error' ||
    event.startsWith('storage.');
  const storageLog = (event: string, payload: Record<string, unknown>) => {
    // `storage.*` events are routine atomic-write telemetry (e.g. the
    // ctx.todos checkpoint at packages/core/src/storage/todos-checkpoint.ts
    // emitting a JSON line on every save). Successful reads/writes
    // (`outcome: 'success'`) are not user-actionable signals and would
    // clutter the CLI's stdout chat pane (the SimpleUI protocol decoder
    // also rejects these frames before they reach the timeline; see
    // packages/webui-server/src/protocol/decoder.ts).
    //
    // However, failure paths must NOT be silently swallowed here. Many
    // emitters publish failure telemetry only on `storage.error` (and
    // some on `storage.read`/`storage.write` with `outcome: 'failure'`)
    // — they do not consistently publish a duplicate `agent.error` or
    // `error` event. Hiding them on this filter would lose non-fatal
    // but user-actionable diagnostics (e.g. project-manifest write
    // failures in plan-store.ts, audit-log record failures in
    // tool-audit-log.ts). So we keep three exception channels:
    //   1. `storage.error` — always surface (warning level).
    //   2. `storage.read` / `storage.write` carrying `outcome: 'failure'`.
    //   3. Any other `storage.<token>` whose payload reports a failure.
    // Everything else in the `storage.*` namespace (successful routine
    // telemetry) is dropped so the terminal stays clean.
    //
    // Prefix-boundary check: explicit equality for the three known
    // kinds, then a dot-anchored prefix for any future `storage.<token>`
    // the host may add. `startsWith('storage.')` alone would also match
    // `storagex.write` (a typosquat), so the dot anchor pins the
    // namespace exactly.
    if (isStorageNamespace(event)) {
      const outcome = payload.outcome;
      const isErrorEvent = event === 'storage.error';
      const reportsFailure = outcome === 'failure' || outcome === 'error';
      const isFailure = isErrorEvent || reportsFailure;
      if (!isFailure) {
        return;
      }
      const traceId = (payload.traceId as string | undefined) ?? rootTraceId;
      // eslint-disable-next-line no-console
      console.warn(
        JSON.stringify({
          ...payload,
          level: 'warning',
          event,
          timestamp: new Date().toISOString(),
          traceId,
        }),
      );
      return;
    }
    const traceId = (payload.traceId as string | undefined) ?? rootTraceId;
    // eslint-disable-next-line no-console
    console.warn(
      JSON.stringify({
        ...payload,
        level: 'info',
        event,
        timestamp: new Date().toISOString(),
        traceId,
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

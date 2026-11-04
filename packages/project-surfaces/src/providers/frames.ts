import { type QuotaSnapshot, useProviderQuotaStore } from './provider-quota-store';

/**
 * `provider.quota` — a metered provider reported how much of its plan is spent. Pushed after
 * every metered response and replayed on `provider.quota.get`; both carry the same `snapshots`
 * array. `refreshed` is present only on the reply to this client's own `provider.quota.refresh`.
 */
export function applyQuotaFrame(payload: unknown): void {
  const frame = (payload ?? {}) as { snapshots?: unknown; refreshed?: unknown };
  if (!Array.isArray(frame.snapshots)) return;
  const store = useProviderQuotaStore.getState();
  store.apply(frame.snapshots as QuotaSnapshot[]);
  if (Array.isArray(frame.refreshed)) store.applyRefreshes(frame.refreshed);
}

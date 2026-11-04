/**
 * The live quota feed behind the side-panel section and the Plan Quota page:
 * the saved providers (so a configured vendor has a card before its first
 * reading), a replay of the server's readings, and the on-demand account
 * reads (`provider.quota.refresh`) — on mount, every few minutes while
 * mounted, and on the refresh button. The server throttles the reads, so two
 * surfaces mounted at once cost nothing extra.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useProviderHost } from './feed';
import { useProviderQuotaStore } from './provider-quota-store';
import { buildQuotaCards, type QuotaCard, type SavedProviderLite } from './quota-model';

/** How often a mounted surface re-reads the account-endpoint vendors. */
const AUTO_REFRESH_MS = 5 * 60_000;
/** Re-render cadence for countdowns and "as of" ages. */
const TICK_MS = 30_000;

export interface QuotaFeed {
  cards: QuotaCard[];
  now: number;
  refreshing: boolean;
  refresh: () => void;
  wsConnected: boolean;
}

export function useQuotaFeed(): QuotaFeed {
  const host = useProviderHost();
  const client = host.useClient();
  const wsConnected = host.useConnected();
  const metersByKey = useProviderQuotaStore((s) => s.meters);
  const refreshes = useProviderQuotaStore((s) => s.refreshes);
  const [saved, setSaved] = useState<SavedProviderLite[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const refreshTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refresh = () => {
    if (!client) return;
    setRefreshing(true);
    clearTimeout(refreshTimeout.current);
    // The reply clears it; the timeout only covers a reply that never comes.
    refreshTimeout.current = setTimeout(() => setRefreshing(false), 15_000);
    client.send({ type: 'provider.quota.refresh' });
  };

  // A reply to our refresh lands as new outcomes in the store.
  useEffect(() => {
    setRefreshing(false);
    clearTimeout(refreshTimeout.current);
  }, [refreshes]);

  useEffect(() => {
    if (!client || !wsConnected) return;
    const off = client.on('providers.saved', (message) => {
      if (message.type !== 'providers.saved') return;
      setSaved(message.payload.providers as SavedProviderLite[]);
    });
    client.send({ type: 'providers.saved' });
    client.send({ type: 'provider.quota.get' });
    refresh();
    const timer = setInterval(refresh, AUTO_REFRESH_MS);
    return () => {
      off();
      clearInterval(timer);
      clearTimeout(refreshTimeout.current);
    };
  }, [client, wsConnected]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const cards = useMemo(
    () => buildQuotaCards(metersByKey, saved, refreshes),
    [metersByKey, saved, refreshes],
  );
  return { cards, now, refreshing, refresh, wsConnected };
}

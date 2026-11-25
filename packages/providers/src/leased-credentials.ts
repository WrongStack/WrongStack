/**
 * Keys held in memory only — "lease" grants from an HQ key vault.
 *
 * A leased key is stored in the profile config like any other key entry —
 * label, auth method, `source: { kind: 'hq', …, lease: true }` — but its
 * `apiKey` is a marker, never the value. The value lives here, per process,
 * until `leaseUntil`; the host's HQ client puts it here and renews it.
 * {@link resolveActiveKey} / {@link resolveActiveKeyEntry} return a COPY of
 * the entry with the value merged in, so the value enters a provider instance
 * and nothing else: no `Config` object, on disk or live, ever holds it, and
 * every persister (which re-reads the config from disk) writes the marker.
 *
 * When a lease arrives, changes or lapses, {@link onLeasedCredentialsChanged}
 * fires and the host rebuilds the active provider; until a lease is live the
 * provider is a stand-in that fails every request with "waiting for HQ" —
 * never a key from the environment.
 */
import type { ProviderApiKey } from '@wrongstack/contracts/types';

export interface LeasedCredential {
  apiKey: string;
  tokenType?: string | undefined;
  scope?: string | undefined;
  project?: string | undefined;
  /** OAuth: when the access token expires. */
  expiresAt?: string | undefined;
  /** Epoch ms after which the lease is gone unless renewed. */
  leaseUntil: number;
}

const leases = new Map<string, LeasedCredential>();
const listeners = new Set<() => void>();
const wantListeners = new Set<(hqId: string) => void>();
let generation = 0;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;

/** The store id of a leased key: HQ, profile and key. */
export function leasedCredentialId(source: {
  hqId: string;
  profileId?: string | undefined;
  keyId: string;
}): string {
  return `${source.hqId}|${source.profileId ?? ''}|${source.keyId}`;
}

/** Whether a stored key entry is a memory-only lease. */
export function isLeasedEntry(entry: ProviderApiKey | undefined): boolean {
  return entry?.source?.kind === 'hq' && entry.source.lease === true;
}

/** The live lease for a leased entry, or undefined (not arrived, or lapsed). */
export function leasedCredential(entry: ProviderApiKey): LeasedCredential | undefined {
  if (!isLeasedEntry(entry) || !entry.source) return undefined;
  const lease = leases.get(leasedCredentialId(entry.source));
  return lease && lease.leaseUntil > Date.now() ? lease : undefined;
}

/** A copy of `entry` carrying its leased value, or undefined without a live lease. */
export function withLeasedValue(entry: ProviderApiKey): ProviderApiKey | undefined {
  const lease = leasedCredential(entry);
  if (!lease) return undefined;
  return {
    ...entry,
    apiKey: lease.apiKey,
    ...(lease.tokenType ? { tokenType: lease.tokenType } : {}),
    ...(lease.scope ? { scope: lease.scope } : {}),
    ...(lease.project ? { project: lease.project } : {}),
    ...(lease.expiresAt ? { expiresAt: lease.expiresAt } : {}),
  };
}

/** What a provider was built from; a renewal that only extends `leaseUntil` is no change. */
function material(lease: LeasedCredential | undefined): string {
  if (!lease) return '';
  const { leaseUntil: _until, ...rest } = lease;
  return JSON.stringify(rest);
}

/**
 * Replace the leases one HQ holds for this process — all of them, or only
 * those of `profileIds` (a partial fetch). Listeners hear about it when a
 * value appeared, changed or went away.
 */
export function setLeasedCredentials(
  hqId: string,
  entries: Iterable<[id: string, lease: LeasedCredential]>,
  scope: { profileIds?: readonly string[] | undefined } = {},
): void {
  const prefix = `${hqId}|`;
  const inScope = (id: string) =>
    id.startsWith(prefix) &&
    (!scope.profileIds || scope.profileIds.includes(id.slice(prefix.length).split('|')[0]!));
  const now = Date.now();
  const inScopeIds = [...leases.keys()].filter(inScope);
  const before = new Map<string, LeasedCredential>();
  for (const id of inScopeIds) {
    const existing = leases.get(id);
    leases.delete(id);
    if (existing && existing.leaseUntil > now) before.set(id, existing);
  }
  for (const [id, lease] of entries) {
    if (inScope(id) && lease.leaseUntil > now) leases.set(id, lease);
  }
  const ids = new Set([...before.keys(), ...[...leases.keys()].filter(inScope)]);
  const changed = [...ids].some((id) => material(before.get(id)) !== material(leases.get(id)));
  scheduleExpiry();
  if (changed) notify();
}

/** Grows whenever the set of usable leased values changes. */
export function leasedCredentialsGeneration(): number {
  return generation;
}

/** Hear when a leased value appears, changes or lapses (rebuild the provider). */
export function onLeasedCredentialsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Hear when something needs a lease this process does not hold — a provider
 * about to send a request. The host's HQ client fetches then, so a process
 * that never uses a leased key never asks HQ for one.
 */
export function onLeaseWanted(listener: (hqId: string) => void): () => void {
  wantListeners.add(listener);
  return () => wantListeners.delete(listener);
}

/**
 * Ask for `entry`'s lease and wait (at most `timeoutMs`, or until `signal`
 * aborts) for it to arrive. True when it is live.
 */
export function waitForLease(
  entry: ProviderApiKey,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (leasedCredential(entry)) return Promise.resolve(true);
  const hqId = entry.source?.kind === 'hq' ? entry.source.hqId : undefined;
  return new Promise((resolve) => {
    const finish = (live: boolean) => {
      clearTimeout(timer);
      off();
      signal?.removeEventListener('abort', onAbort);
      resolve(live);
    };
    const onAbort = () => finish(false);
    const off = onLeasedCredentialsChanged(() => {
      if (leasedCredential(entry)) finish(true);
    });
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (hqId) {
      for (const listener of wantListeners) {
        try {
          listener(hqId);
        } catch {
          // A listener reports its own failures.
        }
      }
    }
  });
}

function notify(): void {
  generation += 1;
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A listener reports its own failures.
    }
  }
}

/** Drop lapsed leases when the first one runs out, so providers stop using them. */
function scheduleExpiry(): void {
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = undefined;
  if (leases.size === 0) return;
  const next = Math.min(...[...leases.values()].map((l) => l.leaseUntil));
  expiryTimer = setTimeout(
    () => {
      const now = Date.now();
      let lapsed = false;
      for (const [id, lease] of leases) {
        if (lease.leaseUntil <= now) {
          leases.delete(id);
          lapsed = true;
        }
      }
      scheduleExpiry();
      if (lapsed) notify();
    },
    Math.max(0, Math.min(next - Date.now(), 2 ** 31 - 1)),
  );
  expiryTimer.unref?.();
}

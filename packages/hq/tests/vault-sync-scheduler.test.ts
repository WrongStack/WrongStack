/**
 * The device's background sync scheduler and the publisher's hand-off of
 * `hq.vault_changed`: notices for another HQ or an old revision are ignored,
 * a burst costs one sync, a newer notice during a sync runs another, a
 * verified revocation stops the scheduler, and the publisher delivers the
 * notice whatever project it serves.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deliverHqServerMessage, parseHqServerMessage } from '../src/publisher-server-message.js';
import type { HqImportReport } from '../src/vault/device-service.js';
import { HqVaultDeviceRevokedError } from '../src/vault/device-service.js';
import type { HqDeviceRecord } from '../src/vault/device-store.js';
import { HqVaultSyncScheduler } from '../src/vault/device-sync.js';
import { onHqVaultNotice } from '../src/vault/notice-bus.js';

const HQ = 'a'.repeat(32);

function emptyReport(): HqImportReport {
  return { added: [], updated: [], removed: [], unchanged: [], renamed: [] };
}

/** A fake service: `sync` records the revision HQ is at (`hqRevision`). */
function fakeService(options: { synced?: number; status?: HqDeviceRecord['status'] } = {}) {
  const state = {
    synced: options.synced,
    hqRevision: 0,
    status: options.status ?? ('approved' as HqDeviceRecord['status']),
    syncs: 0,
    gate: undefined as Promise<void> | undefined,
    fail: undefined as Error | undefined,
    leaseProfileIds: undefined as string[] | undefined,
    leaseFetches: 0,
    leaseFail: undefined as Error | undefined,
    leaseRenewIn: 40,
  };
  const service = {
    device: async () =>
      ({
        hq: { hqId: HQ },
        status: state.status,
        ...(state.synced !== undefined ? { syncedRevision: state.synced } : {}),
        ...(state.leaseProfileIds ? { leaseProfileIds: state.leaseProfileIds } : {}),
      }) as HqDeviceRecord,
    refreshLeases: async () => {
      state.leaseFetches++;
      if (state.leaseFail) throw state.leaseFail;
      return Date.now() + state.leaseRenewIn;
    },
    nextLeaseRenewal: () => undefined,
    revision: async () => ({ hqId: HQ, revision: state.hqRevision }),
    sync: async () => {
      state.syncs++;
      const at = state.hqRevision;
      await state.gate;
      if (state.fail) throw state.fail;
      state.synced = at;
      return { ...emptyReport(), updated: [{ providerId: 'p', profileId: 'p' }] };
    },
  };
  return { state, service };
}

const schedulers: HqVaultSyncScheduler[] = [];
function scheduler(service: ReturnType<typeof fakeService>['service'], extra = {}) {
  const s = new HqVaultSyncScheduler({ service, jitterMs: 0, ...extra });
  schedulers.push(s);
  return s;
}

afterEach(() => {
  for (const s of schedulers.splice(0)) s.stop();
});

describe('HqVaultSyncScheduler', () => {
  it('ignores a notice for another HQ, an old revision, or a revoked device', async () => {
    const { state, service } = fakeService({ synced: 5 });
    const s = scheduler(service);
    s.notice({ hqId: 'b'.repeat(32), revision: 9 });
    s.notice({ hqId: HQ, revision: 5 });
    await new Promise((r) => setTimeout(r, 20));
    expect(state.syncs).toBe(0);

    state.status = 'revoked';
    s.notice({ hqId: HQ, revision: 9 });
    await new Promise((r) => setTimeout(r, 20));
    expect(state.syncs).toBe(0);
  });

  it('a burst of notices costs one sync; a newer one during the sync runs another', async () => {
    const { state, service } = fakeService({ synced: 1 });
    const synced = vi.fn();
    const s = scheduler(service, { onSynced: synced });
    let release!: () => void;
    state.gate = new Promise<void>((r) => {
      release = r;
    });
    state.hqRevision = 2;
    for (let i = 0; i < 4; i++) s.notice({ hqId: HQ, revision: 2 });
    await vi.waitFor(() => expect(state.syncs).toBe(1));

    // HQ moves on while the first sync is still in flight.
    state.hqRevision = 3;
    s.notice({ hqId: HQ, revision: 3 });
    await new Promise((r) => setTimeout(r, 20));
    state.gate = undefined;
    release();
    await vi.waitFor(() => expect(state.synced).toBe(3));
    expect(state.syncs).toBe(2);
    expect(synced).toHaveBeenCalledTimes(2);
  });

  it('polls the revision and syncs only when it moved; a revocation stops it', async () => {
    const { state, service } = fakeService({ synced: 4 });
    const warn = vi.fn();
    const s = scheduler(service, { warn });
    state.hqRevision = 4;
    await s.poll();
    expect(state.syncs).toBe(0);

    state.hqRevision = 6;
    state.fail = new HqVaultDeviceRevokedError('http://hq', []);
    await s.poll();
    expect(state.syncs).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('revoked this machine'));

    // Stopped: later notices do nothing.
    state.fail = undefined;
    s.notice({ hqId: HQ, revision: 7 });
    await new Promise((r) => setTimeout(r, 20));
    expect(state.syncs).toBe(1);
  });

  it('says an unreachable HQ once per streak, not on every poll', async () => {
    const { service } = fakeService({ synced: 0 });
    const warn = vi.fn();
    const s = scheduler(
      { ...service, revision: async () => Promise.reject(new Error('ECONNREFUSED')) },
      { warn },
    );
    await s.poll();
    await s.poll();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('lease renewal', () => {
  it('a process holding leases fetches them at start and renews them on time', async () => {
    const { state, service } = fakeService({ synced: 0 });
    state.leaseProfileIds = ['team'];
    scheduler(service, { firstPollMs: 60_000 }).start();
    await vi.waitFor(() => expect(state.leaseFetches).toBeGreaterThanOrEqual(1));
    await vi.waitFor(() => expect(state.leaseFetches).toBeGreaterThanOrEqual(3));
  });

  it('on demand: nothing at start; a want for this HQ fetches once, one for another HQ nothing', async () => {
    const { state, service } = fakeService({ synced: 0 });
    state.leaseProfileIds = ['team'];
    state.leaseRenewIn = 60_000;
    let want: ((hqId: string) => void) | undefined;
    const unsubscribe = vi.fn();
    scheduler(service, {
      firstPollMs: 60_000,
      onLeaseWanted: (listener: (hqId: string) => void) => {
        want = listener;
        return unsubscribe;
      },
    }).start();
    await new Promise((r) => setTimeout(r, 30));
    expect(state.leaseFetches).toBe(0);

    want?.('b'.repeat(32));
    await new Promise((r) => setTimeout(r, 30));
    expect(state.leaseFetches).toBe(0);

    for (let i = 0; i < 3; i++) want?.(HQ);
    await vi.waitFor(() => expect(state.leaseFetches).toBe(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(state.leaseFetches).toBe(1);
  });

  it('a machine without leases fetches nothing at start', async () => {
    const { state, service } = fakeService({ synced: 0 });
    scheduler(service, { firstPollMs: 60_000 }).start();
    await new Promise((r) => setTimeout(r, 50));
    expect(state.leaseFetches).toBe(0);
  });

  it('a failed renewal is said once and retried later; a revocation stops it', async () => {
    const { state, service } = fakeService({ synced: 0 });
    state.leaseProfileIds = ['team'];
    state.leaseFail = new Error('ECONNREFUSED');
    const warn = vi.fn();
    const s = scheduler(service, { firstPollMs: 60_000, warn });
    await s.renewLeases();
    await s.renewLeases();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('HQ lease renewal failed'));

    state.leaseFail = new HqVaultDeviceRevokedError('http://hq', []);
    await s.renewLeases();
    const fetches = state.leaseFetches;
    await s.renewLeases(); // stopped
    expect(state.leaseFetches).toBe(fetches);
  });
});

describe('publisher hand-off of hq.vault_changed', () => {
  it('parses the notice for any project, rejects a malformed one, and delivers it', async () => {
    const frame = (payload: unknown) => ({
      data: JSON.stringify({ type: 'hq.vault_changed', payload }),
    });
    const parsed = parseHqServerMessage(frame({ hqId: HQ, revision: 3 }), 'some-project');
    expect(parsed).toEqual({ type: 'hq.vault_changed', payload: { hqId: HQ, revision: 3 } });
    expect(parseHqServerMessage(frame({ hqId: HQ, revision: -1 }), 'p')).toBeNull();
    expect(parseHqServerMessage(frame({ hqId: 'not hex', revision: 1 }), 'p')).toBeNull();

    const seen: unknown[] = [];
    const off = onHqVaultNotice((notice) => seen.push(notice));
    try {
      await deliverHqServerMessage(parsed as never, {});
    } finally {
      off();
    }
    expect(seen).toEqual([{ hqId: HQ, revision: 3 }]);
  });
});

/**
 * The wire contract: frames in, store actions out — plus the refresh gate.
 *
 * The gate is the part worth pinning. `hq.resume_reject` must (a) drop the
 * resume cursors and (b) cause EXACTLY ONE `/api/snapshot` fetch per
 * reconnect. Two historical bugs live here: a second subscriber firing under
 * StrictMode used to queue a duplicate fetch, and gating on
 * `snapshot.generatedAt` used to re-arm itself from its own response, looping
 * forever.
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchJson = vi.fn<(path: string) => Promise<unknown>>();
vi.mock('../../src/data/api.js', () => ({
  fetchJson: (path: string) => fetchJson(path),
  authorizedFetch: vi.fn(),
}));

const { applySocketMessage, armSnapshotRefresh, createReconnectReauthorizer, hydrateFromHttp } =
  await import('../../src/data/wire.js');
const { useHqStore } = await import('../../src/data/store/index.js');
const { alert, commandEntry, event, peerPayload, snapshot } = await import('../fixtures/hq.js');

const INITIAL = useHqStore.getState();

beforeEach(() => {
  fetchJson.mockReset();
  useHqStore.setState({
    snapshot: null,
    events: [],
    alerts: [],
    commandStatuses: [],
    resumeCursors: {},
    needsSnapshotRefresh: false,
    peerEnvelope: null,
    connected: false,
    authRequired: false,
    selectedSessionId: null,
    selectedAgentId: null,
    selectedClientId: null,
    activeView: INITIAL.activeView,
  });
});

describe('applySocketMessage', () => {
  it('applies hq.snapshot through the shared projector', () => {
    applySocketMessage(useHqStore, { type: 'hq.snapshot', snapshot: snapshot() } as never);
    expect(useHqStore.getState().snapshot).not.toBeNull();
    expect(useHqStore.getState().connected).toBe(true);
  });

  it('applies hq.event', () => {
    applySocketMessage(useHqStore, { type: 'hq.event', event: event('e1') } as never);
    expect(useHqStore.getState().events).toHaveLength(1);
  });

  it('applies hq.alert', () => {
    applySocketMessage(useHqStore, alert() as never);
    expect(useHqStore.getState().alerts).toHaveLength(1);
  });

  it('applies hq.command_status', () => {
    applySocketMessage(useHqStore, {
      type: 'hq.command_status',
      command: commandEntry('c1'),
    } as never);
    expect(useHqStore.getState().commandStatuses).toHaveLength(1);
  });

  it('replays every envelope in an hq.resume_gap, in order', () => {
    applySocketMessage(useHqStore, {
      type: 'hq.resume_gap',
      envelopes: [event('e1', { seq: 1 }), event('e2', { seq: 2 })],
    } as never);
    expect(useHqStore.getState().events.map((entry) => entry.id)).toEqual(['e1', 'e2']);
    expect(useHqStore.getState().resumeCursors).toEqual({ 'client-1': 2 });
  });

  it('hq.resume_reject drops the cursors AND arms the refresh', () => {
    useHqStore.setState({ resumeCursors: { 'client-1': 99 } });
    applySocketMessage(useHqStore, { type: 'hq.resume_reject' } as never);
    expect(useHqStore.getState().resumeCursors).toEqual({});
    expect(useHqStore.getState().needsSnapshotRefresh).toBe(true);
  });

  it('ignores a frame type it does not know (forward compatibility)', () => {
    expect(() => applySocketMessage(useHqStore, { type: 'hq.heartbeat' } as never)).not.toThrow();
    expect(() =>
      applySocketMessage(useHqStore, { type: 'hq.some_future_frame' } as never),
    ).not.toThrow();
  });

  it('surfaces a peer envelope as a dismissible banner', () => {
    applySocketMessage(useHqStore, {
      type: 'hq.event',
      event: event('p1', { type: 'peer.lost', seq: 1, payload: peerPayload() }),
    } as never);
    expect(useHqStore.getState().peerEnvelope?.kind).toBe('peer.lost');

    useHqStore.getState().dismissPeerEnvelope();
    expect(useHqStore.getState().peerEnvelope).toBeNull();
  });
});

describe('armSnapshotRefresh', () => {
  it('fetches exactly once when the flag is raised', async () => {
    fetchJson.mockResolvedValue(snapshot());
    const unsubscribe = armSnapshotRefresh(useHqStore);

    useHqStore.getState().setNeedsSnapshotRefresh(true);
    await vi.waitFor(() => expect(fetchJson).toHaveBeenCalledTimes(1));

    expect(fetchJson).toHaveBeenCalledWith('/api/snapshot');
    expect(useHqStore.getState().snapshot).not.toBeNull();
    unsubscribe();
  });

  it('clears the flag synchronously so a re-entrant raise cannot queue a second fetch', () => {
    fetchJson.mockReturnValue(new Promise(() => undefined)); // never settles
    const unsubscribe = armSnapshotRefresh(useHqStore);

    useHqStore.getState().setNeedsSnapshotRefresh(true);
    expect(useHqStore.getState().needsSnapshotRefresh).toBe(false);

    // A second raise while the first fetch is still in flight is refused.
    useHqStore.getState().setNeedsSnapshotRefresh(true);
    expect(fetchJson).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('does not fetch when an ordinary snapshot arrives', async () => {
    // The server stamps a fresh `generatedAt` on every buildSnapshot(); a gate
    // keyed on that would re-arm from its own response and loop forever.
    const unsubscribe = armSnapshotRefresh(useHqStore);
    useHqStore.getState().applySnapshot(snapshot('2026-07-14T12:01:00.000Z'));
    useHqStore.getState().applySnapshot(snapshot('2026-07-14T12:02:00.000Z'));
    expect(fetchJson).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('survives a failing refresh and can retry on the next reconnect', async () => {
    fetchJson.mockRejectedValueOnce(new Error('offline'));
    const unsubscribe = armSnapshotRefresh(useHqStore);

    useHqStore.getState().setNeedsSnapshotRefresh(true);
    await vi.waitFor(() => expect(fetchJson).toHaveBeenCalledTimes(1));

    // The `finally` that clears the in-flight guard runs on a later tick.
    await new Promise((resolve) => setTimeout(resolve, 0));

    fetchJson.mockResolvedValueOnce(snapshot());
    useHqStore.getState().setNeedsSnapshotRefresh(true);
    await vi.waitFor(() => expect(fetchJson).toHaveBeenCalledTimes(2));
    unsubscribe();
  });
});

describe('hydrateFromHttp', () => {
  it('seeds the store from the boot request', async () => {
    fetchJson.mockResolvedValue(snapshot());
    hydrateFromHttp(useHqStore);
    await vi.waitFor(() => expect(useHqStore.getState().snapshot).not.toBeNull());
  });

  it('drops a late boot response once a live snapshot has landed', async () => {
    let resolveBoot: (value: unknown) => void = () => undefined;
    fetchJson.mockReturnValue(
      new Promise((resolve) => {
        resolveBoot = resolve;
      }),
    );
    hydrateFromHttp(useHqStore);

    useHqStore.getState().applySnapshot(snapshot('2026-07-14T12:05:00.000Z'));
    resolveBoot(snapshot('2026-07-14T12:00:00.000Z'));
    await Promise.resolve();

    expect(useHqStore.getState().snapshot?.generatedAt).toBe('2026-07-14T12:05:00.000Z');
  });

  it('swallows a boot failure — the socket owns recovery', async () => {
    fetchJson.mockRejectedValue(new Error('401'));
    expect(() => hydrateFromHttp(useHqStore)).not.toThrow();
    await Promise.resolve();
  });
});

describe('createReconnectReauthorizer', () => {
  it('re-mints the cookie when the transport starts reconnecting', async () => {
    const upgrade = vi.fn(async () => true);
    const now = 1_000;
    const reauthorize = createReconnectReauthorizer(upgrade, 30_000, () => now);

    reauthorize('connecting');
    reauthorize('connected');
    expect(upgrade).not.toHaveBeenCalled();

    reauthorize('reconnecting');
    expect(upgrade).toHaveBeenCalledTimes(1);
    await Promise.resolve(); // settle the fire-and-forget upgrade
  });

  it('throttles a reconnect burst to one attempt per interval', () => {
    const upgrade = vi.fn(async () => true);
    let now = 1_000;
    const reauthorize = createReconnectReauthorizer(upgrade, 30_000, () => now);

    reauthorize('reconnecting');
    now += 1_000;
    reauthorize('reconnecting');
    now += 10_000;
    reauthorize('reconnecting');
    expect(upgrade).toHaveBeenCalledTimes(1);

    now += 30_000;
    reauthorize('reconnecting');
    expect(upgrade).toHaveBeenCalledTimes(2);
  });

  it('survives a failing upgrade — a dead token must not break the transport', async () => {
    const upgrade = vi.fn(async () => {
      throw new Error('network down');
    });
    const reauthorize = createReconnectReauthorizer(upgrade, 30_000, () => 0);
    expect(() => reauthorize('reconnecting')).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });
});

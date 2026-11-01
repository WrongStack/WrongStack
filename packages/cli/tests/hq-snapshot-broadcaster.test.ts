import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSnapshotBroadcaster } from '../src/hq-server/snapshot.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('HQ snapshot broadcaster shutdown', () => {
  it('ignores late socket broadcasts after close', () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const persistence = {
      snapshotStore: { save },
    } as unknown as NonNullable<Parameters<typeof createSnapshotBroadcaster>[2]>;
    const clients = new Map() as Parameters<typeof createSnapshotBroadcaster>[0];
    const browsers = new Set() as Parameters<typeof createSnapshotBroadcaster>[1];
    const broadcaster = createSnapshotBroadcaster(clients, browsers, persistence);

    broadcaster.currentSerialized();
    expect(save).toHaveBeenCalledTimes(1);

    broadcaster.close();
    broadcaster.broadcast();
    vi.runAllTimers();

    expect(save).toHaveBeenCalledTimes(1);
  });

  it('cancels an already queued snapshot flush on close', () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const persistence = {
      snapshotStore: { save },
    } as unknown as NonNullable<Parameters<typeof createSnapshotBroadcaster>[2]>;
    const broadcaster = createSnapshotBroadcaster(
      new Map() as Parameters<typeof createSnapshotBroadcaster>[0],
      new Set() as Parameters<typeof createSnapshotBroadcaster>[1],
      persistence,
    );

    broadcaster.broadcast();
    broadcaster.close();
    vi.runAllTimers();

    expect(save).not.toHaveBeenCalled();
  });
});

describe('HQ snapshot broadcaster token counts', () => {
  it('puts token counts in the browser frame but never in the disk checkpoint', () => {
    const save = vi.fn();
    const persistence = {
      snapshotStore: { save },
    } as unknown as NonNullable<Parameters<typeof createSnapshotBroadcaster>[2]>;
    const stats = { browserTotal: 2, clientTotal: 1, expired: 0, expiringSoon: 1 };
    const broadcaster = createSnapshotBroadcaster(
      new Map() as Parameters<typeof createSnapshotBroadcaster>[0],
      new Set() as Parameters<typeof createSnapshotBroadcaster>[1],
      persistence,
      { tokenStats: () => stats },
    );

    const frame = JSON.parse(broadcaster.currentSerialized()) as {
      type: string;
      snapshot: { totals: { tokenStats?: unknown } };
    };
    expect(frame.type).toBe('hq.snapshot');
    expect(frame.snapshot.totals.tokenStats).toEqual(stats);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0].totals.tokenStats).toBeUndefined();
  });

  it('omits them when no source is wired', () => {
    const broadcaster = createSnapshotBroadcaster(
      new Map() as Parameters<typeof createSnapshotBroadcaster>[0],
      new Set() as Parameters<typeof createSnapshotBroadcaster>[1],
    );
    const frame = JSON.parse(broadcaster.currentSerialized()) as {
      snapshot: { totals: Record<string, unknown> };
    };
    expect('tokenStats' in frame.snapshot.totals).toBe(false);
  });
});

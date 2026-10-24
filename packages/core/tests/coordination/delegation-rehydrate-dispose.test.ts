import type { SessionEvent } from '@wrongstack/contracts/types/session';
import { expect, it } from 'vitest';
import { DelegationTracker } from '../../src/coordination/delegation/delegation-tracker.js';
import { LeaderDeliveryHub } from '../../src/coordination/delegation/leader-delivery-hub.js';

const journal = (id: string): SessionEvent[] => [
  {
    type: 'delegate_started',
    ts: '2026-01-01T00:00:00.000Z',
    target: 'worker',
    task: 'read',
    delegationId: id,
    mode: 'background',
  },
];

it('drops journal recovery after disposal while a fresh tracker can restore it once', async () => {
  const hub = new LeaderDeliveryHub();
  const tracker = new DelegationTracker({ hub });
  const fresh = new DelegationTracker({ hub });
  try {
    expect(tracker.rehydrate('control', journal('control'))).toBe(1);
    expect(tracker.rehydrate('control', journal('control'))).toBe(0);
    expect(hub.take('control')[0]?.wake).toBe(false);
    let release!: (value: SessionEvent[]) => void;
    const loaded = new Promise<SessionEvent[]>((done) => {
      release = done;
    });
    const restored = loaded.then((events) => tracker.rehydrate('late', events));
    tracker.dispose();
    tracker.dispose();
    release(journal('late'));
    expect(await restored).toBe(0);
    expect(hub.pending('late')).toBe(0);
    expect(tracker.rehydrate('empty', [])).toBe(0);
    expect(fresh.rehydrate('late', journal('late'))).toBe(1);
    expect(hub.take('late')[0]?.wake).toBe(false);
  } finally {
    tracker.dispose();
    fresh.dispose();
  }
});

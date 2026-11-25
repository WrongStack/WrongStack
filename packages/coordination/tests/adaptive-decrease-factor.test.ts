import { describe, expect, it } from 'vitest';
import { AdaptiveConcurrencyController } from '../src/adaptive-concurrency.js';
import { FleetBus, type FleetEvent } from '../src/fleet-bus.js';

describe('AdaptiveConcurrencyController (F2180)', () => {
  it('falls back to default decreaseFactor when configured decreaseFactor >= 1', () => {
    const bus = new FleetBus();
    let current = 8;
    const ctrl = new AdaptiveConcurrencyController(
      bus,
      (n) => {
        current = n;
      },
      { enabled: true, minConcurrent: 1, maxConcurrent: 8, decreaseFactor: 2 },
    );
    bus.emit({
      type: 'provider.attempt.failed',
      payload: { status: 429 },
    } as unknown as FleetEvent);
    ctrl.dispose();
    expect(current).toBe(4);
  });
});

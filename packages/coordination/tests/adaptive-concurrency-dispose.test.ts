import { describe, expect, it } from 'vitest';
import { AdaptiveConcurrencyController } from '../src/adaptive-concurrency.js';

describe('AdaptiveConcurrencyController disposal', () => {
  it('ignores decrease() and onStateChange() after dispose()', () => {
    const calls: number[] = [];
    const controller = new AdaptiveConcurrencyController(
      { onAny: () => () => {} } as never,
      (n) => calls.push(n),
      { enabled: true, minConcurrent: 1, maxConcurrent: 8 },
    );
    calls.length = 0;

    controller.dispose();
    controller.decrease(2);
    expect(calls).toEqual([]);
    expect(controller.getState().current).toBe(8);

    let notified = 0;
    const off = controller.onStateChange(() => {
      notified += 1;
    });
    controller.updateConfig({ maxConcurrent: 4 });
    off();
    expect(notified).toBe(0);
  });
});

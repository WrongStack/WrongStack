import { describe, expect, it } from 'vitest';
import { installFleetConcurrencyFrames } from '../src/server/fleet-concurrency.js';

describe('installFleetConcurrencyFrames non-finite ceiling guard', () => {
  it('ignores non-finite concurrency.changed payloads', () => {
    const handlers = new Map<string, (e: { n: number }) => void>();
    const frames: Array<Record<string, unknown>> = [];
    const ctrl = installFleetConcurrencyFrames({
      events: {
        on: ((ev: string, fn: (e: { n: number }) => void) => {
          handlers.set(ev, fn);
          return () => {};
        }) as Parameters<typeof installFleetConcurrencyFrames>[0]['events']['on'],
      },
      broadcast: (msg) => frames.push(msg.payload),
    });
    handlers.get('concurrency.changed')?.({ n: Number.NaN });
    ctrl.dispose();
    expect(frames.at(-1)?.fleetConcurrencyMax).toBe(4);
  });
});

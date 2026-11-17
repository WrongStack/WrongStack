import { describe, expect, it } from 'vitest';
import { beginBootTiming, finishBootTiming, markBoot } from '../src/server/boot-timing.js';

describe('boot timing marks', () => {
  it('reports each step once, in order, and ends with ready', () => {
    beginBootTiming();
    markBoot('config');
    markBoot('session');
    markBoot('config');
    const timing = finishBootTiming();
    expect(timing).toBeDefined();
    expect(Object.keys(timing!.marks)).toEqual(['config', 'session', 'ready']);
    expect(timing!.marks['ready']).toBeGreaterThanOrEqual(timing!.marks['session']!);
    expect(timing!.startedAfterMs).toBeGreaterThanOrEqual(0);
  });

  it('ignores marks outside a boot and reports nothing after it ended', () => {
    markBoot('stray');
    expect(finishBootTiming()).toBeUndefined();
    beginBootTiming();
    expect(finishBootTiming()?.marks).toEqual({ ready: expect.any(Number) });
    markBoot('late');
    expect(finishBootTiming()).toBeUndefined();
  });
});

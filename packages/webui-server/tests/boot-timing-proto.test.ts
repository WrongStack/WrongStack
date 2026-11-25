import { describe, expect, it } from 'vitest';
import { beginBootTiming, finishBootTiming, markBoot } from '../src/server/boot-timing.js';

describe('boot-timing prototype-safe mark recording', () => {
  it('records own marks for names matching Object.prototype properties', () => {
    beginBootTiming();
    markBoot('toString');
    markBoot('constructor');
    const timing = finishBootTiming();
    expect(timing).toBeDefined();
    expect(Object.hasOwn(timing!.marks, 'toString')).toBe(true);
    expect(Object.hasOwn(timing!.marks, 'constructor')).toBe(true);
    expect(typeof timing!.marks['toString']).toBe('number');
  });
});

import { describe, expect, it } from 'vitest';
import { attachAutoExtend } from '../src/auto-extend.js';

describe('attachAutoExtend denied extension count guard (F2224)', () => {
  it('does not burn maxExtensionsPerKind when a capped extension is denied', () => {
    const listeners = new Map<string, Array<(e: unknown) => void>>();
    const events = {
      on(name: string, fn: (e: unknown) => void) {
        const arr = listeners.get(name) ?? [];
        arr.push(fn);
        listeners.set(name, arr);
        return () => {};
      },
      emit(name: string, payload: unknown) {
        for (const fn of listeners.get(name) ?? []) fn(payload);
      },
    };

    attachAutoExtend(events as unknown as Parameters<typeof attachAutoExtend>[0], {
      maxExtensionsPerKind: 1,
      ceiling: { maxIterations: 100 },
    });

    let firstDenied = false;
    events.emit('budget.threshold_reached', {
      kind: 'iterations',
      limit: 100,
      extend: () => {},
      deny: () => {
        firstDenied = true;
      },
    });

    let granted: unknown = null;
    events.emit('budget.threshold_reached', {
      kind: 'iterations',
      limit: 20,
      extend: (patch: unknown) => {
        granted = patch;
      },
      deny: () => {},
    });

    expect(firstDenied).toBe(true);
    expect(granted).toEqual({ maxIterations: 30 });
  });
});

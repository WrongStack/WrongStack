import { describe, expect, it } from 'vitest';
import { safeJsonStringify } from '../src/runtime/safe-json.js';

describe('safeJsonStringify accessor handling (F934)', () => {
  it('invokes getter properties only once instead of re-reading them in the replacer', () => {
    let calls = 0;
    const payload = {
      get nested() {
        calls += 1;
        if (calls > 1) throw new Error('getter invoked more than once');
        return { ok: true };
      },
    };
    expect(safeJsonStringify(payload)).toBe('{"nested":{"ok":true}}');
    expect(calls).toBe(1);
  });

  it('still breaks toJSON cycles on own data properties', () => {
    const cycle: Record<string, unknown> = {
      toJSON() {
        return { wrapped: cycle };
      },
    };
    expect(safeJsonStringify({ item: cycle })).toBe('{"item":{"wrapped":"[circular]"}}');
  });
});

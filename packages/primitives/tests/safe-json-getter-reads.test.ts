import { describe, expect, it } from 'vitest';
import { safeStringify } from '../src/safe-json.js';

describe('safeStringify reads accessors only through native serialization', () => {
  it.each([false, true])('preserves a one-read getter with pretty=%s', (pretty) => {
    let reads = 0;
    const value = {
      get payload() {
        if (++reads > 1) throw new Error('payload getter read twice');
        return { ok: true };
      },
    };
    expect(JSON.parse(safeStringify(value, pretty))).toEqual({ payload: { ok: true } });
    expect(reads).toBe(1);
  });

  it('reads array element accessors once', () => {
    let reads = 0;
    const value: unknown[] = [];
    Object.defineProperty(value, '0', {
      enumerable: true,
      get() {
        reads++;
        return { ok: true };
      },
    });
    expect(JSON.parse(safeStringify(value))).toEqual([{ ok: true }]);
    expect(reads).toBe(1);
  });

  it('reads accessors on toJSON output once', () => {
    let reads = 0;
    const value = {
      toJSON() {
        return {
          get payload() {
            reads++;
            return { ok: true };
          },
        };
      },
    };
    expect(JSON.parse(safeStringify(value))).toEqual({ payload: { ok: true } });
    expect(reads).toBe(1);
  });

  it('does not mistake shared getter results for cycles', () => {
    let reads = 0;
    const shared = { ok: true };
    const value = {
      get first() {
        reads++;
        return shared;
      },
      get second() {
        reads++;
        return shared;
      },
    };
    expect(JSON.parse(safeStringify(value))).toEqual({ first: shared, second: shared });
    expect(reads).toBe(2);
  });

  it('still detects cycles through data properties transformed by toJSON', () => {
    const value = {
      toJSON() {
        return { self: value };
      },
    };
    expect(JSON.parse(safeStringify(value))).toEqual({ self: '[Circular]' });
  });

  it('still reports a genuinely throwing getter', () => {
    const value = {
      get payload() {
        throw new Error('unavailable payload');
      },
    };
    expect(JSON.parse(safeStringify(value))).toEqual({
      __serialization_error: 'unavailable payload',
    });
  });
});

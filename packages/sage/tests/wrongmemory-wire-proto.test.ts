import { describe, expect, it } from 'vitest';
import { compact, pick } from '../src/wrongmemory-wire.js';

describe('wrongmemory-wire prototype/own-key guards (F285)', () => {
  it('pick ignores inherited and prototype properties', () => {
    const inherited = Object.create({ secret: 'inherited' });
    inherited.own = 'ok';
    const picked = pick(inherited, ['own', 'secret', 'toString', '__proto__']);
    expect(picked).toEqual({ own: 'ok' });
    expect(Object.hasOwn(picked, 'secret')).toBe(false);
    expect(Object.hasOwn(picked, 'toString')).toBe(false);
  });

  it('compact ignores __proto__ keys without mutating prototype', () => {
    const payload = JSON.parse('{"__proto__":{"polluted":"yes"},"a":1,"b":null}') as Record<
      string,
      unknown
    >;
    const compacted = compact(payload);
    expect(Object.getPrototypeOf(compacted)).toBe(Object.prototype);
    expect((compacted as Record<string, unknown>).polluted).toBeUndefined();
    expect(compacted).toEqual({ a: 1, b: null });
  });
});

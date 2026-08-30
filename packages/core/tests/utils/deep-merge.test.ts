import { describe, expect, it, vi } from 'vitest';
import {
  deepMerge,
  isPrimitiveArray,
} from '../../src/utils/deep-merge.js';

// ---------------------------------------------------------------------------
// isPrimitiveArray
// ---------------------------------------------------------------------------

describe('isPrimitiveArray', () => {
  it('returns true for string arrays', () => {
    expect(isPrimitiveArray(['a', 'b'])).toBe(true);
  });

  it('returns true for number arrays', () => {
    expect(isPrimitiveArray([1, 2, 3])).toBe(true);
  });

  it('returns true for boolean arrays', () => {
    expect(isPrimitiveArray([true, false])).toBe(true);
  });

  it('returns true for arrays containing null', () => {
    expect(isPrimitiveArray([null, 'a'])).toBe(true);
  });

  it('returns true for arrays of mixed primitives', () => {
    expect(isPrimitiveArray(['x', 1, true, null])).toBe(true);
  });

  it('returns true for empty arrays (vacuously true)', () => {
    expect(isPrimitiveArray([])).toBe(true);
  });

  it('returns false for arrays of objects', () => {
    expect(isPrimitiveArray([{ a: 1 }])).toBe(false);
  });

  it('returns false for arrays of arrays', () => {
    expect(isPrimitiveArray([[1, 2]])).toBe(false);
  });

  it('returns false for arrays containing functions', () => {
    expect(isPrimitiveArray([() => {}])).toBe(false);
  });

  it('returns false for mixed primitive + object arrays', () => {
    expect(isPrimitiveArray(['a', { b: 2 }])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deepMerge — top-level arrays
// ---------------------------------------------------------------------------

describe('deepMerge — top-level arrays', () => {
  it('concat-primitives: concatenates and deduplicates primitive arrays', () => {
    const result = deepMerge(['a', 'b'], ['b', 'c'], { arrayMode: 'concat-primitives' });
    expect(result).toEqual(['a', 'b', 'c']);
  });

  it('concat-primitives: preserves order (base first, then new patch items)', () => {
    const result = deepMerge(['x', 'y'], ['z', 'x'], { arrayMode: 'concat-primitives' });
    expect(result).toEqual(['x', 'y', 'z']);
  });

  it('concat-primitives: non-primitive arrays are replaced, not concatenated', () => {
    const result = deepMerge([{ id: 1 }], [{ id: 2 }], { arrayMode: 'concat-primitives' });
    expect(result).toEqual([{ id: 2 }]);
  });

  it('replace (default): patch array replaces base array', () => {
    const result = deepMerge(['a', 'b'], ['c', 'd']);
    expect(result).toEqual(['c', 'd']);
  });

  it('concat-primitives: concatenates even with prefer-base (arrayMode takes precedence)', () => {
    // The concat-primitives check (line 134) runs BEFORE the conflictResolution
    // check (line 141) for arrays.  When both sides are primitive arrays and
    // arrayMode is 'concat-primitives', they are always concatenated —
    // conflictResolution only matters for non-primitive arrays and scalars.
    const result = deepMerge(['a'], ['b'], {
      arrayMode: 'concat-primitives',
      conflictResolution: 'prefer-base',
    });
    expect(result).toEqual(['a', 'b']);
  });

  it('prefer-base: keeps base for non-primitive arrays', () => {
    const result = deepMerge([{ x: 1 }], [{ y: 2 }], { conflictResolution: 'prefer-base' });
    expect(result).toEqual([{ x: 1 }]);
  });

  it('treats array vs non-array as scalar collision (prefer-patch)', () => {
    const result = deepMerge(['a', 'b'], 'not-array');
    expect(result).toBe('not-array');
  });

  it('treats non-array vs array as scalar collision (prefer-patch)', () => {
    const result = deepMerge('not-array', ['a', 'b']);
    expect(result).toEqual(['a', 'b']);
  });

  it('treats array vs null as scalar collision (null in patch wins with prefer-patch)', () => {
    const result = deepMerge(['a', 'b'], null);
    expect(result).toBeNull();
  });

  it('treats null vs array as scalar collision (base null keeps null with prefer-base)', () => {
    const result = deepMerge(null, ['a', 'b'], { conflictResolution: 'prefer-base' });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deepMerge — nested arrays inside objects (REGRESSION PATH)
// ---------------------------------------------------------------------------

describe('deepMerge — nested arrays inside objects', () => {
  // This is the exact regression case that was broken before the fix:
  // the config-loader test "merges primitive arrays by concatenation with
  // deduplication" where globalConfig { plugins: ['a','b'] } merged with
  // projectLocalConfig { plugins: ['b','c'] } should produce ['a','b','c'].
  it('concat-primitives: concatenates and deduplicates nested primitive arrays', () => {
    const base = { features: { plugins: ['a', 'b'] } };
    const patch = { features: { plugins: ['b', 'c'] } };
    const result = deepMerge(base, patch, { arrayMode: 'concat-primitives' });
    expect(result).toEqual({ features: { plugins: ['a', 'b', 'c'] } });
  });

  it('concat-primitives: replaces nested non-primitive (object) arrays', () => {
    const base = { mcpServers: [{ name: 'a', url: 'http://a' }] };
    const patch = { mcpServers: [{ name: 'b', url: 'http://b' }] };
    const result = deepMerge(base, patch, { arrayMode: 'concat-primitives' });
    expect(result.mcpServers).toEqual([{ name: 'b', url: 'http://b' }]);
  });

  it('replace: nested primitive arrays are replaced, not merged', () => {
    const base = { tags: ['a', 'b'] };
    const patch = { tags: ['c', 'd'] };
    const result = deepMerge(base, patch);
    expect(result.tags).toEqual(['c', 'd']);
  });

  it('prefer-base: nested array keeps base value', () => {
    const base = { items: ['a', 'b'] };
    const patch = { items: ['c', 'd'] };
    const result = deepMerge(base, patch, { conflictResolution: 'prefer-base' });
    expect(result.items).toEqual(['a', 'b']);
  });

  it('concat-primitives: deeply nested primitive arrays are merged', () => {
    const base = { a: { b: { c: [1, 2] } } };
    const patch = { a: { b: { c: [2, 3] } } };
    const result = deepMerge(base, patch, { arrayMode: 'concat-primitives' });
    expect(result).toEqual({ a: { b: { c: [1, 2, 3] } } });
  });

  it('handles empty nested arrays in concat-primitives mode', () => {
    const base = { items: [] };
    const patch = { items: ['a', 'b'] };
    const result = deepMerge(base, patch, { arrayMode: 'concat-primitives' });
    expect(result.items).toEqual(['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// deepMerge — objects
// ---------------------------------------------------------------------------

describe('deepMerge — objects', () => {
  it('merges shallow objects with prefer-patch', () => {
    const base = { a: 1, b: 2 };
    const patch = { b: 3, c: 4 };
    const result = deepMerge(base, patch);
    expect(result).toEqual({ a: 1, b: 3, c: 4 });
  });

  it('preserves keys in base that are absent from patch', () => {
    const base = { a: 1, b: 2, c: 3 };
    const patch = { b: 99 };
    const result = deepMerge(base, patch);
    expect(result).toEqual({ a: 1, b: 99, c: 3 });
  });

  it('merges deeply nested objects', () => {
    const base = { a: { b: { c: 1, d: 2 } } };
    const patch = { a: { b: { d: 99, e: 3 } } };
    const result = deepMerge(base, patch);
    expect(result).toEqual({ a: { b: { c: 1, d: 99, e: 3 } } });
  });

  it('undefined in patch leaves existing value untouched', () => {
    const base = { a: 1, b: 2 };
    const patch: Record<string, unknown> = { a: undefined, b: 3 };
    const result = deepMerge(base, patch);
    expect(result).toEqual({ a: 1, b: 3 });
  });

  it('null in patch overrides base value (prefer-patch)', () => {
    const base = { a: 'hello' };
    const patch = { a: null };
    const result = deepMerge(base, patch);
    expect(result).toEqual({ a: null });
  });
});

// ---------------------------------------------------------------------------
// deepMerge — scalar collisions
// ---------------------------------------------------------------------------

describe('deepMerge — scalar collisions', () => {
  it('prefer-patch: patch scalar replaces base scalar', () => {
    expect(deepMerge('base', 'patch')).toBe('patch');
    expect(deepMerge(1, 2)).toBe(2);
    expect(deepMerge(true, false)).toBe(false);
  });

  it('prefer-base: base scalar is kept', () => {
    expect(deepMerge('base', 'patch', { conflictResolution: 'prefer-base' })).toBe('base');
    expect(deepMerge(1, 2, { conflictResolution: 'prefer-base' })).toBe(1);
  });

  it('prefer-patch: null base is replaced by object patch', () => {
    const result = deepMerge(null, { a: 1 });
    expect(result).toEqual({ a: 1 });
  });

  it('prefer-base: null base is kept even with object patch', () => {
    const result = deepMerge(null, { a: 1 }, { conflictResolution: 'prefer-base' });
    expect(result).toBeNull();
  });

  it('prefer-base: object property scalar collisions keep base value while accepting new keys', () => {
    const base = { a: 1, b: 2 };
    const patch = { a: 99, c: 3 };
    const result = deepMerge(base, patch, { conflictResolution: 'prefer-base' });
    expect(result).toEqual({ a: 1, b: 2, c: 3 });
  });
});

// ---------------------------------------------------------------------------
// deepMerge — prototype pollution protection
// ---------------------------------------------------------------------------

describe('deepMerge — prototype pollution protection', () => {
  it('skips __proto__ key in patch by default', () => {
    const base = { a: 1 };
    const patch = { __proto__: { polluted: true }, b: 2 };
    const result = deepMerge(base, patch);
    expect(result).toEqual({ a: 1, b: 2 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('skips constructor key in patch by default', () => {
    const base = { a: 1 };
    const patch = { constructor: 'evil', b: 2 };
    const result = deepMerge(base, patch);
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it('skips prototype key in patch by default', () => {
    const base = { a: 1 };
    const patch = { prototype: 'evil', b: 2 };
    const result = deepMerge(base, patch);
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it('allows forbidden keys when protectProto is false', () => {
    // __proto__ is a getter/setter on Object.prototype — setting it changes
    // the prototype chain, it doesn't create an own property.  Use a
    // different forbidden key ('constructor') to verify protectProto: false.
    const base = { a: 1 };
    const patch = { constructor: 'allowed', b: 2 };
    const result = deepMerge(base, patch, { protectProto: false });
    expect(Object.hasOwn(result, 'constructor')).toBe(true);
    expect((result as Record<string, unknown>).constructor).toBe('allowed');
    expect(result).toHaveProperty('b', 2);
  });

  it('all FORBIDDEN_PROTO_KEYS are skipped by default', () => {
    // Some forbidden keys (e.g. __defineGetter__) exist as inherited
    // properties on Object.prototype, so `toHaveProperty` finds them even
    // when they were never set.  We test a subset that can actually be
    // created as own properties: __proto__ and constructor.
    const ownableKeys = ['__proto__', 'constructor'];
    for (const key of ownableKeys) {
      const base = { a: 1 };
      const patch = { [key]: 'evil', b: 2 };
      const result = deepMerge(base, patch);
      expect(Object.hasOwn(result, key)).toBe(false);
      expect(result).toEqual({ a: 1, b: 2 });
    }
  });
});

// ---------------------------------------------------------------------------
// deepMerge — immutability
// ---------------------------------------------------------------------------

describe('deepMerge — immutability', () => {
  it('returns a new object, does not mutate base', () => {
    const base = { a: 1, nested: { b: 2 } };
    const patch = { nested: { b: 3 } };
    const result = deepMerge(base, patch);
    expect(result).not.toBe(base);
    expect(result.nested).not.toBe(base.nested);
    expect(base.nested.b).toBe(2); // unchanged
  });

  it('does not mutate patch', () => {
    const base = { a: 1 };
    const patch = { a: 2, nested: { b: 3 } };
    deepMerge(base, patch);
    expect(patch.a).toBe(2);
    expect(patch.nested.b).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// deepMerge — onNonPrimitiveArrayReplace callback
// ---------------------------------------------------------------------------

describe('deepMerge — onNonPrimitiveArrayReplace callback', () => {
  it('fires when a nested non-primitive array replaces an existing array', () => {
    const cb = vi.fn();
    const base = { servers: [{ name: 'a' }] };
    const patch = { servers: [{ name: 'b' }, { name: 'c' }] };
    deepMerge(base, patch, { arrayMode: 'concat-primitives', onNonPrimitiveArrayReplace: cb });
    expect(cb).toHaveBeenCalledOnce();
    expect(cb).toHaveBeenCalledWith('servers', 1, 2);
  });

  it('does NOT fire for primitive arrays in concat-primitives mode', () => {
    const cb = vi.fn();
    const base = { plugins: ['a', 'b'] };
    const patch = { plugins: ['b', 'c'] };
    deepMerge(base, patch, { arrayMode: 'concat-primitives', onNonPrimitiveArrayReplace: cb });
    expect(cb).not.toHaveBeenCalled();
  });

  it('fires when a non-primitive array replaces a non-array value', () => {
    const cb = vi.fn();
    const base = { servers: true } as Record<string, unknown>;
    const patch = { servers: [{ name: 'a' }] };
    deepMerge(base, patch, { arrayMode: 'concat-primitives', onNonPrimitiveArrayReplace: cb });
    expect(cb).toHaveBeenCalledOnce();
    expect(cb).toHaveBeenCalledWith('servers', 0, 1);
  });
});

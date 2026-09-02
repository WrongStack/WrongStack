/**
 * Tests for object-utils — isPlainObject, isNodeReadable, stripCacheControl.
 */
import { describe, it, expect } from 'vitest';
import { isPlainObject, isNodeReadable, stripCacheControl } from '../src/object-utils.js';

// ============================================================================
// isPlainObject
// ============================================================================

describe('isPlainObject', () => {
  it('returns true for plain objects', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
  });

  it('returns false for null', () => {
    expect(isPlainObject(null)).toBe(false);
  });

  it('returns false for arrays', () => {
    expect(isPlainObject([])).toBe(false);
  });

  it('returns false for primitives', () => {
    expect(isPlainObject('string')).toBe(false);
    expect(isPlainObject(42)).toBe(false);
    expect(isPlainObject(true)).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
  });
});

// ============================================================================
// isNodeReadable
// ============================================================================

describe('isNodeReadable', () => {
  it('returns true for objects with pipe and on methods', () => {
    expect(isNodeReadable({ pipe: () => {}, on: () => {} })).toBe(true);
  });

  it('returns false for null', () => {
    expect(isNodeReadable(null)).toBe(false);
  });

  it('returns false for plain objects', () => {
    expect(isNodeReadable({})).toBe(false);
  });

  it('returns false for primitives', () => {
    expect(isNodeReadable('string')).toBe(false);
    expect(isNodeReadable(42)).toBe(false);
  });

  it('returns false for objects missing pipe', () => {
    expect(isNodeReadable({ on: () => {} })).toBe(false);
  });

  it('returns false for objects missing on', () => {
    expect(isNodeReadable({ pipe: () => {} })).toBe(false);
  });
});

// ============================================================================
// stripCacheControl
// ============================================================================

describe('stripCacheControl', () => {
  it('returns undefined for null/undefined system', () => {
    expect(stripCacheControl(undefined)).toBeUndefined();
    expect(stripCacheControl(null as any)).toBeUndefined();
  });

  it('strips cache_control from each block', () => {
    const input = [
      { type: 'text', text: 'Hello', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'World' },
    ] as any;
    const result = stripCacheControl(input);
    expect(result).toHaveLength(2);
    expect(result![0]).not.toHaveProperty('cache_control');
    expect(result![0]).toEqual({ type: 'text', text: 'Hello' });
    expect(result![1]).toEqual({ type: 'text', text: 'World' });
  });

  it('preserves other block properties', () => {
    const input = [
      {
        type: 'text',
        text: 'Test',
        metadata: { key: 'value' },
        cache_control: { type: 'ephemeral' },
      },
    ] as any;
    const result = stripCacheControl(input);
    expect(result![0]).toEqual({ type: 'text', text: 'Test', metadata: { key: 'value' } });
  });
});

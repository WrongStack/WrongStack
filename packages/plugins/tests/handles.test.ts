/**
 * Tests for runtime/handles.ts — releaseHandle, releaseHandles, Unregister.
 */
import { describe, expect, it, vi } from 'vitest';
import { releaseHandle, releaseHandles } from '../src/runtime/handles.js';

describe('releaseHandle', () => {
  it('returns null and calls the unregister function when given a function', () => {
    const off = vi.fn();
    const result = releaseHandle(off);
    expect(result).toBeNull();
    expect(off).toHaveBeenCalledOnce();
  });

  it('returns null and does nothing when given null', () => {
    const result = releaseHandle(null);
    expect(result).toBeNull();
  });

  it('returns null and does nothing when given undefined', () => {
    const result = releaseHandle(undefined);
    expect(result).toBeNull();
  });

  it('swallows errors thrown by the unregister function', () => {
    const off = vi.fn(() => {
      throw new Error('already disposed');
    });
    expect(() => releaseHandle(off)).not.toThrow();
    expect(off).toHaveBeenCalledOnce();
  });
});

describe('releaseHandles', () => {
  it('releases multiple handles on a state object, clearing them in place', () => {
    const off1 = vi.fn();
    const off2 = vi.fn();
    const state: { a: null | (() => void); b: null | (() => void) } = { a: off1, b: off2 };

    releaseHandles(state, ['a', 'b']);

    expect(state.a).toBeNull();
    expect(state.b).toBeNull();
    expect(off1).toHaveBeenCalledOnce();
    expect(off2).toHaveBeenCalledOnce();
  });

  it('handles null/undefined entries without throwing', () => {
    const state: { a: null | (() => void); b: null | (() => void) } = {
      a: null,
      b: undefined as never,
    };

    expect(() => releaseHandles(state, ['a', 'b'])).not.toThrow();
    expect(state.a).toBeNull();
  });

  it('handles throwing unregister functions gracefully', () => {
    const off1 = vi.fn(() => {
      throw new Error('fail');
    });
    const off2 = vi.fn();
    const state: { a: null | (() => void); b: null | (() => void) } = { a: off1, b: off2 };

    expect(() => releaseHandles(state, ['a', 'b'])).not.toThrow();
    expect(state.a).toBeNull();
    expect(state.b).toBeNull();
    expect(off1).toHaveBeenCalled();
    expect(off2).toHaveBeenCalled();
  });
});

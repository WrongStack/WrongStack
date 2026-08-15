/**
 * Tests for runtime/h1-state.ts — createH1State.
 *
 * Pins SAGE memory T-03 (single-slot H1 state leak): re-registering
 * a key with a new unregister function MUST release the prior one,
 * otherwise plugin reload silently leaks hooks/extensions/subscribers.
 */
import { describe, expect, it, vi } from 'vitest';
import { createH1State } from '../src/runtime/h1-state.js';

describe('createH1State', () => {
  it('exposes the initial state and lets the caller mutate it', () => {
    const h = createH1State({ counter: 0 });
    h.state.counter = 1;
    expect(h.state.counter).toBe(1);
  });

  it('release is a no-op when the key has no registered handle', () => {
    const h = createH1State({});
    expect(() => h.release('not-set')).not.toThrow();
    expect(h.size()).toBe(0);
  });

  it('register stores the unregister under the key', () => {
    const off = vi.fn();
    const h = createH1State({});
    h.register('hook', off);
    expect(h.size()).toBe(1);
    expect(h.keys()).toEqual(['hook']);
  });

  it('registering the same key releases the PRIOR handle before storing the new one', () => {
    const prior = vi.fn();
    const next = vi.fn();
    const h = createH1State({});

    h.register('hook', prior);
    h.register('hook', next);

    expect(prior).toHaveBeenCalledOnce();
    expect(next).not.toHaveBeenCalled();
    expect(h.size()).toBe(1);

    h.releaseAll();
    expect(next).toHaveBeenCalledOnce();
  });

  it('release(key) releases the handle and removes it from the registry', () => {
    const off = vi.fn();
    const h = createH1State({});
    h.register('hook', off);
    h.release('hook');
    expect(off).toHaveBeenCalledOnce();
    expect(h.size()).toBe(0);
  });

  it('releaseAll releases every registered handle in insertion order', () => {
    const calls: string[] = [];
    const h = createH1State({});
    h.register('a', () => calls.push('a'));
    h.register('b', () => calls.push('b'));
    h.register('c', () => calls.push('c'));

    h.releaseAll();

    expect(calls).toEqual(['a', 'b', 'c']);
    expect(h.size()).toBe(0);
  });

  it('releaseAll is idempotent (safe to call when empty)', () => {
    const h = createH1State({});
    expect(() => h.releaseAll()).not.toThrow();
    expect(() => h.releaseAll()).not.toThrow();
  });

  it('swallows errors thrown by an unregister function', () => {
    const throwing = vi.fn(() => {
      throw new Error('already disposed');
    });
    const h = createH1State({});
    h.register('hook', throwing);
    expect(() => h.release('hook')).not.toThrow();
    expect(throwing).toHaveBeenCalledOnce();
  });

  it('register(null|undefined) is treated as a release', () => {
    const off = vi.fn();
    const h = createH1State({});
    h.register('hook', off);
    expect(h.size()).toBe(1);

    h.register('hook', null);
    expect(off).toHaveBeenCalledOnce();
    expect(h.size()).toBe(0);

    h.register('hook', undefined);
    expect(h.size()).toBe(0);
  });

  it('a reload sequence leaves exactly one active handle per key', () => {
    const sequence: string[] = [];
    const h = createH1State({});
    for (let i = 0; i < 5; i++) {
      h.register('hook', () => sequence.push(`r${i}`));
    }
    expect(h.size()).toBe(1);
    expect(sequence).toEqual(['r0', 'r1', 'r2', 'r3']); // 4 prior released

    h.releaseAll();
    expect(sequence).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
  });
});

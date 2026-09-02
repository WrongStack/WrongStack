/**
 * Edge-case tests for src/lib/chime.ts — SSR guard (window undefined).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('chime — SSR guard (line 16)', () => {
  beforeEach(() => {
    vi.resetModules();
    // Clear window.AudioContext AND make the audio() function return null
    // by removing window entirely (typeof window === 'undefined')
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does nothing when window is undefined (SSR)', async () => {
    vi.stubGlobal('window', undefined);
    const { playCompletionChime, playPermissionChime } = await import('../../src/lib/chime');
    expect(() => playCompletionChime()).not.toThrow();
    expect(() => playPermissionChime()).not.toThrow();
  });

  it('does nothing when AudioContext constructor throws', async () => {
    // This is covered by existing test but re-testing explicitly
    Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      value: class Throws {
        constructor() {
          throw new Error('no audio');
        }
      },
    });
    const { playCompletionChime, playPermissionChime } = await import('../../src/lib/chime');
    expect(() => playCompletionChime()).not.toThrow();
    expect(() => playPermissionChime()).not.toThrow();
  });
});

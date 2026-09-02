/**
 * Tests for src/lib/terminal-dock.ts — clampTerminalHeight edge cases.
 * Pure function, but has a `typeof window === 'undefined'` SSR guard branch (line 8).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clampTerminalHeight,
  MIN_TERMINAL_HEIGHT,
  MAX_TERMINAL_HEIGHT,
} from '../../src/lib/terminal-dock';

describe('clampTerminalHeight', () => {
  it('returns MIN when value is below minimum', () => {
    expect(clampTerminalHeight(0)).toBe(MIN_TERMINAL_HEIGHT);
    expect(clampTerminalHeight(-100)).toBe(MIN_TERMINAL_HEIGHT);
  });

  it('uses viewport-based max when window is available (line 8 else branch)', () => {
    // In jsdom, window.innerHeight is 768 by default
    // viewportMax = max(140, min(640, floor(768*0.55=422), 768-260=508)) = max(140, min(640, 422, 508))
    // = max(140, 422) = 422
    // So result = min(max(value, 140), 422)
    expect(clampTerminalHeight(300)).toBe(300); // max(300,140) = 300, min(300, 422) = 300
    expect(clampTerminalHeight(9999)).toBe(422); // max(9999,140) = 9999, min(9999, 422) = 422
  });
});

describe('clampTerminalHeight — SSR branch (line 8)', () => {
  beforeEach(() => {
    vi.stubGlobal('window', undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses MAX_TERMINAL_HEIGHT when window is undefined (SSR guard)', () => {
    // Without window, viewportMax = MAX_TERMINAL_HEIGHT = 640
    expect(clampTerminalHeight(200)).toBe(200);
    expect(clampTerminalHeight(9999)).toBe(MAX_TERMINAL_HEIGHT);
  });
});

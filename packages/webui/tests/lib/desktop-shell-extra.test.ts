/**
 * Additional tests for src/lib/desktop-shell.ts — isDesktopShell function.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { isDesktopShell } from '../../src/lib/desktop-shell.js';

describe('isDesktopShell', () => {
  const originalWindow = globalThis.window;

  afterEach(() => {
    (globalThis as any).window = originalWindow;
    vi.restoreAllMocks();
  });

  it('returns false when window is undefined (SSR)', () => {
    (globalThis as any).window = undefined;
    expect(isDesktopShell()).toBe(false);
  });

  it('returns false when wrongstackDesktopHost is absent and no query param', () => {
    vi.stubGlobal('window', { location: { search: '' } });
    expect(isDesktopShell()).toBe(false);
  });

  it('returns true when wrongstackDesktopHost is present', () => {
    vi.stubGlobal('window', {
      location: { search: '' },
      wrongstackDesktopHost: {},
    });
    expect(isDesktopShell()).toBe(true);
  });
});

describe('detectDesktopShell catch block', () => {
  it('falls back to false when URLSearchParams constructor throws', async () => {
    // Temporarily break URLSearchParams to exercise the catch block
    const origURLSearchParams = globalThis.URLSearchParams;
    (globalThis as any).URLSearchParams = class Broken {
      constructor() {
        throw new Error('boom');
      }
      get() {
        return null;
      }
    };
    const mod = await import('../../src/lib/desktop-shell.js');
    expect(mod.detectDesktopShell('?shell=desktop', false)).toBe(false);
    (globalThis as any).URLSearchParams = origURLSearchParams;
  });
});

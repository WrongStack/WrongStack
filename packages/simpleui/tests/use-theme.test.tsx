// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTheme } from '../src/hooks/use-theme.js';

/**
 * The theme is persisted as the user's CHOICE ('system' | 'light' | 'dark');
 * what reaches the DOM and consumers is always the RESOLVED theme. 'system'
 * is the default and tracks prefers-color-scheme LIVE (not just at boot).
 * jsdom has no matchMedia, so a stub is installed per test — and the hook
 * must degrade to 'dark' when even that API is missing.
 */

const BASE = 'WrongStack SimpleUI';

const roots: Root[] = [];
const hosts: HTMLElement[] = [];

interface MatchMediaStub {
  matches: boolean;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
}

function installMatchMedia(matches: boolean): MatchMediaStub {
  const stub: MatchMediaStub = {
    matches,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn(() => stub),
  });
  return stub;
}

interface ThemeProbe {
  theme: () => 'system' | 'light' | 'dark' | undefined;
  resolvedTheme: () => 'light' | 'dark' | undefined;
  setTheme: (t: 'system' | 'light' | 'dark') => void;
  toggle: () => void;
}

function renderTheme(): ThemeProbe {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  hosts.push(host);

  let latest: ReturnType<typeof useTheme>;
  function Probe(): null {
    latest = useTheme();
    return null;
  }
  act(() => {
    root.render(<Probe />);
  });
  return {
    theme: () => latest.theme,
    resolvedTheme: () => latest.resolvedTheme,
    setTheme: (t) =>
      act(() => {
        latest.setTheme(t);
      }),
    toggle: () =>
      act(() => {
        latest.toggleTheme();
      }),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const host of hosts.splice(0)) host.remove();
  localStorage.clear();
  delete (document.documentElement as { dataset: Record<string, unknown> }).dataset.theme;
  document.documentElement.style.colorScheme = '';
  vi.restoreAllMocks();
});

describe('useTheme — initial resolution', () => {
  it('defaults to system mode, resolved from the OS', () => {
    installMatchMedia(true);
    const t = renderTheme();
    expect(t.theme()).toBe('system');
    expect(t.resolvedTheme()).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('wrongstack.simpleui.theme')).toBe('system');
  });

  it('honors a saved light/dark choice and skips the OS query', () => {
    const stub = installMatchMedia(true);
    localStorage.setItem('wrongstack.simpleui.theme', 'dark');
    const t = renderTheme();
    expect(t.theme()).toBe('dark');
    expect(t.resolvedTheme()).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    // Explicit choice: no live tracking while not in system mode.
    expect(stub.addEventListener).not.toHaveBeenCalled();
  });

  it('honors a saved system choice', () => {
    installMatchMedia(false);
    localStorage.setItem('wrongstack.simpleui.theme', 'system');
    const t = renderTheme();
    expect(t.theme()).toBe('system');
    expect(t.resolvedTheme()).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('treats a corrupted saved value as system', () => {
    installMatchMedia(false);
    localStorage.setItem('wrongstack.simpleui.theme', 'midnight');
    const t = renderTheme();
    expect(t.theme()).toBe('system');
    expect(t.resolvedTheme()).toBe('dark');
  });

  it('falls back to system/dark when localStorage throws (privacy mode)', () => {
    installMatchMedia(false);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const t = renderTheme();
    expect(t.theme()).toBe('system');
    expect(t.resolvedTheme()).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('degrades to dark when matchMedia is missing entirely', () => {
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: undefined });
    const t = renderTheme();
    expect(t.theme()).toBe('system');
    expect(t.resolvedTheme()).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});

describe('useTheme — persistence and DOM side-effects', () => {
  it('persists explicit choices and applies them to the document', () => {
    installMatchMedia(false);
    const t = renderTheme();
    t.setTheme('light');
    expect(t.theme()).toBe('light');
    expect(t.resolvedTheme()).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
    expect(localStorage.getItem('wrongstack.simpleui.theme')).toBe('light');
  });

  it('swallows persistence failures (storage blocked) and still applies the DOM', () => {
    installMatchMedia(false);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full');
    });
    const t = renderTheme();
    t.setTheme('light');
    expect(t.theme()).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});

describe('useTheme — toggle cycle', () => {
  it('cycles system → light → dark → system', () => {
    installMatchMedia(false);
    const t = renderTheme();
    expect(t.theme()).toBe('system');
    t.toggle();
    expect(t.theme()).toBe('light');
    expect(t.resolvedTheme()).toBe('light');
    t.toggle();
    expect(t.theme()).toBe('dark');
    expect(t.resolvedTheme()).toBe('dark');
    t.toggle();
    expect(t.theme()).toBe('system');
    expect(t.resolvedTheme()).toBe('dark'); // OS still dark
    expect(localStorage.getItem('wrongstack.simpleui.theme')).toBe('system');
  });
});

describe('useTheme — live OS tracking', () => {
  it('re-resolves when the OS preference flips while in system mode', () => {
    const stub = installMatchMedia(true);
    const t = renderTheme();
    expect(t.resolvedTheme()).toBe('light');

    // Simulate the OS flipping to dark: flip the stub, then fire the
    // registered change listener.
    stub.matches = false;
    const handler = stub.addEventListener.mock.calls.at(-1)?.[1] as () => void;
    act(() => {
      handler();
    });
    expect(t.resolvedTheme()).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('detaches the OS listener on unmount', () => {
    const stub = installMatchMedia(true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    function Probe(): null {
      useTheme();
      return null;
    }
    act(() => {
      root.render(<Probe />);
    });
    act(() => root.unmount());
    expect(stub.removeEventListener).toHaveBeenCalled();
  });
});

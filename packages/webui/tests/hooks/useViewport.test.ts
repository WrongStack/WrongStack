import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isMobileViewport, MOBILE_BREAKPOINT, useViewport } from '../../src/hooks/useViewport';

// Mock matchMedia
function mockMatchMedia(matches: boolean) {
  return vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onchange: null,
  }));
}

/**
 * A query-evaluating stand-in for the browser media engine: jsdom never parses
 * `(max-width: …)`, so the boundary itself has to be evaluated for the
 * breakpoint tests to mean anything.
 */
function mockMatchMediaForWidth() {
  return vi.fn().mockImplementation((query: string) => {
    const max = Number(/max-width:\s*([\d.]+)px/.exec(query)?.[1]);
    const matches = Number.isFinite(max) ? window.innerWidth <= max : false;
    return {
      media: query,
      matches,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    } as unknown as MediaQueryList;
  }) as unknown as typeof window.matchMedia;
}

function setInnerWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
}

describe('useViewport', () => {
  const originalMatchMedia = window.matchMedia;
  const originalInnerWidth = window.innerWidth;

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    Object.defineProperty(window, 'innerWidth', { value: originalInnerWidth, writable: true });
  });

  it('returns desktop defaults on first render', () => {
    window.matchMedia = mockMatchMedia(false);
    const { result } = renderHook(() => useViewport());
    expect(result.current.isMobile).toBe(false);
    expect(result.current.isSmall).toBe(false);
  });

  // Tailwind compiles `md:` to `(width >= 48rem)`, so 768px is already the
  // desktop layout (`md:flex` rail, `md:hidden` mobile bar, docked SidePanel).
  // The JS predicate must be exclusive of that value or the two disagree at the
  // edge — which used to auto-close the docked sidebar and set `inert` on <main>.
  it.each([
    [320, true],
    [767, true],
    [768, false],
    [769, false],
    [1440, false],
  ])('classifies %i CSS px as mobile=%s', (width, expected) => {
    setInnerWidth(width);
    window.matchMedia = mockMatchMediaForWidth();
    const { result } = renderHook(() => useViewport());
    expect(result.current.isMobile).toBe(expected);
  });

  it('detects small when viewport ≤ 640px', () => {
    const mobile = true;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('640') ? mobile : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    }));
    const { result } = renderHook(() => useViewport());
    expect(result.current.isSmall).toBe(true);
  });

  it('reports viewport width', () => {
    window.matchMedia = mockMatchMedia(false);
    Object.defineProperty(window, 'innerWidth', { value: 1280, writable: true });
    const { result } = renderHook(() => useViewport());
    expect(result.current.width).toBe(1280);
  });
});

describe('isMobileViewport', () => {
  const originalInnerWidth = window.innerWidth;
  const originalMatchMedia = window.matchMedia;

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: originalInnerWidth, writable: true });
    window.matchMedia = originalMatchMedia;
  });

  it('returns false at exactly the md breakpoint, true one pixel below it', () => {
    // `mockMatchMedia(true)` here would ignore the query and prove nothing; the
    // assertion only means something against the width-evaluating engine.
    window.matchMedia = mockMatchMediaForWidth();
    setInnerWidth(MOBILE_BREAKPOINT);
    expect(isMobileViewport()).toBe(false);
    setInnerWidth(MOBILE_BREAKPOINT - 1);
    expect(isMobileViewport()).toBe(true);
  });

  it('returns false above the breakpoint', () => {
    window.matchMedia = mockMatchMedia(false);
    Object.defineProperty(window, 'innerWidth', { value: MOBILE_BREAKPOINT + 1, writable: true });
    expect(isMobileViewport()).toBe(false);
  });
});

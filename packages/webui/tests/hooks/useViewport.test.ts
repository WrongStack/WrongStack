import { describe, expect, it, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useViewport, isMobileViewport, MOBILE_BREAKPOINT } from '../../src/hooks/useViewport';

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

  it('detects mobile when viewport ≤ 768px', () => {
    window.matchMedia = mockMatchMedia(true);
    const { result } = renderHook(() => useViewport());
    expect(result.current.isMobile).toBe(true);
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

  it('returns true when width ≤ breakpoint', () => {
    window.matchMedia = mockMatchMedia(true);
    Object.defineProperty(window, 'innerWidth', { value: MOBILE_BREAKPOINT, writable: true });
    expect(isMobileViewport()).toBe(true);
  });

  it('returns false when width > breakpoint', () => {
    window.matchMedia = mockMatchMedia(false);
    Object.defineProperty(window, 'innerWidth', { value: MOBILE_BREAKPOINT + 1, writable: true });
    expect(isMobileViewport()).toBe(false);
  });
});

import { useEffect, useState } from 'react';

/**
 * Shared viewport breakpoint contract for the WebUI.
 *
 * Centralizes the Tailwind breakpoint values so every component
 * uses the same pixel thresholds. Previously `matchMedia('(max-width: 768px)')`
 * was scattered across 3+ files with the magic number inlined.
 *
 * Breakpoint values mirror Tailwind's `sm` (640px) and `md` (768px):
 * - `mobile`: viewport ≤ 768px (below `md`)
 * - `tablet`: 641px–768px (between `sm` and `md`)
 * - `desktop`: > 768px (at or above `md`)
 */

interface ViewportState {
  /** True when viewport width ≤ 768px (Tailwind `md` breakpoint). */
  isMobile: boolean;
  /** True when viewport width ≤ 640px (Tailwind `sm` breakpoint). */
  isSmall: boolean;
  /** Current viewport width in pixels (0 during SSR). */
  width: number;
}

const MOBILE_BREAKPOINT = 768;
const SMALL_BREAKPOINT = 640;

/**
 * React hook that tracks the viewport breakpoint state.
 * Re-renders on viewport resize. SSR-safe (returns desktop defaults
 * until mounted).
 *
 * @example
 * ```tsx
 * const { isMobile } = useViewport();
 * if (isMobile) return <MobileLayout />;
 * return <DesktopLayout />;
 * ```
 */
export function useViewport(): ViewportState {
  const [state, setState] = useState<ViewportState>({
    isMobile: false,
    isSmall: false,
    width: 0,
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const mqMobile = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`);
    const mqSmall = window.matchMedia(`(max-width: ${SMALL_BREAKPOINT}px)`);

    const apply = () => {
      setState({
        isMobile: mqMobile.matches,
        isSmall: mqSmall.matches,
        width: window.innerWidth,
      });
    };

    apply();
    mqMobile.addEventListener('change', apply);
    mqSmall.addEventListener('change', apply);
    return () => {
      mqMobile.removeEventListener('change', apply);
      mqSmall.removeEventListener('change', apply);
    };
  }, []);

  return state;
}

export function isMobileViewport(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`).matches;
}

export { MOBILE_BREAKPOINT };

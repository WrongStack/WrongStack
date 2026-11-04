import { useEffect, useState } from 'react';

/**
 * Shared viewport breakpoint contract for the WebUI.
 *
 * Centralizes the Tailwind breakpoint values so every component
 * uses the same pixel thresholds. Previously `matchMedia('(max-width: 768px)')`
 * was scattered across 3+ files with the magic number inlined.
 *
 * Breakpoint values mirror Tailwind's `sm` (640px) and `md` (768px). Tailwind
 * emits a breakpoint variant as `@media (width >= 48rem)`, so the breakpoint
 * VALUE belongs to the larger layout and "mobile" is strictly BELOW `md`:
 * - `mobile`: viewport < 768px (`max-md`, i.e. `width < 48rem`)
 * - `tablet`: 640px–767px (between `sm` and `md`)
 * - `desktop`: ≥ 768px (at or above `md`)
 *
 * An inclusive `(max-width: 768px)` query made 768px both mobile (JS) and
 * desktop (every `md:` utility), which fought the layout it described: at
 * exactly 768px `md:hidden` already hid the mobile activity bar, `md:flex`
 * already showed the rail, `max-md:pb-14` already dropped the bottom padding
 * and `SidePanel` already docked itself (`width < 768`) — while `isMobile`
 * auto-closed that docked sidebar and set `inert` on `<main>` with no backdrop
 * to dismiss it. Keep this query exclusive of `md` so JS and CSS never claim
 * different layouts at the same width.
 */

interface ViewportState {
  /** True when viewport width < 768px (below the Tailwind `md` breakpoint). */
  isMobile: boolean;
  /** True when viewport width ≤ 640px (Tailwind `sm` breakpoint). */
  isSmall: boolean;
  /** Current viewport width in pixels (0 during SSR). */
  width: number;
}

const MOBILE_BREAKPOINT = 768;
const SMALL_BREAKPOINT = 640;

/**
 * The exclusive CSS counterpart of the `md` breakpoint: Tailwind compiles `md:`
 * to `@media (width >= 48rem)`, so 768px itself belongs to the desktop side.
 * `(max-width: 768px)` therefore claimed 768px twice — once as mobile, once as
 * every `md:` utility. `767.98px` is the portable form of "strictly below 768"
 * (fractional viewport widths appear under browser zoom, so subtracting a whole
 * pixel would open a dead zone where neither layout claims the viewport).
 */
const MOBILE_MAX_WIDTH_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 0.02}px)`;

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

    const mqMobile = window.matchMedia(MOBILE_MAX_WIDTH_QUERY);
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
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(MOBILE_MAX_WIDTH_QUERY).matches;
}

export { MOBILE_BREAKPOINT };

/**
 * True below Tailwind's `md` breakpoint (768px), the width at which the surfaces switch to
 * their narrow layout. Tailwind's `md:` applies from 768px up, so 768px itself is not narrow.
 */
export function isMobileViewport(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(max-width: 767.98px)').matches;
}

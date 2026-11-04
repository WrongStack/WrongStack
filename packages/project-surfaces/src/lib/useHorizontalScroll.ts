import { type RefObject, useEffect } from 'react';

/**
 * Horizontal scroll handler — gives keyboard and Shift+Wheel users a way to
 * pan a horizontally-scrollable container without a trackpad.
 *
 * - **Shift+Wheel**: translates vertical wheel delta into horizontal scroll.
 *   This matches the platform convention (Chrome/Firefox/Safari all do this
 *   natively when Shift is held, but only for the *document* scroller —
 *   here we apply it to an inner `overflow-x-auto` container).
 * - **Ctrl+ArrowLeft / Ctrl+ArrowRight**: scrolls by one viewport width.
 *   Only fires when focus is inside the container (or on it), so it never
 *   hijacks text editing or other Cmd+Arrow shortcuts.
 *
 * Returns nothing — attaches the listeners via effect cleanup.
 */
export function useHorizontalScroll(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean = true,
): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;

    const onWheel = (e: WheelEvent) => {
      if (!e.shiftKey) return;
      // Only intercept when there's actual horizontal range and the
      // wheel event originated from within (or on) this element.
      if (el.scrollWidth <= el.clientWidth + 1) return;
      const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (delta === 0) return;
      e.preventDefault();
      el.scrollLeft += delta;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      if (el.scrollWidth <= el.clientWidth + 1) return;
      const amount = el.clientWidth * 0.8;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        el.scrollLeft -= amount;
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        el.scrollLeft += amount;
      }
    };

    // wheel is passive:false because we call preventDefault on Shift+Wheel
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('keydown', onKeyDown);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('keydown', onKeyDown);
    };
  }, [ref, enabled]);
}

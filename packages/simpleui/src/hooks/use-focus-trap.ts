import { useEffect } from 'react';

/**
 * Focus containment for `aria-modal` dialogs.
 *
 * The aria-modal contract requires Tab/Shift+Tab to stay inside the dialog;
 * without a trap, keyboard users escape into background content that screen
 * readers have already been told is inert. This hook:
 *  - cycles Tab between the first/last focusable descendants;
 *  - restores focus to the previously focused element when the dialog closes
 *    (unmount or `active` turning false).
 *
 * `containerRef` should point at the element carrying `role="dialog"`. The
 * element itself must be focusable-if-empty (give it `tabIndex={-1}` when it
 * has no focusable children) so a bare Tab has somewhere to land.
 */

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function visibleFocusables(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => {
      if ((element as HTMLElement & { disabled?: boolean }).disabled) return false;
      // checkVisibility handles display:none / visibility:hidden subtrees.
      // It is missing in jsdom (no layout engine) — treat that as visible.
      if (typeof element.checkVisibility === 'function' && !element.checkVisibility()) {
        return false;
      }
      return true;
    },
  );
}

export function useFocusTrap<T extends HTMLElement>(
  containerRef: React.RefObject<T | null>,
  active: boolean,
): void {
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // The listener lives on the document (not the container) so a Tab press
    // that starts on an element the focus already escaped to is still caught.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      if (!container.isConnected) return;
      const items = visibleFocusables(container);
      if (items.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }
      const first = items[0] as HTMLElement;
      const last = items[items.length - 1] as HTMLElement;
      const current = document.activeElement;
      const inside = current instanceof Node && container.contains(current);
      if (event.shiftKey) {
        if (!inside || current === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (!inside || current === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      // Restore focus only if the element is still in the document; a removed
      // target (e.g. the trigger was unmounted) would throw or be a no-op.
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [active, containerRef]);
}

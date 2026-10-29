import { useCallback } from 'react';

/**
 * Makes a `<details>` used as a floating popover behave like one: Escape inside it closes it and
 * returns focus to its summary, and a press anywhere outside it closes it. Returns a callback ref,
 * so the listeners follow the element even when it is rendered conditionally.
 */
export function useDetailsDismiss() {
  return useCallback((details: HTMLDetailsElement | null) => {
    if (!details) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !details.open) return;
      event.preventDefault();
      event.stopPropagation();
      details.open = false;
      details.querySelector<HTMLElement>(':scope > summary')?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      if (details.open && event.target instanceof Node && !details.contains(event.target))
        details.open = false;
    };
    details.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      details.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer, true);
    };
  }, []);
}

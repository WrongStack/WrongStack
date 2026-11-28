import { useEffect, useRef, useState } from 'react';

/**
 * Open state for a composer chip's popover: a click outside the chip and its panel closes it,
 * and Escape closes only it and returns focus to the chip.
 */
export function useComposerPopover() {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (anchorRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      anchorRef.current?.querySelector('button')?.focus();
    };
    document.addEventListener('mousedown', onPointerDown);
    // On the window in the capture phase, ahead of a surrounding dialog's own document-level
    // Escape handler: Escape closes this popover, not the Run settings dialog it sits in.
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);
  return { open, setOpen, anchorRef, panelRef };
}

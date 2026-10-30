import { type ComponentPropsWithoutRef, type RefObject, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

/** Anchor menus outside clipped containers while respecting available viewport space. */
export function AnchoredPopover({
  anchorRef,
  panelRef,
  initialFocusRef,
  width: preferredWidth = 320,
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<'div'> & {
  anchorRef: RefObject<HTMLElement | null>;
  panelRef: RefObject<HTMLDivElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  width?: number | 'anchor';
}) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [position, setPosition] = useState<{
    left: number;
    width: number;
    maxHeight: number;
    top?: number;
    bottom?: number;
  }>();

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    // Stay inside the active modal's focus/pointer scope, but outside the
    // scrollable field or task panel that would clip an inline menu.
    const dialog = anchor.closest<HTMLElement>('[role="dialog"]');
    setContainer(dialog ?? document.body);
    const update = () => {
      const rect = anchor.getBoundingClientRect();
      const margin = 8;
      const gap = 8;
      const frame = dialog?.getBoundingClientRect();
      const originX = frame && dialog ? frame.left + dialog.clientLeft - dialog.scrollLeft : 0;
      const originY = frame && dialog ? frame.top + dialog.clientTop - dialog.scrollTop : 0;
      const left = Math.max(0, frame && dialog ? frame.left + dialog.clientLeft : 0);
      const right = Math.min(
        window.innerWidth,
        frame && dialog ? frame.left + dialog.clientLeft + dialog.clientWidth : window.innerWidth,
      );
      const top = Math.max(0, frame && dialog ? frame.top + dialog.clientTop : 0);
      const bottom = Math.min(
        window.innerHeight,
        frame && dialog ? frame.top + dialog.clientTop + dialog.clientHeight : window.innerHeight,
      );
      const width = Math.min(
        preferredWidth === 'anchor' ? Math.max(240, rect.width) : preferredWidth,
        Math.max(1, right - left - margin * 2),
      );
      const above = Math.max(0, rect.top - gap - top - margin);
      const below = Math.max(0, bottom - rect.bottom - gap - margin);
      const placeAbove = above >= below;
      setPosition({
        left: Math.max(left + margin, Math.min(rect.left, right - width - margin)) - originX,
        width,
        maxHeight: placeAbove ? above : below,
        ...(placeAbove
          ? { bottom: (dialog?.clientHeight ?? window.innerHeight) - rect.top + gap + originY }
          : { top: rect.bottom + gap - originY }),
      });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
    observer?.observe(anchor);
    if (dialog) observer?.observe(dialog);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      observer?.disconnect();
    };
  }, [anchorRef, preferredWidth]);

  const ready = position !== undefined;
  useLayoutEffect(() => {
    if (ready) initialFocusRef?.current?.focus();
  }, [ready, initialFocusRef, container]);

  return createPortal(
    <div
      {...props}
      ref={panelRef}
      className={cn(
        'fixed z-50 overflow-y-auto overscroll-contain border border-border bg-popover p-3 text-popover-foreground shadow-lg',
        className,
      )}
      style={{
        ...position,
        position: container && container !== document.body ? 'absolute' : 'fixed',
        visibility: ready ? 'visible' : 'hidden',
      }}
    >
      {children}
    </div>,
    container ?? document.body,
  );
}

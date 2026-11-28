import type { ComponentPropsWithoutRef, RefObject } from 'react';
import { cn } from '@/lib/utils';
import { ComposerPopover } from './composer-popover';

/**
 * A composer chip's panel: a popover anchored to the chip in the toolbar, or, inside the phone's
 * Run settings dialog (`inline`), a block under the chip, where a popover would be clipped by the
 * dialog's own bounds.
 */
export function ChipPanel({
  inline,
  anchorRef,
  panelRef,
  initialFocusRef,
  width,
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<'div'> & {
  inline: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  panelRef: RefObject<HTMLDivElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  width: number;
}) {
  if (inline)
    return (
      <div
        {...props}
        ref={panelRef}
        className={cn(
          'mt-1.5 w-full border border-border bg-popover p-2 text-popover-foreground',
          className,
        )}
      >
        {children}
      </div>
    );
  return (
    <ComposerPopover
      {...props}
      anchorRef={anchorRef}
      panelRef={panelRef}
      initialFocusRef={initialFocusRef}
      width={width}
      className={className}
    >
      {children}
    </ComposerPopover>
  );
}

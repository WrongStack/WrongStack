import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cva, type VariantProps } from 'class-variance-authority';
import { X } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Sheet — a side-anchored overlay built on Radix Dialog.
 *
 * The WebUI previously hand-rolled every side panel (FleetMonitor,
 * AgentsMonitor, QueuePanel) as a `fixed inset-0` backdrop with bespoke
 * Escape handling, focus management, and animation — none of which were
 * accessible (no focus trap, no aria-modal, no focus restore). Routing them
 * through Radix Dialog gives us all of that for free.
 *
 * Unlike the centered `Dialog`, a `Sheet` slides in from one screen edge and
 * is full-height, matching the existing FleetMonitor / AgentsMonitor UX.
 */
const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
const SheetClose = DialogPrimitive.Close;
const SheetPortal = DialogPrimitive.Portal;

const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn('ws-sheet-overlay fixed inset-0 z-50 bg-black/50 backdrop-blur-sm', className)}
    {...props}
  />
));
SheetOverlay.displayName = DialogPrimitive.Overlay.displayName;

const sheetVariants = cva('ws-sheet-content fixed z-50 gap-4 bg-card shadow-2xl', {
  variants: {
    side: {
      top: 'inset-x-0 top-0 border-b',
      bottom: 'inset-x-0 bottom-0 border-t',
      left: 'inset-y-0 left-0 h-full w-3/4 border-r sm:max-w-md',
      right: 'inset-y-0 right-0 h-full w-3/4 border-l sm:max-w-md',
    },
  },
  defaultVariants: { side: 'right' },
});

interface SheetContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>,
    VariantProps<typeof sheetVariants> {
  /** Render the dimming backdrop. Non-modal inspector drawers disable it so
   *  the workspace remains visible and interactive underneath. */
  showOverlay?: boolean | undefined;
  /** Render the primitive's default top-right close button. Complex drawers
   *  normally provide a labelled close action in their own header. */
  showCloseButton?: boolean | undefined;
}

const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  SheetContentProps
>(
  (
    { side = 'right', className, children, showOverlay = true, showCloseButton = true, ...props },
    ref,
  ) => (
    <SheetPortal>
      {showOverlay ? <SheetOverlay /> : null}
      <DialogPrimitive.Content
        ref={ref}
        data-side={side}
        className={cn(sheetVariants({ side }), className)}
        {...props}
      >
        {children}
        {showCloseButton ? (
          <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none">
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </SheetPortal>
  ),
);
SheetContent.displayName = DialogPrimitive.Content.displayName;

const SheetHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col space-y-1.5 text-left p-4 border-b', className)} {...props} />
);
SheetHeader.displayName = 'SheetHeader';

const SheetTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-base font-semibold leading-none', className)}
    {...props}
  />
));
SheetTitle.displayName = DialogPrimitive.Title.displayName;

const SheetDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-xs text-muted-foreground', className)}
    {...props}
  />
));
SheetDescription.displayName = DialogPrimitive.Description.displayName;

export { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle };

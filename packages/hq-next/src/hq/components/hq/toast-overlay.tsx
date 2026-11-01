/**
 * Toast overlay — transient notices, bottom-right, above everything.
 *
 * Rendered once by the shell. Entries expire on their own timer inside the
 * store; this component only paints them.
 */
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react';
import type * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { type ToastSeverity, useToastStore } from '../../data/toast-store.js';
import { cn } from '../../lib/utils.js';

const SEVERITY = {
  error: { icon: CircleAlert, className: 'border-destructive/40 text-destructive' },
  warning: { icon: TriangleAlert, className: 'border-warning/40 text-warning' },
  success: { icon: CircleCheck, className: 'border-success/40 text-success' },
  info: { icon: Info, className: 'border-info/40 text-info' },
} satisfies Record<ToastSeverity, { icon: React.ElementType; className: string }>;

export function ToastOverlay(): React.ReactElement | null {
  const { toasts, removeToast } = useToastStore(
    useShallow((state) => ({ toasts: state.toasts, removeToast: state.removeToast })),
  );

  if (toasts.length === 0) return null;

  return (
    <div
      data-testid="toast-overlay"
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-80 flex-col gap-2"
    >
      {toasts.map((toast) => {
        const { icon: Icon, className } = SEVERITY[toast.severity];
        return (
          <div
            key={toast.id}
            data-testid="toast"
            data-severity={toast.severity}
            className={cn(
              'pointer-events-auto flex items-start gap-2 border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg animate-in slide-in-from-right-4 fade-in-0',
              className,
            )}
          >
            <Icon className="mt-px size-3.5 shrink-0" />
            <span className="flex-1 text-foreground">{toast.message}</span>
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => removeToast(toast.id)}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * EmptyState — consistent placeholder for detail views when no item is selected.
 *
 * Renders a centered card with an optional icon, title, description, and
 * an optional action button. Replaces ad hoc empty states across Files,
 * Changes, Mailbox, and Skills views.
 */

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface EmptyStateAction {
  label: string;
  onClick: () => void;
}

interface EmptyStateProps {
  /** Icon component (lucide-react element). Rendered in a tinted circle. */
  icon?: ReactNode;
  /** Primary heading. */
  title: string;
  /** Secondary description. */
  description?: string;
  /** Optional action button. */
  action?: EmptyStateAction;
  /** Additional classes for the outer wrapper. */
  className?: string;
  /** When true, adds a softer background tint (used in panel contexts). */
  panel?: boolean;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  panel = true,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex min-h-0 min-w-0 flex-1 items-center justify-center p-4',
        panel && 'bg-[hsl(var(--surface-2)/0.45)]',
        className,
      )}
    >
      <div className="ws-surface flex max-w-md flex-col items-center gap-3 rounded-xl p-6 text-center text-muted-foreground">
        {icon && (
          <span className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10 text-primary">
            {icon}
          </span>
        )}
        <div>
          <p className="text-base font-semibold text-foreground">{title}</p>
          {description && <p className="mt-1 text-sm">{description}</p>}
        </div>
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            className="mt-1 rounded-md border border-border/70 bg-card/70 px-4 py-2 text-sm text-foreground shadow-sm transition-colors hover:bg-accent"
          >
            {action.label}
          </button>
        )}
      </div>
    </div>
  );
}

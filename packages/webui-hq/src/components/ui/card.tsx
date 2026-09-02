import type * as React from 'react';
import { cn } from '../../lib/utils.js';

type DivProps = React.HTMLAttributes<HTMLDivElement>;

export function Card({ className, ...props }: DivProps): React.ReactElement {
  return (
    <div
      data-slot="card"
      className={cn('flex flex-col border border-border bg-card text-card-foreground', className)}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: DivProps): React.ReactElement {
  return (
    <div
      data-slot="card-header"
      className={cn(
        'flex items-center gap-2 border-b border-border px-3 py-2 [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: DivProps): React.ReactElement {
  return (
    <div
      data-slot="card-title"
      className={cn(
        'font-display text-[11px] font-semibold uppercase tracking-[0.09em] text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

export function CardDescription({ className, ...props }: DivProps): React.ReactElement {
  return (
    <div
      data-slot="card-description"
      className={cn('text-xs text-muted-foreground', className)}
      {...props}
    />
  );
}

/** Pushes trailing header content (counts, actions) to the right edge. */
export function CardAction({ className, ...props }: DivProps): React.ReactElement {
  return (
    <div
      data-slot="card-action"
      className={cn('ml-auto flex items-center gap-1.5', className)}
      {...props}
    />
  );
}

export function CardContent({ className, ...props }: DivProps): React.ReactElement {
  return <div data-slot="card-content" className={cn('p-3', className)} {...props} />;
}

export function CardFooter({ className, ...props }: DivProps): React.ReactElement {
  return (
    <div
      data-slot="card-footer"
      className={cn('flex items-center gap-2 border-t border-border px-3 py-2', className)}
      {...props}
    />
  );
}

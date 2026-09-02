import type * as React from 'react';
import { cn } from '../../lib/utils.js';

const FIELD =
  'w-full border border-input bg-background px-2.5 py-1.5 text-sm text-foreground shadow-none transition-colors placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50';

export function Input({
  className,
  type = 'text',
  ...props
}: React.ComponentProps<'input'>): React.ReactElement {
  return <input data-slot="input" type={type} className={cn(FIELD, 'h-9', className)} {...props} />;
}

export function Textarea({
  className,
  ...props
}: React.ComponentProps<'textarea'>): React.ReactElement {
  return (
    <textarea
      data-slot="textarea"
      className={cn(FIELD, 'min-h-20 resize-y font-mono text-xs leading-relaxed', className)}
      {...props}
    />
  );
}

/**
 * Native select. Radix Select is used where the list needs search, icons or
 * grouping; a plain picker does not need a portal and a listbox.
 */
export function Select({
  className,
  ...props
}: React.ComponentProps<'select'>): React.ReactElement {
  return <select data-slot="select" className={cn(FIELD, 'h-9 pr-8', className)} {...props} />;
}

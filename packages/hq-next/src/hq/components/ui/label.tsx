import * as LabelPrimitive from '@radix-ui/react-label';
import type * as React from 'react';
import { cn } from '../../lib/utils.js';

export function Label({
  className,
  ...props
}: React.ComponentProps<typeof LabelPrimitive.Root>): React.ReactElement {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        'text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground select-none peer-disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

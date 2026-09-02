import type * as React from 'react';
import { cn } from '../../lib/utils.js';

export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return (
    <div data-slot="skeleton" className={cn('animate-pulse bg-muted', className)} {...props} />
  );
}

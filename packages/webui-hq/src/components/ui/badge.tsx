import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';
import { cn } from '../../lib/utils.js';

/**
 * Badge — the workhorse of this dashboard (the old CSS had 73 `.hq-pill`
 * sites). Variants are SEMANTIC, not colours: callers pass what a value means
 * and the token layer decides how it looks in light and dark.
 */
export const badgeVariants = cva(
  'inline-flex items-center gap-1 border px-1.5 py-0.5 text-[11px] font-medium leading-none whitespace-nowrap transition-colors [&_svg]:size-3 [&_svg]:shrink-0',
  {
    variants: {
      tone: {
        neutral: 'border-border bg-secondary text-secondary-foreground',
        idle: 'border-border bg-transparent text-muted-foreground',
        info: 'border-info/30 bg-info/10 text-info',
        active: 'border-success/30 bg-success/10 text-success',
        running: 'border-primary/35 bg-primary/10 text-primary',
        warn: 'border-warning/35 bg-warning/10 text-warning',
        error: 'border-destructive/35 bg-destructive/10 text-destructive',
        outline: 'border-border bg-transparent text-foreground',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>['tone']>;

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  asChild?: boolean;
}

export function Badge({ className, tone, asChild = false, ...props }: BadgeProps): React.ReactElement {
  const Comp = asChild ? Slot : 'span';
  return <Comp data-slot="badge" className={cn(badgeVariants({ tone }), className)} {...props} />;
}

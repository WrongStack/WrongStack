import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';
import { cn } from '../lib/utils';

/**
 * HueChip — the single owner of the "sub-12px status hue" pattern.
 *
 * Design-brief rule (.design/brief.md acceptance): below 12px, status hues
 * ride on background tints or icons — NEVER on text color. Brand-signal
 * palettes swap only --primary (and its derivatives), so hue-as-text both
 * fails AA in some palettes/modes and shifts hue per palette. This primitive
 * keeps the tone visible via a bg tint (and an optional tone-colored icon)
 * while the text itself stays neutral, so contrast is palette-immune.
 */
const hueChipVariants = cva(
  'inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium whitespace-nowrap',
  {
    variants: {
      tone: {
        primary: 'bg-primary/15 text-foreground',
        info: 'bg-info/15 text-foreground',
        warning: 'bg-warning/15 text-foreground',
        success: 'bg-success/15 text-foreground',
        destructive: 'bg-destructive/15 text-foreground',
      },
    },
    defaultVariants: {
      tone: 'primary',
    },
  },
);

const hueChipIconVariants = cva('shrink-0', {
  variants: {
    tone: {
      primary: 'text-primary',
      info: 'text-info',
      warning: 'text-warning',
      success: 'text-success',
      destructive: 'text-destructive',
    },
  },
  defaultVariants: {
    tone: 'primary',
  },
});

interface HueChipProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof hueChipVariants> {
  /** Optional icon rendered in the tone color (hues ride on icons). */
  icon?: React.ReactNode;
}

function HueChip({ className, tone, icon, children, ...props }: HueChipProps) {
  return (
    <span className={cn(hueChipVariants({ tone }), className)} {...props}>
      {icon ? (
        <span className={cn(hueChipIconVariants({ tone }), 'inline-flex')}>{icon}</span>
      ) : null}
      {children}
    </span>
  );
}

export { HueChip, type HueChipProps };

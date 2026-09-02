/**
 * The shared skeleton every view is built from: a padded column, a hero strip
 * with headline metrics, and titled sections.
 *
 * Views used to hand-roll this with a dozen `hq-screen-*` classes each, which
 * is exactly how the twelve surfaces drifted apart. One set of components
 * means one set of paddings, one type scale and one metric row.
 */
import type * as React from 'react';
import type { HqTone } from '../../domain/status-tone.js';
import { cn } from '../../lib/utils.js';
import { toneText } from './primitives.js';

export function ViewShell({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div data-testid="view-shell" className={cn('flex flex-col gap-5 p-4', className)}>
      {children}
    </div>
  );
}

export function ViewHero({
  eyebrow,
  headline,
  description,
  metrics,
  actions,
  tone,
}: {
  eyebrow: string;
  headline: React.ReactNode;
  description?: React.ReactNode;
  metrics?: React.ReactNode;
  actions?: React.ReactNode;
  /** Colours the left rule — the view's one-glance health signal. */
  tone?: HqTone;
}): React.ReactElement {
  return (
    <section
      data-testid="view-hero"
      data-tone={tone}
      aria-label={`${eyebrow} summary`}
      className={cn(
        'flex flex-wrap items-start gap-x-8 gap-y-4 border-l-2 bg-card/40 py-1 pl-4',
        tone === 'error'
          ? 'border-destructive'
          : tone === 'warn'
            ? 'border-warning'
            : tone === 'active'
              ? 'border-success'
              : 'border-primary',
      )}
    >
      <div className="min-w-56 flex-1 space-y-1">
        <span className="font-display text-[10px] font-semibold uppercase tracking-[0.11em] text-muted-foreground">
          {eyebrow}
        </span>
        <h2 className="tabular font-display text-2xl leading-none">{headline}</h2>
        {description !== undefined && (
          <p className="max-w-prose text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      {metrics !== undefined && <div className="flex flex-wrap gap-x-7 gap-y-3">{metrics}</div>}
      {actions !== undefined && <div className="flex items-center gap-2">{actions}</div>}
    </section>
  );
}

/** A hero figure. Smaller than a StatTile and always right of the headline. */
export function HeroMetric({
  label,
  value,
  tone = 'idle',
}: {
  label: string;
  value: React.ReactNode;
  tone?: HqTone;
}): React.ReactElement {
  return (
    <div data-testid="hero-metric" className="flex flex-col gap-0.5">
      <span className={cn('tabular font-display text-lg leading-none', toneText(tone))}>
        {value}
      </span>
      <span className="text-[10px] uppercase tracking-[0.09em] text-muted-foreground">{label}</span>
    </div>
  );
}

export function Section({
  eyebrow,
  title,
  action,
  children,
  className,
}: {
  eyebrow?: string;
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <section data-testid="view-section" className={cn('space-y-2', className)} aria-label={title}>
      <div className="flex items-end gap-2">
        <div className="space-y-0.5">
          {eyebrow !== undefined && (
            <span className="font-display text-[10px] font-semibold uppercase tracking-[0.11em] text-muted-foreground">
              {eyebrow}
            </span>
          )}
          <h3 className="font-display text-sm font-semibold leading-none">{title}</h3>
        </div>
        {action !== undefined && <div className="ml-auto flex items-center gap-2">{action}</div>}
      </div>
      {children}
    </section>
  );
}

/** A proportion bar — used for cost share, token share, queue mix. */
export function ShareBar({
  fraction,
  tone = 'running',
  className,
}: {
  /** 0..1; values outside are clamped. */
  fraction: number;
  tone?: HqTone;
  className?: string;
}): React.ReactElement {
  const percent = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0)) * 100;
  const fill =
    tone === 'error'
      ? 'bg-destructive'
      : tone === 'warn'
        ? 'bg-warning'
        : tone === 'active'
          ? 'bg-success'
          : tone === 'info'
            ? 'bg-info'
            : 'bg-primary';
  return (
    <div
      data-testid="share-bar"
      role="presentation"
      className={cn('h-1 w-full bg-secondary', className)}
    >
      <div className={cn('h-full transition-[width]', fill)} style={{ width: `${percent}%` }} />
    </div>
  );
}

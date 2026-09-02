/**
 * Small HQ-specific compositions used across every view.
 *
 * These are not shadcn primitives — they are the recurring *shapes* of this
 * dashboard: an empty pane, a liveness dot, a labelled number, a copy button.
 * Keeping them here stops each view from re-inventing the same three divs.
 */
import { Check, Copy, type LucideIcon } from 'lucide-react';
import type * as React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { HqTone } from '../../domain/status-tone.js';
import { cn } from '../../lib/utils.js';
import { Button } from '../ui/button.js';

const TONE_BG: Record<HqTone, string> = {
  active: 'bg-success',
  info: 'bg-info',
  running: 'bg-primary',
  warn: 'bg-warning',
  error: 'bg-destructive',
  idle: 'bg-muted-foreground/50',
};

const TONE_TEXT: Record<HqTone, string> = {
  active: 'text-success',
  info: 'text-info',
  running: 'text-primary',
  warn: 'text-warning',
  error: 'text-destructive',
  idle: 'text-muted-foreground',
};

export function toneText(tone: HqTone): string {
  return TONE_TEXT[tone];
}

/** A liveness dot. `pulse` marks something actually moving right now. */
export function StatusDot({
  tone,
  pulse = false,
  className,
}: {
  tone: HqTone;
  pulse?: boolean;
  className?: string;
}): React.ReactElement {
  return (
    <span
      data-testid="status-dot"
      data-tone={tone}
      className={cn(
        'inline-block size-1.5 shrink-0',
        TONE_BG[tone],
        pulse && 'animate-pulse',
        className,
      )}
    />
  );
}

/**
 * Empty pane. Every view uses the same one, so "nothing here" always looks
 * deliberate rather than broken.
 */
export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  hint?: string;
  action?: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div
      data-testid="empty-state"
      className={cn(
        'flex flex-col items-center justify-center gap-2 border border-dashed border-border/70 px-6 py-10 text-center',
        className,
      )}
    >
      {Icon !== undefined && <Icon className="size-5 text-muted-foreground/60" />}
      <p className="text-xs font-medium text-foreground">{title}</p>
      {hint !== undefined && <p className="max-w-sm text-[11px] text-muted-foreground">{hint}</p>}
      {action}
    </div>
  );
}

/** A labelled figure. The number is tabular so columns of them line up. */
export function StatTile({
  label,
  value,
  hint,
  tone = 'idle',
  className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: HqTone;
  className?: string;
}): React.ReactElement {
  return (
    <div data-testid="stat-tile" className={cn('flex flex-col gap-0.5', className)}>
      <span
        data-testid="stat-label"
        className="text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-foreground"
      >
        {label}
      </span>
      <span
        data-testid="stat-value"
        className={cn('tabular font-display text-xl leading-none', TONE_TEXT[tone])}
      >
        {value}
      </span>
      {hint !== undefined && <span className="text-[10px] text-muted-foreground">{hint}</span>}
    </div>
  );
}

/** Section eyebrow — the small uppercase label above a group of content. */
export function Kicker({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div
      className={cn(
        'font-display text-[10px] font-semibold uppercase tracking-[0.11em] text-muted-foreground',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Copy-to-clipboard, flashing a tick. Silently does nothing without a clipboard. */
export function CopyButton({
  value,
  label = 'Copy',
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(() => {
    void navigator.clipboard
      ?.writeText(value)
      .then(() => {
        setCopied(true);
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1_200);
      })
      .catch(() => undefined);
  }, [value]);

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      onClick={copy}
      aria-label={label}
      title={label}
      data-testid="copy-button"
      className={className}
    >
      {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
    </Button>
  );
}

/** Monospace inline value — ids, paths, hashes. */
export function Mono({
  children,
  className,
  title,
}: {
  children: React.ReactNode;
  className?: string;
  title?: string;
}): React.ReactElement {
  return (
    <span title={title} className={cn('font-mono text-[11px] text-muted-foreground', className)}>
      {children}
    </span>
  );
}

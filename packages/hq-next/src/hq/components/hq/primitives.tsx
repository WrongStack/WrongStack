/**
 * Small HQ-specific compositions used across every view.
 *
 * These are not shadcn primitives — they are the recurring *shapes* of this
 * dashboard: an empty pane, a copy button, monospace text.
 * Keeping them here stops each view from re-inventing the same three divs.
 */
import { Check, Copy } from 'lucide-react';
import type * as React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { HqTone } from '../../domain/status-tone.js';
import { cn } from '../../lib/utils.js';
import { Button } from '../ui/button.js';

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

/**
 * EmptyState — consistent placeholder for detail views when no item is selected.
 *
 * Renders a centered card with an optional icon, title, description, and
 * an optional action button. Replaces ad hoc empty states across Files,
 * Changes, Mailbox, and Skills views.
 */

import type { ReactNode } from 'react';
import { cn } from '../lib/utils';
import { Button } from './button';
import './terminal-motifs.css';

interface EmptyStateAction {
  label: string;
  onClick: () => void;
}

interface EmptyStateProps {
  /** Icon component (lucide-react element), framed by a decorative vector. */
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
  /**
   * Terminal motif (2026-10-20 brief amendment): renders an ASCII-art frame
   * with a blinking cursor and grid backdrop instead of the vector art, for
   * code/terminal surfaces where the developer aesthetic serves state.
   */
  motif?: 'terminal';
}

/** Decorative ASCII frame — generic, untranslated, always aria-hidden. */
const TERMINAL_ASCII = '┌─────────────┐\n│  · empty ·  │\n└─────────────┘';

export function EmptyState({
  icon,
  title,
  description,
  action,
  motif,
  className,
  panel = true,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex h-full min-h-0 min-w-0 flex-1 items-center justify-center p-4',
        panel && 'bg-[hsl(var(--surface-2)/0.45)]',
        motif === 'terminal' && 'ws-term-grid',
        className,
      )}
    >
      <div className="ws-empty-state flex w-full max-w-md flex-col items-center gap-4 p-5 sm:p-8 text-center text-muted-foreground">
        {motif === 'terminal' ? (
          <span className="flex flex-col items-center gap-1" aria-hidden="true">
            <pre className="ws-term-ascii m-0 text-[11px] leading-tight text-muted-foreground/80">
              {TERMINAL_ASCII}
            </pre>
            <span className="font-mono text-sm text-primary">
              &gt;
              <span className="ws-term-cursor" />
            </span>
          </span>
        ) : (
          icon && (
            <span className="ws-empty-art" aria-hidden="true">
              <svg viewBox="0 0 120 96" fill="none" aria-hidden="true" focusable="false">
                <path
                  d="M4 48h20m72 0h20M60 4v12m0 64v12"
                  stroke="currentColor"
                  opacity="0.25"
                  strokeDasharray="2 4"
                />
                <rect
                  x="30"
                  y="18"
                  width="60"
                  height="60"
                  rx="18"
                  stroke="currentColor"
                  opacity="0.15"
                  transform="rotate(-12 60 48)"
                />
                <rect
                  x="34"
                  y="22"
                  width="52"
                  height="52"
                  rx="14"
                  fill="currentColor"
                  fillOpacity="0.06"
                  stroke="currentColor"
                  strokeOpacity="0.3"
                />
                <circle cx="22" cy="24" r="3" fill="currentColor" opacity="0.4" />
                <path d="M99 68v8m-4-4h8" stroke="currentColor" opacity="0.5" />
              </svg>
              <span className="ws-empty-art-icon">{icon}</span>
            </span>
          )
        )}
        <div>
          <p className="text-base font-semibold text-foreground">{title}</p>
          {description && <p className="mt-2 text-sm leading-relaxed">{description}</p>}
        </div>
        {action && (
          <Button type="button" variant="outline" onClick={action.onClick} className="mt-1">
            {action.label}
          </Button>
        )}
      </div>
    </div>
  );
}

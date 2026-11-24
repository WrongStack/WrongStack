'use client';

/** Layout pieces and the one async-action pattern every vault panel uses. */
import type { ReactNode } from 'react';
import { useCallback, useId, useState } from 'react';
import { cn } from '@/lib/cn';
import { errorText } from '@/lib/error-text';

export const field =
  'h-10 w-full border border-border bg-background px-3 text-sm disabled:opacity-60';
export const label = 'text-sm font-medium';
export const smallButton =
  'inline-flex h-8 items-center border border-border px-2.5 text-xs hover:bg-muted disabled:opacity-50';
export const primaryButton =
  'h-10 self-start bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50';
export const dangerButton =
  'inline-flex h-8 items-center border border-destructive/60 px-2.5 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50';

export function VaultSection({
  title,
  description,
  children,
  actions,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  actions?: ReactNode;
}): ReactNode {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4 border-t border-border pt-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 id={id} className="text-lg font-semibold">
            {title}
          </h2>
          {description !== undefined && (
            <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

export interface VaultMessage {
  tone: 'ok' | 'error';
  text: string;
}

export function MessageLine({ message }: { message: VaultMessage | null }): ReactNode {
  if (message === null) return null;
  return (
    <p
      role={message.tone === 'error' ? 'alert' : 'status'}
      className={cn('text-sm', message.tone === 'ok' ? 'text-success' : 'text-destructive')}
    >
      {message.text}
    </p>
  );
}

/**
 * Run one mutation at a time with a message slot: `run(fn, okText)` clears the
 * last message, marks busy, reports the server's own error text on failure.
 */
export function useVaultAction(): {
  busy: boolean;
  message: VaultMessage | null;
  setMessage: (message: VaultMessage | null) => void;
  run: (fn: () => Promise<void>, okText?: string) => Promise<boolean>;
} {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<VaultMessage | null>(null);
  const run = useCallback(async (fn: () => Promise<void>, okText?: string): Promise<boolean> => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      if (okText !== undefined) setMessage({ tone: 'ok', text: okText });
      return true;
    } catch (cause) {
      setMessage({ tone: 'error', text: errorText(cause) });
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, message, setMessage, run };
}

/** A fingerprint in its 8 groups, monospaced, wrapping only between groups. */
export function Fingerprint({ value }: { value: string }): ReactNode {
  return (
    <span className="font-mono text-xs tracking-tight" title="Compare with the device">
      {value.split('-').map((group, index) => (
        <span key={`${index}-${group}`} className="inline-block pr-1">
          {group}
        </span>
      ))}
    </span>
  );
}

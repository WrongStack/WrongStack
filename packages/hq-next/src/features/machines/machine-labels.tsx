'use client';

/**
 * Operator labels on a machine ("prod", "gpu", "eu"): shown as chips, edited
 * in place as one line of words, on the desktop and on the phone (both need
 * `control.enqueue`, as the server does). The server normalises and validates
 * them; the snapshot broadcast brings the saved labels back to every
 * dashboard.
 */
import { setMachineLabels } from '@hq/data/api';
import {
  credentialAllows,
  useCredentialCapabilities,
} from '@hq/domain/use-credential-capabilities';
import { Tag } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useId, useState } from 'react';
import { cn } from '@/lib/cn';
import { errorText } from '@/lib/error-text';

/** "prod, gpu  eu" → ["prod", "gpu", "eu"]; the server does the rest. */
function splitLabels(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((word) => word.trim())
    .filter((word) => word !== '');
}

export function LabelChips({
  labels,
  className,
}: {
  labels: readonly string[];
  className?: string;
}): ReactNode {
  if (labels.length === 0) return null;
  return (
    <span className={cn('flex flex-wrap gap-1', className)}>
      {labels.map((label) => (
        <span
          key={label}
          className="border border-border px-1.5 font-mono text-xs text-muted-foreground"
        >
          {label}
        </span>
      ))}
    </span>
  );
}

/**
 * The filter above a machine list: every label in use with its count, as
 * links that set `?label=` (and "All", which clears it).
 */
export function LabelFilter({
  counts,
  current,
  hrefFor,
}: {
  counts: readonly { label: string; count: number }[];
  current: string | null;
  hrefFor: (label: string | null) => string;
}): ReactNode {
  if (counts.length === 0) return null;
  const chip = (active: boolean) =>
    cn(
      'inline-flex h-8 items-center gap-1.5 border px-2.5 text-sm',
      active ? 'border-primary/60 bg-muted text-foreground' : 'border-border text-muted-foreground',
    );
  return (
    <nav aria-label="Filter machines by label" className="flex flex-wrap gap-2">
      <Link
        href={hrefFor(null)}
        aria-current={current === null ? 'true' : undefined}
        className={chip(current === null)}
        scroll={false}
      >
        All
      </Link>
      {counts.map(({ label, count }) => (
        <Link
          key={label}
          href={hrefFor(label)}
          aria-current={current === label ? 'true' : undefined}
          data-label-filter={label}
          className={chip(current === label)}
          scroll={false}
        >
          <span className="font-mono">{label}</span>
          <span className="tabular text-xs">{count}</span>
        </Link>
      ))}
    </nav>
  );
}

/** Labels of one machine, with an editor for credentials that may change them. */
export function MachineLabelsEditor({
  machineKey,
  labels,
}: {
  machineKey: string;
  labels: readonly string[];
}): ReactNode {
  const mayEdit = credentialAllows(useCredentialCapabilities(), 'control.enqueue');
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();

  const save = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      await setMachineLabels(machineKey, splitLabels(text));
      setEditing(false);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-2" data-testid="machine-labels">
      <h4 className="flex items-center gap-2 text-sm font-semibold">
        <Tag className="size-4 text-muted-foreground" aria-hidden />
        Labels
      </h4>
      {editing ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label htmlFor={inputId} className="text-xs text-muted-foreground">
            Words separated by spaces or commas: letters, digits, dot, dash or underscore, up to 8.
          </label>
          <input
            id={inputId}
            value={text}
            onChange={(event) => setText(event.target.value)}
            maxLength={300}
            autoComplete="off"
            spellCheck={false}
            className="h-9 border border-border bg-background px-2 font-mono text-sm"
          />
          {error !== null && (
            <p role="alert" className="text-sm text-destructive">
              The labels were not saved: {error}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={pending}
              className="inline-flex h-9 items-center border border-border bg-muted px-3 text-sm font-medium hover:ring-2 hover:ring-ring disabled:opacity-60"
            >
              {pending ? 'Saving…' : 'Save labels'}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setEditing(false);
                setError(null);
              }}
              className="inline-flex h-9 items-center px-3 text-sm text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {labels.length === 0 ? (
            <span className="text-sm text-muted-foreground">No labels.</span>
          ) : (
            <LabelChips labels={labels} />
          )}
          {mayEdit && (
            <button
              type="button"
              onClick={() => {
                setText(labels.join(' '));
                setEditing(true);
              }}
              className="inline-flex h-8 items-center border border-border px-2.5 text-sm hover:bg-muted"
            >
              {labels.length === 0 ? 'Add labels' : 'Edit labels'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

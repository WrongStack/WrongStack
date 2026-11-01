'use client';

/**
 * Mint a client token for a new machine without a shell on the HQ host. The
 * secret comes back once and is handed to the caller, which puts it into the
 * ready-to-paste `/hq set` line. Needs `auth.admin`; without it the caller
 * falls back to the CLI step.
 */
import { mintMachineToken } from '@hq/data/api';
import { KeyRound } from 'lucide-react';
import type { ReactNode } from 'react';
import { useId, useState } from 'react';
import { errorText } from '@/lib/error-text';

const EXPIRY = [
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '1 year' },
  { days: 0, label: 'Never' },
];

const field = 'h-10 w-full border border-border bg-background px-3 text-sm disabled:opacity-60';

export interface MintedToken {
  token: string;
  label: string;
  expiresAt?: string;
  shell: boolean;
}

export function MachineTokenForm({
  onMinted,
}: {
  onMinted: (token: MintedToken) => void;
}): ReactNode {
  const id = useId();
  const [label, setLabel] = useState('');
  const [ttlDays, setTtlDays] = useState(90);
  const [allowShell, setAllowShell] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mint = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await mintMachineToken({ label: label.trim(), ttlDays, allowShell });
      onMinted({
        token: result.token,
        label: label.trim(),
        ...(result.expiresAt !== undefined ? { expiresAt: result.expiresAt } : {}),
        shell: allowShell,
      });
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-3"
      data-testid="machine-token-form"
      onSubmit={(event) => {
        event.preventDefault();
        void mint();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-label`} className="text-sm font-medium">
            Machine name
          </label>
          <input
            id={`${id}-label`}
            className={field}
            value={label}
            maxLength={80}
            placeholder="LAB-02"
            onChange={(event) => setLabel(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-ttl`} className="text-sm font-medium">
            Expires after
          </label>
          <select
            id={`${id}-ttl`}
            className={field}
            value={ttlDays}
            onChange={(event) => setTtlDays(Number(event.target.value))}
          >
            {EXPIRY.map((entry) => (
              <option key={entry.days} value={entry.days}>
                {entry.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={allowShell}
          onChange={(event) => setAllowShell(event.target.checked)}
        />
        <span>
          Let HQ run shell commands on this machine{' '}
          <span className="text-muted-foreground">
            (control.execute). Leave it off unless you need remote shell; steering, approvals and
            telemetry work without it.
          </span>
        </span>
      </label>
      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div>
        <button
          type="submit"
          disabled={busy || label.trim() === ''}
          className="inline-flex h-9 items-center gap-2 bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
        >
          <KeyRound className="size-4" />
          {busy ? 'Creating…' : 'Create a token'}
        </button>
      </div>
    </form>
  );
}

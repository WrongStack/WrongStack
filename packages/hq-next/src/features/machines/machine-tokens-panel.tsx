'use client';

/**
 * The client tokens machines use to reach HQ: who they were made for, when
 * they expire, when they were last used and whether they allow remote shell.
 * Revoking one disconnects the machine using it within seconds. Admin only —
 * for any other sign-in the panel stays hidden.
 */
import { fetchMachineTokens, type MachineTokenRow, revokeMachineToken } from '@hq/data/api';
import { KeyRound } from 'lucide-react';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { relativeTime } from '@/features/attention/model';
import { cn } from '@/lib/cn';
import { errorText } from '@/lib/error-text';

const button =
  'inline-flex h-8 items-center border border-border px-2.5 text-xs hover:bg-muted disabled:opacity-60';

export function MachineTokensPanel({ now }: { now: number }): ReactNode {
  const [rows, setRows] = useState<MachineTokenRow[] | null>(null);
  const [tokenMode, setTokenMode] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await fetchMachineTokens();
      setRows(next.tokens);
      setTokenMode(next.tokenMode);
    } catch {
      // Not an admin (or HQ is older): the panel is simply not offered.
      setRows(null);
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  if (rows === null) return null;
  return (
    <section
      className="flex flex-col gap-3"
      aria-label="Machine tokens"
      data-testid="machine-tokens"
    >
      <div className="flex flex-col gap-1">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <KeyRound className="size-4" />
          Machine tokens
        </h3>
        <p className="text-sm text-muted-foreground">
          {tokenMode
            ? 'Every machine needs one of these to reach HQ. Revoking a token disconnects the machine using it.'
            : 'HQ is open: machines can connect without a token until the first one is created.'}
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No machine token yet.</p>
      ) : (
        <ul className="flex flex-col border border-border">
          {rows.map((row) => (
            <TokenRow key={row.id} row={row} now={now} onChanged={load} />
          ))}
        </ul>
      )}
    </section>
  );
}

function TokenRow({
  row,
  now,
  onChanged,
}: {
  row: MachineTokenRow;
  now: number;
  onChanged: () => Promise<void>;
}): ReactNode {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shell = row.capabilities === null || row.capabilities.includes('control.execute');
  const revoke = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await revokeMachineToken(row.id);
      await onChanged();
    } catch (cause) {
      setError(errorText(cause));
      setBusy(false);
    }
  };
  return (
    <li
      className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-3 py-2 text-sm last:border-b-0"
      data-token={row.id}
    >
      <span className="min-w-0 flex-1">
        <span className="font-medium">{row.label ?? 'Unnamed'}</span>{' '}
        <span className="font-mono text-xs text-muted-foreground">{row.id.slice(0, 8)}</span>
        {shell && <span className="ml-2 text-xs text-warning">remote shell</span>}
      </span>
      <span className={cn('text-xs', row.expired ? 'text-destructive' : 'text-muted-foreground')}>
        {row.expired
          ? 'Expired'
          : row.expiresAt !== undefined
            ? `Expires ${new Date(row.expiresAt).toLocaleDateString()}`
            : 'No expiry'}
        {' · '}
        {row.lastUsedAt !== undefined ? `used ${relativeTime(row.lastUsedAt, now)}` : 'never used'}
      </span>
      {confirm ? (
        <span className="flex gap-2">
          <button
            type="button"
            disabled={busy}
            className={cn(button, 'border-destructive text-destructive')}
            onClick={() => void revoke()}
          >
            Revoke {row.label ?? 'token'}
          </button>
          <button type="button" className={button} onClick={() => setConfirm(false)}>
            Keep
          </button>
        </span>
      ) : (
        <button type="button" className={button} onClick={() => setConfirm(true)}>
          Revoke
        </button>
      )}
      {error !== null && (
        <span role="alert" className="w-full text-xs text-destructive">
          {error}
        </span>
      )}
    </li>
  );
}

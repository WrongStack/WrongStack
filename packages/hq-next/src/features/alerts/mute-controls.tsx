'use client';

/**
 * Mute one firing rule for a while, or unmute it. A muted rule stays listed
 * (so nobody forgets it is still true) but sends no notification and is not
 * re-evaluated until the mute ends. The server caps a mute at 24 hours.
 */
import { snoozeAlertRule, unsnoozeAlertRule } from '@hq/data/api';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { errorText } from '@/lib/error-text';

const OPTIONS = [
  { minutes: 60, label: '1 hour' },
  { minutes: 8 * 60, label: '8 hours' },
  { minutes: 24 * 60, label: '24 hours' },
];

const button =
  'inline-flex h-8 items-center border border-border px-2.5 text-xs hover:bg-muted disabled:opacity-60';

export function MuteControls({
  ruleId,
  until,
  now,
  onChanged,
}: {
  ruleId: string;
  until: number | undefined;
  now: number;
  onChanged: () => Promise<void>;
}): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (work: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await onChanged();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  const muted = until !== undefined && until > now;
  return (
    <div className="flex flex-wrap items-center gap-2 pt-1" data-mute={ruleId}>
      {muted ? (
        <>
          <span className="text-xs text-muted-foreground">
            Muted — no notifications until {new Date(until).toLocaleString()}
          </span>
          <button
            type="button"
            className={button}
            disabled={busy}
            onClick={() => void run(() => unsnoozeAlertRule(ruleId))}
          >
            Unmute
          </button>
        </>
      ) : (
        <>
          <span className="text-xs text-muted-foreground">Mute for</span>
          {OPTIONS.map((option) => (
            <button
              key={option.minutes}
              type="button"
              className={button}
              disabled={busy}
              onClick={() => void run(() => snoozeAlertRule(ruleId, option.minutes))}
            >
              {option.label}
            </button>
          ))}
        </>
      )}
      {error !== null && (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}

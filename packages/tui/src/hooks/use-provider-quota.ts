/**
 * useProviderQuota — the one quota number a status bar has room for.
 *
 * Subscription-metered providers report their remaining plan budget into the
 * provider-neutral store in `@wrongstack/core/quota`. A statusline chip cannot
 * show every window of every provider, so this hook reduces the store to the
 * single reading that would change what the user does next: the most-consumed
 * window anywhere, with its countdown.
 *
 * It subscribes rather than polling. Quota changes only when a request
 * completes, so a timer would either lag the reading or repaint a quiet
 * terminal for nothing — and this terminal stays quiet by directive.
 *
 * The countdown is deliberately NOT re-rendered every second. A reset is hours
 * away; ticking it once a second would repaint the whole status bar 3,600 times
 * to move one digit. The value is recomputed whenever a new reading lands,
 * which is exactly when it can have meaningfully changed.
 */

import {
  formatQuotaResetIn,
  getAllProviderQuota,
  onProviderQuota,
  quotaResetInMs,
  quotaWindowLabel,
  worstProviderQuotaWindow,
} from '@wrongstack/core/quota';
import { useEffect, useState } from 'react';

/** What the chip renders. Absent until some provider has reported. */
export interface ProviderQuotaChip {
  /** Provider that reported this window, e.g. `openai-codex`. */
  providerId: string;
  /** Window name: `5h`, `7d`, or the provider's own label. */
  windowLabel: string;
  usedPercent: number;
  /** `4h 12m`, when the provider published a reset time. */
  resetIn?: string | undefined;
  /** True when this window is the one currently cutting the account off. */
  reached: boolean;
}

function readWorst(): ProviderQuotaChip | undefined {
  const worst = worstProviderQuotaWindow(getAllProviderQuota());
  if (!worst) return undefined;
  const resetIn = formatQuotaResetIn(quotaResetInMs(worst.window));
  return {
    providerId: worst.snapshot.providerId,
    windowLabel: quotaWindowLabel(worst.window),
    usedPercent: worst.window.usedPercent,
    ...(resetIn !== undefined ? { resetIn } : {}),
    reached: worst.snapshot.reachedWindowId === worst.window.id,
  };
}

export function useProviderQuota(): ProviderQuotaChip | undefined {
  // Seeded from the store rather than empty: the status bar can mount after a
  // request has already landed (a `/statusline` toggle, a resumed session), and
  // starting blank would hide a reading we already hold until the next turn.
  const [chip, setChip] = useState<ProviderQuotaChip | undefined>(readWorst);

  useEffect(() => {
    setChip(readWorst());
    return onProviderQuota(() => {
      setChip(readWorst());
    });
  }, []);

  return chip;
}

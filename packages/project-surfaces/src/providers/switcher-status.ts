import type { QuotaSnapshot } from './provider-quota-store';
import { quotaWindowLabel } from './provider-quota-store';
import { quotaLevel, worstWindow } from './quota-model';

/** What a model-switcher row says on its right: the one fact that decides whether to pick it. */
export type SwitcherStatus =
  | { kind: 'none' }
  | { kind: 'needs-key' }
  | {
      kind: 'quota';
      /** Share of the busiest window still left, 0-100. */
      left: number;
      window: string;
      level: 'ok' | 'warn' | 'critical';
      /** The window's reset, epoch seconds. */
      resetsAt?: number | undefined;
    }
  | { kind: 'reached'; window: string; resetsAt?: number | undefined };

/**
 * The status a provider's own meters give it in a model switcher: a cut-off window first, else
 * the busiest one. Shared by the desktop and WebUI switchers so both read a plan the same way.
 */
export function providerQuotaStatus(
  provider: string,
  quota: readonly QuotaSnapshot[],
): SwitcherStatus {
  // A gateway pool account running out does not cut the session off: the gateway rotates.
  const meters = quota.filter((meter) => meter.providerId === provider && meter.via === undefined);
  // A cut-off window comes first. `reachedWindowId` names it, and a reading can
  // carry that name with no window at all (a 429 whose utilization headers were
  // dropped), so the busiest-window scan alone would miss it or mask it behind
  // a busier window that is not the one biting.
  for (const meter of meters) {
    if (meter.reachedWindowId === undefined) continue;
    const reached = meter.windows.find((each) => each.id === meter.reachedWindowId);
    return {
      kind: 'reached',
      window: reached ? quotaWindowLabel(reached) : meter.reachedWindowId,
      resetsAt: reached?.resetsAt,
    };
  }
  const worst = worstWindow(meters);
  if (!worst) return { kind: 'none' };
  const window = quotaWindowLabel(worst.window);
  if (worst.reached) return { kind: 'reached', window, resetsAt: worst.window.resetsAt };
  const used = Math.min(100, Math.max(0, worst.window.usedPercent));
  return {
    kind: 'quota',
    left: Math.round(100 - used),
    window,
    level: quotaLevel(used, false),
    resetsAt: worst.window.resetsAt,
  };
}

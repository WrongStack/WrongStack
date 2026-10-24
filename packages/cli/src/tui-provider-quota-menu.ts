import type { ProviderConfig } from '@wrongstack/contracts/types';
import {
  formatQuotaPercent,
  formatQuotaResetIn,
  getAllProviderQuota,
  quotaResetInMs,
  quotaWindowLabel,
} from '@wrongstack/core/quota';
import type { ResourceMenuSnapshot } from '@wrongstack/tui';

/** One provider per row, with all its meters in the detail pane. */
export function providerQuotaMenu(
  providers: Readonly<Record<string, ProviderConfig>> | undefined,
): ResourceMenuSnapshot {
  const snapshots = getAllProviderQuota();
  const ids = [
    ...new Set([...Object.keys(providers ?? {}), ...snapshots.map((s) => s.providerId)]),
  ].sort((a, b) => a.localeCompare(b));
  const now = Date.now();
  return {
    id: 'provider-quota',
    title: 'Providers',
    subtitle: 'Provider quota · r refresh · ↑↓ select',
    emptyText: 'No configured providers or quota readings.',
    items: ids.map((id) => {
      const meters = snapshots
        .filter((s) => s.providerId === id)
        .sort((a, b) => (a.meterLabel ?? a.meterId).localeCompare(b.meterLabel ?? b.meterId));
      const worst = Math.max(0, ...meters.flatMap((s) => s.windows.map((w) => w.usedPercent)));
      const reached = meters.some((s) => s.reachedWindowId !== undefined);
      const noCredits = meters.some(
        (s) => s.credits && !s.credits.unlimited && !s.credits.hasCredits,
      );
      const body: string[] = [];
      for (const meter of meters) {
        body.push(meter.meterLabel ?? meter.meterId);
        if (meter.planLabel) body.push(`Plan: ${meter.planLabel}`);
        if (meter.via) body.push(`Pool account via ${meter.via}`);
        for (const window of meter.windows) {
          const filled = Math.round(Math.max(0, Math.min(100, window.usedPercent)) / 10);
          body.push(
            `${quotaWindowLabel(window)}  ${'█'.repeat(filled)}${'░'.repeat(10 - filled)}`,
            `${formatQuotaPercent(window.usedPercent)} used · ${formatQuotaPercent(Math.max(0, 100 - window.usedPercent))} left`,
          );
          const reset = formatQuotaResetIn(quotaResetInMs(window, now));
          if (reset) body.push(`Resets in ${reset}`);
        }
        if (meter.credits) {
          body.push(
            `Credits: ${meter.credits.unlimited ? 'unlimited' : (meter.credits.balance ?? (meter.credits.hasCredits ? 'available' : 'none'))}`,
          );
        }
        if (meter.reachedWindowId) body.push(`Limit reached: ${meter.reachedWindowId}`);
        if (meter.note) body.push(meter.note);
        body.push(`As of ${new Date(meter.capturedAt).toLocaleString()}`, '');
      }
      return {
        id,
        label: id,
        status:
          meters.length === 0
            ? 'muted'
            : reached || noCredits || worst >= 90
              ? 'bad'
              : worst >= 70
                ? 'warn'
                : 'good',
        summary:
          meters.length === 0
            ? 'No quota reading available.'
            : `${meters.length} quota meter${meters.length === 1 ? '' : 's'}`,
        details: [],
        body:
          body.length > 0
            ? body.join('\n').trimEnd()
            : 'This provider has no reported quota yet. Account reads may be unavailable or unsupported. Press r to retry; the last known reading is kept if a read fails.',
        actions: [{ key: 'r', label: 'refresh quota', command: '/provider-quota' }],
      };
    }),
  };
}

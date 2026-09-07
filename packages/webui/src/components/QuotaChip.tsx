import { Target } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  formatQuotaResetIn,
  quotaWindowLabel,
  selectWorstQuotaWindow,
  useProviderQuotaStore,
} from '@/stores';

/**
 * Subscription plan quota, condensed to one chip.
 *
 * Subscription-metered providers (ChatGPT/Codex today, any plan-backed login
 * next) charge against rolling windows rather than per token, and report the
 * burn only on the responses to requests the agent already makes. Without this
 * the first visible sign of an exhausted plan is a failed turn.
 *
 * The chip shows the window nearest to cutting the user off across EVERY
 * metered provider — not the first to report — because that is the one that
 * decides whether the next turn runs. Providers with a different meter shape
 * need no change here: the store is provider-neutral.
 *
 * Renders nothing until a provider has reported. That is the honest state: the
 * reading is observational and is never fetched on its own, because asking a
 * metered plan how much you have spent costs a request against that same plan.
 */
export function QuotaChip({ className }: { className?: string | undefined }) {
  const meters = useProviderQuotaStore((s) => s.meters);
  const worst = selectWorstQuotaWindow(meters);
  if (!worst) return null;

  const { snapshot, window } = worst;
  const pct = Math.round(window.usedPercent);
  const reached = snapshot.reachedWindowId === window.id;
  const label = quotaWindowLabel(window);
  const resetIn = formatQuotaResetIn(window);

  // Advisory thresholds, not the provider's: amber is early enough to change
  // what you spend the rest of the window on, red is the point where the next
  // turn may not run at all.
  const tone =
    reached || pct >= 90
      ? 'text-destructive'
      : pct >= 70
        ? 'text-warning'
        : 'text-muted-foreground/70';

  const title = [
    `${snapshot.providerId}${snapshot.planLabel ? ` (${snapshot.planLabel})` : ''}`,
    `${label} window: ${pct}% used`,
    resetIn ? `resets in ${resetIn}` : null,
    reached ? 'limit reached' : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <span
      className={cn('flex items-center gap-1 tabular-nums shrink-0', tone, className)}
      title={title}
    >
      <Target className="h-3 w-3" aria-hidden />
      <span>
        {label} {pct}%
      </span>
      {resetIn && <span className="text-muted-foreground/50">{resetIn}</span>}
    </span>
  );
}

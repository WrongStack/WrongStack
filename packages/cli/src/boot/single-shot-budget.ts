/**
 * `--max-budget-usd` for single-shot runs.
 *
 * Spend is the leader's cost delta since the run started plus every subagent's
 * cumulative cost. Subagents run on their own token counters, so the leader's
 * counter alone would let a delegating run blow straight past the cap.
 *
 * The check fires after each accounted request; the request that crosses the
 * line has already been paid for, so the cap bounds the overshoot to one
 * request rather than preventing it.
 */
import type { EventBus } from '@wrongstack/contracts/kernel';
import type { TokenCounter } from '@wrongstack/contracts/types';

/** Parse the flag. `undefined` = not set; throws on a value that is set but unusable. */
export function parseMaxBudgetUsd(value: string | boolean | undefined): number | undefined {
  if (value === undefined) return undefined;
  const amount = typeof value === 'string' ? Number(value.trim()) : Number.NaN;
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('--max-budget-usd needs a positive dollar amount (e.g. --max-budget-usd 0.50)');
  }
  return amount;
}

export interface SingleShotBudget {
  /** Spend so far, in USD. */
  spent(): number;
  /** True once the limit was crossed and `onExceeded` fired. */
  readonly exceeded: boolean;
  /** Detach the event listeners. */
  dispose(): void;
}

export function watchSingleShotBudget(opts: {
  limitUsd: number;
  tokenCounter: Pick<TokenCounter, 'estimateCost'>;
  events: Pick<EventBus, 'on'>;
  onExceeded: () => void;
}): SingleShotBudget {
  const leaderStart = opts.tokenCounter.estimateCost().total;
  const subagentCost = new Map<string, number>();
  let exceeded = false;

  const spent = (): number => {
    let total = opts.tokenCounter.estimateCost().total - leaderStart;
    for (const cost of subagentCost.values()) total += cost;
    return total;
  };
  const check = (): void => {
    if (exceeded || spent() <= opts.limitUsd) return;
    exceeded = true;
    opts.onExceeded();
  };

  const offLeader = opts.events.on('token.accounted', check);
  const offSubagent = opts.events.on('subagent.token_accounted', (payload) => {
    subagentCost.set(payload.subagentId, payload.cost.total);
    check();
  });

  return {
    spent,
    get exceeded() {
      return exceeded;
    },
    dispose() {
      offLeader();
      offSubagent();
    },
  };
}

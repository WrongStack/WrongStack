/**
 * Alert rules in words, and the history read as episodes.
 *
 * An HQ alert is an episode of one rule: it starts when the rule starts firing
 * (`firstFiredAt`) and is re-confirmed on every evaluation (`lastFiredAt`)
 * until it stops. The history keeps the episodes; the active list is the ones
 * still running.
 */
import type { HqAlert } from '@wrongstack/hq';

export const RULE_LABEL: Record<string, { name: string; checks: string }> = {
  'budget-fleet-24h': {
    name: 'Daily fleet budget',
    checks: 'Fleet spend over the last 24 hours reached the daily budget.',
  },
  'fleet-cost-threshold': {
    name: 'Spend over the threshold',
    checks: 'Total fleet spend reached the configured cost threshold.',
  },
  'fleet-throughput-budget': {
    name: 'Spend budget reached',
    checks: 'Cumulative spend reached the operator’s throughput budget.',
  },
  'all-machines-stale': {
    name: 'Every machine went quiet',
    checks: 'No connected machine has reported for longer than the stale limit.',
  },
  'high-concurrency': {
    name: 'Too many agents at once',
    checks: 'More agents are running than the configured maximum.',
  },
  'fleet-failure-spike': {
    name: 'Failures spiking',
    checks: 'Agent or command failures rose sharply.',
  },
  'token-expired-present': {
    name: 'An expired token is still configured',
    checks: 'A browser or client token past its expiry is still in auth.json.',
  },
  'token-expiry-imminent': {
    name: 'A token expires soon',
    checks: 'A token expires within the warning window.',
  },
};

export function ruleName(ruleId: string): string {
  if (ruleId.startsWith('budget-project:')) return 'Daily project budget';
  if (ruleId.startsWith('budget-machine:')) return 'Daily machine budget';
  return RULE_LABEL[ruleId]?.name ?? ruleId;
}

export interface Episode {
  alert: HqAlert;
  /** Still firing now. */
  active: boolean;
  /** How long it was confirmed firing; 0 when only seen once. */
  durationMs: number;
}

/** History and active merged into episodes, newest first, each listed once. */
export function episodes(active: readonly HqAlert[], history: readonly HqAlert[]): Episode[] {
  const activeIds = new Set(active.map((alert) => alert.id));
  const byId = new Map<string, HqAlert>();
  for (const alert of history) byId.set(alert.id, alert);
  // The active copy carries the freshest lastFiredAt.
  for (const alert of active) byId.set(alert.id, alert);
  return [...byId.values()]
    .map((alert) => ({
      alert,
      active: activeIds.has(alert.id),
      durationMs: Math.max(0, alert.lastFiredAt - alert.firstFiredAt),
    }))
    .sort((left, right) => right.alert.firstFiredAt - left.alert.firstFiredAt);
}

export interface RuleCount {
  ruleId: string;
  episodes: number;
  firing: boolean;
}

/** How often each rule fired in the loaded history, the noisiest first. */
export function ruleCounts(list: readonly Episode[]): RuleCount[] {
  const counts = new Map<string, RuleCount>();
  for (const episode of list) {
    const entry = counts.get(episode.alert.ruleId) ?? {
      ruleId: episode.alert.ruleId,
      episodes: 0,
      firing: false,
    };
    entry.episodes += 1;
    entry.firing ||= episode.active;
    counts.set(episode.alert.ruleId, entry);
  }
  return [...counts.values()].sort(
    (left, right) =>
      Number(right.firing) - Number(left.firing) ||
      right.episodes - left.episodes ||
      left.ruleId.localeCompare(right.ruleId),
  );
}

export function duration(ms: number): string {
  if (ms < 60_000) return 'under a minute';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  if (ms < 48 * 3_600_000) return `${(ms / 3_600_000).toFixed(1)} h`;
  return `${Math.round(ms / (24 * 3_600_000))} days`;
}

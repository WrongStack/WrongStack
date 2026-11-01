import type { HqAlert } from '@wrongstack/hq';
import { describe, expect, it } from 'vitest';
import { duration, episodes, ruleCounts, ruleName } from '../src/features/alerts/model';

const alert = (id: string, ruleId: string, first: number, last = first): HqAlert => ({
  id,
  ruleId,
  severity: 'warn',
  message: `${ruleId} fired`,
  firstFiredAt: first,
  lastFiredAt: last,
});

describe('alert episodes', () => {
  it('lists an active episode once, with its freshest confirmation', () => {
    const stale = alert('a-1', 'fleet-cost-threshold', 1_000, 1_000);
    const fresh = alert('a-1', 'fleet-cost-threshold', 1_000, 61_000);
    const list = episodes([fresh], [stale, alert('b-1', 'all-machines-stale', 5_000, 5_000)]);
    expect(list.map((entry) => [entry.alert.id, entry.active, entry.durationMs])).toEqual([
      ['b-1', false, 0],
      ['a-1', true, 60_000],
    ]);
  });

  it('ranks rules: firing first, then the noisiest', () => {
    const list = episodes(
      [alert('c-9', 'high-concurrency', 9)],
      [
        alert('a-1', 'fleet-failure-spike', 1),
        alert('a-2', 'fleet-failure-spike', 2),
        alert('b-1', 'token-expiry-imminent', 3),
      ],
    );
    expect(ruleCounts(list).map((entry) => [entry.ruleId, entry.episodes, entry.firing])).toEqual([
      ['high-concurrency', 1, true],
      ['fleet-failure-spike', 2, false],
      ['token-expiry-imminent', 1, false],
    ]);
  });

  it('names rules in words and keeps unknown ids', () => {
    expect(ruleName('all-machines-stale')).toBe('Every machine went quiet');
    expect(ruleName('custom-rule')).toBe('custom-rule');
  });

  it('reads durations', () => {
    expect(duration(30_000)).toBe('under a minute');
    expect(duration(12 * 60_000)).toBe('12 min');
    expect(duration(3 * 3_600_000)).toBe('3.0 h');
    expect(duration(5 * 24 * 3_600_000)).toBe('5 days');
  });
});

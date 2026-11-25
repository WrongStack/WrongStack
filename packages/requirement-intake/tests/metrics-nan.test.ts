import { describe, expect, it } from 'vitest';
import { InMemoryIntakeMetrics } from '../src/metrics.js';

describe('InMemoryIntakeMetrics non-finite/negative guards', () => {
  it('ignores NaN increments and NaN/negative durations', () => {
    const metrics = new InMemoryIntakeMetrics();
    metrics.increment('intake.created', 2);
    metrics.increment('intake.created', Number.NaN);
    metrics.recordDuration('intake.time_to_submit', 100);
    metrics.recordDuration('intake.time_to_submit', Number.NaN);
    metrics.recordDuration('intake.time_to_submit', -5);

    expect(metrics.count('intake.created')).toBe(2);
    expect(metrics.durationSum('intake.time_to_submit')).toBe(100);
  });
});

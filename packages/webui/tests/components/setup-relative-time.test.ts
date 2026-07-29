import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatSetupRelativeTime } from '../../src/components/SetupScreen/relative-time';

/** Records the key + interpolation values the formatter asked for. */
function recorder() {
  const calls: Array<{ key: string; values?: Record<string, number> }> = [];
  const t = (key: string, values?: Record<string, number>) => {
    calls.push(values === undefined ? { key } : { key, values });
    return values ? `${key}:${values.count}` : key;
  };
  return { calls, t };
}

const NOW = new Date('2026-07-29T12:00:00.000Z');

function agoBy(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

describe('formatSetupRelativeTime', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function freeze() {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  }

  it('reports "just now" below the 10 second floor', () => {
    freeze();
    const { t, calls } = recorder();
    expect(formatSetupRelativeTime(agoBy(0), t)).toBe('setup:screen.time.justNow');
    expect(formatSetupRelativeTime(agoBy(9_999), t)).toBe('setup:screen.time.justNow');
    // The "just now" branch takes no interpolation values.
    expect(calls.every((c) => c.values === undefined)).toBe(true);
  });

  it('switches to seconds exactly at 10s', () => {
    freeze();
    const { t } = recorder();
    expect(formatSetupRelativeTime(agoBy(10_000), t)).toBe('setup:screen.time.secondsAgo:10');
    expect(formatSetupRelativeTime(agoBy(59_000), t)).toBe('setup:screen.time.secondsAgo:59');
  });

  it('switches to minutes exactly at 60s and floors the remainder', () => {
    freeze();
    const { t } = recorder();
    expect(formatSetupRelativeTime(agoBy(60_000), t)).toBe('setup:screen.time.minutesAgo:1');
    // 90s floors to 1 minute, not 2.
    expect(formatSetupRelativeTime(agoBy(90_000), t)).toBe('setup:screen.time.minutesAgo:1');
    expect(formatSetupRelativeTime(agoBy(59 * 60_000), t)).toBe('setup:screen.time.minutesAgo:59');
  });

  it('switches to hours exactly at 60 minutes', () => {
    freeze();
    const { t } = recorder();
    expect(formatSetupRelativeTime(agoBy(3_600_000), t)).toBe('setup:screen.time.hoursAgo:1');
    expect(formatSetupRelativeTime(agoBy(23 * 3_600_000), t)).toBe('setup:screen.time.hoursAgo:23');
  });

  it('switches to days exactly at 24 hours and has no upper bound', () => {
    freeze();
    const { t } = recorder();
    expect(formatSetupRelativeTime(agoBy(24 * 3_600_000), t)).toBe('setup:screen.time.daysAgo:1');
    expect(formatSetupRelativeTime(agoBy(400 * 24 * 3_600_000), t)).toBe(
      'setup:screen.time.daysAgo:400',
    );
  });

  it('treats a future date as "just now" rather than emitting a negative count', () => {
    freeze();
    const { t } = recorder();
    // diffSec is negative, which is still < 10 — the first branch wins.
    expect(formatSetupRelativeTime(new Date(NOW.getTime() + 60_000), t)).toBe(
      'setup:screen.time.justNow',
    );
  });

  it('passes the count through as an interpolation value, not baked into the key', () => {
    freeze();
    const { t, calls } = recorder();
    formatSetupRelativeTime(agoBy(5 * 60_000), t);
    expect(calls.at(-1)).toEqual({
      key: 'setup:screen.time.minutesAgo',
      values: { count: 5 },
    });
  });
});

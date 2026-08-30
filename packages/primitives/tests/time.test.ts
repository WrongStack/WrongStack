/**
 * Regression tests for the canonical wall-clock helper `nowIso`.
 *
 * Six byte-identical copies of this helper were consolidated into this
 * package; the ISO-8601 UTC shape below is the contract every consumer
 * (kanban, cli, sage, plugins) stores and sorts by.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { nowIso } from '../src/time.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('nowIso', () => {
  it('returns the frozen wall clock as ISO-8601 UTC', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-02T03:04:05.678Z'));
    expect(nowIso()).toBe('2026-01-02T03:04:05.678Z');
  });

  it('matches the ISO-8601 UTC shape with millisecond precision', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-12-31T23:59:59.999Z'));
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  });

  it('tracks the live clock within a sane tolerance', () => {
    const before = Date.now();
    const parsed = Date.parse(nowIso());
    const after = Date.now();
    expect(parsed).toBeGreaterThanOrEqual(before - 50);
    expect(parsed).toBeLessThanOrEqual(after + 50);
  });
});

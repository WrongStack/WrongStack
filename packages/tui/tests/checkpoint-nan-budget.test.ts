import { expect, it } from 'vitest';
import { retainCheckpoints } from '../src/checkpoint-retention.js';

const rows = [0, 1].map((promptIndex) => ({
  promptIndex,
  promptPreview: 'x'.repeat(100),
  ts: '2026-01-01T00:00:00Z',
  fileCount: 0,
}));
it.each([{ maxEntries: 0 }, { maxEntries: -5 }, { maxEntries: 1.9 }])(
  'keeps newest with pathological budget %j',
  (budget) => {
    expect(retainCheckpoints(rows, budget).map((r) => r.promptIndex)).toEqual([1]);
  },
);
it.each([{ maxEntries: NaN }, { maxBytes: NaN }, { maxEntries: NaN, maxBytes: NaN }])(
  'falls back to the default caps for a NaN budget %j',
  (budget) => {
    expect(retainCheckpoints(rows, budget).map((r) => r.promptIndex)).toEqual([0, 1]);
  },
);
it('preserves defaults, explicit unbounded limits, empty input and oversized newest entry', () => {
  expect(retainCheckpoints(rows)).toBe(rows);
  expect(retainCheckpoints(rows, { maxEntries: Infinity, maxBytes: Infinity })).toBe(rows);
  const empty: typeof rows = [];
  expect(retainCheckpoints(empty, { maxEntries: NaN })).toBe(empty);
  expect(retainCheckpoints([rows[1]!], { maxBytes: NaN })).toHaveLength(1);
});

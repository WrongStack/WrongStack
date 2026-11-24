import { describe, expect, it } from 'vitest';
import { comparePartitionPaths } from '../src/partition-filename.js';

/**
 * F103 (same root class as F102): partition family ordering used
 * localeCompare, which returns 0 for distinct canonically-equivalent file
 * names ('café' vs 'cafe\u0301'). Partition order must be deterministic —
 * a zero collapses two distinct families into an unstable sort. Facet
 * tie-break sorts in query.ts/sqlite-query.ts carried the same defect.
 */
describe('partition order is locale-independent (F103)', () => {
  it('never compares distinct canonically-equivalent families equal', () => {
    const a = '/store/café.events.jsonl';
    const b = '/store/cafe\u0301.events.jsonl';
    expect(a).not.toBe(b);
    expect(comparePartitionPaths(a, b)).not.toBe(0);
  });

  it('still orders rotation sequences numerically (control)', () => {
    expect(
      comparePartitionPaths('/s/a.events.00001.jsonl', '/s/a.events.00002.jsonl'),
    ).toBeLessThan(0);
    expect(
      comparePartitionPaths('/s/a.events.00010.jsonl', '/s/a.events.00002.jsonl'),
    ).toBeGreaterThan(0);
  });

  it('still sorts the unrotated file first within its family (control)', () => {
    expect(comparePartitionPaths('/s/a.events.jsonl', '/s/a.events.00001.jsonl')).toBeLessThan(0);
  });

  it('still orders families by name (control)', () => {
    expect(comparePartitionPaths('/s/a.events.jsonl', '/s/b.events.jsonl')).toBeLessThan(0);
  });
});

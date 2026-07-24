import { describe, expect, it } from 'vitest';
import {
  boundedLimit,
  clampPageLimit,
  compareByUpdatedDesc,
  DEFAULT_LIST_LIMIT,
  DEFAULT_PAGE_LIMIT,
  decodePageCursor,
  encodePageCursor,
  MAX_PAGE_LIMIT,
  normalizeListStatuses,
} from '../src/shared/pagination.js';
import type { Sage, SageStatus } from '../src/types.js';

function sage(id: string, updatedAt: string): Sage {
  return { id, updatedAt } as Sage;
}

describe('pagination helpers', () => {
  it('round-trips valid cursors and rejects every malformed shape', () => {
    expect(decodePageCursor(undefined)).toBeUndefined();
    expect(decodePageCursor('')).toBeUndefined();
    expect(decodePageCursor('not-json')).toBeUndefined();
    expect(
      decodePageCursor(Buffer.from(JSON.stringify({ u: 1, i: 'id' })).toString('base64url')),
    ).toBeUndefined();
    expect(
      decodePageCursor(Buffer.from(JSON.stringify({ u: 'time', i: 1 })).toString('base64url')),
    ).toBeUndefined();

    const encoded = encodePageCursor({ updatedAt: '2026-01-01T00:00:00.000Z', id: 'memory-1' });
    expect(decodePageCursor(encoded)).toEqual({
      updatedAt: '2026-01-01T00:00:00.000Z',
      id: 'memory-1',
    });
  });

  it('clamps page and list limits at every boundary', () => {
    expect(clampPageLimit(undefined)).toBe(DEFAULT_PAGE_LIMIT);
    expect(clampPageLimit(Number.NaN)).toBe(DEFAULT_PAGE_LIMIT);
    expect(clampPageLimit(0)).toBe(1);
    expect(clampPageLimit(12.9)).toBe(12);
    expect(clampPageLimit(MAX_PAGE_LIMIT + 1)).toBe(MAX_PAGE_LIMIT);

    expect(boundedLimit(undefined, DEFAULT_LIST_LIMIT, 100)).toBe(DEFAULT_LIST_LIMIT);
    expect(boundedLimit(Number.POSITIVE_INFINITY, 7, 100)).toBe(7);
    expect(boundedLimit(-1, 7, 100)).toBe(0);
    expect(boundedLimit(8.9, 7, 100)).toBe(8);
    expect(boundedLimit(101, 7, 100)).toBe(100);
  });

  it('normalizes omitted, empty, valid, and invalid statuses', () => {
    expect(normalizeListStatuses(undefined)).toEqual(
      new Set(['active', 'stale', 'superseded', 'contradicted', 'archived']),
    );
    expect(normalizeListStatuses([])).toEqual(new Set());
    expect(normalizeListStatuses(['active', 'deleted'])).toEqual(new Set(['active', 'deleted']));
    expect(normalizeListStatuses(['unknown' as SageStatus])).toEqual(new Set());
    expect(normalizeListStatuses(['active'], new Set<SageStatus>(['stale']))).toEqual(new Set());
  });

  it('sorts by descending timestamp and then descending id', () => {
    const base = '2026-01-01T00:00:00.000Z';
    expect(compareByUpdatedDesc(sage('a', '2025'), sage('b', base))).toBe(1);
    expect(compareByUpdatedDesc(sage('a', '2027'), sage('b', base))).toBe(-1);
    expect(compareByUpdatedDesc(sage('a', base), sage('b', base))).toBe(1);
    expect(compareByUpdatedDesc(sage('c', base), sage('b', base))).toBe(-1);
    expect(compareByUpdatedDesc(sage('b', base), sage('b', base))).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import { compareEventToKey, findInsertionIndex, matches, orderKey } from '../src/query-matching.js';
import type { ChronicleEvent } from '../src/types.js';

/**
 * F102: compareEventToKey ordered machine identifiers with localeCompare.
 * Collation treats canonically-equivalent Unicode as EQUAL: on this en-US
 * host, 'call_é' (precomposed) vs 'call_e\u0301' (decomposed) are distinct
 * strings yet localeCompare returns 0. The event order is the total order
 * behind cursor pagination and binary-search insertion — a zero for distinct
 * events lets a page skip or duplicate rows. Text search and path
 * normalization used toLocaleLowerCase, whose folding is host-locale
 * dependent (Turkish I: 'I' → 'ı', so an uppercase query silently misses on
 * a tr-TR host). Machine data must use locale-independent operations.
 */
const base = {
  occurredAt: '2026-01-01T00:00:00.000Z',
  observedAt: '2026-01-01T00:00:00.000Z',
  persistedAt: '2026-01-01T00:00:01.000Z',
  sequence: 1,
};
const composed = { ...base, eventId: 'call_é' } as ChronicleEvent;
const decomposed = { ...base, eventId: 'call_e\u0301' } as ChronicleEvent;

describe('chronicle event order is a locale-independent total order (F102)', () => {
  it('never compares distinct canonically-equivalent eventIds equal', () => {
    expect(composed.eventId).not.toBe(decomposed.eventId);
    expect(compareEventToKey(composed, orderKey(decomposed))).not.toBe(0);
  });

  it('is antisymmetric for the collation-equal pair', () => {
    const ab = compareEventToKey(composed, orderKey(decomposed));
    const ba = compareEventToKey(decomposed, orderKey(composed));
    expect(ab).toBe(-ba);
  });

  it('keeps both events reachable through binary-search insertion', () => {
    const sorted: ChronicleEvent[] = [];
    for (const event of [composed, decomposed]) {
      const at = findInsertionIndex(sorted, event, (left, right) =>
        compareEventToKey(left, orderKey(right)),
      );
      sorted.splice(at, 0, event);
    }
    expect(sorted).toHaveLength(2);
    expect(new Set(sorted.map((e) => e.eventId)).size).toBe(2);
  });

  it('still orders ASCII timestamps and sequences correctly (control)', () => {
    const earlier = {
      ...base,
      eventId: 'a',
      occurredAt: '2025-12-31T00:00:00.000Z',
    } as ChronicleEvent;
    const later = { ...base, eventId: 'b' } as ChronicleEvent;
    expect(compareEventToKey(earlier, orderKey(later))).toBeLessThan(0);
    expect(compareEventToKey(later, orderKey(earlier))).toBeGreaterThan(0);
    const seq2 = { ...base, eventId: 'a', sequence: 2 } as ChronicleEvent;
    expect(
      compareEventToKey({ ...base, eventId: 'a' } as ChronicleEvent, orderKey(seq2)),
    ).toBeLessThan(0);
  });
});

describe('chronicle search folding is locale-independent (F102)', () => {
  const event = {
    ...base,
    eventId: 'e1',
    eventType: 'tool.executed',
    previousHash: '',
    hash: '',
    scope: { installationId: 'i', machineId: 'm' },
    correlation: { traceId: 't', spanId: 's' },
    attributes: { note: 'input value' },
    resource: { kind: 'file', id: 'f', path: 'SRC/Index.ts' },
  } as unknown as ChronicleEvent;

  it('still matches text case-insensitively (control)', () => {
    expect(matches(event, { text: 'INPUT' })).toBe(true);
    expect(matches(event, { text: 'absent' })).toBe(false);
  });

  it('still normalizes path separators and case (control)', () => {
    expect(matches(event, { path: 'src\\index.ts' })).toBe(true);
  });
});

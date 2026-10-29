import { describe, expect, it } from 'vitest';
import {
  historyRetention,
  percent,
  requestResidency,
  retentionRows,
} from '../src/context-residency-model';

const residency = {
  seq: 3,
  at: 1,
  providerId: 'local',
  model: 'm1',
  mechanism: 'explicit',
  segments: [
    { kind: 'tools', tokens: 400, lane: 'cached', count: 12 },
    { kind: 'history-new', tokens: 120, lane: 'written', count: 2 },
  ],
  lanes: { cached: 400, written: 120, uncached: 0 },
  total: 520,
  expectedCacheRatio: 0.77,
  verdict: 'hit',
  breakers: [],
  next: { rewritten: false, pendingMessages: 0, pendingTokens: 0 },
};
const classes = {
  protected: { messages: 4, tokens: 900 },
  'elision-candidate': { messages: 1, tokens: 300 },
  compactable: { messages: 0, tokens: 0 },
  elided: { messages: 0, tokens: 0 },
  digest: { messages: 1, tokens: 50 },
};

describe('context residency view model', () => {
  it('accepts the engine layout and refuses shapes it cannot draw', () => {
    expect(requestResidency(residency)?.total).toBe(520);
    expect(requestResidency(undefined)).toBeNull();
    expect(requestResidency({ ...residency, segments: [] })).toBeNull();
    expect(
      requestResidency({ ...residency, segments: [{ kind: 'tools', lane: 'cached' }] }),
    ).toBeNull();
    expect(requestResidency({ ...residency, total: Number.NaN })).toBeNull();
  });
  it('lists only retention classes that hold something, in display order', () => {
    const retention = historyRetention({
      preserveK: 4,
      eliseThreshold: 2000,
      preserveStart: 3,
      classes,
      total: 1250,
    })!;
    expect(retentionRows(retention).map((row) => row.name)).toEqual([
      'protected',
      'elision-candidate',
      'digest',
    ]);
    expect(historyRetention({ total: 1, classes: { protected: { tokens: 1 } } })).toBeNull();
  });
  it('computes whole percentages without dividing by zero', () => {
    expect(percent(0.77, 1)).toBe(77);
    expect(percent(1, 3)).toBe(33);
    expect(percent(5, 0)).toBe(0);
  });
});

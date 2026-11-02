import type { SessionSummary } from '@wrongstack/contracts/types/session';
import { describe, expect, it } from 'vitest';
import {
  compareSessionSummaries,
  matchesSessionFilter,
} from '../../src/storage/session-summary.js';

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'sess_1',
    title: 'Test session',
    startedAt: '2026-01-01T00:00:00.000Z',
    model: 'gpt-4',
    provider: 'openai',
    tokenTotal: 1000,
    ...overrides,
  };
}

describe('compareSessionSummaries', () => {
  it('returns -1 when a is newer than b (descending order)', () => {
    const a = makeSummary({ startedAt: '2026-02-01T00:00:00.000Z' });
    const b = makeSummary({ startedAt: '2026-01-01T00:00:00.000Z' });
    expect(compareSessionSummaries(a, b)).toBe(-1);
  });

  it('returns 1 when a is older than b', () => {
    const a = makeSummary({ startedAt: '2026-01-01T00:00:00.000Z' });
    const b = makeSummary({ startedAt: '2026-02-01T00:00:00.000Z' });
    expect(compareSessionSummaries(a, b)).toBe(1);
  });

  it('ties broken by id localeCompare when dates are equal', () => {
    const a = makeSummary({ id: 'sess_a', startedAt: '2026-01-01T00:00:00.000Z' });
    const b = makeSummary({ id: 'sess_b', startedAt: '2026-01-01T00:00:00.000Z' });
    // 'a' < 'b' so compare returns -1
    expect(compareSessionSummaries(a, b)).toBe(-1);
  });

  it('sorts stable when id and date are equal', () => {
    const a = makeSummary({ id: 'same', startedAt: '2026-01-01T00:00:00.000Z' });
    const b = makeSummary({ id: 'same', startedAt: '2026-01-01T00:00:00.000Z' });
    expect(compareSessionSummaries(a, b)).toBe(0);
  });
});

describe('matchesSessionFilter', () => {
  const summary = makeSummary({
    title: 'My Migration Session',
    provider: 'anthropic',
    model: 'claude-3',
    tokenTotal: 5000,
  });

  it('returns true with no criteria (empty filter)', () => {
    expect(matchesSessionFilter(summary, {})).toBe(true);
  });

  it('filters by since (startedAt >= since)', () => {
    expect(matchesSessionFilter(summary, { since: '2025-12-01T00:00:00.000Z' })).toBe(true);
    expect(matchesSessionFilter(summary, { since: '2027-01-01T00:00:00.000Z' })).toBe(false);
  });

  it('filters by until (startedAt <= until)', () => {
    expect(matchesSessionFilter(summary, { until: '2027-01-01T00:00:00.000Z' })).toBe(true);
    expect(matchesSessionFilter(summary, { until: '2025-12-01T00:00:00.000Z' })).toBe(false);
  });

  it('filters by provider', () => {
    expect(matchesSessionFilter(summary, { provider: 'anthropic' })).toBe(true);
    expect(matchesSessionFilter(summary, { provider: 'openai' })).toBe(false);
  });

  it('filters by model', () => {
    expect(matchesSessionFilter(summary, { model: 'claude-3' })).toBe(true);
    expect(matchesSessionFilter(summary, { model: 'gpt-4' })).toBe(false);
  });

  it('filters by minTokens (tokenTotal >= minTokens)', () => {
    expect(matchesSessionFilter(summary, { minTokens: 4000 })).toBe(true);
    expect(matchesSessionFilter(summary, { minTokens: 6000 })).toBe(false);
  });

  it('filters by titleContains (case-insensitive)', () => {
    expect(matchesSessionFilter(summary, { titleContains: 'migration' })).toBe(true);
    expect(matchesSessionFilter(summary, { titleContains: 'MIGRATION' })).toBe(true);
    expect(matchesSessionFilter(summary, { titleContains: 'backup' })).toBe(false);
  });

  it('combines multiple criteria (AND logic)', () => {
    expect(
      matchesSessionFilter(summary, {
        provider: 'anthropic',
        model: 'claude-3',
        minTokens: 4000,
      }),
    ).toBe(true);

    expect(
      matchesSessionFilter(summary, {
        provider: 'anthropic',
        model: 'not-mine',
      }),
    ).toBe(false);
  });

  it('handles empty title correctly with titleContains', () => {
    const emptyTitle = makeSummary({ title: '' });
    expect(matchesSessionFilter(emptyTitle, { titleContains: 'anything' })).toBe(false);
  });

  it('handles undefined tokenTotal with minTokens filter gracefully', () => {
    const noTokens = makeSummary({ tokenTotal: 0 });
    expect(matchesSessionFilter(noTokens, { minTokens: 100 })).toBe(false);
  });

  it('treats a MISSING tokenTotal as 0, like the catalog backend (parity)', () => {
    // Regression (bug-hunt round 15): the catalog filters with
    // `COALESCE(json_extract(summary_json,'$.tokenTotal'),0) >= ?`, so a legacy
    // or damaged summary that omits the field is excluded. This predicate used
    // the raw compare, and `undefined < 100` is FALSE — the same filtered list
    // returned different sessions depending on whether the catalog daemon was
    // running. `tokenTotal` is required on the type, but these rows are parsed
    // from on-disk JSON, which is not type-checked.
    const { tokenTotal: _omitted, ...rest } = makeSummary();
    const legacy = rest as SessionSummary;
    expect(matchesSessionFilter(legacy, { minTokens: 100 })).toBe(false);
    // A zero/absent floor still admits it, exactly as `0 >= 0` does in SQL.
    expect(matchesSessionFilter(legacy, { minTokens: 0 })).toBe(true);
    expect(matchesSessionFilter(legacy, {})).toBe(true);
    expect(matchesSessionFilter(legacy, { minTokens: undefined })).toBe(true);
  });

  it('treats a non-finite tokenTotal as 0 as well', () => {
    expect(matchesSessionFilter(makeSummary({ tokenTotal: Number.NaN }), { minTokens: 1 })).toBe(
      false,
    );
  });

  it('edge: undefined minTokens does not filter', () => {
    expect(matchesSessionFilter(summary, { minTokens: undefined })).toBe(true);
  });
});

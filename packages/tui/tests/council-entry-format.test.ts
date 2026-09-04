// Council trace formatters. The distinct-target count is deliberately on the
// headline: a panel whose seats resolved to the SAME model produces a
// perfectly normal-looking unanimous verdict while adding cost without adding
// independence, and nothing else in the card reveals that.

import { describe, expect, it } from 'vitest';
import { councilHeadline, councilSeatLine } from '../src/components/history/entry.js';

describe('councilHeadline', () => {
  it('reports resolution, quorum, panel diversity, judge use and cost', () => {
    const line = councilHeadline({
      resolution: 'judge',
      configuredSeatCount: 3,
      validVoteCount: 3,
      distinctTargetCount: 3,
      judgeUsed: true,
      totalTokens: 420,
      durationMs: 1250,
      seats: [],
    });

    expect(line).toBe('↳ Council: judge · 3/3 seats · 3 distinct targets · judge · 1.3s · 420 tok');
  });

  it('singularizes a correlated one-target panel and omits absent cost data', () => {
    const line = councilHeadline({
      resolution: 'majority',
      configuredSeatCount: 3,
      validVoteCount: 2,
      distinctTargetCount: 1,
      judgeUsed: false,
      seats: [],
    });

    expect(line).toBe('↳ Council: majority · 2/3 seats · 1 distinct target');
  });
});

describe('councilSeatLine', () => {
  it('shows the vote, the serving model and veto power', () => {
    expect(
      councilSeatLine({
        seatId: 'voter-1',
        persona: 'skeptic',
        status: 'valid',
        optionId: 'hold',
        model: 'gpt-5',
        veto: true,
      }),
    ).toBe('   • skeptic → hold (gpt-5, veto)');
  });

  it('shows the error rather than a vote for a seat that failed', () => {
    expect(
      councilSeatLine({
        seatId: 'voter-2',
        persona: 'auditor',
        status: 'failed',
        error: 'timeout',
      }),
    ).toBe('   × auditor → timeout');
  });

  it('falls back to the status when a failed seat carries no error text', () => {
    expect(councilSeatLine({ seatId: 'voter-3', persona: 'security', status: 'cancelled' })).toBe(
      '   × security → cancelled',
    );
  });
});

describe('councilHeadline — deliberation and judge identity', () => {
  const base = {
    resolution: 'majority' as const,
    configuredSeatCount: 3,
    validVoteCount: 3,
    distinctTargetCount: 3,
    judgeUsed: false,
    seats: [],
  };

  it('reports the round count and how many seats actually moved', () => {
    expect(councilHeadline({ ...base, rounds: 2, deliberationChanges: 1 })).toContain(
      '2 rounds, 1 changed',
    );
  });

  it('says so explicitly when the extra rounds changed nothing', () => {
    // 0 is the honest signal that deliberation bought cost and nothing else,
    // so it must be stated rather than omitted.
    expect(councilHeadline({ ...base, rounds: 2, deliberationChanges: 0 })).toContain(
      '2 rounds, none changed',
    );
  });

  it('omits the round segment for a single-round panel', () => {
    expect(councilHeadline({ ...base, rounds: 1, deliberationChanges: 0 })).not.toContain('round');
  });

  it('names the judge and flags one that had already voted', () => {
    const line = councilHeadline({
      ...base,
      judgeUsed: true,
      judgeLabel: 'anthropic/haiku',
      judgeIsVoter: true,
    });
    // A tie-breaker that cast one of the tied votes is not an independent
    // opinion; the headline is the only place that surfaces it.
    expect(line).toContain('judge anthropic/haiku (also a voter)');
  });
});

describe('councilSeatLine — stances and deliberation', () => {
  it('prints the actual stance for an optionless panel', () => {
    // It used to print the literal word "stance", which said that the seat
    // had voted but never what it said — the whole content of an open panel.
    expect(
      councilSeatLine({
        seatId: 'voter-1',
        persona: 'executor',
        status: 'valid',
        stance: 'Ship behind a flag.',
      }),
    ).toBe('   • executor → Ship behind a flag.');
  });

  it('elides a very long stance rather than wrapping the row', () => {
    const line = councilSeatLine({
      seatId: 'voter-1',
      persona: 'executor',
      status: 'valid',
      stance: 'x'.repeat(200),
    });
    expect(line.length).toBeLessThan(100);
    expect(line).toContain('…');
  });

  it('marks a seat that changed its vote after reading the others', () => {
    expect(
      councilSeatLine({
        seatId: 'voter-1',
        persona: 'skeptic',
        status: 'valid',
        optionId: 'merge',
        changed: true,
      }),
    ).toBe('   ↺ skeptic → merge');
  });

  it('reports a valid seat with no stance at all rather than an empty arrow', () => {
    expect(councilSeatLine({ seatId: 'voter-1', persona: 'auditor', status: 'valid' })).toBe(
      '   • auditor → no stance',
    );
  });
});

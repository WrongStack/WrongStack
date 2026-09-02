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

    expect(line).toBe(
      '↳ Council: judge · 3/3 seats · 3 distinct targets · judge used · 1.3s · 420 tok',
    );
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

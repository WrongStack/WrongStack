import { expect, it } from 'vitest';
import { readUsageSummary } from '../src/ProjectUsageSummary';

it('reads the engine usage summary and drops malformed rows', () => {
  expect(
    readUsageSummary({
      sessions: 3,
      sessionsWithTokens: 2,
      tokenTotal: 900,
      capped: false,
      byModel: [
        { provider: 'p', model: 'm', sessions: 2, tokenTotal: 900 },
        { provider: 'p', model: 7, sessions: 1, tokenTotal: 0 },
      ],
    }),
  ).toEqual({
    sessions: 3,
    sessionsWithTokens: 2,
    tokenTotal: 900,
    capped: false,
    byModel: [{ provider: 'p', model: 'm', sessions: 2, tokenTotal: 900 }],
  });
  // Older engines send no summary.
  expect(readUsageSummary(undefined)).toBeNull();
  expect(readUsageSummary({ sessions: -1, sessionsWithTokens: 0, tokenTotal: 0 })).toBeNull();
});

import { describe, expect, it } from 'vitest';
import { appendModelFeedback } from '../src/shared/model-feedback.js';

describe('appendModelFeedback blank sessionId guard (F2239)', () => {
  it('rejects whitespace-only sessionId and trims valid sessionId', () => {
    expect(() =>
      appendModelFeedback(
        { id: 'm1', revision: 1, feedback: [] } as unknown as Parameters<
          typeof appendModelFeedback
        >[0],
        {
          verdict: 'useful',
          observedRevision: 1,
          evidence: 'Verified against src/index.ts',
          sessionId: '   ',
        },
        '2026-06-01T00:00:00.000Z',
      ),
    ).toThrow('Invalid SAGE feedback sessionId.');

    const updated = appendModelFeedback(
      { id: 'm1', revision: 1, feedback: [] } as unknown as Parameters<
        typeof appendModelFeedback
      >[0],
      {
        verdict: 'useful',
        observedRevision: 1,
        evidence: 'Verified against src/index.ts',
        sessionId: ' sess-1 ',
      },
      '2026-06-01T00:00:00.000Z',
    );
    expect(updated.feedback?.[0]?.sessionId).toBe('sess-1');
  });
});

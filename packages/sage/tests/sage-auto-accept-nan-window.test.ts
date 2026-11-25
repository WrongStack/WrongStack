import { describe, expect, it } from 'vitest';
import { acceptDueConsolidations } from '../src/consolidation/auto-accept.js';

describe('acceptDueConsolidations non-finite windowMs guard (F2237)', () => {
  it('falls back to CONSOLIDATION_AUTO_ACCEPT_MS when windowMs is NaN or negative', async () => {
    const nowMs = Date.UTC(2026, 5, 10, 12, 0, 0);
    const justCreated = new Date(nowMs - 1_000).toISOString();

    const result = await acceptDueConsolidations(
      {
        listCandidates: async () =>
          [
            {
              id: 'cand-1',
              suggestedAction: 'consolidate',
              createdAt: justCreated,
              text: 'Always run tests before merging.',
            },
          ] as unknown as Awaited<
            ReturnType<Parameters<typeof acceptDueConsolidations>[0]['listCandidates']>
          >,
        acceptCandidate: async (id) => ({ id }) as unknown as never,
      },
      nowMs,
      Number.NaN,
    );

    expect(result.accepted).toEqual([]);
  });
});

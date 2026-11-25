import { describe, expect, it } from 'vitest';
import { makeTypeSafeDispatchClassifier } from '../src/typesafe-dispatch-classifier.js';

describe('makeTypeSafeDispatchClassifier option sanitization', () => {
  it('falls back to defaults for negative timeoutMs and NaN thresholds', async () => {
    const candidates = [
      { role: 'coder', summary: 'writes code' },
      { role: 'reviewer', summary: 'reviews code' },
    ] as Parameters<ReturnType<typeof makeTypeSafeDispatchClassifier>>[1];
    const client = {
      systemOne: async () => ({
        answers: {
          which: {
            type: 'choice',
            choice: 'coder',
            confidence: 0.9,
            probabilities: { coder: 0.9 },
          },
          any_fits: { type: 'noul', noul: 0.9 },
        },
      }),
    } as Parameters<typeof makeTypeSafeDispatchClassifier>[0]['client'];

    const classify = makeTypeSafeDispatchClassifier({
      client,
      timeoutMs: -1,
      fitThreshold: Number.NaN,
      minConfidence: Number.NaN,
    });
    expect((await classify('fix bug', candidates))?.role).toBe('coder');
  });
});

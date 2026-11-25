import { describe, expect, it } from 'vitest';
import {
  archetypeScore,
  type FallbackSuggestionId,
  type ScoredFallbackCandidate,
} from '../src/models/fallback-suggest-llm.js';

describe('archetypeScore (F2215)', () => {
  it('falls back to balanced weights for prototype property names', () => {
    const candidate = {
      strength: 0.8,
      speed: 0.5,
      cheapness: 0.5,
      unstable: false,
    } as unknown as ScoredFallbackCandidate;
    expect(archetypeScore(candidate, 'toString' as unknown as FallbackSuggestionId)).toBe(
      archetypeScore(candidate, 'balanced'),
    );
  });
});

import { describe, expect, it } from 'vitest';
import { applyFrequencyBonus, type ExtractedTerm } from '../src/domain-term-candidates.js';

describe('applyFrequencyBonus non-finite mentionCount guard (F1979)', () => {
  it('does not corrupt confidence when mentionCount is NaN', () => {
    const terms: ExtractedTerm[] = [
      {
        term: 'TaskGraph',
        definition: '',
        confidence: 0.7,
        mentionCount: Number.NaN,
        evidence: [],
        sources: ['user'],
      },
      {
        term: 'FleetBus',
        definition: '',
        confidence: 0.7,
        mentionCount: 2,
        evidence: [],
        sources: ['user'],
      },
    ];
    applyFrequencyBonus(terms);
    expect(terms[0]?.confidence).toBe(0.7);
    expect(terms[1]?.confidence).toBeGreaterThan(0.7);
  });
});

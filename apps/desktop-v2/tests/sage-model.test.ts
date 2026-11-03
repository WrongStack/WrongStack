import { describe, expect, it } from 'vitest';
import { fileMemories } from '../src/sage-model';

describe('SAGE file matches', () => {
  it('reads canonical file matches with their provenance instead of treating path search as anchoring', () => {
    expect(
      fileMemories({
        response: {
          primaryMatches: [
            {
              memory: { id: 'a', text: 'Guard the vault' },
              matchedVia: 'anchor_file',
              matchStrength: 0.85,
            },
          ],
          relatedMatches: [{ memory: { id: 'b' }, matchedVia: 'mention', matchStrength: 0.3 }],
        },
      }),
    ).toMatchObject([
      { id: 'a', matchedVia: 'anchor_file', matchStrength: 0.85 },
      { id: 'b', matchedVia: 'mention' },
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import {
  type RefinementDraft,
  refinementDraftCodec,
  refinementDraftResult,
} from '../src/refinement-draft';

const draft: RefinementDraft = {
  original: 'fix the parser',
  mode: 'queue',
  draftAtOpen: 'fix the parser',
  freshContext: false,
  result: {
    refined: 'Fix the parser for empty input.',
    english: 'Fix the parser for empty input.',
    refinedWith: { provider: 'local', model: 'm1' },
  },
  variant: 'refined',
  edited: 'Fix the parser for empty and null input.',
  savedAt: 1_800_000_000_000,
};

describe('refinement review draft', () => {
  it('round-trips a completed review with its edits and provenance', () => {
    expect(refinementDraftCodec.parse(refinementDraftCodec.serialize(draft))).toEqual(draft);
    expect(refinementDraftCodec.parse(null)).toBeNull();
  });
  it('keeps only the reviewable fields of the engine reply', () => {
    expect(
      refinementDraftResult({
        refined: 'R',
        english: '  ',
        refinedWith: { provider: 'p', model: 'm', secret: 'x' },
        usage: { tokens: 3 },
      }),
    ).toEqual({ refined: 'R', refinedWith: { provider: 'p', model: 'm' } });
    // No refined text means there is nothing to review or restore.
    expect(refinementDraftResult({ refined: '' })).toBeNull();
  });
  it('refuses foreign or inconsistent reviews', () => {
    const bad = [
      { ...draft, version: 2 },
      { ...draft, mode: 'later' },
      { ...draft, original: '' },
      { ...draft, variant: 'english', result: { refined: 'R' } },
      { ...draft, edited: 3 },
      { ...draft, freshContext: 'no' },
      { ...draft, result: { refined: 'x'.repeat(1_000_001) } },
    ];
    for (const value of bad)
      expect(() =>
        refinementDraftCodec.parse({
          version: 1,
          ...value,
          ...('version' in value ? { version: value.version } : {}),
        }),
      ).toThrow(/unsupported format/);
  });
});

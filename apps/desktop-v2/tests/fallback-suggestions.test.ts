import { expect, it } from 'vitest';
import { readFallbackSuggestions } from '../src/FallbackSuggestions';

it('reads fallback suggestions and drops chains without models', () => {
  expect(
    readFallbackSuggestions([
      {
        id: 'strong',
        chain: ['a/x', 'b/y', 3],
        score: 0.9,
        providerCount: 2,
        source: 'llm',
        rationale: 'r',
      },
      { id: 'fast', chain: ['a/x', 'a/z'] },
      { id: 'empty', chain: [] },
      { chain: ['a/x'] },
    ]),
  ).toEqual([
    {
      id: 'strong',
      chain: ['a/x', 'b/y'],
      score: 0.9,
      providerCount: 2,
      source: 'llm',
      rationale: 'r',
    },
    {
      id: 'fast',
      chain: ['a/x', 'a/z'],
      score: 0,
      providerCount: 1,
      source: 'heuristic',
      rationale: '',
    },
  ]);
});

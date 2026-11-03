import { entries, record } from './engine-values';

/** SAGE matches for a file from `memory.sage.forFile`, with how each one matched. */
export function fileMemories(value: unknown): Record<string, unknown>[] {
  const data = record(record(value)['response']);
  return ['primaryMatches', 'symbolMatches', 'relatedMatches'].flatMap((bucket) =>
    entries(data[bucket]).map((match) => ({
      ...record(match['memory']),
      matchedVia: match['matchedVia'],
      matchStrength: match['matchStrength'],
      pendingReview: match['pendingReview'],
    })),
  );
}

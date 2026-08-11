import { describe, expect, it } from 'vitest';
import { filterProposalsAgainstPendingTargets } from '../../src/shared/candidate-dedupe.js';

describe('filterProposalsAgainstPendingTargets', () => {
  it('drops proposals that already have a pending targetMemoryId', () => {
    const proposals = [
      { memoryId: 'a', reason: 'x' },
      { memoryId: 'b', reason: 'y' },
      { memoryId: 'c', reason: 'z' },
    ];
    const pending = [
      { status: 'pending', targetMemoryId: 'b' },
      { status: 'accepted', targetMemoryId: 'c' },
      { status: 'pending' },
    ];
    expect(filterProposalsAgainstPendingTargets(proposals, pending)).toEqual([
      { memoryId: 'a', reason: 'x' },
      { memoryId: 'c', reason: 'z' },
    ]);
  });

  it('returns all proposals when nothing is pending', () => {
    const proposals = [{ memoryId: 'a' }];
    expect(filterProposalsAgainstPendingTargets(proposals, [])).toEqual(proposals);
  });
});

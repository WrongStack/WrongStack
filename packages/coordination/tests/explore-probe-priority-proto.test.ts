import { describe, expect, it } from 'vitest';
import { exploreProbePriority } from '../src/explore-probe-policy.js';
import type { ExploreProbe } from '../src/explore-probe-types.js';

describe('exploreProbePriority (F2163)', () => {
  it('ignores prototype keys and returns -1 for unknown sources', () => {
    expect(exploreProbePriority({ source: 'toString' } as unknown as ExploreProbe)).toBe(-1);
    expect(exploreProbePriority({ source: 'constructor' } as unknown as ExploreProbe)).toBe(-1);
    expect(exploreProbePriority({ source: 'mailbox_ask' } as unknown as ExploreProbe)).toBe(5);
  });
});

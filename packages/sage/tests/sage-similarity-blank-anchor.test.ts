import { describe, expect, it } from 'vitest';
import { isNearDuplicateMemory } from '../src/memory-similarity.js';

describe('isNearDuplicateMemory blank anchor guard', () => {
  it('does not treat whitespace-only anchors as shared structural anchors', () => {
    const left = {
      kind: 'fact' as const,
      text: 'alpha beta gamma delta epsilon zeta eta theta',
      anchors: [{ type: 'command' as const, command: '   ' }],
    };
    const right = {
      kind: 'fact' as const,
      text: 'alpha beta gamma delta epsilon zeta omega kappa',
      anchors: [{ type: 'command' as const, command: '   ' }],
    };
    expect(isNearDuplicateMemory(left, right)).toBe(false);

    expect(
      isNearDuplicateMemory(
        { ...left, anchors: [{ type: 'command' as const, command: 'bun test' }] },
        { ...right, anchors: [{ type: 'command' as const, command: '  bun test  ' }] },
      ),
    ).toBe(true);
  });
});

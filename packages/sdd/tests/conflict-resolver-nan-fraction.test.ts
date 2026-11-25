import type { TaskNode } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import { makeLlmConflictResolver } from '../src/conflict-resolver.js';

describe('makeLlmConflictResolver (F2184)', () => {
  it('falls back to default minRetainedFraction when configured value is NaN', async () => {
    let wrote = false;
    const resolver = makeLlmConflictResolver({
      minRetainedFraction: Number.NaN,
      run: async () => 'single line',
      io: {
        read: async () =>
          [
            'line1',
            'line2',
            'line3',
            'line4',
            'line5',
            'line6',
            'line7',
            'line8',
            '<<<<<<< HEAD',
            'ours',
            '=======',
            'theirs',
            '>>>>>>> branch',
          ].join('\n'),
        write: async () => {
          wrote = true;
        },
      },
    });

    const ok = await resolver({
      task: { id: 't1', title: 't' } as unknown as TaskNode,
      conflictFiles: ['a.ts'],
      cwd: '/tmp',
    });
    expect(ok).toBe(false);
    expect(wrote).toBe(false);
  });
});

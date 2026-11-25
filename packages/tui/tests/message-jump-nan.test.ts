import { describe, expect, it } from 'vitest';
import { reduceMessageJump } from '../src/reducers/message-jump.js';

describe('reduceMessageJump non-finite direction guard', () => {
  it('keeps the current entryId when direction is NaN', () => {
    const state = {
      entries: [
        { id: 1, kind: 'user' },
        { id: 2, kind: 'user' },
      ],
      messageJump: { entryId: 1, seq: 1 },
      hint: '',
    } as Parameters<typeof reduceMessageJump>[0];

    const next = reduceMessageJump(state, {
      type: 'messageJump',
      direction: Number.NaN as -1,
    });
    expect(next.messageJump.entryId).toBe(1);
  });
});

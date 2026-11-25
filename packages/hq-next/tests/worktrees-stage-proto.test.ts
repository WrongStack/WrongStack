import { describe, expect, it } from 'vitest';
import { laneSentence } from '../src/features/worktrees/model';

describe('laneSentence prototype-safe stage lookup', () => {
  it('ignores inherited Object.prototype keys in failedStage', () => {
    const out = laneSentence({
      outcome: 'failed',
      failedStage: 'toString' as never,
      conflictFiles: [],
      segments: [],
    } as Parameters<typeof laneSentence>[0]);
    expect(out).toBe('Failed.');
  });
});

import { describe, expect, it } from 'vitest';
import { parseParallelSlots } from '../src/slash-commands/sdd-command-helpers.js';

describe('parseParallelSlots negative input', () => {
  it('rejects negative and zero slot values', () => {
    expect(parseParallelSlots('-5')).toBeUndefined();
    expect(parseParallelSlots('0')).toBeUndefined();
    expect(parseParallelSlots('4')).toEqual({ parallelSlots: 4 });
    expect(parseParallelSlots('99')).toEqual({ parallelSlots: 16 });
  });
});

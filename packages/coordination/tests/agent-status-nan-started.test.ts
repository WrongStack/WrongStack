import { describe, expect, it } from 'vitest';
import { completedToolReceipt } from '../src/agent-status-helpers.js';

describe('completedToolReceipt (F2175)', () => {
  it('sanitizes non-finite pending.startedAt and drops non-finite numeric input fields', () => {
    const receipt = completedToolReceipt(
      { name: 'read_file', input: { line: Number.NaN, limit: 10 } },
      { name: 'read_file', startedAt: Number.NaN },
    );
    expect(Number.isFinite(receipt.startedAt)).toBe(true);
    expect(receipt.input).toEqual({ limit: 10 });
  });
});

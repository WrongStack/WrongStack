import { describe, expect, it } from 'vitest';
import { signalAbortReason } from '../src/core/agent-loop-retry.js';

describe('signalAbortReason (F2176)', () => {
  it('trims abort reasons and falls back when whitespace-only', () => {
    const ac1 = new AbortController();
    ac1.abort('   ');
    expect(signalAbortReason(ac1.signal)).toBe('aborted');

    const ac2 = new AbortController();
    ac2.abort(new Error('   '));
    expect(signalAbortReason(ac2.signal)).toBe('Error');

    const ac3 = new AbortController();
    ac3.abort('  cancelled  ');
    expect(signalAbortReason(ac3.signal)).toBe('cancelled');
  });
});

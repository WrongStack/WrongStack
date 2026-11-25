import { describe, expect, it } from 'vitest';
import { type PendingRequest, rejectPendingRequests } from '../src/client/acp-request-state.js';

describe('rejectPendingRequests re-entrancy guard (F2259)', () => {
  it('clears pending map before rejecting so re-entrant calls cannot double-reject', () => {
    let rejectCount = 0;
    const pending = new Map<string | number, PendingRequest>();
    pending.set(1, {
      method: 'session/prompt',
      resolve: () => {},
      reject: () => {
        rejectCount++;
        if (rejectCount === 1) rejectPendingRequests(pending, 'reentrant');
      },
      timeoutMs: 1000,
      timeoutHandle: setTimeout(() => {}, 1000),
    });

    rejectPendingRequests(pending, 'eof');
    expect(rejectCount).toBe(1);
    expect(pending.size).toBe(0);
  });
});

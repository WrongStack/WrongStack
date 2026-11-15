import { describe, expect, it } from 'vitest';
import { ApprovalFlow } from '../../src/approval-flow.js';

describe('ApprovalFlow timeout overflow guard', () => {
  it('does not expire immediately when expiresAt exceeds 2_147_483_647ms', async () => {
    const flow = new ApprovalFlow({
      log: { debug() {}, info() {}, warn() {}, error() {} } as never,
      api: () => ({ answerCallbackQuery: async () => {} }) as never,
      inboundDenialReason: () => undefined,
    });

    const ac = new AbortController();
    let expiredEarly = false;
    const pending = flow
      .awaitApproval({
        requestId: 'r-ovf',
        sessionId: 's1',
        expectedChatId: 'chat1',
        expectedUserIds: ['u1'],
        allowGroup: false,
        expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
        signal: ac.signal,
      })
      .then((res) => {
        expiredEarly = !ac.signal.aborted && res.fromUser === 'timeout';
        return res;
      });

    await new Promise((r) => setTimeout(r, 30));
    ac.abort();
    await pending;
    expect(expiredEarly).toBe(false);
  });
});

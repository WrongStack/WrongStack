import type { Logger } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import type { TelegramApiCallbackQuery, TelegramApiClient } from '../src/api-client.js';
import { ApprovalFlow } from '../src/approval-flow.js';

describe('ApprovalFlow (F2188)', () => {
  it('fails closed on non-finite expiresAt even for synchronous callbacks', async () => {
    const flow = new ApprovalFlow({
      log: { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger,
      api: () => ({ answerCallbackQuery: async () => {} }) as unknown as TelegramApiClient,
      inboundDenialReason: () => undefined,
    });

    const p = flow.awaitApproval({
      requestId: 'r-nan',
      sessionId: 's1',
      expectedChatId: '100',
      expectedUserIds: ['42'],
      allowGroup: false,
      expiresAt: Number.NaN,
    });
    const req = flow.callbackWaiters.get('r-nan');
    if (req) req.promptMessageId = 7;

    await flow.dispatchCallback({
      id: 'cb1',
      data: 'approve:r-nan:yes',
      from: { id: 42, username: 'alice' },
      message: { message_id: 7, chat: { id: 100, type: 'private' } },
    } as unknown as TelegramApiCallbackQuery);

    const res = await p;
    expect(res.approved).toBe(false);
    expect(res.fromUser).toBe('timeout');
  });
});

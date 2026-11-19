import { describe, expect, it } from 'vitest';
import { type BrainHandlerContext, handleBrainAsk } from '../src/server/brain-handlers.js';

describe('handleBrainAsk input and session validation', () => {
  it('returns usage error without throwing when question is non-string or blank', async () => {
    const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const ctx: BrainHandlerContext = {
      send: (_ws, msg) => sent.push(msg as never),
      brainSettings: { maxAutoRisk: 'medium' },
      getBrainLog: () => [],
      resolveArbiter: () => undefined,
      getSessionId: () => 'fallback-sess',
    };

    for (const badQuestion of [123, {}, null, ['a'], true, '   ']) {
      sent.length = 0;
      await handleBrainAsk(ctx, {} as never, badQuestion as never, 'tab-1', 'req-1');
      expect(sent).toHaveLength(1);
      expect(sent[0]?.type).toBe('key.operation_result');
      expect(sent[0]?.payload).toEqual({
        success: false,
        message: 'Usage: /brain ask <question>',
        sessionId: 'tab-1',
        requestId: 'req-1',
      });
    }
  });

  it('falls back to ctx.getSessionId() when sessionId is empty/whitespace and omits blank fallback or non-string requestId', async () => {
    const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const decided: Array<{ sessionId?: string | undefined; question: string }> = [];
    let fallbackSession: string | undefined = 'fallback-sess';

    const ctx: BrainHandlerContext = {
      send: (_ws, msg) => sent.push(msg as never),
      brainSettings: { maxAutoRisk: 'medium' },
      getBrainLog: () => [],
      resolveArbiter: () =>
        ({
          async decide(req: { sessionId?: string | undefined; question: string }) {
            decided.push({ sessionId: req.sessionId, question: req.question });
            return { type: 'answer', text: 'ok' };
          },
        }) as never,
      getSessionId: () => fallbackSession,
    };

    for (const emptySess of ['', '   ', undefined]) {
      sent.length = 0;
      decided.length = 0;
      await handleBrainAsk(ctx, {} as never, '  Check risk  ', emptySess, 'req-ok');
      expect(decided).toEqual([{ sessionId: 'fallback-sess', question: 'Check risk' }]);
      expect(sent[0]?.type).toBe('brain.answer');
      expect(sent[0]?.payload?.['sessionId']).toBe('fallback-sess');
      expect(sent[0]?.payload?.['requestId']).toBe('req-ok');
    }

    fallbackSession = '   ';
    sent.length = 0;
    decided.length = 0;
    await handleBrainAsk(ctx, {} as never, 'Check unbound', '', 999 as never);
    expect(decided).toEqual([{ sessionId: undefined, question: 'Check unbound' }]);
    expect('sessionId' in (sent[0]?.payload ?? {})).toBe(false);
    expect('requestId' in (sent[0]?.payload ?? {})).toBe(false);
  });
});

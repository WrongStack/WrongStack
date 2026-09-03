import type { BrainArbiter } from '@wrongstack/core/coordination';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { BrainHandlerContext } from '../src/server/brain-handlers.js';
import { createBrainRouteHandlers, handleBrainRoute } from '../src/server/brain-routes.js';
import type { WSClientMessage } from '../src/server/types.js';

/**
 * B-08 (docs/audit/webui-full-review-2026-09-03.md).
 *
 * `validateBrainRiskPayload`, `validateBrainAskPayload` and
 * `validateBrainConfigSetPayload` were written, exported and unit-tested — and
 * called by nothing. Both hosts built the brain route table by hand with inline
 * casts, so a malformed frame reached the handler unchecked and surfaced
 * through whatever guard the handler happened to carry.
 *
 * `createBrainRouteHandlers` is now the single table both hosts use. These
 * tests assert the wiring, not the validators: each one drives a bad payload
 * through the real route chain and pins the FIELD-NAMING message that only the
 * validator produces. If a future refactor unhooks a validator, the handler's
 * own guard will still answer — with a different message — and this fails.
 */

function mockWs(): WebSocket & { send: ReturnType<typeof vi.fn> } {
  return { readyState: 1, send: vi.fn() } as never as WebSocket & {
    send: ReturnType<typeof vi.fn>;
  };
}

function results(ws: { send: ReturnType<typeof vi.fn> }): Array<{
  type: string;
  payload: { success: boolean; message: string };
}> {
  return ws.send.mock.calls.map(
    ([raw]) => JSON.parse(String(raw)) as { type: string; payload: never },
  );
}

/** A context wired richly enough that a VALID payload would do real work. */
function makeCtx(): BrainHandlerContext {
  const arbiter = {
    decide: vi.fn(async () => ({ type: 'proceed', text: 'ok' })),
  } as never as BrainArbiter;
  return {
    send: (ws: WebSocket, message: unknown) => ws.send(JSON.stringify(message)),
    brainSettings: { maxAutoRisk: 'medium' },
    brainRuntime: undefined,
    getBrainLog: () => [],
    resolveArbiter: () => arbiter,
    getSessionId: () => 'sess-1',
  } as never as BrainHandlerContext;
}

async function route(type: string, payload: unknown) {
  const ws = mockWs();
  const ctx = makeCtx();
  const claimed = await handleBrainRoute(
    ws,
    { type, payload } as never as WSClientMessage,
    createBrainRouteHandlers(ctx),
  );
  return { ws, ctx, claimed, sent: results(ws) };
}

describe('brain routes reject malformed payloads through the shared validators', () => {
  it.each([
    ['a non-object payload', 'high'],
    ['a missing level', {}],
    ['a level that is not a string', { level: 3 }],
    ['a level outside the risk ladder', { level: 'catastrophic' }],
  ])('rejects brain.risk with %s', async (_name, payload) => {
    const { claimed, sent } = await route('brain.risk', payload);
    // The route still CLAIMS the message — a rejection is an answer, not a
    // fall-through to "Unknown message type".
    expect(claimed).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe('key.operation_result');
    expect(sent[0]?.payload.success).toBe(false);
    expect(sent[0]?.payload.message).toContain('brain.risk payload');
  });

  it.each([
    ['a non-object payload', 42],
    ['a missing question', {}],
    ['a blank question', { question: '   ' }],
    ['a question that is not a string', { question: ['hi'] }],
  ])('rejects brain.ask with %s', async (_name, payload) => {
    const { claimed, sent } = await route('brain.ask', payload);
    expect(claimed).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload.success).toBe(false);
    expect(sent[0]?.payload.message).toContain('brain.ask payload');
  });

  it.each([
    ['a non-object payload', null],
    ['a missing patch', {}],
    ['a patch that is an array', { patch: [] }],
    ['a patch that is not an object', { patch: 'maxAutoRisk=high' }],
  ])('rejects brain.config.set with %s', async (_name, payload) => {
    const { claimed, sent } = await route('brain.config.set', payload);
    expect(claimed).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload.success).toBe(false);
    expect(sent[0]?.payload.message).toContain('brain.config.set payload');
  });

  it('does not touch the arbiter when brain.ask is malformed', async () => {
    const ws = mockWs();
    const ctx = makeCtx();
    const arbiter = ctx.resolveArbiter();
    await handleBrainRoute(
      ws,
      { type: 'brain.ask', payload: { question: '' } } as never as WSClientMessage,
      createBrainRouteHandlers(ctx),
    );
    expect(arbiter?.decide).not.toHaveBeenCalled();
  });
});

describe('brain routes still serve well-formed payloads', () => {
  it('answers a valid brain.ask from the arbiter', async () => {
    const { sent, ctx } = await route('brain.ask', { question: '  What next?  ' });
    expect(ctx.resolveArbiter()?.decide).toHaveBeenCalledTimes(1);
    expect(sent.some((m) => m.type === 'brain.answer')).toBe(true);
  });

  it('applies a valid brain.risk level and echoes the new status', async () => {
    const { ctx, sent } = await route('brain.risk', { level: 'high' });
    expect(ctx.brainSettings?.maxAutoRisk).toBe('high');
    expect(sent.some((m) => m.type === 'brain.status')).toBe(true);
  });

  // The question reaches the arbiter TRIMMED — the validator normalizes it, so
  // the handler and the decision log see one canonical form.
  it('passes the trimmed question through to the arbiter', async () => {
    const { ctx } = await route('brain.ask', { question: '  Explain the plan  ' });
    expect(ctx.resolveArbiter()?.decide).toHaveBeenCalledWith(
      expect.objectContaining({ question: 'Explain the plan' }),
    );
  });
});

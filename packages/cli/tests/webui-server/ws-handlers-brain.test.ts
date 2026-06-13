import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import type {
  BrainHandlerContext,
  BrainLogEntry,
} from '../../src/webui-server/ws-handlers/brain.js';
import type { WsServerMessage } from '../../src/webui-server/ws-handlers/index.js';
import {
  handleBrainAsk,
  handleBrainRisk,
  handleBrainStatus,
} from '../../src/webui-server/ws-handlers/index.js';

/**
 * PR 5b of Issue #30: Brain ws-handler unit tests.
 *
 * The handlers take a BrainHandlerContext; these drive them with a fake
 * context (capturing send/broadcast) and a stub arbiter so no real Brain,
 * container, or socket is involved.
 */

const FAKE_WS = {} as WebSocket;

interface Captured {
  sent: WsServerMessage[];
}

function makeCtx(over: Partial<BrainHandlerContext> = {}): {
  ctx: BrainHandlerContext;
  cap: Captured;
} {
  const cap: Captured = { sent: [] };
  const ctx: BrainHandlerContext = {
    brainSettings: { maxAutoRisk: 'medium' },
    getBrainLog: () => [],
    resolveArbiter: () => undefined,
    send: (_ws, msg) => cap.sent.push(msg),
    broadcast: () => {},
    log: () => {},
    ...over,
  };
  return { ctx, cap };
}

const lastResultMsg = (cap: Captured) =>
  cap.sent.filter((m) => m.type === 'key.operation_result').at(-1)?.payload as
    | { success: boolean; message: string }
    | undefined;

const lastOfType = (cap: Captured, type: string) => cap.sent.filter((m) => m.type === type).at(-1);

describe('handleBrainStatus', () => {
  it('emits the current ceiling and log', () => {
    const log: BrainLogEntry[] = [{ at: 1, kind: 'auto', question: 'q', outcome: 'allow' }];
    const { ctx, cap } = makeCtx({
      brainSettings: { maxAutoRisk: 'high' },
      getBrainLog: () => log,
    });
    handleBrainStatus(ctx, FAKE_WS);
    const msg = lastOfType(cap, 'brain.status');
    expect(msg?.payload).toEqual({ maxAutoRisk: 'high', log });
  });

  it('defaults the ceiling to medium and log to [] when unwired', () => {
    const { ctx, cap } = makeCtx({ brainSettings: undefined, getBrainLog: undefined });
    handleBrainStatus(ctx, FAKE_WS);
    expect(lastOfType(cap, 'brain.status')?.payload).toEqual({ maxAutoRisk: 'medium', log: [] });
  });
});

describe('handleBrainRisk', () => {
  it('rejects an unknown level', () => {
    const { ctx, cap } = makeCtx();
    handleBrainRisk(ctx, FAKE_WS, 'bogus');
    expect(lastResultMsg(cap)?.success).toBe(false);
    expect(lastResultMsg(cap)?.message).toContain('Unknown risk level');
  });

  it('errors when brain settings are not wired', () => {
    const { ctx, cap } = makeCtx({ brainSettings: undefined });
    handleBrainRisk(ctx, FAKE_WS, 'high');
    expect(lastResultMsg(cap)?.success).toBe(false);
    expect(lastResultMsg(cap)?.message).toContain('not wired');
  });

  it('mutates the shared ceiling and echoes the new status', () => {
    const settings = { maxAutoRisk: 'low' as const };
    const { ctx, cap } = makeCtx({ brainSettings: settings });
    handleBrainRisk(ctx, FAKE_WS, 'all');
    // The SAME object is mutated (shared with /brain).
    expect(settings.maxAutoRisk).toBe('all');
    expect(lastOfType(cap, 'brain.status')?.payload).toMatchObject({ maxAutoRisk: 'all' });
  });
});

describe('handleBrainAsk', () => {
  it('rejects an empty question', async () => {
    const { ctx, cap } = makeCtx();
    await handleBrainAsk(ctx, FAKE_WS, '   ');
    expect(lastResultMsg(cap)?.success).toBe(false);
    expect(lastResultMsg(cap)?.message).toContain('Usage');
  });

  it('errors when no arbiter is wired', async () => {
    const { ctx, cap } = makeCtx({ resolveArbiter: () => undefined });
    await handleBrainAsk(ctx, FAKE_WS, 'should we deploy?');
    expect(lastResultMsg(cap)?.success).toBe(false);
    expect(lastResultMsg(cap)?.message).toContain('No Brain');
  });

  it('forwards the question to the arbiter and emits the answer', async () => {
    const decision = { action: 'allow', reason: 'ok' };
    const seen: Array<{ question: string; risk: string }> = [];
    const { ctx, cap } = makeCtx({
      resolveArbiter: () =>
        ({
          decide: async (req: { question: string; risk: string }) => {
            seen.push({ question: req.question, risk: req.risk });
            return decision as never;
          },
        }) as never,
    });
    await handleBrainAsk(ctx, FAKE_WS, '  ship it?  ');
    // trims the question before forwarding
    expect(seen).toEqual([{ question: 'ship it?', risk: 'medium' }]);
    expect(lastOfType(cap, 'brain.answer')?.payload).toEqual({
      question: 'ship it?',
      decision,
    });
  });

  it('reports a friendly error when the arbiter throws', async () => {
    const { ctx, cap } = makeCtx({
      resolveArbiter: () =>
        ({
          decide: async () => {
            throw new Error('brain offline');
          },
        }) as never,
    });
    await handleBrainAsk(ctx, FAKE_WS, 'q?');
    expect(lastResultMsg(cap)?.success).toBe(false);
    expect(lastResultMsg(cap)?.message).toContain('Brain consultation failed');
    expect(lastResultMsg(cap)?.message).toContain('brain offline');
  });
});

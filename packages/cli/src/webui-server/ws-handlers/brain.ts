import type { BrainArbiter, BrainAutoRisk } from '@wrongstack/core';
import type { WebSocket } from 'ws';
import type { WsCommon } from './index.js';

/**
 * PR 5b of Issue #30: Brain WebSocket handlers (`brain.status` /
 * `brain.risk` / `brain.ask`).
 *
 * Extracted from the `runWebUI` switch. The former closure captures —
 * `opts.brainSettings`, `opts.getBrainLog`, and the
 * `opts.brain ?? container.resolve(TOKENS.BrainArbiter)` lookup — are now
 * fields on `BrainHandlerContext`. The arbiter resolution is passed as a
 * thunk so this module needn't know about the agent container or tokens.
 */

/** A single Brain decision-log entry (newest last). */
export interface BrainLogEntry {
  at: number;
  kind: string;
  question: string;
  outcome: string;
}

export interface BrainHandlerContext extends WsCommon {
  /** Shared autonomy ceiling — the SAME object `/brain` mutates. */
  brainSettings: { maxAutoRisk: BrainAutoRisk } | undefined;
  /** Read the host's rolling Brain decision log, or undefined when not wired. */
  getBrainLog: (() => BrainLogEntry[]) | undefined;
  /** Resolve the active Brain arbiter (host instance, else container-bound), or undefined. */
  resolveArbiter: () => BrainArbiter | undefined;
}

function sendResult(ctx: WsCommon, ws: WebSocket, success: boolean, message: string): void {
  ctx.send(ws, { type: 'key.operation_result', payload: { success, message } });
}

export function handleBrainStatus(ctx: BrainHandlerContext, ws: WebSocket): void {
  ctx.send(ws, {
    type: 'brain.status',
    payload: {
      maxAutoRisk: ctx.brainSettings?.maxAutoRisk ?? 'medium',
      log: ctx.getBrainLog?.() ?? [],
    },
  });
}

export function handleBrainRisk(ctx: BrainHandlerContext, ws: WebSocket, level: string): void {
  const valid = ['off', 'low', 'medium', 'high', 'all'];
  if (!valid.includes(level)) {
    sendResult(ctx, ws, false, `Unknown risk level "${level}". Use: ${valid.join(', ')}.`);
    return;
  }
  if (!ctx.brainSettings) {
    sendResult(ctx, ws, false, 'Brain settings are not wired into this server.');
    return;
  }
  ctx.brainSettings.maxAutoRisk = level as BrainAutoRisk;
  ctx.send(ws, {
    type: 'brain.status',
    payload: { maxAutoRisk: ctx.brainSettings.maxAutoRisk, log: ctx.getBrainLog?.() ?? [] },
  });
}

export async function handleBrainAsk(
  ctx: BrainHandlerContext,
  ws: WebSocket,
  question: string | undefined,
): Promise<void> {
  const q = question?.trim();
  if (!q) {
    sendResult(ctx, ws, false, 'Usage: /brain ask <question>');
    return;
  }
  const arbiter = ctx.resolveArbiter();
  if (!arbiter) {
    sendResult(ctx, ws, false, 'No Brain is wired into this server.');
    return;
  }
  try {
    const decision = await arbiter.decide({
      id: `brain-ask-${Date.now().toString(36)}`,
      source: 'user',
      question: q,
      risk: 'medium',
      fallback: 'ask_human',
    });
    ctx.send(ws, { type: 'brain.answer', payload: { question: q, decision } });
  } catch (err) {
    sendResult(
      ctx,
      ws,
      false,
      `Brain consultation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

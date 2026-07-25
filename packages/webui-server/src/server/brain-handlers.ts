import type { BrainArbiter } from '@wrongstack/core/coordination';
import type { BrainAutoRisk, BrainConfigPatch, BrainRuntime } from '@wrongstack/core/execution';
import type { WebSocket } from 'ws';
import { toErrorMessage } from '@wrongstack/core/utils';
import type { WSServerMessage } from './types.js';

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

export interface BrainTransportContext {
  send: (ws: WebSocket, message: WSServerMessage) => void;
}

export interface BrainHandlerContext extends BrainTransportContext {
  /** Shared autonomy ceiling — the SAME object `/brain` mutates. */
  brainSettings: { maxAutoRisk: BrainAutoRisk } | undefined;
  /**
   * Live-editable Brain config owner. Powers `brain.config.get/set` and
   * enriches `brain.status`; risk-only hosts may leave it undefined.
   */
  brainRuntime?: BrainRuntime | undefined;
  /** Read the host's rolling Brain decision log, or undefined when not wired. */
  getBrainLog: (() => BrainLogEntry[]) | undefined;
  /** Resolve the active Brain arbiter (host instance, else container-bound), or undefined. */
  resolveArbiter: () => BrainArbiter | undefined;
  /** Read the active session id for brain.ask requests. */
  getSessionId?: (() => string | undefined) | undefined;
}

function sendResult(
  ctx: BrainTransportContext,
  ws: WebSocket,
  success: boolean,
  message: string,
): void {
  ctx.send(ws, { type: 'key.operation_result', payload: { success, message } });
}

export function handleBrainStatus(ctx: BrainHandlerContext, ws: WebSocket): void {
  const snapshot = ctx.brainRuntime?.getSnapshot();
  ctx.send(ws, {
    type: 'brain.status',
    payload: {
      maxAutoRisk: ctx.brainSettings?.maxAutoRisk ?? snapshot?.maxAutoRisk ?? 'medium',
      log: ctx.getBrainLog?.() ?? [],
      // Additive enrichment — only present when a BrainRuntime is wired.
      ...(snapshot
        ? {
            mode: snapshot.mode,
            poolLabels: snapshot.poolLabels,
            councilLabels: snapshot.councilLabels,
            // Status already lists the seats; without the judge it does not
            // say who breaks their ties — and the derived judge is exactly
            // the one that can silently be one of those seats.
            judgeLabel: snapshot.judgeLabel,
            // Naming the judge without saying whether it also voted would just
            // move the blind spot one level down.
            judgeIsVoter: snapshot.judgeIsVoter,
            ledgerPath: snapshot.ledger.path,
          }
        : {}),
    },
  });
}

export function handleBrainConfigGet(ctx: BrainHandlerContext, ws: WebSocket): void {
  if (!ctx.brainRuntime) {
    sendResult(
      ctx,
      ws,
      false,
      'Brain config is not editable on this server (no BrainRuntime wired).',
    );
    return;
  }
  ctx.send(ws, {
    type: 'brain.config',
    payload: { config: ctx.brainRuntime.getSnapshot(), persisted: true },
  });
}

export async function handleBrainConfigSet(
  ctx: BrainHandlerContext,
  ws: WebSocket,
  payload: unknown,
): Promise<void> {
  if (!ctx.brainRuntime) {
    sendResult(
      ctx,
      ws,
      false,
      'Brain config is not editable on this server (no BrainRuntime wired).',
    );
    return;
  }
  const patch = (payload as { patch?: unknown } | undefined)?.patch;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    sendResult(ctx, ws, false, 'brain.config.set requires a { patch: {...} } payload.');
    return;
  }
  try {
    // The runtime is the validator: unknown fields / bad values throw
    // BEFORE any live state changes.
    const { persisted } = ctx.brainRuntime.apply(patch as BrainConfigPatch);
    const result = await persisted;
    ctx.send(ws, {
      type: 'brain.config',
      payload: {
        config: ctx.brainRuntime.getSnapshot(),
        persisted: result.ok,
        ...(result.ok ? {} : { error: result.error ?? 'Persist failed.' }),
      },
    });
    // Keep risk-only surfaces (status views, TUI mirrors) in sync.
    handleBrainStatus(ctx, ws);
  } catch (err) {
    ctx.send(ws, {
      type: 'brain.config',
      payload: {
        config: ctx.brainRuntime.getSnapshot(),
        persisted: false,
        error: `Invalid Brain setting: ${toErrorMessage(err)}`,
      },
    });
  }
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
      sessionId: ctx.getSessionId?.(),
      source: 'user',
      question: q,
      risk: 'medium',
      fallback: 'ask_human',
    });
    ctx.send(ws, {
      type: 'brain.answer',
      payload: { sessionId: ctx.getSessionId?.(), question: q, decision },
    });
  } catch (err) {
    sendResult(ctx, ws, false, `Brain consultation failed: ${toErrorMessage(err)}`);
  }
}

import type { BrainArbiter } from '@wrongstack/core/coordination';
import type { BrainAutoRisk, BrainConfigPatch, BrainRuntime } from '@wrongstack/core/execution';
import { BUILTIN_COUNCIL_PERSONAS } from '@wrongstack/core/execution';
import { toErrorMessage } from '@wrongstack/core/utils';
import type { WebSocket } from 'ws';
import type { WSServerMessage } from './types.js';

/**
 * Council decision lenses published to the browser.
 *
 * The settings section used to hard-code `['executor','skeptic','auditor']`,
 * so the registry's `security`, `maintainer` and `user-advocate` lenses were
 * unselectable. Sending the registry keeps the picker honest as lenses are
 * added, instead of leaving three copies of the list to drift.
 */
const COUNCIL_PERSONA_CATALOG = Object.freeze(
  BUILTIN_COUNCIL_PERSONAS.map((persona) =>
    Object.freeze({
      id: persona.id,
      name: persona.name,
      description: persona.description,
      ...(persona.defaultVeto !== undefined ? { defaultVeto: persona.defaultVeto } : {}),
    }),
  ),
);

/** Snapshot decorated with the static persona catalog the browser renders. */
function brainConfigPayload(runtime: BrainRuntime): Record<string, unknown> {
  return { ...runtime.getSnapshot(), personaCatalog: COUNCIL_PERSONA_CATALOG };
}

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
  /**
   * The session the decision was about. The Brain is project-wide, but each
   * decision concerns one session's tool call — a tab asking `/brain` wants
   * ITS decisions, not an unlabelled mixture of every open tab's.
   * Undefined for decisions that named no session.
   */
  sessionId?: string | undefined;
  /**
   * Which tier of the ladder resolved the decision, when the chain recorded
   * one. Passed through verbatim so a client can tell a free deterministic
   * verdict from one that cost a provider call.
   */
  tier?: string | undefined;
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

export function handleBrainStatus(
  ctx: BrainHandlerContext,
  ws: WebSocket,
  sessionId?: string | undefined,
): void {
  const snapshot = ctx.brainRuntime?.getSnapshot();
  const log = ctx.getBrainLog?.() ?? [];
  ctx.send(ws, {
    type: 'brain.status',
    payload: {
      maxAutoRisk: ctx.brainSettings?.maxAutoRisk ?? snapshot?.maxAutoRisk ?? 'medium',
      sessionId,
      // Show the asking tab its own decisions plus the unattributed ones.
      // Without the filter, `/brain` in one tab reported three other tabs'
      // decisions as if they were its own.
      log: sessionId ? log.filter((e) => !e.sessionId || e.sessionId === sessionId) : log,
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
    payload: { config: brainConfigPayload(ctx.brainRuntime), persisted: true },
  });
}

export async function handleBrainConfigSet(
  ctx: BrainHandlerContext,
  ws: WebSocket,
  payload: unknown,
  /** The tab that changed the setting — the follow-up status is stamped for it. */
  sessionId?: string | undefined,
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
        config: brainConfigPayload(ctx.brainRuntime),
        persisted: result.ok,
        ...(result.ok ? {} : { error: result.error ?? 'Persist failed.' }),
      },
    });
    // Keep risk-only surfaces (status views, TUI mirrors) in sync.
    handleBrainStatus(ctx, ws, sessionId);
  } catch (err) {
    ctx.send(ws, {
      type: 'brain.config',
      payload: {
        config: brainConfigPayload(ctx.brainRuntime),
        persisted: false,
        error: `Invalid Brain setting: ${toErrorMessage(err)}`,
      },
    });
  }
}

export function handleBrainRisk(
  ctx: BrainHandlerContext,
  ws: WebSocket,
  level: string,
  sessionId?: string | undefined,
): void {
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
  // The ceiling itself is project-wide (one shared settings object), but the
  // status frame that reports it is not: sending the unfiltered log handed
  // the asking tab three other tabs' decisions, and sending it untagged put
  // it in whichever lane happened to be in front.
  handleBrainStatus(ctx, ws, sessionId);
}

export async function handleBrainAsk(
  ctx: BrainHandlerContext,
  ws: WebSocket,
  question: string | undefined,
  /**
   * The tab that asked. `ctx.getSessionId()` is the runtime's session — with
   * four tabs open that is the one the runtime last switched to, so a
   * background tab's `/brain ask` was attributed to another session, filed
   * under its decisions, and answered with a stamp the asking tab's own
   * session gate then dropped.
   */
  sessionId?: string | undefined,
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
    const answerSessionId = sessionId ?? ctx.getSessionId?.();
    const decision = await arbiter.decide({
      id: `brain-ask-${Date.now().toString(36)}`,
      sessionId: answerSessionId,
      source: 'user',
      question: q,
      risk: 'medium',
      fallback: 'ask_human',
    });
    ctx.send(ws, {
      type: 'brain.answer',
      // Omit sessionId when there is no session: this is a direct reply to
      // the asker, not a broadcast, but the client's session gate
      // (isActiveSessionMessage) is fail-closed on a present-but-empty
      // sessionId — stamping '' would hide the answer from its own asker
      // in an embedded host with an unbound agent context.
      payload: {
        ...(answerSessionId ? { sessionId: answerSessionId } : {}),
        question: q,
        decision,
      },
    });
  } catch (err) {
    sendResult(ctx, ws, false, `Brain consultation failed: ${toErrorMessage(err)}`);
  }
}

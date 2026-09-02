/**
 * BrainTelemetryBridge — forwards local Brain (decision layer) events to the
 * HQ publisher as `brain.event` envelopes, so the command center can observe
 * decision requests, answers, denials, ask-human escalations, and
 * self-activated interventions across every connected machine.
 *
 * Source: the `brain.*` EventBus events emitted by `ObservableBrainArbiter`
 * (`coordination/brain.ts`) and `BrainMonitor` (`coordination/brain-monitor.ts`).
 * All payloads are plain serializable data (request id, question, source, risk,
 * decision kind, rationale) — no closures, no decoupled relay needed.
 *
 * The webui `setup-events.ts` already forwards these verbatim to its browser;
 * this bridge does the same for the cross-machine HQ plane.
 *
 * @module hq/brain-bridge
 */
import type { EventBus } from '../kernel/events.js';
import type { BrainDecision, BrainDecisionRequest } from '../coordination/brain.js';
import type { HqBrainEventKind, HqBrainEventPayload, HqEventEnvelope } from './protocol.js';
import { createBridgeContext, type BridgeContextOptions } from './bridge-context.js';

export interface BrainTelemetryBridgeOptions extends BridgeContextOptions {
  /** Local EventBus emitting `brain.*` events. */
  events: EventBus;
}

function extractRequestFields(req: BrainDecisionRequest | undefined): {
  requestId?: string;
  question?: string;
  source?: string;
  risk?: string;
} {
  if (req === undefined) return {};
  const out: { requestId?: string; question?: string; source?: string; risk?: string } = {};
  if (typeof req.id === 'string') out.requestId = req.id;
  if (typeof req.question === 'string') out.question = req.question;
  if (typeof req.source === 'string') out.source = req.source;
  if (typeof req.risk === 'string') out.risk = req.risk;
  return out;
}

function extractDecisionFields(dec: BrainDecision | undefined): {
  decision?: string;
  detail?: string;
} {
  if (dec === undefined) return {};
  const out: { decision?: string; detail?: string } = {};
  // BrainDecision is a discriminated union on `type` (answer | ask_human | deny).
  out.decision = dec.type;
  if (dec.type === 'answer') {
    out.detail = dec.text;
  } else if (dec.type === 'ask_human') {
    out.detail = dec.prompt;
  } else if (dec.type === 'deny') {
    out.detail = dec.reason;
  }
  return out;
}

/**
 * Start forwarding brain events to HQ. Returns a disposer that unsubscribes
 * all listeners — call on shutdown.
 */
export function startBrainTelemetryBridge(opts: BrainTelemetryBridgeOptions): () => void {
  const { events } = opts;
  const ctx = createBridgeContext(opts);

  function publish(
    kind: HqBrainEventKind,
    payload: Partial<HqBrainEventPayload>,
    at: number,
  ): void {
    ctx.safePublish({
      type: 'brain.event',
      payload: { kind, at, ...payload } as HqBrainEventPayload,
      ...ctx.sessionIdTag(),
      timestamp: ctx.now(),
    });
  }

  ctx.track(
    events.on('brain.decision_requested', (p) => {
      publish('decision_requested', extractRequestFields(p.request), p.at);
    }),
  );
  ctx.track(
    events.on('brain.decision_answered', (p) => {
      publish(
        'decision_answered',
        {
          ...extractRequestFields(p.request),
          ...extractDecisionFields(p.decision),
        },
        p.at,
      );
    }),
  );
  ctx.track(
    events.on('brain.decision_ask_human', (p) => {
      publish(
        'decision_ask_human',
        {
          ...extractRequestFields(p.request),
          ...extractDecisionFields(p.decision),
        },
        p.at,
      );
    }),
  );
  ctx.track(
    events.on('brain.decision_denied', (p) => {
      publish(
        'decision_denied',
        {
          ...extractRequestFields(p.request),
          ...extractDecisionFields(p.decision),
        },
        p.at,
      );
    }),
  );
  ctx.track(
    events.on('brain.human_answered', (p) => {
      const detail = typeof p.text === 'string' ? p.text : p.optionId;
      publish(
        'human_answered',
        {
          requestId: p.id,
          ...(detail !== undefined ? { detail } : {}),
          ...(p.deny === true ? { decision: 'deny' } : {}),
        },
        p.at,
      );
    }),
  );
  ctx.track(
    events.on('brain.intervention', (p) => {
      publish(
        'intervention',
        {
          ...extractRequestFields(p.request),
          ...extractDecisionFields(p.decision),
          interventionKind: p.kind,
          intervened: p.intervened,
        },
        p.at,
      );
    }),
  );

  return ctx.dispose;
}

/** Re-export for type-only consumers. */
export type { HqEventEnvelope };

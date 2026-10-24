/**
 * BrainTelemetryBridge — forwards local Brain (decision layer) events to the
 * HQ publisher as `brain.event` envelopes, so the command center can observe
 * decision requests, answers, denials, ask-human escalations, and
 * self-activated interventions across every connected machine.
 *
 * Source: the `brain.*` EventBus events emitted by `ObservableBrainArbiter`
 * (`brain/brain.ts`) and `BrainMonitor` (`brain/brain-monitor.ts`).
 * All payloads are plain serializable data (request id, question, source, risk,
 * decision kind, rationale) — no closures, no decoupled relay needed.
 *
 * The webui `setup-events.ts` already forwards these verbatim to its browser;
 * this bridge does the same for the cross-machine HQ plane.
 *
 * @module hq/brain-bridge
 */

import type { EventBus } from '@wrongstack/contracts/kernel/events';
import type { BrainDecision, BrainDecisionRequest } from '@wrongstack/contracts/types/brain';
import { type BridgeContextOptions, createBridgeContext } from './bridge-context.js';
import type { HqBrainEventKind, HqBrainEventPayload, HqEventEnvelope } from './protocol.js';

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

  /**
   * `correlationId` groups the envelopes of one Brain activity: every event
   * carrying the same decision request id is that one request observed over
   * time, so HQ can render requested → answered → intervened as a chain rather
   * than N unrelated rows. It is not a dedup key — the same id legitimately
   * appears on several distinct envelopes.
   */
  function publish(
    kind: HqBrainEventKind,
    payload: Partial<HqBrainEventPayload>,
    at: number,
    correlationId?: string,
    sessionId?: string,
  ): void {
    ctx.safePublish({
      type: 'brain.event',
      payload: { kind, at, ...payload } as HqBrainEventPayload,
      ...ctx.sessionIdTag(sessionId),
      ...(correlationId !== undefined ? { correlationId } : {}),
      timestamp: ctx.now(),
    });
  }

  ctx.track(
    events.on('brain.decision_requested', (p) => {
      publish(
        'decision_requested',
        extractRequestFields(p.request),
        p.at,
        p.request?.id,
        p.sessionId ?? p.request?.sessionId,
      );
    }),
  );
  ctx.track(
    events.on('brain.decision_answered', (p) => {
      publish(
        'decision_answered',
        {
          ...extractRequestFields(p.request),
          ...extractDecisionFields(p.decision),
          // Provenance is what separates a free rule hit from a council call.
          ...(p.tier ? { tier: p.tier } : {}),
        },
        p.at,
        p.request?.id,
        p.sessionId ?? p.request?.sessionId,
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
          ...(p.tier ? { tier: p.tier } : {}),
          // A pending prompt means a human is being waited on RIGHT NOW —
          // the one brain state a fleet operator can act on.
          ...(p.pending ? { pending: true } : {}),
        },
        p.at,
        p.request?.id,
        p.sessionId ?? p.request?.sessionId,
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
          ...(p.tier ? { tier: p.tier } : {}),
        },
        p.at,
        p.request?.id,
        p.sessionId ?? p.request?.sessionId,
      );
    }),
  );
  // Council panels are the Brain's most expensive tier and its most
  // failure-prone one (correlated seats, starved voters, a judge that is also
  // a voter). HQ saw none of it: a degraded panel produced a perfectly
  // ordinary `decision_answered` row.
  ctx.track(
    events.on('brain.council_resolved', (p) => {
      publish(
        'council_resolved',
        {
          requestId: p.requestId,
          decision: p.status,
          resolution: p.resolution,
          seatCount: p.configuredSeatCount,
          validVoteCount: p.validVoteCount,
          distinctTargetCount: p.distinctTargetCount,
          ...(p.judgeLabel !== undefined
            ? { judgeLabel: p.judgeLabel, judgeIsVoter: p.judgeIsVoter === true }
            : {}),
          ...(p.usage ? { totalTokens: p.usage.totalTokens } : {}),
          ...(p.rounds !== undefined
            ? { rounds: p.rounds, deliberationChanges: p.deliberationChanges ?? 0 }
            : {}),
          ...(p.warnings?.length ? { warnings: [...p.warnings] } : {}),
        },
        p.at,
        p.requestId,
        p.sessionId,
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
        p.id,
        p.sessionId,
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
        p.request?.id,
        p.sessionId ?? p.request?.sessionId,
      );
    }),
  );

  return ctx.dispose;
}

/** Re-export for type-only consumers. */
export type { HqEventEnvelope };

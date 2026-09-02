import { createHash } from 'node:crypto';
import type { BrainDecision, BrainDecisionRequest } from '../coordination/brain.js';
import type { EventBus } from '../kernel/events.js';
import type { ChronicleContext } from './context.js';
import type { ChronicleEventSink } from './sink.js';
import type { ChronicleEventInput } from './types.js';

export interface ChronicleDecisionAdapterOptions {
  events: EventBus;
  journal: ChronicleEventSink;
  context: ChronicleContext | (() => ChronicleContext);
  onPersistError?: ((error: unknown, event: ChronicleEventInput) => void) | undefined;
}

/** Decision provenance without persisting raw questions, context or rationale. */
export function wireDecisionsToChronicle(options: ChronicleDecisionAdapterOptions): () => void {
  const write = (
    eventType: string,
    at: number,
    sessionId: string | undefined,
    requestId: string,
    attributes: Record<string, unknown>,
    outcome: ChronicleEventInput['outcome'],
  ): void => {
    const context = typeof options.context === 'function' ? options.context() : options.context;
    const input: ChronicleEventInput = {
      eventType,
      occurredAt: new Date(at).toISOString(),
      outcome,
      scope: { ...context.scope, ...(sessionId ? { sessionId } : {}) },
      correlation: context.correlation,
      resource: { kind: 'other', id: `decision:${requestId}` },
      attributes: { decisionId: requestId, ...attributes },
    };
    void options.journal.append(input).catch((error) => options.onPersistError?.(error, input));
  };
  const requestAttrs = (request: BrainDecisionRequest) => ({
    source: request.source,
    risk: request.risk,
    fallback: request.fallback,
    questionHash: hash(request.question),
    contextHash: hash(request.context),
    optionCount: request.options?.length ?? 0,
    options: request.options?.map((option) => ({
      id: option.id,
      risk: option.risk,
      recommended: option.recommended ?? false,
      labelHash: hash(option.label),
      consequenceHash: hash(option.consequence),
    })),
  });
  const decisionAttrs = (decision: BrainDecision) => ({
    type: decision.type,
    ...('optionId' in decision && decision.optionId ? { optionId: decision.optionId } : {}),
    contentHash: hash(
      'text' in decision ? decision.text : 'prompt' in decision ? decision.prompt : decision.reason,
    ),
    rationaleHash: hash('rationale' in decision ? decision.rationale : undefined),
  });

  const offs = [
    options.events.on('brain.decision_requested', (e) =>
      write(
        'decision.requested',
        e.at,
        e.sessionId,
        e.request.id,
        requestAttrs(e.request),
        'started',
      ),
    ),
    options.events.on('brain.decision_answered', (e) =>
      write(
        'decision.resolved',
        e.at,
        e.sessionId,
        e.request.id,
        { ...requestAttrs(e.request), ...decisionAttrs(e.decision), resolver: 'brain' },
        'success',
      ),
    ),
    options.events.on('brain.decision_ask_human', (e) =>
      write(
        'decision.escalated',
        e.at,
        e.sessionId,
        e.request.id,
        { ...requestAttrs(e.request), ...decisionAttrs(e.decision) },
        'started',
      ),
    ),
    options.events.on('brain.decision_denied', (e) =>
      write(
        'decision.denied',
        e.at,
        e.sessionId,
        e.request.id,
        { ...requestAttrs(e.request), ...decisionAttrs(e.decision) },
        'denied',
      ),
    ),
    options.events.on('brain.human_answered', (e) =>
      write(
        'decision.human_answered',
        e.at,
        e.sessionId,
        e.id,
        {
          resolver: 'human',
          optionId: e.optionId,
          denied: e.deny ?? false,
          answerHash: hash(e.text),
        },
        e.deny ? 'denied' : 'success',
      ),
    ),
    options.events.on('brain.outcome', (e) =>
      write(
        'decision.outcome_observed',
        e.at,
        e.sessionId,
        e.requestId,
        { observedOutcome: e.outcome, detailHash: hash(e.detail) },
        e.outcome,
      ),
    ),
  ];
  return () =>
    offs.forEach((off) => {
      off();
    });
}

function hash(value: string | undefined): string | undefined {
  return value ? createHash('sha256').update(value).digest('hex') : undefined;
}

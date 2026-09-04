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
        {
          ...requestAttrs(e.request),
          ...decisionAttrs(e.decision),
          resolver: 'brain',
          // `resolver: 'brain'` flattens a free rule hit, a cache replay and a
          // multi-model council into one bucket. The tier is the only field
          // that makes cross-session cost analysis possible, and it is pure
          // structural metadata — no question, context or rationale.
          ...(e.tier ? { tier: e.tier } : {}),
        },
        'success',
      ),
    ),
    options.events.on('brain.decision_ask_human', (e) =>
      write(
        'decision.escalated',
        e.at,
        e.sessionId,
        e.request.id,
        {
          ...requestAttrs(e.request),
          ...decisionAttrs(e.decision),
          ...(e.tier ? { tier: e.tier } : {}),
          // The same event name carries the PROMPT and a final ask_human.
          // Without this flag one escalated decision writes two identical
          // rows and every "how often does the Brain escalate" query
          // double-counts interactive sessions.
          pending: e.pending === true,
        },
        'started',
      ),
    ),
    options.events.on('brain.decision_denied', (e) =>
      write(
        'decision.denied',
        e.at,
        e.sessionId,
        e.request.id,
        {
          ...requestAttrs(e.request),
          ...decisionAttrs(e.decision),
          ...(e.tier ? { tier: e.tier } : {}),
        },
        'denied',
      ),
    ),
    // Council panels are the Brain's only multi-model tier and its whole
    // cost story. All of this is structural — seat counts, model distinctness,
    // token totals — so it persists without any content redaction.
    options.events.on('brain.council_resolved', (e) =>
      write(
        'decision.council_resolved',
        e.at,
        e.sessionId,
        e.requestId,
        {
          status: e.status,
          resolution: e.resolution,
          configuredSeatCount: e.configuredSeatCount,
          validVoteCount: e.validVoteCount,
          distinctTargetCount: e.distinctTargetCount,
          judgeUsed: e.judgeUsed,
          judgeIsVoter: e.judgeIsVoter ?? false,
          // Deliberation doubles a panel's cost, so the round count belongs
          // next to the token totals; `deliberationChanges` is what says
          // whether that spend bought anything.
          rounds: e.rounds ?? 1,
          deliberationChanges: e.deliberationChanges ?? 0,
          inputTokens: e.usage?.inputTokens ?? 0,
          outputTokens: e.usage?.outputTokens ?? 0,
          totalTokens: e.usage?.totalTokens ?? 0,
          calls: e.usage?.calls ?? 0,
          durationMs: e.usage?.durationMs ?? 0,
          warnings: e.warnings ?? [],
        },
        e.status === 'decided' ? 'success' : e.status === 'denied' ? 'denied' : 'failure',
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

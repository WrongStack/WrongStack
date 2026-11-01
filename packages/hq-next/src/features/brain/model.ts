/**
 * Brain rules as pure functions: the event trail folded into decisions.
 *
 * A request, its answer (or denial, or escalation to a human, and the human's
 * answer) share a request id within one session; they are one decision, read
 * together. Interventions and council results without a request id stand alone.
 */
import type { HqBrainEventPayload, HqEventEnvelope } from '@wrongstack/hq';

/**
 * Tiers that reach a verdict without a provider call. Mirrors core's
 * `DETERMINISTIC_BRAIN_TIERS`; a literal because the browser bundle must not
 * pull core's runtime.
 */
export const FREE_TIERS: ReadonlySet<string> = new Set([
  'rule',
  'policy',
  'heuristic',
  'cache',
  'ledger-guard',
  'terminal',
]);

export type Outcome = 'open' | 'answered' | 'denied' | 'waiting' | 'escalated' | 'human';

export const OUTCOME_LABEL: Record<Outcome, string> = {
  open: 'No answer yet',
  answered: 'Answered',
  denied: 'Denied',
  waiting: 'Waiting on a human',
  escalated: 'Handed to a human',
  human: 'A human answered',
};

export interface Council {
  resolution: string | undefined;
  decision: string | undefined;
  seats: number;
  votes: number;
  distinctModels: number;
  judge: string | undefined;
  judgeIsVoter: boolean;
  tokens: number;
  rounds: number | undefined;
  warnings: string[];
  /** Fewer usable votes than seats, seats collapsing onto fewer models, a voting judge, or a failed panel. */
  degraded: boolean;
}

export interface Decision {
  kind: 'decision';
  key: string;
  requestId: string | undefined;
  projectId: string;
  sessionId: string | undefined;
  question: string | undefined;
  source: string | undefined;
  risk: string | undefined;
  tier: string | undefined;
  outcome: Outcome;
  decision: string | undefined;
  detail: string | undefined;
  humanDetail: string | undefined;
  council: Council | undefined;
  startedAt: number;
  lastAt: number;
  steps: HqBrainEventPayload[];
}

export interface Intervention {
  kind: 'intervention';
  key: string;
  projectId: string;
  sessionId: string | undefined;
  signal: string | undefined;
  steered: boolean;
  detail: string | undefined;
  lastAt: number;
}

export type TrailItem = Decision | Intervention;

function councilOf(payload: HqBrainEventPayload): Council {
  const seats = payload.seatCount ?? 0;
  const votes = payload.validVoteCount ?? 0;
  const distinctModels = payload.distinctTargetCount ?? 0;
  const warnings = payload.warnings ?? [];
  return {
    resolution: payload.resolution,
    decision: payload.decision,
    seats,
    votes,
    distinctModels,
    judge: payload.judgeLabel,
    judgeIsVoter: payload.judgeIsVoter === true,
    tokens: payload.totalTokens ?? 0,
    rounds: payload.rounds,
    warnings,
    degraded:
      warnings.length > 0 ||
      payload.judgeIsVoter === true ||
      votes < seats ||
      (votes > 0 && distinctModels < votes) ||
      ['failed', 'cancelled', 'abstained'].includes(payload.decision ?? ''),
  };
}

function outcomeAfter(current: Outcome, payload: HqBrainEventPayload): Outcome {
  switch (payload.kind) {
    case 'decision_answered':
      return current === 'human' ? current : 'answered';
    case 'decision_denied':
      return current === 'human' ? current : 'denied';
    case 'decision_ask_human':
      if (current === 'human') return current;
      return payload.pending === true ? 'waiting' : 'escalated';
    case 'human_answered':
      return 'human';
    default:
      return current;
  }
}

/** Fold brain envelopes (any order) into decisions and interventions, newest activity first. */
export function buildTrail(events: readonly HqEventEnvelope[]): TrailItem[] {
  const ordered = [...events]
    .filter(
      (event) =>
        event.type === 'brain.event' && typeof event.payload === 'object' && event.payload !== null,
    )
    .sort(
      (left, right) =>
        (left.payload as HqBrainEventPayload).at - (right.payload as HqBrainEventPayload).at,
    );
  const decisions = new Map<string, Decision>();
  const items: TrailItem[] = [];

  for (const event of ordered) {
    const payload = event.payload as HqBrainEventPayload;
    if (payload.kind === 'intervention') {
      items.push({
        kind: 'intervention',
        key: event.id,
        projectId: event.projectId,
        sessionId: event.sessionId,
        signal: payload.interventionKind,
        steered: payload.intervened === true,
        detail: payload.detail,
        lastAt: payload.at,
      });
      continue;
    }
    const key =
      payload.requestId !== undefined && payload.requestId !== ''
        ? JSON.stringify([event.clientId, event.sessionId ?? '', payload.requestId])
        : event.id;
    let decision = decisions.get(key);
    if (decision === undefined) {
      decision = {
        kind: 'decision',
        key,
        requestId: payload.requestId,
        projectId: event.projectId,
        sessionId: event.sessionId,
        question: undefined,
        source: undefined,
        risk: undefined,
        tier: undefined,
        outcome: 'open',
        decision: undefined,
        detail: undefined,
        humanDetail: undefined,
        council: undefined,
        startedAt: payload.at,
        lastAt: payload.at,
        steps: [],
      };
      decisions.set(key, decision);
      items.push(decision);
    }
    decision.steps.push(payload);
    decision.lastAt = Math.max(decision.lastAt, payload.at);
    decision.question ??= payload.question;
    decision.source ??= payload.source;
    if (payload.risk !== undefined) decision.risk = payload.risk;
    if (payload.tier !== undefined) decision.tier = payload.tier;
    if (payload.kind === 'council_resolved') {
      decision.council = councilOf(payload);
      decision.decision ??= payload.decision;
      continue;
    }
    decision.outcome = outcomeAfter(decision.outcome, payload);
    if (payload.kind === 'human_answered') {
      decision.humanDetail = payload.detail ?? payload.decision;
    } else if (payload.kind !== 'decision_requested') {
      if (payload.decision !== undefined) decision.decision = payload.decision;
      if (payload.detail !== undefined) decision.detail = payload.detail;
    }
  }
  return items.sort((left, right) => right.lastAt - left.lastAt);
}

export function isHighRisk(risk: string | undefined): boolean {
  return risk === 'high' || risk === 'critical';
}

export function isModelBacked(tier: string | undefined): boolean {
  return tier !== undefined && !FREE_TIERS.has(tier);
}

export type TrailFilter = 'all' | 'waiting' | 'high-risk' | 'model' | 'interventions';

export function filterTrail(items: readonly TrailItem[], filter: TrailFilter): TrailItem[] {
  switch (filter) {
    case 'waiting':
      return items.filter((item) => item.kind === 'decision' && item.outcome === 'waiting');
    case 'high-risk':
      return items.filter((item) => item.kind === 'decision' && isHighRisk(item.risk));
    case 'model':
      return items.filter((item) => item.kind === 'decision' && isModelBacked(item.tier));
    case 'interventions':
      return items.filter((item) => item.kind === 'intervention');
    default:
      return [...items];
  }
}

export interface TrailSummary {
  decisions: number;
  answered: number;
  denied: number;
  waiting: number;
  humans: number;
  highRisk: number;
  modelBacked: number;
  free: number;
  interventions: number;
  steered: number;
  councilTokens: number;
  degradedPanels: number;
}

export function summarize(items: readonly TrailItem[]): TrailSummary {
  const summary: TrailSummary = {
    decisions: 0,
    answered: 0,
    denied: 0,
    waiting: 0,
    humans: 0,
    highRisk: 0,
    modelBacked: 0,
    free: 0,
    interventions: 0,
    steered: 0,
    councilTokens: 0,
    degradedPanels: 0,
  };
  for (const item of items) {
    if (item.kind === 'intervention') {
      summary.interventions += 1;
      if (item.steered) summary.steered += 1;
      continue;
    }
    summary.decisions += 1;
    if (item.outcome === 'answered') summary.answered += 1;
    if (item.outcome === 'denied') summary.denied += 1;
    if (item.outcome === 'waiting') summary.waiting += 1;
    if (item.outcome === 'escalated' || item.outcome === 'human') summary.humans += 1;
    if (isHighRisk(item.risk)) summary.highRisk += 1;
    if (isModelBacked(item.tier)) summary.modelBacked += 1;
    else if (item.tier !== undefined) summary.free += 1;
    if (item.council !== undefined) {
      summary.councilTokens += item.council.tokens;
      if (item.council.degraded) summary.degradedPanels += 1;
    }
  }
  return summary;
}

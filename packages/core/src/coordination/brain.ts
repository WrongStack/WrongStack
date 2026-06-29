/**
 * Brain coordination primitives.
 *
 * Brain is an authority layer above a leader/director but below the human. It is
 * intentionally modeled as a decision interface first, not as an autonomous
 * bypass: callers ask for a decision, Brain either answers within policy or
 * escalates to the human.
 */

import type { EventBus } from '../kernel/events.js';

export type BrainDecisionSource = 'autophase' | 'director' | 'tool' | 'user' | 'system';

export type BrainRisk = 'low' | 'medium' | 'high' | 'critical';

export type BrainFallback = 'ask_human' | 'deny' | 'continue';

export interface BrainDecisionOption {
  id: string;
  label: string;
  consequence?: string | undefined;
  risk?: BrainRisk | undefined;
  recommended?: boolean | undefined;
}

export interface BrainDecisionRequest {
  id: string;
  /** Active host session id for surfaces that multiplex multiple sessions. */
  sessionId?: string | undefined;
  source: BrainDecisionSource;
  question: string;
  context?: string | undefined;
  options?: BrainDecisionOption[] | undefined;
  risk: BrainRisk;
  /** What a non-LLM/default Brain should do when policy cannot decide safely. */
  fallback: BrainFallback;
}

export type BrainDecision =
  | {
      type: 'answer';
      optionId?: string | undefined;
      text: string;
      rationale?: string | undefined;
    }
  | {
      type: 'ask_human';
      prompt: string;
      options?: BrainDecisionOption[] | undefined;
      rationale?: string | undefined;
    }
  | {
      type: 'deny';
      reason: string;
    };

export interface BrainArbiter {
  decide(request: BrainDecisionRequest): Promise<BrainDecision>;
}

/**
 * Event-emitting decorator for any Brain implementation. Hosts wire this around
 * their actual arbiter so TUI/session surfaces can render Brain decisions
 * without coupling to the caller that requested the decision.
 */
export class ObservableBrainArbiter implements BrainArbiter {
  constructor(
    private readonly inner: BrainArbiter,
    private readonly events: EventBus,
  ) {}

  async decide(request: BrainDecisionRequest): Promise<BrainDecision> {
    this.events.emit('brain.decision_requested', { sessionId: request.sessionId, request, at: Date.now() });
    const decision = await this.inner.decide(request);
    const event =
      decision.type === 'ask_human'
        ? 'brain.decision_ask_human'
        : decision.type === 'deny'
          ? 'brain.decision_denied'
          : 'brain.decision_answered';
    this.events.emit(event, { sessionId: request.sessionId, request, decision, at: Date.now() });
    return decision;
  }
}

export interface BrainDecisionQueueOptions {
  /** Safety fallback if the human never answers. Default: no timeout. */
  timeoutMs?: number | undefined;
}

/**
 * Bridge between an `ask_human` Brain decision and the UI. It emits the visible
 * ask-human event, then resolves when the TUI emits `brain.human_answered`.
 */
export class BrainDecisionQueue {
  private readonly pending = new Map<
    string,
    {
      request: BrainDecisionRequest;
      resolve: (decision: BrainDecision) => void;
      timer?: ReturnType<typeof setTimeout> | undefined;
    }
  >();
  private readonly offAnswer: () => void;

  constructor(
    private readonly events: EventBus,
    private readonly opts: BrainDecisionQueueOptions = {},
  ) {
    this.offAnswer = this.events.on('brain.human_answered', (answer) => {
      const pending = this.pending.get(answer.id);
      if (!pending) return;
      this.pending.delete(answer.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (answer.deny) {
        pending.resolve({ type: 'deny', reason: answer.text ?? 'Denied by human.' });
        return;
      }
      const option = pending.request.options?.find((o) => o.id === answer.optionId);
      pending.resolve({
        type: 'answer',
        optionId: answer.optionId,
        text: answer.text ?? option?.label ?? answer.optionId ?? 'Human answered.',
        rationale: 'Human answered a Brain escalation prompt.',
      });
    });
  }

  async requestHumanDecision(request: BrainDecisionRequest): Promise<BrainDecision> {
    const ask: BrainDecision = {
      type: 'ask_human',
      prompt: formatHumanPrompt(request),
      options: request.options,
      rationale: 'Decision escalated to human authority.',
    };
    const pending = new Promise<BrainDecision>((resolve) => {
      const entry: {
        request: BrainDecisionRequest;
        resolve: (decision: BrainDecision) => void;
        timer?: ReturnType<typeof setTimeout> | undefined;
      } = { request, resolve };
      if (this.opts.timeoutMs && this.opts.timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(request.id);
          resolve({ type: 'deny', reason: 'Brain human decision timed out.' });
        }, this.opts.timeoutMs);
      }
      this.pending.set(request.id, entry);
    });
    this.events.emit('brain.decision_ask_human', { sessionId: request.sessionId, request, decision: ask, at: Date.now() });
    return pending;
  }

  dispose(): void {
    this.offAnswer();
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve({ type: 'deny', reason: 'Brain decision queue disposed.' });
      this.pending.delete(id);
    }
  }
}

/**
 * Decorator that turns `ask_human` into an actual awaited human decision.
 * The wrapped Brain remains policy-only; this layer owns the UI/event bridge.
 */
export class HumanEscalatingBrainArbiter implements BrainArbiter {
  constructor(
    private readonly inner: BrainArbiter,
    private readonly queue: BrainDecisionQueue,
  ) {}

  async decide(request: BrainDecisionRequest): Promise<BrainDecision> {
    const decision = await this.inner.decide(request);
    if (decision.type !== 'ask_human') return decision;
    return this.queue.requestHumanDecision(request);
  }
}

export interface DefaultBrainArbiterOptions {
  /** Allow deterministic auto-answering for low-risk requests. Default true. */
  allowLowRiskAutoAnswer?: boolean | undefined;
}

/**
 * Conservative deterministic Brain implementation.
 *
 * It only auto-answers low-risk requests when the caller provided a recommended
 * option. Everything else follows the request fallback. This gives hosts a safe
 * policy object to wire before an LLM-backed Brain exists.
 */
export class DefaultBrainArbiter implements BrainArbiter {
  private readonly allowLowRiskAutoAnswer: boolean;

  constructor(opts: DefaultBrainArbiterOptions = {}) {
    this.allowLowRiskAutoAnswer = opts.allowLowRiskAutoAnswer ?? true;
  }

  async decide(request: BrainDecisionRequest): Promise<BrainDecision> {
    const recommended = request.options?.find((option) => option.recommended);
    if (this.allowLowRiskAutoAnswer && request.risk === 'low' && recommended) {
      return {
        type: 'answer',
        optionId: recommended.id,
        text: recommended.label,
        rationale: 'Low-risk request with an explicit recommended option.',
      };
    }

    switch (request.fallback) {
      case 'deny':
        return {
          type: 'deny',
          reason: `Brain could not safely decide: ${request.question}`,
        };
      case 'continue':
        return {
          type: 'answer',
          text: 'Continue with the caller default.',
          rationale: 'No safe Brain decision was available; request fallback is continue.',
        };
      case 'ask_human':
        return {
          type: 'ask_human',
          prompt: formatHumanPrompt(request),
          options: request.options,
          rationale: 'Decision requires human authority or lacks a safe automatic option.',
        };
      default:
        // Runtime safety: deserialized or unknown fallback defaults to deny
        return {
          type: 'deny',
          reason: `Brain could not safely decide (unknown fallback: ${String(request.fallback)}): ${request.question}`,
        };
    }
  }
}

export function formatHumanPrompt(request: BrainDecisionRequest): string {
  const lines = [
    `Brain requires human decision for ${request.source}:`,
    `Question: ${request.question}`,
  ];
  if (request.context?.trim()) {
    lines.push('', 'Context:', request.context.trim());
  }
  if (request.options?.length) {
    lines.push('', 'Options:');
    for (const option of request.options) {
      const risk = option.risk ? ` [risk: ${option.risk}]` : '';
      const consequence = option.consequence ? ` — ${option.consequence}` : '';
      lines.push(`- ${option.id}: ${option.label}${risk}${consequence}`);
    }
  }
  lines.push('', `Risk: ${request.risk}`);
  return lines.join('\n');
}

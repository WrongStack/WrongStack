/**
 * Brain decision provenance — WHICH tier actually resolved a decision.
 *
 * The Brain chain is a ladder (rules → policy → cache → council → LLM →
 * escalation), but every tier returns a bare `BrainDecision` with no marker
 * saying where it came from. `ObservableBrainArbiter` sits OUTSIDE the chain,
 * so the events it emits — the only thing the TUI/WebUI/HQ surfaces see —
 * could not distinguish a free deterministic answer from one that cost a
 * multi-model council call. That made the single most important operational
 * question ("how often does the Brain actually burn an LLM?") unanswerable.
 *
 * Provenance is recorded OUT OF BAND, keyed by the identity of the
 * `BrainDecisionRequest` object, rather than as a field on `BrainDecision`:
 *
 *   - `BrainDecision` is a public union compared structurally in a great many
 *     places (`expect(d).toEqual(deny('…'))` throughout the Brain tests, and
 *     equality checks in host code). Adding even an optional field would
 *     change those comparisons.
 *   - The SAME request object reference is threaded unchanged through every
 *     tier, so its identity is already a reliable per-decision key.
 *   - A `WeakMap` keeps this leak-free: when the request is collected, so is
 *     its provenance entry. No cleanup protocol, no unbounded growth.
 *
 * Marks are last-writer-wins. Each tier marks itself as it RESOLVES; a tier
 * that defers to the next one must not mark.
 *
 * @module brain-telemetry
 */

import type { EventBus } from '../kernel/events.js';
import type { BrainDecisionRequest } from './brain.js';

/**
 * The tier that produced a decision, cheapest first.
 *
 * - `rule`        — a configured deterministic `BrainRule` matched.
 * - `policy`      — `DefaultBrainArbiter` fallback semantics.
 * - `heuristic`   — a built-in pattern heuristic (quickDecide / blocked-resolved).
 * - `cache`       — a previous identical decision was replayed.
 * - `ledger-guard`— denied deterministically from observed failure history.
 * - `council`     — the multi-LLM panel decided.
 * - `llm`         — the single-LLM tier decided.
 * - `terminal`    — headless terminal policy (no human available).
 * - `human`       — a person answered the escalation prompt.
 */
export type BrainDecisionTier =
  | 'rule'
  | 'policy'
  | 'heuristic'
  | 'cache'
  | 'ledger-guard'
  | 'council'
  | 'llm'
  | 'terminal'
  | 'human';

/** Tiers that did NOT cost a provider call. */
export const DETERMINISTIC_BRAIN_TIERS: ReadonlySet<BrainDecisionTier> = new Set<BrainDecisionTier>(
  ['rule', 'policy', 'heuristic', 'cache', 'ledger-guard', 'terminal'],
);

const tierByRequest = new WeakMap<BrainDecisionRequest, BrainDecisionTier>();

/**
 * Record which tier resolved this request. Call it at the point of RESOLUTION
 * — a tier that falls through to the next one must not mark, or the ladder's
 * provenance collapses onto whichever tier ran last.
 */
export function markDecisionTier(request: BrainDecisionRequest, tier: BrainDecisionTier): void {
  tierByRequest.set(request, tier);
}

/** The tier that resolved this request, when a tier recorded itself. */
export function readDecisionTier(request: BrainDecisionRequest): BrainDecisionTier | undefined {
  return tierByRequest.get(request);
}

/** True when the decision was reached without any provider call. */
export function isDeterministicTier(tier: BrainDecisionTier | undefined): boolean {
  return tier !== undefined && DETERMINISTIC_BRAIN_TIERS.has(tier);
}

/** Running per-tier tally, for `/brain stats` and the settings surfaces. */
export interface BrainTierStats {
  /** Decisions resolved by each tier. Tiers with no decisions are omitted. */
  byTier: Partial<Record<BrainDecisionTier, number>>;
  /** Total decisions counted (including ones with no recorded tier). */
  total: number;
  /** Decisions reached without any provider call. */
  deterministic: number;
  /** Decisions that cost at least one provider call (`council` + `llm`). */
  llmBacked: number;
  /** Decisions whose tier was never recorded. */
  unattributed: number;
}

/**
 * Mutable per-tier counter. Hosts keep one per session and feed it from the
 * `brain.decision_*` event stream.
 */
export class BrainTierCounter {
  private readonly counts = new Map<BrainDecisionTier, number>();
  private total = 0;
  private unattributed = 0;

  /** Count one decision. `undefined` counts toward `unattributed`. */
  record(tier: BrainDecisionTier | undefined): void {
    this.total += 1;
    if (tier === undefined) {
      this.unattributed += 1;
      return;
    }
    this.counts.set(tier, (this.counts.get(tier) ?? 0) + 1);
  }

  snapshot(): BrainTierStats {
    const byTier: Partial<Record<BrainDecisionTier, number>> = {};
    let deterministic = 0;
    let llmBacked = 0;
    for (const [tier, count] of this.counts) {
      byTier[tier] = count;
      if (DETERMINISTIC_BRAIN_TIERS.has(tier)) deterministic += count;
      else if (tier === 'council' || tier === 'llm') llmBacked += count;
    }
    return {
      byTier,
      total: this.total,
      deterministic,
      llmBacked,
      unattributed: this.unattributed,
    };
  }

  reset(): void {
    this.counts.clear();
    this.total = 0;
    this.unattributed = 0;
  }
}

/**
 * Emit one `brain.tier_transition` step.
 *
 * Every tier of the ladder needs to record its own step, or a decision's
 * path is only partially reconstructable: before this helper existed only
 * the tiered arbiter (policy/council/llm) emitted transitions, so a decision
 * settled by a rule, a cache hit, the ledger guard or the headless terminal
 * policy produced a trace record with an EMPTY `steps` array — the cheapest
 * and most common outcomes were the least observable ones.
 *
 * Kept next to `markDecisionTier` on purpose: a tier that marks itself as
 * the resolver should emit the matching step, and one call site for the
 * payload shape stops the emitters from drifting apart.
 */
export function emitBrainTierTransition(
  events: EventBus | undefined,
  request: BrainDecisionRequest,
  tier: BrainDecisionTier,
  outcome: 'answer' | 'deny' | 'ask_human' | 'error' | 'skipped',
  terminal: boolean,
  startedAt: number,
  reason?: string,
): void {
  if (!events) return;
  const at = Date.now();
  events.emit('brain.tier_transition', {
    sessionId: request.sessionId,
    requestId: request.id,
    tier,
    outcome,
    terminal,
    ...(reason ? { reason } : {}),
    durationMs: Math.max(0, at - startedAt),
    at,
  });
}

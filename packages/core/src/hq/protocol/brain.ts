// ── Brain decision telemetry ───────────────────────────────────────────────
//
// The Brain (decision layer) routes autonomous decisions through a three-tier
// chain. These envelopes let the HQ command center observe decision requests,
// answers, denials, ask-human escalations, and self-activated interventions
// across every connected machine — without coupling HQ to the in-process
// Brain. All payloads are plain serializable data (no closures); the rich
// BrainDecisionRequest / BrainDecision shapes are forwarded as-is.

import type { BrainDecisionTier } from '../../coordination/brain-telemetry.js';
import type { BrainInterventionKind } from '../../kernel/events.js';

export type HqBrainEventKind =
  | 'decision_requested'
  | 'decision_answered'
  | 'decision_ask_human'
  | 'human_answered'
  | 'decision_denied'
  | 'intervention'
  | 'council_resolved';

export interface HqBrainEventPayload {
  /** Which brain lifecycle event this is (mirrors the EventBus `brain.*` name suffix). */
  kind: HqBrainEventKind;
  /** The decision request id, when present (decision_request/answer/deny). */
  requestId?: string;
  /** Short human-readable question the brain was asked. */
  question?: string;
  /** The source that triggered the decision (e.g. 'autonomy', 'system'). */
  source?: string;
  /** Resolved risk tier, when known (e.g. 'low' | 'medium' | 'high'). */
  risk?: string;
  /** The chosen decision kind, when answered/denied (e.g. 'answer' | 'ask_human' | 'deny'). */
  decision?: string;
  /** Free-text rationale or answer payload, when present. */
  detail?: string;
  /**
   * For `intervention`: the watched signal that engaged the brain.
   *
   * Imported rather than re-declared: this used to be a hand-copied literal
   * union, so every signal added to the monitor silently failed to type here
   * — the one place a fleet-wide operator would look for it.
   */
  interventionKind?: BrainInterventionKind;
  /** For `intervention`: true when a steer was actually delivered to the agent. */
  intervened?: boolean;
  /**
   * Which tier resolved the decision. Without it every decision looks alike
   * at HQ — a free rule hit and a multi-model council call are the same row,
   * so "what is the fleet's Brain actually spending" is unanswerable from
   * the command centre.
   */
  tier?: BrainDecisionTier;
  /**
   * For `decision_ask_human`: true when this is the PROMPT and a human is
   * still being waited on, rather than ask_human being the final decision.
   */
  pending?: boolean;
  /** For `council_resolved`: how the panel resolved (majority/veto/judge/…). */
  resolution?: string;
  /** For `council_resolved`: seats configured vs seats that returned a usable vote. */
  seatCount?: number;
  validVoteCount?: number;
  /** For `council_resolved`: distinct models behind those votes. */
  distinctTargetCount?: number;
  /** For `council_resolved`: the tie-breaker, and whether it had already voted. */
  judgeLabel?: string;
  judgeIsVoter?: boolean;
  /** For `council_resolved`: total tokens the panel burned. */
  totalTokens?: number;
  /** For `council_resolved`: deliberation rounds run (1 = no deliberation). */
  rounds?: number;
  /** For `council_resolved`: seats that changed their vote in the final round. */
  deliberationChanges?: number;
  /** For `council_resolved`: panel-integrity warnings (correlated seats). */
  warnings?: string[];
  /** Epoch milliseconds at which the event occurred. */
  at: number;
}

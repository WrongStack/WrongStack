/**
 * Phase 2: Deterministic Value Score
 *
 * Computes a numeric 0-100 score for a SAGE memory from structured signals
 * only — no LLM, no side effects. Used to triage UNCERTAIN memories from
 * Phase 1 into KEEP (≥70), GRAY (30-69), or DISCARD (≤29) bands.
 *
 * The score decomposes into five sub-scores, each with a fixed weight:
 *
 *   anchorScore    (0-25) — presence and validity of retrieval anchors
 *   usageScore     (0-25) — injection and usage track record
 *   freshnessScore (0-20) — last verification age
 *   qualityScore   (0-15) — kind correctness, tagging, text shape
 *   persistenceScore (0-15) — persistence class bonus
 */

import type { Sage, SageKind } from '../types.js';

// ── Types ───────────────────────────────────────────────────────────────

export interface ValueScoreBreakdown {
  /** Total score, 0-100. */
  total: number;
  /** Which band the score falls into. */
  band: 'keep' | 'gray' | 'discard';
  /** Sub-scores for traceability. */
  anchor: number;
  usage: number;
  freshness: number;
  quality: number;
  persistence: number;
  /** Max possible for each sub-score. */
  maxes: {
    anchor: number;
    usage: number;
    freshness: number;
    quality: number;
    persistence: number;
  };
  /** Human-readable reasons for each sub-score. */
  reasons: string[];
  /**
   * Optional evidence from the SAGE injector — only present when the caller
   * supplies `injectorEvidence` to `computeValueScore`. 0–1 normalized pressure
   * score driven by rejection counts and the dominant gate. Used by the LLM
   * triage prompt as an additional signal, not folded into `total`.
   */
  rejectionPressure?: number;
  /** The dominant gate the memory was most-recently rejected by. */
  rejectionGate?: RejectionGate;
  /** Count for the dominant rejection gate over the supplied lookback window. */
  rejectionCount?: number;
}

export type ValueBand = 'keep' | 'gray' | 'discard';

/** Gates emitted by the SAGE injector when a candidate fails to inject. */
type RejectionGate = 'duplicate' | 'belowScore' | 'alreadyVisible' | 'cooldown' | 'budget';

/** Per-memory evidence from the SAGE injector. Read-only input to triage. */
export interface InjectorEvidence {
  /** Counts per gate over the lookback window (typically the triage `since`). */
  rejectedByGate: Partial<Record<RejectionGate, number>>;
  /** True if the memory cleared all gates and reached `activated` at least once. */
  lastActivated: boolean;
  /** True if the memory was actually `injected` at least once in the window. */
  lastInjected: boolean;
  /** Last rejection reason, bounded to 200 chars by the injector. */
  lastReason?: string;
  /** Rolling-window count for the dominant gate (5 min by injector default). */
  rejectionCount?: number;
}

/** Below this count of `belowScore` rejections, the pressure gate stays neutral.
 *  Below the injector threshold (3) is normal noise; this is the *triage* side. */
const BELOW_SCORE_TRIAGE_PENALTY_THRESHOLD = 5;
/** Penalty applied to `usage` sub-score when belowScore count exceeds the threshold. */
const BELOW_SCORE_USAGE_PENALTY = 2;

/**
 * Normalization denominator for the weighted gate-count sum. The gate
 * weights sum to 1.3 (0.6 + 0.4 + 0.3), so dividing by ~1.67 (1.3 *
 * 1.28) gives a pressure score that saturates near 1 when ALL gates
 * are at their observed maxima. Extracted from the formula so the
 * denominator is named alongside the weights it normalizes.
 */
const PRESSURE_NORMALIZATION_DENOM = 1.67;

/** Minimum rejection-burst count that earns a multiplicative pressure boost. */
const BURST_PRESSURE_BOOST_MIN = 3;
/** Multiplier applied to `pressure` when `rejectionCount >= BURST_PRESSURE_BOOST_MIN`. */
const BURST_PRESSURE_BOOST_FACTOR = 1.25;

// ── Constants ───────────────────────────────────────────────────────────

const MAX_ANCHOR = 25;
const MAX_USAGE = 25;
const MAX_FRESHNESS = 20;
const MAX_QUALITY = 15;
const MAX_PERSISTENCE = 15;

/** Kinds that represent durable, reusable knowledge. */
const DURABLE_KINDS: ReadonlySet<SageKind> = new Set([
  'fact',
  'decision',
  'convention',
  'preference',
  'warning',
  'anti_pattern',
  'workflow',
  'bug_root_cause',
  'file_note',
  'symbol_note',
  'command_note',
  'tool_outcome',
  'error_pattern',
  'role_operational',
  'task_outcome',
  'security_signal',
  'fleet_convention',
]);

/**
 * Transient or meta kinds that do not carry durable project knowledge.
 * `summary` and `memory_review` are process artifacts, not reusable facts.
 */
const TRANSIENT_KINDS: ReadonlySet<SageKind> = new Set(['summary', 'memory_review']);

/** Optimal text length range (chars). */
const TEXT_SWEET_MIN = 80;
const TEXT_SWEET_MAX = 500;

/** Anchor type diversity bonus cap. */
const ANCHOR_TYPE_CAP = 10;

/** Verified <= 30 days = fresh. */
const FRESH_DAYS = 30;
/** Verified 30-90 days = aging. */
const AGING_DAYS = 90;

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Compute the value score for a single memory.
 *
 * When `options.injectorEvidence` is supplied, two additional outputs are
 * populated on the breakdown: `rejectionPressure` (0–1) and `rejectionGate`
 * (the dominant gate the memory was rejected by). The `usage` sub-score also
 * receives a small penalty when the memory was repeatedly rejected for
 * `belowScore` over the lookback window — see
 * `BELOW_SCORE_TRIAGE_PENALTY_THRESHOLD`.
 */
export function computeValueScore(
  memory: Sage,
  options?: { injectorEvidence?: InjectorEvidence },
): ValueScoreBreakdown {
  const reasons: string[] = [];

  const anchor = computeAnchorScore(memory, reasons);
  const usage = computeUsageScore(memory, reasons, options?.injectorEvidence);
  const freshness = computeFreshnessScore(memory, reasons);
  const quality = computeQualityScore(memory, reasons);
  const persistence = computePersistenceScore(memory, reasons);

  const total = anchor + usage + freshness + quality + persistence;
  const band = total >= 70 ? 'keep' : total <= 29 ? 'discard' : 'gray';

  const breakdown: ValueScoreBreakdown = {
    total,
    band,
    anchor,
    usage,
    freshness,
    quality,
    persistence,
    maxes: {
      anchor: MAX_ANCHOR,
      usage: MAX_USAGE,
      freshness: MAX_FRESHNESS,
      quality: MAX_QUALITY,
      persistence: MAX_PERSISTENCE,
    },
    reasons,
  };
  if (options?.injectorEvidence) {
    const { pressure, gate, count } = computeRejectionPressure(options.injectorEvidence);
    breakdown.rejectionPressure = pressure;
    if (gate !== undefined) {
      breakdown.rejectionGate = gate;
      breakdown.rejectionCount = count;
    }
  }
  return breakdown;
}

/**
 * Pressure score (0–1) reflecting how often a memory was rejected by the
 * SAGE injector over the lookback window. The dominant gate (highest count)
 * wins; `belowScore` carries the most weight because it implies a structural
 * mismatch, while `cooldown`/`budget` are session-policy signals.
 *
 * When `rejectionCount` (rolling-window) exceeds the threshold of 3, the
 * pressure is multiplied by 1.25 (capped at 1.0). The pressure is *advisory*
 * — it surfaces in the LLM triage prompt and in `rejectionGate`, not in the
 * `total` score directly (which gets the `BELOW_SCORE_USAGE_PENALTY` clamp).
 */
function computeRejectionPressure(evidence: InjectorEvidence): {
  pressure: number;
  gate: RejectionGate | undefined;
  count: number;
} {
  const counts = evidence.rejectedByGate;
  const gates: RejectionGate[] = [
    'belowScore',
    'cooldown',
    'budget',
    'alreadyVisible',
    'duplicate',
  ];
  // Default to "no dominant gate" so the caller can distinguish a memory
  // that was rejected (gate defined) from one that has zero rejection
  // history (gate undefined). Prevents the LLM-triage prompt from
  // mis-attributing rejection evidence to a memory that has never been
  // rejected in the lookback window.
  let dominantGate: RejectionGate | undefined;
  let dominantCount = 0;
  let weighted = 0;
  for (const gate of gates) {
    const count = counts[gate] ?? 0;
    if (count > dominantCount) {
      dominantCount = count;
      dominantGate = gate;
    }
    const weight =
      gate === 'belowScore' ? 0.6 : gate === 'cooldown' ? 0.4 : gate === 'budget' ? 0.3 : 0;
    weighted += weight * count;
  }
  let pressure = Math.min(1, weighted / PRESSURE_NORMALIZATION_DENOM);
  const burst = evidence.rejectionCount ?? 0;
  if (burst >= BURST_PRESSURE_BOOST_MIN)
    pressure = Math.min(1, pressure * BURST_PRESSURE_BOOST_FACTOR);
  return { pressure, gate: dominantGate, count: dominantCount };
}

/**
 * Batch score — returns sorted from highest to lowest.
 */
export function computeValueScores(memories: Sage[]): Map<string, ValueScoreBreakdown> {
  const results = new Map<string, ValueScoreBreakdown>();
  for (const memory of memories) {
    results.set(memory.id, computeValueScore(memory));
  }
  return results;
}

// ── Sub-score functions ─────────────────────────────────────────────────

/**
 * Anchor score (0-25).
 *
 * Rewards memories anchored to concrete code locations, which is the
 * primary retrieval key for injection. Penalizes unanchored memories
 * (they rely on weak lexical overlap).
 */
function computeAnchorScore(memory: Sage, reasons: string[]): number {
  const anchors = memory.anchors;

  if (anchors.length === 0) {
    reasons.push('anchor: none (unanchored — relies on weak lexical match)');
    return 0;
  }

  // Check if all anchors are stale (status === 'stale' means anchor verification failed)
  // We can't directly check anchor staleness from the Sage type — use memory status
  // as a proxy. A stale memory likely has stale anchors.
  const memoryIsStale = memory.status === 'stale';
  const memoryWasRecentlyVerified =
    memory.lastVerifiedAt != null && daysSince(memory.lastVerifiedAt) <= 30;

  if (memoryIsStale && !memoryWasRecentlyVerified) {
    reasons.push('anchor: all likely stale (memory is stale + not recently verified)');
    return 5;
  }

  // Count distinct anchor types for diversity bonus
  const anchorTypes = new Set(anchors.map((a) => a.type));
  const typeDiversity = Math.min(anchorTypes.size * 3, ANCHOR_TYPE_CAP);

  const score = 15 + typeDiversity;
  reasons.push(
    `anchor: ${anchors.length} anchor(s), ${anchorTypes.size} type(s) → ${score}/${MAX_ANCHOR}`,
  );
  return Math.min(score, MAX_ANCHOR);
}

/**
 * Usage score (0-25).
 *
 * Rewards memories that agents actually referenced (useCount > 0).
 * Penalizes memories injected many times but never used (suspicious).
 * Neutral for never-injected memories.
 */
function computeUsageScore(
  memory: Sage,
  reasons: string[],
  injectorEvidence?: InjectorEvidence,
): number {
  const injected = memory.injectionCount ?? 0;
  const used = memory.useCount ?? 0;

  // Compute the injector-rejection penalty (if any) BEFORE the early
  // returns so it applies across every branch — `used > 0` doesn't exempt
  // a memory from the penalty when SAGE's injector has repeatedly rejected
  // it for `belowScore` (the injector and the LLM reference counters are
  // independent signals). The penalty is bounded and asymmetric — only
  // `belowScore` triggers it, and only past the threshold — so transient
  // noise doesn't drag a memory down.
  const belowScore = injectorEvidence?.rejectedByGate.belowScore ?? 0;
  const applyPenalty = belowScore >= BELOW_SCORE_TRIAGE_PENALTY_THRESHOLD;
  // Floor must sit BELOW every branch's base value, otherwise `penalized`
  // is a no-op in that branch — `Math.max(floor, raw - delta)` clamps to
  // `floor` when `raw <= floor + delta`. The smallest branch base here is
  // 3 (suspicious: injected many, never used), so 0 is the only floor that
  // does not accidentally re-anchor any branch.
  const clampFloor = 0;
  const penalized = (raw: number): number => {
    if (!applyPenalty) return raw;
    return Math.max(clampFloor, raw - BELOW_SCORE_USAGE_PENALTY);
  };

  // Strong signal: the agent actually referenced this memory
  if (used > 0) {
    const bonus = Math.min(5, used);
    const raw = 20 + bonus;
    const score = penalized(Math.min(raw, MAX_USAGE));
    reasons.push(`usage: used ${used}x, injected ${injected}x → ${score}/${MAX_USAGE}`);
    return score;
  }

  // Suspicious: injected many times but NEVER referenced
  if (injected >= 5) {
    const raw = 3;
    const score = penalized(raw);
    reasons.push(`usage: injected ${injected}x, never used — suspicious (${score}/${MAX_USAGE})`);
    return score;
  }

  // Mildly suspicious: injected a few times, never used
  if (injected >= 1) {
    const raw = 8;
    const score = penalized(raw);
    reasons.push(`usage: injected ${injected}x, never used — untested (${score}/${MAX_USAGE})`);
    return score;
  }

  // Neutral: never injected, never used
  const raw = 10;
  const score = penalized(raw);
  reasons.push(`usage: never injected or used — neutral (${score}/${MAX_USAGE})`);
  return score;
}

/**
 * Freshness score (0-20).
 *
 * Rewards recently-verified memories. Aged or never-verified memories
 * get lower scores because their anchor claims may be stale.
 */
function computeFreshnessScore(memory: Sage, reasons: string[]): number {
  if (!memory.lastVerifiedAt) {
    reasons.push(`freshness: never verified → ${5}/${MAX_FRESHNESS}`);
    return 5;
  }

  const age = daysSince(memory.lastVerifiedAt);

  if (age <= FRESH_DAYS) {
    reasons.push(`freshness: verified ${age}d ago → ${20}/${MAX_FRESHNESS}`);
    return 20;
  }

  if (age <= AGING_DAYS) {
    reasons.push(`freshness: verified ${age}d ago → ${12}/${MAX_FRESHNESS}`);
    return 12;
  }

  reasons.push(`freshness: verified ${age}d ago (>${AGING_DAYS}d) → ${5}/${MAX_FRESHNESS}`);
  return 5;
}

/**
 * Quality score (0-15).
 *
 * Rewards well-structured memories: correct kind, meaningful tags,
 * appropriate text length. These signals correlate with deliberate,
 * useful contributions vs. auto-generated noise.
 */
function computeQualityScore(memory: Sage, reasons: string[]): number {
  let score = 0;

  // Kind correctness: durable kinds are worth more
  if (DURABLE_KINDS.has(memory.kind)) {
    score += 5;
    reasons.push('quality: durable kind (+5)');
  } else if (TRANSIENT_KINDS.has(memory.kind)) {
    reasons.push('quality: transient kind (summary/memory_review → +0)');
  } else {
    // Catch-all for kinds not in either set (see `SageKind` for the full list).
    // Currently empty — DURABLE_KINDS covers all non-transient kinds as of
    // the A4 expansion — but the branch is preserved for forward-compatibility
    // when new transient kinds are added.
    score += 0;
    reasons.push('quality: unclassified kind (+0)');
  }

  // Tag richness
  if (memory.tags.length >= 3) {
    score += 5;
    reasons.push('quality: ≥3 tags (+5)');
  } else if (memory.tags.length >= 1) {
    score += 3;
    reasons.push(`quality: ${memory.tags.length} tag(s) (+3)`);
  } else {
    reasons.push('quality: no tags (+0)');
  }

  // Text length — sweet spot is 80-500 chars
  const len = memory.text.length;
  if (len >= TEXT_SWEET_MIN && len <= TEXT_SWEET_MAX) {
    score += 5;
    reasons.push(`quality: text ${len} chars (sweet spot) (+5)`);
  } else {
    score += 2;
    reasons.push(`quality: text ${len} chars (outside ${TEXT_SWEET_MIN}-${TEXT_SWEET_MAX}) (+2)`);
  }

  return Math.min(score, MAX_QUALITY);
}

/**
 * Persistence score (0-15).
 *
 * Mirrors the persistence class. Permanent memories get full credit;
 * long_lived are neutral; short_lived are penalized.
 */
function computePersistenceScore(memory: Sage, reasons: string[]): number {
  switch (memory.persistence) {
    case 'permanent':
      reasons.push(`persistence: permanent → ${MAX_PERSISTENCE}/${MAX_PERSISTENCE}`);
      return MAX_PERSISTENCE;
    case 'short_lived':
      reasons.push(`persistence: short_lived → ${3}/${MAX_PERSISTENCE}`);
      return 3;
    default:
      reasons.push(`persistence: long_lived (default) → ${10}/${MAX_PERSISTENCE}`);
      return 10;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function daysSince(iso: string): number {
  const diff = Date.now() - new Date(iso).getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

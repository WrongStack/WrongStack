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
}

export type ValueBand = 'keep' | 'gray' | 'discard';

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
  'warning',
  'anti_pattern',
  'workflow',
  'bug_root_cause',
  'file_note',
  'symbol_note',
  'command_note',
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
 */
export function computeValueScore(memory: Sage): ValueScoreBreakdown {
  const reasons: string[] = [];

  const anchor = computeAnchorScore(memory, reasons);
  const usage = computeUsageScore(memory, reasons);
  const freshness = computeFreshnessScore(memory, reasons);
  const quality = computeQualityScore(memory, reasons);
  const persistence = computePersistenceScore(memory, reasons);

  const total = anchor + usage + freshness + quality + persistence;
  const band = total >= 70 ? 'keep' : total <= 29 ? 'discard' : 'gray';

  return {
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
function computeUsageScore(memory: Sage, reasons: string[]): number {
  const injected = memory.injectionCount ?? 0;
  const used = memory.useCount ?? 0;

  // Strong signal: the agent actually referenced this memory
  if (used > 0) {
    const bonus = Math.min(5, used);
    const score = 20 + bonus;
    reasons.push(`usage: used ${used}x, injected ${injected}x → ${score}/${MAX_USAGE}`);
    return Math.min(score, MAX_USAGE);
  }

  // Suspicious: injected many times but NEVER referenced
  if (injected >= 5) {
    reasons.push(`usage: injected ${injected}x, never used — suspicious (${3}/${MAX_USAGE})`);
    return 3;
  }

  // Mildly suspicious: injected a few times, never used
  if (injected >= 1) {
    reasons.push(`usage: injected ${injected}x, never used — untested (${8}/${MAX_USAGE})`);
    return 8;
  }

  // Neutral: never injected, never used
  reasons.push(`usage: never injected or used — neutral (${10}/${MAX_USAGE})`);
  return 10;
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
    // preference — middling, still valid
    score += 3;
    reasons.push('quality: preference kind (+3)');
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
    case 'long_lived':
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

/**
 * Phase 1: Deterministic Pre-Filter
 *
 * Runs on every memory. Pure rule engine — no LLM, no side effects.
 * Classifies each memory as KEEP, DISCARD, or UNCERTAIN.
 *
 * KEEP memories exit the pipeline immediately.
 * DISCARD memories are marked stale + archive proposal candidates.
 * UNCERTAIN memories flow into Phase 2 (value scoring).
 */

import type { Sage } from '../types.js';

// ── Types ───────────────────────────────────────────────────────────────

export type PreFilterVerdict = 'keep' | 'discard' | 'uncertain';

export interface PreFilterResult {
  verdict: PreFilterVerdict;
  reasons: string[];
}

// ── Constants ───────────────────────────────────────────────────────────

/** Text length below which a memory cannot plausibly carry durable knowledge. */
const MIN_MEANINGFUL_TEXT_LENGTH = 20;

/** Transient-content markers — text that matches these is session debris. */
const TRANSIENT_PATTERNS = [
  /^(wip|todo|test|tmp|draft|tbd|placeholder|scratch)[:\s-]/i,
  /^fix(ed|ing)?\s*:/i,
  /^debug\s*:/i,
];

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Classify a single memory as keep / discard / uncertain.
 *
 * Rules are ordered deliberately: KEEP checks run first (safety-first),
 * then DISCARD checks, then everything else is UNCERTAIN.
 */
export function preFilter(memory: Sage): PreFilterResult {
  const reasons: string[] = [];

  // ── KEEP checks ──────────────────────────────────────────────────
  const keepReason = isKeep(memory);
  if (keepReason) {
    reasons.push(keepReason);
    return { verdict: 'keep', reasons };
  }

  // ── DISCARD checks ───────────────────────────────────────────────
  const discardReasons = isDiscard(memory);
  if (discardReasons.length > 0) {
    return { verdict: 'discard', reasons: discardReasons };
  }

  // ── UNCERTAIN ────────────────────────────────────────────────────
  return { verdict: 'uncertain', reasons: [] };
}

/**
 * Batch classify — returns three arrays for convenient downstream processing.
 */
export function preFilterBatch(memories: Sage[]): {
  keep: Sage[];
  discard: Sage[];
  uncertain: Sage[];
  results: Map<string, PreFilterResult>;
} {
  const keep: Sage[] = [];
  const discard: Sage[] = [];
  const uncertain: Sage[] = [];
  const results = new Map<string, PreFilterResult>();

  for (const memory of memories) {
    const result = preFilter(memory);
    results.set(memory.id, result);
    switch (result.verdict) {
      case 'keep':
        keep.push(memory);
        break;
      case 'discard':
        discard.push(memory);
        break;
      case 'uncertain':
        uncertain.push(memory);
        break;
    }
  }

  return { keep, discard, uncertain, results };
}

// ── Rule engines ────────────────────────────────────────────────────────

/**
 * KEEP rules. Return the first matching reason, or null if none apply.
 *
 * These are deliberately narrow — only memories with exceptionally strong
 * signals skip the rest of the pipeline.
 */
function isKeep(memory: Sage): string | null {
  // 1. User explicitly marked as near-essential
  if (memory.importance >= 0.9) {
    return 'importance ≥ 0.9 (user-designated critical)';
  }

  // 2. Persistence locked — explicit invariant
  if (memory.persistence === 'permanent') {
    return 'persistence = permanent (explicit invariant)';
  }

  // 3. Proven behavioral value — the agent actually used it
  if ((memory.useCount ?? 0) > 0) {
    return `useCount > 0 (referenced ${memory.useCount}x by agents)`;
  }

  // 4. Hard-won knowledge kinds — expensive to re-discover
  if (memory.kind === 'decision') {
    return 'kind = decision (architectural choice, expensive to lose)';
  }
  if (memory.kind === 'bug_root_cause') {
    return 'kind = bug_root_cause (verified root cause, high replay cost)';
  }

  // 5. Proven injection track record — injected many times AND used
  if ((memory.injectionCount ?? 0) >= 10 && (memory.useCount ?? 0) > 0) {
    return `injected ${memory.injectionCount}x with useCount > 0 (proven injection value)`;
  }

  // 6. High-importance preferences — behavioral guidance is inherently unanchored,
  //    and the Phase 2 anchor penalty would unfairly demote them.
  if (memory.kind === 'preference' && memory.importance >= 0.8) {
    return `kind = preference with importance ${memory.importance} ≥ 0.8 (behavioral guidance)`;
  }

  return null;
}

/**
 * DISCARD rules. Return all matching reasons (may be compound).
 *
 * These are also narrow — only memories that are clearly noise or debris.
 * Everything ambiguous stays UNCERTAIN.
 */
function isDiscard(memory: Sage): string[] {
  const reasons: string[] = [];

  // 1. Empty or ultra-short text
  if (!memory.text || memory.text.trim().length < MIN_MEANINGFUL_TEXT_LENGTH) {
    reasons.push(
      `text too short (${memory.text?.length ?? 0} chars, minimum ${MIN_MEANINGFUL_TEXT_LENGTH})`,
    );
  }

  // 2. Transient content markers
  for (const pattern of TRANSIENT_PATTERNS) {
    if (pattern.test(memory.text.trim())) {
      reasons.push(`text matches transient pattern: "${memory.text.trim().slice(0, 60)}"`);
      break;
    }
  }

  // 3. Orphaned noise: no anchors, no tags, low importance, never injected
  if (
    memory.anchors.length === 0 &&
    memory.tags.length === 0 &&
    memory.importance < 0.5 &&
    (memory.injectionCount ?? 0) === 0
  ) {
    reasons.push('orphaned: no anchors, no tags, low importance, never injected');
  }

  // 4. Stale and abandoned — already stale, long-unverified, low importance
  if (memory.status === 'stale' && memory.importance < 0.6 && memory.lastVerifiedAt) {
    const verifiedAge = daysSince(memory.lastVerifiedAt);
    if (verifiedAge > 90) {
      reasons.push(
        `stale + unverified ${verifiedAge}d (importance ${memory.importance}, threshold 0.6)`,
      );
    }
  }

  // 5. Explicitly expired
  if (memory.expiresAt && new Date(memory.expiresAt) < new Date()) {
    reasons.push(`expired at ${memory.expiresAt}`);
  }

  return reasons;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function daysSince(iso: string): number {
  const diff = Date.now() - new Date(iso).getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

/**
 * Phase 5: Action Dispatcher
 *
 * Takes the results from Phase 2 (value scores) and Phase 3 (LLM evaluations)
 * and produces concrete action items that can be applied through SAGE memory
 * tools: `memory_update` for safe/reversible mutations and `memory_candidates`
 * for destructive proposals.
 *
 * Design:
 * - Pure function — produces action items, does NOT execute them.
 *   The caller (agent, CLI command, cron job) executes via memory tools.
 * - Two output arrays:
 *   - `autoApply`: safe updates (confidence, importance, status=stale, superseded)
 *   - `proposals`: archive/delete/investigate proposals for user approval
 * - Safety gate: importance >= 0.9 memories never get destructive proposals.
 */

import type { Sage } from '../types.js';
import type { ValueScoreBreakdown } from './value-score.js';
import type { LlmTriageResult, TriageAction } from './llm-evaluator.js';

// ── Types ───────────────────────────────────────────────────────────────

/** A single field update for `memory_update`. */
export interface MemoryFieldUpdate {
  field: string;
  value: unknown;
  reason: string;
}

/** An auto-apply action — safe, reversible, no user approval needed. */
export interface AutoApplyAction {
  memoryId: string;
  memoryText: string; // truncated preview for audit
  updates: MemoryFieldUpdate[];
}

/** A proposal for a destructive or high-impact action. */
export interface TriageProposal {
  memoryId: string;
  memoryText: string;
  suggestedAction: 'archive' | 'delete' | 'investigate';
  reason: string;
  /** Optional: related memory IDs (for merge proposals in Phase 4). */
  relatedMemoryIds?: string[] | undefined;
}

/** The full output of the action dispatcher. */
export interface DispatchResult {
  /** Safe updates ready to apply via `memory_update`. */
  autoApply: AutoApplyAction[];
  /** Destructive proposals to file via `memory_candidates`. */
  proposals: TriageProposal[];
  /** Summary counts. */
  summary: {
    total: number;
    autoApply: number;
    proposals: number;
    skipped: number;
  };
}

// ── Constants ───────────────────────────────────────────────────────────

const TRUNCATE_PREVIEW = 80;

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Dispatch actions for a single triage result (Phase 2 + Phase 3).
 *
 * Returns the auto-apply updates and proposals for this one memory.
 */
export function dispatchAction(result: LlmTriageResult): {
  autoApply: AutoApplyAction | null;
  proposal: TriageProposal | null;
} {
  const { memory, valueScore, evaluation, action } = result;
  const preview = memory.text.slice(0, TRUNCATE_PREVIEW);

  const updates = computeUpdates(memory, valueScore, evaluation, action);
  const proposal = computeProposal(memory, action, evaluation);

  return {
    autoApply: updates.updates.length > 0 ? { memoryId: memory.id, memoryText: preview, updates: updates.updates } : null,
    proposal,
  };
}

/**
 * Dispatch actions for a batch of triage results.
 *
 * Produces two flat arrays ready for execution:
 * - `autoApply`: safe `memory_update` calls
 * - `proposals`: `memory_candidates propose` calls
 */
export function dispatchBatch(results: LlmTriageResult[]): DispatchResult {
  const autoApply: AutoApplyAction[] = [];
  const proposals: TriageProposal[] = [];
  let skipped = 0;

  for (const result of results) {
    const { autoApply: aa, proposal } = dispatchAction(result);

    if (aa) autoApply.push(aa);
    if (proposal) proposals.push(proposal);

    // Skip if neither auto-update nor proposal — the triage said "keep" cleanly
    if (!aa && !proposal) skipped++;
  }

  return {
    autoApply,
    proposals,
    summary: {
      total: results.length,
      autoApply: autoApply.length,
      proposals: proposals.length,
      skipped,
    },
  };
}

// ── Update computation ──────────────────────────────────────────────────

function computeUpdates(
  memory: Sage,
  vs: ValueScoreBreakdown,
  eval_: LlmTriageResult['evaluation'],
  action: TriageAction,
): { updates: MemoryFieldUpdate[] } {
  const updates: MemoryFieldUpdate[] = [];

  switch (action) {
    case 'keep': {
      // Confidence calibration: if LLM rated 4-5, bump confidence
      if (eval_.score >= 4 && memory.confidence < 0.8) {
        updates.push({
          field: 'confidence',
          value: eval_.score === 5 ? 0.9 : 0.8,
          reason: `LLM rated ${eval_.score} → confidence calibrated from ${memory.confidence}`,
        });
      }
      break;
    }

    case 'keep_llm_override': {
      // LLM overrode a low det score — bump confidence to reflect LLM verdict
      if (memory.confidence < 0.75) {
        updates.push({
          field: 'confidence',
          value: 0.75,
          reason: `LLM overrode det score ${vs.total}/100 → confidence raised from ${memory.confidence}`,
        });
      }
      // Also bump importance if it was artificially low
      if (memory.importance < 0.55) {
        updates.push({
          field: 'importance',
          value: 0.55,
          reason: `LLM overrode det score ${vs.total}/100 → importance raised from ${memory.importance}`,
        });
      }
      break;
    }

    case 'stale': {
      // Mark stale — non-terminal signal (skip if already stale)
      if (memory.status !== 'stale') {
        updates.push({
          field: 'status',
          value: 'stale',
          reason: `Triage: det score ${vs.total}/100, LLM rated ${eval_.score} → marking stale`,
        });
      }
      // Lower confidence to reflect uncertainty
      if (memory.confidence > 0.4) {
        updates.push({
          field: 'confidence',
          value: 0.4,
          reason: `Triage uncertain → confidence lowered from ${memory.confidence}`,
        });
      }
      break;
    }

    case 'propose_archive':
    case 'propose_archive_safety_stale': {
      // For safety-gated: mark stale instead of archiving
      if (action === 'propose_archive_safety_stale') {
        if (memory.status !== 'stale') {
          updates.push({
            field: 'status',
            value: 'stale',
            reason: `LLM rated ${eval_.score} but importance ${memory.importance} ≥ 0.9 → safety gate: stale only`,
          });
        }
      }
      // For non-safety-gated: lower confidence to reflect archive recommendation
      if (action === 'propose_archive' && memory.confidence > 0.3) {
        updates.push({
          field: 'confidence',
          value: 0.3,
          reason: `LLM rated ${eval_.score} → archive recommended, confidence lowered from ${memory.confidence}`,
        });
      }
      break;
    }

    default:
      break;
  }

  return { updates };
}

// ── Proposal computation ────────────────────────────────────────────────

function computeProposal(
  memory: Sage,
  action: TriageAction,
  eval_: LlmTriageResult['evaluation'],
): TriageProposal | null {
  switch (action) {
    case 'propose_archive':
      return {
        memoryId: memory.id,
        memoryText: memory.text.slice(0, TRUNCATE_PREVIEW),
        suggestedAction: 'archive',
        reason: `LLM rated ${eval_.score} (${eval_.reason}) + det score low → propose archive`,
      };

    case 'propose_archive_safety_stale':
      return {
        memoryId: memory.id,
        memoryText: memory.text.slice(0, TRUNCATE_PREVIEW),
        suggestedAction: 'investigate',
        reason: `LLM rated ${eval_.score} but importance ${memory.importance} ≥ 0.9 → safety gate: human review needed. LLM reason: ${eval_.reason}`,
      };

    default:
      return null;
  }
}

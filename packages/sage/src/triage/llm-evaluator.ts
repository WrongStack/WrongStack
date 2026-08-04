/**
 * Phase 3: Cheap LLM Per-Memory Evaluation
 *
 * Takes memories in the "gray zone" (Phase 2 score 30-69) and evaluates each
 * one individually with a compact prompt on a cheap model. The LLM rates the
 * memory's value on a 1-5 scale.
 *
 * Design:
 * - Pluggable `evaluate` function — callers inject the LLM transport
 *   (e.g., `llm` tool, direct API call, mock for testing).
 * - Ultra-compact prompt: ~100 tokens per memory.
 * - Structured output: "SCORE | REASON" format for easy parsing.
 * - Safety gate: importance >= 0.9 memories cannot get destructive actions.
 */

import type { Sage } from '../types.js';
import type { ValueScoreBreakdown } from './value-score.js';

// ── Types ───────────────────────────────────────────────────────────────

/** What the LLM returns for a single memory. */
export interface LlmEvaluation {
  /** 1-5 rating from the LLM. */
  score: 1 | 2 | 3 | 4 | 5;
  /** One-line reason from the LLM. */
  reason: string;
  /** Raw response text for audit. */
  raw: string;
  /** Whether the LLM call succeeded. */
  ok: boolean;
  /** Error message if the call failed. */
  error?: string | undefined;
}

/** Action derived from combining the LLM score with the Phase 2 value score. */
export type TriageAction =
  | 'keep'
  | 'keep_llm_override'
  | 'stale'
  | 'propose_archive'
  | 'propose_archive_safety_stale';

export interface LlmTriageResult {
  memory: Sage;
  valueScore: ValueScoreBreakdown;
  evaluation: LlmEvaluation;
  action: TriageAction;
  /** Human-readable explanation of why this action was chosen. */
  actionReason: string;
}

/**
 * Signature for the pluggable LLM call.
 *
 * Receives system + user prompt strings and returns the raw model output.
 * Callers wire this to the `llm` tool, a direct provider call, or a mock.
 */
export type LlmCallFn = (system: string, userPrompt: string) => Promise<string>;

// ── Options ─────────────────────────────────────────────────────────────

export interface LlmEvaluatorOptions {
  /** Maximum memories to evaluate in a single batch (safety cap). */
  maxBatchSize?: number | undefined;
  /** Whether to log each evaluation to stderr. */
  verbose?: boolean | undefined;
}

const DEFAULT_MAX_BATCH_SIZE = 50;

// ── Prompt templates ────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  'Rate this project memory 1-5. 1=noise/dust 2=transient/churn 3=niche/rarely-useful 4=useful 5=essential. Reply: SCORE | one-line reason.';

/**
 * Build a compact user prompt for a single memory.
 * Target: ~80-120 tokens.
 */
function buildUserPrompt(memory: Sage, vs: ValueScoreBreakdown): string {
  const anchorSummary = memory.anchors.length > 0
    ? memory.anchors.map((a) => a.path ?? a.symbol ?? a.command ?? a.type).slice(0, 3).join(', ')
    : 'none';
  const age = daysSince(memory.createdAt);

  return [
    `TEXT: "${truncate(memory.text, 300)}"`,
    `ANCHORS: ${anchorSummary} | KIND: ${memory.kind}`,
    `INJECTED: ${memory.injectionCount ?? 0}x | USED: ${memory.useCount ?? 0}x`,
    `AGE: ${age}d | SCORE: ${vs.total}/100 | IMPORTANCE: ${memory.importance.toFixed(1)}`,
  ].join('\n');
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Evaluate a single gray-zone memory with the LLM.
 */
export async function evaluateMemory(
  memory: Sage,
  valueScore: ValueScoreBreakdown,
  callLlm: LlmCallFn,
): Promise<LlmTriageResult> {
  const userPrompt = buildUserPrompt(memory, valueScore);
  let evaluation: LlmEvaluation;

  try {
    const raw = await callLlm(SYSTEM_PROMPT, userPrompt);
    evaluation = parseEvaluation(raw);
  } catch (err) {
    evaluation = {
      score: 3,
      reason: 'LLM call failed — defaulting to neutral',
      raw: '',
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const { action, actionReason } = resolveAction(memory, valueScore, evaluation);
  return { memory, valueScore, evaluation, action, actionReason };
}

/**
 * Evaluate a batch of gray-zone memories sequentially.
 *
 * Sequential by design — cheap models often have low rate limits,
 * and we want predictable, auditable behavior.
 */
export async function evaluateBatch(
  memories: Sage[],
  valueScores: Map<string, ValueScoreBreakdown>,
  callLlm: LlmCallFn,
  options: LlmEvaluatorOptions = {},
): Promise<LlmTriageResult[]> {
  const maxBatch = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
  const batch = memories.slice(0, maxBatch);
  const results: LlmTriageResult[] = [];

  for (const memory of batch) {
    const vs = valueScores.get(memory.id);
    if (!vs) {
      if (options.verbose) {
        process.stderr.write(`[triage] skipping ${memory.id}: no value score\n`);
      }
      continue;
    }
    if (options.verbose) {
      process.stderr.write(`[triage] evaluating ${memory.id} (score ${vs.total}/100)...\n`);
    }
    const result = await evaluateMemory(memory, vs, callLlm);
    results.push(result);
  }

  return results;
}

// ── Action resolution ──────────────────────────────────────────────────

/**
 * Map an LLM score + Phase 2 value score to a concrete triage action.
 *
 * Safety gate: importance >= 0.9 memories never get destructive actions.
 * The worst that can happen to them is being marked stale.
 */
function resolveAction(
  memory: Sage,
  vs: ValueScoreBreakdown,
  eval_: LlmEvaluation,
): { action: TriageAction; actionReason: string } {
  const imp = memory.importance;
  const llmScore = eval_.score;
  const safetyGated = imp >= 0.9;

  // LLM score 5 → always keep
  if (llmScore === 5) {
    return {
      action: 'keep',
      actionReason: `LLM rated 5 (essential) + det score ${vs.total}/100 → keep, update confidence → 0.9`,
    };
  }

  // LLM score 4 → keep (override if det score is low)
  if (llmScore === 4) {
    if (vs.total >= 40) {
      return {
        action: 'keep',
        actionReason: `LLM rated 4 (useful) + det score ${vs.total}/100 ≥ 40 → keep, update confidence → 0.8`,
      };
    }
    return {
      action: 'keep_llm_override',
      actionReason: `LLM rated 4 (useful) overrides det score ${vs.total}/100 (< 40) → keep`,
    };
  }

  // LLM score 3 → borderline
  if (llmScore === 3) {
    if (vs.total >= 50) {
      return {
        action: 'keep',
        actionReason: `LLM rated 3 (niche) + det score ${vs.total}/100 ≥ 50 → keep`,
      };
    }
    return {
      action: 'stale',
      actionReason: `LLM rated 3 (niche) + det score ${vs.total}/100 < 50 → mark stale, lower confidence → 0.4`,
    };
  }

  // LLM score 2 → propose archive (unless safety-gated)
  if (llmScore === 2) {
    if (safetyGated) {
      return {
        action: 'stale',
        actionReason: `LLM rated 2 (transient) but importance ${imp} ≥ 0.9 → safety gate: mark stale only (not archive)`,
      };
    }
    return {
      action: 'propose_archive',
      actionReason: `LLM rated 2 (transient) + det score ${vs.total}/100 → propose archive`,
    };
  }

  // LLM score 1 → propose archive (unless safety-gated)
  if (llmScore === 1) {
    if (safetyGated) {
      return {
        action: 'propose_archive_safety_stale',
        actionReason: `LLM rated 1 (noise) but importance ${imp} ≥ 0.9 → safety gate: mark stale only, flag for human review`,
      };
    }
    return {
      action: 'propose_archive',
      actionReason: `LLM rated 1 (noise) + det score ${vs.total}/100 → propose archive`,
    };
  }

  // Fallback (shouldn't reach here)
  return { action: 'keep', actionReason: 'fallback: default keep' };
}

// ── Response parsing ───────────────────────────────────────────────────

/**
 * Parse the LLM's raw response into a structured evaluation.
 *
 * Expected format: "SCORE | REASON"
 * Examples: "4 | Documents a key architectural invariant"
 *           "2 | Outdated — the API has changed since this was written"
 *
 * Robust to minor formatting variations:
 * - Accepts "SCORE - REASON", "SCORE: REASON", "SCORE. REASON"
 * - Extracts the first digit 1-5 found at the start
 * - Falls back to score 3 (neutral) on parse failure
 */
function parseEvaluation(raw: string): LlmEvaluation {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { score: 3, reason: 'empty response', raw, ok: false, error: 'Empty LLM response' };
  }

  // Extract first digit 1-5
  const scoreMatch = trimmed.match(/^[^\d]*([1-5])/);
  const score: 1 | 2 | 3 | 4 | 5 = scoreMatch?.[1]
    ? (Number.parseInt(scoreMatch[1], 10) as 1 | 2 | 3 | 4 | 5)
    : 3;

  // Extract reason: everything after the score + separator
  const reasonMatch = trimmed.match(/^[^\d]*[1-5]\s*[|\-:.]\s*(.+)/s);
  const reason = reasonMatch?.[1] ? reasonMatch[1].trim().slice(0, 200) : trimmed.slice(0, 200);

  return { score, reason, raw, ok: true };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

function daysSince(iso: string): number {
  const diff = Date.now() - new Date(iso).getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

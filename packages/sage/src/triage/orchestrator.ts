/**
 * Triage Orchestrator — wires all 5 phases together.
 *
 * Pipeline:
 *   1. preFilterBatch    → split into keep / discard / uncertain
 *   2. computeValueScores → score uncertain memories 0-100
 *   3. evaluateBatch      → LLM-triage gray-zone memories (30-69)
 *   4. detectMerges       → cluster + pair LLM comparison
 *   5. dispatchBatch      → produce autoApply + proposals
 *
 * Output is a single TriageReport that callers can:
 *   - read to understand what was found
 *   - execute dry-run by checking report.dryRun
 *   - execute apply by iterating report.dispatch.autoApply and calling
 *     memory_update for each, plus report.dispatch.proposals for
 *     memory_candidates propose calls
 */

import type { Sage } from '../types.js';
import type { AutoApplyAction, TriageProposal } from './action-dispatcher.js';
import { dispatchBatch } from './action-dispatcher.js';
import type { LlmCallFn } from './llm-evaluator.js';
import { evaluateBatch } from './llm-evaluator.js';
import type { MergeAction, OverlapProposal } from './merge-detection.js';
import { detectMerges } from './merge-detection.js';
import { preFilterBatch } from './pre-filter.js';
import type { InjectorEvidence } from './value-score.js';
import { computeValueScore } from './value-score.js';

// ── Types ───────────────────────────────────────────────────────────────

export interface TriageReport {
  dryRun: boolean;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  phaseStats: {
    /** Total memories submitted to the pipeline. */
    input: number;
    /** Phase 1: kept without further triage. */
    phase1Keep: number;
    /** Phase 1: discarded (stale marker + archive proposal). */
    phase1Discard: number;
    /** Phase 1: uncertain (flow into Phase 2). */
    phase1Uncertain: number;
    /** Phase 2: score distribution. */
    phase2Keep: number;
    phase2Gray: number;
    phase2Discard: number;
    /** Phase 3: LLM-evaluated gray-zone memories. */
    phase3Evaluated: number;
    /** Phase 4: merge detection. */
    phase4Clusters: number;
    phase4PairsEvaluated: number;
  };
  /** Phase 5 dispatch output. */
  dispatch: {
    autoApply: AutoApplyAction[];
    proposals: TriageProposal[];
  };
  /** Phase 4 merge output. */
  merges: {
    merges: MergeAction[];
    overlaps: OverlapProposal[];
  };
  /** Cost estimate. */
  cost: {
    /** Total LLM calls made (Phase 3 + Phase 4). */
    llmCalls: number;
    /** Estimated tokens used (input + output). */
    estimatedTokens: number;
  };
}

export interface RunTriageOptions {
  /** If true, do not mark any memories as needing updates — just compute. */
  dryRun?: boolean;
  /**
   * Optional provider that supplies SAGE injector gate evidence per
   * memory id. The Phase 2 value scorer folds this evidence into its
   * `rejectionPressure`, `rejectionGate`, and `usage` sub-score
   * calculations. When omitted, `computeValueScore` falls back to its
   * pre-A4 behavior (no pressure, no gate, no usage penalty).
   *
   * The provider is invoked once per Phase 2 entry. A `undefined`
   * return means "no evidence for this memory" — the scorer treats it
   * identically to omitting the option. The CLI runner will wire a
   * concrete provider in a follow-up; today, callers can pass any
   * `(memoryId) => InjectorEvidence | undefined` to opt in.
   */
  injectorEvidenceProvider?: (memoryId: string) => InjectorEvidence | undefined;
  /** Max LLM calls for Phase 3. Default: 1000. */
  maxPhase3Calls?: number;
  /** Max pairs for Phase 4. Default: 50. */
  maxPhase4Pairs?: number;
  /** When true, log progress to stderr. */
  verbose?: boolean;
}

const DEFAULT_MAX_PHASE3_CALLS = 1000;
const DEFAULT_MAX_PHASE4_PAIRS = 50;

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Run the full triage pipeline on a set of memories.
 *
 * This is a pure computation function — it does NOT call any persistence
 * tools (memory_update, memory_candidates). The caller is responsible for
 * executing the dispatch actions.
 */
export async function runTriage(
  memories: Sage[],
  callLlm: LlmCallFn,
  options: RunTriageOptions = {},
): Promise<TriageReport> {
  const dryRun = options.dryRun ?? true;
  const verbose = options.verbose ?? false;
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  // ── Phase 1: Pre-filter ──────────────────────────────────────
  if (verbose) process.stderr.write(`[triage] Phase 1: pre-filtering ${memories.length}...\n`);
  const phase1 = preFilterBatch(memories);

  // ── Phase 2: Value score ─────────────────────────────────────
  if (verbose)
    process.stderr.write(`[triage] Phase 2: scoring ${phase1.uncertain.length} uncertain...\n`);
  const valueScores = new Map<string, ReturnType<typeof computeValueScore>>();
  let phase2Keep = 0;
  let phase2Gray = 0;
  let phase2Discard = 0;

  for (const memory of phase1.uncertain) {
    const evidence = options.injectorEvidenceProvider?.(memory.id);
    const score = evidence
      ? computeValueScore(memory, { injectorEvidence: evidence })
      : computeValueScore(memory);
    valueScores.set(memory.id, score);
    if (score.band === 'keep') phase2Keep++;
    else if (score.band === 'gray') phase2Gray++;
    else phase2Discard++;
  }

  // ── Phase 3: LLM triage (gray zone only) ─────────────────────
  const grayMemories = phase1.uncertain.filter((m) => {
    const s = valueScores.get(m.id);
    return s?.band === 'gray';
  });

  if (verbose)
    process.stderr.write(`[triage] Phase 3: LLM triage on ${grayMemories.length} gray-zone...\n`);
  const maxPhase3 = options.maxPhase3Calls ?? DEFAULT_MAX_PHASE3_CALLS;
  const llmResults = await evaluateBatch(grayMemories, valueScores, callLlm, {
    maxBatchSize: maxPhase3,
    verbose,
  });

  // ── Phase 4: Merge detection ─────────────────────────────────
  if (verbose) process.stderr.write(`[triage] Phase 4: merge detection...\n`);
  const maxPhase4Pairs = options.maxPhase4Pairs ?? DEFAULT_MAX_PHASE4_PAIRS;
  const mergeResult = await detectMerges(memories, callLlm, {
    maxPairs: maxPhase4Pairs,
    verbose,
  });

  // ── Phase 5: Dispatch ────────────────────────────────────────
  if (verbose) process.stderr.write(`[triage] Phase 5: dispatching actions...\n`);
  const dispatch = dispatchBatch(llmResults);

  const completedAt = new Date().toISOString();

  // ── Cost estimate ────────────────────────────────────────────
  // Phase 3: ~150 tokens per call (system + user + output)
  // Phase 4: ~530 tokens per call (system + user with 2x 250 chars + output)
  const phase3Tokens = llmResults.length * 150;
  const phase4Tokens = mergeResult.summary.pairsEvaluated * 530;
  const totalTokens = phase3Tokens + phase4Tokens;

  return {
    dryRun,
    startedAt,
    completedAt,
    durationMs: Date.now() - startMs,
    phaseStats: {
      input: memories.length,
      phase1Keep: phase1.keep.length,
      phase1Discard: phase1.discard.length,
      phase1Uncertain: phase1.uncertain.length,
      phase2Keep,
      phase2Gray,
      phase2Discard,
      phase3Evaluated: llmResults.length,
      phase4Clusters: mergeResult.summary.clusters,
      phase4PairsEvaluated: mergeResult.summary.pairsEvaluated,
    },
    dispatch: {
      autoApply: dispatch.autoApply,
      proposals: dispatch.proposals,
    },
    merges: {
      merges: mergeResult.merges,
      overlaps: mergeResult.overlaps,
    },
    cost: {
      llmCalls: llmResults.length + mergeResult.summary.pairsEvaluated,
      estimatedTokens: totalTokens,
    },
  };
}

/**
 * Format a TriageReport as a human-readable Markdown summary.
 */
export function formatTriageReport(report: TriageReport): string {
  const lines: string[] = [];

  lines.push(`# Triage Report — ${report.startedAt}`);
  lines.push('');
  lines.push(`- **Mode:** ${report.dryRun ? 'dry-run' : 'apply'}`);
  lines.push(`- **Duration:** ${report.durationMs}ms`);
  lines.push('');

  lines.push('## Phase Statistics');
  lines.push('');
  lines.push(`- Input: ${report.phaseStats.input} memories`);
  lines.push(
    `- Phase 1: ${report.phaseStats.phase1Keep} keep, ${report.phaseStats.phase1Discard} discard, ${report.phaseStats.phase1Uncertain} uncertain`,
  );
  lines.push(
    `- Phase 2: ${report.phaseStats.phase2Keep} keep, ${report.phaseStats.phase2Gray} gray, ${report.phaseStats.phase2Discard} discard`,
  );
  lines.push(`- Phase 3: ${report.phaseStats.phase3Evaluated} LLM evaluations`);
  lines.push(
    `- Phase 4: ${report.phaseStats.phase4Clusters} clusters, ${report.phaseStats.phase4PairsEvaluated} pairs`,
  );
  lines.push('');

  lines.push('## Actions');
  lines.push('');
  lines.push(`- Auto-apply updates: ${report.dispatch.autoApply.length}`);
  lines.push(`- Proposals (archive/investigate): ${report.dispatch.proposals.length}`);
  lines.push(`- Merge actions: ${report.merges.merges.length}`);
  lines.push(`- Overlap proposals: ${report.merges.overlaps.length}`);
  lines.push('');

  lines.push('## Cost');
  lines.push('');
  lines.push(`- LLM calls: ${report.cost.llmCalls}`);
  lines.push(`- Estimated tokens: ${report.cost.estimatedTokens}`);
  lines.push('');

  return lines.join('\n');
}

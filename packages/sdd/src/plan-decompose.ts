/**
 * Planning-time proactive decomposition pass.
 *
 * Walks the pending leaves of a generated TaskGraph, scores each with the
 * deterministic atomicity rule set, and for every `needs_decomposition`
 * verdict asks the injected LLM decomposer for sub-tasks:
 *   - mode 'auto': applies the split immediately via splitGraphNode (the same
 *     code path run-time splits use);
 *   - mode 'propose': returns proposals for approval (WebUI surfaces them).
 *
 * Bounded and non-recursive: children created here are never re-decomposed in
 * the same pass, and `maxDecompositions` caps LLM spend per graph.
 */

import {
  assessAtomicity,
  type AtomicityRuleSetConfig,
  type KanbanAtomicityAssessment,
} from '@wrongstack/kanban';
import type { TaskTracker } from '@wrongstack/core/tasking';
import type { TaskNode } from '@wrongstack/core/types';
import type { PlanningDecomposer } from './decompose-task.js';
import { splitGraphNode } from './graph-split.js';
import type { SddSubtaskSpec } from './sdd-parallel-run.js';
import { extractVerificationCommand } from './task-generator.js';

export interface DecompositionProposal {
  nodeId: string;
  title: string;
  reasons: string[];
  subtasks: SddSubtaskSpec[];
}

export interface PlanDecomposeOptions {
  tracker: TaskTracker;
  decompose: PlanningDecomposer;
  config?: AtomicityRuleSetConfig | undefined;
  /** 'auto' applies splits immediately; 'propose' returns them for approval. */
  mode: 'auto' | 'propose';
  /** LLM budget guard: max decompositions per graph. Default 10. */
  maxDecompositions?: number | undefined;
}

export interface PlanDecomposeResult {
  /** Node ids that were split (auto mode). */
  applied: Array<{ nodeId: string; subtaskIds: string[] }>;
  /** Proposals awaiting approval (propose mode). */
  proposals: DecompositionProposal[];
  /** Node ids assessed as needing decomposition (superset of applied+proposals). */
  flagged: string[];
}

/** Count "- ..." bullets under an "**Acceptance Criteria:**" block. */
function countAcceptanceCriteria(description: string): number {
  const marker = description.indexOf('**Acceptance Criteria:**');
  if (marker === -1) return 0;
  const tail = description.slice(marker);
  return (tail.match(/^\s*-\s+\S/gm) ?? []).length;
}

export function assessTaskNodeAtomicity(
  tracker: TaskTracker,
  node: TaskNode,
  config?: AtomicityRuleSetConfig,
): KanbanAtomicityAssessment {
  const criteriaCount = countAcceptanceCriteria(node.description ?? '');
  const verificationCommand =
    (node.metadata?.['verificationCommand'] as string | undefined) ??
    extractVerificationCommand([node.description ?? '']);
  return assessAtomicity(
    {
      title: node.title,
      description: node.description,
      estimatedHours: node.estimateHours,
      dependencyCount: tracker.getBlockers(node.id).length,
      successCriteriaCount: criteriaCount,
      hasVerifiableOutput: Boolean(verificationCommand),
      childCount: tracker.getAllNodes().filter((n) => n.parentId === node.id).length,
    },
    config,
  );
}

export async function decomposeNonAtomicTasks(
  opts: PlanDecomposeOptions,
): Promise<PlanDecomposeResult> {
  const maxDecompositions = Math.max(1, opts.maxDecompositions ?? 10);
  const result: PlanDecomposeResult = { applied: [], proposals: [], flagged: [] };

  const nodes = opts.tracker.getAllNodes();
  const childCounts = new Map<string, number>();
  for (const node of nodes) {
    if (node.parentId) childCounts.set(node.parentId, (childCounts.get(node.parentId) ?? 0) + 1);
  }
  // Snapshot the candidate list before any split so children created by this
  // pass are never re-decomposed (no recursion).
  const candidates = nodes.filter((node) => node.status === 'pending' && !childCounts.get(node.id));

  let spent = 0;
  for (const node of candidates) {
    if (spent >= maxDecompositions) break;
    const assessment = assessTaskNodeAtomicity(opts.tracker, node, opts.config);
    // Stamp the assessment so downstream surfaces (board projector, mirror)
    // can show why a task was or wasn't split.
    opts.tracker.patchMetadata(node.id, {
      atomicity: {
        verdict: assessment.verdict,
        score: assessment.score,
        reasons: assessment.criteria.filter((c) => c.score < 1).map((c) => c.reason),
      },
    });
    if (assessment.verdict !== 'needs_decomposition') continue;
    result.flagged.push(node.id);
    spent += 1;

    const reasons = assessment.criteria.filter((c) => c.score < 1).map((c) => c.reason);
    const subtasks = await opts.decompose({
      title: node.title,
      description: node.description ?? '',
      reasons,
    });
    if (!subtasks.length) continue;

    if (opts.mode === 'auto') {
      const subtaskIds = splitGraphNode(opts.tracker, node.id, subtasks);
      if (subtaskIds.length) result.applied.push({ nodeId: node.id, subtaskIds });
    } else {
      result.proposals.push({ nodeId: node.id, title: node.title, reasons, subtasks });
    }
  }
  return result;
}

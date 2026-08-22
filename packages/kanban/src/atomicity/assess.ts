/**
 * Atomicity assessment: scores a candidate against the deterministic rule set
 * and maps the aggregate to a verdict. Pure — persistence and events live in
 * manager/atomicity.ts.
 */

import { createHash } from 'node:crypto';
import type {
  AtomicityRuleSetConfig,
  AtomicityVerdict,
  KanbanAtomicityAssessment,
  KanbanTask,
} from '../types.js';
import {
  type AtomicityCandidate,
  buildDefaultRuleSet,
  resolveAtomicityConfig,
} from './criteria.js';

/** Check types the completion verifier can evaluate without an LLM. */
const DETERMINISTIC_CHECK_TYPES = new Set([
  'test',
  'command',
  'file_exists',
  'file_matches',
  'git_diff',
  'metric',
]);

import { nowIso } from '@wrongstack/primitives';

export function hashAtomicityConfig(config?: AtomicityRuleSetConfig): string {
  const resolved = resolveAtomicityConfig(config);
  return createHash('sha256').update(JSON.stringify(resolved)).digest('hex').slice(0, 12);
}

export function assessAtomicity(
  candidate: AtomicityCandidate,
  config?: AtomicityRuleSetConfig,
  options: { assessedBy?: KanbanAtomicityAssessment['assessedBy'] | undefined } = {},
): KanbanAtomicityAssessment {
  const resolved = resolveAtomicityConfig(config);
  const assessedBy = options.assessedBy ?? 'rules';

  // Tasks that already have children are containers: they are completed via
  // subtask aggregation, so per-axis scoring is irrelevant.
  if (candidate.childCount > 0) {
    return {
      verdict: 'composite',
      score: 1,
      criteria: [
        {
          id: 'already-decomposed',
          score: 1,
          weight: 1,
          reason: `${candidate.childCount} child tasks; container verified via subtask aggregation`,
        },
      ],
      assessedAt: nowIso(),
      assessedBy,
      configHash: hashAtomicityConfig(config),
    };
  }

  const scoreAgainst = (ruleSetConfig: AtomicityRuleSetConfig | undefined) =>
    buildDefaultRuleSet(ruleSetConfig).map((criterion) => {
      const { score, reason } = criterion.evaluate(candidate);
      return { id: criterion.id as string, score, weight: criterion.weight, reason };
    });

  let criteria = scoreAgainst(config);
  let totalWeight = criteria.reduce((sum, entry) => sum + entry.weight, 0);
  if (totalWeight === 0) {
    // Every criterion weight was overridden to zero. Scoring 1 here — which is
    // what the previous `totalWeight > 0 ? … : 1` fallback did — returned the
    // most permissive verdict, 'atomic', meaning "do not decompose". A config
    // that expresses no opinion at all would therefore silently switch
    // decomposition off, and it would do so in the direction that looks fine.
    //
    // Zeroing a subset is a supported and tested way to score on one axis, but
    // zeroing *all* of them is indistinguishable from supplying no weights, so
    // fall back to the built-in ones and produce a real assessment. Those are
    // all positive, so this cannot recurse into the same state.
    criteria = scoreAgainst({ ...config, weights: {} });
    totalWeight = criteria.reduce((sum, entry) => sum + entry.weight, 0);
  }
  const score = criteria.reduce((sum, entry) => sum + entry.score * entry.weight, 0) / totalWeight;

  let verdict: AtomicityVerdict;
  if (score >= resolved.atomicThreshold) verdict = 'atomic';
  else if (score < resolved.decomposeThreshold) verdict = 'needs_decomposition';
  else verdict = 'borderline';

  return {
    verdict,
    score: Math.round(score * 1000) / 1000,
    criteria,
    assessedAt: nowIso(),
    assessedBy,
    configHash: hashAtomicityConfig(config),
  };
}

export function candidateFromKanbanTask(task: KanbanTask): AtomicityCandidate {
  const successCriteria = task.successCriteria ?? [];
  return {
    title: task.title,
    description: task.description,
    estimatedHours: task.estimatedHours,
    dependencyCount: task.dependsOn?.length ?? 0,
    expectedFileChangeCount: task.expectedFileChanges?.length,
    successCriteriaCount: successCriteria.length,
    hasVerifiableOutput: successCriteria.some((check) => DETERMINISTIC_CHECK_TYPES.has(check.type)),
    childCount: task.childTaskIds?.length ?? 0,
  };
}

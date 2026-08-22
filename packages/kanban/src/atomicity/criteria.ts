/**
 * Deterministic atomicity rule set.
 *
 * Pure and side-effect free by design: no LLM, no I/O, no core dependency.
 * The engine scores a neutral candidate shape so both KanbanTask and mapped
 * task-graph nodes can be assessed with the same rules.
 */

import type { AtomicityRuleSetConfig } from '../types.js';

/** Neutral input so both KanbanTask and (mapped) core TaskNode can be scored. */
export interface AtomicityCandidate {
  title: string;
  description?: string | undefined;
  estimatedHours?: number | undefined;
  /** dependsOn.length */
  dependencyCount: number;
  expectedFileChangeCount?: number | undefined;
  successCriteriaCount: number;
  /** At least one criterion of a deterministic type (test|command|file_exists|file_matches|git_diff|metric). */
  hasVerifiableOutput: boolean;
  /** childTaskIds.length */
  childCount: number;
}

export type AtomicityCriterionId =
  | 'effort'
  | 'file-scope'
  | 'dependency-fan-in'
  | 'single-verifiable-output'
  | 'description-scope'
  | 'already-decomposed';

export interface AtomicityCriterion {
  id: AtomicityCriterionId;
  /** Score in [0, 1]; 1 = fully atomic on this axis. */
  evaluate(candidate: AtomicityCandidate): { score: number; reason: string };
  weight: number;
}

export interface ResolvedAtomicityConfig {
  maxEstimatedHours: number;
  maxExpectedFileChanges: number;
  maxDependencies: number;
  maxScopeMarkers: number;
  atomicThreshold: number;
  decomposeThreshold: number;
  weights: Partial<Record<string, number>>;
}

export const DEFAULT_ATOMICITY_CONFIG: ResolvedAtomicityConfig = {
  maxEstimatedHours: 4,
  maxExpectedFileChanges: 5,
  maxDependencies: 3,
  maxScopeMarkers: 2,
  atomicThreshold: 0.7,
  decomposeThreshold: 0.45,
  weights: {},
};

export function resolveAtomicityConfig(config?: AtomicityRuleSetConfig): ResolvedAtomicityConfig {
  return {
    maxEstimatedHours: config?.maxEstimatedHours ?? DEFAULT_ATOMICITY_CONFIG.maxEstimatedHours,
    maxExpectedFileChanges:
      config?.maxExpectedFileChanges ?? DEFAULT_ATOMICITY_CONFIG.maxExpectedFileChanges,
    maxDependencies: config?.maxDependencies ?? DEFAULT_ATOMICITY_CONFIG.maxDependencies,
    maxScopeMarkers: config?.maxScopeMarkers ?? DEFAULT_ATOMICITY_CONFIG.maxScopeMarkers,
    atomicThreshold: config?.atomicThreshold ?? DEFAULT_ATOMICITY_CONFIG.atomicThreshold,
    decomposeThreshold: config?.decomposeThreshold ?? DEFAULT_ATOMICITY_CONFIG.decomposeThreshold,
    weights: config?.weights ?? {},
  };
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Linear penalty above a ceiling: at or below `limit` the axis is fully atomic;
 * the score decays to 0 as the value approaches `limit * 2`.
 */
function ceilingScore(value: number, limit: number): number {
  if (value <= limit) return 1;
  const overflowSpan = Math.max(limit, 1);
  return clamp01(1 - (value - limit) / overflowSpan);
}

/**
 * Markers that suggest a task bundles several deliverables: explicit
 * conjunctions between clauses and enumerated lists in the description.
 * Kept intentionally coarse — this axis nudges, it does not decide alone.
 */
const SCOPE_MARKER_RES: RegExp[] = [
  /\band\s+(?:then|also)\b/gi,
  /\bthen\b/gi,
  /\bafter\s+that\b/gi,
  /\bas\s+well\s+as\b/gi,
  /\bplus\b/gi,
  /^\s*(?:[-*]|\d+[.)])\s+/gm,
  /;\s/g,
];

export function countScopeMarkers(text: string): number {
  let count = 0;
  for (const re of SCOPE_MARKER_RES) {
    const matches = text.match(re);
    if (matches) count += matches.length;
  }
  return count;
}

export function buildDefaultRuleSet(config?: AtomicityRuleSetConfig): AtomicityCriterion[] {
  const resolved = resolveAtomicityConfig(config);
  const weightOf = (id: AtomicityCriterionId, fallback: number): number => {
    const override = resolved.weights[id];
    return typeof override === 'number' && override >= 0 ? override : fallback;
  };

  const criteria: AtomicityCriterion[] = [
    {
      id: 'effort',
      weight: weightOf('effort', 3),
      evaluate: (c) => {
        if (c.estimatedHours === undefined) {
          return { score: 0.6, reason: 'no estimate; effort unknown' };
        }
        const score = ceilingScore(c.estimatedHours, resolved.maxEstimatedHours);
        return {
          score,
          reason:
            c.estimatedHours <= resolved.maxEstimatedHours
              ? `estimated ${c.estimatedHours}h within ${resolved.maxEstimatedHours}h ceiling`
              : `estimated ${c.estimatedHours}h exceeds ${resolved.maxEstimatedHours}h ceiling`,
        };
      },
    },
    {
      id: 'file-scope',
      weight: weightOf('file-scope', 2),
      evaluate: (c) => {
        if (c.expectedFileChangeCount === undefined) {
          return { score: 0.7, reason: 'no expected file changes declared; scope unknown' };
        }
        const score = ceilingScore(c.expectedFileChangeCount, resolved.maxExpectedFileChanges);
        return {
          score,
          reason:
            c.expectedFileChangeCount <= resolved.maxExpectedFileChanges
              ? `${c.expectedFileChangeCount} expected file changes within ${resolved.maxExpectedFileChanges}`
              : `${c.expectedFileChangeCount} expected file changes exceed ${resolved.maxExpectedFileChanges}`,
        };
      },
    },
    {
      id: 'dependency-fan-in',
      weight: weightOf('dependency-fan-in', 1),
      evaluate: (c) => {
        const score = ceilingScore(c.dependencyCount, resolved.maxDependencies);
        return {
          score,
          reason:
            c.dependencyCount <= resolved.maxDependencies
              ? `${c.dependencyCount} dependencies within ${resolved.maxDependencies}`
              : `${c.dependencyCount} dependencies exceed ${resolved.maxDependencies}`,
        };
      },
    },
    {
      id: 'single-verifiable-output',
      weight: weightOf('single-verifiable-output', 2),
      evaluate: (c) => {
        if (c.successCriteriaCount === 0) {
          return { score: 0.3, reason: 'no success criteria; completion is unverifiable' };
        }
        if (!c.hasVerifiableOutput) {
          return {
            score: 0.55,
            reason: `${c.successCriteriaCount} criteria but none deterministically verifiable`,
          };
        }
        return {
          score: 1,
          reason: `${c.successCriteriaCount} criteria with at least one deterministic verifier`,
        };
      },
    },
    {
      id: 'description-scope',
      weight: weightOf('description-scope', 1),
      evaluate: (c) => {
        const markers = countScopeMarkers(`${c.title}\n${c.description ?? ''}`);
        const score = ceilingScore(markers, resolved.maxScopeMarkers);
        return {
          score,
          reason:
            markers <= resolved.maxScopeMarkers
              ? `${markers} scope markers within ${resolved.maxScopeMarkers}`
              : `${markers} scope markers suggest bundled deliverables`,
        };
      },
    },
  ];
  return criteria;
}

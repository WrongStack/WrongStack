/**
 * TechStack — Deterministic research triage.
 *
 * Decides which dependencies are worth an LLM call. No LLM, no network.
 *
 * @see docs/archive/specs/techstack-sdd.md §31, §557
 */

import type { DependencyObservation, DependencyStatus } from '../types.js';
import type { ResearchCluster, TriageCandidate } from './types.js';

/** Default cap on researched packages. Keeps a full analyze bounded. */
export const DEFAULT_TRIAGE_LIMIT = 40;

const CLUSTER_BY_STATUS: Partial<Record<DependencyStatus, ResearchCluster>> = {
  vulnerable: 'vulnerability',
  yanked: 'replacement',
  deprecated: 'replacement',
  unmaintained_suspected: 'replacement',
  update_available_breaking: 'breaking_change',
};

const PRIORITY_BY_STATUS: Partial<Record<DependencyStatus, number>> = {
  vulnerable: 100,
  yanked: 80,
  deprecated: 60,
  update_available_breaking: 40,
  unmaintained_suspected: 30,
};

const DIRECT_BONUS = 10;
const RUNTIME_BONUS = 5;

function priorityFor(dep: DependencyObservation): number {
  const base = Object.hasOwn(PRIORITY_BY_STATUS, dep.status)
    ? (PRIORITY_BY_STATUS[dep.status] ?? 0)
    : 0;
  const direct = dep.direct ? DIRECT_BONUS : 0;
  const runtime = dep.scope === 'runtime' ? RUNTIME_BONUS : 0;
  return base + direct + runtime;
}

/**
 * A NUL escape is used as an unambiguous separator. Keeping the source as the
 * two printable characters `\\0` avoids embedding binary NUL bytes in this
 * TypeScript file while producing the same runtime key.
 */
function dedupKey(dep: DependencyObservation): string {
  return `${dep.ecosystem}\0${dep.name}\0${dep.locked ?? dep.installed ?? dep.requested ?? ''}`;
}

export interface TriageOptions {
  /** Max candidates returned. Defaults to {@link DEFAULT_TRIAGE_LIMIT}. */
  readonly limit?: number | undefined;
}

/** Select and rank the dependencies worth researching. */
export function triageCandidates(
  dependencies: readonly DependencyObservation[],
  options: TriageOptions = {},
): readonly TriageCandidate[] {
  // `Number(...)` first: a malformed caller value (a string, or NaN from an
  // unvalidated `AnalyzeOptions.researchLimit`) slips past `??`, and
  // `Math.max(0, NaN)` stays NaN — `slice(0, NaN)` then returned NOTHING, which
  // is indistinguishable from the deliberate `limit: 0` disable, so the whole
  // research stage became a silent no-op. NaN falls back to the documented
  // default; `Infinity` still means "no cap".
  const requested = Number(options.limit ?? DEFAULT_TRIAGE_LIMIT);
  const limit = Number.isNaN(requested) ? DEFAULT_TRIAGE_LIMIT : Math.max(0, requested);
  if (limit === 0) return [];

  const best = new Map<string, TriageCandidate>();

  for (const dependency of dependencies) {
    const cluster = Object.hasOwn(CLUSTER_BY_STATUS, dependency.status)
      ? CLUSTER_BY_STATUS[dependency.status]
      : undefined;
    if (!cluster) continue;
    if (dependency.sourceType === 'path' || dependency.sourceType === 'git') continue;

    const candidate: TriageCandidate = {
      dependency,
      cluster,
      priority: priorityFor(dependency),
    };

    const key = dedupKey(dependency);
    const existing = best.get(key);
    if (!existing || candidate.priority > existing.priority) {
      best.set(key, candidate);
    }
  }

  return [...best.values()]
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        a.dependency.name.localeCompare(b.dependency.name) ||
        (a.dependency.locked ?? '').localeCompare(b.dependency.locked ?? ''),
    )
    .slice(0, limit);
}

/** Group triaged candidates by cluster, preserving triage order within each. */
export function clusterCandidates(
  candidates: readonly TriageCandidate[],
): ReadonlyMap<ResearchCluster, readonly TriageCandidate[]> {
  const out = new Map<ResearchCluster, TriageCandidate[]>();
  for (const candidate of candidates) {
    const list = out.get(candidate.cluster);
    if (list) list.push(candidate);
    else out.set(candidate.cluster, [candidate]);
  }
  return out;
}

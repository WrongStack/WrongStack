import { triageCandidates } from '../research/triage.js';
import type { TechStackResearcher } from '../research/types.js';
import type { Finding, Snapshot } from '../types.js';

export interface ResearchPhaseOptions {
  readonly researcher?: TechStackResearcher | undefined;
  readonly researchLimit?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?:
    | ((phase: 'researching' | 'synthesizing', completed: number, total: number) => void)
    | undefined;
}

export async function runResearchPhase(
  snapshot: Snapshot,
  options: ResearchPhaseOptions = {},
): Promise<Snapshot> {
  if (!options.researcher || options.signal?.aborted) return snapshot;
  const candidates = triageCandidates(snapshot.dependencies, { limit: options.researchLimit });
  if (candidates.length === 0) return snapshot;
  options.onProgress?.('researching', 0, candidates.length);
  let findings: readonly Finding[];
  try {
    findings = await options.researcher.research(candidates, {
      signal: options.signal,
      onProgress: (completed, total) => options.onProgress?.('researching', completed, total),
    });
  } catch {
    return snapshot;
  }
  options.onProgress?.('synthesizing', 1, 1);
  return findings.length
    ? { ...snapshot, findings: [...snapshot.findings, ...findings] }
    : snapshot;
}

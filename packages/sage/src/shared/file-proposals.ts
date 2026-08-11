/**
 * File triage proposals as MemoryCandidates, deduped against pending reviews.
 * Shared by `/memory triage --apply` and the daily dry-run host schedule.
 */

import type { SageSurface } from '../service-contract.js';
import type { CreateCandidateInput } from '../types.js';
import type { TriageProposal } from '../triage/action-dispatcher.js';
import { filterProposalsAgainstPendingTargets } from './candidate-dedupe.js';

export interface ProposalFileResult {
  filed: number;
  failed: number;
  total: number;
  skippedAsDuplicate: number;
  failures: Array<{ memoryId: string; error: string }>;
  inputs: CreateCandidateInput[];
}

export async function fileTriageProposals(
  Sage: SageSurface,
  proposals: readonly TriageProposal[],
): Promise<ProposalFileResult> {
  const inputs: CreateCandidateInput[] = [];
  const failures: Array<{ memoryId: string; error: string }> = [];
  let filed = 0;
  let skippedAsDuplicate = 0;

  let toFile = [...proposals];
  if (typeof Sage.listCandidates === 'function') {
    try {
      const pending = await Sage.listCandidates(false);
      const filtered = filterProposalsAgainstPendingTargets(proposals, pending);
      skippedAsDuplicate = proposals.length - filtered.length;
      toFile = filtered;
    } catch {
      // Fail-open: file all proposals.
    }
  }

  for (const proposal of toFile) {
    const input: CreateCandidateInput = {
      text: proposal.memoryText,
      targetMemoryId: proposal.memoryId,
      reviewReason: proposal.reason,
      suggestedAction: proposal.suggestedAction,
      kind: 'memory_review',
      scope: 'project',
      importance: 0.5,
      confidence: 0.9,
      tags: ['triage'],
      anchors: [],
      sources: [{ type: 'project_instruction' }],
    };
    inputs.push(input);
    try {
      await Sage.createCandidate(input);
      filed++;
    } catch (err) {
      failures.push({
        memoryId: proposal.memoryId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    filed,
    failed: failures.length,
    total: toFile.length,
    skippedAsDuplicate,
    failures,
    inputs,
  };
}

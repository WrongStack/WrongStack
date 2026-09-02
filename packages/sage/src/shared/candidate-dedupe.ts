/**
 * Dedupe triage proposals against already-pending hygiene/review candidates
 * so the same memory is not proposed twice for human review.
 */

export interface PendingCandidateTarget {
  status: string;
  targetMemoryId?: string | undefined;
}

/**
 * Drop proposals whose `memoryId` already has a pending candidate
 * with a matching `targetMemoryId`.
 */
export function filterProposalsAgainstPendingTargets<T extends { memoryId: string }>(
  proposals: readonly T[],
  pending: readonly PendingCandidateTarget[],
): T[] {
  const pendingTargets = new Set(
    pending
      .filter(
        (c) => c.status === 'pending' && typeof c.targetMemoryId === 'string' && c.targetMemoryId,
      )
      .map((c) => c.targetMemoryId as string),
  );
  if (pendingTargets.size === 0) return [...proposals];
  return proposals.filter((p) => !pendingTargets.has(p.memoryId));
}

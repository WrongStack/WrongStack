import type { MemoryCandidate, Sage } from '../types.js';
import { consolidationHoldReasons } from './review-hold.js';

/** A consolidation proposal nobody rejected within this window is applied. */
const CONSOLIDATION_AUTO_ACCEPT_MS = 7 * 86_400_000;

export interface ConsolidationAutoAcceptStore {
  listCandidates(includeResolved?: boolean): Promise<MemoryCandidate[]>;
  acceptCandidate(candidateId: string): Promise<Sage | undefined>;
}

/**
 * Apply pending consolidation proposals older than `windowMs`. The window is
 * the review period: rejecting a proposal inside it keeps the members as they
 * are. Acceptance only supersedes members (reversible) and re-checks each
 * member's revision, so a member edited since distillation is left alone.
 * A lesson that reads like an instruction to the agent is held for a person
 * (see review-hold.ts). Runs in the store owner with no model call.
 */
export async function acceptDueConsolidations(
  store: ConsolidationAutoAcceptStore,
  nowMs: number,
  windowMs = CONSOLIDATION_AUTO_ACCEPT_MS,
): Promise<{ accepted: string[]; failed: number; held: number }> {
  const safeNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const safeWindowMs =
    typeof windowMs === 'number' && Number.isFinite(windowMs) && windowMs >= 0
      ? windowMs
      : CONSOLIDATION_AUTO_ACCEPT_MS;
  const accepted: string[] = [];
  let failed = 0;
  let held = 0;
  for (const candidate of await store.listCandidates(false)) {
    if (candidate.suggestedAction !== 'consolidate') continue;
    const createdAt = Date.parse(candidate.createdAt);
    if (!Number.isFinite(createdAt) || safeNowMs - createdAt < safeWindowMs) continue;
    // Reads like an instruction to the agent: a person decides.
    if (consolidationHoldReasons(candidate.text).length > 0) {
      held++;
      continue;
    }
    try {
      if (await store.acceptCandidate(candidate.id)) accepted.push(candidate.id);
    } catch {
      // A lesson that no longer validates stays pending for a person.
      failed++;
    }
  }
  return { accepted, failed, held };
}

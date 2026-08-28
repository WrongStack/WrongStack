/**
 * Shared session-consolidation logic.
 *
 * Both `SageStore` (legacy, removed) and `SqliteSageStore` (SQLite)
 * implement the same `consolidateSession()` flow: build a dedup set of
 * canonical memory texts from existing project memories and pending
 * candidates, then iterate session facts — creating candidates and
 * auto-accepting those above a policy score threshold.
 *
 * This module extracts that orchestration so the two store classes
 * differ only in how they fetch the dedup set (in-memory load vs. SQL
 * query) while sharing the loop, scoring, and result-accounting logic.
 */

import { canonicalMemoryText, clamp01, normalizeText } from '../store-helpers.js';
import type {
  CreateCandidateInput,
  MemoryCandidate,
  SessionConsolidationInput,
  SessionConsolidationResult,
  Sage,
} from '../types.js';

// ─── Services interface ─────────────────────────────────────────────────

/**
 * Persistence operations that a concrete store must provide for
 * session consolidation to work. Each store implements these through
 * its own backend (JSONL append, SQLite INSERT, etc.).
 */
interface ConsolidationServices {
  /** Create a new review candidate from the given input. */
  createCandidate(input: CreateCandidateInput): Promise<MemoryCandidate>;
  /** Promote a pending candidate to a full memory record. */
  acceptCandidate(candidateId: string): Promise<Sage | undefined>;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function buildCandidateInput(fact: SessionConsolidationInput['facts'][number], sessionId: string) {
  return {
    text: fact.text,
    kind: fact.kind,
    confidence: fact.confidence,
    importance: fact.importance,
    tags: fact.tags,
    anchors: fact.anchors,
    sources: [{ type: 'session' as const, sessionId }],
  };
}

// ─── Core consolidation ─────────────────────────────────────────────────

/**
 * Run the shared session-consolidation loop.
 *
 * @param services  - Persistence callbacks (create + accept).
 * @param initialDedupSet  - Snapshot of canonical text keys for
 *                           existing project memories (active + stale).
 *                           Defensively copied; the caller's set is not mutated.
 * @param input     - The session facts and options.
 */
export async function consolidateSession(
  services: ConsolidationServices,
  initialDedupSet: Set<string>,
  input: SessionConsolidationInput,
): Promise<SessionConsolidationResult> {
  const result: SessionConsolidationResult = {
    candidates: 0,
    accepted: 0,
    rejected: 0,
    duplicate: 0,
  };

  const existing = new Set(initialDedupSet);
  const threshold = clamp01(input.autoAcceptThreshold ?? 0.85);

  for (const fact of input.facts) {
    const text = normalizeText(fact.text);
    const key = canonicalMemoryText(text);
    if (!text || existing.has(key)) {
      result.duplicate++;
      continue;
    }

    let candidate: MemoryCandidate;
    try {
      candidate = await services.createCandidate(buildCandidateInput(fact, input.sessionId));
    } catch {
      result.rejected++;
      continue;
    }

    result.candidates++;
    existing.add(key);

    const policyScore = candidate.confidence * 0.55 + candidate.importance * 0.45;
    if (policyScore >= threshold) {
      await services.acceptCandidate(candidate.id);
      result.accepted++;
    }
  }

  return result;
}

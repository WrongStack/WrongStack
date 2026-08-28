/**
 * Shared candidate lifecycle helpers.
 *
 * Both `SageStore` (legacy, removed) and `SqliteSageStore`
 * (SQLite) independently duplicated:
 *
 * 1. The `rejectIfUnsafeInput` guard that prevents secrets/credentials
 *    from entering the review queue.
 * 2. The `resolveCandidate` decision-policy logic (what to do when a
 *    review candidate is resolved with `delete` / `archive` / `keep`).
 *
 * This module consolidates the policy layer while leaving the
 * persistence and concurrency details (file locks vs. SQL transactions)
 * in each store.
 */

import { collectStringValues, looksLikeSecret, normalizeText } from '../store-helpers.js';
import type {
  CandidateDecision,
  MemoryCandidate,
  MemoryCandidateResolution,
  Sage,
} from '../types.js';
import { DEFAULT_PERSISTENCE } from '../types.js';

// ─── Secret guard ───────────────────────────────────────────────────────

/**
 * Reject input that looks like a secret or credential.
 * Shared by both stores so every persistence path (direct memories
 * and review candidates) uses the same guard.
 *
 * @throws {Error} when any string value in `input` matches a secret pattern.
 */
export function rejectIfUnsafeInput(input: unknown): void {
  for (const value of collectStringValues(input)) {
    if (looksLikeSecret(value)) {
      throw new Error('SAGE refused to store text that looks like a secret or credential.');
    }
  }
}

// ─── Resolution policy ──────────────────────────────────────────────────

/**
 * Describes what mutation a resolution decision calls for.
 * The store is responsible for executing the mutation (and
 * handling its own locking / transaction model).
 */
interface ResolutionMutation {
  readonly kind: 'delete_memory' | 'archive_memory' | 'noop';
  readonly targetId: string | undefined;
  readonly applied: boolean;
}

/**
 * Outcome of the resolution check, returned to the caller for
 * persistence + audit.
 */
interface ResolutionDecision {
  readonly resolution: MemoryCandidateResolution;
  /** What the store should do (if anything). */
  readonly mutation: ResolutionMutation;
  /** Normalised audit reason string. */
  readonly reason: string;
  /** The candidate status to persist: 'accepted' or 'rejected'. */
  readonly candidateStatus: 'accepted' | 'rejected';
}

/**
 * Resolve the target memory id from a candidate snapshot.
 *
 * Trust boundary: the target id must come ONLY from the explicit
 * `targetMemoryId` field on the candidate. Tags are user-supplied free
 * text — the previous fallback that parsed `source:<id>` from candidate
 * tags let any caller silently retarget a resolution by including the
 * tag in their `memory_candidates({ action: 'propose', memory_id: X })`
 * call (which used to write `source:${memory_id}` into the tag list). The
 * fallback is removed AND the tag channel is fully retired (E1, 2026-08-02):
 * no producer writes `source:`/`review:`/`suggested:` prefixes anymore —
 * `targetMemoryId`, `reviewReason`, and `suggestedAction` are the sole,
 * typed channels. `targetMemoryId` is the single resolution source.
 */
export function resolveTargetId(candidate: MemoryCandidate): string | undefined {
  return candidate.targetMemoryId;
}

/**
 * Canonical policy for resolving a review candidate.
 *
 * Determines whether the target memory should be deleted, archived,
 * or left untouched based on the candidate's `targetMemoryId` and
 * the requested `decision`.
 *
 * This is a **pure policy function** — it does not mutate anything.
 * The caller (each store's `resolveCandidate`) inspects the returned
 * `ResolutionMutation.kind` and executes the appropriate persistence
 * operation under its own locking/transaction model.
 *
 * Rules:
 * - `delete` + `targetId` + `permanent` → mutation = noop (applied = false)
 * - `delete` + `targetId` + not permanent + target found → mutation = delete (applied = true)
 * - `delete`/`archive` + `targetId` + target not found (race-deleted) → mutation = noop (applied = false)
 * - `archive` + `targetId` + target found → mutation = archive (applied = true)
 * - `keep` → mutation = noop (applied = true)
 * - no `targetId` + `delete`/`archive` → mutation = noop (applied = false)
 *
 * @param snapshot   - The candidate as read from persistence (must be pending).
 * @param decision   - The decision from the resolver.
 * @param reason     - Optional user-supplied reason.
 * @param target     - The target memory record (null if missing/deleted).
 * @returns A description of what the store should persist.
 */
export function computeResolution(
  snapshot: MemoryCandidate,
  decision: CandidateDecision,
  reason: string | undefined,
  target: Sage | null,
): ResolutionDecision {
  const targetId = resolveTargetId(snapshot);

  const isPermanent =
    target !== null && (target.persistence ?? DEFAULT_PERSISTENCE) === 'permanent';

  // Normalise the reason string here so all callers (JSONL store, SQLite store)
  // persist the same canonical form — prevents divergence between candidate
  // records and audit entries when one caller normalises and another forgets.
  const resolutionNote = normalizeText(
    reason ??
      (snapshot.reviewReason
        ? `Review resolve (${snapshot.reviewReason})`
        : decision === 'keep'
          ? 'Reviewed: keep'
          : `Reviewed: ${decision}`),
  );

  // ── Determine the action ─────────────────────────────────────────
  let mutationKind: 'delete_memory' | 'archive_memory' | 'noop';
  let applied: boolean;

  if (decision === 'delete' && targetId && !isPermanent) {
    // Delete is allowed for non-permanent — even if target was race-deleted
    // (target === null), the store's try/catch will handle the error.
    mutationKind = 'delete_memory';
    applied = target !== null;
  } else if (decision === 'archive' && targetId) {
    // Archive is always allowed — even if target is race-deleted, the
    // store's try/catch will handle the error.
    mutationKind = 'archive_memory';
    applied = target !== null;
  } else if (decision === 'keep') {
    mutationKind = 'noop';
    applied = true; // Nothing to mutate — the memory is kept as-is.
  } else {
    mutationKind = 'noop';
    applied = false;
  }

  return {
    resolution: {
      candidateId: snapshot.id,
      decision,
      ...(targetId ? { targetMemoryId: targetId } : {}),
      applied,
    },
    mutation: {
      kind: mutationKind,
      targetId,
      applied,
    },
    reason: resolutionNote,
    candidateStatus: decision === 'keep' ? 'rejected' : 'accepted',
  };
}

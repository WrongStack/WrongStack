import type { DatabaseSync } from 'node:sqlite';
import { ulid, withFileLock } from '@wrongstack/core/utils';
import {
  computeResolution,
  rejectIfUnsafeInput,
  resolveTargetId,
} from './shared/candidate-lifecycle.js';
import { normalizeValidity, validityKey } from './shared/memory-validity.js';
import {
  readSqliteSageRow,
  sqliteRowToCandidate,
  sqliteRowToMemory,
} from './sqlite-store-codec.js';
import {
  clamp01,
  normalizeAnchors,
  normalizeAudience,
  normalizeSources,
  normalizeTags,
  normalizeText,
  normalizeTextKey,
  validateRememberInput,
} from './store-helpers.js';
import type {
  CandidateDecision,
  CreateCandidateInput,
  MemoryCandidate,
  MemoryCandidateResolution,
  Sage,
  UpdateSageInput,
} from './types.js';
import { SAGE_SCHEMA_VERSION } from './types.js';

interface SqliteCandidateContext {
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>;
  upsertCandidate: (candidate: MemoryCandidate, canonicalText?: string) => void;
}

interface SqliteRejectCandidateContext extends SqliteCandidateContext {
  nowIso: () => string;
  audit: (event: string, data?: Record<string, unknown>) => void;
}

interface SqliteResolveCandidateContext extends SqliteRejectCandidateContext {
  runMutation: <T>(work: () => T) => Promise<T>;
  updateSage: (id: string, input: UpdateSageInput) => Promise<Sage>;
}

export interface SqliteCreateCandidateContext extends SqliteRejectCandidateContext {
  projectRoot: string;
  runMutation: <T>(work: () => T) => Promise<T>;
}

interface SqliteAcceptCandidateContext extends SqliteRejectCandidateContext {
  candidateLockPath: (candidateId: string) => string;
  runMutation: <T>(work: () => T) => Promise<T>;
  rememberSage: (input: {
    text: string;
    kind: MemoryCandidate['kind'];
    scope: MemoryCandidate['scope'];
    ownerSessionId?: string | undefined;
    confidence: number;
    importance: number;
    tags: MemoryCandidate['tags'];
    anchors: MemoryCandidate['anchors'];
    audience?: MemoryCandidate['audience'];
    sources: MemoryCandidate['sources'];
    validity?: MemoryCandidate['validity'];
  }) => Promise<Sage>;
  /** Retires consolidation members; absent on hosts that cannot update. */
  updateSage?: (id: string, input: UpdateSageInput) => Promise<Sage>;
}

export function addSqliteCandidate(ctx: SqliteCandidateContext, candidate: MemoryCandidate): void {
  rejectIfUnsafeInput(candidate);
  ctx.upsertCandidate(candidate);
}

export function listSqliteCandidates(
  ctx: Pick<SqliteCandidateContext, 'stmt'>,
  includeResolved = false,
): MemoryCandidate[] {
  const sql = includeResolved
    ? 'SELECT data FROM candidates ORDER BY updated_at DESC'
    : "SELECT data FROM candidates WHERE status = 'pending' ORDER BY updated_at DESC";
  const rows = ctx.stmt(sql).all() as Array<{ data: string }>;
  // One corrupt row must not hide the whole review queue.
  const candidates: MemoryCandidate[] = [];
  for (const row of rows) {
    try {
      candidates.push(sqliteRowToCandidate(row));
    } catch {
      // Skip corrupt rows, like createSqliteCandidate's dedupe scan.
    }
  }
  return candidates;
}

export function createSqliteCandidate(
  ctx: SqliteCreateCandidateContext,
  input: CreateCandidateInput,
): Promise<MemoryCandidate> {
  rejectIfUnsafeInput(input);
  validateRememberInput(input);
  if (
    input.targetRevision !== undefined &&
    (!input.targetMemoryId ||
      !Number.isSafeInteger(input.targetRevision) ||
      input.targetRevision < 1)
  ) {
    throw new Error(
      'SAGE targetRevision requires a targetMemoryId and a positive integer revision.',
    );
  }
  const supersedes = validateSupersedes(input);
  const text = normalizeText(input.text);
  if (!text) throw new Error('SAGE candidate text must not be empty.');
  const scope = input.scope ?? 'project';
  const ownerSessionId = scope === 'session' ? input.ownerSessionId?.trim() : undefined;
  const key = normalizeTextKey(text);
  return ctx.runMutation(() => {
    const rows = ctx
      .stmt(
        `SELECT data FROM candidates
         WHERE status = 'pending' AND canonical_text = ?
         ORDER BY created_at DESC`,
      )
      .all(key) as Array<{ data: string }>;
    for (const row of rows) {
      try {
        const existing = sqliteRowToCandidate(row);
        if (
          existing.scope === scope &&
          existing.ownerSessionId === ownerSessionId &&
          existing.targetMemoryId === input.targetMemoryId &&
          existing.targetRevision === input.targetRevision &&
          validityKey(existing.validity) === validityKey(input.validity)
        ) {
          return existing;
        }
      } catch {
        // Skip corrupt rows.
      }
    }
    const now = ctx.nowIso();
    const audience = normalizeAudience(input.audience);
    const candidate: MemoryCandidate = {
      schemaVersion: SAGE_SCHEMA_VERSION,
      id: `candidate_${ulid()}`,
      status: 'pending',
      text,
      kind: input.kind ?? 'fact',
      scope,
      ...(ownerSessionId ? { ownerSessionId } : {}),
      confidence: clamp01(input.confidence ?? 0.6),
      importance: clamp01(input.importance ?? 0.6),
      tags: normalizeTags(input.tags),
      anchors: normalizeAnchors(ctx.projectRoot, input.anchors ?? []),
      ...(audience ? { audience } : {}),
      sources: normalizeSources(input.sources ?? [{ type: 'session' }]),
      ...(input.validity ? { validity: normalizeValidity(input.validity) } : {}),
      createdAt: now,
      updatedAt: now,
      ...(input.targetMemoryId ? { targetMemoryId: input.targetMemoryId } : {}),
      ...(input.targetRevision !== undefined ? { targetRevision: input.targetRevision } : {}),
      ...(input.reviewReason ? { reviewReason: input.reviewReason } : {}),
      ...(input.suggestedAction ? { suggestedAction: input.suggestedAction } : {}),
      ...(supersedes
        ? { supersedesMemoryIds: supersedes.ids, supersedesRevisions: supersedes.revisions }
        : {}),
    };
    ctx.upsertCandidate(candidate, key);
    ctx.audit('memory.candidate_created', { details: { candidateId: candidate.id } });
    return candidate;
  });
}

const MAX_SUPERSEDED_MEMBERS = 50;

function validateSupersedes(
  input: CreateCandidateInput,
): { ids: string[]; revisions: number[] } | undefined {
  const ids = input.supersedesMemoryIds;
  const revisions = input.supersedesRevisions;
  if (ids === undefined && revisions === undefined) return undefined;
  if (
    !Array.isArray(ids) ||
    !Array.isArray(revisions) ||
    ids.length === 0 ||
    ids.length !== revisions.length ||
    ids.length > MAX_SUPERSEDED_MEMBERS ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => typeof id !== 'string' || !id || id.length > 200) ||
    revisions.some((revision) => !Number.isSafeInteger(revision) || revision < 1)
  ) {
    throw new Error(
      `SAGE supersedesMemoryIds needs 1-${MAX_SUPERSEDED_MEMBERS} distinct ids with one positive integer revision each.`,
    );
  }
  return { ids: [...ids], revisions: [...revisions] };
}

/**
 * Retire the members a consolidation proposal replaces. A member is only
 * superseded while it is still active at the revision that was distilled: one
 * edited, retired or deleted since keeps its own lifecycle.
 */
async function retireConsolidatedMembers(
  ctx: SqliteAcceptCandidateContext,
  candidate: MemoryCandidate,
  keeperId: string,
): Promise<string[]> {
  const ids = candidate.supersedesMemoryIds ?? [];
  const revisions = candidate.supersedesRevisions ?? [];
  if (!ctx.updateSage || ids.length === 0 || ids.length !== revisions.length) return [];
  const retired: string[] = [];
  for (const [index, id] of ids.entries()) {
    if (id === keeperId) continue;
    const current = readSqliteSageRow(ctx.stmt, id);
    if (current?.status !== 'active' || current.revision !== revisions[index]) continue;
    try {
      await ctx.updateSage(id, {
        status: 'superseded',
        supersededBy: keeperId,
        expectedRevision: current.revision,
      });
      retired.push(id);
    } catch {
      // A concurrent edit won the revision race: that member stays as it is.
    }
  }
  return retired;
}

export function acceptSqliteCandidate(
  ctx: SqliteAcceptCandidateContext,
  candidateId: string,
): Promise<Sage | undefined> {
  return withFileLock(
    ctx.candidateLockPath(candidateId),
    async () => {
      const snapshot = ctx.runMutation(() => {
        const row = ctx
          .stmt("SELECT data FROM candidates WHERE id = ? AND status = 'pending'")
          .get(candidateId) as { data: string } | undefined;
        if (!row) return undefined;
        return sqliteRowToCandidate(row);
      });
      const candidate = await snapshot;
      if (!candidate) return undefined;

      // A review proposal (hygiene, triage, `memory_candidates propose`)
      // carries its TARGET memory's text. Accepting it re-remembered that
      // text as a `memory_review` record, which exact-matched and merged into
      // the target — stapling review tags such as `persistence:long_lived`
      // onto the very memory under review. Proposals are decided, not
      // accepted.
      if (candidate.kind === 'memory_review') {
        throw new Error(
          `Memory candidate "${candidateId}" is a review proposal` +
            (candidate.targetMemoryId ? ` for memory ${candidate.targetMemoryId}` : '') +
            '; resolve it with a decision (delete, archive or keep) instead of accepting it.',
        );
      }

      // Claim BEFORE writing the memory. The old order wrote first and
      // claimed second, so a concurrent resolve/reject that won the claim
      // left an orphaned memory behind (only logged). The file lock covers
      // accept-vs-accept; resolve does not take it, the claim covers both.
      const claimedAt = ctx.nowIso();
      const claimed = await ctx.runMutation(() => {
        const result = ctx
          .stmt(
            "UPDATE candidates SET data = ?, status = 'accepted', updated_at = ? WHERE id = ? AND status = 'pending'",
          )
          .run(
            JSON.stringify({ ...candidate, status: 'accepted', updatedAt: claimedAt }),
            claimedAt,
            candidateId,
          );
        return result.changes > 0;
      });
      if (!claimed) return undefined;

      let memory: Sage;
      try {
        memory = await ctx.rememberSage({
          text: candidate.text,
          kind: candidate.kind,
          scope: candidate.scope,
          ...(candidate.ownerSessionId ? { ownerSessionId: candidate.ownerSessionId } : {}),
          confidence: candidate.confidence,
          importance: candidate.importance,
          tags: candidate.tags,
          anchors: candidate.anchors,
          audience: candidate.audience,
          sources: candidate.sources,
          validity: candidate.validity,
        });
      } catch (error) {
        // The write failed (validation, secret guard, store error): release
        // the claim so the candidate stays reviewable instead of reading as
        // accepted with no memory behind it.
        await ctx.runMutation(() =>
          ctx
            .stmt(
              "UPDATE candidates SET data = ?, status = 'pending', updated_at = ? WHERE id = ? AND status = 'accepted'",
            )
            .run(JSON.stringify(candidate), ctx.nowIso(), candidateId),
        );
        throw error;
      }

      await ctx.runMutation(() =>
        ctx.stmt('UPDATE candidates SET data = ?, updated_at = ? WHERE id = ?').run(
          JSON.stringify({
            ...candidate,
            status: 'accepted',
            memoryId: memory.id,
            updatedAt: ctx.nowIso(),
          }),
          ctx.nowIso(),
          candidateId,
        ),
      );
      const retired = await retireConsolidatedMembers(ctx, candidate, memory.id);
      ctx.audit('memory.candidate_accepted', {
        memoryId: memory.id,
        details: { candidateId, ...(retired.length > 0 ? { superseded: retired } : {}) },
      });
      return memory;
    },
    {
      timeoutMs: 60_000,
      staleMs: 30 * 60_000,
    },
  );
}

export function rejectSqliteCandidate(
  ctx: SqliteRejectCandidateContext,
  candidateId: string,
  reason: string,
): boolean {
  const row = ctx
    .stmt("SELECT data FROM candidates WHERE id = ? AND status = 'pending'")
    .get(candidateId) as { data: string } | undefined;
  if (!row) return false;
  const candidate = sqliteRowToCandidate(row);
  const updated: MemoryCandidate = {
    ...candidate,
    status: 'rejected',
    reason: normalizeText(reason),
    updatedAt: ctx.nowIso(),
  };
  // Claim-guarded CAS, matching the pending predicate accept's claim and
  // resolve's claim both use. This write used to be a plain INSERT OR REPLACE
  // upsert: a reject whose SELECT predates a concurrent accept's claim
  // overwrote the accepted candidate (with its memoryId link) as 'rejected'.
  // With the CAS, the loser of the race changes nothing and reports false.
  const claimed = ctx
    .stmt(
      "UPDATE candidates SET data = ?, status = 'rejected', updated_at = ? WHERE id = ? AND status = 'pending'",
    )
    .run(JSON.stringify(updated), updated.updatedAt, candidateId);
  if (claimed.changes === 0) return false;
  ctx.audit('memory.candidate_rejected', { reason, details: { candidateId } });
  return true;
}

export async function resolveSqliteCandidate(
  ctx: SqliteResolveCandidateContext,
  candidateId: string,
  decision: CandidateDecision,
  reason?: string,
): Promise<MemoryCandidateResolution | undefined> {
  const snapshot = await ctx.runMutation(() => {
    const row = ctx
      .stmt("SELECT data FROM candidates WHERE id = ? AND status = 'pending'")
      .get(candidateId) as { data: string } | undefined;
    return row ? sqliteRowToCandidate(row) : undefined;
  });
  if (!snapshot) {
    const existing = await ctx.runMutation(() => {
      const row = ctx.stmt('SELECT data FROM candidates WHERE id = ?').get(candidateId) as
        | { data: string }
        | undefined;
      return row ? sqliteRowToCandidate(row) : undefined;
    });
    if (!existing) return undefined;
    const anyTargetId = resolveTargetId(existing);
    return {
      candidateId,
      decision,
      applied: false,
      alreadyResolved: true,
      ...(anyTargetId ? { targetMemoryId: anyTargetId } : {}),
    };
  }

  const targetId = resolveTargetId(snapshot);
  const target: Sage | null = targetId
    ? await ctx.runMutation(() => readSqliteSageRow(ctx.stmt, targetId))
    : null;
  const policy = computeResolution(snapshot, decision, reason, target ?? null);

  // Claim the candidate, then perform the target mutation. If the mutation
  // fails, revert the candidate back to 'pending' so a retry can attempt
  // the resolution again instead of returning alreadyResolved.
  let applied = false;
  let claimed = false;
  let mutationError: string | undefined;
  try {
    claimed = await ctx.runMutation(() => {
      const updated: MemoryCandidate = {
        ...snapshot,
        status: policy.candidateStatus,
        reason: policy.reason,
        updatedAt: ctx.nowIso(),
      };
      const result = ctx
        .stmt(
          "UPDATE candidates SET data = ?, status = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
        )
        .run(JSON.stringify(updated), updated.status, updated.updatedAt, candidateId);
      return result.changes > 0;
    });
    if (!claimed) {
      const failTargetId = resolveTargetId(snapshot);
      return {
        candidateId,
        decision,
        applied: false,
        alreadyResolved: true,
        ...(failTargetId ? { targetMemoryId: failTargetId } : {}),
      };
    }

    // Perform the target mutation. If it fails, revert the candidate to
    // 'pending' so the caller can retry the same decision.
    if (policy.mutation.kind === 'delete_memory' && policy.mutation.targetId) {
      try {
        // Candidate-resolved deletes go through in-process `ctx.updateSage`,
        // not over IPC, so the IPC force gate does not apply. They pass
        // `deleteAuthorized: true` — NOT `force: true`: the resolution is an
        // authorized internal operation for non-permanent targets, but the
        // update-layer permanent-persistence guard must stay armed so a
        // target promoted to 'permanent' between the review snapshot and
        // this mutation survives (SAGE permanent-memory invariant; matches
        // the two-path contract documented in project-server.ts).
        await ctx.updateSage(policy.mutation.targetId, {
          status: 'deleted',
          deleteAuthorized: true,
          ...(snapshot.targetRevision !== undefined
            ? { expectedRevision: snapshot.targetRevision }
            : {}),
        });
        applied = true;
      } catch (err) {
        mutationError = err instanceof Error ? err.message : String(err);
        applied = false;
      }
    } else if (policy.mutation.kind === 'archive_memory' && policy.mutation.targetId) {
      try {
        await ctx.updateSage(policy.mutation.targetId, {
          status: 'archived',
          ...(snapshot.targetRevision !== undefined
            ? { expectedRevision: snapshot.targetRevision }
            : {}),
        });
        applied = true;
      } catch (err) {
        mutationError = err instanceof Error ? err.message : String(err);
        applied = false;
      }
    } else if (decision === 'keep') {
      applied = true;
    }
  } catch (outerErr) {
    mutationError = outerErr instanceof Error ? outerErr.message : String(outerErr);
    applied = false;
  }

  // If the target mutation failed (threw an exception), revert the candidate
  // to 'pending' so the caller can retry. Do NOT revert for by-design noops
  // where applied is false without an error (e.g. permanent target, keep
  // decision, mutation without targetId) — those are intentional terminal
  // states, not retryable failures.
  if (claimed && !applied && mutationError !== undefined) {
    const reverted = await ctx.runMutation(() => {
      const revertResult = ctx
        .stmt(
          "UPDATE candidates SET data = ?, status = 'pending', updated_at = ? WHERE id = ? AND status = ?",
        )
        .run(JSON.stringify({ ...snapshot }), ctx.nowIso(), candidateId, policy.candidateStatus);
      return revertResult.changes > 0;
    });
    if (reverted) {
      ctx.audit('memory.candidate_resolution_reverted', {
        ...(targetId ? { memoryId: targetId } : {}),
        reason: policy.reason,
        details: { candidateId, decision, mutationError },
      });
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'sage.candidate_resolution_reverted',
          candidateId,
          message: `Target mutation failed; candidate reverted to pending for retry. Error: ${mutationError}`,
          timestamp: ctx.nowIso(),
        }),
      );
    }
    return {
      candidateId,
      decision,
      applied: false,
      ...(targetId ? { targetMemoryId: targetId } : {}),
      ...(mutationError ? { error: mutationError } : {}),
    };
  }

  ctx.audit('memory.candidate_resolved', {
    ...(policy.mutation.targetId ? { memoryId: policy.mutation.targetId } : {}),
    reason: policy.reason,
    details: { candidateId, decision, applied },
  });
  return {
    candidateId,
    decision,
    ...(policy.mutation.targetId ? { targetMemoryId: policy.mutation.targetId } : {}),
    applied,
  };
}

// ─── H2 accepted-candidate reconciliation (docs/archive/plans/sage-phase4-design.md) ──

export interface SqliteReconcileContext {
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>;
  nowIso: () => string;
  audit: (event: string, data?: Record<string, unknown>) => void;
}

export interface CandidateReconciliationResult {
  /** Candidates re-linked to the active memory the crashed accept wrote. */
  relinked: number;
  /** Candidates released back to `pending` (no matching active memory). */
  released: number;
  /** Candidates inside the grace window — left for the next sweep. */
  skipped: number;
}

/** Skip candidates accepted more recently than this. */
export const RECONCILE_GRACE_MS = 60_000;

/**
 * Reconcile candidates the accept flow left `accepted` without a `memoryId`.
 *
 * `acceptSqliteCandidate` writes the claim and the target memory in separate
 * transactions (the target write goes through `rememberSage`'s secret guard,
 * canonical dedupe, and FTS sync). A hard crash between the two leaves the
 * candidate `accepted` with no `memoryId`, and the claim CAS makes re-accept a
 * no-op — the memory exists but nothing links it. This sweep closes that
 * window: it re-links the candidate to the ACTIVE memory with the same
 * canonical text, or — when no such memory exists — releases it back to
 * `pending` so it becomes reviewable again. Never deletes anything.
 *
 * Runs once per store initialize (after schema init). Candidates accepted
 * within `graceMs` of now are skipped so a live accept in a concurrent
 * store opener is not preempted mid-write.
 */
export function reconcileAcceptedCandidates(
  ctx: SqliteReconcileContext,
  graceMs = RECONCILE_GRACE_MS,
): CandidateReconciliationResult {
  const nowMs = Date.parse(ctx.nowIso());
  const result: CandidateReconciliationResult = { relinked: 0, released: 0, skipped: 0 };
  const rows = ctx
    .stmt("SELECT data, canonical_text FROM candidates WHERE status = 'accepted'")
    .all() as Array<{ data: string; canonical_text: string | null }>;
  for (const row of rows) {
    let candidate: MemoryCandidate;
    try {
      candidate = sqliteRowToCandidate(row);
    } catch {
      continue; // Skip corrupt rows, like every other candidate scan.
    }
    if (candidate.memoryId) continue; // Fully annotated — nothing to reconcile.
    const acceptedAtMs = Date.parse(candidate.updatedAt);
    // Only a candidate genuinely INSIDE the recency window is skipped. An
    // unparseable/missing `updatedAt` (a legacy-imported epoch or hand-edited
    // row — `sqliteRowToCandidate` is an unvalidated `JSON.parse` cast) can
    // never satisfy this test, so folding it in with `||` skipped such a
    // candidate on EVERY sweep, forever: it stayed `accepted` with no
    // `memoryId`, and `listSqliteCandidates` (status = 'pending') hid it, so it
    // was permanently unreviewable — the exact outcome this sweep exists to
    // prevent. It is also safe to fall through: a live in-flight accept always
    // stamps `nowIso()`, so only a parseable-and-recent candidate can be one.
    if (Number.isFinite(acceptedAtMs) && nowMs - acceptedAtMs < graceMs) {
      result.skipped++;
      continue;
    }
    // Match the full identity the accept flow would have created. Canonical
    // text alone is not sufficient: identical text can legitimately exist in
    // another scope/kind/audience/session/validity, and relinking to that row
    // would attribute the candidate to a memory it could not have produced.
    const ownerSessionKey =
      candidate.scope === 'session' ? candidate.ownerSessionId?.trim() || null : null;
    const candidateValidityKey = validityKey(normalizeValidity(candidate.validity));
    const memoryRows = ctx
      .stmt(
        `SELECT id, data FROM memories
         WHERE canonical_text = ? AND status = 'active'
           AND scope = ? AND kind = ? AND audience IS ?
           AND owner_session_id IS ?
         ORDER BY updated_at DESC`,
      )
      .all(
        normalizeTextKey(candidate.text),
        candidate.scope,
        candidate.kind,
        candidate.audience ? JSON.stringify(candidate.audience) : null,
        ownerSessionKey,
      ) as Array<{ id: string; data: string }>;
    let memory: { id: string } | undefined;
    for (const memRow of memoryRows) {
      try {
        const decoded = sqliteRowToMemory(memRow);
        if (validityKey(decoded.validity) === candidateValidityKey) {
          memory = { id: decoded.id };
          break;
        }
      } catch {}
    }
    const stamp = ctx.nowIso();
    if (memory) {
      const annotated: MemoryCandidate = { ...candidate, memoryId: memory.id, updatedAt: stamp };
      ctx
        .stmt("UPDATE candidates SET data = ?, updated_at = ? WHERE id = ? AND status = 'accepted'")
        .run(JSON.stringify(annotated), stamp, candidate.id);
      result.relinked++;
      ctx.audit('memory.candidate_accept_reconciled', {
        memoryId: memory.id,
        details: { candidateId: candidate.id, outcome: 'relinked' },
      });
      continue;
    }
    const released: MemoryCandidate = { ...candidate, status: 'pending', updatedAt: stamp };
    ctx
      .stmt(
        "UPDATE candidates SET data = ?, status = 'pending', updated_at = ? WHERE id = ? AND status = 'accepted'",
      )
      .run(JSON.stringify(released), stamp, candidate.id);
    result.released++;
    ctx.audit('memory.candidate_accept_reconciled', {
      details: { candidateId: candidate.id, outcome: 'released' },
    });
  }
  return result;
}

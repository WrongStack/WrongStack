import type { DatabaseSync } from 'node:sqlite';
import { ulid, withFileLock } from '@wrongstack/core/utils';
import {
  computeResolution,
  rejectIfUnsafeInput,
  resolveTargetId,
} from './shared/candidate-lifecycle.js';
import { readSqliteSageRow, sqliteRowToCandidate } from './sqlite-store-codec.js';
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
    confidence: number;
    importance: number;
    tags: MemoryCandidate['tags'];
    anchors: MemoryCandidate['anchors'];
    audience?: MemoryCandidate['audience'];
    sources: MemoryCandidate['sources'];
  }) => Promise<Sage>;
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
  return rows.map((r) => sqliteRowToCandidate(r));
}

export function createSqliteCandidate(
  ctx: SqliteCreateCandidateContext,
  input: CreateCandidateInput,
): Promise<MemoryCandidate> {
  rejectIfUnsafeInput(input);
  validateRememberInput(input);
  const text = normalizeText(input.text);
  if (!text) throw new Error('SAGE candidate text must not be empty.');
  const scope = input.scope ?? 'project';
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
        if (existing.scope === scope && existing.targetMemoryId === input.targetMemoryId) {
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
      confidence: clamp01(input.confidence ?? 0.6),
      importance: clamp01(input.importance ?? 0.6),
      tags: normalizeTags(input.tags),
      anchors: normalizeAnchors(ctx.projectRoot, input.anchors ?? []),
      ...(audience ? { audience } : {}),
      sources: normalizeSources(input.sources ?? [{ type: 'session' }]),
      createdAt: now,
      updatedAt: now,
      ...(input.targetMemoryId ? { targetMemoryId: input.targetMemoryId } : {}),
      ...(input.reviewReason ? { reviewReason: input.reviewReason } : {}),
      ...(input.suggestedAction ? { suggestedAction: input.suggestedAction } : {}),
    };
    ctx.upsertCandidate(candidate, key);
    ctx.audit('memory.candidate_created', { details: { candidateId: candidate.id } });
    return candidate;
  });
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

      const memory = await ctx.rememberSage({
        text: candidate.text,
        kind: candidate.kind,
        scope: candidate.scope,
        confidence: candidate.confidence,
        importance: candidate.importance,
        tags: candidate.tags,
        anchors: candidate.anchors,
        audience: candidate.audience,
        sources: candidate.sources,
      });

      // Mark candidate as accepted. The reclaim-UPDATE pattern ensures
      // atomicity: if a concurrent resolveCandidate already flipped the
      // status away from 'pending', this UPDATE matches 0 rows and we
      // log the orphaned memory for diagnostics instead of silently
      // leaving the candidate in a stale state.
      const accepted = await ctx.runMutation(() => {
        const result = ctx
          .stmt(
            "UPDATE candidates SET data = ?, status = 'accepted', updated_at = ? WHERE id = ? AND status = 'pending'",
          )
          .run(
            JSON.stringify({
              ...candidate,
              status: 'accepted',
              memoryId: memory.id,
              updatedAt: ctx.nowIso(),
            }),
            ctx.nowIso(),
            candidateId,
          );
        return result.changes > 0;
      });
      if (!accepted) {
        // A concurrent resolveCandidate raced us. The memory was already
        // created — log the orphan so an operator can reconcile.
        ctx.audit('memory.candidate_accept_orphaned', {
          memoryId: memory.id,
          details: { candidateId, reason: 'Candidate status was no longer pending during accept' },
        });
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'sage.candidate_accept_orphaned',
            candidateId,
            memoryId: memory.id,
            message:
              'Memory created but candidate was resolved concurrently; orphaned memory logged.',
            timestamp: ctx.nowIso(),
          }),
        );
      } else {
        ctx.audit('memory.candidate_accepted', {
          memoryId: memory.id,
          details: { candidateId },
        });
      }
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
  ctx.upsertCandidate(updated);
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
        });
        applied = true;
      } catch (err) {
        mutationError = err instanceof Error ? err.message : String(err);
        applied = false;
      }
    } else if (policy.mutation.kind === 'archive_memory' && policy.mutation.targetId) {
      try {
        await ctx.updateSage(policy.mutation.targetId, { status: 'archived' });
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

import type { DatabaseSync } from 'node:sqlite';

import { rejectIfUnsafeInput } from './shared/candidate-lifecycle.js';
import { readSqliteSageRow } from './sqlite-store-codec.js';
import { cleanReferencingMemories, memoryNodeId } from './sqlite-store-graph-helpers.js';
import {
  clamp01,
  normalizeAnchors,
  normalizeAudience,
  normalizeTags,
  normalizeText,
  VALID_KINDS,
} from './store-helpers.js';
import type { Sage, SageStatus, UpdateSageInput } from './types.js';
import { DEFAULT_PERSISTENCE, VALID_PERSISTENCE } from './types.js';

interface SqliteUpdateContext {
  projectRoot: string;
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>;
  nowIso: () => string;
  upsertMemory: (memory: Sage) => void;
  syncAnchorEdges: (memory: Sage) => void;
  cascadeDeleteEdges: (nodeId: string) => void;
  audit: (event: string, data?: Record<string, unknown>) => void;
  emitUpdated: (memory: Sage) => void;
  emitDeleted: (memory: Sage, reason: string, removedEdges: number) => void;
}

export function updateSqliteSage(
  ctx: SqliteUpdateContext,
  id: string,
  input: UpdateSageInput,
): Sage {
  rejectIfUnsafeInput(input);
  // Field-value validation mirrors validateRememberInput (store-helpers.ts):
  // unknown persistence/kind values are rejected instead of silently behaving
  // as a different class (an invalid persistence used to slip through and act
  // as non-permanent everywhere; an invalid kind would pollute byStatus and
  // byKind stats). `scope` is deliberately NOT part of UpdateSageInput — a
  // memory's scope and session ownership are immutable after creation
  // (change = delete+recreate).
  if (input.text !== undefined) {
    const normalizedText = normalizeText(input.text);
    if (!normalizedText) throw new Error('SAGE text must not be empty.');
    if (normalizedText.length < 4) {
      throw new Error('SAGE text is too short to be useful long-term memory.');
    }
  }
  if (input.persistence !== undefined && !VALID_PERSISTENCE.has(input.persistence)) {
    throw new Error(
      `SAGE persistence must be one of: ${[...VALID_PERSISTENCE].join(', ')}; got "${input.persistence}".`,
    );
  }
  if (input.kind !== undefined && !VALID_KINDS.has(input.kind)) {
    throw new Error(
      `SAGE kind must be one of: ${[...VALID_KINDS].join(', ')}; got "${input.kind}".`,
    );
  }
  const existing = readSqliteSageRow(ctx.stmt, id);
  if (!existing) throw new Error(`SAGE ${id} not found.`);
  if (input.status === 'deleted') {
    const permanentTarget =
      (existing.persistence ?? DEFAULT_PERSISTENCE) === 'permanent' ||
      input.persistence === 'permanent';
    const authorized = input.force === true || input.deleteAuthorized === true;
    if (!authorized) {
      if (permanentTarget) {
        throw new Error(
          `SAGE "${id}" is marked 'permanent' and cannot be deleted. ` +
            `Pass { force: true } to override; the override will be recorded in the audit log.`,
        );
      }
      throw new Error(
        `SAGE "${id}" cannot be deleted without explicit authorization. ` +
          `Pass { force: true } to the memory_delete tool. ` +
          `The force flag is recorded in the audit log.`,
      );
    }
    // Candidate-resolution time-of-check: the resolution policy was computed
    // from an earlier snapshot, while `existing` above is the fresh
    // in-mutation reread. An authorized-but-not-forced delete must still
    // refuse a target that is permanent NOW — a concurrent
    // promotion-to-permanent wins the race; only user-level `force: true`
    // overrides permanence.
    if (permanentTarget && input.force !== true) {
      throw new Error(
        `SAGE "${id}" was promoted to 'permanent'; an authorized candidate ` +
          `resolution cannot delete it. Re-review the candidate, or pass ` +
          `{ force: true } to override; the override will be recorded in the audit log.`,
      );
    }
  }
  const updated: Sage = {
    ...existing,
    ...(input.text !== undefined && { text: normalizeText(input.text) }),
    ...(input.persistence !== undefined && { persistence: input.persistence }),
    ...(input.kind !== undefined && { kind: input.kind }),
    ...(input.status !== undefined && { status: input.status as SageStatus }),
    ...(input.tags !== undefined && { tags: normalizeTags(input.tags) }),
    ...(input.anchors !== undefined && {
      anchors: normalizeAnchors(ctx.projectRoot, input.anchors),
    }),
    ...(input.importance !== undefined && { importance: clamp01(input.importance) }),
    ...(input.confidence !== undefined && { confidence: clamp01(input.confidence) }),
    ...(input.freshness !== undefined && { freshness: clamp01(input.freshness) }),
    ...(input.audience !== undefined && { audience: normalizeAudience(input.audience) }),
    ...(input.supersedes !== undefined && { supersedes: input.supersedes }),
    ...(input.contradicts !== undefined && { contradicts: input.contradicts }),
    revision: existing.revision + 1,
    updatedAt: ctx.nowIso(),
  };
  ctx.upsertMemory(updated);
  const statusAffectsAnchorEdges =
    input.status !== undefined &&
    existing.status !== updated.status &&
    updated.status !== 'deleted';
  if (
    updated.status !== 'deleted' &&
    (input.anchors !== undefined ||
      input.confidence !== undefined ||
      input.supersedes !== undefined ||
      input.contradicts !== undefined ||
      statusAffectsAnchorEdges)
  ) {
    ctx.syncAnchorEdges(updated);
  }
  ctx.emitUpdated(updated);
  if (existing.status !== 'deleted' && updated.status === 'deleted') {
    const nodeId = memoryNodeId(updated.id);
    cleanReferencingMemories(ctx, updated.id);
    const removedEdges = ctx
      .stmt(
        "SELECT COUNT(*) AS n FROM edges WHERE (from_node = ? OR to_node = ?) AND relation != 'related_to'",
      )
      .get(nodeId, nodeId) as { n: number };
    ctx.cascadeDeleteEdges(nodeId);
    const reason = 'Memory status changed to deleted.';
    ctx.audit('memory.deleted', {
      memoryId: updated.id,
      reason,
      details: {
        force: input.force === true,
        persistence: updated.persistence ?? DEFAULT_PERSISTENCE,
        removedEdges: removedEdges.n,
      },
    });
    ctx.emitDeleted(updated, reason, removedEdges.n);
  }
  return updated;
}

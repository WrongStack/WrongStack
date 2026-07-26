import type { DatabaseSync } from 'node:sqlite';

import { rejectIfUnsafeInput } from './shared/candidate-lifecycle.js';
import { sqliteRowToMemory } from './sqlite-store-codec.js';
import { memoryNodeId } from './sqlite-store-graph-helpers.js';
import {
  clamp01,
  normalizeAnchors,
  normalizeAudience,
  normalizeTags,
  normalizeText,
} from './store-helpers.js';
import type { Sage, SageStatus, UpdateSageInput } from './types.js';
import { DEFAULT_PERSISTENCE } from './types.js';

export interface SqliteUpdateContext {
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
  const row = ctx.stmt('SELECT data FROM memories WHERE id = ?').get(id) as
    | { data: string }
    | undefined;
  if (!row) throw new Error(`SAGE ${id} not found.`);
  const existing = sqliteRowToMemory(row);
  if (
    input.status === 'deleted' &&
    !input.force &&
    ((existing.persistence ?? DEFAULT_PERSISTENCE) === 'permanent' ||
      input.persistence === 'permanent')
  ) {
    throw new Error(`SAGE "${id}" is marked 'permanent' and cannot be deleted.`);
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
  const statusAffectsAnchorEdges = input.status !== undefined && existing.status !== updated.status;
  if (input.anchors !== undefined || input.confidence !== undefined || statusAffectsAnchorEdges) {
    ctx.syncAnchorEdges(updated);
  }
  ctx.emitUpdated(updated);
  if (existing.status !== 'deleted' && updated.status === 'deleted') {
    const nodeId = memoryNodeId(updated.id);
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

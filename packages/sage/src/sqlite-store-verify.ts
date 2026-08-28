import type { DatabaseSync } from 'node:sqlite';

import { verifyMemoryAnchors } from './anchors/verify.js';
import { anchorsChanged } from './sqlite-store-anchor-diff.js';
import { readSqliteSageRow } from './sqlite-store-codec.js';
import { sqliteRowsToMemories } from './sqlite-store-search-helpers.js';
import { applySemanticChange } from './shared/semantic-rewrite.js';
import type { MemoryVerificationResult, Sage } from './types.js';

interface SqliteVerifyContext {
  projectRoot: string;
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>;
  nowIso: () => string;
  runMutation: <T>(work: () => T) => Promise<T>;
  upsertMemory: (memory: Sage) => void;
  syncAnchorEdges: (memory: Sage) => void;
}

export async function verifySqliteSage(
  ctx: SqliteVerifyContext,
  memoryId?: string,
  signal?: AbortSignal,
): Promise<MemoryVerificationResult[]> {
  signal?.throwIfAborted();
  const rows = (
    memoryId
      ? ctx.stmt("SELECT data FROM memories WHERE id = ? AND status != 'deleted'").all(memoryId)
      : ctx.stmt("SELECT data FROM memories WHERE status != 'deleted'").all()
  ) as Array<{ data: string }>;
  const memories = sqliteRowsToMemories(rows);

  const results: MemoryVerificationResult[] = [];
  const updates: Array<{
    id: string;
    observedAnchors: Sage['anchors'];
    observedStatus: Sage['status'];
    status?: Sage['status'] | undefined;
    lastVerifiedAt: string;
    freshness?: number | undefined;
  }> = [];
  const verificationRunAt = ctx.nowIso();
  for (const memory of memories) {
    signal?.throwIfAborted();
    const result = await verifyMemoryAnchors(ctx.projectRoot, memory, verificationRunAt, signal);
    results.push(result);
    if (result.status === 'stale' && memory.status === 'active') {
      updates.push({
        id: memory.id,
        observedAnchors: memory.anchors,
        observedStatus: memory.status,
        status: 'stale',
        lastVerifiedAt: result.checkedAt,
      });
    } else if (result.status === 'verified') {
      switch (memory.status) {
        case 'stale':
          updates.push({
            id: memory.id,
            observedAnchors: memory.anchors,
            observedStatus: memory.status,
            status: 'active',
            lastVerifiedAt: result.checkedAt,
            freshness: 1,
          });
          break;
        case 'active':
          updates.push({
            id: memory.id,
            observedAnchors: memory.anchors,
            observedStatus: memory.status,
            lastVerifiedAt: result.checkedAt,
            freshness: 1,
          });
          break;
        default:
          updates.push({
            id: memory.id,
            observedAnchors: memory.anchors,
            observedStatus: memory.status,
            lastVerifiedAt: result.checkedAt,
          });
          break;
      }
    } else if (memory.anchors.length > 0 && memory.lastVerifiedAt !== result.checkedAt) {
      updates.push({
        id: memory.id,
        observedAnchors: memory.anchors,
        observedStatus: memory.status,
        lastVerifiedAt: result.checkedAt,
      });
    }
  }
  if (updates.length > 0) {
    await ctx.runMutation(() => {
      for (const update of updates) {
        const current = readSqliteSageRow(ctx.stmt, update.id);
        if (!current) continue;
        if (anchorsChanged(current.anchors, update.observedAnchors)) continue;
        if (current.status !== update.observedStatus && !['active', 'stale'].includes(current.status)) {
          continue;
        }
        const nextStatus =
          update.status === 'stale' && current.status === 'active'
            ? 'stale'
            : update.status === 'active' && current.status === 'stale'
              ? 'active'
              : current.status;
        const verified = applySemanticChange(
          current,
          {
            status: nextStatus,
            lastVerifiedAt: update.lastVerifiedAt,
            ...(update.freshness !== undefined && { freshness: update.freshness }),
          },
          ctx.nowIso(),
        );
        ctx.upsertMemory(verified);
        if (verified.status !== current.status) ctx.syncAnchorEdges(verified);
      }
    });
  }
  return results;
}

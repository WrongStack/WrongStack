import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { verifyMemoryAnchors } from './anchors/verify.js';
import { normalizeSlashes } from './paths.js';
import { applySemanticChange } from './shared/semantic-rewrite.js';
import { anchorsChanged } from './sqlite-store-anchor-diff.js';
import { readSqliteSageRow } from './sqlite-store-codec.js';
import { MEMORY_NODE_PREFIX } from './sqlite-store-graph-helpers.js';
import { sqliteRowsToMemories } from './sqlite-store-search-helpers.js';
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
  return reconcileVerifiedMemories(ctx, sqliteRowsToMemories(rows), signal);
}

/**
 * Verify only the memories anchored to the given paths (file/test/git anchors
 * on the path itself, symbol anchors inside it). Backs the tool-call
 * middleware's verify-on-mutation hook, so a write/edit/patch re-checks the
 * memories about the files it touched instead of the whole corpus. Anchor
 * edges exist only for active and stale memories, which is exactly the set
 * whose status verification may flip.
 */
export async function verifySqliteSageForPaths(
  ctx: SqliteVerifyContext,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<MemoryVerificationResult[]> {
  signal?.throwIfAborted();
  const root = path.resolve(ctx.projectRoot);
  const relativePaths = new Set<string>();
  for (const value of paths) {
    const relative = path.relative(root, path.resolve(root, value));
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`)) continue;
    if (path.isAbsolute(relative)) continue;
    relativePaths.add(normalizeSlashes(relative));
  }
  if (relativePaths.size === 0) return [];

  const memoryIds = new Set<string>();
  const byFile = ctx.stmt('SELECT from_node FROM edges WHERE to_node = ?');
  // `#` (0x23) and `$` (0x24) are adjacent, so this range is exactly the
  // `symbol:<path>#…` nodes of one file and stays on the to_node index.
  const bySymbol = ctx.stmt('SELECT from_node FROM edges WHERE to_node >= ? AND to_node < ?');
  for (const relative of relativePaths) {
    const edges = [
      ...(byFile.all(`file:${relative}`) as Array<{ from_node: string }>),
      ...(bySymbol.all(`symbol:${relative}#`, `symbol:${relative}$`) as Array<{
        from_node: string;
      }>),
    ];
    for (const edge of edges) {
      if (edge.from_node.startsWith(MEMORY_NODE_PREFIX)) {
        memoryIds.add(edge.from_node.slice(MEMORY_NODE_PREFIX.length));
      }
    }
  }
  if (memoryIds.size === 0) return [];

  const select = ctx.stmt("SELECT data FROM memories WHERE id = ? AND status != 'deleted'");
  const rows = [...memoryIds].flatMap((id) => select.all(id) as Array<{ data: string }>);
  return reconcileVerifiedMemories(ctx, sqliteRowsToMemories(rows), signal);
}

async function reconcileVerifiedMemories(
  ctx: SqliteVerifyContext,
  memories: Sage[],
  signal?: AbortSignal,
): Promise<MemoryVerificationResult[]> {
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
            ...(memory.staleReason !== 'manual' ? { status: 'active', freshness: 1 } : {}),
            lastVerifiedAt: result.checkedAt,
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
        if (
          current.status !== update.observedStatus &&
          !['active', 'stale'].includes(current.status)
        ) {
          continue;
        }
        const nextStatus =
          update.status === 'stale' && current.status === 'active'
            ? 'stale'
            : update.status === 'active' &&
                current.status === 'stale' &&
                current.staleReason !== 'manual'
              ? 'active'
              : current.status;
        const verified = applySemanticChange(
          current,
          {
            status: nextStatus,
            ...(nextStatus !== current.status
              ? { staleReason: nextStatus === 'stale' ? ('verification' as const) : undefined }
              : {}),
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

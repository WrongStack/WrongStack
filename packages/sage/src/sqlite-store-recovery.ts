import { ulid } from '@wrongstack/core/utils';
import {
  DEFAULT_PERSISTENCE,
  type Sage,
  type SageBackfillOptions,
  type SageBackfillRecord,
  type SageBackfillReport,
} from './types.js';

interface SqliteRecoveryContext {
  nowIso(): string;
  getMemory(id: string): Sage | null;
  listMemories(): Sage[];
  runMutation<T>(work: () => T): Promise<T>;
  upsertMemory(memory: Sage): void;
  syncAnchorEdges(memory: Sage): void;
  addSupersedesEdge(fromId: string, toId: string, createdAt: string): void;
  audit(event: string, data?: Record<string, unknown>): void;
  emit(event: string, payload: Record<string, unknown>): void;
}

function backfillRecord(memory: Sage, reason: string, newActiveId?: string): SageBackfillRecord {
  return {
    originalId: memory.id,
    ...(newActiveId ? { newActiveId } : {}),
    reason,
    kind: memory.kind,
    scope: memory.scope,
    textPreview: memory.text.slice(0, 200),
    deletedAt: memory.updatedAt,
    persistence: memory.persistence ?? DEFAULT_PERSISTENCE,
  };
}

function followSupersededHead(ctx: SqliteRecoveryContext, memory: Sage): Sage | null {
  let current = memory;
  const seen = new Set<string>([current.id]);
  for (let depth = 0; depth < 64; depth++) {
    if (!current.supersededBy) return current.status === 'active' ? current : null;
    if (seen.has(current.supersededBy)) return null;
    seen.add(current.supersededBy);
    const next = ctx.getMemory(current.supersededBy);
    if (!next) return null;
    current = next;
  }
  return null;
}

function activeSuccessorHead(ctx: SqliteRecoveryContext, id: string): Sage | null {
  for (const memory of ctx.listMemories()) {
    if (memory.status === 'deleted' || !memory.supersedes?.includes(id)) continue;
    const head = followSupersededHead(ctx, memory);
    if (head) return head;
  }
  return null;
}

/** Identity of a memory's knowledge for duplicate detection within one owner scope. */
function duplicateKey(memory: Sage): string {
  const text = memory.text.trim().replace(/\s+/g, ' ').toLowerCase();
  return `${memory.scope}\u0000${memory.ownerSessionId ?? ''}\u0000${text}`;
}

export async function recoverSqliteSage(
  ctx: SqliteRecoveryContext,
  id: string,
  reason = 'Manually recovered via API.',
): Promise<Sage> {
  const memory = ctx.getMemory(id);
  if (!memory) throw new Error(`SAGE "${id}" not found.`);
  if (memory.status === 'active') return memory;
  if (memory.status === 'superseded') {
    const head = followSupersededHead(ctx, memory);
    if (!head) {
      throw new Error(`SAGE "${id}" is superseded but its active chain head is unavailable.`);
    }
    ctx.audit('memory.recover_noop', {
      memoryId: id,
      reason: 'Already superseded; returning active chain head.',
      details: { activeId: head.id },
    });
    ctx.emit('memory.recover_noop', { requestedId: id, activeId: head.id });
    return head;
  }
  if (memory.status !== 'deleted') {
    throw new Error(`SAGE "${id}" has status "${memory.status}" and cannot be recovered.`);
  }

  return ctx.runMutation(() => {
    const fresh = ctx.getMemory(id);
    if (!fresh) throw new Error(`SAGE "${id}" disappeared before recovery completed.`);
    if (fresh.status === 'active') return fresh;
    if (fresh.status !== 'deleted') {
      throw new Error(`SAGE "${id}" changed status during recovery.`);
    }
    // `backfillRecoverable` restores a deleted memory as a NEW row that
    // supersedes it, leaving the original tombstone untouched. Restoring the
    // tombstone as well produced two active copies of the same knowledge —
    // injected twice, and each other's merge target never. Resolve to the
    // successor's active head instead.
    const successorHead = activeSuccessorHead(ctx, id);
    if (successorHead) {
      ctx.audit('memory.recover_noop', {
        memoryId: id,
        reason: 'Already restored by backfill; returning its active successor.',
        details: { activeId: successorHead.id },
      });
      ctx.emit('memory.recover_noop', { requestedId: id, activeId: successorHead.id });
      return successorHead;
    }
    const now = ctx.nowIso();
    const restored: Sage = {
      ...fresh,
      revision: fresh.revision + 1,
      status: 'active',
      staleReason: undefined,
      updatedAt: now,
    };
    ctx.upsertMemory(restored);
    ctx.syncAnchorEdges(restored);
    ctx.audit('memory.recovered', {
      memoryId: id,
      reason,
      details: { persistence: restored.persistence ?? DEFAULT_PERSISTENCE },
    });
    ctx.emit('memory.recovered', { memoryId: id, reason });
    return restored;
  });
}

export async function backfillRecoverableSqliteSage(
  ctx: SqliteRecoveryContext,
  options: SageBackfillOptions = {},
): Promise<SageBackfillReport> {
  const dryRun = options.dryRun !== false;
  const filter = options.filter ?? {};
  const requestedIds = filter.ids ? new Set(filter.ids) : undefined;
  const requireText = filter.requireText !== false;
  const requireProvenance = filter.requireProvenance !== false;
  const startedAt = ctx.nowIso();
  const all = ctx.listMemories();
  const deleted = all.filter((memory) => memory.status === 'deleted');
  const alreadyRecovered = new Set<string>();
  // Backfill writes rows directly, bypassing remember()'s exact/near-duplicate
  // merge. Without this check a fact deleted and later re-remembered (or two
  // deleted copies of it) came back as a second active memory with the same
  // text.
  const liveKnowledge = new Set<string>();
  for (const memory of all) {
    if (memory.status === 'deleted') continue;
    for (const previous of memory.supersedes ?? []) alreadyRecovered.add(previous);
    if (memory.status === 'active' || memory.status === 'stale') {
      liveKnowledge.add(duplicateKey(memory));
    }
  }

  const report: SageBackfillReport = {
    startedAt,
    completedAt: startedAt,
    dryRun,
    examined: deleted.length,
    recoverable: 0,
    recovered: 0,
    skipped: 0,
    skippedRecords: [],
    recoverableRecords: [],
    byKind: {},
    byReason: {},
  };

  const skip = (memory: Sage, reason: string): void => {
    report.skipped++;
    report.byReason[reason] = (report.byReason[reason] ?? 0) + 1;
    report.skippedRecords.push(backfillRecord(memory, reason));
  };

  for (const memory of deleted) {
    if (requestedIds && !requestedIds.has(memory.id)) {
      skip(memory, 'filter_ids');
      continue;
    }
    if (alreadyRecovered.has(memory.id)) {
      skip(memory, 'already_recovered');
      continue;
    }
    if (filter.kinds && !filter.kinds.includes(memory.kind)) {
      skip(memory, 'filter_kinds');
      continue;
    }
    if (filter.scopes && !filter.scopes.includes(memory.scope)) {
      skip(memory, 'filter_scopes');
      continue;
    }
    if (filter.updatedAfter && memory.updatedAt < filter.updatedAfter) {
      skip(memory, 'filter_updatedAfter');
      continue;
    }
    if (filter.updatedBefore && memory.updatedAt > filter.updatedBefore) {
      skip(memory, 'filter_updatedBefore');
      continue;
    }
    if (requireText && memory.text.trim().length === 0) {
      skip(memory, 'empty_text');
      continue;
    }
    if (requireProvenance && memory.sources.length === 0 && memory.anchors.length === 0) {
      skip(memory, 'no_provenance');
      continue;
    }
    const key = duplicateKey(memory);
    if (liveKnowledge.has(key)) {
      skip(memory, 'duplicate_active');
      continue;
    }
    liveKnowledge.add(key);
    report.recoverable++;
    report.byKind[memory.kind] = (report.byKind[memory.kind] ?? 0) + 1;
    report.recoverableRecords.push(backfillRecord(memory, 'recoverable'));
  }

  if (!dryRun && report.recoverableRecords.length > 0) {
    await ctx.runMutation(() => {
      // The scan above ran OUTSIDE this transaction, so `alreadyRecovered` /
      // `liveKnowledge` describe the pre-scan snapshot only. An overlapping
      // apply — or a manual recoverSqliteSage — can resurrect a tombstone as a
      // new active successor between that scan and this write pass, and
      // re-checking the ORIGINAL's status alone does not see it (backfill
      // leaves the tombstone 'deleted' by design). Re-derive the superseded set
      // under the lock, mirroring the scan's own `alreadyRecovered` rule and
      // recoverSqliteSage's in-mutation successor check, so the loser of the
      // race does not create a second active copy of the same knowledge.
      const restoredBySupersedes = new Set<string>();
      for (const memory of ctx.listMemories()) {
        if (memory.status === 'deleted') continue;
        for (const previous of memory.supersedes ?? []) restoredBySupersedes.add(previous);
      }
      for (const record of report.recoverableRecords) {
        const original = ctx.getMemory(record.originalId);
        if (original?.status !== 'deleted' || restoredBySupersedes.has(record.originalId)) {
          record.reason = 'race_lost';
          report.byReason['race_lost'] = (report.byReason['race_lost'] ?? 0) + 1;
          continue;
        }
        const now = ctx.nowIso();
        const newMemory: Sage = {
          ...original,
          id: `mem_${ulid()}`,
          revision: 1,
          status: 'active',
          staleReason: undefined,
          tags: [...new Set([...original.tags, 'backfill:recovered'])],
          supersedes: [...new Set([...(original.supersedes ?? []), original.id])],
          supersededBy: undefined,
          contextPolicy: original.contextPolicy === 'never' ? 'never' : undefined,
          injectionCount: 0,
          useCount: 0,
          createdAt: now,
          updatedAt: now,
          lastAccessedAt: undefined,
          lastVerifiedAt: undefined,
          lastUsedAt: undefined,
        };
        ctx.upsertMemory(newMemory);
        ctx.syncAnchorEdges(newMemory);
        ctx.addSupersedesEdge(newMemory.id, original.id, now);
        record.newActiveId = newMemory.id;
        report.recovered++;
        ctx.audit('memory.backfilled', {
          memoryId: original.id,
          reason: 'backfillRecoverable',
          details: { newActiveId: newMemory.id },
        });
        // Per-memory event: the aggregate `memory.backfill_applied` below
        // carries only counts, so live subscribers (the vector mirror, the
        // lifecycle panels) never learned the restored rows existed.
        ctx.emit('memory.recovered', { memoryId: newMemory.id, reason: 'backfillRecoverable' });
      }
    });
  }

  report.completedAt = ctx.nowIso();
  ctx.audit(dryRun ? 'memory.backfill_dry_run' : 'memory.backfill_applied', {
    details: {
      examined: report.examined,
      recoverable: report.recoverable,
      recovered: report.recovered,
      skipped: report.skipped,
    },
  });
  ctx.emit(dryRun ? 'memory.backfill_dry_run' : 'memory.backfill_applied', {
    examined: report.examined,
    recoverable: report.recoverable,
    recovered: report.recovered,
    skipped: report.skipped,
  });
  return report;
}

import type { MemoryScope } from '@wrongstack/contracts/types';
import type { HqSageRecord } from '@wrongstack/hq';
import { recordSqliteInjection, recordSqliteUse } from './sqlite-store-counters.js';
import { clearLegacySqliteMemory } from './sqlite-store-legacy-clear.js';
import { consolidateLegacySqliteMemory } from './sqlite-store-legacy-consolidate.js';
import { forgetLegacySqliteMemory } from './sqlite-store-legacy-forget.js';
import { applySageHqSync } from './sqlite-store-operations.js';
import { updateSqliteSage } from './sqlite-store-update.js';
import { upsertSqliteMemory } from './sqlite-store-upsert.js';
import { mergeLiveCounterFields } from './store-helpers.js';
import type { Sage, UpdateSageInput } from './types.js';
import { DEFAULT_PERSISTENCE } from './types.js';

export interface SqliteMemoryMutationsHost {
  initialize: () => Promise<void>;
  runMutation: <T>(work: () => T, signal?: AbortSignal | undefined) => Promise<T>;
  stmt: (sql: string) => import('node:sqlite').StatementSync;
  nowIso: () => string;
  upsertMemory: (m: import('./memory-model.js').Sage) => void;
  cascadeDeleteEdges: (nodeId: string) => void;
  audit: (event: string, data?: Record<string, unknown> | undefined) => void;
  events: import('@wrongstack/contracts/kernel').EventBus | undefined;
  syncAnchorEdges: (memory: import('./memory-model.js').Sage) => void;
  db: import('node:sqlite').DatabaseSync;
  projectRoot: string;
  eventPayload: <T extends object>(
    payload: T,
  ) => T & { traceId?: string | undefined; sessionId?: string | undefined };
  deleteSage: (
    id: string,
    reason?: string,
    options?: { force?: boolean; neverInject?: boolean },
  ) => Promise<void>;
  runCounterMutation: <T>(work: () => T extends Promise<unknown> ? never : T) => Promise<T>;
}

export async function forget(
  this: SqliteMemoryMutationsHost,
  query: string,
  scope: MemoryScope = 'project-memory',
): Promise<number> {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return 0;
  await this.initialize();
  return this.runMutation(() => {
    return forgetLegacySqliteMemory(
      {
        stmt: (sql) => this.stmt(sql),
        nowIso: () => this.nowIso(),
        upsertMemory: (memory) => this.upsertMemory(memory),
        cascadeDeleteEdges: (nodeId) => this.cascadeDeleteEdges(nodeId),
        audit: (event, data) => this.audit(event, data),
        emitForgotten: (targetScope, targetQuery, removed) =>
          this.events?.emit('memory.forgotten', {
            scope: targetScope,
            query: targetQuery,
            removed,
          }),
      },
      query,
      scope,
    );
  });
}

export async function consolidate(
  this: SqliteMemoryMutationsHost,
  scope: MemoryScope,
): Promise<void> {
  await this.initialize();
  await this.runMutation(() => {
    consolidateLegacySqliteMemory(
      {
        stmt: (sql) => this.stmt(sql),
        nowIso: () => this.nowIso(),
        upsertMemory: (memory) => this.upsertMemory(memory),
        syncAnchorEdges: (memory) => this.syncAnchorEdges(memory),
        audit: (event, data) => this.audit(event, data),
        emitConsolidated: (targetScope, removed) =>
          this.events?.emit('memory.consolidated', { scope: targetScope, removed }),
      },
      scope,
    );
  });
}

export async function clear(this: SqliteMemoryMutationsHost, scope?: MemoryScope): Promise<void> {
  await this.initialize();
  await this.runMutation(() => {
    clearLegacySqliteMemory(
      {
        stmt: (sql) => this.stmt(sql),
        nowIso: () => this.nowIso(),
        upsertMemory: (memory) => this.upsertMemory(memory),
        cascadeDeleteEdges: (nodeId) => this.cascadeDeleteEdges(nodeId),
        audit: (event, data) => this.audit(event, data),
        emitCleared: (targetScope) => this.events?.emit('memory.cleared', { scope: targetScope }),
      },
      scope,
    );
  });
}

export function upsertMemory(this: SqliteMemoryMutationsHost, m: Sage): void {
  // H6 (docs/archive/plans/sage-phase4-design.md): the counter chain json_set's advisory
  // fields into `data` independently of this whole-column write, so an
  // advisory bump that committed after the caller read the row must survive
  // the replace.
  const previous = this.stmt('SELECT data FROM memories WHERE id = ?').get(m.id) as
    | { data: string }
    | undefined;
  upsertSqliteMemory((sql) => this.stmt(sql), mergeLiveCounterFields(previous?.data, m));
}

export async function applyHqSync(
  this: SqliteMemoryMutationsHost,
  records: HqSageRecord[],
): Promise<void> {
  await this.initialize();
  const changed = await this.runMutation(() =>
    applySageHqSync(
      {
        db: this.db,
        upsert: (memory) => this.upsertMemory(memory),
        anchors: (memory) => this.syncAnchorEdges(memory),
        deleteEdges: (node) => this.cascadeDeleteEdges(node),
      },
      records,
    ),
  );
  for (const id of changed) {
    this.audit('memory.hq_synced', { memoryId: id });
  }
  if (changed.length)
    this.events?.emit('memory.consolidated', { scope: 'project-memory', removed: 0 });
}

export async function updateSage(
  this: SqliteMemoryMutationsHost,
  id: string,
  input: UpdateSageInput,
): Promise<Sage> {
  await this.initialize();
  return this.runMutation(() => {
    return updateSqliteSage(
      {
        projectRoot: this.projectRoot,
        stmt: (sql) => this.stmt(sql),
        nowIso: () => this.nowIso(),
        upsertMemory: (memory) => this.upsertMemory(memory),
        syncAnchorEdges: (memory) => this.syncAnchorEdges(memory),
        cascadeDeleteEdges: (nodeId) => this.cascadeDeleteEdges(nodeId),
        audit: (event, data) => this.audit(event, data),
        emitUpdated: (memory) =>
          this.events?.emit(
            'memory.updated',
            this.eventPayload({
              memoryId: memory.id,
              status: memory.status,
              kind: memory.kind,
              persistence: memory.persistence ?? DEFAULT_PERSISTENCE,
              confidence: memory.confidence,
              freshness: memory.freshness,
            }),
          ),
        emitDeleted: (memory, reason, removedEdges) =>
          this.events?.emit(
            'memory.deleted',
            this.eventPayload({
              memoryId: memory.id,
              reason,
              persistence: memory.persistence ?? DEFAULT_PERSISTENCE,
              removedEdges,
              contextPolicy:
                memory.contextPolicy === 'never' ? ('never' as const) : ('eligible' as const),
            }),
          ),
      },
      id,
      input,
    );
  });
}

export async function hardDeleteSage(
  this: SqliteMemoryMutationsHost,
  id: string,
  reason?: string,
): Promise<{ deleted: true; id: string }> {
  // Soft-delete shim. The SQLite backend used to ship its own
  // un-audited-by-force SQL path here; it now routes through
  // `deleteSage` (which sets status: 'deleted', preserving
  // the tombstone for audit/recovery) so the same force/permanent
  // guard, edge cascade, audit entry, and event payload apply to
  // every caller.
  // Pass `force: true` because this method historically implied
  // "operator-driven, no questions asked" (it predates the guard).
  await this.deleteSage(id, reason ?? 'Manually deleted via SQLite API.', {
    force: true,
  });
  return { deleted: true, id };
}

export async function recordInjection(
  this: SqliteMemoryMutationsHost,
  memoryIds: string[],
  trigger: string,
  sessionId?: string,
): Promise<void> {
  if (memoryIds.length === 0) return;
  await this.initialize();
  await this.runCounterMutation(() => {
    recordSqliteInjection(
      {
        stmt: (sql) => this.stmt(sql),
        nowIso: () => this.nowIso(),
        audit: (event, data) => this.audit(event, data),
      },
      memoryIds,
      trigger,
      sessionId,
    );
  });
}

export async function recordUse(
  this: SqliteMemoryMutationsHost,
  memoryIds: string[],
  source: string,
  sessionId?: string,
): Promise<void> {
  if (memoryIds.length === 0) return;
  await this.initialize();
  await this.runCounterMutation(() => {
    recordSqliteUse(
      {
        stmt: (sql) => this.stmt(sql),
        nowIso: () => this.nowIso(),
        audit: (event, data) => this.audit(event, data),
      },
      memoryIds,
      source,
      sessionId,
    );
  });
}

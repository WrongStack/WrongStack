import type { MemoryEntry, MemoryScope } from '@wrongstack/core/types';
import type {
  MemoryCandidate,
  MemoryGraphEdge,
  Sage,
  SageAuditRecord,
  SageRecord,
} from './types.js';

export function importanceFromPriority(priority: MemoryEntry['priority']): number {
  switch (priority) {
    case 'critical':
      return 1;
    case 'high':
      return 0.8;
    case 'low':
      return 0.3;
    case 'medium':
    case undefined:
      return 0.6;
    default: {
      // Unknown priority can come from future persisted JSON; keep the hot path tolerant.
      return 0.6;
    }
  }
}

export function legacyScopeLabel(scope: MemoryScope): string {
  switch (scope) {
    case 'project-agents':
      return 'Project AGENTS.md';
    case 'project-memory':
      return 'Project Memory';
    case 'user-memory':
      return 'User Memory';
    default: {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'sage.unknown_memory_scope',
          scope,
          message: 'Unknown MemoryScope; using fallback label',
          timestamp: new Date().toISOString(),
        }),
      );
      return `${scope}`;
    }
  }
}

export function matchesLegacyForget(memory: Sage, normalizedQuery: string): boolean {
  const searchable = [
    memory.id,
    memory.text,
    ...memory.tags,
    ...memory.anchors.flatMap((anchor) => [
      anchor.path,
      anchor.symbol,
      anchor.command,
      anchor.role,
    ]),
  ]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  return searchable.includes(normalizedQuery);
}

export function isMigratableMemoryRecord(value: unknown): value is SageRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<SageRecord>;
  const memory = record.memory as Partial<Sage> | undefined;
  return (
    record.recordType === 'memory' &&
    !!memory &&
    typeof memory.id === 'string' &&
    Number.isInteger(memory.revision) &&
    (memory.revision ?? 0) >= 1 &&
    typeof memory.status === 'string' &&
    typeof memory.kind === 'string' &&
    typeof memory.scope === 'string' &&
    typeof memory.text === 'string' &&
    typeof memory.importance === 'number' &&
    Number.isFinite(memory.importance) &&
    typeof memory.confidence === 'number' &&
    Number.isFinite(memory.confidence) &&
    typeof memory.freshness === 'number' &&
    Number.isFinite(memory.freshness) &&
    Array.isArray(memory.tags) &&
    Array.isArray(memory.anchors) &&
    Array.isArray(memory.sources) &&
    typeof memory.createdAt === 'string' &&
    typeof memory.updatedAt === 'string'
  );
}

/** Match the JSONL replay rule while never replacing a newer SQLite revision. */
export function shouldReplaceMigratedMemory(current: Sage, incoming: Sage): boolean {
  if (incoming.revision !== current.revision) return incoming.revision > current.revision;
  return current.status === 'deleted' && incoming.status !== 'deleted';
}

export function isMigratableCandidate(value: unknown): value is MemoryCandidate {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<MemoryCandidate>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.status === 'string' &&
    typeof candidate.text === 'string' &&
    typeof candidate.createdAt === 'string' &&
    typeof candidate.updatedAt === 'string'
  );
}

export function isMigratableEdge(value: unknown): value is MemoryGraphEdge {
  if (!value || typeof value !== 'object') return false;
  const edge = value as Partial<MemoryGraphEdge>;
  return (
    typeof edge.id === 'string' &&
    typeof edge.from === 'string' &&
    typeof edge.to === 'string' &&
    typeof edge.relation === 'string' &&
    typeof edge.weight === 'number' &&
    Number.isFinite(edge.weight) &&
    typeof edge.createdAt === 'string'
  );
}

export function isMigratableAuditRecord(value: unknown): value is SageAuditRecord {
  if (!value || typeof value !== 'object') return false;
  const audit = value as Partial<SageAuditRecord>;
  return typeof audit.event === 'string' && typeof audit.at === 'string';
}

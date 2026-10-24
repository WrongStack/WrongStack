import type {
  MemoryEntry,
  MemoryPriority,
  MemoryScope,
  MemoryType,
} from '@wrongstack/contracts/types';
import type { Sage, SageKind, SageScope } from './memory-model.js';

export function sageToLegacyScope(scope: SageScope): MemoryScope {
  switch (scope) {
    case 'user':
      return 'user-memory';
    case 'project':
    case 'session':
    case 'file':
    case 'symbol':
      return 'project-memory';
  }
}

export function legacyToSageScope(scope: MemoryScope): SageScope {
  switch (scope) {
    case 'user-memory':
      return 'user';
    case 'project-agents':
    case 'project-memory':
      return 'project';
  }
}

export function kindToLegacyType(kind: SageKind): MemoryType {
  switch (kind) {
    case 'decision':
      return 'decision';
    case 'convention':
      return 'convention';
    case 'preference':
      return 'preference';
    case 'anti_pattern':
      return 'anti_pattern';
    case 'file_note':
    case 'symbol_note':
    case 'command_note':
      return 'reference';
    case 'warning':
    case 'workflow':
    case 'bug_root_cause':
    case 'summary':
    case 'memory_review':
    case 'tool_outcome':
    case 'error_pattern':
    case 'session_digest':
    case 'role_operational':
    case 'task_outcome':
    case 'security_signal':
    case 'fleet_convention':
    case 'fact':
      return 'fact';
  }
}

export function legacyTypeToKind(type: MemoryType | undefined): SageKind {
  switch (type) {
    case 'decision':
      return 'decision';
    case 'convention':
      return 'convention';
    case 'preference':
      return 'preference';
    case 'anti_pattern':
      return 'anti_pattern';
    case 'reference':
      return 'file_note';
    case 'fact':
    case undefined:
      return 'fact';
  }
}

export function toLegacyEntry(memory: Sage): MemoryEntry {
  return {
    scope: memory.legacyScope ?? sageToLegacyScope(memory.scope),
    text: memory.text,
    ts: memory.createdAt,
    type: kindToLegacyType(memory.kind),
    tags: memory.tags.length > 0 ? memory.tags : undefined,
    priority: priorityFromImportance(memory.importance),
    source: memory.sources[0]?.type,
    confidence: memory.confidence,
    lastAccessed: memory.lastAccessedAt,
  };
}

function priorityFromImportance(importance: number): MemoryPriority {
  if (importance >= 0.9) return 'critical';
  if (importance >= 0.75) return 'high';
  if (importance >= 0.4) return 'medium';
  return 'low';
}

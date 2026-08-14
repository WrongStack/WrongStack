import type { MemoryPort, MemoryPriority, MemoryScope, MemoryType } from '@wrongstack/core/types';

export interface MemorySlashDeps {
  memoryStore: MemoryPort;
}

export const DEFAULT_MEMORY_LIMIT = 50;
export const MAX_MEMORY_LIMIT = 500;

export interface SageLike {
  id: string;
  kind: string;
  status: string;
  text: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  importance: number;
  confidence: number;
  anchors: Array<{
    type: string;
    path?: string | undefined;
    symbol?: string | undefined;
    command?: string | undefined;
  }>;
  sources: Array<{ type: string }>;
}

export interface SageStatsLike {
  total: number;
  byStatus: Record<string, number>;
  byKind: Partial<Record<string, number>>;
  edges: number;
}

export interface MemoryAnchorLike {
  type: string;
  path?: string | undefined;
  symbol?: string | undefined;
  command?: string | undefined;
}

export interface UpdateSageInput {
  text?: string | undefined;
  kind?: string | undefined;
  tags?: string[] | undefined;
  anchors?: MemoryAnchorLike[] | undefined;
  importance?: number | undefined;
  confidence?: number | undefined;
  freshness?: number | undefined;
  status?: string | undefined;
  supersedes?: string[] | undefined;
  contradicts?: string[] | undefined;
}

export interface Stats {
  total: number;
  perScope: Record<MemoryScope, number>;
  perType: Partial<Record<MemoryType, number>>;
  perPriority: Partial<Record<MemoryPriority, number>>;
  recency: { week: number; month: number; older: number };
  tagCounts: Map<string, number>;
  noTypeCount: number;
  noPriorityCount: number;
  sources: Set<string>;
}

export interface ParsedArgs {
  tag?: string;
  path?: string;
  compact: boolean;
  limit: number;
  positional: string;
}

export const MEMORY_WRITE_SUBS = new Set([
  'remember',
  'add',
  'update',
  'edit',
  'delete',
  'del',
  'forget',
  'rm',
]);

export const MEMORY_KIND_VALUES = [
  'fact',
  'decision',
  'convention',
  'preference',
  'warning',
  'anti_pattern',
  'workflow',
  'bug_root_cause',
  'file_note',
  'symbol_note',
  'command_note',
  'summary',
];

export const MEMORY_SCOPE_VALUES = ['project', 'user', 'session', 'file', 'symbol'];

export const MEMORY_STATUS_VALUES = [
  'active',
  'stale',
  'superseded',
  'contradicted',
  'archived',
  'deleted',
] as const;

export interface ParsedMemoryFlags {
  text: string;
  kind?: string;
  scope?: string;
  status?: string;
  tags?: string[];
  anchors?: MemoryAnchorLike[];
  importance?: number | undefined;
  confidence?: number | undefined;
  freshness?: number | undefined;
  supersedes?: string[];
  contradicts?: string[];
  errors: string[];
}

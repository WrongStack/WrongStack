export type MemoryScope = 'project-agents' | 'project-memory' | 'user-memory';

// ── Memory categories ──────────────────────────────────────────────────

export type MemoryType =
  | 'fact'
  | 'decision'
  | 'convention'
  | 'preference'
  | 'reference'
  | 'anti_pattern';

export const MEMORY_TYPE_LABELS: Record<MemoryType, string> = {
  fact: 'Fact',
  decision: 'Decision',
  convention: 'Convention',
  preference: 'Preference',
  reference: 'Reference',
  anti_pattern: 'Anti-pattern',
};

export type MemoryPriority = 'critical' | 'high' | 'medium' | 'low';

export interface MemoryEntry {
  scope: MemoryScope;
  text: string;
  ts: string;
  /** Category — helps the agent decide whether to inject or ignore. */
  type?: MemoryType | undefined;
  /** Free-form tags for grouping (e.g. ["build", "pnpm", "typescript"]). */
  tags?: string[] | undefined;
  /** Priority — critical entries are always injected; low may be skipped. */
  priority?: MemoryPriority | undefined;
  /** Session or agent that created this entry. */
  source?: string | undefined;
  /** 0.0–1.0 confidence. Low-confidence entries are injected less often. */
  confidence?: number | undefined;
  /** ISO timestamp of last access (read or injection into context). */
  lastAccessed?: string | undefined;
}

// ── Memory events — emitted by SageStore so plugins can react ──

export interface MemoryRememberedPayload {
  scope: MemoryScope;
  text: string;
  ts: string;
  type?: MemoryType | undefined;
  tags?: string[] | undefined;
  priority?: MemoryPriority | undefined;
}

export interface MemoryForgottenPayload {
  scope: MemoryScope;
  query: string;
  removed: number;
}

export interface MemoryClearedPayload {
  /** Scope that was cleared, or undefined when all scopes were cleared. */
  scope?: MemoryScope | undefined;
}

export interface MemoryConsolidatedPayload {
  scope: MemoryScope;
  /** Entries removed by deduplication. */
  removed: number;
}

// ── Relevance scoring ──────────────────────────────────────────────────

/**
 * Context used to score memory relevance for context injection.
 * Passed by the system prompt builder.
 */
export interface MemoryRelevanceContext {
  /** Current user message or task description. */
  currentTask: string;
  /** Active skills in this session (e.g. ["typescript-strict", "git-flow"]). */
  activeSkills?: string[] | undefined;
  /** Active mode (e.g. "Teach", "Brief", "Code Reviewer"). */
  activeMode?: string | undefined;
  /** Available tools — memories referencing relevant tools score higher. */
  toolNames?: string[] | undefined;
}

export interface ScoredEntry extends MemoryEntry {
  score: number;
  matchReason: string;
}

// ── Store interface ────────────────────────────────────────────────────

export interface MemoryStore {
  readAll(): Promise<string>;
  read(scope: MemoryScope): Promise<string>;
  remember(
    text: string,
    scope?: MemoryScope,
    metadata?: Omit<Partial<MemoryEntry>, 'scope' | 'text' | 'ts'>,
  ): Promise<void>;
  forget(query: string, scope?: MemoryScope): Promise<number>;
  consolidate(scope: MemoryScope): Promise<void>;
  clear(scope?: MemoryScope): Promise<void>;
  /** List entries, newest first. */
  list(scope?: MemoryScope, limit?: number): Promise<MemoryEntry[]>;
  /** Search by content (substring or semantic). */
  search(query: string, scope?: MemoryScope, limit?: number): Promise<MemoryEntry[]>;
  /** Access the backend for advanced queries. */
  getBackend?(): unknown;
  /** Graph-based related memory traversal. */
  findRelated?(text: string, scope?: MemoryScope, limit?: number): Promise<MemoryEntry[]>;
  /**
   * Score and rank memories by relevance to the current context.
   * Returns only entries that meet a relevance threshold.
   */
  scoreRelevant?(
    ctx: MemoryRelevanceContext,
    scope?: MemoryScope,
    limit?: number,
  ): Promise<ScoredEntry[]>;
  /**
   * Run memory hygiene: verify anchors, mark stale entries, archive
   * low-confidence/old memories. Optional — only SAGE stores
   * implement this. Declared on the interface so callers can invoke
   * it without a type-erasing cast.
   */
  hygiene?(opts?: {
    retentionDays?: number | undefined;
    sessionRetentionDays?: number | undefined;
    archiveLowConfidenceAfterDays?: number | undefined;
    archiveUnusedAfterDays?: number | undefined;
    unusedMinInjections?: number | undefined;
    purgeDeletedAfterDays?: number | undefined;
    nearDedup?: boolean | undefined;
    verify?: boolean | undefined;
  }): Promise<unknown>;
  /**
   * Attach a trace ID to this store so that all subsequent `storage.*`
   * events include it for observability correlation. Mutates the store
   * in place and returns the same instance (convenience chaining).
   */
  withTraceId(traceId: string): MemoryStore;
}

/**
 * A typed key for an optional memory feature. Implementations expose features
 * through keys instead of forcing hosts to inspect concrete store methods.
 */
export interface MemoryCapability<T> {
  readonly id: string;
  /**
   * Type-level brand to prevent structural assignment between capabilities
   * with different generic parameters. Exists at runtime as an identity
   * function (assigned by `defineMemoryCapability`) but is never inspected
   * by any code path — capability lookup is keyed by `id` only.
   */
  readonly __memoryCapabilityType?: ((value: T) => T) | undefined;
}

export function defineMemoryCapability<T>(id: string): MemoryCapability<T> {
  return Object.freeze({
    id,
    /** Identity function that makes the brand a real runtime value so
     *  `defineMemoryCapability<A>('x')` and `defineMemoryCapability<B>('x')`
     *  produce structurally distinct objects. Capability lookup is still
     *  keyed by `id` only — the brand prevents accidental cross-type casts
     *  at the type level. */
    __memoryCapabilityType: (v: T) => v,
  });
}

export interface MemoryHealth {
  status: 'ready' | 'degraded' | 'unavailable';
  backend: string;
  details?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Host-facing memory boundary. Basic legacy operations remain available during
 * migration; optional graph/admin/SAGE behavior is capability-based.
 */
export interface MemoryPort extends MemoryStore {
  initialize(): Promise<void>;
  getCapability<T>(capability: MemoryCapability<T>): T | undefined;
  health(): Promise<MemoryHealth>;
  dispose(): Promise<void>;
  withTraceId(traceId: string): MemoryPort;
}

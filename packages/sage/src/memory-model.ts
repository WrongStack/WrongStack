import type { MemoryScope } from '@wrongstack/contracts/types';

export type SageScope = 'project' | 'user' | 'session' | 'file' | 'symbol';

/**
 * Persistence class — controls how hygiene treats a memory.
 *
 * - `permanent`:   Hygiene never deletes or recommends deletion. Anchors are
 *                  still verified, and a stale flag is set on failure, but no
 *                  time-based or usage-based retention ever fires.
 * - `long_lived`:  Default. Hygiene surfaces review candidates for never-used,
 *                  injected-but-unused, or low-confidence memories; final
 *                  decision always belongs to the user/LLM via `memory_forget`
 *                  or `memory_update`. Time-based deletion is **off**.
 * - `short_lived`: Subject to the (still advisory, not auto-applying) time-
 *                  based review thresholds. Caller may also set `expiresAt`
 *                  for a hard TTL the user explicitly opted into.
 *
 * Migration: existing stores without this field are treated as `long_lived`.
 */
export type PersistenceClass = 'permanent' | 'long_lived' | 'short_lived';

export type SageKind =
  | 'fact'
  | 'decision'
  | 'convention'
  | 'preference'
  | 'warning'
  | 'anti_pattern'
  | 'workflow'
  | 'bug_root_cause'
  | 'file_note'
  | 'symbol_note'
  | 'command_note'
  | 'summary'
  | 'memory_review'
  // ── New SAGE-only kinds (added 2026-08-08, retrospective analysis) ───
  // All map to legacy `MemoryType='fact'` for backward compat — they are
  // semantically distinct in SAGE so retrieval + the WebUI can render them
  // differently, but the legacy `MemoryStore` surface stays closed.
  | 'tool_outcome' // durable result of a successful tool call (e.g. command exited 0)
  | 'error_pattern' // recurring error signature → root cause + fix
  | 'session_digest' // per-session outcome summary (owned by session, expires)
  | 'role_operational' // guidance for a specific agent role / task type
  | 'task_outcome' // what worked (or didn't) for a Kanban/task type
  | 'security_signal' // denial patterns, secret-scrubber hits, path-guard rejections
  | 'fleet_convention'; // cross-agent handoff / roster etiquette

export type SageStatus =
  | 'active'
  | 'stale'
  | 'superseded'
  | 'contradicted'
  | 'archived'
  | 'deleted';

/**
 * Every {@link SageStatus} as a runtime list. The union alone cannot be iterated,
 * which is how `buildSageStats` came to return only the statuses that happened to
 * have rows: SQL `GROUP BY status` omits empty groups, the partial record was cast
 * to `Record<SageStatus, number>`, and `/memory stats` printed
 * "stale undefined; archived undefined; deleted undefined" on any store with only
 * active memories (probe-verified 2026-09-22 against the real SQLite backend).
 */
export const SAGE_STATUSES = [
  'active',
  'stale',
  'superseded',
  'contradicted',
  'archived',
  'deleted',
] as const satisfies readonly SageStatus[];

/**
 * Compile gate: `never` while {@link SAGE_STATUSES} lists every status. A status
 * added to the union but not to the list fails here, naming itself — the same
 * `AssertNever` idiom `config-doctor.ts` and `view-navigation.ts` use. (An empty
 * array typed `X[]` is NOT a gate: it is assignable for every `X`.)
 */
type AssertNever<T extends never> = T;
export type AssertAllSageStatusesListed = AssertNever<
  Exclude<SageStatus, (typeof SAGE_STATUSES)[number]>
>;

/**
 * Every {@link SageKind} as a runtime list — the single source of truth for
 * command-side validation vocabularies (for example `/memory gather --kind`).
 * The union alone cannot be iterated, and a hand-copied CLI list has already
 * drifted from it once (gather rejected the 2026-08-08 kinds), the same
 * failure mode the status list above was created to prevent.
 */
export const SAGE_KINDS = [
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
  'memory_review',
  'tool_outcome',
  'error_pattern',
  'session_digest',
  'role_operational',
  'task_outcome',
  'security_signal',
  'fleet_convention',
] as const satisfies readonly SageKind[];

/**
 * Compile gate: `never` while {@link SAGE_KINDS} lists every kind. A kind
 * added to the union but not to the list fails here, naming itself — the same
 * `AssertNever` idiom the status list uses.
 */
export type AssertAllSageKindsListed = AssertNever<Exclude<SageKind, (typeof SAGE_KINDS)[number]>>;

export interface MemoryAnchor {
  type: 'file' | 'directory' | 'symbol' | 'package' | 'command' | 'test' | 'git' | 'agent';
  path?: string | undefined;
  symbol?: string | undefined;
  command?: string | undefined;
  /** Stable roster/catalog role id when type is `agent`. */
  role?: string | undefined;
  contentHash?: string | undefined;
  gitBlobHash?: string | undefined;
  lineStart?: number | undefined;
  lineEnd?: number | undefined;
}

export interface MemoryAudienceSelector {
  /** Stable fleet/catalog role ids (for example `reviewer`, `refactor-planner`, or `git`). */
  roles?: string[] | undefined;
  /** Work classifications such as `review`, `refactor`, or Kanban task types. */
  taskTypes?: string[] | undefined;
  /** Runtime modes that should receive the memory (for example `code-review`). */
  modes?: string[] | undefined;
}

export interface MemoryAudienceContext {
  role?: string | undefined;
  taskType?: string | undefined;
  mode?: string | undefined;
}

export interface MemorySourceRef {
  type:
    | 'user'
    | 'session'
    | 'tool_result'
    | 'project_instruction'
    | 'file'
    | 'test'
    | 'command'
    | 'legacy_memory';
  sessionId?: string | undefined;
  toolUseId?: string | undefined;
  path?: string | undefined;
  command?: string | undefined;
  excerptHash?: string | undefined;
}

export interface MemoryValidity {
  /** Applicability assumptions, not instructions or proof of correctness. */
  statement: string;
  /** Literal source evidence only; no commands, expressions or regular expressions. */
  checks?: Array<{ type: 'source_contains'; path: string; text: string }> | undefined;
}

export interface MemoryFeedbackInput {
  verdict: 'useful' | 'outdated' | 'incorrect' | 'irrelevant' | 'uncertain';
  /** Revision actually read by the model, not a fresh revision guessed at write time. */
  observedRevision: number;
  /** Concrete observation, test result or source reference supporting the judgment. */
  evidence: string;
  sessionId?: string | undefined;
}

export interface MemoryFeedback extends MemoryFeedbackInput {
  at: string;
}

export interface Sage {
  id: string;
  revision: number;
  /** Bounded model judgments; these are not verification or permission signals. */
  feedback?: MemoryFeedback[] | undefined;
  validity?: MemoryValidity | undefined;
  scope: SageScope;
  legacyScope?: MemoryScope | undefined;
  kind: SageKind;
  status: SageStatus;
  /** Orthogonal to lifecycle: only `never` is an absolute LLM-context ban. */
  contextPolicy?: 'eligible' | 'never' | undefined;
  /**
   * Persistence class. Optional for back-compat: legacy records without this
   * field are treated as `long_lived` by the load path (see
   * `withDefaultPersistence` in store.ts).
   */
  persistence?: PersistenceClass | undefined;
  text: string;
  summary?: string | undefined;
  importance: number;
  confidence: number;
  freshness: number;
  tags: string[];
  anchors: MemoryAnchor[];
  /** Optional project-local audience. Omitted memories remain general project knowledge. */
  audience?: MemoryAudienceSelector | undefined;
  sources: MemorySourceRef[];
  supersedes?: string[] | undefined;
  supersededBy?: string | undefined;
  contradicts?: string[] | undefined;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt?: string | undefined;
  lastVerifiedAt?: string | undefined;
  /**
   * Why a `stale` memory is stale. `verification` — anchor verification
   * demoted it, so a later passing verification may restore it.
   * `manual` — someone set the status (retirement); automatic passes leave it
   * alone. Absent on records written before the field existed.
   */
  staleReason?: 'verification' | 'manual' | undefined;
  /** Last time the assistant referenced an injected memory (usefulness signal). */
  lastUsedAt?: string | undefined;
  expiresAt?: string | undefined;
  /**
   * How often this memory was injected into context. Approximate: stores batch
   * counter persistence (JSONL) or count process-locally (SQLite); the audit
   * log's `memory.injected` events remain the exact record.
   */
  injectionCount?: number | undefined;
  /** How often an injected memory was referenced by the assistant afterwards. */
  useCount?: number | undefined;
  /**
   * The session that owns a `scope: 'session'` memory. Required for
   * session-scoped writes so retrieval and injection can filter by the
   * requesting session. Undefined for project/user/file/symbol scopes.
   */
  ownerSessionId?: string | undefined;
}

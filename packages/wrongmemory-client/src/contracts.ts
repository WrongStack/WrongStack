// Vendored from WrongMemory (https://github.com/WrongStack/wrongmemory) commit d78559e,
// file packages/client-ts/src/contracts.ts. Do not edit here; update upstream and re-vendor.
/**
 * Wire contracts mirrored from `crates/wrongmemory-contracts` (lib.rs and
 * record.rs). Names are the camelCase wire names. `scripts/check-contract-parity.ts`
 * fails when the method list or ErrorCode set drifts from the Rust source.
 */

export const PROTOCOL_MAJOR = 1;
export const PROTOCOL_MINOR = 0;
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;
export const MAX_AUTH_FRAME_BYTES = 16 * 1024;
export const MAX_PAGE_SIZE = 200;
export const STORAGE_PROFILE_ID = 'sage-sqlite-v5-baseline';
export const EXTENSION_PROFILE_ID = 'wrongmemory-ext-v1';
export const SEMANTIC_PROFILE_ID = 'wrongmemory-native-slice-v0';

export const ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'PROTOCOL_UNSUPPORTED',
  'PROFILE_UNSUPPORTED',
  'PROJECT_NOT_FOUND',
  'NOT_FOUND',
  'STORE_IDENTITY_CONFLICT',
  'OWNER_CONFLICT',
  'READ_ONLY',
  'REVISION_CONFLICT',
  'IDEMPOTENCY_MISMATCH',
  'INVALID_REQUEST',
  'METHOD_NOT_FOUND',
  'NOT_IMPLEMENTED',
  'QUEUE_SATURATED',
  'DATABASE_BUSY',
  'DATABASE_CORRUPT',
  'DISK_FULL',
  'SHUTTING_DOWN',
  'DEADLINE_EXCEEDED',
  'STORE_UNAVAILABLE',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Client-side codes for failures that never reached the daemon. */
export type ClientErrorCode = 'UNAVAILABLE' | 'TRANSPORT' | 'PROTOCOL';

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

export const METHODS = {
  DAEMON_HEALTH: 'daemon.health',
  DAEMON_SHUTDOWN: 'daemon.shutdown',
  PROJECT_REGISTER: 'project.register',
  PROJECT_LIST: 'project.list',
  PROJECT_GET: 'project.get',
  PROJECT_DETACH: 'project.detach',
  GRANT_CREATE: 'grant.create',
  GRANT_LIST: 'grant.list',
  GRANT_REVOKE: 'grant.revoke',
  SESSION_ACQUIRE: 'session.acquire',
  SESSION_RELEASE: 'session.release',
  MEMORY_SEARCH: 'memory.search',
  MEMORY_GET: 'memory.get',
  MEMORY_FOR_PATH: 'memory.forPath',
  MEMORY_REMEMBER: 'memory.remember',
  CANDIDATE_LIST: 'candidate.list',
  CANDIDATE_PROPOSE: 'candidate.propose',
  CANDIDATE_ACCEPT: 'candidate.accept',
  CANDIDATE_REJECT: 'candidate.reject',
  CANDIDATE_RESOLVE: 'candidate.resolve',
  MEMORY_UPDATE: 'memory.update',
  MEMORY_FEEDBACK: 'memory.feedback',
  MEMORY_DELETE: 'memory.delete',
  MEMORY_RECORD_USAGE: 'memory.recordUsage',
  MEMORY_LIST_PAGE: 'memory.listPage',
  MEMORY_RELATED: 'memory.related',
  MEMORY_FOR_AUDIENCE: 'memory.forAudience',
  MEMORY_FOR_FILE: 'memory.forFile',
  MEMORY_UNIFIED_SEARCH: 'memory.unifiedSearch',
  MEMORY_GRAPH: 'memory.graph',
  MEMORY_STATS: 'memory.stats',
  MEMORY_RECOVER: 'memory.recover',
  MEMORY_BACKFILL: 'memory.backfill',
  MEMORY_HYGIENE: 'memory.hygiene',
  MEMORY_VERIFY: 'memory.verify',
  MEMORY_IMPORT_LEGACY: 'memory.importLegacy',
  MEMORY_LEGACY_FORGET: 'memory.legacyForget',
  MEMORY_LEGACY_CONSOLIDATE: 'memory.legacyConsolidate',
  MEMORY_LEGACY_CLEAR: 'memory.legacyClear',
  MAINTENANCE_STATUS: 'maintenance.status',
  MAINTENANCE_CONFIGURE: 'maintenance.configure',
  MAINTENANCE_RUN: 'maintenance.run',
  JOBS_LIST: 'jobs.list',
  JOBS_GET: 'jobs.get',
  JOBS_CANCEL: 'jobs.cancel',
  EVENTS_SINCE: 'events.since',
} as const;
export type Method = (typeof METHODS)[keyof typeof METHODS];

export type Action = 'read' | 'propose' | 'write' | 'curate' | 'admin';
export type PolicyProfile = 'read-only' | 'read-propose' | 'writer' | 'curator';

export type Credential =
  | { kind: 'host'; token: string }
  | { kind: 'grant'; grantId: string; secret: string };

export interface AuthRequest {
  protocolMajor: number;
  protocolMinor: number;
  credential: Credential;
  clientName: string;
  clientVersion: string;
}

export interface Limits {
  maxFrameBytes: number;
  maxPageSize: number;
  maxInflight: number;
}

export interface PrincipalInfo {
  principalId: string;
  kind: 'host' | 'grant';
  profile: PolicyProfile | null;
  projects: string[] | null;
}

export interface Hello {
  daemonInstanceId: string;
  daemonVersion: string;
  protocolMajor: number;
  protocolMinor: number;
  storageProfileId: string;
  extensionProfileId: string;
  semanticProfileId: string;
  capabilities: string[];
  limits: Limits;
  principal: PrincipalInfo;
}

export type AuthResponse = { status: 'ok'; hello: Hello } | { status: 'error'; error: ErrorBody };

export interface Request {
  protocol: number;
  requestId: string;
  method: string;
  projectId?: string;
  params: unknown;
  idempotencyKey?: string;
}

export interface Response {
  requestId: string;
  result?: unknown;
  error?: ErrorBody;
}

export interface EndpointInfo {
  endpoint: string;
  daemonInstanceId: string;
  daemonVersion: string;
  pid: number;
  protocolMajor: number;
  protocolMinor: number;
  startedAtMs: number;
}

export interface Health {
  daemonInstanceId: string;
  daemonVersion: string;
  pid: number;
  uptimeMs: number;
  dataRoot: string;
  sqliteVersion: string;
  projects: number;
  openStores: number;
  connections: number;
  draining: boolean;
}

export type StoreKind = 'adopted' | 'managed';
export type Admission = 'read-write' | 'read-only' | 'refused';

export interface RegisterProjectParams {
  root: string;
  displayName?: string;
  storeKind: StoreKind;
  write?: boolean;
  forceOwner?: boolean;
}

export interface ProjectInfo {
  projectId: string;
  displayName: string;
  root: string;
  storePath: string;
  storeKind: StoreKind;
  admission: Admission;
  admissionReason: string;
  ownerEpoch: number;
  storageProfileId: string | null;
  createdAtMs: number;
}

export interface RegisterProjectResult {
  project: ProjectInfo;
  created: boolean;
}

export interface GrantCreateParams {
  label: string;
  profile: PolicyProfile;
  projects: string[];
  expiresAtMs?: number;
}

export interface GrantInfo {
  grantId: string;
  label: string;
  profile: PolicyProfile;
  projects: string[];
  createdAtMs: number;
  expiresAtMs: number | null;
  revokedAtMs: number | null;
}

/** `grant.create` reply: the secret is stored owner-private, never echoed. */
export interface GrantCreateReply {
  grant: GrantInfo;
  secretFile: string;
}

export interface SessionAcquireParams {
  hostSessionId?: string;
}

export interface SessionInfo {
  sessionId: string;
  daemonIssued: boolean;
}

// ─── Records (record.rs) ────────────────────────────────────────────────────

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
] as const;
export type SageKind = (typeof SAGE_KINDS)[number];
export const SAGE_SCOPES = ['project', 'user', 'session', 'file', 'symbol'] as const;
export type SageScope = (typeof SAGE_SCOPES)[number];
export const SAGE_STATUSES = [
  'active',
  'stale',
  'superseded',
  'contradicted',
  'archived',
  'deleted',
] as const;
export type SageStatus = (typeof SAGE_STATUSES)[number];

/** Unknown fields survive a decode/encode cycle (index signature). */
export interface MemoryAnchor {
  type: string;
  path?: string;
  symbol?: string;
  command?: string;
  role?: string;
  [extra: string]: unknown;
}

export interface MemoryAudience {
  roles?: string[];
  taskTypes?: string[];
  modes?: string[];
  [extra: string]: unknown;
}

export interface MemorySource {
  type: string;
  sessionId?: string;
  path?: string;
  command?: string;
  [extra: string]: unknown;
}

export interface ValidityCheck {
  type: 'source_contains';
  path: string;
  text: string;
}

export interface MemoryValidity {
  statement: string;
  checks?: ValidityCheck[];
}

/** Vocabulary fields are strings: newer SAGE values must still decode. */
export interface SageRecord {
  id: string;
  revision: number;
  scope: string;
  legacyScope?: string;
  kind: string;
  status: string;
  contextPolicy?: string;
  persistence?: string;
  text: string;
  summary?: string;
  importance: number;
  confidence: number;
  freshness: number;
  tags: string[];
  anchors: MemoryAnchor[];
  audience?: MemoryAudience;
  sources: MemorySource[];
  validity?: MemoryValidity;
  feedback?: unknown[];
  supersedes?: string[];
  supersededBy?: string;
  contradicts?: string[];
  createdAt: string;
  updatedAt: string;
  lastAccessedAt?: string;
  lastVerifiedAt?: string;
  staleReason?: string;
  lastUsedAt?: string;
  expiresAt?: string;
  injectionCount?: number;
  useCount?: number;
  ownerSessionId?: string;
  [extra: string]: unknown;
}

export interface MemoryCandidate {
  schemaVersion: number;
  id: string;
  status: string;
  text: string;
  kind: string;
  scope: string;
  ownerSessionId?: string;
  confidence: number;
  importance: number;
  tags: string[];
  anchors: MemoryAnchor[];
  audience?: MemoryAudience;
  sources: MemorySource[];
  validity?: MemoryValidity;
  createdAt: string;
  updatedAt: string;
  memoryId?: string;
  reason?: string;
  targetMemoryId?: string;
  targetRevision?: number;
  reviewReason?: string;
  suggestedAction?: string;
  supersedesMemoryIds?: string[];
  supersedesRevisions?: number[];
  [extra: string]: unknown;
}

export interface SearchParams {
  query: string;
  limit?: number;
  kinds?: string[];
  statuses?: string[];
}

export interface ForPathParams {
  path: string;
  limit?: number;
}

export interface SearchHit {
  memory: SageRecord;
  /** `fts`, `like`, `path`, `recent`; scores are not comparable across channels. */
  channel: string;
  score: number;
  reasons?: string[];
}

export interface SearchResult {
  hits: SearchHit[];
  truncated: boolean;
  corruptSkipped: number;
  channel: string;
}

export interface GetParams {
  id: string;
}

export interface RememberParams {
  text: string;
  kind?: string;
  scope?: string;
  persistence?: string;
  tags?: string[];
  anchors?: MemoryAnchor[];
  audience?: MemoryAudience;
  sources?: MemorySource[];
  validity?: MemoryValidity;
  importance?: number;
  confidence?: number;
  freshness?: number;
  expiresAt?: string;
}

export interface ProposeParams {
  text: string;
  kind?: string;
  scope?: string;
  tags?: string[];
  anchors?: MemoryAnchor[];
  audience?: MemoryAudience;
  sources?: MemorySource[];
  validity?: MemoryValidity;
  importance?: number;
  confidence?: number;
  targetMemoryId?: string;
  targetRevision?: number;
  reviewReason?: string;
  suggestedAction?: string;
}

export interface CandidateListParams {
  status?: string;
  limit?: number;
}

export interface CandidateListResult {
  candidates: MemoryCandidate[];
  truncated: boolean;
  corruptSkipped: number;
}

export interface MutationOutcome {
  /** `memory-committed` or `candidate-pending`. */
  outcome: string;
  id: string;
  revision?: number;
  /** True when served from a durable receipt (retry). */
  replayed: boolean;
  record: unknown;
}

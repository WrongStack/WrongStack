import type { HqSageRecord } from '@wrongstack/core/hq';
import type {
  MemoryEntry,
  MemoryHealth,
  MemoryRelevanceContext,
  MemoryScope,
  ScoredEntry,
} from '@wrongstack/core/types';
import type {
  SageDoctorOptions,
  SageDoctorReport,
  SageMaintenanceStatus,
} from './memory-doctor-types.js';
import type { VectorAugmentHit } from './retrieval/vector-augment.js';
import type { SearchOptions, SearchQuery, SearchResult } from './service-contract.js';
import type {
  CandidateDecision,
  CreateCandidateInput,
  FindMemoriesForFileOptions,
  FindMemoriesForFileResponse,
  ListSagePageOptions,
  ListSagePageResult,
  MemoryCandidate,
  MemoryCandidateResolution,
  MemoryGraphEdge,
  MemoryVerificationResult,
  RememberSageInput,
  Sage,
  SageBackfillOptions,
  SageBackfillReport,
  SageForPathOptions,
  SageHygieneOptions,
  SageHygieneReport,
  SageSearchOptions,
  SageStats,
  SageStatus,
  SessionConsolidationInput,
  SessionConsolidationResult,
  UpdateSageInput,
} from './types.js';

export const SAGE_PROJECT_SERVER_PROTOCOL_VERSION = 1;

/**
 * What the daemon tells a connecting client about itself. Deliberately
 * carries NO secret — see {@link SageProjectServerMetadata}.
 */
export interface SageProjectServerInfo {
  /** Application release; absent on legacy daemons. */
  runtimeVersion?: string | undefined;
  protocolVersion: number;
  pid: number;
  projectRoot: string;
  storageRoot: string;
  endpoint: string;
  startedAt: string;
}

/**
 * `server.json` — the on-disk metadata file, written 0600.
 *
 * WS-028: the `authToken` used to live on {@link SageProjectServerInfo}, which
 * is the payload of the `hello` frame the daemon sends to **every** socket
 * that connects. The token was therefore handed to exactly the caller it was
 * meant to refuse, and the auth gate it fed was decorative: any same-UID
 * process could connect, read the token out of `hello`, and replay it.
 *
 * The token now exists only here. A client proves it could read an owner-only
 * file in the project's own state directory before it may issue a request —
 * which is the boundary the doc claimed all along.
 */
export interface SageProjectServerMetadata extends SageProjectServerInfo {
  /**
   * Per-process auth token. Minted at server startup with
   * `crypto.randomBytes(16)` and required on every `request` and `shutdown`
   * message in `meta.authToken` / `authToken`.
   */
  authToken: string;
}

interface SageProjectServerStatus extends SageProjectServerInfo {
  clients: number;
  pendingRequests: number;
  health: MemoryHealth;
}

export interface SageRequestMetadata {
  /**
   * Server-assigned from a per-connection nonce. Any value supplied by
   * the client is silently overwritten so two different connections
   * can never claim the same `clientId` in the audit log.
   */
  clientId: string;
  /**
   * Per-message auth token. Must equal the `authToken` in the daemon's
   * owner-only `server.json` (WS-028: it used to come from the `hello`
   * frame, which the daemon sends to every connecting socket — so the
   * gate refused nobody). Connections that omit or send a wrong token are
   * dropped at the `request` boundary, not silently logged.
   */
  authToken?: string | undefined;
  traceId?: string | undefined;
  sessionId?: string | undefined;
  /**
   * REMOVED for security: clients used to be able to set this, which
   * let any same-UID process poison the audit log with fake workspace
   * paths. The server now derives `workspaceRoot` from
   * `projectRoot` and ignores any value in `meta`.
   */
  workspaceRoot?: never;
}

export interface SageServerOperations {
  getHqSyncVersion: { args: Record<string, never>; result: string };
  listHqSync: { args: { after: string }; result: HqSageRecord[] };
  applyHqSync: { args: { records: HqSageRecord[] }; result: void };
  ping: { args: Record<string, never>; result: SageProjectServerStatus };
  readAll: { args: Record<string, never>; result: string };
  read: { args: { scope: MemoryScope }; result: string };
  remember: {
    args: {
      text: string;
      scope?: MemoryScope | undefined;
      metadata?: Omit<Partial<MemoryEntry>, 'scope' | 'text' | 'ts'> | undefined;
    };
    result: void;
  };
  forget: { args: { query: string; scope?: MemoryScope | undefined }; result: number };
  consolidate: { args: { scope: MemoryScope }; result: void };
  clear: { args: { scope?: MemoryScope | undefined }; result: void };
  list: {
    args: { scope?: MemoryScope | undefined; limit?: number | undefined };
    result: MemoryEntry[];
  };
  search: {
    args: { query: string; scope?: MemoryScope | undefined; limit?: number | undefined };
    result: MemoryEntry[];
  };
  findRelated: {
    args: { text: string; scope?: MemoryScope | undefined; limit?: number | undefined };
    result: MemoryEntry[];
  };
  scoreRelevant: {
    args: {
      context: MemoryRelevanceContext;
      scope?: MemoryScope | undefined;
      limit?: number | undefined;
    };
    result: ScoredEntry[];
  };
  stats: { args: Record<string, never>; result: SageStats };
  listSage: { args: { statuses?: SageStatus[] | undefined }; result: Sage[] };
  listSagePage: { args: { options?: ListSagePageOptions | undefined }; result: ListSagePageResult };
  getSage: { args: { id: string }; result: Sage | null };
  rememberSage: { args: { input: RememberSageInput }; result: Sage };
  updateSage: { args: { id: string; patch: UpdateSageInput }; result: Sage };
  deleteSage: {
    args: {
      id: string;
      reason?: string | undefined;
      options?: { force?: boolean; neverInject?: boolean } | undefined;
    };
    result: void;
  };
  retrieveForPath: { args: { options: SageForPathOptions }; result: Sage[] };
  searchSage: {
    // The full option set, not a subset: the daemon forwards these verbatim,
    // and a narrower type here silently drops the audience and all-terms
    // gates that automatic injection depends on.
    args: { query: string; options?: SageSearchOptions | undefined };
    result: Sage[];
  };
  /**
   * Rich variant of `searchSage` that returns per-channel score
   * breakdowns (lexical / vector / RRF final, with a `source`
   * attribution). Used by the WebUI's memory panel to surface WHY
   * a memory was returned — same shape as the `memory_search_explain`
   * tool, but reachable over IPC.
   *
   * Optional on the protocol level: clients should fall back to
   * `searchSage` when the daemon returns a not-implemented error.
   * The shape is identical to `VectorAugmentHit` so the consumer can
   * branch on `source` / `vectorScore` uniformly with the in-process
   * variant.
   */
  searchSageWithBreakdown: {
    args: { query: string; options?: SageSearchOptions | undefined };
    result: VectorAugmentHit[];
  };
  unifiedSearch: {
    args: { query: SearchQuery; options?: SearchOptions | undefined };
    result: SearchResult;
  };
  findRelatedSage: {
    args: {
      memoryIds: string[];
      options?: {
        limit?: number;
        maxDepth?: number;
        includeStatuses?: SageStatus[];
        includeAudienceScoped?: boolean;
        sessionId?: string | undefined;
        includeAllSessions?: boolean | undefined;
      };
    };
    result: Sage[];
  };
  recordInjection: {
    args: { memoryIds: string[]; trigger: string; sessionId?: string | undefined };
    result: void;
  };
  recordUse: {
    args: { memoryIds: string[]; source: string; sessionId?: string | undefined };
    result: void;
  };
  retrieveForAudience: {
    args: {
      context: { role?: string; taskType?: string; mode?: string };
      limit?: number | undefined;
      sessionId?: string | undefined;
      includeAllSessions?: boolean | undefined;
    };
    result: Sage[];
  };
  graphFor: {
    args: { query: string; maxDepth?: number | undefined; limit?: number | undefined };
    result: MemoryGraphEdge[];
  };
  verify: { args: { memoryId?: string | undefined }; result: MemoryVerificationResult[] };
  verifyForPaths: { args: { paths: string[] }; result: MemoryVerificationResult[] };
  hygiene: {
    args: {
      options?: SageHygieneOptions | undefined;
      automatic?: boolean | undefined;
    };
    result: SageHygieneReport;
  };
  listCandidates: {
    args: { includeResolved?: boolean | undefined };
    result: MemoryCandidate[];
  };
  createCandidate: { args: { input: CreateCandidateInput }; result: MemoryCandidate };
  resolveCandidate: {
    args: {
      candidateId: string;
      decision: CandidateDecision;
      reason?: string | undefined;
    };
    result: MemoryCandidateResolution | undefined;
  };
  acceptCandidate: { args: { candidateId: string }; result: Sage | undefined };
  rejectCandidate: {
    args: { candidateId: string; reason: string };
    result: boolean;
  };
  recoverSage: {
    args: { id: string; reason?: string | undefined };
    result: Sage;
  };
  backfillRecoverable: {
    args: { options?: SageBackfillOptions | undefined };
    result: SageBackfillReport;
  };
  findMemoriesForFile: {
    args: { filePath: string; options?: FindMemoriesForFileOptions | undefined };
    result: FindMemoriesForFileResponse;
  };
  readAudit: {
    args: { limit?: number | undefined };
    result: import('./types.js').SageAuditRecord[];
  };
  importLegacyFiles: {
    args: { files: string[] };
    result: import('./types.js').LegacyImportResult;
  };
  consolidateSession: {
    args: { input: SessionConsolidationInput };
    result: SessionConsolidationResult;
  };
  /**
   * Daemon-owned maintenance: `schedule` registers the host's hygiene options
   * and arms the periodic pass; `status` only reports. Older daemons answer
   * with an unknown-operation error, which hosts treat as "not supported".
   */
  maintenance: {
    args: { action: 'schedule' | 'status'; options?: SageHygieneOptions | undefined };
    result: SageMaintenanceStatus;
  };
  /** Health report plus optional named repairs (see sqlite-store-doctor.ts). */
  doctor: {
    args: { options?: SageDoctorOptions | undefined };
    result: SageDoctorReport;
  };
}

export type SageServerOperationName = keyof SageServerOperations;

// ─── H9: shallow dispatch-args validation (docs/archive/plans/sage-phase4-design.md) ───

/**
 * Shallow shape kinds a required dispatch arg may take. Deliberately NOT a
 * schema language: only existence and primitive/array/object shape are
 * checked, unknown fields are tolerated, and nested shapes are left to the
 * store methods (the same minimum-validation philosophy as
 * `validateMemoryShape`). Optional args are never listed — validation is for
 * required fields only.
 */
export type SageFieldKind = 'string' | 'number' | 'boolean' | 'string[]' | 'object' | 'any';

/** `[fieldName, kind]` for one required dispatch arg. */
export type SageFieldSpec = readonly [field: string, kind: SageFieldKind];

/**
 * Required top-level args per operation, keyed by {@link SageServerOperationName}.
 *
 * The `satisfies` makes adding a new operation without declaring (or
 * deliberately waiving) its required-args spec a compile error, so the table
 * cannot drift behind `SageServerOperations`. Ops whose args are fully
 * optional declare `[]`; their handlers already tolerate `undefined` args.
 *
 * Ops NOT listed with strict kinds on purpose: nested payloads
 * (`rememberSage.input`, `updateSage.patch`, `createCandidate.input`,
 * `consolidateSession.input`, …) are validated as `object` here and checked
 * in depth by the store methods they are handed to (secret guard,
 * `validateMemoryShape`, `clamp01`, decision policy). Validating those shapes
 * here would duplicate that logic and drift against it.
 */
export const SAGE_DISPATCH_FIELD_SPECS = {
  getHqSyncVersion: [],
  listHqSync: [['after', 'string']],
  applyHqSync: [['records', 'any']],
  ping: [],
  readAll: [],
  read: [['scope', 'string']],
  remember: [['text', 'string']],
  forget: [['query', 'string']],
  consolidate: [['scope', 'string']],
  clear: [],
  list: [],
  search: [['query', 'string']],
  findRelated: [['text', 'string']],
  scoreRelevant: [['context', 'object']],
  stats: [],
  listSage: [],
  listSagePage: [],
  getSage: [['id', 'string']],
  rememberSage: [['input', 'object']],
  updateSage: [
    ['id', 'string'],
    ['patch', 'object'],
  ],
  deleteSage: [['id', 'string']],
  retrieveForPath: [['options', 'object']],
  searchSage: [['query', 'string']],
  searchSageWithBreakdown: [['query', 'string']],
  unifiedSearch: [['query', 'object']],
  findRelatedSage: [['memoryIds', 'string[]']],
  recordInjection: [
    ['memoryIds', 'string[]'],
    ['trigger', 'string'],
  ],
  recordUse: [
    ['memoryIds', 'string[]'],
    ['source', 'string'],
  ],
  retrieveForAudience: [['context', 'object']],
  graphFor: [['query', 'string']],
  verify: [],
  verifyForPaths: [['paths', 'string[]']],
  hygiene: [],
  listCandidates: [],
  createCandidate: [['input', 'object']],
  resolveCandidate: [
    ['candidateId', 'string'],
    ['decision', 'string'],
  ],
  acceptCandidate: [['candidateId', 'string']],
  rejectCandidate: [
    ['candidateId', 'string'],
    ['reason', 'string'],
  ],
  recoverSage: [['id', 'string']],
  backfillRecoverable: [],
  findMemoriesForFile: [['filePath', 'string']],
  readAudit: [],
  importLegacyFiles: [['files', 'string[]']],
  consolidateSession: [['input', 'object']],
  maintenance: [['action', 'string']],
  doctor: [],
} as const satisfies Record<SageServerOperationName, readonly SageFieldSpec[]>;

function sageFieldMatchesKind(value: unknown, kind: SageFieldKind): boolean {
  switch (kind) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'string[]':
      return Array.isArray(value) && value.every((item) => typeof item === 'string');
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'any':
      return true;
  }
}

export class SageInvalidArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSageRequestArgs';
  }
}

/**
 * Shallow dispatch-args check for one operation (H9,
 * docs/archive/plans/sage-phase4-design.md).
 *
 * Returns `null` when `rawArgs` satisfies the op's required-field spec;
 * otherwise a human-readable reason naming the first offending field. The
 * dispatch head turns a non-null result into an `InvalidSageRequestArgs`
 * error, which the connection handler renders as the response frame's
 * `errorName` — the same wire shape `UnauthorizedSageRequest` uses.
 */
export function validateDispatchArgs(op: SageServerOperationName, rawArgs: unknown): string | null {
  const spec = SAGE_DISPATCH_FIELD_SPECS[op];
  if (spec.length === 0) return null;
  if (rawArgs === undefined || rawArgs === null) {
    return `missing args object; required: ${spec.map(([field]) => field).join(', ')}`;
  }
  if (typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    return 'args must be an object';
  }
  const args = rawArgs as Record<string, unknown>;
  for (const [field, kind] of spec) {
    const value = args[field];
    if (value === undefined) return `missing required arg "${field}"`;
    if (!sageFieldMatchesKind(value, kind)) return `arg "${field}" must be of type ${kind}`;
  }
  return null;
}

/** Reject malformed args before store access, preserving the IPC error name. */
export function assertDispatchArgs(op: SageServerOperationName, rawArgs: unknown): void {
  const error = validateDispatchArgs(op, rawArgs);
  if (error) throw new SageInvalidArgsError(error);
}

export type SageProjectServerClientMessage =
  | {
      type: 'request';
      id: number;
      op: SageServerOperationName;
      args: unknown;
      meta: SageRequestMetadata;
    }
  | { type: 'cancel'; id: number }
  /**
   * WS-028: `shutdown` now carries the token. It stops the project's SAGE
   * daemon for every client — a denial of service any same-UID process could
   * previously trigger with a single unauthenticated frame. `cancel` needs no
   * token: it is scoped to the sending connection's own in-flight requests.
   */
  | { type: 'shutdown'; id: number; reason?: string | undefined; authToken?: string | undefined };

export type SageProjectServerMessage =
  | ({ type: 'hello' } & SageProjectServerInfo)
  | {
      type: 'event';
      event: string;
      payload: unknown;
      meta?: SageRequestMetadata | undefined;
    }
  | { type: 'response'; id: number; ok: true; result: unknown }
  | {
      type: 'response';
      id: number;
      ok: false;
      error: string;
      errorName?: string | undefined;
    };

export function encodeSageProjectServerMessage(message: object): string {
  return `${JSON.stringify(message)}\n`;
}

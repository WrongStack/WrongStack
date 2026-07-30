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
import type {
  MemoryEntry,
  MemoryHealth,
  MemoryRelevanceContext,
  MemoryScope,
  ScoredEntry,
} from '@wrongstack/core/types';
import type { SearchOptions, SearchQuery, SearchResult } from './service-contract.js';

export const SAGE_PROJECT_SERVER_PROTOCOL_VERSION = 1;

export interface SageProjectServerInfo {
  protocolVersion: number;
  pid: number;
  projectRoot: string;
  storageRoot: string;
  endpoint: string;
  startedAt: string;
}

export interface SageProjectServerStatus extends SageProjectServerInfo {
  clients: number;
  pendingRequests: number;
  health: MemoryHealth;
}

export interface SageRequestMetadata {
  clientId: string;
  traceId?: string | undefined;
  sessionId?: string | undefined;
  workspaceRoot?: string | undefined;
}

export interface SageServerOperations {
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
    };
    result: Sage[];
  };
  graphFor: {
    args: { query: string; maxDepth?: number | undefined; limit?: number | undefined };
    result: MemoryGraphEdge[];
  };
  verify: { args: { memoryId?: string | undefined }; result: MemoryVerificationResult[] };
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
}

export type SageServerOperationName = keyof SageServerOperations;

export type SageProjectServerClientMessage =
  | {
      type: 'request';
      id: number;
      op: SageServerOperationName;
      args: unknown;
      meta: SageRequestMetadata;
    }
  | { type: 'cancel'; id: number }
  | { type: 'shutdown'; id: number; reason?: string | undefined };

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

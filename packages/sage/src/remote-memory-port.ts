import { randomUUID } from 'node:crypto';
import type { EventBus } from '@wrongstack/core/kernel';
import type {
  MemoryCapability,
  MemoryEntry,
  MemoryHealth,
  MemoryPort,
  MemoryRelevanceContext,
  MemoryScope,
  ScoredEntry,
} from '@wrongstack/core/types';
import type { SageRetrieverLike } from './middleware/tool-call-memory.js';
import type { SageServiceLike, SageSurface } from './service-contract.js';
import {
  SageProjectServerConnection,
  type SageProjectServerConnectionState,
} from './project-server-client.js';
import type { SageRequestMetadata, SageServerOperationName } from './project-server-protocol.js';
import type { SageServerOperations } from './project-server-protocol.js';
import type { SageForPathOptions, SageHygieneOptions, SageStoreOptions } from './types.js';

const SAGE_SERVICE_CAPABILITY_ID = 'wrongstack.memory.sage-service.v1';
const SAGE_RETRIEVAL_CAPABILITY_ID = 'wrongstack.memory.retrieval.v1';
const SAGE_SURFACE_CAPABILITY_ID = 'wrongstack.memory.surface.v1';

interface RemoteSageRetrievalCapability extends SageRetrieverLike {
  flushPendingCounters?(): Promise<void>;
  retrieveForAudience?(
    context: { role?: string; taskType?: string; mode?: string },
    limit?: number,
    /**
     * Optional truncation callback. Fires when the SQL prefilter was
     * saturated — the scan window hit `AUDIENCE_MAX_SCAN` before the corpus
     * ran out and more matching rows likely exist beyond it. The remote
     * port cannot forward the callback across IPC, but the interface
     * declares it for parity with the in-process `SageRetrievalCapability`.
     * The server side still emits an internal `memory.audience_truncated`
     * audit event when truncation is detected, so remote callers can
     * observe it through the audit log.
     */
    onTruncated?: (info: { sqlRowsExamined: number; returned: number }) => void,
    /**
     * Session ownership filter. When set, only session-scoped memories owned
     * by this session (plus all non-session memories) are returned. When
     * unset (and `includeAllSessions` is not true), owned session-scoped
     * memories are hidden — only unowned session memories remain visible,
     * so pass `sessionId` to see your own session's records.
     */
    sessionId?: string | undefined,
    /** Admin opt-out: include all sessions' session-scoped memories. */
    includeAllSessions?: boolean | undefined,
  ): Promise<import('./types.js').Sage[]>;
}

export interface ProjectSageMemoryPortOptions
  extends Pick<SageStoreOptions, 'projectRoot' | 'directory' | 'events'> {
  getSessionId?: (() => string | undefined) | undefined;
  /**
   * @deprecated The IPC server now derives `workspaceRoot` from
   * `projectRoot` and rejects any caller-supplied value (audit-log
   * poisoning). This option is preserved only so existing callers do not
   * crash on type-check; it is no longer forwarded over IPC. Set
   * `projectRoot` instead.
   */
  workspaceRoot?: string | undefined;
  clientId?: string | undefined;
}

export class ProjectSageMemoryPort implements MemoryPort {
  private readonly connection: SageProjectServerConnection;
  private readonly clientId: string;
  private readonly events?: EventBus | undefined;
  private readonly getSessionId?: (() => string | undefined) | undefined;
  private traceId?: string | undefined;
  private readonly unsubscribeEvent: () => void;

  private readonly retrievalCapability: RemoteSageRetrievalCapability = {
    retrieveForPath: (options) => this.call('retrieveForPath', { options }),
    searchSage: (query: string, options: unknown) =>
      this.call('searchSage', { query, options } as never),
    // The remote IPC prefers the rich variant when the daemon
    // implements it. Servers that don't ship `searchSageWithBreakdown`
    // (e.g. legacy / non-augmented backends) throw a recognizable
    // "not available" error — we catch it and fall back to the flat
    // `searchSage` shape, wrapping the results as lexical-only
    // breakdown entries so consumers can branch on `source` and
    // `vectorScore` uniformly.
    searchSageWithBreakdown: async (query, options) => {
      try {
        const rows = (await this.call('searchSageWithBreakdown', {
          query,
          options,
        } as never)) as unknown[];
        return rows as never;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!/not available/i.test(message)) {
          throw err;
        }
        const rows = (await this.call('searchSage', {
          query,
          options,
        } as never)) as unknown[];
        return rows.map((memory: unknown, index: number) => {
          const total = rows.length;
          return {
            memory: memory as never,
            vectorScore: null,
            lexicalScore: total <= 1 ? 1 : 1 - index / (total - 1),
            finalScore: total <= 1 ? 1 : 1 - index / (total - 1),
            source: 'lexical' as const,
          };
        });
      }
    },
    findRelatedSage: (memoryIds, options) =>
      this.call('findRelatedSage', options === undefined ? { memoryIds } : { memoryIds, options }),
    recordInjection: (memoryIds, trigger, sessionId) =>
      this.call('recordInjection', { memoryIds, trigger, sessionId }),
    recordUse: (memoryIds, source, sessionId) =>
      this.call('recordUse', { memoryIds, source, sessionId }),
    flushPendingCounters: async () => {},
    retrieveForAudience: (context, limit, _onTruncated, sessionId, includeAllSessions) =>
      this.call('retrieveForAudience', { context, limit, sessionId, includeAllSessions }),
  };

  private readonly surfaceCapability: SageSurface = {
    stats: () => this.call('stats', {}),
    listSage: (statuses) => this.call('listSage', { statuses }),
    listSagePage: (options) => this.call('listSagePage', { options }),
    getSage: (id) => this.call('getSage', { id }),
    rememberSage: (input) => this.call('rememberSage', { input }),
    updateSage: (id, patch) => this.call('updateSage', { id, patch }),
    deleteSage: (id, reason, options) => this.call('deleteSage', { id, reason, options }),
    retrieveForPath: (options) => this.call('retrieveForPath', { options }),
    searchSage: (query, options) => this.call('searchSage', { query, options } as never),
    searchSageWithBreakdown: async (query, options) => {
      const rows = (await this.call('searchSage', { query, options } as never)) as unknown[];
      return rows.map((memory: unknown, index: number) => {
        const total = rows.length;
        return {
          memory: memory as never,
          vectorScore: null,
          lexicalScore: total <= 1 ? 1 : 1 - index / (total - 1),
          finalScore: total <= 1 ? 1 : 1 - index / (total - 1),
          source: 'lexical' as const,
        };
      });
    },
    acceptCandidate: (candidateId) => this.call('acceptCandidate', { candidateId }),
    rejectCandidate: (candidateId, reason) => this.call('rejectCandidate', { candidateId, reason }),
    retrieveForAudience: (context, limit, _onTruncated, sessionId, includeAllSessions) =>
      this.call('retrieveForAudience', { context, limit, sessionId, includeAllSessions }),
    hygiene: (options) => this.call('hygiene', { options }, { timeoutMs: 5 * 60_000 }),
    listCandidates: (includeResolved) => this.call('listCandidates', { includeResolved }),
    createCandidate: (input) => this.call('createCandidate', { input }),
    graphFor: (query, maxDepth, limit) => this.call('graphFor', { query, maxDepth, limit }),
    verify: (memoryId, signal) =>
      this.call('verify', { memoryId }, { signal, timeoutMs: 2 * 60_000 }),
    recoverSage: (id, reason) => this.call('recoverSage', { id, reason }),
    backfillRecoverable: (options) =>
      this.call('backfillRecoverable', { options }, { timeoutMs: 5 * 60_000 }),
    findMemoriesForFile: (filePath, options) =>
      this.call('findMemoriesForFile', { filePath, options }),
    readAudit: (limit) => this.call('readAudit', { limit }),
    importLegacy: (files) => this.call('importLegacyFiles', { files }, { timeoutMs: 2 * 60_000 }),
  };

  private readonly serviceCapability: SageServiceLike = {
    unifiedSearchService: (query, options) => this.call('unifiedSearch', { query, options }),
    readAll: () => this.readAll(),
    read: (scope) => this.read(scope),
    remember: (text, scope, metadata) => this.remember(text, scope, metadata),
    forget: (query, scope) => this.forget(query, scope),
    consolidate: (scope) => this.consolidate(scope),
    clear: (scope) => this.clear(scope),
    list: (scope, limit) => this.list(scope, limit),
    search: (query, scope, limit) => this.search(query, scope, limit),
    getBackend: () => this.getBackend(),
    findRelated: (text, scope, limit) => this.findRelated(text, scope, limit),
    scoreRelevant: (context, scope, limit) => this.scoreRelevant(context, scope, limit),
    hygiene: (options, signal) =>
      this.call('hygiene', { options }, { signal, timeoutMs: 5 * 60_000 }),
    withTraceId: (traceId) => {
      this.withTraceId(traceId);
      return this.serviceCapability;
    },
    retrieveForPath: (options) =>
      this.call('retrieveForPath', { options: options as SageForPathOptions }),
    searchSage: (query, options) => this.call('searchSage', { query, options } as never),
    searchSageWithBreakdown: async (query, options) => {
      const rows = (await this.call('searchSage', { query, options } as never)) as unknown[];
      return rows.map((memory: unknown, index: number) => {
        const total = rows.length;
        return {
          memory: memory as never,
          vectorScore: null,
          lexicalScore: total <= 1 ? 1 : 1 - index / (total - 1),
          finalScore: total <= 1 ? 1 : 1 - index / (total - 1),
          source: 'lexical' as const,
        };
      });
    },
    retrieveForAudience: (context, limit, _onTruncated, sessionId, includeAllSessions) =>
      this.call('retrieveForAudience', { context, limit, sessionId, includeAllSessions }),
    graphFor: (query, maxDepth, limit) => this.call('graphFor', { query, maxDepth, limit }),
    verify: (memoryId, signal) =>
      this.call('verify', { memoryId }, { signal, timeoutMs: 2 * 60_000 }),
    listCandidates: (includeResolved) => this.call('listCandidates', { includeResolved }),
    createCandidate: (input) => this.call('createCandidate', { input }),
    resolveCandidate: (candidateId, decision, reason) =>
      this.call('resolveCandidate', { candidateId, decision, reason }),
    acceptCandidate: (candidateId) => this.call('acceptCandidate', { candidateId }),
    rejectCandidate: (candidateId, reason) => this.call('rejectCandidate', { candidateId, reason }),
    rememberSage: (input) => this.call('rememberSage', { input }),
    updateSage: (id, patch) => this.call('updateSage', { id, patch }),
    deleteSage: (id, reason, options) => this.call('deleteSage', { id, reason, options }),
    recoverSage: (id, reason) => this.call('recoverSage', { id, reason }),
    backfillRecoverable: (options) =>
      this.call('backfillRecoverable', { options }, { timeoutMs: 5 * 60_000 }),
    findMemoriesForFile: (filePath, options) =>
      this.call('findMemoriesForFile', { filePath, options }),
    getSage: (id) => this.call('getSage', { id }),
    listSagePage: (options) => this.call('listSagePage', { options }),
  };

  constructor(options: ProjectSageMemoryPortOptions) {
    this.clientId = options.clientId ?? `sage-client-${process.pid}-${randomUUID()}`;
    this.events = options.events;
    this.getSessionId = options.getSessionId;
    this.connection = new SageProjectServerConnection(options.projectRoot, options.directory);
    this.unsubscribeEvent = this.connection.onEvent((event, payload, meta) => {
      if (!this.events) return;
      const enriched =
        typeof payload === 'object' && payload !== null
          ? {
              ...(payload as Record<string, unknown>),
              ...(meta?.traceId && !('traceId' in payload) ? { traceId: meta.traceId } : {}),
              ...(meta?.sessionId && !('sessionId' in payload)
                ? { sessionId: meta.sessionId }
                : {}),
            }
          : payload;
      (
        this.events as unknown as {
          emit(eventName: string, eventPayload: unknown): void;
        }
      ).emit(event, enriched);
    });
  }

  getConnectionState(): SageProjectServerConnectionState {
    return this.connection.getState();
  }

  onConnectionStateChange(listener: (state: SageProjectServerConnectionState) => void): () => void {
    return this.connection.onStateChange(listener);
  }

  async initialize(): Promise<void> {
    await this.connection.connect();
    await this.call('ping', {}, { timeoutMs: 5_000 });
  }

  readAll(): Promise<string> {
    return this.call('readAll', {});
  }

  read(scope: MemoryScope): Promise<string> {
    return this.call('read', { scope });
  }

  remember(
    text: string,
    scope?: MemoryScope,
    metadata?: Omit<Partial<MemoryEntry>, 'scope' | 'text' | 'ts'>,
  ): Promise<void> {
    return this.call('remember', { text, scope, metadata });
  }

  forget(query: string, scope?: MemoryScope): Promise<number> {
    return this.call('forget', { query, scope });
  }

  consolidate(scope: MemoryScope): Promise<void> {
    return this.call('consolidate', { scope }, { timeoutMs: 2 * 60_000 });
  }

  clear(scope?: MemoryScope): Promise<void> {
    return this.call('clear', { scope });
  }

  list(scope?: MemoryScope, limit?: number): Promise<MemoryEntry[]> {
    return this.call('list', { scope, limit });
  }

  search(query: string, scope?: MemoryScope, limit?: number): Promise<MemoryEntry[]> {
    return this.call('search', { query, scope, limit });
  }

  findRelated(text: string, scope?: MemoryScope, limit?: number): Promise<MemoryEntry[]> {
    return this.call('findRelated', { text, scope, limit });
  }

  scoreRelevant(
    context: MemoryRelevanceContext,
    scope?: MemoryScope,
    limit?: number,
  ): Promise<ScoredEntry[]> {
    return this.call('scoreRelevant', { context, scope, limit });
  }

  hygiene(options?: SageHygieneOptions): Promise<unknown> {
    return this.call('hygiene', { options, automatic: true }, { timeoutMs: 5 * 60_000 });
  }

  getBackend(): unknown {
    return {
      kind: 'sage-project-server',
      connection: this.connection.getState(),
    };
  }

  withTraceId(traceId: string): this {
    this.traceId = traceId;
    return this;
  }

  getCapability<T>(capability: MemoryCapability<T>): T | undefined {
    switch (capability.id) {
      case SAGE_SERVICE_CAPABILITY_ID:
        return this.serviceCapability as unknown as T;
      case SAGE_RETRIEVAL_CAPABILITY_ID:
        return this.retrievalCapability as unknown as T;
      case SAGE_SURFACE_CAPABILITY_ID:
        return this.surfaceCapability as unknown as T;
      default:
        return undefined;
    }
  }

  async health(): Promise<MemoryHealth> {
    try {
      const status = await this.call('ping', {}, { timeoutMs: 5_000 });
      return {
        status: status.health.status,
        backend: 'sage-project-server',
        details: {
          pid: status.pid,
          clients: status.clients,
          pendingRequests: status.pendingRequests,
          storageRoot: status.storageRoot,
          serverBackend: status.health.backend,
        },
      };
    } catch (error) {
      return {
        status: 'unavailable',
        backend: 'sage-project-server',
        details: { error: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  async dispose(): Promise<void> {
    this.unsubscribeEvent();
    this.connection.close();
  }

  private meta(): SageRequestMetadata {
    // Note: `workspaceRoot` is intentionally NOT included. IPC server
    // derives workspace root from `projectRoot` and rejects any attempt
    // to set it via meta (audit-log poisoning).
    return {
      clientId: this.clientId,
      traceId: this.traceId,
      sessionId: this.getSessionId?.(),
    };
  }

  private call<O extends SageServerOperationName>(
    op: O,
    args: SageServerOperations[O]['args'],
    options: { timeoutMs?: number | undefined; signal?: AbortSignal | undefined } = {},
  ): Promise<SageServerOperations[O]['result']> {
    return this.connection.call(op, args, {
      ...options,
      meta: this.meta(),
    });
  }
}

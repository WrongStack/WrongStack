import {
  defineMemoryCapability,
  type MemoryCapability,
  type MemoryHealth,
  type MemoryPort,
  type MemoryStore,
} from '@wrongstack/core/types';
import * as fs from 'node:fs/promises';
import type { SageRetrieverLike } from './middleware/tool-call-memory.js';
import type { SageServiceLike, SageSurface } from './service-contract.js';
import { ProjectSageMemoryPort, type ProjectSageMemoryPortOptions } from './remote-memory-port.js';
import { SqliteSageStore } from './sqlite-store.js';
import type { SageStoreOptions } from './types.js';

export const SAGE_SERVICE_CAPABILITY = defineMemoryCapability<SageServiceLike>(
  'wrongstack.memory.sage-service.v1',
);

export interface SageRetrievalCapability extends SageRetrieverLike {
  flushPendingCounters?(): Promise<void>;
  retrieveForAudience?(
    context: { role?: string; taskType?: string; mode?: string },
    limit?: number,
    /**
     * Optional truncation callback. Fires when the SQL prefilter was
     * saturated — the scan window hit `AUDIENCE_MAX_SCAN` before the corpus
     * ran out and more matching rows likely exist beyond it. When omitted,
     * the store still emits an internal `memory.audience_truncated` audit
     * event so downstream observers (e.g. CLI hygiene teardown) can pick it
     * up without having to thread a callback through every call site.
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

export const SAGE_RETRIEVAL_CAPABILITY = defineMemoryCapability<SageRetrievalCapability>(
  'wrongstack.memory.retrieval.v1',
);
export const SAGE_SURFACE_CAPABILITY = defineMemoryCapability<SageSurface>(
  'wrongstack.memory.surface.v1',
);

export function getSageService(port: MemoryPort): SageServiceLike | undefined {
  return port.getCapability(SAGE_SERVICE_CAPABILITY);
}

export function getSageRetrieval(port: MemoryPort): SageRetrievalCapability | undefined {
  return port.getCapability(SAGE_RETRIEVAL_CAPABILITY);
}

export function getSageSurface(port: MemoryPort): SageSurface | undefined {
  return port.getCapability(SAGE_SURFACE_CAPABILITY);
}

/** Production SQLite backend exposed through the host-facing MemoryPort. */
export class SqliteMemoryPort extends SqliteSageStore implements MemoryPort {
  private readonly retrievalCapability: SageRetrievalCapability = {
    retrieveForPath: (options) =>
      super.retrieveForPath([options.path], {
        path: options.path,
        limit: options.limit,
        includeAncestors: options.includeAncestors,
        includeStatuses: options.includeStatuses,
        includeAudienceScoped: options.includeAudienceScoped,
        sessionId: options.sessionId,
        includeAllSessions: options.includeAllSessions,
      }),
    searchSage: (query: string, options: unknown) => super.searchSage(query, options as never),
    searchSageWithBreakdown: (query: string, options: unknown) =>
      super.searchSageWithBreakdown(query, options as never),
    findRelatedSage: (memoryIds, options) => super.findRelatedSage(memoryIds, options),
    recordInjection: (memoryIds, trigger, sessionId) =>
      super.recordInjection(memoryIds, trigger, sessionId),
    recordUse: (memoryIds, source, sessionId) => super.recordUse(memoryIds, source, sessionId),
    // SqliteSageStore writes injection/use counters to the memories row
    // synchronously inside recordInjection/recordUse. There is no
    // in-memory pending accumulator, so flushPendingCounters is a no-op:
    // the data is already on disk. The capability stays wired (instead of
    // being removed) so the optional chain in CLI hygiene teardown
    // (packages/cli/src/wiring/sage.ts) does not silently skip the call
    // when this port is the backing store. A future optimization may
    // batch counter writes behind a configurable interval; until then,
    // flushPendingCounters is the no-op signal that "everything is already
    // durable".
    flushPendingCounters: async () => {},
    retrieveForAudience: (context, limit, onTruncated, sessionId, includeAllSessions) =>
      super.retrieveForAudience(context, limit, onTruncated, sessionId, includeAllSessions),
  };
  private readonly surfaceCapability: SageSurface = {
    stats: () => super.stats(),
    listSage: (statuses) => super.listSage(statuses),
    listSagePage: (options) => super.listSagePage(options),
    getSage: (id) => super.getSage(id),
    rememberSage: (input) => super.rememberSage(input),
    updateSage: (id, patch) => super.updateSage(id, patch),
    deleteSage: (id, reason, options) => super.deleteSage(id, reason, options),
    retrieveForPath: (options) =>
      super.retrieveForPath([options.path], { ...options, path: options.path }),
    searchSage: (query: string, options: unknown) => super.searchSage(query, options as never),
    searchSageWithBreakdown: (query: string, options: unknown) =>
      super.searchSageWithBreakdown(query, options as never),
    acceptCandidate: (candidateId) => super.acceptCandidate(candidateId),
    rejectCandidate: (candidateId, reason) => super.rejectCandidate(candidateId, reason),
    retrieveForAudience: (context, limit, onTruncated, sessionId, includeAllSessions) =>
      super.retrieveForAudience(context, limit, onTruncated, sessionId, includeAllSessions),
    hygiene: (options) => super.hygiene(options),
    listCandidates: (includeResolved) => super.listCandidates(includeResolved),
    createCandidate: (input) => super.createCandidate(input),
    graphFor: (query, maxDepth, limit) => super.graphFor(query, maxDepth, limit),
    verify: (memoryId, signal) => super.verify(memoryId, signal),
    recoverSage: (id, reason) => super.recoverSage(id, reason),
    backfillRecoverable: (options) => super.backfillRecoverable(options),
    findMemoriesForFile: (filePath, options) => super.findMemoriesForFile(filePath, options),
    readAudit: (limit) => super.readAudit(limit),
    importLegacy: (files) => this.importLegacyFiles(files),
  };
  private readonly serviceCapability: SageServiceLike = {
    unifiedSearchService: (query, options) => super.unifiedSearchService(query, options),
    readAll: () => super.readAll(),
    read: (scope) => super.read(scope),
    remember: (text, scope, metadata) => super.remember(text, scope, metadata),
    forget: (query, scope) => super.forget(query, scope),
    consolidate: (scope) => super.consolidate(scope),
    clear: (scope) => super.clear(scope),
    list: (scope, limit) => super.list(scope, limit),
    search: (query, scope, limit) => super.search(query, scope, limit),
    findRelated: (text, scope, limit) => super.search(text, scope, limit),
    scoreRelevant: async (context, scope, limit) =>
      (await super.search(context.currentTask, scope, limit)).map((entry, index) => ({
        ...entry,
        score: Math.max(0.1, 1 - index * 0.05),
        matchReason: 'SAGE lexical search',
      })),
    hygiene: (options) => super.hygiene(options),
    withTraceId: (traceId) => {
      this.withTraceId(traceId);
      return this.serviceCapability;
    },
    retrieveForPath: (options) =>
      super.retrieveForPath([options.path], { ...options, path: options.path }),
    searchSage: (query: string, options: unknown) => super.searchSage(query, options as never),
    searchSageWithBreakdown: (query: string, options: unknown) =>
      super.searchSageWithBreakdown(query, options as never),
    retrieveForAudience: (context, limit, onTruncated, sessionId, includeAllSessions) =>
      super.retrieveForAudience(context, limit, onTruncated, sessionId, includeAllSessions),
    graphFor: (query, maxDepth, limit) => super.graphFor(query, maxDepth, limit),
    verify: (memoryId, signal) => super.verify(memoryId, signal),
    listCandidates: (includeResolved) => super.listCandidates(includeResolved),
    createCandidate: (input) => super.createCandidate(input),
    resolveCandidate: (candidateId, decision, reason) =>
      super.resolveCandidate(candidateId, decision, reason),
    acceptCandidate: (candidateId) => super.acceptCandidate(candidateId),
    rejectCandidate: (candidateId, reason) => super.rejectCandidate(candidateId, reason),
    rememberSage: (input) => super.rememberSage(input),
    updateSage: (id, patch) => super.updateSage(id, patch),
    deleteSage: (id, reason, options) => super.deleteSage(id, reason, options),
    recoverSage: (id, reason) => super.recoverSage(id, reason),
    backfillRecoverable: (options) => super.backfillRecoverable(options),
    findMemoriesForFile: (filePath, options) => super.findMemoriesForFile(filePath, options),
    getSage: (id) => super.getSage(id),
    listSagePage: (options) => super.listSagePage(options),
  };

  private async importLegacyFiles(files: string[]) {
    const result = { imported: 0, skipped: 0, files: 0 };
    for (const file of files) {
      const imported = await super.importLegacy(await fs.readFile(file, 'utf8'));
      result.imported += imported.imported;
      result.skipped += imported.skipped;
      result.files++;
    }
    return result;
  }

  override withTraceId(traceId: string): this {
    super.withTraceId(traceId);
    return this;
  }

  getCapability<T>(capability: MemoryCapability<T>): T | undefined {
    if (capability.id === SAGE_RETRIEVAL_CAPABILITY.id) {
      return this.retrievalCapability as unknown as T;
    }
    if (capability.id === SAGE_SURFACE_CAPABILITY.id) {
      return this.surfaceCapability as unknown as T;
    }
    if (capability.id === SAGE_SERVICE_CAPABILITY.id) {
      return this.serviceCapability as unknown as T;
    }
    return undefined;
  }

  async health(): Promise<MemoryHealth> {
    try {
      await this.initialize();
      return { status: 'ready', backend: 'sqlite' };
    } catch (error) {
      return {
        status: 'unavailable',
        backend: 'sqlite',
        details: { error: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  async dispose(): Promise<void> {
    // Production teardown sequence: drain every queued mutation so a close()
    // call never lands under an in-flight BEGIN IMMEDIATE / file lock /
    // prepared-statement run. Without the drain, a remember / inject /
    // counter increment that was still running when the host tore down the
    // port would close the DB handle from under it, throwing inside the
    // caller's awaited promise with a confusing stack trace.
    await this.drainMutations();
    this.close();
  }
}

/**
 * Compatibility wrapper for third-party implementations of the legacy Core
 * MemoryStore. It deliberately exposes no optional SAGE capability.
 */
export class LegacyMemoryPortAdapter implements MemoryPort {
  constructor(
    private readonly store: MemoryStore,
    private readonly backend = 'legacy',
  ) {}

  async initialize(): Promise<void> {}

  readAll(): Promise<string> {
    return this.store.readAll();
  }

  read(...args: Parameters<MemoryStore['read']>): ReturnType<MemoryStore['read']> {
    return this.store.read(...args);
  }

  remember(...args: Parameters<MemoryStore['remember']>): ReturnType<MemoryStore['remember']> {
    return this.store.remember(...args);
  }

  forget(...args: Parameters<MemoryStore['forget']>): ReturnType<MemoryStore['forget']> {
    return this.store.forget(...args);
  }

  consolidate(
    ...args: Parameters<MemoryStore['consolidate']>
  ): ReturnType<MemoryStore['consolidate']> {
    return this.store.consolidate(...args);
  }

  clear(...args: Parameters<MemoryStore['clear']>): ReturnType<MemoryStore['clear']> {
    return this.store.clear(...args);
  }

  list(...args: Parameters<MemoryStore['list']>): ReturnType<MemoryStore['list']> {
    return this.store.list(...args);
  }

  search(...args: Parameters<MemoryStore['search']>): ReturnType<MemoryStore['search']> {
    return this.store.search(...args);
  }

  getBackend(): unknown {
    return this.store.getBackend?.();
  }

  findRelated(...args: Parameters<NonNullable<MemoryStore['findRelated']>>) {
    return this.store.findRelated?.(...args) ?? Promise.resolve([]);
  }

  scoreRelevant(...args: Parameters<NonNullable<MemoryStore['scoreRelevant']>>) {
    return this.store.scoreRelevant?.(...args) ?? Promise.resolve([]);
  }

  hygiene(...args: Parameters<NonNullable<MemoryStore['hygiene']>>) {
    return this.store.hygiene?.(...args) ?? Promise.resolve(undefined);
  }

  withTraceId(traceId: string): this {
    this.store.withTraceId(traceId);
    return this;
  }

  getCapability<T>(_capability: MemoryCapability<T>): T | undefined {
    return undefined;
  }

  async health(): Promise<MemoryHealth> {
    return { status: 'ready', backend: this.backend };
  }

  async dispose(): Promise<void> {}
}
export function createSqliteMemoryPort(options: SageStoreOptions): MemoryPort {
  return new SqliteMemoryPort(options);
}

/**
 * Production project memory port.
 *
 * Normal hosts connect to the detached per-project SAGE server so SQLite,
 * hygiene, counters, and mutation ordering have exactly one owner. Tests and
 * explicit offline recovery may opt into the direct store; production never
 * silently falls back because that would recreate split-brain memory.
 */
export function createProjectSageMemoryPort(options: ProjectSageMemoryPortOptions): MemoryPort {
  const explicitInline = process.env['WRONGSTACK_SAGE_INLINE'] === '1';
  const testInline =
    process.env['VITEST'] === 'true' ||
    process.env['VITEST_WORKER_ID'] !== undefined ||
    process.env['NODE_ENV'] === 'test';
  if (explicitInline || testInline) return new SqliteMemoryPort(options);
  return new ProjectSageMemoryPort(options);
}

export { ProjectSageMemoryPort, type ProjectSageMemoryPortOptions };

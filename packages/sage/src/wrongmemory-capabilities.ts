/**
 * The WrongMemory port's three capability objects
 * (`wrongstack.memory.sage-service.v1`, `wrongstack.memory.retrieval.v1`,
 * `wrongstack.memory.surface.v1`), built as delegating factories over the
 * operations tier so the tier files stay cohesive.
 */
import type {
  MemoryEntry,
  MemoryRelevanceContext,
  MemoryScope,
  ScoredEntry,
} from '@wrongstack/contracts/types';
import type { SageRetrievalCapability } from './memory-port.js';
import type { SageServiceLike, SageSurface } from './service-contract.js';
import type { WrongMemorySageOps } from './wrongmemory-sage-ops.js';

/**
 * The service capability additionally reaches the legacy `MemoryStore`
 * surface, which only the concrete `WrongMemoryPort` implements.
 */
export interface WrongMemoryServiceAdapter extends WrongMemorySageOps {
  readonly readAll: () => Promise<string>;
  readonly read: (scope: MemoryScope) => Promise<string>;
  readonly remember: (
    text: string,
    scope?: MemoryScope,
    metadata?: Omit<Partial<MemoryEntry>, 'scope' | 'text' | 'ts'>,
  ) => Promise<void>;
  readonly forget: (query: string, scope?: MemoryScope) => Promise<number>;
  readonly consolidate: (scope: MemoryScope) => Promise<void>;
  readonly clear: (scope?: MemoryScope) => Promise<void>;
  readonly list: (scope?: MemoryScope, limit?: number) => Promise<MemoryEntry[]>;
  readonly search: (query: string, scope?: MemoryScope, limit?: number) => Promise<MemoryEntry[]>;
  readonly getBackend: () => unknown;
  readonly findRelated: (
    text: string,
    scope?: MemoryScope,
    limit?: number,
  ) => Promise<MemoryEntry[]>;
  readonly scoreRelevant: (
    context: MemoryRelevanceContext,
    scope?: MemoryScope,
    limit?: number,
  ) => Promise<ScoredEntry[]>;
  readonly withTraceId: (traceId: string) => unknown;
}

export function buildRetrievalCapability(port: WrongMemorySageOps): SageRetrievalCapability {
  return {
    retrieveForPath: (options) => port.retrieveForPath(options),
    searchSage: (query, options) => port.searchSage(query, options),
    searchSageWithBreakdown: (query, options) => port.searchSageWithBreakdown(query, options),
    findRelatedSage: (memoryIds, options) => port.findRelatedSage(memoryIds, options),
    recordInjection: (memoryIds, trigger, sessionId) =>
      port.recordUsage(memoryIds, 'injection', trigger, sessionId),
    recordUse: (memoryIds, source, sessionId) =>
      port.recordUsage(memoryIds, 'use', source, sessionId),
    // Usage counters are durable on the daemon when `recordUsage` returns.
    flushPendingCounters: async () => {},
    verifyForPaths: (paths, signal) => port.verifyForPaths(paths, signal),
    retrieveForAudience: (context, limit, onTruncated, sessionId, includeAllSessions) =>
      port.retrieveForAudience(context, limit, onTruncated, sessionId, includeAllSessions),
  };
}

export function buildSurfaceCapability(port: WrongMemorySageOps): SageSurface {
  return {
    stats: () => port.stats(),
    listSage: (statuses) => port.listSage(statuses),
    listSagePage: (options) => port.listSagePage(options),
    getSage: (id) => port.getSage(id),
    rememberSage: (input) => port.rememberSage(input),
    updateSage: (id, patch) => port.updateSage(id, patch),
    deleteSage: (id, reason, options) => port.deleteSage(id, reason, options),
    retrieveForPath: (options) => port.retrieveForPath(options),
    searchSageWithBreakdown: (query, options) => port.searchSageWithBreakdown(query, options),
    searchSage: (query, options) => port.searchSage(query, options),
    acceptCandidate: (candidateId) => port.acceptCandidate(candidateId),
    rejectCandidate: (candidateId, reason) => port.rejectCandidate(candidateId, reason),
    resolveCandidate: (candidateId, decision, reason) =>
      port.resolveCandidate(candidateId, decision, reason),
    retrieveForAudience: (context, limit, onTruncated, sessionId, includeAllSessions) =>
      port.retrieveForAudience(context, limit, onTruncated, sessionId, includeAllSessions),
    verify: (memoryId, signal) => port.verify(memoryId, signal),
    hygiene: (options) => port.runHygiene(options),
    listCandidates: (includeResolved) => port.listCandidates(includeResolved),
    createCandidate: (input) => port.createCandidate(input),
    graphFor: (query, maxDepth, limit) => port.graphFor(query, maxDepth, limit),
    recoverSage: (id, reason) => port.recoverSage(id, reason),
    backfillRecoverable: (options) => port.backfillRecoverable(options),
    importLegacy: (files) => port.importLegacyFiles(files),
    maintenance: (action, options) => port.maintenance(action, options),
    doctor: (options) => port.doctor(options),
    readAudit: (limit) => port.readAudit(limit),
    findMemoriesForFile: (filePath, options) => port.findMemoriesForFile(filePath, options),
  };
}

export function buildServiceCapability(
  port: WrongMemoryServiceAdapter,
  getServiceCapability: () => SageServiceLike,
): SageServiceLike {
  return {
    unifiedSearchService: (query, options) => port.unifiedSearchService(query, options),
    readAll: () => port.readAll(),
    read: (scope) => port.read(scope),
    remember: (text, scope, metadata) => port.remember(text, scope, metadata),
    forget: (query, scope) => port.forget(query, scope),
    consolidate: (scope) => port.consolidate(scope),
    clear: (scope) => port.clear(scope),
    list: (scope, limit) => port.list(scope, limit),
    search: (query, scope, limit) => port.search(query, scope, limit),
    getBackend: () => port.getBackend(),
    findRelated: (text, scope, limit) => port.findRelated(text, scope, limit),
    scoreRelevant: (context, scope, limit) => port.scoreRelevant(context, scope, limit),
    hygiene: (options) => port.runHygiene(options),
    withTraceId: (traceId) => {
      port.withTraceId(traceId);
      return getServiceCapability();
    },
    retrieveForPath: (options) => port.retrieveForPath(options),
    searchSage: (query, options) => port.searchSage(query, options),
    searchSageWithBreakdown: (query, options) => port.searchSageWithBreakdown(query, options),
    graphFor: (query, maxDepth, limit) => port.graphFor(query, maxDepth, limit),
    verify: (memoryId, signal) => port.verify(memoryId, signal),
    listCandidates: (includeResolved) => port.listCandidates(includeResolved),
    createCandidate: (input) => port.createCandidate(input),
    resolveCandidate: (candidateId, decision, reason) =>
      port.resolveCandidate(candidateId, decision, reason),
    acceptCandidate: (candidateId) => port.acceptCandidate(candidateId),
    rejectCandidate: (candidateId, reason) => port.rejectCandidate(candidateId, reason),
    rememberSage: (input) => port.rememberSage(input),
    updateSage: (id, patch) => port.updateSage(id, patch),
    deleteSage: (id, reason, options) => port.deleteSage(id, reason, options),
    recoverSage: (id, reason) => port.recoverSage(id, reason),
    backfillRecoverable: (options) => port.backfillRecoverable(options),
    retrieveForAudience: (context, limit, onTruncated, sessionId, includeAllSessions) =>
      port.retrieveForAudience(context, limit, onTruncated, sessionId, includeAllSessions),
    findMemoriesForFile: (filePath, options) => port.findMemoriesForFile(filePath, options),
    getSage: (id) => port.getSage(id),
    listSagePage: (options) => port.listSagePage(options),
  };
}

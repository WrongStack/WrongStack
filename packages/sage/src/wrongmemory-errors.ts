/**
 * WrongMemory backend identity, daemon wire limits and the error surface of
 * the WrongMemory port (shared across the wrongmemory-* modules).
 */

export const WRONGMEMORY_BACKEND = 'wrongmemory';

export const SAGE_SERVICE_CAPABILITY_ID = 'wrongstack.memory.sage-service.v1';
export const SAGE_RETRIEVAL_CAPABILITY_ID = 'wrongstack.memory.retrieval.v1';
export const SAGE_SURFACE_CAPABILITY_ID = 'wrongstack.memory.surface.v1';

/** Daemon page ceiling (`MAX_PAGE_SIZE` in the wire contract). */
export const DAEMON_MAX_PAGE = 200;
export const SLOW_OP_TIMEOUT_MS = 5 * 60_000;
export const CANDIDATE_STATUSES = ['pending', 'accepted', 'rejected', 'merged'] as const;
/** `memory.update` accepts exactly these keys; anything else is rejected by the daemon. */
export const UPDATE_KEYS = [
  'text',
  'persistence',
  'kind',
  'status',
  'tags',
  'anchors',
  'importance',
  'confidence',
  'freshness',
  'audience',
  'supersedes',
  'contradicts',
  'supersededBy',
  'validity',
  'sources',
  'expectedRevision',
  'force',
] as const;
export const HYGIENE_KEYS = [
  'retentionDays',
  'sessionRetentionDays',
  'archiveLowConfidenceAfterDays',
  'archiveUnusedAfterDays',
  'unusedMinInjections',
  'verify',
  'verifyDepth',
  'nearDedup',
  'purgeDeletedAfterDays',
] as const;

/** An operation the WrongMemory daemon does not serve. Never retried locally. */
export class WrongMemoryNotImplementedError extends Error {
  readonly code = 'NOT_IMPLEMENTED' as const;
  constructor(readonly operation: string) {
    super(`NOT_IMPLEMENTED: ${operation} is not supported by the WrongMemory backend`);
    this.name = 'WrongMemoryNotImplementedError';
  }
}

/** The WrongMemory daemon is unreachable or the connection dropped. No inline fallback. */
export class WrongMemoryUnavailableError extends Error {
  readonly code = 'WRONGMEMORY_UNAVAILABLE' as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(`WRONGMEMORY_UNAVAILABLE: ${message}`, options);
    this.name = 'WrongMemoryUnavailableError';
  }
}

/** The project root has no WrongMemory registration and this port may not create one. */
export class WrongMemoryProjectNotRegisteredError extends Error {
  readonly code = 'PROJECT_NOT_FOUND' as const;
  constructor(readonly projectRoot: string) {
    super(`PROJECT_NOT_FOUND: ${projectRoot} is not registered with WrongMemory`);
    this.name = 'WrongMemoryProjectNotRegisteredError';
  }
}

/** The subset of {@link WrongMemoryClient} this port uses (test seam). */
export interface WrongMemoryClientLike {
  call<T = unknown>(
    method: string,
    params?: unknown,
    opts?: { projectId?: string; idempotencyKey?: string; timeoutMs?: number },
  ): Promise<T>;
  close(): void;
}

/**
 * WrongMemory-backed {@link MemoryPort}.
 *
 * Talks to the `wrongmemoryd` service over the vendored
 * `@wrongstack/wrongmemory-client`. It exposes the same capability surface as
 * `ProjectSageMemoryPort` (`wrongstack.memory.sage-service.v1`,
 * `wrongstack.memory.retrieval.v1`, `wrongstack.memory.surface.v1`) and maps
 * every operation the daemon supports. Anything the daemon cannot serve
 * throws {@link WrongMemoryNotImplementedError}; this port NEVER falls back to
 * a local SQLite store. A lost daemon surfaces as
 * {@link WrongMemoryUnavailableError} (the next call reconnects).
 *
 * Session visibility: the daemon binds ONE session per connection
 * (`session.acquire{hostSessionId}`). Every call that carries a session
 * (explicit `sessionId` option, else `getSessionId()`) binds it first under a
 * port-wide lock, so a bind and the call it scopes never interleave with
 * another session's call. A call without a session releases the binding, so
 * owned session records stay hidden — the same under-report rule the SQLite
 * store applies. `includeAllSessions` cannot be honored (the daemon exposes no
 * cross-session view) and is ignored.
 *
 * Cohesion: wire types and daemon lifecycle live in `wrongmemory-wire.ts` /
 * `wrongmemory-daemon.ts`, the connection pipeline in
 * `wrongmemory-transport.ts`, SAGE operations in `wrongmemory-sage-ops.ts`
 * (HQ sync and audit in `wrongmemory-sage-sync.ts`), capability objects in
 * `wrongmemory-capabilities.ts` and the shared error surface in
 * `wrongmemory-errors.ts`. This module re-exports the public surface, so
 * importers keep using `./wrongmemory-port.js`.
 */
import type {
  MemoryCapability,
  MemoryEntry,
  MemoryHealth,
  MemoryPort,
  MemoryRelevanceContext,
  MemoryScope,
  ScoredEntry,
} from '@wrongstack/contracts/types';
import { METHODS, type ProjectInfo } from '@wrongstack/wrongmemory-client';
import { legacyToSageScope, sageToLegacyScope, toLegacyEntry } from './legacy-memory-conversion.js';
import type { SageRetrievalCapability } from './memory-port.js';
import type { SageServiceLike, SageSurface } from './service-contract.js';
import { readAllSqliteMemory, readSqliteMemory } from './sqlite-store-legacy-bridge.js';
import type { SageHygieneOptions, SageHygieneReport } from './types.js';
import {
  buildRetrievalCapability,
  buildServiceCapability,
  buildSurfaceCapability,
  type WrongMemoryServiceAdapter,
} from './wrongmemory-capabilities.js';
import {
  SAGE_RETRIEVAL_CAPABILITY_ID,
  SAGE_SERVICE_CAPABILITY_ID,
  SAGE_SURFACE_CAPABILITY_ID,
  SLOW_OP_TIMEOUT_MS,
  WRONGMEMORY_BACKEND,
  WrongMemoryUnavailableError,
} from './wrongmemory-errors.js';
import { WrongMemorySageOps } from './wrongmemory-sage-ops.js';
import type { WrongMemoryPortOptions } from './wrongmemory-transport.js';
import { compact, hostEventsFor, type WireEventsSince } from './wrongmemory-wire.js';

export {
  probeWrongMemoryProject,
  resolveWrongMemoryProject,
  type StartDaemonOptions,
  startWrongMemoryDaemon,
} from './wrongmemory-daemon.js';
export * from './wrongmemory-errors.js';
export type { WrongMemoryPortOptions } from './wrongmemory-transport.js';
export type { WireHqSageRecord } from './wrongmemory-wire.js';

export class WrongMemoryPort extends WrongMemorySageOps implements MemoryPort {
  private traceId: string | undefined;
  private relayTimer: ReturnType<typeof setInterval> | undefined;
  private relayCursor: { generation: number; instance: string } | undefined;
  private relaying = false;

  constructor(options: WrongMemoryPortOptions) {
    super(options);
  }

  private readonly serviceCapability: SageServiceLike = buildServiceCapability(
    this as WrongMemoryServiceAdapter,
    () => this.serviceCapability,
  );

  protected readonly retrievalCapability: SageRetrievalCapability = buildRetrievalCapability(this);
  protected readonly surfaceCapability: SageSurface = buildSurfaceCapability(this);

  /** The host bus it emits on, read by the vector-memory mirror as on the local ports. */
  get events(): WrongMemoryPortOptions['events'] {
    return this.options.events;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    if (this.disposed) throw new WrongMemoryUnavailableError('port disposed');
    await this.ensureProject();
    if (this.disposed) return;
    const interval = this.options.relayIntervalMs ?? 2_000;
    if (this.options.events && interval > 0 && !this.relayTimer) {
      this.relayTimer = setInterval(() => void this.relayChanges(), interval);
      this.relayTimer.unref?.();
      void this.relayChanges();
    }
  }

  /**
   * Relay changes committed through other connections (another host, an MCP
   * bridge, the daemon's scheduler) as the in-process store's host events.
   * The first poll only records the current generation; a resync or a new
   * daemon instance skips ahead without replaying history. Runs on the
   * relay timer; exposed for tests.
   */
  async relayChanges(): Promise<void> {
    if (this.relaying || this.disposed || !this.client || !this.options.events) return;
    this.relaying = true;
    try {
      const cursor = this.relayCursor;
      const feed = await this.scoped<WireEventsSince>(
        METHODS.EVENTS_SINCE,
        compact({ generation: cursor?.generation ?? 0, daemonInstanceId: cursor?.instance }),
        this.session(undefined),
      );
      this.relayCursor = { generation: feed.generation, instance: feed.daemonInstanceId };
      if (!cursor || feed.resync || cursor.instance !== feed.daemonInstanceId) return;
      for (const event of feed.events) {
        if (event.telemetry || (event.origin && this.ownConnections.has(event.origin))) continue;
        for (const [name, payload] of hostEventsFor(event)) this.emit(name, payload);
      }
    } catch {
      // The relay is advisory: a lost daemon surfaces on the next real call.
    } finally {
      this.relaying = false;
    }
  }

  /** Registered project this port serves (after `initialize`). */
  getProject(): ProjectInfo | undefined {
    return this.project;
  }

  async health(): Promise<MemoryHealth> {
    try {
      const client = await this.ensureClient();
      const health = await client.call<Record<string, unknown>>(
        METHODS.DAEMON_HEALTH,
        {},
        {
          timeoutMs: 5_000,
        },
      );
      const project = this.project;
      const readOnly = project !== undefined && project.admission !== 'read-write';
      return {
        status: readOnly ? 'degraded' : 'ready',
        backend: WRONGMEMORY_BACKEND,
        details: {
          ...health,
          projectId: project?.projectId,
          admission: project?.admission,
          admissionReason: project?.admissionReason,
        },
      };
    } catch (error) {
      return {
        status: 'unavailable',
        backend: WRONGMEMORY_BACKEND,
        details: { error: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.relayTimer) clearInterval(this.relayTimer);
    this.relayTimer = undefined;
    this.dropClient();
  }

  /** Drop the connection but stay usable; the next call reconnects. */
  releaseConnection(): void {
    this.dropClient();
  }

  withTraceId(traceId: string): this {
    this.traceId = traceId;
    return this;
  }

  getBackend(): unknown {
    return {
      kind: WRONGMEMORY_BACKEND,
      projectId: this.project?.projectId,
      connected: this.client !== undefined,
      traceId: this.traceId,
    };
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

  // ─── Legacy MemoryStore ────────────────────────────────────────────

  readAll(): Promise<string> {
    return readAllSqliteMemory((scope) => this.read(scope));
  }

  read(scope: MemoryScope): Promise<string> {
    return readSqliteMemory((s) => this.list(s), scope);
  }

  async remember(
    text: string,
    scope: MemoryScope = 'project-memory',
    metadata?: Omit<Partial<MemoryEntry>, 'scope' | 'text' | 'ts'>,
  ): Promise<void> {
    await this.rememberSage({
      text,
      legacyScope: scope,
      scope: legacyToSageScope(scope),
      type: metadata?.type,
      tags: metadata?.tags,
      priority: metadata?.priority,
      confidence: metadata?.confidence,
      sources: metadata?.source
        ? [{ type: 'legacy_memory', excerptHash: metadata.source }]
        : undefined,
    });
  }

  /**
   * Legacy bulk mutations run on the daemon (`memory.legacy*`, curator
   * action) with the baseline semantics, restricted to rows this session
   * can see. A grant without the curator profile gets `FORBIDDEN`.
   */
  async forget(query: string, scope: MemoryScope = 'project-memory'): Promise<number> {
    const result = await this.scoped<{ record: { removed: number } }>(
      METHODS.MEMORY_LEGACY_FORGET,
      { query, scope },
      this.session(undefined),
      { timeoutMs: SLOW_OP_TIMEOUT_MS },
    );
    const removed = result.record.removed;
    if (removed > 0) this.emit('memory.forgotten', { scope, query, removed });
    return removed;
  }

  async consolidate(scope: MemoryScope): Promise<void> {
    const result = await this.scoped<{ record?: { removed?: number } }>(
      METHODS.MEMORY_LEGACY_CONSOLIDATE,
      { scope },
      this.session(undefined),
      { timeoutMs: SLOW_OP_TIMEOUT_MS },
    );
    this.emit('memory.consolidated', { scope, removed: result?.record?.removed ?? 0 });
  }

  /** `clear()` without a scope clears every scope, as the baseline does. */
  async clear(scope?: MemoryScope): Promise<void> {
    const result = await this.scoped<{ record?: { deleted?: number } }>(
      METHODS.MEMORY_LEGACY_CLEAR,
      scope ? { scope } : { all: true },
      this.session(undefined),
      { timeoutMs: SLOW_OP_TIMEOUT_MS },
    );
    if ((result?.record?.deleted ?? 0) > 0) this.emit('memory.cleared', { scope });
  }

  /** Active memories of one legacy scope, newest first (SQLite `list` order). */
  async list(scope: MemoryScope = 'project-memory', limit?: number): Promise<MemoryEntry[]> {
    const memories = (await this.listSage(['active'])).filter(
      (m) => (m.legacyScope ?? sageToLegacyScope(m.scope)) === scope,
    );
    memories.sort((a, b) =>
      a.createdAt === b.createdAt
        ? a.id < b.id
          ? 1
          : a.id > b.id
            ? -1
            : 0
        : a.createdAt < b.createdAt
          ? 1
          : -1,
    );
    const entries = memories.map(toLegacyEntry);
    return limit === undefined ? entries : entries.slice(0, Math.max(0, limit));
  }

  async search(
    query: string,
    scope: MemoryScope = 'project-memory',
    limit?: number,
  ): Promise<MemoryEntry[]> {
    const memories = await this.searchSage(query, limit === undefined ? {} : { limit });
    return memories
      .filter((m) => m.contextPolicy !== 'never')
      .filter((m) => (m.legacyScope ?? sageToLegacyScope(m.scope)) === scope)
      .map(toLegacyEntry);
  }

  findRelated(text: string, scope?: MemoryScope, limit?: number): Promise<MemoryEntry[]> {
    return this.search(text, scope, limit);
  }

  /**
   * Prompt-context relevance, as the in-process SAGE port composes it: the
   * legacy search for the current task, ranked by position.
   */
  async scoreRelevant(
    context: MemoryRelevanceContext,
    scope?: MemoryScope,
    limit?: number,
  ): Promise<ScoredEntry[]> {
    return (await this.search(context.currentTask, scope, limit)).map((entry, index) => ({
      ...entry,
      score: Math.max(0.1, 1 - index * 0.05),
      matchReason: 'SAGE lexical search',
    }));
  }

  hygiene(options?: SageHygieneOptions): Promise<SageHygieneReport> {
    return this.runHygiene(options);
  }
}

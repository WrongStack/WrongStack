import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';

import * as path from 'node:path';
import type { HqPublisher } from '../hq/publisher.js';
import type { EventBus } from '../kernel/events.js';
import { withFileLock } from '../utils/atomic-write.js';
import {
  AGENT_STALE_MS,
  AUTO_COMPACT_INTERVAL_MS,
  CLIENT_STALE_MS,
  LINE_SEPARATOR,
  REGISTRY_CACHE_TTL_MS,
} from './mailbox-constants.js';
import {
  MailboxMessageCache,
  type MailboxMessageFileStat,
} from './mailbox-message-cache.js';
import { statMailboxMessageFile } from './mailbox-message-file-stat.js';
import type { MailboxEventEmitter } from './mailbox-events.js';
import { parseMailboxFile } from './mailbox-parse-state.js';
import { isMessageCompletedForActor } from './global-mailbox-completion.js';
import { assertMailboxNotFenced } from './mailbox-version-fence.js';
import { normalizeMailboxMessageType, serializeAckRecord } from './mailbox-message-codec.js';
import {
  GLOBAL_MAILBOX_CLIENT_REGISTRY_FILE,
  GLOBAL_MAILBOX_FILE,
} from './global-mailbox-paths.js';
import {
  readAgentRegistryFile,
  readClientRegistryFile,
  writeRegistryFile,
} from './mailbox-registry-file.js';
import { selectMailboxQueryCandidates } from './mailbox-query-candidates.js';
import { pruneStaleRegistryEntries } from './mailbox-registry-utils.js';
import {
  ackMailboxFor,
  heartbeatMailboxActor,
  queryMailboxFor,
  registerMailboxActor,
  restoreMailboxFor,
  sendMailboxFor,
  softDeleteMailboxFor,
} from './global-mailbox-actor-methods.js';
import { ackMailboxMany } from './global-mailbox-ack.js';
import { runGlobalMailboxAutoCompact } from './global-mailbox-auto-compact.js';
import { runGlobalMailboxClearAll } from './global-mailbox-clear.js';
import {
  deregisterMailboxClient,
  getMailboxClientStatuses,
  heartbeatMailboxClient,
  purgeMailboxClients,
  registerMailboxClient,
  type GlobalMailboxClientRegistryContext,
} from './global-mailbox-clients.js';
import {
  deregisterMailboxAgent,
  getMailboxAgentStatuses,
  heartbeatMailboxAgent,
  registerMailboxAgent,
  type GlobalMailboxAgentRegistryContext,
} from './global-mailbox-agents.js';
import { runGlobalMailboxPurgeStale } from './global-mailbox-purge-stale.js';
import {
  clearMailboxSingletonCache,
  getOrCreateMailboxInstance,
} from './global-mailbox-singleton-cache.js';
import type {
  AckRecord,
  ActorMailboxMessage,
  AgentHeartbeatInput,
  AgentRegistrationInput,
  AutoCompactOptions,
  AutoCompactResult,
  ClientHeartbeatInput,
  ClientRegistrationInput,
  ClientStatus,
  Mailbox,
  MailboxAckBatchInput,
  MailboxAckInput,
  MailboxActorContext,
  MailboxAgentStatus,
  MailboxMessage,
  MailboxQuery,
  MailboxSendInput,
  PurgeOptions,
  PurgeResult,
  RegisteredAgent,
  RegisteredClient,
} from './mailbox-types.js';
import { isMailboxMessageVisibleTo, normalizeRecipient, sessionRecipient, validateSendType } from './mailbox-types.js';
export { resolveProjectDir } from './global-mailbox-paths.js';

type HqPublisherRef = HqPublisher | (() => HqPublisher | undefined);

export function getSharedMailbox(
  projectDir: string,
  events?: EventBus,
  hqPublisher?: HqPublisherRef,
  opts?: { forceNew?: boolean },
): GlobalMailbox {
  if (opts?.forceNew) {
    return new GlobalMailbox(projectDir, events, hqPublisher);
  }
  const publisherKey = hqPublisher === undefined ? undefined : Object(hqPublisher);
  return getOrCreateMailboxInstance(projectDir, events, publisherKey, () =>
    new GlobalMailbox(projectDir, events, hqPublisher),
  );
}

export function _clearMailboxSingletons(): void {
  clearMailboxSingletonCache();
}

export class GlobalMailbox implements Mailbox {
  readonly messagePath: string;
  readonly registryPath: string;
  readonly clientRegistryPath: string;
  private readonly _events?: EventBus | undefined;
  private readonly _hqPublisher?: HqPublisherRef | undefined;
  readonly eventEmitter?: MailboxEventEmitter | undefined;
  private _registryCache: Map<string, RegisteredAgent> | null = null;
  private _registryCacheAt = 0;
  /**
   * Local cache of the client registry to avoid re-reading on every call.
   * Same reasoning as agent registry cache.
   */
  private _clientRegistryCache: Map<string, RegisteredClient> | null = null;
  /** When the client registry cache was last refreshed from disk (epoch ms). */
  private _clientRegistryCacheAt = 0;
  /** Last time each local agent sent a heartbeat (throttle). */
  private _lastHeartbeat = new Map<string, number>();
  /** Last time each local client sent a heartbeat (throttle). */
  private _lastClientHeartbeat = new Map<string, number>();

  /** Keep heartbeat throttle state bounded to currently registered entities. */
  private pruneHeartbeatThrottleMap(
    throttleMap: Map<string, number>,
    registry: ReadonlyMap<string, unknown>,
  ): void {
    for (const id of throttleMap.keys()) {
      if (!registry.has(id)) throttleMap.delete(id);
    }
  }

  private agentRegistryContext(): GlobalMailboxAgentRegistryContext {
    return {
      registryPath: this.registryPath,
      hqMailboxId: this.hqMailboxId,
      lastHeartbeat: this._lastHeartbeat,
      ensureRegistry: () => this._ensureRegistry(),
      readRegistry: (opts) => this._readRegistry(opts),
      writeRegistry: (registry) => this._writeRegistry(registry),
      pruneStaleInPlace: (registry) => this._pruneStaleInPlace(registry),
      pruneHeartbeatThrottleMap: (throttleMap, registry) =>
        this.pruneHeartbeatThrottleMap(throttleMap, registry),
      setRegistryCache: (registry) => {
        this._registryCache = registry;
        this._registryCacheAt = Date.now();
      },
      emitAgentEvent: (event, payload) => this._events?.emitCustom(event, payload),
      publishHqMailboxEvent: (input) => this.publishHqMailboxEvent(input),
      publishHqMailboxSnapshot: () => this.publishHqMailboxSnapshot(),
    };
  }

  private clientRegistryContext(): GlobalMailboxClientRegistryContext {
    return {
      clientRegistryPath: this.clientRegistryPath,
      lastClientHeartbeat: this._lastClientHeartbeat,
      ensureClientRegistry: () => this._ensureClientRegistry(),
      readClientRegistry: (opts) => this._readClientRegistry(opts),
      writeClientRegistry: (registry) => this._writeClientRegistry(registry),
      pruneStaleClientsInPlace: (registry) => this._pruneStaleClientsInPlace(registry),
      pruneHeartbeatThrottleMap: (throttleMap, registry) =>
        this.pruneHeartbeatThrottleMap(throttleMap, registry),
      setClientRegistryCache: (registry) => {
        this._clientRegistryCache = registry;
        this._clientRegistryCacheAt = Date.now();
      },
      emitClientEvent: (event, payload) => this._events?.emitCustom(event, payload),
      publishHqMailboxSnapshot: () => this.publishHqMailboxSnapshot(),
    };
  }
  /**
   * In-memory mirror of the JSONL message file. The mailbox is shared
   * ACROSS PROCESSES, so reads cannot trust the cache blindly — we pair it
   * with an mtime check. The file lock serializes every write, so a
   * changed mtimeMs is a definitive signal that another process (or this
   * one) wrote; an unchanged mtimeMs guarantees no write happened and the
   * cache is current. This collapses the per-iteration `query()` cost from
   * O(file_size) disk + parse to O(messages) in memory.
   */
  private readonly _messageCache = new MailboxMessageCache();

  /**
   * Recipient → Set of indices into `_messageCache`. Maintained alongside
   * the cache so `query({ to })` and `unreadCount(agentId)` can skip the
   * O(N) full scan and iterate only the messages addressed to the target
   * recipient (plus broadcasts `*`).
   *
   * The index is rebuilt whenever the cache array is replaced
   * (`_setMessageCache`), extended when new messages are pushed
   * (`_pushToCache`), and cleared on `close()`.
   * It is `null` when the cache itself is null (> MESSAGE_CACHE_MAX_ENTRIES
   * or never populated).
   *
   * Safety: array indices are valid only as long as the cache array
   * reference hasn't changed. Since we rebuild the index in the same
   * synchronous step that replaces the cache, a reader that calls
   * `_readMessagesCached()` either gets the old array + old index, or
   * the new array + new index — never a mismatch.
   */

  /**
   * @param projectDir — `~/.wrongstack/projects/<slug>/`
   * @param events — optional EventBus for real-time TUI/WebUI notifications
   * @param hqPublisher — optional HQ publisher, or getter, for cross-project telemetry
   * @param eventEmitter — optional SSE event emitter for HTTP bridge push
   */
  constructor(
    projectDir: string,
    events?: EventBus,
    hqPublisher?: HqPublisherRef,
    eventEmitter?: MailboxEventEmitter,
  ) {
    this.messagePath = path.join(projectDir, GLOBAL_MAILBOX_FILE);
    this.registryPath = path.join(projectDir, '_mailbox.registry.json');
    this.clientRegistryPath = path.join(projectDir, GLOBAL_MAILBOX_CLIENT_REGISTRY_FILE);
    this._events = events;
    this._hqPublisher = hqPublisher;
    this.eventEmitter = eventEmitter;
  }

  private get hqMailboxId(): string {
    return `${path.basename(path.dirname(this.messagePath))}:mailbox`;
  }

  private get hqPublisher(): HqPublisher | undefined {
    return typeof this._hqPublisher === 'function' ? this._hqPublisher() : this._hqPublisher;
  }

  private publishHqMailboxEvent(input: Parameters<HqPublisher['publishMailboxEvent']>[0]): void {
    try {
      this.hqPublisher?.publishMailboxEvent(input);
    } catch {
      // HQ telemetry is best-effort and must never affect mailbox behavior.
    }
  }

  private publishHqMailboxSnapshot(): void {
    const publisher = this.hqPublisher;
    if (publisher === undefined) return;
    void publisher.publishMailboxSnapshot(this, { mailboxId: this.hqMailboxId }).catch(() => {
      // HQ telemetry is best-effort and must never affect mailbox behavior.
    });
  }

  // ── Messages ────────────────────────────────────────────────────────────

  async send(input: MailboxSendInput): Promise<MailboxMessage> {
    return this.sendMessage(input, false);
  }

  /** Persist a runtime-owned control signal. Never expose this to agent tools or HTTP send routes. */
  async sendRuntimeControl(
    input: Omit<MailboxSendInput, 'type'> & { type?: 'control' },
  ): Promise<MailboxMessage> {
    return this.sendMessage({ ...input, type: 'control' }, true);
  }

  private async sendMessage(input: MailboxSendInput, allowRuntimeControl: boolean): Promise<MailboxMessage> {
    // GM-P0.5A: Enforce type/recipient validation at the storage boundary.
    // Runtime control has one explicit, narrowly named bypass above.
    const resolvedType = normalizeMailboxMessageType(input.type);
    const normalizedTo = normalizeRecipient(input.to, input.senderSessionId);
    if (!(allowRuntimeControl && resolvedType === 'control')) {
      validateSendType(resolvedType, normalizedTo);
    }

    const now = new Date().toISOString();
    const msg: MailboxMessage = {
      id: randomUUID(),
      from: input.from,
      to: normalizedTo,
      type: resolvedType,
      ...(input.audience !== undefined && input.audience !== 'all'
        ? { audience: input.audience }
        : {}),
      subject: input.subject,
      body: input.body,
      priority: input.priority ?? 'normal',
      readBy: {},
      completed: false,
      timestamp: now,
      replyTo: input.replyTo,
      taskContext: input.taskContext,
      senderSessionId: input.senderSessionId,
      expiresAt:
        input.ttlMs !== undefined ? new Date(Date.now() + input.ttlMs).toISOString() : undefined,
    };

    const line = JSON.stringify(msg) + LINE_SEPARATOR;
    await fsp.mkdir(path.dirname(this.messagePath), { recursive: true });
    // The append must hold the same lock ack() rewrites under: an unlocked
    // append racing ack's read→rewrite gets silently erased when the rewrite
    // lands. This file is shared ACROSS PROCESSES, so the window is real.
    await withFileLock(this.messagePath, async () => {
      // GM-P0.4A: Refuse mutation when a newer-version process has written
      // v2 receipt records to this mailbox.
      await assertMailboxNotFenced(this.messagePath);
      // Another process may have appended since our last cached read. Refresh
      // before advancing the cache trackers to our post-append size, otherwise
      // those cross-process records would become permanently hidden locally.
      await this._refreshMessageCacheUnderLock();
      await fsp.appendFile(this.messagePath, line, 'utf8');
      // Capture the post-append stat INSIDE the lock so the cache trackers
      // advance with the pushed content. A concurrent reader that lands
      // after we release but before a future stat would otherwise see the
      // file grew and re-append the just-sent tail, duplicating it.
      const { mtimeMs, size } = await this._statMessageFile();
      // Refresh the in-memory cache from the message we just appended —
      // cheaper than re-reading the whole file, and correct because we
      // held the lock so nothing else changed underneath us.
      this._messageCache.push(msg, { mtimeMs, size });
    });

    this.publishHqMailboxEvent({
      mailboxId: this.hqMailboxId,
      action: 'message.sent',
      message: msg,
    });
    this.publishHqMailboxSnapshot();

    // In-process push notification: same-process mailbox consumers (the
    // awareness poller, fleet pulse, TUI/WebUI) can listen on this event
    // to get real-time updates instead of polling on every iteration.
    this._events?.emitCustom('mailbox.message_sent', {
      messageId: msg.id,
      from: msg.from,
      to: msg.to,
      type: msg.type,
      subject: msg.subject,
    });
    // SSE push for external HTTP bridge clients.
    this.eventEmitter?.emit({
      type: 'message.sent' as const,
      messageId: msg.id,
      from: msg.from,
      to: msg.to,
      audience: msg.audience,
      timestamp: now,
    });

    return msg;
  }

  async query(q: MailboxQuery): Promise<MailboxMessage[]> {
    const queryType = q.type === undefined ? undefined : normalizeMailboxMessageType(q.type);
    const all = await this._readMessagesCached();
    const limit = q.limit ?? 50;

    // Single-pass filter — previously 7 chained .filter() allocations each
    // producing a fresh array. Predicates are independent, so we can AND
    // them in one walk and short-circuit per element.
    const order = q.minPriority !== undefined ? ({ low: 0, normal: 1, high: 2 } as const) : null;
    const minPriorityRank = order && q.minPriority !== undefined ? order[q.minPriority] : 0;
    const out: MailboxMessage[] = [];

    // Recipient index fast-path: when the query filters by `to` AND no
    // other broad filter (from, type, etc.) would benefit from the index,
    // iterate only the messages addressed to the target recipient (plus
    // broadcasts `*`) instead of scanning the full cache. Falls back to
    // the full scan when the index is unavailable or when multiple
    // non-recipient filters are present (the index doesn't help there).
    //
    // Sender index fast-path: symmetric — when filtering ONLY by `from`
    // (no `to`, `type`, `minPriority`), iterate only messages from that
    // sender.
    const candidates = selectMailboxQueryCandidates(
      q,
      all,
      this._messageCache.recipientIndex,
      this._messageCache.senderIndex,
    );

    for (const m of candidates) {
      if (q.to !== undefined && m.to !== q.to && m.to !== '*') continue;
      if (q.from !== undefined && m.from !== q.from) continue;
      if (q.sessionId !== undefined && m.senderSessionId !== q.sessionId) continue;
      if (q.unreadBy !== undefined && !isMailboxMessageVisibleTo(m, q.unreadBy, q.readerRole)) continue;
      // An actor-scoped incomplete-work query is independent of unread state:
      // an explicitly reopened message remains read, but must re-enter the
      // actor's incomplete queue. Plain unread queries still exclude reads.
      if (!q.incompleteOnly && q.unreadBy !== undefined && q.unreadBy in m.readBy) continue;
      if (q.incompleteOnly && isMessageCompletedForActor(m, q.unreadBy)) continue;
      if (queryType !== undefined && m.type !== queryType) continue;
      if (order !== null && (order[m.priority as keyof typeof order] ?? 1) < minPriorityRank!) {
        continue;
      }
      if (q.since !== undefined && m.timestamp <= q.since) continue;
      // Default behavior: soft-deleted messages are hidden unless the
      // caller explicitly opts in via `includeDeleted: true` (used by
      // the WebUI's "trash" view).
      if (!q.includeDeleted && m.deletedAt !== undefined) continue;
      // Exact-match filter on replyTo parent message id.
      if (q.replyTo !== undefined && m.replyTo !== q.replyTo) continue;
      out.push(m);
    }

    out.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    // Return defensive shallow copies so callers cannot mutate the shared
    // cache entries. Aggregate projection fields are stripped by default;
    // trusted boundaries may retain them briefly to derive actor-safe fields.
    // Only the returned slice is copied — O(limit), not O(N).
    return out.slice(0, limit).map((m) => {
      const copy = { ...m, readBy: { ...m.readBy } };
      if (!q.includeReceiptState) {
        delete (copy as Record<string, unknown>)['recipientState'];
        delete (copy as Record<string, unknown>)['legacyGlobalCompletion'];
      }
      return copy;
    });
  }

  async ack(input: MailboxAckInput): Promise<MailboxMessage | null> {
    const updated = await this.ackMany({ acks: [input] });
    return updated.length > 0 ? updated[0]! : null;
  }

  /** Diagnostic counters exposed for test/tool introspection. */
  readonly diag = {
    ackManyCacheDesync: 0,
    ackManyPreLockMtime: 0,
    ackManyPostLockMtime: 0,
    ackManyPreLockSize: 0,
    ackManyPostLockSize: 0,
    ackManyMessageCount: 0,
    ackManyAckCount: 0,
    cacheHitCount: 0,
    cacheMissCount: 0,
    cacheDesyncNoOp: 0,
    applyAckTargetMissing: 0,
    setMessageCacheCount: 0,
    pushToCacheCount: 0,
  };

  async ackMany(input: MailboxAckBatchInput): Promise<MailboxMessage[]> {
    return ackMailboxMany(input, {
      messagePath: this.messagePath,
      diag: this.diag,
      eventEmitter: this.eventEmitter,
      hqMailboxId: this.hqMailboxId,
      messageCache: this._messageCache,
      publishHqMailboxEvent: (event) => this.publishHqMailboxEvent(event),
      publishHqMailboxSnapshot: () => this.publishHqMailboxSnapshot(),
      readMessages: () => this._readMessages(),
      readMessagesCached: () => this._readMessagesCached(),
      refreshMessageCacheUnderLock: () => this._refreshMessageCacheUnderLock(),
      statMessageFile: () => this._statMessageFile(),
    });
  }

  async unreadCount(forAgentId: string, sessionId?: string): Promise<number> {
    const all = await this._readMessagesCached();
    const scopedSessionRecipient =
      sessionId === undefined ? undefined : sessionRecipient(sessionId);
    let count = 0;

    // Recipient index fast-path: iterate direct + project broadcast + the
    // recipient's session broadcast, instead of the full cache.
    if (this._messageCache.recipientIndex !== null) {
      const indices = new Set<number>();
      const direct = this._messageCache.recipientIndex.get(forAgentId);
      if (direct !== undefined) for (const i of direct) indices.add(i);
      const broadcasts = this._messageCache.recipientIndex.get('*');
      if (broadcasts !== undefined) for (const i of broadcasts) indices.add(i);
      if (scopedSessionRecipient !== undefined) {
        const sessionBroadcasts = this._messageCache.recipientIndex.get(scopedSessionRecipient);
        if (sessionBroadcasts !== undefined) for (const i of sessionBroadcasts) indices.add(i);
      }
      for (const i of indices) {
        const m = all[i]!;
        if (
          isMailboxMessageVisibleTo(m, forAgentId) &&
          !(forAgentId in m.readBy) &&
          !isMessageCompletedForActor(m, forAgentId)
        ) count++;
      }
    } else {
      for (let i = 0; i < all.length; i++) {
        const m = all[i]!;
        if (
          (m.to === forAgentId || m.to === '*' || m.to === scopedSessionRecipient) &&
          isMailboxMessageVisibleTo(m, forAgentId) &&
          !(forAgentId in m.readBy) &&
          !isMessageCompletedForActor(m, forAgentId)
        ) count++;
      }
    }
    return count;
  }

  async softDelete(mailId: string, by: string): Promise<MailboxMessage | null> {
    // Append-only soft-delete: instead of reading all messages, mutating
    // one, and rewriting the entire file, we append a single ack record
    // with `deleted: true`. At read time, the delete is applied to the
    // target message via parseMailboxLines / applyAckToMessage.
    // No-op when the message is already soft-deleted.

    const all = await this._readMessagesCached();
    const target = all.find((m) => m.id === mailId);
    if (target === undefined) return null;
    if (target.deletedAt !== undefined) {
      return { ...target, readBy: { ...target.readBy } };
    }

    const now = new Date().toISOString();
    const ack: AckRecord = {
      __ack: true,
      messageId: mailId,
      readerId: by,
      timestamp: now,
      read: true,
      deleted: true,
      deletedBy: by,
    };

    await withFileLock(this.messagePath, async () => {
      // GM-P0.4A: Refuse mutation when a newer-version process has written
      // v2 receipt records to this mailbox.
      await assertMailboxNotFenced(this.messagePath);
      await this._refreshMessageCacheUnderLock();
      await fsp.appendFile(this.messagePath, serializeAckRecord(ack), 'utf8');
      const { mtimeMs, size } = await this._statMessageFile();
      this._messageCache.applyAck(ack);
      this._messageCache.updateStat({ mtimeMs, size });
    });

    const msg = { ...target, readBy: { ...target.readBy } };
    msg.deletedAt = now;
    msg.deletedBy = by;
    this.publishHqMailboxEvent({
      mailboxId: this.hqMailboxId,
      action: 'message.updated',
      message: msg,
    });
    this.publishHqMailboxSnapshot();
    this.eventEmitter?.emit({
      type: 'message.deleted' as const,
      messageId: msg.id,
      from: msg.from,
      to: msg.to,
      audience: msg.audience,
      timestamp: msg.deletedAt ?? now,
    });
    return msg;
  }

  async restore(mailId: string): Promise<MailboxMessage | null> {
    // Append-only restore (inverse of append-only softDelete). Same
    // pattern: put a `deleted: false` ack record on disk, apply it to
    // the cache. No-op when the message is not currently soft-deleted.

    const all = await this._readMessagesCached();
    const target = all.find((m) => m.id === mailId);
    if (target === undefined) return null;
    if (target.deletedAt === undefined && target.deletedBy === undefined) {
      return { ...target, readBy: { ...target.readBy } };
    }

    const now = new Date().toISOString();
    const ack: AckRecord = {
      __ack: true,
      messageId: mailId,
      readerId: '',
      timestamp: now,
      read: true,
      deleted: false,
    };

    await withFileLock(this.messagePath, async () => {
      // GM-P0.4A: Refuse mutation when a newer-version process has written
      // v2 receipt records to this mailbox.
      await assertMailboxNotFenced(this.messagePath);
      await this._refreshMessageCacheUnderLock();
      await fsp.appendFile(this.messagePath, serializeAckRecord(ack), 'utf8');
      const { mtimeMs, size } = await this._statMessageFile();
      this._messageCache.applyAck(ack);
      this._messageCache.updateStat({ mtimeMs, size });
    });

    const msg = { ...target, readBy: { ...target.readBy } };
    delete msg.deletedAt;
    delete msg.deletedBy;
    this.publishHqMailboxEvent({
      mailboxId: this.hqMailboxId,
      action: 'message.updated',
      message: msg,
    });
    this.publishHqMailboxSnapshot();
    this.eventEmitter?.emit({
      type: 'message.restored' as const,
      messageId: msg.id,
      from: msg.from,
      to: msg.to,
      audience: msg.audience,
      timestamp: now,
    });
    return msg;
  }

  // ── Agent registry ──────────────────────────────────────────────────────

  async registerAgent(input: AgentRegistrationInput): Promise<void> {
    await registerMailboxAgent(this.agentRegistryContext(), input);
  }

  async deregisterAgent(agentId: string): Promise<void> {
    await deregisterMailboxAgent(this.agentRegistryContext(), agentId);
  }

  async heartbeat(input: AgentHeartbeatInput): Promise<void> {
    await heartbeatMailboxAgent(this.agentRegistryContext(), input);
  }

  async getAgentStatuses(): Promise<MailboxAgentStatus[]> {
    return getMailboxAgentStatuses(this.agentRegistryContext());
  }

  async getOnlineAgents(): Promise<MailboxAgentStatus[]> {
    const all = await this.getAgentStatuses();
    return all.filter((a) => a.online);
  }

  /** Explicitly purge agent registrations older than the requested age. */
  async purgeAgents(maxAgeMs = AGENT_STALE_MS): Promise<number> {
    await this._ensureRegistry();
    let removed = 0;
    await withFileLock(this.registryPath, async () => {
      const registry = await this._readRegistry({ fresh: true });
      const cutoff = Date.now() - Math.max(0, maxAgeMs);
      for (const [agentId, agent] of registry) {
        const lastSeenAt = Date.parse(agent.lastSeenAt);
        if (!Number.isFinite(lastSeenAt) || lastSeenAt <= cutoff) {
          registry.delete(agentId);
          this._lastHeartbeat.delete(agentId);
          removed++;
        }
      }
      this._registryCache = registry;
      this._registryCacheAt = Date.now();
      await this._writeRegistry(registry);
    });
    if (removed > 0) this.publishHqMailboxSnapshot();
    return removed;
  }

  // ── Client registry ─────────────────────────────────────────────────────

  async registerClient(input: ClientRegistrationInput): Promise<void> {
    await registerMailboxClient(this.clientRegistryContext(), input);
  }

  async deregisterClient(clientId: string): Promise<void> {
    await deregisterMailboxClient(this.clientRegistryContext(), clientId);
  }

  async clientHeartbeat(input: ClientHeartbeatInput): Promise<void> {
    await heartbeatMailboxClient(this.clientRegistryContext(), input);
  }

  async getClientStatuses(): Promise<ClientStatus[]> {
    return getMailboxClientStatuses(this.clientRegistryContext());
  }

  /**
   * Explicitly purge stale clients from the registry and write back to disk.
   * Removes client entries whose lastSeenAt is older than CLIENT_STALE_MS.
   * Returns the number of entries purged.
   *
   * Idempotent — safe to call regularly. The same pruning runs implicitly
   * inside registerClient, clientHeartbeat, and getClientStatuses, but if
   * no client registers or heartbeats for a long time, this public method
   * ensures the file gets cleaned up on demand.
   */
  async purgeClients(): Promise<number> {
    return purgeMailboxClients(this.clientRegistryContext());
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async close(): Promise<void> {
    // JSONL append-only — no flush needed
    this._registryCache = null;
    this._clientRegistryCache = null;
    this._messageCache.clear();
  }

  async clearAll(): Promise<void> {
    await runGlobalMailboxClearAll({
      messagePath: this.messagePath,
      statMessageFile: () => this._statMessageFile(),
      setMessageCache: (messages, stat) => this._messageCache.set(messages, stat),
    });
  }

  async purgeStale(opts?: PurgeOptions): Promise<PurgeResult> {
    return runGlobalMailboxPurgeStale(opts, {
      messagePath: this.messagePath,
      getAgentStatuses: () => this.getAgentStatuses(),
      readMessagesFresh: () => this._readMessagesFresh(),
      statMessageFile: () => this._statMessageFile(),
      setMessageCache: (messages, stat) => this._messageCache.set(messages, stat),
    });
  }

  // ── Auto-compaction ─────────────────────────────────────────────────────

  private _autoCompactTimer: NodeJS.Timeout | null = null;

  async autoCompact(opts?: AutoCompactOptions): Promise<AutoCompactResult> {
    return runGlobalMailboxAutoCompact(opts, {
      messagePath: this.messagePath,
      getAgentStatuses: () => this.getAgentStatuses(),
      readMessagesFresh: () => this._readMessagesFresh(),
      statMessageFile: () => this._statMessageFile(),
      setMessageCache: (messages, stat) => this._messageCache.set(messages, stat),
    });
  }

  startAutoCompactTimer(opts?: AutoCompactOptions): () => void {
    // Replace any prior timer.
    if (this._autoCompactTimer !== null) {
      clearInterval(this._autoCompactTimer);
    }
    const intervalMs = opts?.intervalMs ?? AUTO_COMPACT_INTERVAL_MS;
    const timer = setInterval(() => {
      this.autoCompact(opts).catch(() => {
        // Best-effort — background compaction must never crash the process.
      });
    }, intervalMs);
    timer.unref?.();
    this._autoCompactTimer = timer;
    return () => {
      clearInterval(timer);
      this._autoCompactTimer = null;
    };
  }

  // ── Internal ────────────────────────────────────────────────────────────

  /**
   * Read all messages from the JSONL file. Folds v1 messages/acks AND v2
   * receipt records into MailboxMessageProjection[] carrying per-actor
   * recipientState.
   *
   * The returned type is Promise<MailboxMessage[]> for interface compatibility;
   * every element is actually a MailboxMessageProjection that carries
   * recipientState and optional legacyGlobalCompletion on top of the base
   * MailboxMessage fields.
   *
   * Callers that can tolerate a stale-by-mtime view should use
   * {@link _readMessagesCached}; writers that need the post-lock truth
   * should call this directly (it's what {@link _readMessagesFresh} aliases).
   */
  private async _readMessages(): Promise<MailboxMessage[]> {
    try {
      const raw = await fsp.readFile(this.messagePath, 'utf8');
      return parseMailboxFile(raw);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  /**
   * Read messages, then adopt the result as the in-memory cache. Use this
   * from writers that just took the file lock — the read reflects the
   * authoritative post-lock state and should be served to subsequent
   * queries without re-reading.
   *
   * The mtime/size are captured from the stat at read time so the cache
   * trackers match exactly what was parsed. Writers that subsequently
   * rewrite the file MUST re-stat after the write and re-promote with the
   * post-write values (see ackMany / softDelete / restore / purgeStale /
   * clearAll) — otherwise a concurrent reader misclassifies the rewrite
   * as a "file only grew" append and corrupts the cache.
   */
  private async _readMessagesFresh(): Promise<MailboxMessage[]> {
    return this._messageCache.readFresh(
      () => this._readMessages(),
      () => this._statMessageFile(),
    );
  }

  /**
   * Stat the message file, returning its mtimeMs and size. Returns
   * `-1/-1` when the file does not yet exist (ENOENT) so callers can
   * still promote a cache snapshot — the next read will re-stat and
   * fall through to a full re-read. Call from inside the file lock so
   * the result reflects the post-write on-disk state, not a later
   * intermediate state from another process.
   */
  private async _statMessageFile(): Promise<MailboxMessageFileStat> {
    return statMailboxMessageFile(this.messagePath);
  }

  /**
   * Reconcile an existing message cache with the authoritative file while the
   * caller holds `messagePath`'s lock.
   *
   * Call this before any append/rewrite under the lock that updates
   * `_messageCacheSize` or `_messageCacheMtime`. Otherwise a cross-process
   * append that landed since the last cached read is absent from
   * `_messageCache`, while the newer size/mtime makes later readers
   * incorrectly treat that incomplete cache as current.
   *
   * Returns true only when a stale populated cache was refreshed. A null
   * cache is intentionally left alone: it is either not initialized or was
   * disabled by the size cap, and the next query will perform a full read.
   */
  private async _refreshMessageCacheUnderLock(): Promise<boolean> {
    const refreshed = await this._messageCache.refreshUnderLock(
      () => this._readMessages(),
      () => this._statMessageFile(),
    );
    if (refreshed) this.diag.ackManyCacheDesync++;
    return refreshed;
  }

  /**
   * Read messages, consulting the mtime-bounded in-memory cache first.
   *
   * The mailbox file is shared across processes; every `send`/`ack`/
   * `clearAll`/`purgeStale` takes the file lock, so writes are serialized
   * and a changed mtimeMs is a definitive freshness signal. When the
   * stat matches the cached mtime+size we return the cached array — no
   * file read and no JSON.parse — collapsing the per-iteration query
   * cost on the mailbox-loop hot path.
   *
   * When the file only grew (new messages appended by another process), the
   * cache reads and folds just the appended bytes instead of re-parsing the
   * entire history. The read path — including the raw file access — lives in
   * {@link MailboxMessageCache} because the incremental fold needs the base
   * messages and receipt lists that `parseMailboxFile()` discards; see
   * `mailbox-parse-state.ts`. Serialization and staleness handling are
   * documented there. Writers that need the post-lock truth still go through
   * {@link _readMessages}/{@link _readMessagesFresh}.
   */
  private _readMessagesCached(): Promise<MailboxMessage[]> {
    return this._messageCache.readCached(this.messagePath);
  }
  private async _ensureRegistry(): Promise<void> {
    await fsp.mkdir(path.dirname(this.registryPath), { recursive: true });
  }

  private async _readRegistry(opts?: { fresh?: boolean }): Promise<Map<string, RegisteredAgent>> {
    // The registry file is shared across processes. Reads may use a short
    // TTL cache; writers (under the file lock) MUST pass { fresh: true } —
    // a read-modify-write from a stale cache would silently erase agents
    // registered by other sessions.
    if (
      !opts?.fresh &&
      this._registryCache &&
      Date.now() - this._registryCacheAt < REGISTRY_CACHE_TTL_MS
    ) {
      return new Map(this._registryCache);
    }

    const map = await readAgentRegistryFile(this.registryPath);
    this._registryCache = map;
    this._registryCacheAt = Date.now();
    return new Map(map);
  }

  private _pruneStaleInPlace(registry: Map<string, RegisteredAgent>): void {
    pruneStaleRegistryEntries(registry, AGENT_STALE_MS);
  }

  private async _writeRegistry(registry: Map<string, RegisteredAgent>): Promise<void> {
    await writeRegistryFile(this.registryPath, registry);
  }

  // ── Client registry internals ───────────────────────────────────────────

  private async _ensureClientRegistry(): Promise<void> {
    await fsp.mkdir(path.dirname(this.clientRegistryPath), { recursive: true });
  }

  private async _readClientRegistry(opts?: {
    fresh?: boolean;
  }): Promise<Map<string, RegisteredClient>> {
    if (
      !opts?.fresh &&
      this._clientRegistryCache &&
      Date.now() - this._clientRegistryCacheAt < REGISTRY_CACHE_TTL_MS
    ) {
      return new Map(this._clientRegistryCache);
    }

    const map = await readClientRegistryFile(this.clientRegistryPath);
    this._clientRegistryCache = map;
    this._clientRegistryCacheAt = Date.now();
    return new Map(map);
  }

  private _pruneStaleClientsInPlace(registry: Map<string, RegisteredClient>): void {
    pruneStaleRegistryEntries(registry, CLIENT_STALE_MS);
  }

  private async _writeClientRegistry(registry: Map<string, RegisteredClient>): Promise<void> {
    await writeRegistryFile(this.clientRegistryPath, registry);
  }

  // ── GM-P0.5A: Actor-bearing service methods ───────────────────────────
  //
  // These methods enforce a trusted MailboxActorContext before delegating
  // to the existing methods. They are the preferred entry point for all
  // external/untrusted callers. Legacy actor-ambiguous methods (send, ack,
  // query, etc.) remain for trusted runtime callers that already have a
  // resolved actor.

  /**
   * Send a message with a verified actor context.
   * Stamps `from` and `senderSessionId` from the actor — body-supplied
   * values are ignored.
   */
  async sendFor(
    actor: MailboxActorContext,
    input: Omit<MailboxSendInput, 'from' | 'senderSessionId'>,
  ): Promise<MailboxMessage> {
    return sendMailboxFor(actor, input, (sendInput) => this.send(sendInput));
  }

  /** Register presence with identity, session, and role derived from the actor. */
  async registerFor(
    actor: MailboxActorContext,
    input: Omit<AgentRegistrationInput, 'agentId' | 'sessionId' | 'role'>,
  ): Promise<void> {
    await registerMailboxActor(actor, input, (registration) => this.registerAgent(registration));
  }

  /** Update presence with identity derived from the actor. */
  async heartbeatFor(
    actor: MailboxActorContext,
    input: Omit<AgentHeartbeatInput, 'agentId'>,
  ): Promise<void> {
    await heartbeatMailboxActor(actor, input, (heartbeat) => this.heartbeat(heartbeat));
  }

  /**
   * Acknowledge a message with a verified actor context.
   * Stamps `readerId` from the actor. Rejects if the message is not
   * visible to the actor (visibility check before persistence).
   */
  async ackFor(
    actor: MailboxActorContext,
    input: { messageId: string; read?: boolean; completed?: boolean; outcome?: string },
  ): Promise<ActorMailboxMessage | null> {
    return ackMailboxFor(actor, input, {
      readMessages: () => this._readMessagesCached(),
      ack: (ackInput) => this.ack(ackInput),
    });
  }

  /**
   * Query messages with a verified actor context.
   * Derives `readerRole` and `unreadBy` from the actor.
   */
  async queryFor(
    actor: MailboxActorContext,
    query?: Partial<MailboxQuery>,
  ): Promise<ActorMailboxMessage[]> {
    return queryMailboxFor(actor, query, (queryInput) => this.query(queryInput));
  }

  /**
   * Soft-delete a message with a verified actor context.
   * Rejects if the message is not visible to the actor.
   */
  async softDeleteFor(
    actor: MailboxActorContext,
    mailId: string,
  ): Promise<ActorMailboxMessage | null> {
    return softDeleteMailboxFor(actor, mailId, {
      readMessages: () => this._readMessagesCached(),
      softDelete: (targetMailId, readerId) => this.softDelete(targetMailId, readerId),
    });
  }

  /**
   * Restore a soft-deleted message with a verified actor context.
   * Rejects if the message is not visible to the actor.
   */
  async restoreFor(actor: MailboxActorContext, mailId: string): Promise<ActorMailboxMessage | null> {
    return restoreMailboxFor(actor, mailId, {
      readMessages: () => this._readMessagesCached(),
      restore: (targetMailId) => this.restore(targetMailId),
    });
  }
}

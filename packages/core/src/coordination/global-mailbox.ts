/**
 * GlobalMailbox — project-level inter-agent mailbox with cross-session support.
 *
 * Stores messages at `~/.wrongstack/projects/<slug>/_mailbox.jsonl` so every
 * client and agent working on the same canonical project shares one inbox,
 * including agents in different processes, sessions, branches, and linked Git
 * worktrees.
 *
 * Features:
 * - Agent registration + heartbeat (agents go stale after 60s without heartbeat)
 * - Per-recipient read receipts (readBy[agentId] = ISO8601)
 * - Atomic file-locking for concurrent multi-process writes
 * - Unread count for new-mail notifications
 * - Online agent list
 *
 * @module GlobalMailbox
 */

import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';

import * as path from 'node:path';
import type { HqPublisher } from '../hq/publisher.js';
import type { EventBus } from '../kernel/events.js';
import { atomicWrite, withFileLock } from '../utils/atomic-write.js';
import {
  AGENT_STALE_MS,
  AUTO_COMPACT_DEFAULT_TTL_MS,
  AUTO_COMPACT_INTERVAL_MS,
  AUTO_COMPACT_READ_MAX_AGE_MS,
  CLIENT_STALE_MS,
  HEARTBEAT_THROTTLE_MS,
  LINE_SEPARATOR,
  REGISTRY_CACHE_TTL_MS,
} from './mailbox-constants.js';
import {
  MailboxMessageCache,
  type MailboxMessageFileStat,
} from './mailbox-message-cache.js';
import type { MailboxEventEmitter } from './mailbox-events.js';
import {
  buildReceiptRecordV2,
  serializeReceiptRecordV2,
} from './mailbox-receipt-folding.js';
import { ensureVersionSentinel } from './mailbox-version-fence.js';
import {
  normalizeMailboxMessageType,
  parseMailboxLines,
  serializeAckRecord,
} from './mailbox-message-codec.js';
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
  mapRegisteredAgentsToStatuses,
  mapRegisteredClientsToStatuses,
} from './mailbox-status-mappers.js';
import type {
  AckRecord,
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

// ── Singleton factory ────────────────────────────────────────────────────

/**
 * Process-wide registry of GlobalMailbox instances, keyed by projectDir.
 *
 * Without this, `attachMailboxChecker` and `attachFleetPulse` each created
 * a SEPARATE GlobalMailbox for the same project directory — two independent
 * mtime caches, two read chains, two sets of heartbeat timers. The factory
 * ensures that within a single process there is at most one instance per
 * project directory, so cache hit ratio is maximized and I/O is minimized.
 *
 * Cross-process sharing still works as before (the JSONL file + file lock
 * is the source of truth); this is purely an in-process optimization.
 *
 * Pass `forceNew: true` to bypass the cache (used by tests that need an
 * isolated tmpdir instance without polluting the singleton).
 */
const _mailboxInstances = new Map<string, GlobalMailbox>();

export function getSharedMailbox(
  projectDir: string,
  events?: EventBus,
  hqPublisher?: HqPublisherRef,
  opts?: { forceNew?: boolean },
): GlobalMailbox {
  if (opts?.forceNew) {
    return new GlobalMailbox(projectDir, events, hqPublisher);
  }
  const existing = _mailboxInstances.get(projectDir);
  if (existing !== undefined) return existing;
  const mb = new GlobalMailbox(projectDir, events, hqPublisher);
  _mailboxInstances.set(projectDir, mb);
  return mb;
}

/** Clear the singleton registry — used by tests to avoid cross-test leakage. */
export function _clearMailboxSingletons(): void {
  _mailboxInstances.clear();
}

// ── GlobalMailbox ────────────────────────────────────────────────────────

export class GlobalMailbox implements Mailbox {
  /** Path to the JSONL message file. */
  readonly messagePath: string;
  /** Path to the JSON agent registry file. */
  readonly registryPath: string;
  /** Path to the JSON client registry file. */
  readonly clientRegistryPath: string;
  /** Optional event bus for emitting agent registration/heartbeat events. */
  private readonly _events?: EventBus | undefined;
  /** Optional HQ publisher for cross-project command-center telemetry. */
  private readonly _hqPublisher?: HqPublisherRef | undefined;
  /**
   * Optional SSE event emitter for real-time push to HTTP bridge clients.
   * When present, `send`/`ack`/`softDelete`/`restore` emit events that
   * connected SSE subscribers receive instantly.
   */
  readonly eventEmitter?: MailboxEventEmitter | undefined;
  /**
   * Local cache of the agent registry to avoid re-reading on every call.
   * Time-bounded: the registry file is shared ACROSS PROCESSES (that's the
   * whole point of GlobalMailbox), so a cache served forever would never see
   * agents registered by other sessions. Writers always bypass it.
   */
  private _registryCache: Map<string, RegisteredAgent> | null = null;
  /** When the registry cache was last refreshed from disk (epoch ms). */
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
    // GM-P0.5A: Enforce type/recipient validation at the storage boundary.
    // This prevents direct typed callers from bypassing the canonical
    // validateSendType() check that transport adapters (tools, HTTP, CLI)
    // apply. Without this, a direct call to send({ type: 'control', ... })
    // would succeed — control is reserved for runtime use only.
    const resolvedType = normalizeMailboxMessageType(input.type);
    const normalizedTo = normalizeRecipient(input.to, input.senderSessionId);
    validateSendType(resolvedType, normalizedTo);

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
      if (q.unreadBy !== undefined && q.unreadBy in m.readBy) continue;
      if (q.incompleteOnly && m.completed) continue;
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
    // cache entries. Only the returned slice is copied — O(limit), not O(N).
    return out.slice(0, limit).map((m) => ({ ...m, readBy: { ...m.readBy } }));
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
    // Append-only ack: instead of reading all messages, mutating them,
    // and rewriting the entire file (O(N) read + O(N) write), we append
    // small ack records (O(K) append where K = number of acks). At read
    // time, ack records are folded into their target messages.
    //
    // This is the #1 performance fix: every agent iteration calls ackMany
    // on the mailbox-loop hot path. Previously it was O(N) per iteration.
    if (input.acks.length === 0) return [];

    const now = new Date().toISOString();
    const ackRecords: AckRecord[] = [];
    const updated: MailboxMessage[] = [];
    const targetIds = new Set<string>();
    const byId = new Map<string, MailboxAckInput>();

    for (const a of input.acks) {
      byId.set(a.messageId, a);
      targetIds.add(a.messageId);
    }

    // Build ack records and find target messages.
    // We need to find messages to return them; use cached view for speed.
    const all = await this._readMessagesCached();
    // Capture the metadata that produced `all`. Taking this snapshot before
    // the cached read caused false desync reports whenever that read itself
    // legitimately discovered a cross-process append.
    this.diag.ackManyPreLockMtime = this._messageCache.mtimeMs;
    this.diag.ackManyPreLockSize = this._messageCache.sizeBytes;
    for (const msg of all) {
      const a = byId.get(msg.id);
      if (!a) continue;

      // Determine what this ack actually changes to avoid no-op appends.
      const needsRead = a.read !== false && !(a.readerId in msg.readBy);
      const needsComplete = a.completed && !msg.completed;
      const needsOutcome = a.outcome !== undefined && msg.outcome !== a.outcome;

      if (!needsRead && !needsComplete && !needsOutcome) {
        // No-op ack — return the pre-ack state (defensive copy matches
        // the original semantics: re-acking an already-read message
        // returns the message as it was).
        updated.push({ ...msg, readBy: { ...msg.readBy } });
        continue;
      }

      // Apply changes to a defensive copy for the return value.
      const copy = { ...msg, readBy: { ...msg.readBy } };
      if (needsRead) copy.readBy[a.readerId] = now;
      if (needsComplete) {
        copy.completed = true;
        copy.completedBy = a.readerId;
        copy.completedAt = now;
      }
      if (needsOutcome) copy.outcome = a.outcome;
      updated.push(copy);

      ackRecords.push({
        __ack: true,
        messageId: msg.id,
        readerId: a.readerId,
        timestamp: now,
        read: a.read !== false,
        completed: a.completed,
        completedBy: a.completed ? a.readerId : undefined,
        outcome: a.outcome,
      });
    }

    if (ackRecords.length === 0) {
      // All requested acks were no-ops (already read/completed).
      // Still return the messages that were found (updated may be empty if
      // none matched, which preserves prior silent-skip semantics).
      if (updated.length > 0) {
        for (const message of updated) {
          this.publishHqMailboxEvent({
            mailboxId: this.hqMailboxId,
            action: message.completed ? 'message.completed' : 'message.read',
            message,
          });
        }
      }
      return updated;
    }

    // Append ack records to the file under the lock. Messages appended by
    // another process during this ack may be absent from `updated`; callers
    // will observe them on their next query/read.
    //
    // GM-P0.4: Dual-write v1 ack records AND v2 receipt records.
    // The v1 ack preserves backward compatibility for old readers.
    // The v2 receipt record enables per-actor delivery state.
    // The version sentinel is written on the first v2 receipt to fence
    // old processes from mutating a v2 mailbox (GM-P0.4A).
    const serialized = ackRecords.map((a) => serializeAckRecord(a)).join('');
    const v2Receipts = ackRecords.map((a) =>
      serializeReceiptRecordV2(
        buildReceiptRecordV2(a.messageId, a.readerId, a.timestamp, {
          read: a.read !== false,
          completed: a.completed === true,
          ...(a.outcome !== undefined ? { outcome: a.outcome } : {}),
        }),
      ),
    ).join('');
    await withFileLock(this.messagePath, async () => {
      // Close the read→lock race.
      await this._refreshMessageCacheUnderLock();
      // GM-P0.4A: Ensure the version sentinel exists before writing v2 receipts.
      // Reads the file content under lock to check; appends sentinel if absent.
      await ensureVersionSentinel(this.messagePath);
      // Append v1 acks + v2 receipts.
      await fsp.appendFile(this.messagePath, serialized + v2Receipts, 'utf8');
      // Capture the post-append stat inside the lock.
      const { mtimeMs, size } = await this._statMessageFile();
      // Apply ack effects directly to the in-memory cache.
      for (const ack of ackRecords) {
        this._messageCache.applyAck(ack);
      }
      // Advance cache trackers so the next read sees current size.
      this._messageCache.updateStat({ mtimeMs, size });

      // ── Post-lock diagnostics ──
      this.diag.ackManyPostLockMtime = mtimeMs;
      this.diag.ackManyPostLockSize = size;
      this.diag.ackManyMessageCount = this._messageCache.messageCount;
      this.diag.ackManyAckCount = ackRecords.length;
    });

    for (const message of updated) {
      this.publishHqMailboxEvent({
        mailboxId: this.hqMailboxId,
        action: message.completed ? 'message.completed' : 'message.read',
        message,
      });
      this.eventEmitter?.emit({
        type: 'message.acked' as const,
        messageId: message.id,
        from: message.from,
        to: message.to,
        timestamp: new Date().toISOString(),
      });
    }
    if (updated.length > 0) this.publishHqMailboxSnapshot();
    return updated;
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
        if (isMailboxMessageVisibleTo(m, forAgentId) && !(forAgentId in m.readBy) && !m.completed) count++;
      }
    } else {
      for (let i = 0; i < all.length; i++) {
        const m = all[i]!;
        if (
          (m.to === forAgentId || m.to === '*' || m.to === scopedSessionRecipient) &&
          isMailboxMessageVisibleTo(m, forAgentId) &&
          !(forAgentId in m.readBy) &&
          !m.completed
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
      timestamp: now,
    });
    return msg;
  }

  // ── Agent registry ──────────────────────────────────────────────────────

  async registerAgent(input: AgentRegistrationInput): Promise<void> {
    await this._ensureRegistry();
    const now = new Date().toISOString();
    const agent: RegisteredAgent = {
      agentId: input.agentId,
      sessionId: input.sessionId,
      name: input.name,
      role: input.role,
      status: 'idle',
      currentTool: undefined,
      currentTask: undefined,
      iterations: 0,
      toolCalls: 0,
      registeredAt: now,
      lastSeenAt: now,
      pid: input.pid ?? process.pid,
      source: input.source,
    };

    await withFileLock(this.registryPath, async () => {
      // fresh: read-modify-write must start from the on-disk state, not the
      // cache — other processes may have registered agents since.
      const registry = await this._readRegistry({ fresh: true });
      // Prune stale agents
      this._pruneStaleInPlace(registry);
      this.pruneHeartbeatThrottleMap(this._lastHeartbeat, registry);
      // Upsert
      registry.set(input.agentId, agent);
      // Update cache
      this._registryCache = registry;
      this._registryCacheAt = Date.now();
      await this._writeRegistry(registry);
    });

    // Emit event for TUI/WebUI to update online agent count
    this._events?.emitCustom('mailbox.agent_registered', {
      agentId: input.agentId,
      sessionId: input.sessionId,
      name: input.name,
      role: input.role,
      source: input.source,
    });
    this.publishHqMailboxEvent({
      mailboxId: this.hqMailboxId,
      action: 'agent.registered',
      agent: {
        agentId: input.agentId,
        name: input.name,
        ...(input.role !== undefined ? { role: input.role } : {}),
        sessionId: input.sessionId,
        status: 'idle',
        iterations: 0,
        toolCalls: 0,
        lastActivityAt: now,
        lastSeenAt: now,
        online: true,
        pid: input.pid ?? process.pid,
        ...(input.source !== undefined ? { source: input.source } : {}),
      },
    });
    this.publishHqMailboxSnapshot();
  }

  async deregisterAgent(agentId: string): Promise<void> {
    await this._ensureRegistry();
    let removed: RegisteredAgent | undefined;
    await withFileLock(this.registryPath, async () => {
      const registry = await this._readRegistry({ fresh: true });
      this._pruneStaleInPlace(registry);
      this.pruneHeartbeatThrottleMap(this._lastHeartbeat, registry);
      // Capture the record before deletion so HQ telemetry can emit a full,
      // well-typed agent summary rather than a bare id.
      removed = registry.get(agentId);
      registry.delete(agentId);
      this._lastHeartbeat.delete(agentId);
      this._registryCache = registry;
      this._registryCacheAt = Date.now();
      await this._writeRegistry(registry);
    });
    this._events?.emitCustom('mailbox.agent_deregistered', {
      agentId,
    });
    this.publishHqMailboxEvent({
      mailboxId: this.hqMailboxId,
      action: 'agent.deregistered',
      agent: {
        agentId,
        name: removed?.name ?? agentId,
        ...(removed?.role !== undefined ? { role: removed.role } : {}),
        sessionId: removed?.sessionId ?? '',
        status: 'offline',
        ...(removed?.currentTool !== undefined ? { currentTool: removed.currentTool } : {}),
        ...(removed?.currentTask !== undefined ? { currentTask: removed.currentTask } : {}),
        iterations: removed?.iterations ?? 0,
        toolCalls: removed?.toolCalls ?? 0,
        lastActivityAt: removed?.lastSeenAt ?? new Date().toISOString(),
        lastSeenAt: removed?.lastSeenAt ?? new Date().toISOString(),
        online: false,
        pid: removed?.pid ?? 0,
        ...(removed?.source !== undefined ? { source: removed.source } : {}),
      },
    });
    this.publishHqMailboxSnapshot();
  }

  async heartbeat(input: AgentHeartbeatInput): Promise<void> {
    // Throttle: at most one heartbeat per agent per HEARTBEAT_THROTTLE_MS
    const last = this._lastHeartbeat.get(input.agentId) ?? 0;
    const now = Date.now();
    if (now - last < HEARTBEAT_THROTTLE_MS) return;

    this._lastHeartbeat.set(input.agentId, now);

    await this._ensureRegistry();

    await withFileLock(this.registryPath, async () => {
      // fresh: see registerAgent — never read-modify-write from the cache.
      const registry = await this._readRegistry({ fresh: true });
      this._pruneStaleInPlace(registry);
      this.pruneHeartbeatThrottleMap(this._lastHeartbeat, registry);

      const agent = registry.get(input.agentId);
      if (agent) {
        const iso = new Date().toISOString();
        agent.lastSeenAt = iso;
        if (input.status !== undefined) agent.status = input.status;
        if (input.currentTool !== undefined) agent.currentTool = input.currentTool;
        if (input.currentTask !== undefined) agent.currentTask = input.currentTask;
        if (input.iterations !== undefined) agent.iterations = input.iterations;
        if (input.toolCalls !== undefined) agent.toolCalls = input.toolCalls;
      }
      // If agent not registered yet, silently skip — registerAgent first

      this._registryCache = registry;
      this._registryCacheAt = Date.now();
      await this._writeRegistry(registry);
    });

    // Emit event so TUI/WebUI can track online agents in real time
    this._events?.emitCustom('mailbox.agent_heartbeat', {
      agentId: input.agentId,
      status: input.status,
      currentTool: input.currentTool,
      currentTask: input.currentTask,
    });
    this.publishHqMailboxEvent({
      mailboxId: this.hqMailboxId,
      action: 'agent.heartbeat',
      summary: input.agentId,
    });
    this.publishHqMailboxSnapshot();
  }

  async getAgentStatuses(): Promise<MailboxAgentStatus[]> {
    await this._ensureRegistry();
    let registry = await this._readRegistry();
    const before = registry.size;
    this._pruneStaleInPlace(registry);

    // A read can be the only activity after every process in a project exits.
    // Persist expiry under the file lock so old agents do not survive forever
    // in `_mailbox.registry.json` (or race a concurrent registration).
    if (registry.size < before) {
      await withFileLock(this.registryPath, async () => {
        const fresh = await this._readRegistry({ fresh: true });
        this._pruneStaleInPlace(fresh);
        this._registryCache = fresh;
        this._registryCacheAt = Date.now();
        await this._writeRegistry(fresh);
        registry = fresh;
      });
    }

    return mapRegisteredAgentsToStatuses(registry, Date.now(), AGENT_STALE_MS);
  }

  async getOnlineAgents(): Promise<MailboxAgentStatus[]> {
    const all = await this.getAgentStatuses();
    return all.filter((a) => a.online);
  }

  // ── Client registry ─────────────────────────────────────────────────────

  async registerClient(input: ClientRegistrationInput): Promise<void> {
    await this._ensureClientRegistry();
    const now = new Date().toISOString();
    const client: RegisteredClient = {
      clientId: input.clientId,
      sessionId: input.sessionId,
      name: input.name,
      source: input.source,
      registeredAt: now,
      lastSeenAt: now,
      pid: input.pid ?? process.pid,
    };

    await withFileLock(this.clientRegistryPath, async () => {
      const registry = await this._readClientRegistry({ fresh: true });
      this._pruneStaleClientsInPlace(registry);
      this.pruneHeartbeatThrottleMap(this._lastClientHeartbeat, registry);
      registry.set(input.clientId, client);
      this._clientRegistryCache = registry;
      this._clientRegistryCacheAt = Date.now();
      await this._writeClientRegistry(registry);
    });

    // Emit event for TUI/WebUI to update online client count
    this._events?.emitCustom('mailbox.client_registered', {
      clientId: input.clientId,
      sessionId: input.sessionId,
      name: input.name,
      source: input.source,
    });
    this.publishHqMailboxSnapshot();
  }

  async deregisterClient(clientId: string): Promise<void> {
    await this._ensureClientRegistry();
    await withFileLock(this.clientRegistryPath, async () => {
      const registry = await this._readClientRegistry({ fresh: true });
      this._pruneStaleClientsInPlace(registry);
      this.pruneHeartbeatThrottleMap(this._lastClientHeartbeat, registry);
      registry.delete(clientId);
      this._clientRegistryCache = registry;
      this._clientRegistryCacheAt = Date.now();
      await this._writeClientRegistry(registry);
    });
    this._lastClientHeartbeat.delete(clientId);
    this._events?.emitCustom('mailbox.client_deregistered', { clientId });
    this.publishHqMailboxSnapshot();
  }

  async clientHeartbeat(input: ClientHeartbeatInput): Promise<void> {
    // Throttle: at most one heartbeat per client per HEARTBEAT_THROTTLE_MS
    const last = this._lastClientHeartbeat.get(input.clientId) ?? 0;
    const now = Date.now();
    if (now - last < HEARTBEAT_THROTTLE_MS) return;

    this._lastClientHeartbeat.set(input.clientId, now);

    await this._ensureClientRegistry();

    await withFileLock(this.clientRegistryPath, async () => {
      const registry = await this._readClientRegistry({ fresh: true });
      this._pruneStaleClientsInPlace(registry);
      this.pruneHeartbeatThrottleMap(this._lastClientHeartbeat, registry);

      const client = registry.get(input.clientId);
      if (client) {
        client.lastSeenAt = new Date().toISOString();
        if (typeof input.sessionId === 'string' && input.sessionId.length > 0) {
          client.sessionId = input.sessionId;
        }
      }

      this._clientRegistryCache = registry;
      this._clientRegistryCacheAt = Date.now();
      await this._writeClientRegistry(registry);
    });

    // Emit event so TUI/WebUI can track online clients in real time
    this._events?.emitCustom('mailbox.client_heartbeat', {
      clientId: input.clientId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    });
    this.publishHqMailboxSnapshot();
  }

  async getClientStatuses(): Promise<ClientStatus[]> {
    await this._ensureClientRegistry();
    let registry = await this._readClientRegistry();
    const before = registry.size;
    this._pruneStaleClientsInPlace(registry);

    // Persist the pruning so stale entries in _mailbox.clients.json don't
    // accumulate indefinitely. Without this, `getClientStatuses` prunes in
    // memory only — the stale JSON records survive on disk until another
    // write happens (registerClient / clientHeartbeat), which may never
    // occur if all bridge clients are dead.
    //
    // Lock around the read-prune-write to prevent racing concurrent
    // registerClient / clientHeartbeat / deregisterClient calls, all of
    // which also acquire this lock.
    if (registry.size < before) {
      await withFileLock(this.clientRegistryPath, async () => {
        // Re-read under the lock so a concurrent write since our
        // initial read is not overwritten.
        registry = await this._readClientRegistry({ fresh: true });
        const postLockBefore = registry.size;
        this._pruneStaleClientsInPlace(registry);
        if (registry.size < postLockBefore) {
          await this._writeClientRegistry(registry);
        }
      });
    }

    return mapRegisteredClientsToStatuses(registry, Date.now(), CLIENT_STALE_MS);
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
    await this._ensureClientRegistry();
    let purged = 0;
    await withFileLock(this.clientRegistryPath, async () => {
      const registry = await this._readClientRegistry({ fresh: true });
      const before = registry.size;
      this._pruneStaleClientsInPlace(registry);
      purged = before - registry.size;
      if (purged > 0) {
        this._clientRegistryCache = registry;
        this._clientRegistryCacheAt = Date.now();
        await this._writeClientRegistry(registry);
      }
    });
    return purged;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async close(): Promise<void> {
    // JSONL append-only — no flush needed
    this._registryCache = null;
    this._clientRegistryCache = null;
    this._messageCache.clear();
  }

  async clearAll(): Promise<void> {
    // Truncate the mailbox file and promote the empty cache under the same
    // lock, with the post-truncate stat captured synchronously so a
    // concurrent reader doesn't misclassify the shrink as a "file only
    // grew" append.
    await withFileLock(this.messagePath, async () => {
      await atomicWrite(this.messagePath, '');
      const { mtimeMs, size } = await this._statMessageFile();
      this._messageCache.set([], { mtimeMs, size });
    });
  }

  async purgeStale(opts?: PurgeOptions): Promise<PurgeResult> {
    const COMPLETED_MAX_AGE_MS = opts?.completedMaxAgeMs ?? 86_400_000; // 1 day
    const INCOMPLETE_MAX_AGE_MS = opts?.incompleteMaxAgeMs ?? 604_800_000; // 7 days

    let completedPurged = 0;
    let incompletePurged = 0;
    let remaining = 0;

    // Read-modify-write under the lock — same pattern as ack().
    await withFileLock(this.messagePath, async () => {
      const all = await this._readMessagesFresh();
      const now = Date.now();
      const cutoffCompleted = now - COMPLETED_MAX_AGE_MS;
      const cutoffIncomplete = now - INCOMPLETE_MAX_AGE_MS;

      const kept: MailboxMessage[] = [];

      for (const msg of all) {
        const msgTime = new Date(msg.timestamp).getTime();
        const completedTime = msg.completedAt ? new Date(msg.completedAt).getTime() : 0;

        if (msg.completed && completedTime < cutoffCompleted) {
          completedPurged++;
          continue; // drop
        }
        if (!msg.completed && msgTime < cutoffIncomplete) {
          incompletePurged++;
          continue; // drop
        }

        kept.push(msg);
      }
      remaining = kept.length;

      // Rewrite only if something changed
      if (kept.length < all.length) {
        const content = kept.map((m) => JSON.stringify(m)).join(LINE_SEPARATOR) + LINE_SEPARATOR;
        // Atomic temp+rename — a torn compact would silently drop messages.
        await atomicWrite(this.messagePath, content);
      }
      // Capture the post-write (or post-read when nothing purged) stat
      // inside the lock so the cache trackers match the on-disk state.
      const { mtimeMs, size } = await this._statMessageFile();
      // Either way we just read fresh under the lock, so adopt the kept
      // snapshot (== all when nothing was purged) as the cache.
      this._messageCache.set(kept, { mtimeMs, size });
    });

    return {
      completedPurged,
      incompletePurged,
      totalPurged: completedPurged + incompletePurged,
      remaining,
    };
  }

  // ── Auto-compaction ─────────────────────────────────────────────────────

  private _autoCompactTimer: NodeJS.Timeout | null = null;

  async autoCompact(opts?: AutoCompactOptions): Promise<AutoCompactResult> {
    const readMaxAgeMs = opts?.readMaxAgeMs ?? AUTO_COMPACT_READ_MAX_AGE_MS;
    const defaultTtlMs = opts?.defaultTtlMs ?? AUTO_COMPACT_DEFAULT_TTL_MS;
    const completedMaxAgeMs = opts?.completedMaxAgeMs ?? 86_400_000; // 1 day
    const incompleteMaxAgeMs = opts?.incompleteMaxAgeMs ?? 604_800_000; // 7 days

    let expiredPurged = 0;
    let readByAllPurged = 0;
    let completedPurged = 0;
    let incompletePurged = 0;
    let remaining = 0;

    // Resolve the currently-online agent identities so we can check
    // "has every online agent read this?" without a second file read.
    // Online registry is advisory — if it is temporarily empty we
    // skip the read-by-all pass rather than purging everything.
    let onlineAgents: Map<string, string | undefined> | null = null;
    try {
      const statuses = await this.getAgentStatuses();
      const online = statuses.filter((s) => s.online);
      onlineAgents =
        online.length > 0 ? new Map(online.map((s) => [s.agentId, s.role])) : null;
    } catch {
      onlineAgents = null;
    }

    await withFileLock(this.messagePath, async () => {
      const all = await this._readMessagesFresh();
      const now = Date.now();
      const cutoffReadAge = now - readMaxAgeMs;
      const cutoffCompleted = now - completedMaxAgeMs;
      const cutoffIncomplete = now - incompleteMaxAgeMs;
      const cutoffDefaultTtl = now - defaultTtlMs;

      const kept: MailboxMessage[] = [];

      for (const msg of all) {
        const msgTime = new Date(msg.timestamp).getTime();

        // Pass 1: Explicit expiry.
        if (msg.expiresAt !== undefined) {
          if (new Date(msg.expiresAt).getTime() < now) {
            expiredPurged++;
            continue;
          }
        } else if (msgTime < cutoffDefaultTtl) {
          // No explicit expiry; use default TTL from send time.
          expiredPurged++;
          continue;
        }

        // Pass 2: Read by ALL currently-online agents.
        if (onlineAgents !== null && !msg.completed) {
          const eligibleAgentIds = [...onlineAgents]
            .filter(([id, role]) => isMailboxMessageVisibleTo(msg, id, role))
            .map(([id]) => id);
          const readByAll =
            eligibleAgentIds.length > 0 && eligibleAgentIds.every((id) => id in msg.readBy);
          if (readByAll) {
            // Check age of the most recent read receipt.
            const readTimes = Object.values(msg.readBy).map((t) => new Date(t).getTime());
            const latestRead = Math.max(...readTimes);
            if (latestRead < cutoffReadAge) {
              readByAllPurged++;
              continue;
            }
          }
        }

        // Pass 3: Standard purge-stale logic.
        const completedTime = msg.completedAt ? new Date(msg.completedAt).getTime() : 0;
        if (msg.completed && completedTime < cutoffCompleted) {
          completedPurged++;
          continue;
        }
        if (!msg.completed && msgTime < cutoffIncomplete) {
          incompletePurged++;
          continue;
        }

        kept.push(msg);
      }
      remaining = kept.length;

      if (kept.length < all.length) {
        const content = kept.map((m) => JSON.stringify(m)).join(LINE_SEPARATOR) + LINE_SEPARATOR;
        // Atomic temp+rename — a torn compact would silently drop messages.
        await atomicWrite(this.messagePath, content);
      }
      const { mtimeMs, size } = await this._statMessageFile();
      this._messageCache.set(kept, { mtimeMs, size });
    });

    const totalRemoved = expiredPurged + readByAllPurged + completedPurged + incompletePurged;
    return {
      expiredRemoved: expiredPurged,
      readByAllRemoved: readByAllPurged,
      stalePurged: completedPurged + incompletePurged,
      totalRemoved,
      remaining,
    };
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
   * Read all messages from the JSONL file. Always reads + parses the file.
   * Callers that can tolerate a stale-by-mtime view should use
   * {@link _readMessagesCached}; writers that need the post-lock truth
   * should call this directly (it's what {@link _readMessagesFresh} aliases).
   */
  private async _readMessages(): Promise<MailboxMessage[]> {
    try {
      const raw = await fsp.readFile(this.messagePath, 'utf8');
      return parseMailboxLines(raw);
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
    try {
      const st = await fsp.stat(this.messagePath);
      return { mtimeMs: st.mtimeMs, size: st.size };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { mtimeMs: -1, size: -1 };
      }
      throw err;
    }
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
   * Read messages, consulting the mtime-bounded in-memory cache first,
   * serialized so concurrent callers don't both mutate the cache.
   *
   * The mailbox file is shared across processes; every `send`/`ack`/
   * `clearAll`/`purgeStale` takes the file lock, so writes are serialized
   * and a changed mtimeMs is a definitive freshness signal. When the
   * stat matches the cached mtime+size we return the cached array — no
   * file read and no JSON.parse — collapsing the per-iteration query
   * cost on the mailbox-loop hot path.
   *
   * When the file only grew (new messages appended by another process),
   * we read and parse just the tail bytes instead of the entire file.
   * This avoids re-parsing the full 10K-message history on every check.
   *
   * SERIALIZATION: the actual work is chained onto `_readChain` so two
   * overlapping calls can't both pass the `st.size > _messageCacheSize`
   * incremental check against the same stale tracker and each push the
   * same tail bytes onto the cache (duplicating every appended message).
   * Readers don't conflict on file content — only on the cache mutation
   * that follows the read — so we run them one at a time in issue order.
   * Errors in the chain are swallowed so a failed read never poisons
   * subsequent reads; each caller observes and re-throws its own error.
   */
  private _readMessagesCached(): Promise<MailboxMessage[]> {
    return this._messageCache.readCached(this.messagePath, () => this._readMessages());
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
    return this.send({
      ...input,
      from: actor.actorId,
      senderSessionId: actor.sessionId,
    });
  }

  /**
   * Acknowledge a message with a verified actor context.
   * Stamps `readerId` from the actor. Rejects if the message is not
   * visible to the actor (visibility check before persistence).
   */
  async ackFor(
    actor: MailboxActorContext,
    input: { messageId: string; read?: boolean; completed?: boolean; outcome?: string },
  ): Promise<MailboxMessage | null> {
    // Visibility check: the actor must be able to see the message.
    const all = await this._readMessagesCached();
    const target = all.find((m) => m.id === input.messageId);
    if (target === undefined) return null;
    if (!isMailboxMessageVisibleTo(target, actor.actorId, actor.role)) {
      return null; // NOT_FOUND — does not disclose existence
    }
    return this.ack({
      messageId: input.messageId,
      readerId: actor.actorId,
      read: input.read ?? true,
      completed: input.completed ?? false,
      outcome: input.outcome,
    });
  }

  /**
   * Query messages with a verified actor context.
   * Derives `readerRole` and `unreadBy` from the actor.
   */
  async queryFor(
    actor: MailboxActorContext,
    query?: Partial<MailboxQuery>,
  ): Promise<MailboxMessage[]> {
    return this.query({
      ...query,
      readerRole: actor.role ?? actor.actorId.split('@', 1)[0]!,
      // Do not let body override unreadBy — derive from actor.
      unreadBy: query?.unreadBy ?? actor.actorId,
    });
  }

  /**
   * Soft-delete a message with a verified actor context.
   * Rejects if the message is not visible to the actor.
   */
  async softDeleteFor(actor: MailboxActorContext, mailId: string): Promise<MailboxMessage | null> {
    const all = await this._readMessagesCached();
    const target = all.find((m) => m.id === mailId);
    if (target === undefined) return null;
    if (!isMailboxMessageVisibleTo(target, actor.actorId, actor.role)) {
      return null;
    }
    return this.softDelete(mailId, actor.actorId);
  }

  /**
   * Restore a soft-deleted message with a verified actor context.
   * Rejects if the message is not visible to the actor.
   */
  async restoreFor(actor: MailboxActorContext, mailId: string): Promise<MailboxMessage | null> {
    const all = await this._readMessagesCached();
    const target = all.find((m) => m.id === mailId);
    if (target === undefined) return null;
    if (!isMailboxMessageVisibleTo(target, actor.actorId, actor.role)) {
      return null;
    }
    return this.restore(mailId);
  }
}

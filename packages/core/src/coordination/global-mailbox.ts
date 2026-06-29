/**
 * GlobalMailbox — project-level inter-agent mailbox with cross-session support.
 *
 * Stores messages at `~/.wrongstack/projects/<slug>/_mailbox.jsonl` so all
 * sessions (terminals, WebUIs) working on the same project share one inbox.
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
import { withFileLock } from '../utils/atomic-write.js';
import { projectSlug } from '../utils/wstack-paths.js';
import { normalizeRecipient } from './mailbox-types.js';
import type { EventBus } from '../kernel/events.js';
import type { HqPublisher } from '../hq/publisher.js';
import type {
  AgentHeartbeatInput,
  AgentRegistrationInput,
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

// ── Constants ────────────────────────────────────────────────────────────

const MAILBOX_FILE = '_mailbox.jsonl';
const CLIENT_REGISTRY_FILE = '_mailbox.clients.json';
/** Agents without a heartbeat for this long are considered offline. */
const AGENT_STALE_MS = 60_000;
/** Clients without a heartbeat for this long are considered offline. */
const CLIENT_STALE_MS = 60_000;
/** Heartbeat updates are throttled to at most this interval. */
const HEARTBEAT_THROTTLE_MS = 5_000;
/**
 * How long a read may be served from the in-process registry cache before
 * re-reading the shared file. Kept well below HEARTBEAT_THROTTLE_MS so
 * cross-process registrations become visible promptly.
 */
const REGISTRY_CACHE_TTL_MS = 2_000;
const LINE_SEPARATOR = '\n';
/**
 * Soft cap on the in-memory message cache. The cache mirrors the JSONL
 * message file; under normal load it stays well under this. If a pathological
 * mailbox exceeds the cap we fall back to reading from disk rather than
 * holding an unbounded buffer in memory.
 */
const MESSAGE_CACHE_MAX_ENTRIES = 10_000;

type HqPublisherRef = HqPublisher | (() => HqPublisher | undefined);

/**
 * Derive the project-level mailbox directory path.
 *
 * Delegates to the CANONICAL `projectSlug()` from wstack-paths so every
 * surface (CLI, TUI, WebUI, mailbox tool, loop checker) lands in the exact
 * same `~/.wrongstack/projects/<slug>/` directory. A previous inline copy
 * skipped the leading/trailing-hyphen strip, which silently split agents
 * working on projects with non-alphanumeric name edges into TWO mailboxes.
 *
 * @param projectRoot  — absolute path to the project root
 * @param globalRoot   — `~/.wrongstack` (or custom global root)
 */
export function resolveProjectDir(projectRoot: string, globalRoot: string): string {
  return path.join(globalRoot, 'projects', projectSlug(projectRoot));
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
  /**
   * In-memory mirror of the JSONL message file. The mailbox is shared
   * ACROSS PROCESSES, so reads cannot trust the cache blindly — we pair it
   * with an mtime check. The file lock serializes every write, so a
   * changed mtimeMs is a definitive signal that another process (or this
   * one) wrote; an unchanged mtimeMs guarantees no write happened and the
   * cache is current. This collapses the per-iteration `query()` cost from
   * O(file_size) disk + parse to O(messages) in memory.
   */
  private _messageCache: MailboxMessage[] | null = null;
  /** mtimeMs of the file when `_messageCache` was populated. */
  private _messageCacheMtime = -1;
  /** Size of the file when `_messageCache` was populated (extra guard). */
  private _messageCacheSize = -1;

  /**
   * @param projectDir — `~/.wrongstack/projects/<slug>/`
   * @param events — optional EventBus for real-time TUI/WebUI notifications
   * @param hqPublisher — optional HQ publisher, or getter, for cross-project telemetry
   */
  constructor(projectDir: string, events?: EventBus, hqPublisher?: HqPublisherRef) {
    this.messagePath = path.join(projectDir, MAILBOX_FILE);
    this.registryPath = path.join(projectDir, '_mailbox.registry.json');
    this.clientRegistryPath = path.join(projectDir, CLIENT_REGISTRY_FILE);
    this._events = events;
    this._hqPublisher = hqPublisher;
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
    const now = new Date().toISOString();
    const msg: MailboxMessage = {
      id: randomUUID(),
      from: input.from,
      // "all" is an accepted spelling of the broadcast address — canonical
      // form on disk is '*' so every query/checker matches it.
      to: normalizeRecipient(input.to),
      type: input.type,
      subject: input.subject,
      body: input.body,
      priority: input.priority ?? 'normal',
      readBy: {},
      completed: false,
      timestamp: now,
      replyTo: input.replyTo,
      taskContext: input.taskContext,
    };

    const line = JSON.stringify(msg) + LINE_SEPARATOR;
    await fsp.mkdir(path.dirname(this.messagePath), { recursive: true });
    // The append must hold the same lock ack() rewrites under: an unlocked
    // append racing ack's read→rewrite gets silently erased when the rewrite
    // lands. This file is shared ACROSS PROCESSES, so the window is real.
    await withFileLock(this.messagePath, async () => {
      await fsp.appendFile(this.messagePath, line, 'utf8');
      // Refresh the in-memory cache from the message we just appended —
      // cheaper than re-reading the whole file, and correct because we
      // held the lock so nothing else changed underneath us.
      this._pushToCache(msg);
    });

    this.publishHqMailboxEvent({ mailboxId: this.hqMailboxId, action: 'message.sent', message: msg });
    this.publishHqMailboxSnapshot();
    return msg;
  }

  async query(q: MailboxQuery): Promise<MailboxMessage[]> {
    const all = await this._readMessagesCached();
    const limit = q.limit ?? 50;

    // Single-pass filter — previously 7 chained .filter() allocations each
    // producing a fresh array. Predicates are independent, so we can AND
    // them in one walk and short-circuit per element.
    const order = q.minPriority !== undefined
      ? { low: 0, normal: 1, high: 2 } as const
      : null;
    const minPriorityRank = order && q.minPriority !== undefined ? order[q.minPriority] : 0;
    const out: MailboxMessage[] = [];
    for (let i = 0; i < all.length; i++) {
      const m = all[i]!;
      if (q.to !== undefined && m.to !== q.to && m.to !== '*') continue;
      if (q.from !== undefined && m.from !== q.from) continue;
      if (q.unreadBy !== undefined && q.unreadBy in m.readBy) continue;
      if (q.incompleteOnly && m.completed) continue;
      if (q.type !== undefined && m.type !== q.type) continue;
      if (
        order !== null &&
        (order[m.priority as keyof typeof order] ?? 1) < minPriorityRank!
      ) {
        continue;
      }
      if (q.since !== undefined && m.timestamp <= q.since) continue;
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

  async ackMany(input: MailboxAckBatchInput): Promise<MailboxMessage[]> {
    // One lock acquisition + one file rewrite for the whole batch. The
    // previous per-message ack() did a full read-modify-rewrite for every
    // single ack — N fresh messages meant N full-file rewrites in a row.
    if (input.acks.length === 0) return [];

    const updated: MailboxMessage[] = [];
    const byId = new Map<string, MailboxAckInput>();
    for (const a of input.acks) {
      // Last-write-wins within the batch for the same messageId — matches
      // the prior sequential semantics where later acks overrode earlier.
      byId.set(a.messageId, a);
    }

    let cacheSnapshot: MailboxMessage[] | null = null;
    await withFileLock(this.messagePath, async () => {
      // Read fresh under the lock — the cache may be stale relative to
      // other processes that wrote since our last read.
      const all = await this._readMessagesFresh();
      const now = new Date().toISOString();
      let changed = false;

      for (const msg of all) {
        const a = byId.get(msg.id);
        if (!a) continue;
        // Preserve prior semantics: return the message as long as it was
        // found, even if the ack was a no-op (e.g. already read).
        updated.push(msg);
        if (a.read !== false && !(a.readerId in msg.readBy)) {
          msg.readBy[a.readerId] = now;
          changed = true;
        }
        if (a.completed && !msg.completed) {
          msg.completed = true;
          msg.completedBy = a.readerId;
          msg.completedAt = now;
          changed = true;
        }
        if (a.outcome !== undefined && msg.outcome !== a.outcome) {
          msg.outcome = a.outcome;
          changed = true;
        }
      }

      // Only rewrite the file if at least one ack actually mutated state —
      // a re-ack of an already-read message is now a no-op on disk, where
      // previously it was a full rewrite.
      if (changed) {
        const serialized =
          all.map((m) => JSON.stringify(m)).join(LINE_SEPARATOR) + LINE_SEPARATOR;
        await fsp.writeFile(this.messagePath, serialized, 'utf8');
      }
      // We always hold the authoritative post-read snapshot (we read fresh
      // under the lock), so adopt it as the cache regardless of whether we
      // wrote — future queries skip both the stat and the parse.
      cacheSnapshot = all;
    });

    // Promote the freshly-read array to the cache without re-reading.
    if (cacheSnapshot) this._setMessageCache(cacheSnapshot);
    for (const message of updated) {
      this.publishHqMailboxEvent({
        mailboxId: this.hqMailboxId,
        action: message.completed ? 'message.completed' : 'message.read',
        message,
      });
    }
    if (updated.length > 0) this.publishHqMailboxSnapshot();
    return updated;
  }

  async unreadCount(forAgentId: string): Promise<number> {
    const all = await this._readMessagesCached();
    let count = 0;
    for (let i = 0; i < all.length; i++) {
      const m = all[i]!;
      if ((m.to === forAgentId || m.to === '*') && !(forAgentId in m.readBy) && !m.completed) {
        count++;
      }
    }
    return count;
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
      pid: input.pid,
      source: input.source,
    };

    await withFileLock(this.registryPath, async () => {
      // fresh: read-modify-write must start from the on-disk state, not the
      // cache — other processes may have registered agents since.
      const registry = await this._readRegistry({ fresh: true });
      // Prune stale agents
      this._pruneStaleInPlace(registry);
      // Upsert
      registry.set(input.agentId, agent);
      // Update cache
      this._registryCache = registry;
      this._registryCacheAt = Date.now();
      await this._writeRegistry(registry);
    });

    // Emit event for TUI/WebUI to update online agent count
    this._events?.emitCustom('mailbox.agent_registered', {
      agentId: input.agentId, sessionId: input.sessionId,
      name: input.name, role: input.role, source: input.source,
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
        pid: input.pid,
        ...(input.source !== undefined ? { source: input.source } : {}),
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
    const registry = await this._readRegistry();
    this._pruneStaleInPlace(registry);

    const now = Date.now();
    return Array.from(registry.values())
      .map((a) => ({
        agentId: a.agentId,
        name: a.name,
        role: a.role,
        sessionId: a.sessionId,
        status: a.status,
        currentTool: a.currentTool,
        currentTask: a.currentTask,
        iterations: a.iterations,
        toolCalls: a.toolCalls,
        lastActivityAt: a.lastSeenAt,
        lastSeenAt: a.lastSeenAt,
        online: now - new Date(a.lastSeenAt).getTime() < AGENT_STALE_MS,
        pid: a.pid,
        source: a.source,
      }))
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
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
      pid: input.pid,
    };

    await withFileLock(this.clientRegistryPath, async () => {
      const registry = await this._readClientRegistry({ fresh: true });
      this._pruneStaleClientsInPlace(registry);
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
    const registry = await this._readClientRegistry();
    this._pruneStaleClientsInPlace(registry);

    const now = Date.now();
    return Array.from(registry.values())
      .map((c) => ({
        clientId: c.clientId,
        name: c.name,
        source: c.source,
        sessionId: c.sessionId,
        lastSeenAt: c.lastSeenAt,
        online: now - new Date(c.lastSeenAt).getTime() < CLIENT_STALE_MS,
        pid: c.pid,
      }))
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async close(): Promise<void> {
    // JSONL append-only — no flush needed
    this._registryCache = null;
    this._clientRegistryCache = null;
    this._messageCache = null;
    this._messageCacheMtime = -1;
    this._messageCacheSize = -1;
  }

  async clearAll(): Promise<void> {
    // Truncate the mailbox file under the same lock that protects append/ack.
    await withFileLock(this.messagePath, async () => {
      await fsp.writeFile(this.messagePath, '', 'utf8');
    });
    // Reflect the empty mailbox in the cache without a re-read.
    this._setMessageCache([]);
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
        await fsp.writeFile(this.messagePath, content, 'utf8');
      }
      // Either way we just read fresh under the lock, so adopt the kept
      // snapshot (== all when nothing was purged) as the cache.
      this._setMessageCache(kept);
    });

    return {
      completedPurged,
      incompletePurged,
      totalPurged: completedPurged + incompletePurged,
      remaining,
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
      return this._parseLines(raw);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  /**
   * Read only newly-appended bytes from the file and append them to the
   * in-memory cache. This avoids re-reading and re-parsing the entire file
   * when another process appended messages since our last read.
   *
   * Only safe when the file grew in size (messages are append-only). When
   * the file was rewritten (ack/purge changed existing content), callers
   * must fall back to {@link _readMessages}.
   *
   * @returns The (now up-to-date) message cache.
   */
  private async _readNewMessagesOnly(
    fd: fsp.FileHandle,
    oldSize: number,
    newSize: number,
  ): Promise<MailboxMessage[]> {
    const tailLen = newSize - oldSize;
    const buf = Buffer.alloc(tailLen);
    await fd.read(buf, 0, tailLen, oldSize);
    const tail = buf.toString('utf8');
    // Parse and append each new line to the cache.
    for (const line of tail.split(LINE_SEPARATOR)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        // Migrate old `read: boolean` + `readAt` to new `readBy`
        if (!parsed['readBy']) {
          const readBy: Record<string, string> = {};
          if (parsed['read'] && parsed['readAt']) {
            readBy[parsed['to'] as string] = parsed['readAt'] as string;
          }
          parsed['readBy'] = readBy;
          delete parsed['read'];
          delete parsed['readAt'];
        }
        this._messageCache!.push(parsed as never as MailboxMessage);
      } catch {
        // Skip malformed lines
      }
    }
    return this._messageCache!;
  }

  /** Parse a JSONL string into MailboxMessage[], including migration. */
  private _parseLines(raw: string): MailboxMessage[] {
    const lines = raw.split(LINE_SEPARATOR).filter((l) => l.trim().length > 0);
    const messages: MailboxMessage[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        // Migrate old `read: boolean` + `readAt` to new `readBy`
        if (!parsed['readBy']) {
          const readBy: Record<string, unknown> = {};
          if (parsed['read'] && parsed['readAt']) {
            readBy[parsed['to'] as string] = parsed['readAt'];
          }
          parsed['readBy'] = readBy;
          delete parsed['read'];
          delete parsed['readAt'];
        }
        messages.push(parsed as never as MailboxMessage);
      } catch {
        // Skip malformed lines
      }
    }
    return messages;
  }

  /**
   * Read messages, then adopt the result as the in-memory cache. Use this
   * from writers that just took the file lock — the read reflects the
   * authoritative post-lock state and should be served to subsequent
   * queries without re-reading.
   */
  private async _readMessagesFresh(): Promise<MailboxMessage[]> {
    const all = await this._readMessages();
    this._setMessageCache(all);
    return all;
  }

  /**
   * Read messages, consulting the mtime-bounded in-memory cache first.
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
   */
  private async _readMessagesCached(): Promise<MailboxMessage[]> {
    try {
      const st = await fsp.stat(this.messagePath);

      // Fast path: cache is current — no disk I/O beyond stat.
      if (
        this._messageCache !== null &&
        this._messageCacheMtime === st.mtimeMs &&
        this._messageCacheSize === st.size
      ) {
        return this._messageCache;
      }

      // Incremental path: cache exists and the file only grew (appends).
      // No ack/purge/clear rewrote the file, so we only need to parse
      // the newly-appended bytes.
      if (
        this._messageCache !== null &&
        this._messageCacheSize >= 0 &&
        st.size > this._messageCacheSize
      ) {
        const fd = await fsp.open(this.messagePath, 'r');
        try {
          const updated = await this._readNewMessagesOnly(fd, this._messageCacheSize, st.size);
          this._messageCacheMtime = st.mtimeMs;
          this._messageCacheSize = st.size;
          return updated;
        } finally {
          await fd.close();
        }
      }

      // Full re-read: cache empty, file was rewritten (ack/purge), or
      // this is the first read.
      const all = await this._readMessages();
      this._setMessageCache(all, st.mtimeMs, st.size);
      return all;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this._setMessageCache([], -1, -1);
        return [];
      }
      throw err;
    }
  }

  /**
   * Replace the in-memory cache. Caller is responsible for guaranteeing
   * that `messages` reflects the current on-disk state (e.g. they just
   * read or wrote it under the file lock).
   */
  private _setMessageCache(
    messages: MailboxMessage[],
    mtime?: number,
    size?: number,
  ): void {
    // Bound the cache so a runaway mailbox can't balloon memory. The cap
    // is high enough that any realistic project mailbox fits; if it ever
    // exceeds the cap we just refuse to cache and the next read goes to
    // disk (the unoptimized but correct behavior).
    if (messages.length > MESSAGE_CACHE_MAX_ENTRIES) {
      this._messageCache = null;
      this._messageCacheMtime = -1;
      this._messageCacheSize = -1;
      return;
    }
    this._messageCache = messages;
    // When the caller didn't supply an mtime (e.g. in-memory promotion
    // after a write we already did), we re-stat to capture the post-write
    // mtimeMs lazily so the next cached read validates against reality.
    if (mtime !== undefined && size !== undefined) {
      this._messageCacheMtime = mtime;
      this._messageCacheSize = size;
    } else {
      // Fire-and-forget stat to refresh the mtime tracker. Failures just
      // leave the previous values; the worst case is an extra cache miss.
      void fsp
        .stat(this.messagePath)
        .then((st) => {
          this._messageCacheMtime = st.mtimeMs;
          this._messageCacheSize = st.size;
        })
        .catch(() => {
          /* leave cache in place; next read will re-stat */
        });
    }
  }

  /**
   * Append a single just-sent message to the in-memory cache without
   * re-reading the file. The caller must hold the file lock (or have
   * just released it after a successful append) so the cache stays
   * consistent with on-disk state.
   */
  private _pushToCache(msg: MailboxMessage): void {
    if (this._messageCache === null) return;
    if (this._messageCache.length >= MESSAGE_CACHE_MAX_ENTRIES) {
      this._messageCache = null;
      this._messageCacheMtime = -1;
      this._messageCacheSize = -1;
      return;
    }
    // The cache holds shared message objects; we mirror the on-disk line
    // by storing the same reference. Callers of `query()` get defensive
    // copies, so this shared reference is safe.
    this._messageCache.push(msg);
    // Defer the mtime refresh — the just-released lock will have advanced
    // mtime, but we'll re-stat lazily on the next cache validation.
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

    try {
      const raw = await fsp.readFile(this.registryPath, 'utf8');
      const data = JSON.parse(raw) as Record<string, RegisteredAgent>;
      // Parse lastSeenAt strings back into objects
      const map = new Map<string, RegisteredAgent>();
      for (const [id, agent] of Object.entries(data)) {
        map.set(id, agent as RegisteredAgent);
      }
      this._registryCache = map;
      this._registryCacheAt = Date.now();
      return new Map(map);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        const empty = new Map<string, RegisteredAgent>();
        this._registryCache = empty;
        this._registryCacheAt = Date.now();
        return empty;
      }
      throw err;
    }
  }

  private _pruneStaleInPlace(registry: Map<string, RegisteredAgent>): void {
    const cutoff = Date.now() - AGENT_STALE_MS;
    for (const agent of registry.values()) {
      if (new Date(agent.lastSeenAt).getTime() < cutoff) {
        agent.status = 'idle'; // preserve entry but mark as offline
        // Note: we don't delete — the WebUI wants to show recently-offline agents
      }
    }
  }

  private async _writeRegistry(registry: Map<string, RegisteredAgent>): Promise<void> {
    const obj: Record<string, RegisteredAgent> = {};
    for (const [id, agent] of registry) {
      obj[id] = agent;
    }
    const tmp = `${this.registryPath}.${randomUUID().slice(0, 8)}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(obj), 'utf8');
    await fsp.rename(tmp, this.registryPath);
  }

  // ── Client registry internals ───────────────────────────────────────────

  private async _ensureClientRegistry(): Promise<void> {
    await fsp.mkdir(path.dirname(this.clientRegistryPath), { recursive: true });
  }

  private async _readClientRegistry(
    opts?: { fresh?: boolean },
  ): Promise<Map<string, RegisteredClient>> {
    if (
      !opts?.fresh &&
      this._clientRegistryCache &&
      Date.now() - this._clientRegistryCacheAt < REGISTRY_CACHE_TTL_MS
    ) {
      return new Map(this._clientRegistryCache);
    }

    try {
      const raw = await fsp.readFile(this.clientRegistryPath, 'utf8');
      const data = JSON.parse(raw) as Record<string, RegisteredClient>;
      const map = new Map<string, RegisteredClient>();
      for (const [id, client] of Object.entries(data)) {
        map.set(id, client as RegisteredClient);
      }
      this._clientRegistryCache = map;
      this._clientRegistryCacheAt = Date.now();
      return new Map(map);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        const empty = new Map<string, RegisteredClient>();
        this._clientRegistryCache = empty;
        this._clientRegistryCacheAt = Date.now();
        return empty;
      }
      throw err;
    }
  }

  private _pruneStaleClientsInPlace(registry: Map<string, RegisteredClient>): void {
    const cutoff = Date.now() - CLIENT_STALE_MS;
    for (const client of registry.values()) {
      if (new Date(client.lastSeenAt).getTime() < cutoff) {
        // Mark as offline but preserve entry
        client.lastSeenAt = new Date(cutoff).toISOString();
      }
    }
  }

  private async _writeClientRegistry(registry: Map<string, RegisteredClient>): Promise<void> {
    const obj: Record<string, RegisteredClient> = {};
    for (const [id, client] of registry) {
      obj[id] = client;
    }
    const tmp = `${this.clientRegistryPath}.${randomUUID().slice(0, 8)}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(obj), 'utf8');
    await fsp.rename(tmp, this.clientRegistryPath);
  }
}

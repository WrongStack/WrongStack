/**
 * DefaultMailbox — append-only JSONL inter-agent mailbox (per-session).
 *
 * Stores messages under `<sessionDir>/_mailbox.jsonl`. Every send appends
 * one line. Query reads and filters all lines. Ack rewrites changed
 * messages in-place via atomic write.
 *
 * For cross-session communication, use GlobalMailbox instead.
 *
 * @module DefaultMailbox
 */

import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { withFileLock } from '../utils/atomic-write.js';
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
} from './mailbox-types.js';
import { normalizeRecipient } from './mailbox-types.js';

const MAILBOX_FILE = '_mailbox.jsonl';
const LINE_SEPARATOR = '\n';
const MESSAGE_CACHE_MAX_ENTRIES = 10_000;

export class DefaultMailbox implements Mailbox {
  private readonly filePath: string;
  private _messageCache: MailboxMessage[] | null = null;
  private _messageCacheMtime = -1;
  private _messageCacheSize = -1;
  /** Primary index: recipient → Set of messages (points into _messageCache). */
  private _byTo = new Map<string, Set<MailboxMessage>>();
  /** Secondary index: sender → Set of messages (points into _messageCache). */
  private _byFrom = new Map<string, Set<MailboxMessage>>();
  /** Counts malformed JSONL lines skipped during parsing for observability. */
  private _corruptionCount = 0;

  constructor(sessionDir: string) {
    this.filePath = path.join(sessionDir, MAILBOX_FILE);
  }

  get mailboxPath(): string {
    return this.filePath;
  }

  /** Returns the count of malformed JSONL lines encountered during reads. */
  get corruptionCount(): number {
    return this._corruptionCount;
  }

  // ── Send ──────────────────────────────────────────────────────────────

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
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    // The append must hold the same lock ack() rewrites under: an unlocked
    // append racing ack's read→rewrite gets silently erased when the rewrite
    // lands (it was serialized from a snapshot taken before the append).
    //
    // We also stat the file under the same lock and advance the cache
    // metadata to the new size/mtime. This keeps the cache in lock-step
    // with the file: the next _readAllCached() hits the fast path and
    // returns the just-appended message, instead of taking the incremental
    // "file only grew" branch and re-parsing the same bytes that
    // _pushToCache() already added to the cache (which would duplicate
    // the message).
    await withFileLock(this.filePath, async () => {
      await fsp.appendFile(this.filePath, line, 'utf8');
      this._pushToCache(msg);
      const { mtime, size } = await this._statUnderLockOrAbsent();
      this._messageCacheMtime = mtime;
      this._messageCacheSize = size;
    });
    return msg;
  }

  // ── Query ─────────────────────────────────────────────────────────────

  async query(q: MailboxQuery): Promise<MailboxMessage[]> {
    // unreadBy and since require a full scan because they depend on per-message
    // mutable state (readBy) and wall-clock time respectively — no index helps.
    // When either is present, fall back to a scan; otherwise use the _byTo/_byFrom
    // indexes to narrow candidates O(1) before applying remaining filters.
    const needFullScan = q.unreadBy !== undefined || q.since !== undefined;

    let candidates: MailboxMessage[];
    if (needFullScan) {
      candidates = await this._readAllCached();
    } else {
      // Ensure cache + indexes are populated and fresh before reading from
      // them. _readAllCached() compares mtime/size to detect external file
      // changes and calls _setMessageCache() → _buildIndexes() when stale.
      await this._readAllCached();
      if (q.to !== undefined) {
        const direct = this._byTo.get(q.to);
        const broadcast = this._byTo.get('*');
        // Combine direct + broadcast candidates; deduplicate via Map insertion order
        const combined = new Map<string, MailboxMessage>();
        if (direct) for (const m of direct) combined.set(m.id, m);
        if (broadcast) for (const m of broadcast) combined.set(m.id, m);
        candidates = Array.from(combined.values());
      } else if (q.from !== undefined) {
        candidates = Array.from(this._byFrom.get(q.from) ?? []);
      } else {
        candidates = await this._readAllCached();
      }
    }

    const limit = q.limit ?? 50;
    const order = q.minPriority !== undefined ? ({ low: 0, normal: 1, high: 2 } as const) : null;
    const minPriorityRank = order && q.minPriority !== undefined ? order[q.minPriority] : 0;
    const passes = (msg: MailboxMessage): boolean => {
      if (q.to !== undefined && msg.to !== q.to && msg.to !== '*') return false;
      if (q.from !== undefined && msg.from !== q.from) return false;
      if (q.unreadBy !== undefined && q.unreadBy in msg.readBy) return false;
      if (q.incompleteOnly && msg.completed) return false;
      if (q.type !== undefined && msg.type !== q.type) return false;
      if (order !== null && (order[msg.priority as keyof typeof order] ?? 1) < minPriorityRank)
        return false;
      if (q.since !== undefined && msg.timestamp <= q.since) return false;
      return true;
    };

    // When `candidates` is in append (chronological) order — which it is
    // for the file-scan and cache-array paths — we can avoid the full
    // O(N log N) sort by iterating newest-first and stopping at `limit`.
    // The candidate order for the indexed path (`_byTo.get(...)` etc.)
    // is also insertion order, which equals append order on this side
    // because every push goes through _pushToCache / _indexMsg in the
    // order the lines were parsed.
    if (order === null) {
      const out: MailboxMessage[] = [];
      for (let i = candidates.length - 1; i >= 0 && out.length < limit; i--) {
        const msg = candidates[i]!;
        if (passes(msg)) out.push(msg);
      }
      return out;
    }

    // Priority-ordered queries still require a full sort, but we cap
    // the working set to the first N matches under the timestamp order
    // so we never re-rank more messages than we have to return.
    const filtered: MailboxMessage[] = [];
    for (let i = candidates.length - 1; i >= 0; i--) {
      const msg = candidates[i]!;
      if (passes(msg)) filtered.push(msg);
    }
    filtered.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return filtered.slice(0, limit);
  }

  // ── Ack ───────────────────────────────────────────────────────────────

  async ack(input: MailboxAckInput): Promise<MailboxMessage | null> {
    const updated = await this.ackMany({ acks: [input] });
    return updated.length > 0 ? updated[0]! : null;
  }

  async softDelete(_mailId: string, _by: string): Promise<MailboxMessage | null> {
    // No-op default — subclasses backed by a real file backend
    // (`GlobalMailbox`) override this. The skeleton exists so the
    // interface compiles; an in-memory default would just confuse
    // callers.
    return null;
  }

  async restore(_mailId: string): Promise<MailboxMessage | null> {
    // See `softDelete` — no-op default.
    return null;
  }

  async ackMany(input: MailboxAckBatchInput): Promise<MailboxMessage[]> {
    // Batched: one lock acquisition + one file rewrite for N acks. The
    // per-message ack() did a full read-modify-rewrite for every single
    // ack — N acks meant N full-file rewrites in a row.
    if (input.acks.length === 0) return [];
    const updated: MailboxMessage[] = [];
    const byId = new Map<string, MailboxAckInput>();
    for (const a of input.acks) byId.set(a.messageId, a);

    await withFileLock(this.filePath, async () => {
      const all = await this._readAll();
      const now = new Date().toISOString();
      let changed = false;
      for (const msg of all) {
        const a = byId.get(msg.id);
        if (!a) continue;
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
      if (changed) {
        const serialized = all.map((m) => JSON.stringify(m)).join(LINE_SEPARATOR) + LINE_SEPARATOR;
        await fsp.writeFile(this.filePath, serialized, 'utf8');
      }
      // Stat synchronously under the same file lock that protected the
      // write above. The cache metadata must reflect the file we just
      // produced (or the existing file if nothing changed), and the
      // lock prevents any concurrent appender/ack from racing us.
      // Returns the (-1, -1) sentinel if the file doesn't exist yet
      // (e.g. ack on a session that has never sent a message).
      const { mtime, size } = await this._statUnderLockOrAbsent();
      this._setMessageCache(all, mtime, size);
    });
    return updated;
  }

  // ── Agent statuses ────────────────────────────────────────────────────

  async getAgentStatuses(): Promise<MailboxAgentStatus[]> {
    const all = await this._readAllCached();
    const latest = new Map<string, MailboxAgentStatus>();
    for (const m of all) {
      if (m.type !== 'status') continue;
      // taskContext is optional — status messages posted through the mailbox
      // tool carry only from/subject. Synthesize a minimal entry from those
      // so fleet discovery still sees the agent.
      const existing = latest.get(m.from);
      if (existing && m.timestamp <= existing.lastActivityAt) continue;
      latest.set(m.from, {
        agentId: m.from,
        name: m.taskContext?.agentName ?? m.from,
        role: m.taskContext?.agentRole,
        sessionId: m.senderSessionId ?? '?',
        status: (m.taskContext?.status as MailboxAgentStatus['status']) ?? 'idle',
        currentTool: undefined,
        currentTask: m.subject,
        iterations: 0,
        toolCalls: 0,
        lastActivityAt: m.timestamp,
        lastSeenAt: m.timestamp,
        online: true,
        pid: 0,
        source: undefined,
      });
    }
    return Array.from(latest.values()).sort((a, b) =>
      b.lastActivityAt.localeCompare(a.lastActivityAt),
    );
  }

  // ── Stubs for cross-session features (not applicable per-session) ─────

  async getOnlineAgents(): Promise<MailboxAgentStatus[]> {
    return this.getAgentStatuses();
  }

  async registerAgent(_input: AgentRegistrationInput): Promise<void> {
    // no-op: per-session mailbox doesn't track agents globally
  }

  async deregisterAgent(_agentId: string): Promise<void> {
    // no-op: per-session mailbox doesn't track agents globally
  }

  async heartbeat(_input: AgentHeartbeatInput): Promise<void> {
    // no-op: per-session mailbox doesn't track heartbeats
  }

  async unreadCount(forAgentId: string): Promise<number> {
    const all = await this._readAllCached();
    return all.filter(
      (m) => (m.to === forAgentId || m.to === '*') && !(forAgentId in m.readBy) && !m.completed,
    ).length;
  }

  async close(): Promise<void> {
    this._messageCache = null;
    this._messageCacheMtime = -1;
    this._messageCacheSize = -1;
    this._byTo.clear();
    this._byFrom.clear();
  }

  async clearAll(): Promise<void> {
    // Truncate the mailbox file under the same lock that protects
    // append/ack so a concurrent send can't be half-erased.
    await withFileLock(this.filePath, async () => {
      await fsp.writeFile(this.filePath, '', 'utf8');
      // Stat under the same lock so the cache metadata reflects exactly
      // the truncated file. mtime is the post-truncate timestamp; size
      // is 0 (or 1 on some platforms that leave a trailing newline).
      const { mtime, size } = await this._statUnderLockOrAbsent();
      this._setMessageCache([], mtime, size);
    });
  }

  async purgeStale(opts?: PurgeOptions): Promise<PurgeResult> {
    const COMPLETED_MAX_AGE_MS = opts?.completedMaxAgeMs ?? 86_400_000; // 1 day
    const INCOMPLETE_MAX_AGE_MS = opts?.incompleteMaxAgeMs ?? 604_800_000; // 7 days

    let completedPurged = 0;
    let incompletePurged = 0;
    let remaining = 0;

    await withFileLock(this.filePath, async () => {
      const all = await this._readAll();
      const now = Date.now();
      const cutoffCompleted = now - COMPLETED_MAX_AGE_MS;
      const cutoffIncomplete = now - INCOMPLETE_MAX_AGE_MS;

      const kept: MailboxMessage[] = [];

      for (const msg of all) {
        const msgTime = new Date(msg.timestamp).getTime();
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
        await fsp.writeFile(this.filePath, content, 'utf8');
      }
      // Stat under the same file lock that protected the (possible)
      // write above. The cache metadata must reflect the file's current
      // state so subsequent _readAllCached() calls take the right branch
      // (fast path / incremental / full re-read).
      const { mtime, size } = await this._statUnderLockOrAbsent();
      this._setMessageCache(kept, mtime, size);
    });

    return {
      completedPurged,
      incompletePurged,
      totalPurged: completedPurged + incompletePurged,
      remaining,
    };
  }

  // ── Client registry stubs (not applicable per-session) ─────────────────

  async registerClient(_input: ClientRegistrationInput): Promise<void> {
    // no-op: per-session mailbox doesn't track clients globally
  }

  async clientHeartbeat(_input: ClientHeartbeatInput): Promise<void> {
    // no-op: per-session mailbox doesn't track client heartbeats
  }

  async getClientStatuses(): Promise<ClientStatus[]> {
    // no-op: per-session mailbox doesn't track clients globally
    return [];
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private async _readAll(): Promise<MailboxMessage[]> {
    try {
      const raw = await fsp.readFile(this.filePath, 'utf8');
      return this._parseLines(raw);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  /**
   * Read only newly-appended bytes from the file and append them to the
   * in-memory cache, avoiding a full re-read when the file only grew.
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
    for (const line of tail.split(LINE_SEPARATOR)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (!parsed['readBy']) {
          const readBy: Record<string, string> = {};
          if (parsed['read'] && parsed['readAt']) {
            readBy[(parsed['to'] as string) ?? 'unknown'] = parsed['readAt'] as string;
          }
          parsed['readBy'] = readBy;
          delete parsed['read'];
          delete parsed['readAt'];
        }
        const msg = parsed as never as MailboxMessage;
        this._messageCache!.push(msg);
        this._indexMsg(msg);
      } catch (err) {
        this._corruptionCount++;
        console.debug(
          `[mailbox] skipped malformed line during incremental read: ${(err as Error).message}`,
        );
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
        if (!parsed['readBy']) {
          const readBy: Record<string, unknown> = {};
          if (parsed['read'] && parsed['readAt']) {
            readBy[(parsed['to'] as string) ?? 'unknown'] = parsed['readAt'];
          }
          parsed['readBy'] = readBy;
          delete parsed['read'];
          delete parsed['readAt'];
        }
        messages.push(parsed as never as MailboxMessage);
      } catch (err) {
        this._corruptionCount++;
        console.debug(
          `[mailbox] skipped malformed line during full parse: ${(err as Error).message}`,
        );
      }
    }
    return messages;
  }

  /**
   * Stat the mailbox file under the assumption that we are holding the
   * file lock, and that a write to the file has just completed. Returns
   * the (mtimeMs, size) pair, or (-1, -1) if the file does not exist
   * (e.g. ackMany/purgeStale on a session that has never sent a message).
   */
  private async _statUnderLockOrAbsent(): Promise<{ mtime: number; size: number }> {
    try {
      const st = await fsp.stat(this.filePath);
      return { mtime: st.mtimeMs, size: st.size };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { mtime: -1, size: -1 };
      }
      throw err;
    }
  }

  private async _readAllCached(): Promise<MailboxMessage[]> {
    try {
      const st = await fsp.stat(this.filePath);

      // Fast path: cache is current.
      if (
        this._messageCache !== null &&
        this._messageCacheMtime === st.mtimeMs &&
        this._messageCacheSize === st.size
      ) {
        return this._messageCache;
      }

      // Incremental path: file only grew (appends, no rewrite).
      if (
        this._messageCache !== null &&
        this._messageCacheSize >= 0 &&
        st.size > this._messageCacheSize
      ) {
        const fd = await fsp.open(this.filePath, 'r');
        try {
          const updated = await this._readNewMessagesOnly(fd, this._messageCacheSize, st.size);
          this._messageCacheMtime = st.mtimeMs;
          this._messageCacheSize = st.size;
          return updated;
        } finally {
          await fd.close();
        }
      }

      // Full re-read: cache empty, file was rewritten (ack/purge).
      const all = await this._readAll();
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

  private _setMessageCache(messages: MailboxMessage[], mtime: number, size: number): void {
    if (messages.length > MESSAGE_CACHE_MAX_ENTRIES) {
      this._messageCache = null;
      this._messageCacheMtime = -1;
      this._messageCacheSize = -1;
      this._byTo.clear();
      this._byFrom.clear();
      return;
    }
    this._messageCache = messages;
    this._buildIndexes(messages);
    // Set mtime/size synchronously in the same critical section as the
    // file write that produced them. The previous implementation fired
    // a fire-and-forget fsp.stat() here when callers did not pass values,
    // which could race with a later rewrite: a stale stat result from
    // the older call would clobber the freshly-computed mtime/size set
    // by the later call, leading _readAllCached() to take the wrong
    // "file only grew" branch on the next read and append the rewritten
    // contents onto the existing cache (duplicated / stale messages).
    this._messageCacheMtime = mtime;
    this._messageCacheSize = size;
  }

  private _pushToCache(msg: MailboxMessage): void {
    if (this._messageCache === null) return;
    if (this._messageCache.length >= MESSAGE_CACHE_MAX_ENTRIES) {
      this._messageCache = null;
      this._messageCacheMtime = -1;
      this._messageCacheSize = -1;
      this._byTo.clear();
      this._byFrom.clear();
      return;
    }
    this._messageCache.push(msg);
    this._indexMsg(msg);
  }

  /** Rebuild both indexes from a full message list. */
  private _buildIndexes(messages: MailboxMessage[]): void {
    this._byTo.clear();
    this._byFrom.clear();
    for (const msg of messages) {
      this._indexMsg(msg);
    }
  }

  /** Add a single message to both indexes. */
  private _indexMsg(msg: MailboxMessage): void {
    const toSet = this._byTo.get(msg.to);
    if (toSet) {
      toSet.add(msg);
    } else {
      this._byTo.set(msg.to, new Set([msg]));
    }

    const fromSet = this._byFrom.get(msg.from);
    if (fromSet) {
      fromSet.add(msg);
    } else {
      this._byFrom.set(msg.from, new Set([msg]));
    }
  }
}

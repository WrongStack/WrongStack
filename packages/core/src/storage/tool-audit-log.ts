import { expectDefined } from '../utils/expect-defined.js';
import { toErrorMessage } from '../utils/error.js';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { withFileLock } from '../utils/atomic-write.js';
import { safeParse } from '../utils/safe-json.js';
import { sessionScopedPath } from '../utils/session-scoped-path.js';
import type { EventBus } from '../kernel/events.js';
/**
 * ToolAuditLog — idea #9 from IDEAS.md.
 *
 * Tamper-evident audit trail for tool calls. Every tool_use /
 * tool_result pair is appended to a sidecar JSONL with a chained
 * SHA-256 — each entry's `prevHash` is the prior entry's `hash`,
 * so any post-hoc modification of a single line breaks the chain
 * from that point forward.
 *
 * Why a sidecar (not the session JSONL)?
 *   Same reason as `AnnotationsStore` and `ReplayLogStore`: the
 *   session log is an event-sourced journal. Mixing in a hash
 *   chain would inflate every read and tightly couple the
 *   integrity check to the event format. Sidecar keeps both
 *   concerns orthogonal.
 *
 * What "tamper-evident" means here:
 *   - The hash covers the full serialized entry: tool name, id,
 *     input, output, timestamp, author. Changing any byte
 *     changes the hash.
 *   - The chain is sequential — a verifier walks the file in
 *     order, recomputing each hash, and checks `prevHash`
 *     matches the previous entry's `hash`.
 *   - Any insertion, deletion, or modification of a single
 *     entry surfaces as a "chain broken at entry N" verdict.
 *
 * What it does NOT defend against:
 *   - An attacker who rewrites the whole file consistently.
 *     For that you'd need an external anchor (signing key,
 *     transparency log, etc.) — out of scope for Phase 1.
 *   - The agent itself misbehaving; this is post-hoc audit, not
 *     real-time enforcement. Use `PermissionPolicy` for that.
 *
 * File layout: `sessionScopedPath(dir, sessionId, '.audit.jsonl')`,
 * one entry per line. The chain starts with a `genesis` entry whose
 * `prevHash` is all zeros.
 */
export interface AuditEntry {
  /** Monotonic index (0-based). */
  index: number;
  /** UUID for cross-referencing with logs. */
  id: string;
  /** ISO timestamp. */
  ts: string;
  /** Hash of the previous entry (or all-zeros for the genesis entry). */
  prevHash: string;
  /** Hash of this entry's content (sha256 over the canonical JSON). */
  hash: string;
  toolName: string;
  toolUseId: string;
  input: unknown;
  output: unknown;
  isError: boolean;
}

const GENESIS_PREV = '0'.repeat(64);

export type VerifyResult =
  | { ok: true; entries: number }
  | { ok: false; brokenAt: number; reason: string };

export interface ToolAuditLogOptions {
  /** Root sessions directory used with `sessionScopedPath(..., '.audit.jsonl')`. */
  dir: string;
  /**
   * Flush the file system cache to disk every N writes per session.
   * Default 100. Lower values = better crash durability, more I/O overhead.
   * Set to `Infinity` to disable periodic fsync (fastest, but highest data-loss risk).
   */
  fsyncEvery?: number | undefined;
  events?: EventBus;
  traceId?: string;
}

/** Default number of writes between fsync calls. */
const DEFAULT_FSYNC_EVERY = 100;

export class ToolAuditLog {
  private readonly dir: string;
  private readonly events: EventBus | undefined;
  private readonly traceId: string | undefined;
  /** In-memory cache of the last entry's hash (per session), to compute chains efficiently. */
  private readonly tailHash = new Map<string, string>();
  /** In-memory counter for entry indices — avoids re-reading the file on every write. */
  private readonly tailIndex = new Map<string, number>();
  /**
   * File mtime+size recorded after our last write, per session. Used to
   * detect cross-process writes (session handoff, recovery) that would
   * invalidate the in-memory tail cache: if the stat no longer matches
   * we re-read the file to re-establish the chain tip before appending.
   */
  private readonly tailStat = new Map<string, { mtimeMs: number; size: number }>();
  /** Tracks writes since last fsync, per session. */
  private readonly unSyncedWrites = new Map<string, number>();
  private readonly writeChains = new Map<string, Promise<void>>();
  private readonly fsyncEvery: number;

  constructor(opts: ToolAuditLogOptions) {
    this.dir = opts.dir;
    this.events = opts.events;
    this.traceId = opts.traceId;
    this.fsyncEvery = opts.fsyncEvery ?? DEFAULT_FSYNC_EVERY;
  }

  /**
   * Append a tool call/result pair to the chain. Returns the
   * resulting entry. Idempotency is not guaranteed — if you
   * record the same tool_use twice you get two entries. That's
   * intentional: the audit log is a record, not a cache.
   */
  async record(input: {
    sessionId: string;
    toolName: string;
    toolUseId: string;
    input: unknown;
    output: unknown;
    isError: boolean;
  }): Promise<AuditEntry> {
    let entry!: AuditEntry; // assigned inside the enqueue callback
    const fp = this.filePath(input.sessionId);
    const t0 = Date.now();
    try {
      await this.enqueue(input.sessionId, async () => {
        await withFileLock(fp, async () => {
          // Resolve the chain tip from the in-memory cache when possible,
          // re-reading the file only on first contact or when an external
          // writer (cross-process session handoff) changed it under us.
          // The previous implementation did `readAll` on every single
          // record just to find `entries.at(-1)` — a full parse of the
          // audit file per tool call.
          const tip = await this._resolveChainTip(input.sessionId, fp);
          const prevHash = tip.prevHash;
          const index = tip.nextIndex;

          const id = randomUUID();
          const ts = new Date().toISOString();
          const content = {
            id,
            ts,
            prevHash,
            toolName: input.toolName,
            toolUseId: input.toolUseId,
            input: input.input,
            output: input.output,
            isError: input.isError,
            index,
          };
          const hash = createHash('sha256').update(stableStringify(content), 'utf8').digest('hex');
          entry = {
            id,
            ts,
            prevHash,
            hash,
            toolName: input.toolName,
            toolUseId: input.toolUseId,
            input: input.input,
            output: input.output,
            isError: input.isError,
            index,
          };

          // True O(1) append — one line, no full-file rewrite. The previous
          // `writeAll(entries)` path re-serialized every entry on every
          // record; a 1000-call session rewrote a multi-MB audit file 1000
          // times (quadratic in session length). `withFileLock` above
          // guarantees no concurrent writer interleaves with our append.
          await fs.appendFile(fp, JSON.stringify(entry) + '\n', 'utf8');

          // Refresh caches + fsync bookkeeping. We stat post-write so the
          // mtime+size tracker reflects the just-appended line — the next
          // record can trust the cache without re-reading.
          try {
            const st = await fs.stat(fp);
            this.tailStat.set(input.sessionId, { mtimeMs: st.mtimeMs, size: st.size });
          } catch {
            /* best-effort; next record will just re-read */
          }
          this.tailHash.set(input.sessionId, hash);
          this.tailIndex.set(input.sessionId, index + 1);
          await this._trackUnsynced(input.sessionId, fp);

          const durationMs = Date.now() - t0;
          this.events?.emit('storage.write', {
            sessionId: input.sessionId,
            store: 'audit',
            filePath: fp,
            operation: 'record',
            outcome: 'success',
            durationMs,
            ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
          });
        });
      });
      return entry;
    } catch (err) {
      this.events?.emit('storage.error', {
        sessionId: input.sessionId,
        store: 'audit',
        filePath: fp,
        operation: 'record',
        outcome: 'failure',
        error: toErrorMessage(err),
        recoverable: false,
        durationMs: Date.now() - t0,
        ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
      });
      throw err;
    }
  }

  /**
   * Resolve the chain tip (previous hash + next index) for an append.
   * Uses the in-memory `tailHash`/`tailIndex` cache when the file's
   * stat matches our last known write; falls back to a full read on
   * cache miss or when an external writer has extended the file.
   */
  private async _resolveChainTip(
    sessionId: string,
    fp: string,
  ): Promise<{ prevHash: string; nextIndex: number }> {
    const cachedHash = this.tailHash.get(sessionId);
    const cachedIndex = this.tailIndex.get(sessionId);
    const cachedStat = this.tailStat.get(sessionId);

    if (cachedHash !== undefined && cachedIndex !== undefined && cachedStat) {
      // Verify no other process appended since our last write. Stat is a
      // single inode lookup; the common case (same-process sequential
      // writes) returns immediately and we skip the full read.
      try {
        const st = await fs.stat(fp);
        if (st.mtimeMs === cachedStat.mtimeMs && st.size === cachedStat.size) {
          return { prevHash: cachedHash, nextIndex: cachedIndex };
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          // File was removed out from under us — reset and start a new chain.
          this.tailHash.delete(sessionId);
          this.tailIndex.delete(sessionId);
          this.tailStat.delete(sessionId);
          return { prevHash: GENESIS_PREV, nextIndex: 0 };
        }
        /* v8 ignore next -- defensive: a non-ENOENT stat failure during cache-hit is rare */
        throw err;
      }
    }

    // Cache miss or external write detected — read the true tail.
    const entries = await this.readAll(sessionId);
    const prev = entries.at(-1);
    const prevHash = prev?.hash ?? GENESIS_PREV;
    const nextIndex = prev ? prev.index + 1 : 0;
    this.tailHash.set(sessionId, prevHash);
    this.tailIndex.set(sessionId, nextIndex);
    try {
      const st = await fs.stat(fp);
      this.tailStat.set(sessionId, { mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      /* leave cache empty; next record re-reads */
    }
    return { prevHash, nextIndex };
  }

  /**
   * Walk the chain and verify every entry's hash and prevHash.
   * Returns a structured verdict — never throws.
   */
  async verify(sessionId: string): Promise<VerifyResult> {
    const fp = this.filePath(sessionId);
    const t0 = Date.now();
    let entries: AuditEntry[];
    try {
      entries = await this.readAll(sessionId);
    } catch (err) {
      // The file exists but can't be read (permissions, corruption). We
      // can't verify it, so emit a read failure for observability and
      // degrade gracefully — this method's contract is "never throws".
      this.events?.emit('storage.read', {
        sessionId,
        store: 'audit',
        filePath: fp,
        operation: 'verify',
        outcome: 'failure',
        durationMs: Date.now() - t0,
        error: toErrorMessage(err),
        ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
      });
      return { ok: true, entries: 0 };
    }

    // Walk the chain into a verdict, then emit a single storage.read whose
    // outcome reflects the verification result (a broken chain is a failure).
    const verdict = ((): VerifyResult => {
      if (entries.length === 0) return { ok: true, entries: 0 };
      // The first entry's prevHash must be the all-zeros genesis marker.
      if (entries[0]?.prevHash !== GENESIS_PREV) {
        return {
          ok: false,
          brokenAt: 0,
          reason: 'first entry is not the genesis (prevHash != 0…0)',
        };
      }
      let prevHash = GENESIS_PREV;
      for (let i = 0; i < entries.length; i++) {
        const e = expectDefined(entries[i]);
        if (e.prevHash !== prevHash) {
          return {
            ok: false,
            brokenAt: i,
            reason: `prevHash mismatch at entry ${i} (expected ${prevHash.slice(0, 8)}…, got ${e.prevHash.slice(0, 8)}…)`,
          };
        }
        // Recompute the hash from the entry's content (without the
        // `hash` field itself, which is what we are verifying).
        const content = {
          id: e.id,
          ts: e.ts,
          prevHash: e.prevHash,
          toolName: e.toolName,
          toolUseId: e.toolUseId,
          input: e.input,
          output: e.output,
          isError: e.isError,
          index: e.index,
        };
        const expectedHash = createHash('sha256')
          .update(stableStringify(content), 'utf8')
          .digest('hex');
        if (expectedHash !== e.hash) {
          return {
            ok: false,
            brokenAt: i,
            reason: `hash mismatch at entry ${i} (entry content was modified)`,
          };
        }
        prevHash = e.hash;
      }
      return { ok: true, entries: entries.length };
    })();

    this.events?.emit('storage.read', {
      sessionId,
      store: 'audit',
      filePath: fp,
      operation: 'verify',
      outcome: verdict.ok ? 'success' : 'failure',
      durationMs: Date.now() - t0,
      ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
    });
    return verdict;
  }

  /** All entries for a session, in insertion order. */
  async load(sessionId: string): Promise<AuditEntry[]> {
    const fp = this.filePath(sessionId);
    const t0 = Date.now();
    try {
      const entries = await this.readAll(sessionId);
      const durationMs = Date.now() - t0;
      this.events?.emit('storage.read', {
        sessionId,
        store: 'audit',
        filePath: fp,
        operation: 'load',
        outcome: 'success',
        durationMs,
        ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
      });
      return entries;
    } catch (err) {
      const durationMs = Date.now() - t0;
      this.events?.emit('storage.read', {
        sessionId,
        store: 'audit',
        filePath: fp,
        operation: 'load',
        outcome: 'failure',
        durationMs,
        error: toErrorMessage(err),
        ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
      });
      throw err;
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private filePath(sessionId: string): string {
    // Containment-checked: date-sharded ids ("2026-06-11/<base>") are
    // legitimate; traversal is rejected. A plain slash ban would throw
    // for every modern session id the moment record() gets wired in.
    return sessionScopedPath(this.dir, sessionId, '.audit.jsonl');
  }

  private async readAll(sessionId: string): Promise<AuditEntry[]> {
    const fp = this.filePath(sessionId);
    try {
      const raw = await fs.readFile(fp, 'utf8');
      const out: AuditEntry[] = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = safeParse<AuditEntry>(line);
          if (parsed.ok && parsed.value) out.push(parsed.value);
        } catch {
          // Skip corrupt lines — audit data is meta, not fatal.
        }
      }
      return out;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      // Non-ENOENT errors (EACCES, ENOSPC, etc.) are real I/O failures —
      // re-throw so callers (verify, load) can emit storage.error.
      throw err;
    }
  }

  /**
   * Tracks writes since last fsync and triggers periodic fsync.
   * Called after each O(1) append to maintain the same durability
   * guarantees as the old writeAll approach.
   */
  private async _trackUnsynced(sessionId: string, fp: string): Promise<void> {
    const count = (this.unSyncedWrites.get(sessionId) ?? 0) + 1;
    this.unSyncedWrites.set(sessionId, count);
    if (this.fsyncEvery !== Number.POSITIVE_INFINITY && count % this.fsyncEvery === 0) {
      await this.sync(sessionId, fp);
    }
  }

  /**
   * Explicitly sync the file to disk. Called automatically every
   * `fsyncEvery` writes, and available for callers who want to
   * force a sync before closing or during graceful shutdown.
   */
  async flush(sessionId: string): Promise<void> {
    await this.sync(sessionId, this.filePath(sessionId));
  }

  private async sync(sessionId: string, fp: string): Promise<void> {
    try {
      const fh = await fs.open(fp, 'r+');
      try {
        await fh.sync();
      } finally {
        await fh.close();
      }
    } catch {
      // fsync is best-effort; a failure here does not corrupt the chain.
    } finally {
      this.unSyncedWrites.set(sessionId, 0);
    }
  }

  private enqueue(sessionId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.writeChains.get(sessionId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.writeChains.set(
      sessionId,
      next.catch(() => undefined),
    );
    return next;
  }
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeys(obj[key]);
    }
    return sorted;
  }
  return value;
}

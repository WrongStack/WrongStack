/**
 * SQLite-backed Chronicle journal (phase 1 of `chronicle-sqlite-journal-v1`).
 *
 * Same durable contract as `ChronicleJournal`, different storage: events become
 * rows instead of lines in `<day>.events.jsonl` partitions. The tamper-evident
 * chain is unchanged and deliberately so — `sequence`, `previousHash` and
 * `hash` mean exactly what they mean in the JSONL journal, and the hash is
 * computed by the shared `event-hash.ts` so the two stores can never drift.
 *
 * Why the payload is stored verbatim: the `hash` preimage is the canonical
 * encoding of the event *minus* its own `hash`. Reconstructing an event from
 * projected columns and re-hashing it would silently depend on the column set
 * staying lossless forever. Storing `JSON.stringify(event)` and re-deriving the
 * preimage from the parsed payload keeps verification independent of the
 * projection — the columns are a read-path index, never the source of truth.
 *
 * Only the project daemon opens this database, after it has won the endpoint
 * election, so the writer is single by construction and `BEGIN IMMEDIATE` is
 * enough. See `packages/core/tests/architecture/project-daemon-boundary.test.ts`.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { withSqliteExperimentalWarningSuppressed } from '../utils/index.js';
import { chronicleEventHash, GENESIS_HASH, hashValue } from './event-hash.js';
import type { ChronicleJournalStats, ChroniclePurgeResult } from './journal.js';
import {
  ChronicleSqliteQueryEngine,
  type ChronicleSqliteQueryEngineOptions,
} from './sqlite-query.js';
import {
  CHRONICLE_SCHEMA_VERSION,
  type ChronicleEvent,
  type ChronicleEventInput,
  type ChronicleVerifyResult,
} from './types.js';

export const CHRONICLE_SQLITE_FILE = 'chronicle.sqlite';

/** Marker written once the legacy JSONL partitions have been imported. */
export const LEGACY_JSONL_MIGRATION_KEY = 'legacy-jsonl-v1';

/** Day families the import refused to move, recorded so they are never retried silently. */
export const LEGACY_JSONL_QUARANTINE_KEY = 'legacy-jsonl-v1:quarantine';

const SCHEMA_VERSION = 1;
const SQLITE_FIXED_OVERHEAD_BYTES = 16 * 1024 * 1024;
const MIN_SQLITE_PAGE_BUDGET_BYTES = 64 * 1024;
/**
 * Ceiling on the slice of `maxBytes` withheld from the main database for the
 * rollback journal.
 *
 * Quota-enabled journals run in DELETE mode, where the rollback journal holds
 * pre-images of the pages touched by ONE transaction — an append batch plus
 * whatever `enforceEventLimitWithinTransaction` evicts. That is bounded by
 * batch size, not by database size, so the reserve must not scale with the
 * quota. It used to: the budget was a flat 50/50 split, which at the shipped
 * 512 MB quota withheld 248 MB for a journal that never needs a fraction of
 * it, and left the main database a 248 MB budget that `maxEvents: 100_000`
 * filled to 98.2%. The two bounds then collided — whichever tripped first
 * wedged ingestion. Capping the reserve keeps the aggregate ceiling exactly
 * as configured while giving the main database the share it actually needs.
 *
 * Small quotas still fall back to the old half split (see `journalReserve`),
 * so the documented minimum stays reachable.
 */
const MAX_ROLLBACK_JOURNAL_RESERVE_BYTES = 64 * 1024 * 1024;

export class ChronicleStorageQuotaError extends Error {
  readonly currentBytes: number;
  readonly batchBytes: number;
  readonly maxBytes: number;
  readonly path: string;

  constructor(details: {
    currentBytes: number;
    batchBytes: number;
    maxBytes: number;
    path: string;
  }) {
    super(
      `Chronicle SQLite quota exceeded at ${details.path}: ${details.currentBytes} live bytes + ${details.batchBytes} batch bytes exceeds ${details.maxBytes}; lower chronicle retentionDays/maxEvents to shed data (run chronicle compact to return the freed pages to the filesystem)`,
    );
    this.name = 'ChronicleStorageQuotaError';
    this.currentBytes = details.currentBytes;
    this.batchBytes = details.batchBytes;
    this.maxBytes = details.maxBytes;
    this.path = details.path;
  }
}

export interface ChronicleSqliteJournalOptions {
  /** Directory holding the journal, i.e. `<projectDir>/chronicle`. */
  directory: string;
  now?: (() => Date) | undefined;
  monotonicNow?: (() => bigint) | undefined;
  idFactory?: (() => string) | undefined;
  /** Optional age bound, enforced during periodic maintenance. */
  retentionDays?: number | undefined;
  /** Optional row ceiling; oldest rows are checkpointed and evicted after each append. */
  maxEvents?: number | undefined;
  /** Aggregate SQLite allocation ceiling across the database, WAL, and SHM files. */
  maxBytes?: number | undefined;
  retentionCheckIntervalMs?: number | undefined;
}

export interface ChronicleSqlitePurgeOptions {
  retentionDays: number;
  dryRun?: boolean | undefined;
}

interface ChainAnchor {
  sequence: number;
  hash: string;
}

/** A day family the import refused to move, and why. */
export interface ChronicleQuarantinedFamily {
  day: string;
  sequence: number;
  reason: string;
}

/** Write surface handed to a legacy import; see {@link ChronicleSqliteJournal.runFamilyImport}. */
export interface ChronicleImportSink {
  /**
   * Store an event with its recorded `sequence`, `previousHash` and `hash`.
   *
   * The payload is re-serialized rather than copied byte-for-byte from the
   * JSONL line, which is safe because the hash preimage is the *canonical*
   * encoding derived from the parsed event (§3.1 of the spec) — not the stored
   * bytes. `JSON.parse` round-trips it exactly, so verification is unaffected.
   */
  insert(day: string, event: ChronicleEvent): void;
  /** Carry a legacy day-family retention checkpoint over. */
  checkpoint(day: string, sequence: number, hash: string): void;
}

// ─── node:sqlite lazy loader (mirrors metrics-store.ts) ─────────────────────

let Ctor: typeof DatabaseSync | null | undefined;

function loadDatabaseSync(): typeof DatabaseSync {
  if (Ctor) return Ctor;
  if (Ctor === null) throw new Error('node:sqlite is unavailable in this runtime');
  try {
    Ctor = withSqliteExperimentalWarningSuppressed(
      () =>
        (createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite'))
          .DatabaseSync,
    );
    return Ctor;
  } catch (error) {
    Ctor = null;
    throw new Error(
      "The Chronicle journal needs Node's built-in SQLite (node:sqlite, Node >= 22.5): " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

// ─── Store ──────────────────────────────────────────────────────────────────

export class ChronicleSqliteJournal {
  private readonly db: DatabaseSync;
  private readonly dbPath: string;
  private readonly now: () => Date;
  private readonly monotonicNow: () => bigint;
  private readonly idFactory: () => string;
  private readonly retentionDays: number | undefined;
  private readonly maxEvents: number | undefined;
  private readonly maxBytes: number | undefined;
  private readonly retentionCheckIntervalMs: number;
  private nextRetentionCheckAt = 0;
  private retainedEventCount = 0;
  /** Resolved lazily by `pageSizeBytes()`; constant for an open database. */
  private cachedPageSize: number | undefined;

  /**
   * Cached chain head per day. Cleared wholesale on any write failure so the
   * next append rebuilds from the database rather than trusting a counter that
   * may have advanced past what actually committed.
   */
  private readonly anchors = new Map<string, ChainAnchor>();

  private readonly counters = {
    acceptedEvents: 0,
    persistedEvents: 0,
    rejectedEvents: 0,
    failedEvents: 0,
    batches: 0,
    maxObservedPending: 0,
    largestBatch: 0,
  };
  private lastBatchDurationMs: number | undefined;

  constructor(options: ChronicleSqliteJournalOptions) {
    this.dbPath = path.join(path.resolve(options.directory), CHRONICLE_SQLITE_FILE);
    this.now = options.now ?? (() => new Date());
    this.monotonicNow = options.monotonicNow ?? (() => process.hrtime.bigint());
    this.idFactory = options.idFactory ?? (() => randomUUID());
    if (
      options.retentionDays !== undefined &&
      (!Number.isFinite(options.retentionDays) || options.retentionDays <= 0)
    ) {
      throw new RangeError('retentionDays must be a positive finite number');
    }
    if (
      options.retentionCheckIntervalMs !== undefined &&
      (!Number.isFinite(options.retentionCheckIntervalMs) || options.retentionCheckIntervalMs <= 0)
    ) {
      throw new RangeError('retentionCheckIntervalMs must be a positive finite number');
    }
    if (
      options.maxEvents !== undefined &&
      (!Number.isInteger(options.maxEvents) || options.maxEvents < 1)
    ) {
      throw new RangeError('maxEvents must be a positive integer');
    }
    if (
      options.maxBytes !== undefined &&
      (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1)
    ) {
      throw new RangeError('maxBytes must be a positive safe integer');
    }
    const minimumQuotaBytes = SQLITE_FIXED_OVERHEAD_BYTES + 2 * MIN_SQLITE_PAGE_BUDGET_BYTES;
    if (options.maxBytes !== undefined && options.maxBytes < minimumQuotaBytes) {
      throw new RangeError(`maxBytes must be at least ${minimumQuotaBytes}`);
    }
    this.retentionDays = options.retentionDays;
    this.maxEvents = options.maxEvents;
    this.maxBytes = options.maxBytes;
    this.retentionCheckIntervalMs = options.retentionCheckIntervalMs ?? 60 * 60 * 1_000;
    const Database = loadDatabaseSync();
    this.db = new Database(this.dbPath);
    this.db.exec(`PRAGMA journal_mode = ${this.maxBytes === undefined ? 'WAL' : 'DELETE'}`);
    this.ensureSchema();
    this.configureByteQuota();
    if (this.maxEvents !== undefined) {
      const row = this.db.prepare('SELECT COUNT(*) AS count FROM events').get() as {
        count: number;
      };
      this.retainedEventCount = row.count;
      this.enforceEventLimitAtStartup();
    }
  }

  close(): void {
    this.db.close();
  }

  stats(): ChronicleJournalStats {
    return {
      ...this.counters,
      pendingEvents: 0,
      // Retained at zero for wire compatibility: partitions do not exist here,
      // but `ChronicleJournalStats` is part of the IPC health payload.
      partitionRolls: 0,
      ...(this.lastBatchDurationMs !== undefined
        ? { lastBatchDurationMs: this.lastBatchDurationMs }
        : {}),
    };
  }

  /**
   * Writes are synchronous and transactional, so there is nothing buffered to
   * flush. Kept to satisfy `ChronicleEventSink`.
   */
  async flush(): Promise<void> {
    return Promise.resolve();
  }

  async append(input: ChronicleEventInput): Promise<ChronicleEvent> {
    const [event] = await this.appendBatch([input]);
    // appendBatch either returns one event per input or throws.
    return event as ChronicleEvent;
  }

  /**
   * Append a batch as one transaction.
   *
   * The chain is computed in memory from a single anchor, so a partially
   * applied batch would leave a hole in `sequence` that verification can never
   * reconcile. Rollback plus anchor invalidation is what prevents that.
   */
  async appendBatch(inputs: readonly ChronicleEventInput[]): Promise<ChronicleEvent[]> {
    if (inputs.length === 0) return [];
    const started = performance.now();
    this.counters.acceptedEvents += inputs.length;
    this.counters.batches += 1;
    this.counters.largestBatch = Math.max(this.counters.largestBatch, inputs.length);

    const instant = this.now().toISOString();
    // The chain scope is the wall-clock day of the append, matching the file
    // `journalForToday()` would have opened — not the event's `occurredAt`,
    // which a caller may back-date.
    const day = instant.slice(0, 10);
    const events: ChronicleEvent[] = [];
    let previous = this.readAnchor(day);

    for (const input of inputs) {
      const unhashed = {
        ...input,
        occurredAt: input.occurredAt ?? instant,
        monotonicNs: input.monotonicNs ?? this.monotonicNow().toString(),
        schemaVersion: CHRONICLE_SCHEMA_VERSION,
        eventId: this.idFactory(),
        observedAt: instant,
        persistedAt: instant,
        sequence: previous.sequence + 1,
        previousHash: previous.hash,
      };
      const event: ChronicleEvent = { ...unhashed, hash: hashValue(unhashed) };
      events.push(event);
      previous = { sequence: event.sequence, hash: event.hash };
    }

    let retainedCountAfterCommit = this.retainedEventCount;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      this.assertWithinByteQuota(events);
      const insert = this.db.prepare(
        `INSERT INTO events (
           day, sequence, event_id, hash, previous_hash, occurred_at, event_type, outcome,
           project_id, session_id, agent_id, task_id, trace_id, logical_request_id,
           resource_kind, resource_id, resource_path, duration_ns, payload
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const event of events) {
        const row = projectEvent(event);
        insert.run(
          day,
          event.sequence,
          event.eventId,
          event.hash,
          event.previousHash,
          row.occurredAt,
          event.eventType,
          row.outcome,
          row.projectId,
          row.sessionId,
          row.agentId,
          row.taskId,
          row.traceId,
          row.logicalRequestId,
          row.resourceKind,
          row.resourceId,
          row.resourcePath,
          row.durationNs,
          JSON.stringify(event),
        );
      }
      retainedCountAfterCommit = this.enforceEventLimitWithinTransaction();
      this.assertActualAllocationWithinQuota();
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // A failed BEGIN leaves no transaction to roll back.
      }
      this.anchors.clear();
      this.counters.failedEvents += inputs.length;
      this.lastBatchDurationMs = performance.now() - started;
      throw this.normalizeQuotaError(error);
    }

    this.anchors.set(day, previous);
    this.counters.persistedEvents += events.length;
    this.retainedEventCount = retainedCountAfterCommit;
    this.lastBatchDurationMs = performance.now() - started;
    await this.enforceRetentionIfDue();
    return events;
  }

  async readAll(): Promise<ChronicleEvent[]> {
    const rows = this.db
      .prepare('SELECT payload FROM events ORDER BY day, sequence')
      .all() as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as ChronicleEvent);
  }

  /**
   * Walk every chain and prove none has been edited.
   *
   * Chronicle chains are scoped to a day, not to the journal: the JSONL writer
   * anchors each `<day>.events.jsonl` family at `GENESIS_HASH` independently,
   * so `sequence` restarts at 1 every day. Verification mirrors that — each day
   * is validated on its own, and a break in one does not implicate the others.
   *
   * Three independent properties per day, because each catches a different
   * failure: a dense `sequence` catches deletions from the middle, the
   * `previousHash` link catches reordering, and re-hashing the payload catches
   * an in-place edit that left the links intact.
   */
  async verify(): Promise<ChronicleVerifyResult> {
    let entries = 0;
    let lastSequence = 0;
    let lastHash = GENESIS_HASH;

    for (const day of this.days()) {
      const checkpoint = this.readCheckpoint(day);
      let expectedSequence = (checkpoint?.sequence ?? 0) + 1;
      let previousHash = checkpoint?.hash ?? GENESIS_HASH;

      const rows = this.db
        .prepare(
          'SELECT sequence, hash, previous_hash, payload FROM events WHERE day = ? ORDER BY sequence',
        )
        .all(day) as Array<{
        sequence: number;
        hash: string;
        previous_hash: string;
        payload: string;
      }>;

      for (const row of rows) {
        if (row.sequence !== expectedSequence) {
          return {
            ok: false,
            entries,
            brokenAt: entries,
            reason: `sequence gap in ${day}: expected ${expectedSequence}, found ${row.sequence}`,
          };
        }
        if (row.previous_hash !== previousHash) {
          return { ok: false, entries, brokenAt: entries, reason: 'previous hash mismatch' };
        }
        let event: ChronicleEvent;
        try {
          event = JSON.parse(row.payload) as ChronicleEvent;
        } catch {
          return { ok: false, entries, brokenAt: entries, reason: 'invalid payload JSON' };
        }
        if (chronicleEventHash(event) !== row.hash) {
          return { ok: false, entries, brokenAt: entries, reason: 'entry hash mismatch' };
        }
        entries += 1;
        expectedSequence = row.sequence + 1;
        previousHash = row.hash;
      }

      lastSequence = expectedSequence - 1;
      lastHash = previousHash;
    }

    return { ok: true, entries, lastSequence, lastHash };
  }

  private async enforceRetentionIfDue(): Promise<void> {
    if (this.retentionDays === undefined) return;
    const now = this.now();
    if (now.getTime() < this.nextRetentionCheckAt) return;

    this.nextRetentionCheckAt = now.getTime() + this.retentionCheckIntervalMs;
    try {
      await this.purge({ retentionDays: this.retentionDays });
    } catch {
      // Retention is best-effort maintenance and must never reject event ingestion.
    }
  }

  private configureByteQuota(): void {
    if (this.maxBytes === undefined) {
      // max_page_count persists in the database header; remove a prior quota
      // when the journal is intentionally reopened without one.
      this.db.exec('PRAGMA max_page_count = 2147483646');
      return;
    }
    // Reserve rollback-journal headroom, but never more than a transaction can
    // plausibly need. `Math.min` with the old half split keeps small quotas
    // (and the documented `minimumQuotaBytes`) behaving exactly as before.
    const halfSplit = Math.floor((this.maxBytes - SQLITE_FIXED_OVERHEAD_BYTES) / 2);
    const journalReserve = Math.min(MAX_ROLLBACK_JOURNAL_RESERVE_BYTES, halfSplit);
    const mainBudget = this.maxBytes - SQLITE_FIXED_OVERHEAD_BYTES - journalReserve;
    if (mainBudget < MIN_SQLITE_PAGE_BUDGET_BYTES) {
      throw new Error(
        `maxBytes must be at least ${SQLITE_FIXED_OVERHEAD_BYTES + 2 * MIN_SQLITE_PAGE_BUDGET_BYTES}`,
      );
    }
    const maxPages = Math.max(1, Math.floor(mainBudget / this.pageSizeBytes()));
    this.db.exec(`PRAGMA max_page_count = ${maxPages}`);
  }

  /**
   * Bytes the journal actually occupies: live pages in the main database plus
   * whatever the rollback/WAL sidecars currently hold.
   *
   * The quota MUST be measured this way rather than by `statSync` on the main
   * database file. SQLite never returns freed pages to the filesystem — it
   * parks them on the freelist and reuses them — so a database that once grew
   * large keeps that size forever, even after retention and `maxEvents` have
   * evicted almost everything. Measuring the file instead wedged the journal
   * permanently: a 3.9 GB file whose live data was 243 MB failed a 512 MB
   * quota on EVERY append, and the only escape (`chronicle compact`) refuses
   * to run while the daemon is up — and the daemon respawns on demand. Live
   * pages shrink when retention deletes rows, so the quota can recover on its
   * own; allocated size cannot.
   *
   * The sidecars keep their on-disk size: they are transient and genuinely
   * bounded by `configureByteQuota`'s half-of-budget split.
   */
  private aggregateLiveBytes(): number {
    let total = 0;
    for (const file of [`${this.dbPath}-journal`, `${this.dbPath}-wal`, `${this.dbPath}-shm`]) {
      try {
        total += fs.statSync(file).size;
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
    return total + this.mainDatabaseLiveBytes();
  }

  /** Live (non-freelist) pages of the main database, in bytes. */
  private mainDatabaseLiveBytes(): number {
    const pageCount = Number(
      (this.db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count,
    );
    const freelist = Number(
      (this.db.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count,
    );
    return Math.max(0, pageCount - freelist) * this.pageSizeBytes();
  }

  /** Page size never changes for an open database; resolve it once. */
  private pageSizeBytes(): number {
    if (this.cachedPageSize === undefined) {
      this.cachedPageSize = Number(
        (this.db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size,
      );
    }
    return this.cachedPageSize;
  }

  private normalizeQuotaError(error: unknown): unknown {
    if (this.maxBytes === undefined || !(error instanceof Error)) return error;
    const sqliteError = error as Error & { code?: string | number; errcode?: number };
    const quotaExhausted =
      sqliteError.code === 'SQLITE_FULL' ||
      sqliteError.code === 13 ||
      sqliteError.errcode === 13 ||
      /database or disk is full/i.test(sqliteError.message);
    if (!quotaExhausted) return error;
    return new ChronicleStorageQuotaError({
      currentBytes: this.aggregateLiveBytes(),
      batchBytes: 0,
      maxBytes: this.maxBytes,
      path: this.dbPath,
    });
  }

  private assertActualAllocationWithinQuota(): void {
    if (this.maxBytes === undefined) return;
    const currentBytes = this.aggregateLiveBytes();
    if (currentBytes <= this.maxBytes) return;
    throw new ChronicleStorageQuotaError({
      currentBytes,
      batchBytes: 0,
      maxBytes: this.maxBytes,
      path: this.dbPath,
    });
  }

  private assertWithinByteQuota(events: readonly ChronicleEvent[]): void {
    if (this.maxBytes === undefined) return;
    const currentBytes = this.aggregateLiveBytes();
    const batchBytes = Buffer.byteLength(JSON.stringify(events), 'utf8');
    if (currentBytes + batchBytes <= this.maxBytes) return;
    throw new ChronicleStorageQuotaError({
      currentBytes,
      batchBytes,
      maxBytes: this.maxBytes,
      path: this.dbPath,
    });
  }

  private enforceEventLimitWithinTransaction(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number };
    if (this.maxEvents === undefined || row.count <= this.maxEvents) return row.count;

    const excess = row.count - this.maxEvents;
    const boundary = this.db
      .prepare('SELECT day, sequence, hash FROM events ORDER BY day, sequence LIMIT 1 OFFSET ?')
      .get(excess - 1) as (ChainAnchor & { day: string }) | undefined;
    if (!boundary) return row.count;

    this.db
      .prepare(
        `INSERT INTO chain_checkpoint (day, sequence, hash) VALUES (?, ?, ?)
         ON CONFLICT(day) DO UPDATE SET sequence = excluded.sequence, hash = excluded.hash`,
      )
      .run(boundary.day, boundary.sequence, boundary.hash);
    this.db
      .prepare('DELETE FROM events WHERE day < ? OR (day = ? AND sequence <= ?)')
      .run(boundary.day, boundary.day, boundary.sequence);
    this.db.prepare('DELETE FROM chain_checkpoint WHERE day < ?').run(boundary.day);
    this.anchors.clear();
    return this.maxEvents;
  }

  private enforceEventLimitAtStartup(): void {
    if (this.maxEvents === undefined || this.retainedEventCount <= this.maxEvents) return;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const retainedCount = this.enforceEventLimitWithinTransaction();
      this.db.exec('COMMIT');
      this.retainedEventCount = retainedCount;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Preserve the original startup failure.
      }
      throw error;
    }
  }

  /**
   * Drop events older than the retention window.
   *
   * Retention is day-granular and chains are day-scoped, so a purge removes
   * whole chains rather than truncating one. That is why nothing needs to be
   * checkpointed here: there is no surviving suffix left dangling without an
   * anchor. Any checkpoint imported from a partially-purged legacy day family
   * is dropped alongside its events.
   */
  async purge(options: ChronicleSqlitePurgeOptions): Promise<ChroniclePurgeResult> {
    const empty: ChroniclePurgeResult = {
      deletedCount: 0,
      deletedBytes: 0,
      skippedCount: 0,
      errors: [],
    };
    if (!Number.isFinite(options.retentionDays) || options.retentionDays <= 0) return empty;

    const cutoff = new Date(this.now().getTime() - options.retentionDays * 86_400_000)
      .toISOString()
      .slice(0, 10);

    const count = (
      this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE day < ?').get(cutoff) as {
        n: number;
      }
    ).n;
    if (count === 0) return empty;

    if (options.dryRun) {
      const days = this.db
        .prepare('SELECT DISTINCT day FROM events WHERE day < ? ORDER BY day')
        .all(cutoff) as Array<{ day: string }>;
      return { ...empty, deletedCount: count, candidates: days.map((row) => row.day) };
    }

    try {
      this.db.exec('BEGIN IMMEDIATE');
      this.db.prepare('DELETE FROM events WHERE day < ?').run(cutoff);
      this.db.prepare('DELETE FROM chain_checkpoint WHERE day < ?').run(cutoff);
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Nothing to unwind.
      }
      return {
        ...empty,
        errors: [
          {
            file: this.dbPath,
            reason: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }

    this.anchors.clear();
    this.retainedEventCount = Math.max(0, this.retainedEventCount - count);
    return { ...empty, deletedCount: count };
  }

  /**
   * Run one day family's legacy import inside its own transaction.
   *
   * Deliberately separate from `appendBatch`: the append path *computes*
   * `sequence`, `previousHash` and `hash`, while an import must carry them over
   * untouched. Fusing the two would put a code path one refactor away from
   * re-hashing historical events, which is the one change that silently
   * destroys their tamper evidence.
   *
   * The transaction is scoped to a single family because chains are: `sequence`
   * restarts at 1 each day, so one day's break says nothing about the next
   * day's integrity. A whole-journal transaction made every future day hostage
   * to the worst day on disk — one corrupt family and the daemon could never
   * open its store again. The family is still all-or-nothing: a break rolls
   * back that day entirely, so no partial chain is ever visible.
   */
  async runFamilyImport(load: (sink: ChronicleImportSink) => Promise<void>): Promise<void> {
    const insert = this.db.prepare(
      `INSERT INTO events (
         day, sequence, event_id, hash, previous_hash, occurred_at, event_type, outcome,
         project_id, session_id, agent_id, task_id, trace_id, logical_request_id,
         resource_kind, resource_id, resource_path, duration_ns, payload
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const checkpoint = this.db.prepare(
      `INSERT INTO chain_checkpoint (day, sequence, hash) VALUES (?, ?, ?)
         ON CONFLICT(day) DO UPDATE SET sequence = excluded.sequence, hash = excluded.hash`,
    );

    this.db.exec('BEGIN IMMEDIATE');
    let retainedCountAfterCommit = this.retainedEventCount;
    try {
      this.assertWithinByteQuota([]);
      await load({
        insert: (day, event) => {
          const row = projectEvent(event);
          insert.run(
            day,
            event.sequence,
            event.eventId,
            event.hash,
            event.previousHash,
            row.occurredAt,
            event.eventType,
            row.outcome,
            row.projectId,
            row.sessionId,
            row.agentId,
            row.taskId,
            row.traceId,
            row.logicalRequestId,
            row.resourceKind,
            row.resourceId,
            row.resourcePath,
            row.durationNs,
            JSON.stringify(event),
          );
        },
        checkpoint: (day, sequence, hash) => {
          checkpoint.run(day, sequence, hash);
        },
      });
      retainedCountAfterCommit = this.enforceEventLimitWithinTransaction();
      this.assertActualAllocationWithinQuota();
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Nothing to unwind.
      }
      throw this.normalizeQuotaError(error);
    } finally {
      this.anchors.clear();
    }

    this.retainedEventCount = retainedCountAfterCommit;
  }

  /**
   * A read engine over this journal's own connection.
   *
   * Sharing the connection rather than opening a second one keeps the
   * single-writer guarantee intact and means a reader can never observe a
   * half-applied batch: SQLite serialises statements on one handle.
   */
  queryEngine(options?: ChronicleSqliteQueryEngineOptions): ChronicleSqliteQueryEngine {
    return new ChronicleSqliteQueryEngine(this.db, options);
  }

  /** Has the legacy JSONL import already run? */
  hasImportedLegacyJournal(): boolean {
    return this.readMeta(LEGACY_JSONL_MIGRATION_KEY) !== undefined;
  }

  markLegacyJournalImported(): void {
    this.db
      .prepare(
        `INSERT INTO chronicle_meta (key, value) VALUES (?, 'done')
           ON CONFLICT(key) DO UPDATE SET value = 'done'`,
      )
      .run(LEGACY_JSONL_MIGRATION_KEY);
  }

  /**
   * Record the day families the import refused to move.
   *
   * Persisted rather than merely logged because the import runs once: after the
   * marker is set nothing re-reads the JSONL, so this row is the only surviving
   * evidence that a day was dropped. Health reports read it back to say
   * "degraded, and here is exactly what is missing" instead of quietly serving
   * a journal with a hole in it.
   */
  recordQuarantinedFamilies(families: readonly ChronicleQuarantinedFamily[]): void {
    if (families.length === 0) return;
    this.db
      .prepare(
        `INSERT INTO chronicle_meta (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(LEGACY_JSONL_QUARANTINE_KEY, JSON.stringify(families));
  }

  /**
   * Does this day already hold rows?
   *
   * Each family commits on its own, so an import interrupted between families
   * leaves a database that is complete for the days it reached. `(day,
   * sequence)` is the primary key, so re-inserting one of those days would
   * abort on a constraint violation rather than start over — this is what lets
   * the next run resume at the first day it never got to.
   */
  hasImportedDay(day: string): boolean {
    const row = this.db.prepare('SELECT 1 AS present FROM events WHERE day = ? LIMIT 1').get(day) as
      | { present: number }
      | undefined;
    return row !== undefined;
  }

  /** Day families the legacy import refused to move, oldest first. */
  quarantinedFamilies(): ChronicleQuarantinedFamily[] {
    const raw = this.readMeta(LEGACY_JSONL_QUARANTINE_KEY);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as ChronicleQuarantinedFamily[]) : [];
    } catch {
      return [];
    }
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private readMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM chronicle_meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  private readCheckpoint(day: string): ChainAnchor | undefined {
    return this.db.prepare('SELECT sequence, hash FROM chain_checkpoint WHERE day = ?').get(day) as
      | ChainAnchor
      | undefined;
  }

  /** Days that currently hold at least one event, oldest first. */
  private days(): string[] {
    const rows = this.db.prepare('SELECT DISTINCT day FROM events ORDER BY day').all() as Array<{
      day: string;
    }>;
    return rows.map((row) => row.day);
  }

  /**
   * Resolve the chain head, in the same precedence the JSONL journal uses: the
   * newest event, else the retention checkpoint (every event before it was
   * purged), else genesis.
   */
  private readAnchor(day: string): ChainAnchor {
    const cached = this.anchors.get(day);
    if (cached) return cached;
    const last = this.db
      .prepare('SELECT sequence, hash FROM events WHERE day = ? ORDER BY sequence DESC LIMIT 1')
      .get(day) as ChainAnchor | undefined;
    const anchor = last ?? this.readCheckpoint(day) ?? { sequence: 0, hash: GENESIS_HASH };
    this.anchors.set(day, anchor);
    return anchor;
  }

  private ensureSchema(): void {
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        day                TEXT NOT NULL,
        sequence           INTEGER NOT NULL,
        event_id           TEXT NOT NULL UNIQUE,
        hash               TEXT NOT NULL,
        previous_hash      TEXT NOT NULL,
        occurred_at        TEXT NOT NULL,
        event_type         TEXT NOT NULL,
        outcome            TEXT,
        project_id         TEXT,
        session_id         TEXT,
        agent_id           TEXT,
        task_id            TEXT,
        trace_id           TEXT,
        logical_request_id TEXT,
        resource_kind      TEXT,
        resource_id        TEXT,
        resource_path      TEXT,
        duration_ns        TEXT,
        payload            TEXT NOT NULL,
        PRIMARY KEY (day, sequence)
      );
      CREATE INDEX IF NOT EXISTS events_occurred_at ON events(occurred_at);
      CREATE INDEX IF NOT EXISTS events_type_outcome ON events(event_type, outcome);
      CREATE INDEX IF NOT EXISTS events_session ON events(session_id, day, sequence);
      CREATE INDEX IF NOT EXISTS events_trace ON events(trace_id);
      CREATE INDEX IF NOT EXISTS events_logical_request ON events(logical_request_id);
      CREATE INDEX IF NOT EXISTS events_resource_path ON events(resource_path);

      CREATE TABLE IF NOT EXISTS chain_checkpoint (
        day      TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL,
        hash     TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chronicle_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    if (version !== SCHEMA_VERSION) {
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
  }
}

interface ProjectedRow {
  occurredAt: string;
  outcome: string | null;
  projectId: string | null;
  sessionId: string | null;
  agentId: string | null;
  taskId: string | null;
  traceId: string | null;
  logicalRequestId: string | null;
  resourceKind: string | null;
  resourceId: string | null;
  resourcePath: string | null;
  durationNs: string | null;
}

/**
 * Derive the indexed columns from an event.
 *
 * Every value here is recoverable from `payload`; nothing is stored only in a
 * column. That is what lets the projection change in a later release without
 * touching a single stored hash.
 *
 * `day` is deliberately absent: it is the chain scope, not a projection. The
 * legacy writer picks it from the wall clock when the batch is appended (see
 * `journalForToday`), so an event carrying a back-dated `occurredAt` still
 * belongs to the chain of the day it was written on.
 */
function projectEvent(event: ChronicleEvent): ProjectedRow {
  const occurredAt = event.occurredAt ?? event.observedAt;
  return {
    occurredAt,
    outcome: event.outcome ?? null,
    projectId: event.scope.projectId ?? null,
    sessionId: event.scope.sessionId ?? null,
    agentId: event.scope.agentId ?? null,
    taskId: event.scope.taskId ?? null,
    traceId: event.correlation?.traceId ?? null,
    logicalRequestId: event.correlation?.logicalRequestId ?? null,
    resourceKind: event.resource?.kind ?? null,
    resourceId: event.resource?.id ?? null,
    resourcePath: event.resource?.path ?? null,
    durationNs: event.durationNs ?? null,
  };
}

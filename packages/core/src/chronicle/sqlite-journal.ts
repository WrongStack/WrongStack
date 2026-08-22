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
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { chronicleEventHash, GENESIS_HASH, hashValue } from './event-hash.js';
import type { ChronicleJournalStats, ChroniclePurgeResult } from './journal.js';
import {
  ChronicleQuotaManager,
  ChronicleStorageQuotaError,
  MIN_SQLITE_PAGE_BUDGET_BYTES,
  SQLITE_FIXED_OVERHEAD_BYTES,
  WAL_AUTOCHECKPOINT_PAGES,
  WAL_SIZE_LIMIT_BYTES,
} from './sqlite-journal-quota.js';
import {
  CHRONICLE_SQLITE_FILE,
  ensureChronicleSchema,
  LEGACY_JSONL_BOUNDARY_KEY,
  LEGACY_JSONL_MIGRATION_KEY,
  LEGACY_JSONL_QUARANTINE_KEY,
  loadDatabaseSync,
  projectEvent,
} from './sqlite-journal-schema.js';
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

export {
  CHRONICLE_SQLITE_FILE,
  ChronicleStorageQuotaError,
  LEGACY_JSONL_BOUNDARY_KEY,
  LEGACY_JSONL_MIGRATION_KEY,
  LEGACY_JSONL_QUARANTINE_KEY,
};

/**
 * How far `maxEvents` may be overshot before prefix eviction runs.
 *
 * Eviction costs O(rows deleted), plus an index update per surviving secondary
 * index, plus the `chain_checkpoint` write that keeps the truncated chain
 * verifiable. A journal parked exactly at its ceiling pays all of that on
 * *every* append — and sitting at the ceiling is the steady state for any
 * long-lived project, not an edge case. Letting the table drift a little above
 * the ceiling and then cutting back to it amortises the same total work across
 * ~`slack` appends.
 *
 * The slack is a fraction of the ceiling rather than a constant so that small
 * ceilings — including the single-digit ones the tests pin — keep the exact
 * `maxEvents` bound they document.
 */
const TRIM_SLACK_RATIO = 0.02;
const MAX_TRIM_SLACK_EVENTS = 2_000;

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

export class ChronicleSqliteJournal {
  private readonly db: DatabaseSync;
  private readonly dbPath: string;
  private readonly now: () => Date;
  private readonly monotonicNow: () => bigint;
  private readonly idFactory: () => string;
  private readonly retentionDays: number | undefined;
  private readonly maxEvents: number | undefined;
  private readonly retentionCheckIntervalMs: number;
  /** Overshoot allowed above `maxEvents` before eviction runs; see TRIM_SLACK_RATIO. */
  private readonly trimSlack: number;
  private readonly quotaManager: ChronicleQuotaManager;
  private nextRetentionCheckAt = 0;
  private retainedEventCount = 0;

  /**
   * Statements reused across appends.
   *
   * `db.prepare` re-parses the SQL every call, and the append path used to
   * prepare five statements per batch. They are held rather than re-prepared
   * because the schema cannot change under an open journal.
   */
  private statements:
    | {
        insert: ReturnType<DatabaseSync['prepare']>;
        trimBoundary: ReturnType<DatabaseSync['prepare']>;
        writeCheckpoint: ReturnType<DatabaseSync['prepare']>;
        deletePrefix: ReturnType<DatabaseSync['prepare']>;
        deleteCheckpoints: ReturnType<DatabaseSync['prepare']>;
      }
    | undefined;

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
    this.retentionCheckIntervalMs = options.retentionCheckIntervalMs ?? 60 * 60 * 1_000;
    this.trimSlack =
      this.maxEvents === undefined
        ? 0
        : Math.min(MAX_TRIM_SLACK_EVENTS, Math.floor(this.maxEvents * TRIM_SLACK_RATIO));
    const Database = loadDatabaseSync();
    this.db = new Database(this.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = FULL');
    this.db.exec(`PRAGMA wal_autocheckpoint = ${WAL_AUTOCHECKPOINT_PAGES}`);
    this.db.exec(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES}`);
    ensureChronicleSchema(this.db);
    this.quotaManager = new ChronicleQuotaManager(this.db, this.dbPath, options.maxBytes);
    this.quotaManager.configure();
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
      partitionRolls: 0,
      ...(this.lastBatchDurationMs !== undefined
        ? { lastBatchDurationMs: this.lastBatchDurationMs }
        : {}),
    };
  }

  async flush(): Promise<void> {
    return Promise.resolve();
  }

  async append(input: ChronicleEventInput): Promise<ChronicleEvent> {
    const [event] = await this.appendBatch([input]);
    return event as ChronicleEvent;
  }

  async appendBatch(inputs: readonly ChronicleEventInput[]): Promise<ChronicleEvent[]> {
    if (inputs.length === 0) return [];
    const started = performance.now();
    this.counters.acceptedEvents += inputs.length;
    this.counters.batches += 1;
    this.counters.largestBatch = Math.max(this.counters.largestBatch, inputs.length);

    const instant = this.now().toISOString();
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

    const payloads = events.map((event) => JSON.stringify(event));
    let batchBytes = 0;
    for (const payload of payloads) batchBytes += Buffer.byteLength(payload, 'utf8');

    let retainedCountAfterCommit = this.retainedEventCount;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      this.quotaManager.assertWithinByteQuota(batchBytes);
      const { insert } = this.preparedStatements();
      for (const [index, event] of events.entries()) {
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
          row.promptManifestId,
          row.resourceKind,
          row.resourceId,
          row.resourcePath,
          row.durationNs,
          payloads[index] as string,
        );
      }
      retainedCountAfterCommit = this.enforceEventLimitWithinTransaction(
        this.retainedEventCount + events.length,
      );
      this.quotaManager.assertActualAllocationWithinQuota();
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // A failed BEGIN leaves no transaction to roll back.
      }
      this.anchors.clear();
      this.quotaManager.invalidateEstimate();
      this.counters.failedEvents += inputs.length;
      this.lastBatchDurationMs = performance.now() - started;
      throw this.quotaManager.normalizeQuotaError(error);
    }

    this.anchors.set(day, previous);
    this.counters.persistedEvents += events.length;
    this.retainedEventCount = retainedCountAfterCommit;
    this.quotaManager.recordAppendedBytes(batchBytes);
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

  private enforceEventLimitWithinTransaction(count: number, slack = this.trimSlack): number {
    if (this.maxEvents === undefined || count <= this.maxEvents + slack) return count;

    const excess = count - this.maxEvents;
    const statements = this.preparedStatements();
    const boundary = statements.trimBoundary.get(excess - 1) as
      | (ChainAnchor & { day: string })
      | undefined;
    if (!boundary) return count;

    statements.writeCheckpoint.run(boundary.day, boundary.sequence, boundary.hash);
    statements.deletePrefix.run(boundary.day, boundary.day, boundary.sequence);
    statements.deleteCheckpoints.run(boundary.day);
    for (const day of this.anchors.keys()) {
      if (day <= boundary.day) this.anchors.delete(day);
    }
    return this.maxEvents;
  }

  private enforceEventLimitAtStartup(): void {
    if (this.maxEvents === undefined || this.retainedEventCount <= this.maxEvents) return;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const retainedCount = this.enforceEventLimitWithinTransaction(this.retainedEventCount, 0);
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
    this.retainedEventCount = this.countRows();
    this.quotaManager.invalidateEstimate();
    return { ...empty, deletedCount: count };
  }

  async runFamilyImport(load: (sink: ChronicleImportSink) => Promise<void>): Promise<void> {
    const insert = this.db.prepare(
      `INSERT INTO events (
         day, sequence, event_id, hash, previous_hash, occurred_at, event_type, outcome,
         project_id, session_id, agent_id, task_id, trace_id, logical_request_id, prompt_manifest_id,
         resource_kind, resource_id, resource_path, duration_ns, payload
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const checkpoint = this.db.prepare(
      `INSERT INTO chain_checkpoint (day, sequence, hash) VALUES (?, ?, ?)
         ON CONFLICT(day) DO UPDATE SET sequence = excluded.sequence, hash = excluded.hash`,
    );

    this.db.exec('BEGIN IMMEDIATE');
    let retainedCountAfterCommit = this.retainedEventCount;
    try {
      this.quotaManager.invalidateEstimate();
      this.quotaManager.assertWithinByteQuota(0);
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
            row.promptManifestId,
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
      retainedCountAfterCommit = this.enforceEventLimitWithinTransaction(this.countRows(), 0);
      this.quotaManager.invalidateEstimate();
      this.quotaManager.assertActualAllocationWithinQuota();
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Nothing to unwind.
      }
      this.quotaManager.invalidateEstimate();
      throw this.quotaManager.normalizeQuotaError(error);
    } finally {
      this.anchors.clear();
    }

    this.retainedEventCount = retainedCountAfterCommit;
  }

  queryEngine(options?: ChronicleSqliteQueryEngineOptions): ChronicleSqliteQueryEngine {
    return new ChronicleSqliteQueryEngine(this.db, options);
  }

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

  recordQuarantinedFamilies(families: readonly ChronicleQuarantinedFamily[]): void {
    if (families.length === 0) return;
    this.db
      .prepare(
        `INSERT INTO chronicle_meta (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(LEGACY_JSONL_QUARANTINE_KEY, JSON.stringify(families));
  }

  /** Record per-partition-file JSONL byte offsets at import time (merged — the
   *  import persists per family, so a crash mid-run keeps earlier boundaries).
   *  The metrics ingester folds only bytes beyond these boundaries after the
   *  migration, so post-migration appends (the jsonl-store fallback) are
   *  ingested while the migrated bytes are never re-counted. Files absent from
   *  the map were quarantined (or created post-migration) — their events live
   *  only in JSONL. */
  recordLegacyJsonlBoundary(boundary: Record<string, number>): void {
    let merged = boundary;
    try {
      const row = this.db
        .prepare('SELECT value FROM chronicle_meta WHERE key = ?')
        .get(LEGACY_JSONL_BOUNDARY_KEY) as { value?: string } | undefined;
      if (row?.value) {
        merged = { ...(JSON.parse(row.value) as Record<string, number>), ...boundary };
      }
    } catch {
      // Corrupt or absent — start from the given boundary.
    }
    this.db
      .prepare(
        `INSERT INTO chronicle_meta (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(LEGACY_JSONL_BOUNDARY_KEY, JSON.stringify(merged));
  }

  hasImportedDay(day: string): boolean {
    const row = this.db.prepare('SELECT 1 AS present FROM events WHERE day = ? LIMIT 1').get(day) as
      | { present: number }
      | undefined;
    return row !== undefined;
  }

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

  private preparedStatements(): NonNullable<ChronicleSqliteJournal['statements']> {
    this.statements ??= {
      insert: this.db.prepare(
        `INSERT INTO events (
           day, sequence, event_id, hash, previous_hash, occurred_at, event_type, outcome,
           project_id, session_id, agent_id, task_id, trace_id, logical_request_id, prompt_manifest_id,
           resource_kind, resource_id, resource_path, duration_ns, payload
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ),
      trimBoundary: this.db.prepare(
        'SELECT day, sequence, hash FROM events ORDER BY day, sequence LIMIT 1 OFFSET ?',
      ),
      writeCheckpoint: this.db.prepare(
        `INSERT INTO chain_checkpoint (day, sequence, hash) VALUES (?, ?, ?)
         ON CONFLICT(day) DO UPDATE SET sequence = excluded.sequence, hash = excluded.hash`,
      ),
      deletePrefix: this.db.prepare(
        'DELETE FROM events WHERE day < ? OR (day = ? AND sequence <= ?)',
      ),
      deleteCheckpoints: this.db.prepare('DELETE FROM chain_checkpoint WHERE day < ?'),
    };
    return this.statements;
  }

  private countRows(): number {
    return (this.db.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number })
      .count;
  }

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

  private days(): string[] {
    const rows = this.db.prepare('SELECT DISTINCT day FROM events ORDER BY day').all() as Array<{
      day: string;
    }>;
    return rows.map((row) => row.day);
  }

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
}

import { chronicleEventHash, GENESIS_HASH, hashValue } from './event-hash.js';
import type { ChronicleJournalStats, ChroniclePurgeResult } from './journal.js';
import {
  chroniclePayloadStoredBytes,
  decodeChroniclePayload,
  encodeChroniclePayload,
  type StoredChroniclePayload,
} from './payload-codec.js';
import {
  type ChronicleImportSink,
  type ChronicleQuarantinedFamily,
  ChronicleSqliteJournalCore,
  type ChronicleSqlitePurgeOptions,
  TRIM_VACUUM_PAGES,
} from './sqlite-journal-core.js';
import { ChronicleStorageQuotaError } from './sqlite-journal-quota.js';
import {
  CHRONICLE_SQLITE_FILE,
  LEGACY_JSONL_BOUNDARY_KEY,
  LEGACY_JSONL_MIGRATION_KEY,
  LEGACY_JSONL_QUARANTINE_KEY,
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

export type {
  ChronicleQuarantinedFamily,
  ChronicleSqliteJournalOptions,
} from './sqlite-journal-core.js';
export {
  CHRONICLE_SQLITE_FILE,
  ChronicleStorageQuotaError,
  LEGACY_JSONL_BOUNDARY_KEY,
  LEGACY_JSONL_MIGRATION_KEY,
};

export class ChronicleSqliteJournal extends ChronicleSqliteJournalCore {
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

    const payloads = events.map((event) => encodeChroniclePayload(JSON.stringify(event)));
    let batchBytes = 0;
    for (const payload of payloads) batchBytes += chroniclePayloadStoredBytes(payload);

    let retainedCountAfterCommit = this.retainedEventCount;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      this.quotaManager.assertWithinByteQuota(batchBytes);
      const { insert } = this.preparedStatements();
      for (const [index, event] of events.entries()) {
        this.insertEventRow(insert, day, event, payloads[index] as StoredChroniclePayload);
      }
      this.anchors.set(day, previous);
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

    this.counters.persistedEvents += events.length;
    const trimmed = retainedCountAfterCommit < this.retainedEventCount + events.length;
    this.retainedEventCount = retainedCountAfterCommit;
    // A `maxEvents` eviction just moved pages to the freelist, and a journal
    // parked at its ceiling evicts on most appends — without this the file
    // only ever grows. Cheap because the freelist is short in steady state;
    // `incremental_vacuum` cannot run inside the append transaction, so it
    // happens here rather than in enforceEventLimitWithinTransaction.
    if (trimmed) this.reclaimFreePages(TRIM_VACUUM_PAGES);
    this.quotaManager.recordAppendedBytes(batchBytes);
    this.lastBatchDurationMs = performance.now() - started;
    await this.enforceRetentionIfDue();
    return events;
  }

  async readAll(): Promise<ChronicleEvent[]> {
    const rows = this.db
      .prepare('SELECT payload FROM events ORDER BY day, sequence')
      .all() as Array<{ payload: StoredChroniclePayload }>;
    return rows.map((row) => JSON.parse(decodeChroniclePayload(row.payload)) as ChronicleEvent);
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
        payload: StoredChroniclePayload;
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
          event = JSON.parse(decodeChroniclePayload(row.payload)) as ChronicleEvent;
        } catch {
          return { ok: false, entries, brokenAt: entries, reason: 'invalid payload JSON' };
        }
        if (event.hash !== row.hash || chronicleEventHash(event) !== row.hash) {
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

    const doomed = this.db
      .prepare(
        'SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(payload)), 0) AS bytes FROM events WHERE day < ?',
      )
      .get(cutoff) as { n: number; bytes: number };
    const count = doomed.n;
    if (count === 0) return empty;

    if (options.dryRun) {
      const days = this.db
        .prepare('SELECT DISTINCT day FROM events WHERE day < ? ORDER BY day')
        .all(cutoff) as Array<{ day: string }>;
      return {
        ...empty,
        deletedCount: count,
        deletedBytes: Number(doomed.bytes),
        candidates: days.map((row) => row.day),
      };
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
    this.reclaimFreePages();
    this.quotaManager.invalidateEstimate();
    // Payload bytes, not file bytes: the file only shrinks by whole pages and
    // only as fast as incremental_vacuum walks the freelist, so reporting the
    // delta in file size would tell an operator that a purge freed nothing.
    return { ...empty, deletedCount: count, deletedBytes: Number(doomed.bytes) };
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
          this.insertEventRow(insert, day, event, encodeChroniclePayload(JSON.stringify(event)));
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
}

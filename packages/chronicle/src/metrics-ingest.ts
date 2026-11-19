import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { withFileLock } from '@wrongstack/core/utils';
import { ingestEvent, type StatementCache } from './metrics-ingest-events.js';
import {
  type ChronicleMetricsRefreshResult,
  loadDatabaseSync,
  normalizeKey,
  READ_CHUNK_BYTES,
  SQLITE_INGEST_BATCH,
  SQLITE_SOURCE_PREFIX,
} from './metrics-schema.js';
import {
  chroniclePayloadStoredBytes,
  decodeChroniclePayload,
  type StoredChroniclePayload,
} from './payload-codec.js';
import { findChroniclePartitions } from './query.js';
import {
  CHRONICLE_SQLITE_FILE,
  LEGACY_JSONL_BOUNDARY_KEY,
  LEGACY_JSONL_MIGRATION_KEY,
} from './sqlite-journal.js';
import type { ChronicleEvent } from './types.js';

/** ingest_state sentinel recording a completed projection rebuild. Lives under
 *  the sqlite: prefix so `pruneOffsets` never mistakes it for a partition file
 *  and the legacy-progress scan in `needsSqliteRebuild` ignores it. */
const REBUILD_MARKER_KEY = `${SQLITE_SOURCE_PREFIX}rebuild_done`;

export class ChronicleMetricsIngester {
  /**
   * Prepared-statement cache for the per-event ingest hot paths. Preparing
   * the same SQL on every event was the dominant ingest cost; node:sqlite
   * statements are reusable, so each distinct SQL string is prepared once.
   */
  private stmtCache = new Map<string, ReturnType<DatabaseSync['prepare']>>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly directory: string,
    private readonly dbPath: string,
  ) {}

  /** `stmt` bound once, for the per-event projections in metrics-ingest-events. */
  private readonly statements: StatementCache = (sql) => this.stmt(sql);

  private stmt(sql: string): ReturnType<DatabaseSync['prepare']> {
    let s = this.stmtCache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmtCache.set(sql, s);
    }
    return s;
  }

  async refresh(): Promise<ChronicleMetricsRefreshResult> {
    const result: ChronicleMetricsRefreshResult = {
      ingestedEvents: 0,
      ingestedBytes: 0,
      sourceFiles: 0,
      invalidLines: 0,
    };
    await withFileLock(this.dbPath, async () => {
      const files = await findChroniclePartitions(this.directory);
      const offsets = this.loadOffsets();
      const journalPath = path.join(this.directory, CHRONICLE_SQLITE_FILE);
      let source: DatabaseSync | null = null;
      try {
        source = new (loadDatabaseSync())(journalPath, { readOnly: true });
      } catch {
        // No SQLite journal yet — legacy JSONL partitions only.
      }
      try {
        const migrated = source !== null && this.legacyJsonlConsumed(source);
        const boundary = migrated && source !== null ? this.loadJsonlBoundary(source) : null;
        const rebuilt = migrated && this.needsSqliteRebuild(offsets);
        if (rebuilt && source !== null) {
          // One-time repair: the projection may hold pre-migration JSONL counts
          // that the SQLite fold would double. Wipe and re-derive from the
          // SQLite journal; families the import quarantined are re-folded from
          // JSONL.
          this.rebuildFromSqliteJournal(source, result);
        }
        // A pre-boundary-feature migration has no boundary row at all — skip
        // the partitions to preserve the no-double-count guarantee. A boundary
        // row that is empty means every family was quarantined: fold them from
        // JSONL.
        if (!migrated || boundary !== null) {
          for (const file of files) {
            const key = normalizeKey(path.relative(this.directory, file));
            let base: number;
            if (!migrated) {
              base = offsets.get(key) ?? 0;
            } else if (boundary?.has(key)) {
              // Migrated file: bytes up to its import boundary are in SQLite —
              // fold only post-migration appends (the jsonl-store fallback).
              // After a rebuild the aggregates were wiped, so re-fold from the
              // import boundary rather than the pre-wipe offset.
              base = rebuilt
                ? boundary.get(key)!
                : Math.max(offsets.get(key) ?? 0, boundary.get(key)!);
            } else {
              // Quarantined or post-migration file — its events live only in
              // JSONL. After a rebuild the aggregates were wiped, so re-fold
              // from the start; otherwise continue from the recorded offset.
              base = rebuilt ? 0 : (offsets.get(key) ?? 0);
            }
            const ingested = await this.ingestFile(file, key, base, result);
            if (ingested) result.sourceFiles++;
          }
        }
        this.pruneOffsets(files);
        if (source !== null && !rebuilt) {
          this.ingestSqliteJournal(source, offsets, result, false);
          // A fresh post-migration db has no pre-migration legacy progress,
          // so the marker would otherwise never be written — and a later
          // jsonl-store fallback offset would be misread as pre-migration
          // progress, triggering a destructive rebuild that drops the
          // fallback event (the pre-wipe in-memory offset skips it).
          if (migrated) this.ensureRebuildMarker();
        }
      } finally {
        // One close on every path — including fold/prune/rebuild failures —
        // so a throw never leaks the read-only journal handle (Windows cannot
        // remove the journal while it is still open).
        if (source !== null) source.close();
      }
    });
    return result;
  }

  private loadOffsets(): Map<string, number> {
    const rows = this.db.prepare('SELECT file, bytes FROM ingest_state').all() as Array<{
      file: string;
      bytes: number;
    }>;
    return new Map(rows.map((row) => [row.file, Number(row.bytes)]));
  }

  /** True once the legacy JSONL journal was imported into the SQLite journal
   *  (`importLegacyChronicleJournal` records the marker in `chronicle_meta`).
   *  After that point the SQLite `events` table already holds every JSONL
   *  event, so folding the leftover partition files again would double-count
   *  every migrated event in the aggregates. `source` is the already-opened
   *  read-only journal handle (null when no SQLite journal exists yet). */
  private legacyJsonlConsumed(source: DatabaseSync | null): boolean {
    if (source === null) return false;
    try {
      const row = source
        .prepare('SELECT value FROM chronicle_meta WHERE key = ?')
        .get(LEGACY_JSONL_MIGRATION_KEY) as { value?: unknown } | undefined;
      return row?.value !== undefined;
    } catch {
      return false;
    }
  }

  /** Per-partition-file JSONL byte offsets recorded by
   *  `importLegacyChronicleJournal` at import time (keyed by the same relative
   *  path the fold uses). Files absent from the map were quarantined (or
   *  created after the migration) — their events live only in JSONL. */
  private loadJsonlBoundary(source: DatabaseSync): Map<string, number> | null {
    try {
      const row = source
        .prepare('SELECT value FROM chronicle_meta WHERE key = ?')
        .get(LEGACY_JSONL_BOUNDARY_KEY) as { value?: string } | undefined;
      if (!row?.value) return null; // pre-boundary-feature migration
      const parsed = JSON.parse(row.value) as Record<string, number>;
      return new Map(Object.entries(parsed));
    } catch {
      return null;
    }
  }

  /** Persist the rebuild sentinel idempotently. Its presence makes
   *  `needsSqliteRebuild` return false, so post-migration jsonl-store offsets
   *  are never mistaken for pre-migration progress. */
  private ensureRebuildMarker(): void {
    this.db
      .prepare(
        'INSERT INTO ingest_state (file, bytes) VALUES (?, ?) ' +
          'ON CONFLICT(file) DO UPDATE SET bytes = excluded.bytes',
      )
      .run(REBUILD_MARKER_KEY, 1);
  }

  /** Upgrade path: `metrics.db` already aggregated the legacy JSONL, then the
   *  one-shot import copied those same events into the SQLite journal. There
   *  is no `sqlite:` cursor yet, so a plain incremental fold would replay the
   *  entire migrated history on top of the existing aggregates. The metrics
   *  projection is disposable (fully derived from the journal), so rebuild it
   *  from the SQLite source exactly once — the rebuild writes the cursors and
   *  subsequent refreshes go back to incremental folding. */
  private needsSqliteRebuild(offsets: Map<string, number>): boolean {
    if (offsets.has(REBUILD_MARKER_KEY)) return false;
    for (const [key, bytes] of offsets) {
      if (!key.startsWith(SQLITE_SOURCE_PREFIX) && bytes > 0) return true;
    }
    return false;
  }

  private rebuildFromSqliteJournal(
    source: DatabaseSync,
    result: ChronicleMetricsRefreshResult,
  ): void {
    this.db.exec(
      'DELETE FROM ingest_state; DELETE FROM provider_daily; DELETE FROM task_outcomes;' +
        ' DELETE FROM file_lineage; DELETE FROM token_cost; DELETE FROM daily_counters;' +
        ' DELETE FROM family_daily; DELETE FROM agent_daily; DELETE FROM logical_request_daily;' +
        ' DELETE FROM file_seen_daily; DELETE FROM tool_daily;',
    );
    // Propagate failures: the projection is now partial and the marker is not
    // yet written, so a throw leaves the next refresh re-entering the rebuild.
    this.ingestSqliteJournal(source, new Map(), result, true);
    this.ensureRebuildMarker();
  }

  private pruneOffsets(existingFiles: string[]): void {
    const keep = new Set(
      existingFiles.map((file) => normalizeKey(path.relative(this.directory, file))),
    );
    for (const row of this.db.prepare('SELECT file FROM ingest_state').all() as Array<{
      file: string;
    }>) {
      if (row.file.startsWith(SQLITE_SOURCE_PREFIX)) continue;
      if (!keep.has(row.file))
        this.db.prepare('DELETE FROM ingest_state WHERE file = ?').run(row.file);
    }
  }

  private ingestSqliteJournal(
    source: DatabaseSync,
    offsets: Map<string, number>,
    result: ChronicleMetricsRefreshResult,
    propagateErrors: boolean,
  ): void {
    try {
      const days = source.prepare('SELECT DISTINCT day FROM events ORDER BY day').all() as Array<{
        day: string;
      }>;
      const read = source.prepare(
        'SELECT sequence, payload FROM events WHERE day = ? AND sequence > ? ORDER BY sequence LIMIT ?',
      );
      const writeCursor = this.db.prepare(
        'INSERT INTO ingest_state (file, bytes) VALUES (?, ?) ' +
          'ON CONFLICT(file) DO UPDATE SET bytes = excluded.bytes',
      );
      for (const { day } of days) {
        const key = `${SQLITE_SOURCE_PREFIX}${day}`;
        const from = offsets.get(key) ?? 0;
        let cursor = from;
        this.db.exec('BEGIN');
        try {
          for (;;) {
            const rows = read.all(day, cursor, SQLITE_INGEST_BATCH) as Array<{
              sequence: number;
              payload: StoredChroniclePayload;
            }>;
            if (rows.length === 0) break;
            for (const row of rows) {
              try {
                this.ingestEventAtomically(
                  JSON.parse(decodeChroniclePayload(row.payload)) as ChronicleEvent,
                  result,
                );
              } catch {
                result.invalidLines++;
              }
              result.ingestedBytes += chroniclePayloadStoredBytes(row.payload);
              cursor = Number(row.sequence);
            }
            if (rows.length < SQLITE_INGEST_BATCH) break;
          }
          if (cursor > from) writeCursor.run(key, cursor);
          this.db.exec('COMMIT');
        } catch (error) {
          // SQLite may have already ended the transaction when a write or the
          // COMMIT failed (SQLITE_FULL/IOERR auto-rollback); the follow-up
          // ROLLBACK then throws `cannot rollback - no transaction is active`,
          // which would mask the original disk or database error. Preserve the
          // primary error for the caller (the rebuild path propagates it).
          try {
            this.db.exec('ROLLBACK');
          } catch {
            /* preserve original error */
          }
          throw error;
        }
        if (cursor > from) result.sourceFiles++;
      }
    } catch (error) {
      // Best-effort in the incremental path: the per-day transactions roll
      // back and the next refresh retries. The rebuild path propagates so a
      // wiped projection never silently stays partial.
      if (propagateErrors) throw error;
    }
  }

  private async ingestFile(
    file: string,
    key: string,
    consumed: number,
    result: ChronicleMetricsRefreshResult,
  ): Promise<boolean> {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(file, 'r');
    } catch {
      return false;
    }
    try {
      const size = (await handle.stat()).size;
      if (size <= consumed) return false;
      let position = consumed;
      let remainder = Buffer.alloc(0);
      let advanced = consumed;
      this.db.exec('BEGIN');
      try {
        while (position < size) {
          const length = Math.min(READ_CHUNK_BYTES, size - position);
          const buffer = Buffer.allocUnsafe(length);
          const { bytesRead } = await handle.read(buffer, 0, length, position);
          if (bytesRead <= 0) break;
          position += bytesRead;
          const data =
            remainder.length > 0
              ? Buffer.concat([remainder, buffer.subarray(0, bytesRead)])
              : buffer.subarray(0, bytesRead);
          const lastNewline = data.lastIndexOf(0x0a);
          if (lastNewline < 0) {
            remainder = Buffer.from(data);
            continue;
          }
          for (const line of data.subarray(0, lastNewline).toString('utf8').split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              this.ingestEventAtomically(JSON.parse(trimmed) as ChronicleEvent, result);
            } catch {
              result.invalidLines++;
            }
          }
          advanced += lastNewline + 1;
          remainder = Buffer.from(data.subarray(lastNewline + 1));
        }
        this.db
          .prepare(
            'INSERT INTO ingest_state (file, bytes) VALUES (?, ?) ' +
              'ON CONFLICT(file) DO UPDATE SET bytes = excluded.bytes',
          )
          .run(key, advanced);
        this.db.exec('COMMIT');
      } catch (error) {
        // Same rule as the sqlite-journal loop above: a failed write or COMMIT
        // may already have ended the transaction, so the follow-up ROLLBACK
        // throws `cannot rollback - no transaction is active` and would mask
        // the original error. Best-effort rollback, primary error preserved.
        try {
          this.db.exec('ROLLBACK');
        } catch {
          /* preserve original error */
        }
        throw error;
      }
      result.ingestedBytes += advanced - consumed;
      return advanced > consumed;
    } finally {
      await handle.close();
    }
  }

  /** Fold one event into the aggregates atomically. `ingestEvent` runs several
   *  statements; when one throws mid-way (e.g. a malformed resource path), the
   *  statements before it already mutated the aggregates. The savepoint rolls
   *  those partial updates back: `ROLLBACK TO` rewinds, `RELEASE` (reached
   *  before the re-throw) pops the savepoint so the next event in the batch
   *  starts from a clean stack, and the batch commits only fully-succeeded
   *  events. Dropping the `RELEASE` would leak the savepoint into the next
   *  event's stack — the outer transaction ROLLBACK is never reached because
   *  the per-event catch swallows the error and continues the batch. */
  private ingestEventAtomically(
    event: ChronicleEvent,
    result: ChronicleMetricsRefreshResult,
  ): void {
    this.db.exec('SAVEPOINT ingest_event');
    try {
      this.ingestEvent(event);
      this.db.exec('RELEASE ingest_event');
      result.ingestedEvents++;
    } catch (error) {
      this.db.exec('ROLLBACK TO ingest_event');
      this.db.exec('RELEASE ingest_event');
      throw error;
    }
  }

  private ingestEvent(event: ChronicleEvent): void {
    ingestEvent(this.statements, event);
  }
}

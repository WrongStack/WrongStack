import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { withFileLock } from '../utils/atomic-write.js';
import {
  asString,
  type ChronicleMetricsRefreshResult,
  durationMs,
  eventDay,
  loadDatabaseSync,
  normalizeKey,
  normalizePathKey,
  numberAt,
  numberOrDuration,
  READ_CHUNK_BYTES,
  readPath,
  SQLITE_INGEST_BATCH,
  SQLITE_SOURCE_PREFIX,
  stringAt,
} from './metrics-schema.js';
import { findChroniclePartitions, isTerminalFailure, signalFamily } from './query.js';
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
              base = Math.max(offsets.get(key) ?? 0, boundary.get(key)!);
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
        ' DELETE FROM file_seen_daily;',
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
              payload: string;
            }>;
            if (rows.length === 0) break;
            for (const row of rows) {
              try {
                this.ingestEventAtomically(JSON.parse(row.payload) as ChronicleEvent, result);
              } catch {
                result.invalidLines++;
              }
              result.ingestedBytes += row.payload.length;
              cursor = Number(row.sequence);
            }
            if (rows.length < SQLITE_INGEST_BATCH) break;
          }
          if (cursor > from) writeCursor.run(key, cursor);
          this.db.exec('COMMIT');
        } catch (error) {
          this.db.exec('ROLLBACK');
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
        this.db.exec('ROLLBACK');
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
    if (typeof event?.eventType !== 'string' || !event.scope) return;
    this.ingestDailyCounters(event);
    const type = event.eventType;
    if (type.startsWith('provider.attempt.') || type === 'provider.fallback') {
      this.ingestProvider(event);
    } else if (type === 'token.accounted' || type === 'subagent.token_accounted') {
      // Both names feed the same table. A subagent's counter emits on its
      // private EventBus, so its spend reaches the host — and therefore
      // Chronicle — only under the bridged `subagent.` name; scope.agentId is
      // what keeps its row distinct from the leader's.
      this.ingestTokenCost(event);
    } else if (/^(?:sdd|subagent|kanban)\.task[._]/.test(type)) {
      this.ingestTask(event);
    } else if (type === 'file.event' || /^file\.(?:tool|external)\./.test(type)) {
      this.ingestFileEvent(event);
    }
  }

  private ingestDailyCounters(event: ChronicleEvent): void {
    const day = eventDay(event);
    this.stmt('INSERT OR IGNORE INTO daily_counters (day) VALUES (?)').run(day);
    const bump = (sql: string, ...params: Array<string | number>) =>
      this.stmt(`UPDATE daily_counters SET ${sql} WHERE day = ?`).run(...params, day);

    const family = signalFamily(event);
    const failed = isTerminalFailure(event) ? 1 : 0;
    this.stmt(
      `INSERT INTO family_daily (day, family, count, failure_count) VALUES (?, ?, 1, ?)
       ON CONFLICT(day, family) DO UPDATE SET count = count + 1, failure_count = failure_count + excluded.failure_count`,
    ).run(day, family, failed);
    if (failed) bump('failures = failures + 1');
    if (event.outcome === 'cancelled' || event.outcome === 'abandoned')
      bump('cancellations = cancellations + 1');
    if (family === 'agent') bump('agent_events = agent_events + 1');

    if (event.correlation.logicalRequestId) {
      this.stmt(
        'INSERT OR IGNORE INTO logical_request_daily (day, logical_request_id) VALUES (?, ?)',
      ).run(day, event.correlation.logicalRequestId);
    }
    if (event.scope.agentId) {
      this.stmt('INSERT OR IGNORE INTO agent_daily (day, agent_id) VALUES (?, ?)').run(
        day,
        event.scope.agentId,
      );
    }

    const type = event.eventType;
    if (type === 'decision.requested') bump('decisions = decisions + 1');
    else if (type === 'decision.escalated') bump('escalations = escalations + 1');
    else if (type === 'tool.started') bump('tool_calls = tool_calls + 1');
    else if (type === 'tool.executed' || type === 'tool.failed') {
      const dur = durationMs(event);
      const durationCount = dur > 0 ? 1 : 0;
      bump(
        `${type === 'tool.executed' ? 'completed_tools' : 'failed_tools'} = ${type === 'tool.executed' ? 'completed_tools' : 'failed_tools'} + 1,
         tool_duration_ms_total = tool_duration_ms_total + ?, tool_duration_ms_max = MAX(tool_duration_ms_max, ?), tool_duration_count = tool_duration_count + ?`,
        dur,
        dur,
        durationCount,
      );
    } else if (type === 'process.started') bump('processes = processes + 1');
    else if (type === 'process.completed' && event.outcome === 'failure')
      bump('failed_processes = failed_processes + 1');

    if (event.resource?.kind === 'file' || type.startsWith('file.')) {
      bump('file_events_all = file_events_all + 1');
      if (event.resource?.path) {
        this.stmt('INSERT OR IGNORE INTO file_seen_daily (day, path_key) VALUES (?, ?)').run(
          day,
          normalizePathKey(event.resource.path),
        );
      }
    }
  }

  private ingestProvider(event: ChronicleEvent): void {
    const day = eventDay(event);
    const providerId =
      event.runtime?.providerId ??
      asString(readPath(event.attributes ?? {}, 'from.providerId')) ??
      '';
    const modelId =
      event.runtime?.modelId ?? asString(readPath(event.attributes ?? {}, 'from.model')) ?? '';
    if (!providerId && !modelId) return;
    this.stmt(
      'INSERT OR IGNORE INTO provider_daily (day, provider_id, model_id) VALUES (?, ?, ?)',
    ).run(day, providerId, modelId);
    const update = (sql: string, ...params: Array<string | number>) =>
      this.stmt(
        `UPDATE provider_daily SET ${sql} WHERE day = ? AND provider_id = ? AND model_id = ?`,
      ).run(...params, day, providerId, modelId);
    const duration = durationMs(event);
    switch (event.eventType) {
      case 'provider.attempt.started':
        update('attempts = attempts + 1');
        break;
      case 'provider.attempt.completed':
        update(
          'completed = completed + 1, input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, ' +
            'cache_read_tokens = cache_read_tokens + ?, cache_write_tokens = cache_write_tokens + ?, ' +
            'duration_ms_total = duration_ms_total + ?, duration_ms_max = MAX(duration_ms_max, ?), ' +
            'duration_count = duration_count + ?',
          numberAt(event, 'usage.input'),
          numberAt(event, 'usage.output'),
          numberAt(event, 'usage.cacheRead'),
          numberAt(event, 'usage.cacheWrite'),
          duration,
          duration,
          duration > 0 ? 1 : 0,
        );
        break;
      case 'provider.attempt.failed':
        update(
          'failed = failed + 1, retries = retries + ?, duration_ms_total = duration_ms_total + ?, ' +
            'duration_ms_max = MAX(duration_ms_max, ?), duration_count = duration_count + ?',
          event.attributes?.retryScheduled === true ? 1 : 0,
          duration,
          duration,
          duration > 0 ? 1 : 0,
        );
        break;
      case 'provider.fallback':
        update('fallbacks = fallbacks + 1');
        break;
      default:
        break;
    }
  }

  private ingestTokenCost(event: ChronicleEvent): void {
    const attributes = event.attributes ?? {};
    const cost = readPath(attributes, 'cost.total');
    // Tokens are authoritative even when pricing is not: subscription-plan
    // providers resolve to cost 0, so gating the whole row on a finite cost
    // discarded every one of those sessions along with the token counts the
    // cost was derived from. Keep the row when EITHER is usable.
    const usage = {
      input: numberAt(event, 'usage.input'),
      output: numberAt(event, 'usage.output'),
      cacheRead: numberAt(event, 'usage.cacheRead'),
      cacheWrite: numberAt(event, 'usage.cacheWrite'),
    };
    const finiteCost = typeof cost === 'number' && Number.isFinite(cost) ? cost : undefined;
    const anyTokens =
      usage.input > 0 || usage.output > 0 || usage.cacheRead > 0 || usage.cacheWrite > 0;
    if (finiteCost === undefined && !anyTokens) return;
    const scopeKey = `${event.scope.projectId ?? ''}\0${event.scope.sessionId ?? ''}\0${event.scope.agentId ?? ''}`;
    const occurredAt = event.occurredAt ?? event.observedAt;
    this.stmt(
      `INSERT INTO token_cost (
         scope_key, day, occurred_at, sequence, cost,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         provider, model
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope_key) DO UPDATE SET
         day = excluded.day, occurred_at = excluded.occurred_at,
         sequence = excluded.sequence, cost = excluded.cost,
         input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
         cache_read_tokens = excluded.cache_read_tokens,
         cache_write_tokens = excluded.cache_write_tokens,
         provider = excluded.provider, model = excluded.model
       WHERE excluded.occurred_at > token_cost.occurred_at
          OR (excluded.occurred_at = token_cost.occurred_at AND excluded.sequence > token_cost.sequence)`,
    ).run(
      scopeKey,
      eventDay(event),
      occurredAt,
      event.sequence,
      finiteCost ?? 0,
      usage.input,
      usage.output,
      usage.cacheRead,
      usage.cacheWrite,
      event.runtime?.providerId ?? stringAt(attributes, 'provider') ?? '',
      event.runtime?.modelId ?? stringAt(attributes, 'model') ?? '',
    );
  }

  private ingestTask(event: ChronicleEvent): void {
    const attributes = event.attributes ?? {};
    const taskId = event.scope.taskId ?? stringAt(attributes, 'taskId');
    if (!taskId) return;
    const occurredAt = event.occurredAt ?? event.observedAt;
    this.stmt('INSERT OR IGNORE INTO task_outcomes (task_id) VALUES (?)').run(taskId);
    const set = (sql: string, ...params: Array<string | number>) =>
      this.stmt(`UPDATE task_outcomes SET ${sql} WHERE task_id = ?`).run(...params, taskId);
    const lineage: Array<[string, string | undefined]> = [
      ['run_id', stringAt(attributes, 'runId')],
      ['board_id', event.scope.kanbanBoardId ?? stringAt(attributes, 'boardId')],
      ['session_id', event.scope.sessionId],
      ['agent_id', event.scope.agentId ?? stringAt(attributes, 'subagentId')],
    ];
    for (const [column, value] of lineage) {
      if (value) set(`${column} = ?`, value);
    }
    const base = event.eventType.replace(/^(?:sdd|subagent|kanban)\.task[._]/, '');
    switch (base) {
      case 'started':
        set("status = 'started', started_at = COALESCE(started_at, ?)", occurredAt);
        break;
      case 'completed':
        set(
          "status = 'completed', ended_at = ?, duration_ms = ?",
          occurredAt,
          numberOrDuration(event, attributes),
        );
        break;
      case 'failed':
        set("status = 'failed', ended_at = ?", occurredAt);
        break;
      case 'retrying':
        set('retries = retries + 1');
        break;
      case 'verification_failed':
        set('verification_failures = verification_failures + 1');
        break;
      case 'merged':
        set("status = 'merged'");
        break;
      case 'conflict':
        set("status = 'conflict'");
        break;
      default:
        break;
    }
  }

  private ingestFileEvent(event: ChronicleEvent): void {
    const attributes = event.attributes ?? {};
    const operation = stringAt(attributes, 'operation') ?? '';
    if (!operation || operation === 'read') return;
    const filePath = event.resource?.path ?? stringAt(attributes, 'filePath');
    if (!filePath) return;
    this.stmt(
      `INSERT OR IGNORE INTO file_lineage
        (event_id, path, path_key, operation, occurred_at, session_id, agent_id, task_id, board_id, run_id,
         tool_name, provider_id, model_id, logical_request_id, prompt_manifest_id,
         provenance_confidence, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.eventId,
      normalizeKey(filePath),
      normalizePathKey(filePath),
      operation,
      event.occurredAt ?? event.observedAt,
      event.scope.sessionId ?? '',
      event.scope.agentId ?? '',
      event.scope.taskId ?? stringAt(attributes, 'taskId') ?? '',
      event.scope.kanbanBoardId ?? stringAt(attributes, 'boardId') ?? '',
      stringAt(attributes, 'runId') ?? '',
      stringAt(attributes, 'toolName') ?? '',
      event.runtime?.providerId ?? stringAt(attributes, 'provider') ?? '',
      event.runtime?.modelId ?? stringAt(attributes, 'model') ?? '',
      event.correlation.logicalRequestId ?? stringAt(attributes, 'logicalRequestId') ?? '',
      event.correlation.promptManifestId ?? stringAt(attributes, 'promptManifestId') ?? '',
      provenanceConfidence(attributes),
      stringAt(attributes, 'source') ?? (event.eventType === 'file.event' ? 'tool' : 'external'),
    );
  }
}

function provenanceConfidence(
  attributes: Record<string, unknown>,
): 'explicit' | 'correlated' | 'inferred' | 'unknown' {
  const value = attributes['provenanceConfidence'];
  return value === 'explicit' || value === 'correlated' || value === 'inferred' ? value : 'unknown';
}

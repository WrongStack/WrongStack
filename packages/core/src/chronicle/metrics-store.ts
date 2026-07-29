/**
 * ChronicleMetricsStore — derived, queryable aggregates over the raw
 * Chronicle journal ("process, don't hoard").
 *
 * The journal is the durable evidence log; this store is a disposable
 * projection kept in `<chronicleDir>/metrics.db` (node:sqlite, WAL). Each
 * `refresh()` incrementally consumes only the journal bytes appended since
 * the previous run (per-partition byte offsets in `ingest_state`), so the
 * raw JSONL partitions can be purged by retention without losing metrics:
 *
 * - `provider_daily`  — provider×model×day attempt/success/failure/retry/
 *                       fallback counts, token totals, duration stats.
 * - `task_outcomes`   — one row per task (kanban/SDD/subagent) with status,
 *                       timing, retry counts, and board/run/session lineage.
 * - `file_lineage`    — one row per observed file mutation with full
 *                       session/agent/task/board/tool/model attribution.
 * - `token_cost`      — latest cumulative token.accounted cost snapshot per
 *                       scope (same latest-wins semantics as the query
 *                       engine's summary).
 * - `daily_counters`, `family_daily`, `agent_daily`, `logical_request_daily`,
 *   `file_seen_daily` — per-day scalar counters and dedup sets backing
 *   `defaultSummary()`, a `ChronicleSummary` for the common unfiltered/
 *   time-bounded dashboard view. Any genuinely ad hoc filter (free text,
 *   path, session, provider, model) falls back to the raw-scan summary in
 *   query.ts — fixed-dimension aggregation fundamentally can't answer those.
 *
 * The schema is a cache: on version mismatch it is dropped and re-ingested
 * from whatever journal partitions still exist.
 */

import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { withFileLock } from '../utils/atomic-write.js';
import { withSqliteExperimentalWarningSuppressed } from '../utils/sqlite-warning.js';
import { findChroniclePartitions, isTerminalFailure, signalFamily } from './query.js';
import type { ChronicleEvent } from './types.js';
import type { ChronicleSignalFamily, ChronicleSummary } from './query.js';

const SCHEMA_VERSION = 3;
const READ_CHUNK_BYTES = 1024 * 1024;
const EMPTY_FAMILIES: Record<ChronicleSignalFamily, number> = {
  llm: 0, agent: 0, tool: 0, file: 0, memory: 0, task: 0, decision: 0, runtime: 0, finding: 0,
};

export interface ChronicleMetricsRefreshResult {
  ingestedEvents: number;
  ingestedBytes: number;
  sourceFiles: number;
  invalidLines: number;
}

export interface ChronicleProviderDailyRow {
  day: string;
  providerId: string;
  modelId: string;
  attempts: number;
  completed: number;
  failed: number;
  retries: number;
  fallbacks: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  avgDurationMs: number;
  maxDurationMs: number;
}

export interface ChronicleTaskOutcomeRow {
  taskId: string;
  runId: string;
  boardId: string;
  sessionId: string;
  agentId: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  retries: number;
  verificationFailures: number;
  filesTouched: number;
}

export interface ChronicleFileLineageRow {
  path: string;
  operation: string;
  occurredAt: string;
  sessionId: string;
  agentId: string;
  taskId: string;
  boardId: string;
  runId: string;
  toolName: string;
  providerId: string;
  modelId: string;
  source: string;
}

export interface ChronicleMetricsSummary {
  providers: { attempts: number; completed: number; failed: number; successRate: number };
  tasks: Record<string, number>;
  files: { mutations: number; uniquePaths: number };
  estimatedCostUsd: number;
}

// ─── node:sqlite lazy loader (mirrors SAGE's pattern, compacted) ────────────

let Ctor: typeof DatabaseSync | null | undefined;

function loadDatabaseSync(): typeof DatabaseSync {
  if (Ctor) return Ctor;
  if (Ctor === null) throw new Error('node:sqlite is unavailable in this runtime');
  try {
    Ctor = withSqliteExperimentalWarningSuppressed(
      () => (createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')).DatabaseSync,
    );
    return Ctor;
  } catch (error) {
    Ctor = null;
    throw new Error(
      "Chronicle metrics need Node's built-in SQLite (node:sqlite, Node >= 22.5): " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

/** Non-throwing availability probe for callers that degrade gracefully. */
export function isChronicleMetricsAvailable(): boolean {
  try {
    loadDatabaseSync();
    return true;
  } catch {
    return false;
  }
}

// ─── Store ──────────────────────────────────────────────────────────────────

export class ChronicleMetricsStore {
  private readonly db: DatabaseSync;
  private readonly directory: string;
  private readonly dbPath: string;

  private constructor(directory: string) {
    this.directory = path.resolve(directory);
    this.dbPath = path.join(this.directory, 'metrics.db');
    const Database = loadDatabaseSync();
    this.db = new Database(this.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.ensureSchema();
  }

  static open(chronicleDirectory: string): ChronicleMetricsStore {
    return new ChronicleMetricsStore(chronicleDirectory);
  }

  close(): void {
    this.db.close();
  }

  /** Incrementally ingest journal bytes appended since the last refresh.
   *  Safe across processes: guarded by a file lock on the database path. */
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
      for (const file of files) {
        const key = normalizeKey(path.relative(this.directory, file));
        const consumed = offsets.get(key) ?? 0;
        const ingested = await this.ingestFile(file, key, consumed, result);
        if (ingested) result.sourceFiles++;
      }
      this.pruneOffsets(files);
    });
    return result;
  }

  providerDaily(options: { from?: string; to?: string } = {}): ChronicleProviderDailyRow[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (options.from) {
      clauses.push('day >= ?');
      params.push(options.from.slice(0, 10));
    }
    if (options.to) {
      clauses.push('day <= ?');
      params.push(options.to.slice(0, 10));
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT day, provider_id, model_id, attempts, completed, failed, retries, fallbacks,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        duration_ms_total, duration_ms_max, duration_count
       FROM provider_daily${where} ORDER BY day DESC, provider_id, model_id`,
      )
      .all(...params) as Array<Record<string, string | number>>;
    return rows.map((row) => ({
      day: String(row.day),
      providerId: String(row.provider_id),
      modelId: String(row.model_id),
      attempts: Number(row.attempts),
      completed: Number(row.completed),
      failed: Number(row.failed),
      retries: Number(row.retries),
      fallbacks: Number(row.fallbacks),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      cacheReadTokens: Number(row.cache_read_tokens),
      cacheWriteTokens: Number(row.cache_write_tokens),
      avgDurationMs:
        Number(row.duration_count) > 0
          ? Number(row.duration_ms_total) / Number(row.duration_count)
          : 0,
      maxDurationMs: Number(row.duration_ms_max),
    }));
  }

  taskOutcomes(
    options: {
      runId?: string;
      boardId?: string;
      sessionId?: string;
      status?: string;
      limit?: number;
    } = {},
  ): ChronicleTaskOutcomeRow[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (options.runId) {
      clauses.push('t.run_id = ?');
      params.push(options.runId);
    }
    if (options.boardId) {
      clauses.push('t.board_id = ?');
      params.push(options.boardId);
    }
    if (options.sessionId) {
      clauses.push('t.session_id = ?');
      params.push(options.sessionId);
    }
    if (options.status) {
      clauses.push('t.status = ?');
      params.push(options.status);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    params.push(clampLimit(options.limit, 100));
    const rows = this.db
      .prepare(
        `SELECT t.*, (SELECT COUNT(*) FROM file_lineage f WHERE f.task_id = t.task_id) AS files_touched
       FROM task_outcomes t${where}
       ORDER BY COALESCE(t.started_at, '') DESC LIMIT ?`,
      )
      .all(...params) as Array<Record<string, string | number | null>>;
    return rows.map((row) => ({
      taskId: String(row.task_id),
      runId: String(row.run_id),
      boardId: String(row.board_id),
      sessionId: String(row.session_id),
      agentId: String(row.agent_id),
      status: String(row.status),
      startedAt: row.started_at === null ? null : String(row.started_at),
      endedAt: row.ended_at === null ? null : String(row.ended_at),
      durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
      retries: Number(row.retries),
      verificationFailures: Number(row.verification_failures),
      filesTouched: Number(row.files_touched),
    }));
  }

  fileLineage(
    options: {
      path?: string;
      paths?: string[];
      latestPerPath?: boolean;
      taskId?: string;
      boardId?: string;
      sessionId?: string;
      limit?: number;
    } = {},
  ): ChronicleFileLineageRow[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (options.path) {
      clauses.push('path_key = ?');
      params.push(normalizePathKey(options.path));
    }
    if (options.paths) {
      const pathKeys = [...new Set(options.paths.map(normalizePathKey))];
      if (pathKeys.length === 0) return [];
      clauses.push(`path_key IN (${pathKeys.map(() => '?').join(',')})`);
      params.push(...pathKeys);
    }
    if (options.taskId) {
      clauses.push('task_id = ?');
      params.push(options.taskId);
    }
    if (options.boardId) {
      clauses.push('board_id = ?');
      params.push(options.boardId);
    }
    if (options.sessionId) {
      clauses.push('session_id = ?');
      params.push(options.sessionId);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    params.push(clampLimit(options.limit, 200));
    const projection =
      `path, operation, occurred_at, session_id, agent_id, task_id, board_id, run_id,
       tool_name, provider_id, model_id, source`;
    const sql = options.latestPerPath
      ? `SELECT ${projection} FROM (
           SELECT ${projection}, ROW_NUMBER() OVER (
             PARTITION BY path_key ORDER BY occurred_at DESC, event_id DESC
           ) AS path_rank
           FROM file_lineage${where}
         ) WHERE path_rank = 1 ORDER BY occurred_at DESC LIMIT ?`
      : `SELECT ${projection}
         FROM file_lineage${where} ORDER BY occurred_at DESC LIMIT ?`;
    const rows = this.db
      .prepare(sql)
      .all(...params) as Array<Record<string, string>>;
    return rows.map((row) => ({
      path: row.path!,
      operation: row.operation!,
      occurredAt: row.occurred_at!,
      sessionId: row.session_id!,
      agentId: row.agent_id!,
      taskId: row.task_id!,
      boardId: row.board_id!,
      runId: row.run_id!,
      toolName: row.tool_name!,
      providerId: row.provider_id!,
      modelId: row.model_id!,
      source: row.source!,
    }));
  }

  summary(): ChronicleMetricsSummary {
    const provider = this.db
      .prepare(
        'SELECT COALESCE(SUM(attempts),0) a, COALESCE(SUM(completed),0) c, COALESCE(SUM(failed),0) f FROM provider_daily',
      )
      .get() as { a: number; c: number; f: number };
    const tasks: Record<string, number> = {};
    for (const row of this.db
      .prepare('SELECT status, COUNT(*) n FROM task_outcomes GROUP BY status')
      .all() as Array<{ status: string; n: number }>) {
      tasks[row.status] = Number(row.n);
    }
    const files = this.db
      .prepare('SELECT COUNT(*) n, COUNT(DISTINCT path) p FROM file_lineage')
      .get() as { n: number; p: number };
    const cost = this.db.prepare('SELECT COALESCE(SUM(cost),0) c FROM token_cost').get() as {
      c: number;
    };
    const terminal = Number(provider.c) + Number(provider.f);
    return {
      providers: {
        attempts: Number(provider.a),
        completed: Number(provider.c),
        failed: Number(provider.f),
        successRate: terminal > 0 ? Number(provider.c) / terminal : 0,
      },
      tasks,
      files: { mutations: Number(files.n), uniquePaths: Number(files.p) },
      estimatedCostUsd: Number(cost.c),
    };
  }

  /**
   * A `ChronicleSummary` for the default/unfiltered dashboard view — only
   * `from`/`to` (day-precision) narrow it. Any other ad hoc filter (text,
   * path, provider, model, session) can't be answered from these
   * fixed-dimension aggregates; callers must fall back to query.ts's
   * raw-scan summary for those.
   */
  defaultSummary(options: { from?: string; to?: string } = {}): ChronicleSummary {
    const fromDay = options.from?.slice(0, 10);
    const toDay = options.to?.slice(0, 10);
    const dayFilter = (column: string): { where: string; params: string[] } => {
      const clauses: string[] = [];
      const params: string[] = [];
      if (fromDay) { clauses.push(`${column} >= ?`); params.push(fromDay); }
      if (toDay) { clauses.push(`${column} <= ?`); params.push(toDay); }
      return { where: clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '', params };
    };

    const providerRange = dayFilter('day');
    const provider = this.db
      .prepare(
        `SELECT COALESCE(SUM(attempts),0) attempts, COALESCE(SUM(completed),0) completed, COALESCE(SUM(failed),0) failed,
        COALESCE(SUM(retries),0) retries, COALESCE(SUM(fallbacks),0) fallbacks,
        COUNT(DISTINCT provider_id) providers, COUNT(DISTINCT model_id) models,
        COALESCE(SUM(input_tokens),0) inputTokens, COALESCE(SUM(output_tokens),0) outputTokens,
        COALESCE(SUM(cache_read_tokens),0) cacheReadTokens, COALESCE(SUM(cache_write_tokens),0) cacheWriteTokens,
        COALESCE(SUM(duration_ms_total),0) durationTotal, COALESCE(MAX(duration_ms_max),0) durationMax,
        COALESCE(SUM(duration_count),0) durationCount
       FROM provider_daily${providerRange.where}`,
      )
      .get(...providerRange.params) as Record<string, number>;

    const counterRange = dayFilter('day');
    const counters = this.db
      .prepare(
        `SELECT COALESCE(SUM(tool_calls),0) toolCalls, COALESCE(SUM(completed_tools),0) completedTools,
        COALESCE(SUM(failed_tools),0) failedTools, COALESCE(SUM(tool_duration_ms_total),0) toolDurationTotal,
        COALESCE(SUM(tool_duration_count),0) toolDurationCount, COALESCE(SUM(processes),0) processes,
        COALESCE(SUM(failed_processes),0) failedProcesses, COALESCE(SUM(file_events_all),0) fileEvents,
        COALESCE(SUM(decisions),0) decisions, COALESCE(SUM(escalations),0) escalations,
        COALESCE(SUM(agent_events),0) agentEvents, COALESCE(SUM(failures),0) failures,
        COALESCE(SUM(cancellations),0) cancellations
       FROM daily_counters${counterRange.where}`,
      )
      .get(...counterRange.params) as Record<string, number>;

    const familyRange = dayFilter('day');
    const familyRows = this.db
      .prepare(`SELECT family, count, failure_count FROM family_daily${familyRange.where}`)
      .all(...familyRange.params) as Array<{ family: string; count: number; failure_count: number }>;
    const families = { ...EMPTY_FAMILIES };
    const failuresByFamily = { ...EMPTY_FAMILIES };
    for (const row of familyRows) {
      const family = row.family as ChronicleSignalFamily;
      families[family] = Number(row.count);
      failuresByFamily[family] = Number(row.failure_count);
    }

    const agentRange = dayFilter('day');
    const uniqueAgents = (
      this.db.prepare(`SELECT COUNT(DISTINCT agent_id) n FROM agent_daily${agentRange.where}`).get(...agentRange.params) as { n: number }
    ).n;
    const requestRange = dayFilter('day');
    const logicalRequests = (
      this.db.prepare(`SELECT COUNT(DISTINCT logical_request_id) n FROM logical_request_daily${requestRange.where}`).get(...requestRange.params) as { n: number }
    ).n;
    const fileRange = dayFilter('day');
    const uniqueFiles = (
      this.db.prepare(`SELECT COUNT(DISTINCT path_key) n FROM file_seen_daily${fileRange.where}`).get(...fileRange.params) as { n: number }
    ).n;
    const costRange = dayFilter('day');
    const cost = (
      this.db.prepare(`SELECT COALESCE(SUM(cost),0) c FROM token_cost${costRange.where}`).get(...costRange.params) as { c: number }
    ).c;

    return {
      logicalRequests: Number(logicalRequests),
      modelAttempts: Number(provider.attempts),
      completedAttempts: Number(provider.completed),
      failedAttempts: Number(provider.failed),
      scheduledRetries: Number(provider.retries),
      fallbacks: Number(provider.fallbacks),
      providers: Number(provider.providers),
      models: Number(provider.models),
      inputTokens: Number(provider.inputTokens),
      outputTokens: Number(provider.outputTokens),
      cacheReadTokens: Number(provider.cacheReadTokens),
      cacheWriteTokens: Number(provider.cacheWriteTokens),
      estimatedCostUsd: Number(cost),
      providerAvgDurationMs: Number(provider.durationCount) > 0 ? Number(provider.durationTotal) / Number(provider.durationCount) : 0,
      // True p95 needs a retained distribution; this per-day aggregate only
      // keeps sum/max/count, so approximate with the observed max rather
      // than adding a per-attempt histogram write (would add the same kind
      // of per-event overhead this whole effort is trying to remove).
      providerP95DurationMs: Number(provider.durationMax),
      toolCalls: Number(counters.toolCalls),
      completedTools: Number(counters.completedTools),
      failedTools: Number(counters.failedTools),
      toolAvgDurationMs: Number(counters.toolDurationCount) > 0 ? Number(counters.toolDurationTotal) / Number(counters.toolDurationCount) : 0,
      processes: Number(counters.processes),
      failedProcesses: Number(counters.failedProcesses),
      fileEvents: Number(counters.fileEvents),
      uniqueFiles: Number(uniqueFiles),
      agentEvents: Number(counters.agentEvents),
      uniqueAgents: Number(uniqueAgents),
      decisions: Number(counters.decisions),
      escalations: Number(counters.escalations),
      failures: Number(counters.failures),
      cancellations: Number(counters.cancellations),
      families,
      failuresByFamily,
    };
  }

  // ─── Ingest internals ─────────────────────────────────────────────────────

  private ensureSchema(): void {
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version;
    if (version !== 0 && version !== SCHEMA_VERSION) {
      // Derived cache — drop and re-ingest from whatever journal remains.
      this.db.exec(
        'DROP TABLE IF EXISTS ingest_state; DROP TABLE IF EXISTS provider_daily;' +
          'DROP TABLE IF EXISTS task_outcomes; DROP TABLE IF EXISTS file_lineage;' +
          'DROP TABLE IF EXISTS token_cost; DROP TABLE IF EXISTS daily_counters;' +
          'DROP TABLE IF EXISTS family_daily; DROP TABLE IF EXISTS agent_daily;' +
          'DROP TABLE IF EXISTS logical_request_daily; DROP TABLE IF EXISTS file_seen_daily;',
      );
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ingest_state (
        file TEXT PRIMARY KEY,
        bytes INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_daily (
        day TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        completed INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        retries INTEGER NOT NULL DEFAULT 0,
        fallbacks INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        duration_ms_total REAL NOT NULL DEFAULT 0,
        duration_ms_max REAL NOT NULL DEFAULT 0,
        duration_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, provider_id, model_id)
      );
      CREATE TABLE IF NOT EXISTS task_outcomes (
        task_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL DEFAULT '',
        board_id TEXT NOT NULL DEFAULT '',
        session_id TEXT NOT NULL DEFAULT '',
        agent_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'started',
        started_at TEXT,
        ended_at TEXT,
        duration_ms REAL,
        retries INTEGER NOT NULL DEFAULT 0,
        verification_failures INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS file_lineage (
        event_id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        path_key TEXT NOT NULL,
        operation TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        session_id TEXT NOT NULL DEFAULT '',
        agent_id TEXT NOT NULL DEFAULT '',
        task_id TEXT NOT NULL DEFAULT '',
        board_id TEXT NOT NULL DEFAULT '',
        run_id TEXT NOT NULL DEFAULT '',
        tool_name TEXT NOT NULL DEFAULT '',
        provider_id TEXT NOT NULL DEFAULT '',
        model_id TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT ''
      );
      -- Lookups filter on the case-normalized path_key (matching the query
      -- engine); the path column retains original casing for display.
      CREATE INDEX IF NOT EXISTS idx_file_lineage_path ON file_lineage(path_key, occurred_at);
      CREATE INDEX IF NOT EXISTS idx_file_lineage_task ON file_lineage(task_id);
      CREATE TABLE IF NOT EXISTS token_cost (
        scope_key TEXT PRIMARY KEY,
        day TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        cost REAL NOT NULL
      );
      -- Backing store for defaultSummary(): per-day scalar counters plus
      -- dedup sets, populated for every ingested event (not just the
      -- provider/task/file families above).
      CREATE TABLE IF NOT EXISTS daily_counters (
        day TEXT PRIMARY KEY,
        tool_calls INTEGER NOT NULL DEFAULT 0,
        completed_tools INTEGER NOT NULL DEFAULT 0,
        failed_tools INTEGER NOT NULL DEFAULT 0,
        tool_duration_ms_total REAL NOT NULL DEFAULT 0,
        tool_duration_ms_max REAL NOT NULL DEFAULT 0,
        tool_duration_count INTEGER NOT NULL DEFAULT 0,
        processes INTEGER NOT NULL DEFAULT 0,
        failed_processes INTEGER NOT NULL DEFAULT 0,
        file_events_all INTEGER NOT NULL DEFAULT 0,
        decisions INTEGER NOT NULL DEFAULT 0,
        escalations INTEGER NOT NULL DEFAULT 0,
        agent_events INTEGER NOT NULL DEFAULT 0,
        failures INTEGER NOT NULL DEFAULT 0,
        cancellations INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS family_daily (
        day TEXT NOT NULL,
        family TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, family)
      );
      CREATE TABLE IF NOT EXISTS agent_daily (day TEXT NOT NULL, agent_id TEXT NOT NULL, PRIMARY KEY (day, agent_id));
      CREATE TABLE IF NOT EXISTS logical_request_daily (day TEXT NOT NULL, logical_request_id TEXT NOT NULL, PRIMARY KEY (day, logical_request_id));
      CREATE TABLE IF NOT EXISTS file_seen_daily (day TEXT NOT NULL, path_key TEXT NOT NULL, PRIMARY KEY (day, path_key));
      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
  }

  private loadOffsets(): Map<string, number> {
    const rows = this.db.prepare('SELECT file, bytes FROM ingest_state').all() as Array<{
      file: string;
      bytes: number;
    }>;
    return new Map(rows.map((row) => [row.file, Number(row.bytes)]));
  }

  private pruneOffsets(existingFiles: string[]): void {
    const keep = new Set(
      existingFiles.map((file) => normalizeKey(path.relative(this.directory, file))),
    );
    for (const row of this.db.prepare('SELECT file FROM ingest_state').all() as Array<{
      file: string;
    }>) {
      if (!keep.has(row.file))
        this.db.prepare('DELETE FROM ingest_state WHERE file = ?').run(row.file);
    }
  }

  /** Read complete lines appended after `consumed` bytes. The trailing
   *  partial line of an actively-written partition is left for the next
   *  refresh — `ingest_state.bytes` only ever advances past full lines. */
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
          // '\n' is a single byte in UTF-8, so complete-line slices always
          // fall on character boundaries.
          for (const line of data.subarray(0, lastNewline).toString('utf8').split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              this.ingestEvent(JSON.parse(trimmed) as ChronicleEvent);
              result.ingestedEvents++;
            } catch {
              result.invalidLines++;
            }
          }
          // `data` always begins at absolute offset `advanced` (remainder is
          // exactly the unconsumed bytes), so the newline index maps directly.
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

  private ingestEvent(event: ChronicleEvent): void {
    if (typeof event?.eventType !== 'string' || !event.scope) return;
    this.ingestDailyCounters(event);
    const type = event.eventType;
    if (type.startsWith('provider.attempt.') || type === 'provider.fallback') {
      this.ingestProvider(event);
    } else if (type === 'token.accounted') {
      this.ingestTokenCost(event);
    } else if (/^(?:sdd|subagent|kanban)\.task[._]/.test(type)) {
      this.ingestTask(event);
    } else if (type === 'file.event' || /^file\.(?:tool|external)\./.test(type)) {
      this.ingestFileEvent(event);
    }
  }

  /** Runs for every ingested event (not just the type-specific branches
   *  below) — mirrors query.ts's updateSummary() closely enough that
   *  defaultSummary() matches what a raw scan of the same window would say. */
  private ingestDailyCounters(event: ChronicleEvent): void {
    const day = eventDay(event);
    this.db.prepare('INSERT OR IGNORE INTO daily_counters (day) VALUES (?)').run(day);
    const bump = (sql: string, ...params: Array<string | number>) =>
      this.db.prepare(`UPDATE daily_counters SET ${sql} WHERE day = ?`).run(...params, day);

    const family = signalFamily(event);
    const failed = isTerminalFailure(event) ? 1 : 0;
    this.db
      .prepare(
        `INSERT INTO family_daily (day, family, count, failure_count) VALUES (?, ?, 1, ?)
       ON CONFLICT(day, family) DO UPDATE SET count = count + 1, failure_count = failure_count + excluded.failure_count`,
      )
      .run(day, family, failed);
    if (failed) bump('failures = failures + 1');
    if (event.outcome === 'cancelled' || event.outcome === 'abandoned') bump('cancellations = cancellations + 1');
    if (family === 'agent') bump('agent_events = agent_events + 1');

    if (event.correlation.logicalRequestId) {
      this.db
        .prepare('INSERT OR IGNORE INTO logical_request_daily (day, logical_request_id) VALUES (?, ?)')
        .run(day, event.correlation.logicalRequestId);
    }
    if (event.scope.agentId) {
      this.db.prepare('INSERT OR IGNORE INTO agent_daily (day, agent_id) VALUES (?, ?)').run(day, event.scope.agentId);
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
        dur, dur, durationCount,
      );
    } else if (type === 'process.started') bump('processes = processes + 1');
    else if (type === 'process.completed' && event.outcome === 'failure') bump('failed_processes = failed_processes + 1');

    if (event.resource?.kind === 'file' || type.startsWith('file.')) {
      bump('file_events_all = file_events_all + 1');
      if (event.resource?.path) {
        this.db
          .prepare('INSERT OR IGNORE INTO file_seen_daily (day, path_key) VALUES (?, ?)')
          .run(day, normalizePathKey(event.resource.path));
      }
    }
  }

  private ingestProvider(event: ChronicleEvent): void {
    const day = eventDay(event);
    // provider.fallback carries no top-level runtime identity — it belongs to
    // the provider being fallen back FROM, held in attributes.from. Attribute
    // it there rather than letting it manufacture a phantom ('', '') row.
    const providerId =
      event.runtime?.providerId ?? asString(readPath(event.attributes ?? {}, 'from.providerId')) ?? '';
    const modelId =
      event.runtime?.modelId ?? asString(readPath(event.attributes ?? {}, 'from.model')) ?? '';
    // No identity at all → not attributable to any provider row; skip.
    if (!providerId && !modelId) return;
    this.db
      .prepare('INSERT OR IGNORE INTO provider_daily (day, provider_id, model_id) VALUES (?, ?, ?)')
      .run(day, providerId, modelId);
    const update = (sql: string, ...params: Array<string | number>) =>
      this.db
        .prepare(
          `UPDATE provider_daily SET ${sql} WHERE day = ? AND provider_id = ? AND model_id = ?`,
        )
        .run(...params, day, providerId, modelId);
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
    const cost = readPath(event.attributes ?? {}, 'cost.total');
    if (typeof cost !== 'number' || !Number.isFinite(cost)) return;
    const scopeKey = `${event.scope.projectId ?? ''}\0${event.scope.sessionId ?? ''}\0${event.scope.agentId ?? ''}`;
    const occurredAt = event.occurredAt ?? event.observedAt;
    // Latest-wins per scope: token.accounted carries a cumulative snapshot.
    this.db
      .prepare(
        `INSERT INTO token_cost (scope_key, day, occurred_at, sequence, cost) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(scope_key) DO UPDATE SET
         day = excluded.day, occurred_at = excluded.occurred_at,
         sequence = excluded.sequence, cost = excluded.cost
       WHERE excluded.occurred_at > token_cost.occurred_at
          OR (excluded.occurred_at = token_cost.occurred_at AND excluded.sequence > token_cost.sequence)`,
      )
      .run(scopeKey, eventDay(event), occurredAt, event.sequence, cost);
  }

  private ingestTask(event: ChronicleEvent): void {
    const attributes = event.attributes ?? {};
    const taskId = event.scope.taskId ?? stringAt(attributes, 'taskId');
    if (!taskId) return;
    const occurredAt = event.occurredAt ?? event.observedAt;
    this.db.prepare('INSERT OR IGNORE INTO task_outcomes (task_id) VALUES (?)').run(taskId);
    const set = (sql: string, ...params: Array<string | number>) =>
      this.db.prepare(`UPDATE task_outcomes SET ${sql} WHERE task_id = ?`).run(...params, taskId);
    // Lineage columns: last non-empty observation wins.
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
    this.db
      .prepare(
        `INSERT OR IGNORE INTO file_lineage
        (event_id, path, path_key, operation, occurred_at, session_id, agent_id, task_id, board_id, run_id,
         tool_name, provider_id, model_id, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
        stringAt(attributes, 'source') ?? (event.eventType === 'file.event' ? 'tool' : 'external'),
      );
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function eventDay(event: ChronicleEvent): string {
  return (event.occurredAt ?? event.observedAt).slice(0, 10);
}

function durationMs(event: ChronicleEvent): number {
  const value = Number(event.durationNs ?? 0) / 1_000_000;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function numberOrDuration(event: ChronicleEvent, attributes: Record<string, unknown>): number {
  const explicit = attributes.durationMs;
  if (typeof explicit === 'number' && Number.isFinite(explicit)) return explicit;
  return durationMs(event);
}

function numberAt(event: ChronicleEvent, dotPath: string): number {
  const value = readPath(event.attributes ?? {}, dotPath);
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readPath(value: Record<string, unknown>, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (current, part) =>
        current && typeof current === 'object'
          ? (current as Record<string, unknown>)[part]
          : undefined,
      value,
    );
}

function stringAt(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function clampLimit(limit: number | undefined, fallback: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return fallback;
  return Math.min(Math.floor(limit), 10_000);
}

function normalizeKey(value: string): string {
  return value.replaceAll('\\', '/');
}

/** Case-normalized path key for lineage lookups. Mirrors the query engine's
 *  path comparison (lowercase + forward-slash) and additionally strips a
 *  leading `./` so a repo-relative path matches however the tool reported it —
 *  case differences on Windows are the common mismatch. */
function normalizePathKey(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
}

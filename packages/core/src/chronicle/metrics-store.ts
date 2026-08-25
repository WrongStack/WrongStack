/**
 * ChronicleMetricsStore — derived, queryable aggregates over the raw
 * Chronicle journal ("process, don't hoard").
 *
 * The journal is the durable evidence log; this store is a disposable
 * projection kept in `<chronicleDir>/metrics.db` (node:sqlite, WAL). Each
 * `refresh()` incrementally consumes only the journal bytes appended since
 * the previous run (per-partition byte offsets in `ingest_state`), so the
 * raw JSONL partitions can be purged by retention without losing metrics.
 */

import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ChronicleSignalFamily, ChronicleSummary } from './query.js';
import { ChronicleMetricsIngester } from './metrics-ingest.js';
import {
  clampLimit,
  EMPTY_FAMILIES,
  ensureMetricsSchema,
  isChronicleMetricsAvailable,
  loadDatabaseSync,
  normalizePathKey,
  type ChronicleFileLineageRow,
  type ChronicleMetricsRefreshResult,
  type ChronicleMetricsSummary,
  type ChronicleProviderDailyRow,
  type ChronicleTaskOutcomeRow,
} from './metrics-schema.js';

export {
  isChronicleMetricsAvailable,
  type ChronicleFileLineageRow,
  type ChronicleMetricsRefreshResult,
  type ChronicleMetricsSummary,
  type ChronicleProviderDailyRow,
  type ChronicleTaskOutcomeRow,
};

export class ChronicleMetricsStore {
  private readonly db: DatabaseSync;
  private readonly directory: string;
  private readonly dbPath: string;
  private readonly ingester: ChronicleMetricsIngester;

  private constructor(directory: string) {
    this.directory = path.resolve(directory);
    this.dbPath = path.join(this.directory, 'metrics.db');
    const Database = loadDatabaseSync();
    this.db = new Database(this.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    // Every other SQLite store in the repo pairs WAL with NORMAL durability and
    // a busy timeout. Without the timeout a concurrent writer fails instantly
    // with SQLITE_BUSY instead of waiting out the other transaction; metrics
    // are derived data, so FULL fsync per commit buys nothing here.
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    ensureMetricsSchema(this.db);
    this.ingester = new ChronicleMetricsIngester(this.db, this.directory, this.dbPath);
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
    return this.ingester.refresh();
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
    const projection = `path, operation, occurred_at, session_id, agent_id, task_id, board_id, run_id,
       tool_name, provider_id, model_id, logical_request_id, prompt_manifest_id,
       provenance_confidence, source`;
    const sql = options.latestPerPath
      ? `SELECT ${projection} FROM (
           SELECT ${projection}, ROW_NUMBER() OVER (
             PARTITION BY path_key ORDER BY occurred_at DESC, event_id DESC
           ) AS path_rank
           FROM file_lineage${where}
         ) WHERE path_rank = 1 ORDER BY occurred_at DESC LIMIT ?`
      : `SELECT ${projection}
         FROM file_lineage${where} ORDER BY occurred_at DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, string>>;
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
      logicalRequestId: row.logical_request_id!,
      promptManifestId: row.prompt_manifest_id!,
      provenanceConfidence: row.provenance_confidence as ChronicleFileLineageRow['provenanceConfidence'],
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
   * `from`/`to` (day-precision) narrow it.
   */
  defaultSummary(options: { from?: string; to?: string } = {}): ChronicleSummary {
    const fromDay = options.from?.slice(0, 10);
    const toDay = options.to?.slice(0, 10);
    const dayFilter = (column: string): { where: string; params: string[] } => {
      const clauses: string[] = [];
      const params: string[] = [];
      if (fromDay) {
        clauses.push(`${column} >= ?`);
        params.push(fromDay);
      }
      if (toDay) {
        clauses.push(`${column} <= ?`);
        params.push(toDay);
      }
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
      .all(...familyRange.params) as Array<{
      family: string;
      count: number;
      failure_count: number;
    }>;
    const families = { ...EMPTY_FAMILIES };
    const failuresByFamily = { ...EMPTY_FAMILIES };
    for (const row of familyRows) {
      const family = row.family as ChronicleSignalFamily;
      families[family] = Number(row.count);
      failuresByFamily[family] = Number(row.failure_count);
    }

    const agentRange = dayFilter('day');
    const uniqueAgents = (
      this.db
        .prepare(`SELECT COUNT(DISTINCT agent_id) n FROM agent_daily${agentRange.where}`)
        .get(...agentRange.params) as { n: number }
    ).n;
    const requestRange = dayFilter('day');
    const logicalRequests = (
      this.db
        .prepare(
          `SELECT COUNT(DISTINCT logical_request_id) n FROM logical_request_daily${requestRange.where}`,
        )
        .get(...requestRange.params) as { n: number }
    ).n;
    const fileRange = dayFilter('day');
    const uniqueFiles = (
      this.db
        .prepare(`SELECT COUNT(DISTINCT path_key) n FROM file_seen_daily${fileRange.where}`)
        .get(...fileRange.params) as { n: number }
    ).n;
    const costRange = dayFilter('day');
    const cost = (
      this.db
        .prepare(`SELECT COALESCE(SUM(cost),0) c FROM token_cost${costRange.where}`)
        .get(...costRange.params) as { c: number }
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
      providerAvgDurationMs:
        Number(provider.durationCount) > 0
          ? Number(provider.durationTotal) / Number(provider.durationCount)
          : 0,
      providerP95DurationMs: Number(provider.durationMax),
      toolCalls: Number(counters.toolCalls),
      completedTools: Number(counters.completedTools),
      failedTools: Number(counters.failedTools),
      toolAvgDurationMs:
        Number(counters.toolDurationCount) > 0
          ? Number(counters.toolDurationTotal) / Number(counters.toolDurationCount)
          : 0,
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
}

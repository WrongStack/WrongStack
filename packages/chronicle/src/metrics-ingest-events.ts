import type { DatabaseSync } from 'node:sqlite';
import {
  asString,
  durationMs,
  eventDay,
  normalizeKey,
  normalizePathKey,
  numberAt,
  numberOrDuration,
  readPath,
  stringAt,
} from './metrics-schema.js';
import { isTerminalFailure, signalFamily, tokenSnapshotAttributes } from './query.js';
import type { ChronicleEvent } from './types.js';

/**
 * Per-event projections of a Chronicle event into the metrics tables. Each
 * takes the ingester's prepared-statement cache, so the SQL is still
 * prepared once per distinct string.
 */

export type StatementCache = (sql: string) => ReturnType<DatabaseSync['prepare']>;

export function ingestEvent(stmt: StatementCache, event: ChronicleEvent): void {
  if (typeof event?.eventType !== 'string' || !event.scope) return;
  ingestDailyCounters(stmt, event);
  const type = event.eventType;
  if (type.startsWith('provider.attempt.') || type === 'provider.fallback') {
    ingestProvider(stmt, event);
  } else if (
    type === 'token.accounted' ||
    type === 'subagent.token_accounted' ||
    type === 'metrics.counter'
  ) {
    // Both names feed the same table. A subagent's counter emits on its
    // private EventBus, so its spend reaches the host — and therefore
    // Chronicle — only under the bridged `subagent.` name; scope.agentId is
    // what keeps its row distinct from the leader's. At the default
    // `balanced` detail level both arrive folded into `metrics.counter`;
    // ingestTokenCost ignores every other counter.
    ingestTokenCost(stmt, event);
  } else if (/^(?:sdd|subagent|kanban)\.task[._]/.test(type)) {
    ingestTask(stmt, event);
  } else if (type === 'file.event' || /^file\.(?:tool|external)\./.test(type)) {
    ingestFileEvent(stmt, event);
  }
}

function ingestDailyCounters(stmt: StatementCache, event: ChronicleEvent): void {
  const day = eventDay(event);
  stmt('INSERT OR IGNORE INTO daily_counters (day) VALUES (?)').run(day);
  const bump = (sql: string, ...params: Array<string | number>) =>
    stmt(`UPDATE daily_counters SET ${sql} WHERE day = ?`).run(...params, day);

  const family = signalFamily(event);
  const failed = isTerminalFailure(event) ? 1 : 0;
  stmt(
    `INSERT INTO family_daily (day, family, count, failure_count) VALUES (?, ?, 1, ?)
     ON CONFLICT(day, family) DO UPDATE SET count = count + 1, failure_count = failure_count + excluded.failure_count`,
  ).run(day, family, failed);
  if (failed) bump('failures = failures + 1');
  if (event.outcome === 'cancelled' || event.outcome === 'abandoned')
    bump('cancellations = cancellations + 1');
  if (family === 'agent') bump('agent_events = agent_events + 1');

  if (event.correlation.logicalRequestId) {
    stmt('INSERT OR IGNORE INTO logical_request_daily (day, logical_request_id) VALUES (?, ?)').run(
      day,
      event.correlation.logicalRequestId,
    );
  }
  if (event.scope.agentId) {
    stmt('INSERT OR IGNORE INTO agent_daily (day, agent_id) VALUES (?, ?)').run(
      day,
      event.scope.agentId,
    );
  }

  const type = event.eventType;
  if (type === 'decision.requested') bump('decisions = decisions + 1');
  else if (type === 'decision.escalated') bump('escalations = escalations + 1');
  else if (type === 'tool.started') {
    bump('tool_calls = tool_calls + 1');
    ingestToolDaily(stmt, event, day, 'invocation', 0);
  } else if (type === 'tool.executed') {
    const dur = durationMs(event);
    const durationCount = dur > 0 ? 1 : 0;
    bump(
      'completed_tools = completed_tools + 1, tool_duration_ms_total = tool_duration_ms_total + ?, tool_duration_ms_max = MAX(tool_duration_ms_max, ?), tool_duration_count = tool_duration_count + ?',
      dur,
      dur,
      durationCount,
    );
    const kind =
      event.attributes?.['ok'] === false || event.outcome === 'failure' ? 'failure' : 'invocation';
    ingestToolDaily(stmt, event, day, kind, dur);
  } else if (type === 'tool.failed') {
    // tool.failed is terminal: the matching tool.started already
    // counted the invocation, so here we only bump failures + duration.
    const dur = durationMs(event);
    const durationCount = dur > 0 ? 1 : 0;
    bump(
      'failed_tools = failed_tools + 1, tool_duration_ms_total = tool_duration_ms_total + ?, tool_duration_ms_max = MAX(tool_duration_ms_max, ?), tool_duration_count = tool_duration_count + ?',
      dur,
      dur,
      durationCount,
    );
    ingestToolDaily(stmt, event, day, 'failure', dur);
  } else if (type === 'process.started') bump('processes = processes + 1');
  else if (type === 'process.completed' && event.outcome === 'failure')
    bump('failed_processes = failed_processes + 1');

  if (event.resource?.kind === 'file' || type.startsWith('file.')) {
    bump('file_events_all = file_events_all + 1');
    if (event.resource?.path) {
      stmt('INSERT OR IGNORE INTO file_seen_daily (day, path_key) VALUES (?, ?)').run(
        day,
        normalizePathKey(event.resource.path),
      );
    }
  }
}

/**
 * Per-tool fold used by the auto-thinning pipeline. Distinct from
 * `daily_counters` (which is name-agnostic): keyed by `(day, tool_name)`
 * so `underusedTools()` can pick candidates without scanning the journal.
 *
 * `kind` selects which counter increments:
 *   - `invocation` — `tool.started` and `tool.executed` (success)
 *   - `failure`    — `tool.failed` and `tool.executed` with `!ok`
 *
 * `lastInvokedAt` is the event's wall-clock at fold time, not the tool's
 * internal duration; the auto-thinning policy uses it to compute
 * "days since last use" relative to the request's anchor day.
 */
function ingestToolDaily(
  stmt: StatementCache,
  event: ChronicleEvent,
  day: string,
  kind: 'invocation' | 'failure',
  durationMs: number,
): void {
  const toolName = stringAt(event.attributes ?? {}, 'toolName');
  if (!toolName) return;
  const occurredAtMs = Date.parse(event.occurredAt ?? event.observedAt);
  const lastInvokedAt = Number.isFinite(occurredAtMs) ? occurredAtMs : Date.now();
  stmt('INSERT OR IGNORE INTO tool_daily (day, tool_name) VALUES (?, ?)').run(day, toolName);
  const invocations = kind === 'invocation' ? 1 : 0;
  const failures = kind === 'failure' ? 1 : 0;
  stmt(
    `UPDATE tool_daily
     SET invocations = invocations + ?,
         failures = failures + ?,
         duration_ms_total = duration_ms_total + ?,
         duration_ms_max = MAX(duration_ms_max, ?),
         last_invoked_at = MAX(COALESCE(last_invoked_at, 0), ?)
     WHERE day = ? AND tool_name = ?`,
  ).run(invocations, failures, durationMs, durationMs, lastInvokedAt, day, toolName);
}

function ingestProvider(stmt: StatementCache, event: ChronicleEvent): void {
  const day = eventDay(event);
  const providerId =
    event.runtime?.providerId ??
    asString(readPath(event.attributes ?? {}, 'from.providerId')) ??
    '';
  const modelId =
    event.runtime?.modelId ?? asString(readPath(event.attributes ?? {}, 'from.model')) ?? '';
  if (!providerId && !modelId) return;
  stmt('INSERT OR IGNORE INTO provider_daily (day, provider_id, model_id) VALUES (?, ?, ?)').run(
    day,
    providerId,
    modelId,
  );
  const update = (sql: string, ...params: Array<string | number>) =>
    stmt(`UPDATE provider_daily SET ${sql} WHERE day = ? AND provider_id = ? AND model_id = ?`).run(
      ...params,
      day,
      providerId,
      modelId,
    );
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

function ingestTokenCost(stmt: StatementCache, event: ChronicleEvent): void {
  const snapshot = tokenSnapshotAttributes(event);
  if (!snapshot) return;
  const attributes = event.attributes ?? {};
  const cost = readPath(snapshot, 'cost.total');
  // Tokens are authoritative even when pricing is not: subscription-plan
  // providers resolve to cost 0, so gating the whole row on a finite cost
  // discarded every one of those sessions along with the token counts the
  // cost was derived from. Keep the row when EITHER is usable.
  const tokens = (dotPath: string): number => {
    const value = readPath(snapshot, dotPath);
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  };
  const usage = {
    input: tokens('usage.input'),
    output: tokens('usage.output'),
    cacheRead: tokens('usage.cacheRead'),
    cacheWrite: tokens('usage.cacheWrite'),
  };
  const finiteCost = typeof cost === 'number' && Number.isFinite(cost) ? cost : undefined;
  const anyTokens =
    usage.input > 0 || usage.output > 0 || usage.cacheRead > 0 || usage.cacheWrite > 0;
  if (finiteCost === undefined && !anyTokens) return;
  const scopeKey = `${event.scope.projectId ?? ''}\0${event.scope.sessionId ?? ''}\0${event.scope.agentId ?? ''}`;
  const occurredAt = event.occurredAt ?? event.observedAt;
  stmt(
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

function ingestTask(stmt: StatementCache, event: ChronicleEvent): void {
  const attributes = event.attributes ?? {};
  const taskId = event.scope.taskId ?? stringAt(attributes, 'taskId');
  if (!taskId) return;
  const occurredAt = event.occurredAt ?? event.observedAt;
  stmt('INSERT OR IGNORE INTO task_outcomes (task_id) VALUES (?)').run(taskId);
  const set = (sql: string, ...params: Array<string | number>) =>
    stmt(`UPDATE task_outcomes SET ${sql} WHERE task_id = ?`).run(...params, taskId);
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

function ingestFileEvent(stmt: StatementCache, event: ChronicleEvent): void {
  const attributes = event.attributes ?? {};
  const operation = stringAt(attributes, 'operation') ?? '';
  if (!operation || operation === 'read') return;
  const filePath = event.resource?.path ?? stringAt(attributes, 'filePath');
  if (!filePath) return;
  stmt(
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

function provenanceConfidence(
  attributes: Record<string, unknown>,
): 'explicit' | 'correlated' | 'inferred' | 'unknown' {
  const value = attributes['provenanceConfidence'];
  return value === 'explicit' || value === 'correlated' || value === 'inferred' ? value : 'unknown';
}

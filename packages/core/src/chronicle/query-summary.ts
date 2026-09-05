import { compareEvents, readPath } from './query-matching.js';
import type { ChronicleSignalFamily, ChronicleSummary } from './query-types.js';
import type { ChronicleEvent } from './types.js';

export interface SummaryAcc {
  logicalRequestIds: Set<string>;
  modelAttempts: number;
  completedAttempts: number;
  failedAttempts: number;
  scheduledRetries: number;
  fallbacks: number;
  providers: Set<string>;
  models: Set<string>;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costByScope: Map<string, { cost: number; event: ChronicleEvent }>;
  providerDurations: number[];
  toolCalls: number;
  completedTools: number;
  failedTools: number;
  toolDurations: number[];
  processes: number;
  failedProcesses: number;
  fileEvents: number;
  uniqueFiles: Set<string>;
  agentEvents: number;
  uniqueAgents: Set<string>;
  decisions: number;
  escalations: number;
  failures: number;
  cancellations: number;
  families: Record<ChronicleSignalFamily, number>;
  failuresByFamily: Record<ChronicleSignalFamily, number>;
}

/**
 * Exported for the SQLite query engine (`sqlite-query.ts`).
 *
 * Filtering and summarisation are the parts of `ChronicleQuery` with real
 * semantics — family classification, nested `usage.*` attribute paths, cost
 * de-duplication by scope, a p95 over every matching duration. Re-expressing
 * those in SQL would create a second definition that drifts from this one, and
 * the drift would show up as quietly different numbers rather than an error.
 * The SQLite engine therefore uses SQL only to narrow candidates, then runs
 * these exact functions over the parsed events.
 */
export function createSummaryAccumulator(): SummaryAcc {
  return {
    logicalRequestIds: new Set(),
    modelAttempts: 0,
    completedAttempts: 0,
    failedAttempts: 0,
    scheduledRetries: 0,
    fallbacks: 0,
    providers: new Set(),
    models: new Set(),
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costByScope: new Map(),
    providerDurations: [],
    toolCalls: 0,
    completedTools: 0,
    failedTools: 0,
    toolDurations: [],
    processes: 0,
    failedProcesses: 0,
    fileEvents: 0,
    uniqueFiles: new Set(),
    agentEvents: 0,
    uniqueAgents: new Set(),
    decisions: 0,
    escalations: 0,
    failures: 0,
    cancellations: 0,
    families: {
      llm: 0,
      agent: 0,
      tool: 0,
      file: 0,
      memory: 0,
      task: 0,
      decision: 0,
      runtime: 0,
      finding: 0,
    },
    failuresByFamily: {
      llm: 0,
      agent: 0,
      tool: 0,
      file: 0,
      memory: 0,
      task: 0,
      decision: 0,
      runtime: 0,
      finding: 0,
    },
  };
}

export function updateSummary(acc: SummaryAcc, event: ChronicleEvent): void {
  // Families
  const family = signalFamily(event);
  acc.families[family]++;
  if (isTerminalFailure(event)) acc.failuresByFamily[family]++;

  // Running counts per event type
  if (event.correlation.logicalRequestId)
    acc.logicalRequestIds.add(event.correlation.logicalRequestId);
  if (event.runtime?.providerId) acc.providers.add(event.runtime.providerId);
  if (event.runtime?.modelId) acc.models.add(event.runtime.modelId);

  if (event.eventType === 'provider.attempt.started') acc.modelAttempts++;
  else if (event.eventType === 'provider.attempt.completed') {
    acc.completedAttempts++;
    acc.inputTokens += numberAt(event, 'usage.input');
    acc.outputTokens += numberAt(event, 'usage.output');
    acc.cacheReadTokens += numberAt(event, 'usage.cacheRead');
    acc.cacheWriteTokens += numberAt(event, 'usage.cacheWrite');
    const dur = durationMs(event);
    if (dur > 0) acc.providerDurations.push(dur);
  } else if (event.eventType === 'provider.attempt.failed') {
    acc.failedAttempts++;
    if (event.attributes?.retryScheduled === true) acc.scheduledRetries++;
    const dur = durationMs(event);
    if (dur > 0) acc.providerDurations.push(dur);
  } else if (event.eventType === 'provider.fallback') acc.fallbacks++;
  else if (event.eventType === 'tool.started') acc.toolCalls++;
  else if (event.eventType === 'tool.executed') {
    acc.completedTools++;
    const dur = durationMs(event);
    if (dur > 0) acc.toolDurations.push(dur);
  } else if (event.eventType === 'tool.failed') {
    acc.failedTools++;
    const dur = durationMs(event);
    if (dur > 0) acc.toolDurations.push(dur);
  } else if (event.eventType === 'process.started') acc.processes++;
  else if (event.eventType === 'process.completed' && event.outcome === 'failure')
    acc.failedProcesses++;
  else if (event.eventType === 'decision.requested') acc.decisions++;
  else if (event.eventType === 'decision.escalated') acc.escalations++;

  // Token accounted — keep the latest finite snapshot per scope. Zero is a
  // meaningful reset, and compareEvents makes ties independent of scan order.
  // `subagent.token_accounted` is the bridged name a subagent's spend arrives
  // under (its own EventBus never reaches Chronicle); scopeKey includes the
  // agent, so leader and subagent snapshots occupy separate slots and the
  // cost sum covers both instead of silently dropping every subagent.
  if (event.eventType === 'token.accounted' || event.eventType === 'subagent.token_accounted') {
    const cost = readPath(event.attributes ?? {}, 'cost.total');
    if (typeof cost === 'number' && Number.isFinite(cost)) {
      const key = scopeKey(event);
      const existing = acc.costByScope.get(key);
      if (!existing || compareEvents(event, existing.event) > 0) {
        acc.costByScope.set(key, { cost, event });
      }
    }
  }

  // File evidence
  if (event.resource?.kind === 'file' || event.eventType.startsWith('file.')) {
    acc.fileEvents++;
    if (event.resource?.path) acc.uniqueFiles.add(event.resource.path);
  }

  // Agent events
  if (family === 'agent') acc.agentEvents++;
  if (event.scope.agentId) acc.uniqueAgents.add(event.scope.agentId);

  // Terminal failures and cancellations
  if (isTerminalFailure(event)) acc.failures++;
  if (event.outcome === 'cancelled' || event.outcome === 'abandoned') acc.cancellations++;
}

export function finalizeSummary(acc: SummaryAcc): ChronicleSummary {
  const sortedProviderDurations = acc.providerDurations.slice().sort((a, b) => a - b);
  const sortedToolDurations = acc.toolDurations.slice().sort((a, b) => a - b);
  const totalCost = [...acc.costByScope.values()].reduce((sum, entry) => sum + entry.cost, 0);
  return {
    logicalRequests: acc.logicalRequestIds.size,
    modelAttempts: acc.modelAttempts,
    completedAttempts: acc.completedAttempts,
    failedAttempts: acc.failedAttempts,
    scheduledRetries: acc.scheduledRetries,
    fallbacks: acc.fallbacks,
    providers: acc.providers.size,
    models: acc.models.size,
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    cacheReadTokens: acc.cacheReadTokens,
    cacheWriteTokens: acc.cacheWriteTokens,
    estimatedCostUsd: totalCost,
    providerAvgDurationMs: average(sortedProviderDurations),
    providerP95DurationMs: percentile(sortedProviderDurations, 0.95),
    toolCalls: acc.toolCalls,
    completedTools: acc.completedTools,
    failedTools: acc.failedTools,
    toolAvgDurationMs: average(sortedToolDurations),
    processes: acc.processes,
    failedProcesses: acc.failedProcesses,
    fileEvents: acc.fileEvents,
    uniqueFiles: acc.uniqueFiles.size,
    agentEvents: acc.agentEvents,
    uniqueAgents: acc.uniqueAgents.size,
    decisions: acc.decisions,
    escalations: acc.escalations,
    failures: acc.failures,
    cancellations: acc.cancellations,
    families: acc.families,
    failuresByFamily: acc.failuresByFamily,
  };
}

function numberAt(event: ChronicleEvent, dotPath: string): number {
  const value = readPath(event.attributes ?? {}, dotPath);
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function durationMs(event: ChronicleEvent): number {
  const value = Number(event.durationNs ?? 0) / 1_000_000;
  return Number.isFinite(value) ? value : 0;
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
}

function percentile(sorted: number[], quantile: number): number {
  return sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))]!
    : 0;
}

function scopeKey(event: ChronicleEvent): string {
  return `${event.scope.projectId ?? ''}\0${event.scope.sessionId ?? ''}\0${event.scope.agentId ?? ''}`;
}

/** Shared with ChronicleMetricsStore so its default-view summary classifies
 *  events identically to the raw-scan summary it stands in for. */
export function signalFamily(event: ChronicleEvent): ChronicleSignalFamily {
  if (/^(?:decision|brain|permission)\./.test(event.eventType)) return 'decision';
  if (
    event.resource?.kind === 'file' ||
    event.resource?.kind === 'symbol' ||
    /^(?:file|worktree)\./.test(event.eventType)
  )
    return 'file';
  if (/^(?:provider|token|context|ctx|compaction)\./.test(event.eventType)) return 'llm';
  if (/^(?:agent|subagent|delegate|fleet|concurrency)\./.test(event.eventType)) return 'agent';
  if (/^(?:tool|process|mcp|network)\./.test(event.eventType)) return 'tool';
  if (/^(?:memory|storage|trust)\./.test(event.eventType)) return 'memory';
  if (/^(?:sdd|task|kanban|checkpoint|session|iteration|in_flight)\./.test(event.eventType))
    return 'task';
  if (/^(?:finding|review)\./.test(event.eventType)) return 'finding';
  return 'runtime';
}

/** Shared with ChronicleMetricsStore — see signalFamily(). */
export function isTerminalFailure(event: ChronicleEvent): boolean {
  if (event.eventType === 'provider.attempt.failed')
    return event.attributes?.retryScheduled !== true;
  return (
    event.eventType === 'tool.failed' ||
    (event.eventType === 'process.completed' && event.outcome === 'failure') ||
    /^(?:agent\.run\.error|sdd\.task\.failed|compaction\.failed|network\.request\.failed)$/.test(
      event.eventType,
    )
  );
}

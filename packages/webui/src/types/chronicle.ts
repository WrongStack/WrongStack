export interface ChronicleEventView {
  schemaVersion: number;
  eventId: string;
  eventType: string;
  occurredAt?: string | undefined;
  observedAt: string;
  persistedAt: string;
  sequence: number;
  hash: string;
  previousHash: string;
  outcome?: string | undefined;
  durationNs?: string | undefined;
  scope: Record<string, string | undefined>;
  correlation: Record<string, string | undefined>;
  runtime?:
    | { providerId?: string; modelId?: string; processId?: number; parentProcessId?: number }
    | undefined;
  resource?:
    | { kind: string; id: string; path?: string; lineStart?: number; lineEnd?: number }
    | undefined;
  attributes?: Record<string, unknown> | undefined;
  tags?: Record<string, string> | undefined;
}

export interface ChronicleQuery {
  eventId?: string;
  eventTypes?: string[];
  outcomes?: string[];
  from?: string;
  to?: string;
  projectId?: string;
  sessionId?: string;
  agentId?: string;
  taskId?: string;
  providerId?: string;
  modelId?: string;
  traceId?: string;
  logicalRequestId?: string;
  attemptId?: string;
  toolCallId?: string;
  resourceKind?: string;
  resourceId?: string;
  path?: string;
  line?: number;
  text?: string;
  order?: 'asc' | 'desc';
  limit?: number;
  cursor?: string;
  tags?: Record<string, string>;
  attributes?: Record<string, unknown>;
}
export type ChronicleFacet =
  | 'eventType'
  | 'outcome'
  | 'projectId'
  | 'sessionId'
  | 'agentId'
  | 'taskId'
  | 'providerId'
  | 'modelId'
  | 'resourceKind'
  | 'resourcePath'
  | 'toolCallId';
export interface ChronicleFacetValue {
  value: string;
  count: number;
}
export interface ChronicleQueryResult {
  events: ChronicleEventView[];
  total: number;
  nextCursor?: string;
  scannedEvents: number;
  sourceFiles: number;
  invalidLines: number;
  summary: ChronicleSummary;
}
export interface ChronicleSummary {
  logicalRequests: number;
  modelAttempts: number;
  completedAttempts: number;
  failedAttempts: number;
  scheduledRetries: number;
  fallbacks: number;
  providers: number;
  models: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
  providerAvgDurationMs: number;
  providerP95DurationMs: number;
  toolCalls: number;
  completedTools: number;
  failedTools: number;
  toolAvgDurationMs: number;
  processes: number;
  failedProcesses: number;
  fileEvents: number;
  uniqueFiles: number;
  agentEvents: number;
  uniqueAgents: number;
  decisions: number;
  escalations: number;
  failures: number;
  cancellations: number;
  families: Record<ChronicleSignalFamily, number>;
  failuresByFamily: Record<ChronicleSignalFamily, number>;
}
export type ChronicleSignalFamily =
  | 'llm'
  | 'agent'
  | 'tool'
  | 'file'
  | 'memory'
  | 'task'
  | 'decision'
  | 'runtime';
export interface ChronicleGraphResult {
  nodes: ChronicleEventView[];
  edges: Array<{
    from: string;
    to: string;
    kind: string;
    confidence: 'explicit' | 'correlated' | 'inferred';
  }>;
  truncated: boolean;
}
/** Derived aggregates served from the server-side Chronicle metrics store
 *  (metrics.db) — no raw journal scan on the request path. */
export type ChronicleMetricsView = 'summary' | 'providers' | 'tasks' | 'files';
interface ChronicleMetricsRefresh {
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
interface ChronicleMetricsSummaryView {
  providers: { attempts: number; completed: number; failed: number; successRate: number };
  tasks: Record<string, number>;
  files: { mutations: number; uniquePaths: number };
  estimatedCostUsd: number;
}
export type ChronicleMetricsResultPayload =
  | { view: 'summary'; refreshed: ChronicleMetricsRefresh; data: ChronicleMetricsSummaryView }
  | { view: 'providers'; refreshed: ChronicleMetricsRefresh; data: ChronicleProviderDailyRow[] }
  | { view: 'tasks'; refreshed: ChronicleMetricsRefresh; data: ChronicleTaskOutcomeRow[] }
  | { view: 'files'; refreshed: ChronicleMetricsRefresh; data: ChronicleFileLineageRow[] };

export interface ChronicleStatus {
  mode: 'server' | 'inline';
  protocolVersion: number;
  pid: number;
  projectRoot: string;
  projectDir: string;
  chronicleDirectory: string;
  endpoint: string;
  startedAt: string;
  checkedAt: number;
  uptimeMs: number;
  clients: number;
  activeRequests: number;
  journal: {
    pendingEvents: number;
    rejectedEvents: number;
    largestBatch: number;
  };
  watcher: {
    active: boolean;
    watchedFiles: number;
    lastError?: string | undefined;
  };
  memory: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
  };
  pipeline: {
    collection: 'session-event-adapters';
    processing: 'project-chronicle-server' | 'inline-chronicle-fallback';
    storage: string;
    serving: 'webui-server';
  };
}

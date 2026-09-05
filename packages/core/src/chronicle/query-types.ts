import type { ChroniclePartitionRangeCache } from './partition-range-cache.js';
import type { ChronicleEvent, ChronicleOutcome, ChronicleResourceRef } from './types.js';

export interface ChronicleQuery {
  eventId?: string;
  eventTypes?: string[];
  outcomes?: ChronicleOutcome[];
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
  promptManifestId?: string;
  attemptId?: string;
  toolCallId?: string;
  resourceKind?: ChronicleResourceRef['kind'];
  resourceId?: string;
  path?: string;
  line?: number;
  tags?: Record<string, string>;
  attributes?: Record<string, unknown>;
  text?: string;
  order?: 'asc' | 'desc';
  limit?: number;
  cursor?: string;
}

export interface ChronicleQueryResult {
  events: ChronicleEvent[];
  total: number;
  nextCursor?: string;
  scannedEvents: number;
  sourceFiles: number;
  invalidLines: number;
  summary: ChronicleSummary;
}

/** Derived once from all matching events; never from the paginated UI sample. */
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
  | 'runtime'
  | 'finding';

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

export type ChronicleFacetResults = Partial<Record<ChronicleFacet, ChronicleFacetValue[]>>;

/**
 * The complete set of valid {@link ChronicleFacet} values. Shared by both
 * the CLI-embedded and standalone WebUI message routers so they can validate
 * `chronicle.facet` / `chronicle.facets` payloads against a single source of
 * truth — if `ChronicleFacet` grows a member, this set is the only place
 * that needs updating.
 */
export const CHRONICLE_FACET_FIELDS: ReadonlySet<ChronicleFacet> = new Set<ChronicleFacet>([
  'eventType',
  'outcome',
  'projectId',
  'sessionId',
  'agentId',
  'taskId',
  'providerId',
  'modelId',
  'resourceKind',
  'resourcePath',
  'toolCallId',
]);

export type ChronicleRelationKind =
  | 'parent_span'
  | 'trace'
  | 'tool_call'
  | 'logical_request'
  | 'attempt'
  | 'decision'
  | 'network_request'
  | 'prompt_manifest'
  | 'resource_lineage';

export interface ChronicleGraphEdge {
  from: string;
  to: string;
  kind: ChronicleRelationKind;
  confidence: 'explicit' | 'correlated' | 'inferred';
}

export interface ChronicleGraphResult {
  nodes: ChronicleEvent[];
  edges: ChronicleGraphEdge[];
  truncated: boolean;
}

export interface ChronicleOrderKey {
  occurredAt: string;
  persistedAt: string;
  sequence: number;
  eventId: string;
}

export interface ChronicleSnapshotEntry {
  id: string;
  size: number;
}

export interface ChronicleCursor {
  version: 1;
  order: 'asc' | 'desc';
  queryHash: string;
  after: ChronicleOrderKey;
  snapshot: ChronicleSnapshotEntry[];
}

export interface SnapshotFile extends ChronicleSnapshotEntry {
  file: string;
}

export const MAX_CURSOR_SNAPSHOT_ENTRIES = 10_000;

export interface ChronicleQueryEngineOptions {
  /** Shared, longer-lived cache of closed partitions' observed occurredAt ranges. */
  rangeCache?: ChroniclePartitionRangeCache;
}

import { createHash } from 'node:crypto';
import type {
  ChronicleCursor,
  ChronicleFacet,
  ChronicleGraphEdge,
  ChronicleOrderKey,
  ChronicleQuery,
  ChronicleRelationKind,
} from './query-types.js';
import { MAX_CURSOR_SNAPSHOT_ENTRIES } from './query-types.js';
import type { ChronicleEvent } from './types.js';

export function matches(event: ChronicleEvent, query: ChronicleQuery): boolean {
  if (query.eventId && event.eventId !== query.eventId) return false;
  if (query.eventTypes && !query.eventTypes.includes(event.eventType)) return false;
  if (query.outcomes && (!event.outcome || !query.outcomes.includes(event.outcome))) return false;
  const occurredAt = event.occurredAt ?? event.observedAt;
  if ((query.from && occurredAt < query.from) || (query.to && occurredAt > query.to)) return false;
  if (
    !equal(query.projectId, event.scope.projectId) ||
    !equal(query.sessionId, event.scope.sessionId)
  )
    return false;
  if (!equal(query.agentId, event.scope.agentId) || !equal(query.taskId, event.scope.taskId))
    return false;
  if (
    !equal(query.providerId, event.runtime?.providerId) ||
    !equal(query.modelId, event.runtime?.modelId)
  )
    return false;
  if (
    !equal(query.traceId, event.correlation.traceId) ||
    !equal(query.logicalRequestId, event.correlation.logicalRequestId)
  )
    return false;
  if (!equal(query.promptManifestId, event.correlation.promptManifestId)) return false;
  if (
    !equal(query.attemptId, event.correlation.attemptId) ||
    !equal(query.toolCallId, event.correlation.toolCallId)
  )
    return false;
  if (
    !equal(query.resourceKind, event.resource?.kind) ||
    !equal(query.resourceId, event.resource?.id)
  )
    return false;
  if (query.path && normalize(event.resource?.path) !== normalize(query.path)) return false;
  if (query.line !== undefined && !lineContains(event, query.line)) return false;
  if (query.tags && !objectContains(event.tags, query.tags)) return false;
  if (query.attributes && !objectContains(event.attributes, query.attributes)) return false;
  if (
    query.text &&
    !JSON.stringify(event).toLocaleLowerCase().includes(query.text.toLocaleLowerCase())
  )
    return false;
  return true;
}

export function equal<T>(expected: T | undefined, actual: T | undefined): boolean {
  return expected === undefined || expected === actual;
}

export function normalize(value: string | undefined): string | undefined {
  return value?.replaceAll('\\', '/').toLocaleLowerCase();
}

export function lineContains(event: ChronicleEvent, line: number): boolean {
  const start = event.resource?.lineStart;
  const end = event.resource?.lineEnd ?? start;
  return start !== undefined && end !== undefined && line >= start && line <= end;
}

export function objectContains(
  actual: Record<string, unknown> | undefined,
  expected: Record<string, unknown>,
): boolean {
  return Boolean(
    actual &&
      Object.entries(expected).every(([key, value]) => deepEqual(readPath(actual, key), value)),
  );
}

export function readPath(value: Record<string, unknown>, key: string): unknown {
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

export function deepEqual(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

export function findInsertionIndex(
  events: readonly ChronicleEvent[],
  event: ChronicleEvent,
  compare: (left: ChronicleEvent, right: ChronicleEvent) => number,
): number {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compare(events[middle]!, event) <= 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function compareEvents(a: ChronicleEvent, b: ChronicleEvent): number {
  return compareEventToKey(a, orderKey(b));
}

export function compareEventToKey(event: ChronicleEvent, key: ChronicleOrderKey): number {
  return (
    (event.occurredAt ?? event.observedAt).localeCompare(key.occurredAt) ||
    event.persistedAt.localeCompare(key.persistedAt) ||
    event.sequence - key.sequence ||
    event.eventId.localeCompare(key.eventId)
  );
}

export function orderKey(event: ChronicleEvent): ChronicleOrderKey {
  return {
    occurredAt: event.occurredAt ?? event.observedAt,
    persistedAt: event.persistedAt,
    sequence: event.sequence,
    eventId: event.eventId,
  };
}

export function hashQuery(query: ChronicleQuery): string {
  const { cursor: _cursor, limit: _limit, order: _order, ...filters } = query;
  return createHash('sha256').update(stableStringify(filters), 'utf8').digest('base64url');
}

export function encodeCursor(cursor: ChronicleCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(
  encoded: string | undefined,
  order: 'asc' | 'desc',
  queryHash: string,
): ChronicleCursor | undefined {
  if (!encoded) return undefined;
  if (encoded.length > 1_000_000) throw new Error('Invalid Chronicle cursor');
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown;
    if (!isCursor(parsed) || parsed.order !== order || parsed.queryHash !== queryHash) {
      throw new Error('cursor does not match the query');
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `Invalid Chronicle cursor: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function isCursor(value: unknown): value is ChronicleCursor {
  if (!value || typeof value !== 'object') return false;
  const cursor = value as Partial<ChronicleCursor>;
  const after = cursor.after as Partial<ChronicleOrderKey> | undefined;
  if (
    cursor.version !== 1 ||
    (cursor.order !== 'asc' && cursor.order !== 'desc') ||
    typeof cursor.queryHash !== 'string' ||
    !after ||
    typeof after.occurredAt !== 'string' ||
    typeof after.persistedAt !== 'string' ||
    !Number.isSafeInteger(after.sequence) ||
    typeof after.eventId !== 'string' ||
    !Array.isArray(cursor.snapshot) ||
    cursor.snapshot.length > MAX_CURSOR_SNAPSHOT_ENTRIES
  )
    return false;

  const snapshotIds = new Set<string>();
  for (const entry of cursor.snapshot) {
    if (
      !entry ||
      typeof entry.id !== 'string' ||
      !entry.id ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      snapshotIds.has(entry.id)
    )
      return false;
    snapshotIds.add(entry.id);
  }
  return true;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(',')}}`;
}

export function isChronicleEvent(value: unknown): value is ChronicleEvent {
  if (!isRecord(value) || !isRecord(value.scope) || !isRecord(value.correlation)) return false;
  return (
    value.schemaVersion === 1 &&
    typeof value.eventId === 'string' &&
    typeof value.eventType === 'string' &&
    typeof value.occurredAt === 'string' &&
    typeof value.observedAt === 'string' &&
    typeof value.persistedAt === 'string' &&
    Number.isSafeInteger(value.sequence) &&
    (value.sequence as number) >= 0 &&
    typeof value.previousHash === 'string' &&
    typeof value.hash === 'string' &&
    typeof value.scope.installationId === 'string' &&
    typeof value.scope.machineId === 'string' &&
    optionalStrings(value.scope, [
      'projectId',
      'repositoryId',
      'workspaceId',
      'worktreeId',
      'sessionId',
      'turnId',
      'iterationId',
      'agentId',
      'goalId',
      'planId',
      'taskId',
      'kanbanBoardId',
    ]) &&
    typeof value.correlation.traceId === 'string' &&
    typeof value.correlation.spanId === 'string' &&
    optionalStrings(value.correlation, [
      'parentSpanId',
      'logicalRequestId',
      'promptManifestId',
      'attemptId',
      'toolCallId',
    ]) &&
    isRuntime(value.runtime) &&
    isResource(value.resource) &&
    (value.attributes === undefined || isRecord(value.attributes)) &&
    (value.tags === undefined || isStringRecord(value.tags))
  );
}

export function isRuntime(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) &&
      optionalStrings(value, ['providerId', 'modelId', 'modelRevision']) &&
      optionalFiniteNumbers(value, ['processId', 'parentProcessId']))
  );
}

export function isResource(value: unknown): boolean {
  if (value === undefined) return true;
  if (
    !isRecord(value) ||
    ![
      'file',
      'symbol',
      'memory',
      'task',
      'kanban',
      'process',
      'network',
      'artifact',
      'other',
    ].includes(String(value.kind)) ||
    typeof value.id !== 'string'
  )
    return false;
  return (
    optionalStrings(value, ['path', 'contentHashBefore', 'contentHashAfter']) &&
    optionalFiniteNumbers(value, ['lineStart', 'lineEnd'])
  );
}

export function optionalStrings(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => value[key] === undefined || typeof value[key] === 'string');
}

export function optionalFiniteNumbers(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return keys.every(
    (key) =>
      value[key] === undefined || (typeof value[key] === 'number' && Number.isFinite(value[key])),
  );
}

export function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function facetValue(event: ChronicleEvent, field: ChronicleFacet): string | undefined {
  const values: Record<ChronicleFacet, string | undefined> = {
    eventType: event.eventType,
    outcome: event.outcome,
    projectId: event.scope.projectId,
    sessionId: event.scope.sessionId,
    agentId: event.scope.agentId,
    taskId: event.scope.taskId,
    providerId: event.runtime?.providerId,
    modelId: event.runtime?.modelId,
    resourceKind: event.resource?.kind,
    resourcePath: event.resource?.path,
    toolCallId: event.correlation.toolCallId,
  };
  return values[field];
}

export function relationKeys(event: ChronicleEvent): Array<{
  key: string;
  kind: ChronicleRelationKind;
  confidence: ChronicleGraphEdge['confidence'];
}> {
  const result: Array<{
    key: string;
    kind: ChronicleRelationKind;
    confidence: ChronicleGraphEdge['confidence'];
  }> = [];
  const add = (
    kind: ChronicleRelationKind,
    value: unknown,
    confidence: ChronicleGraphEdge['confidence'],
  ) => {
    if (typeof value === 'string' && value)
      result.push({ key: `${kind}:${value}`, kind, confidence });
  };
  add('trace', event.correlation.traceId, 'correlated');
  add('tool_call', event.correlation.toolCallId, 'explicit');
  add('logical_request', event.correlation.logicalRequestId, 'explicit');
  add('attempt', event.correlation.attemptId, 'explicit');
  add('decision', event.attributes?.decisionId, 'explicit');
  add('network_request', event.attributes?.requestId, 'explicit');
  add(
    'prompt_manifest',
    event.correlation.promptManifestId ??
      (event.attributes?.promptManifest as Record<string, unknown> | undefined)?.manifestId,
    'explicit',
  );
  add('resource_lineage', event.resource?.id, 'inferred');
  if (
    event.eventType === 'metrics.rollup' &&
    event.attributes?.signal === 'tool.resource.observed'
  ) {
    const resources = event.attributes.resources as Array<{ id?: unknown }> | undefined;
    for (const resource of resources ?? []) {
      if (typeof resource?.id === 'string') add('resource_lineage', resource.id, 'inferred');
    }
  }
  if (event.correlation.parentSpanId)
    add('parent_span', event.correlation.parentSpanId, 'explicit');
  add('parent_span', event.correlation.spanId, 'explicit');
  return result;
}

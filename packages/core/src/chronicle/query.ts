import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { comparePartitionPaths, PARTITION_FILE_PATTERN } from './partition-filename.js';
import {
  type ChroniclePartitionRange,
  ChroniclePartitionRangeCache,
} from './partition-range-cache.js';
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

interface ChronicleOrderKey {
  occurredAt: string;
  persistedAt: string;
  sequence: number;
  eventId: string;
}

interface ChronicleSnapshotEntry {
  id: string;
  size: number;
}

interface ChronicleCursor {
  version: 1;
  order: 'asc' | 'desc';
  queryHash: string;
  after: ChronicleOrderKey;
  snapshot: ChronicleSnapshotEntry[];
}

interface SnapshotFile extends ChronicleSnapshotEntry {
  file: string;
}

const MAX_CURSOR_SNAPSHOT_ENTRIES = 10_000;

// ── Streaming line-by-line reader ──────────────────────────────────────────

async function* streamLines(filePath: string, maxBytes?: number): AsyncGenerator<string> {
  const stream = createReadStream(filePath, {
    encoding: 'utf8',
    highWaterMark: 256 * 1024,
    ...(maxBytes !== undefined ? { end: maxBytes - 1 } : {}),
  });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      yield line;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

/** One dedicated full pass over a closed file to learn its true occurredAt bounds. */
async function computeOccurredAtRange(
  file: string,
  size: number,
): Promise<{ min: string; max: string } | undefined> {
  let min: string | undefined;
  let max: string | undefined;
  for await (const line of streamLines(file, size)) {
    if (!line.trim()) continue;
    let event: ChronicleEvent;
    try {
      event = JSON.parse(line) as ChronicleEvent;
      if (!isChronicleEvent(event)) continue;
    } catch {
      continue;
    }
    const occurredAt = event.occurredAt ?? event.observedAt;
    if (min === undefined || occurredAt < min) min = occurredAt;
    if (max === undefined || occurredAt > max) max = occurredAt;
  }
  return min === undefined ? undefined : { min, max: max! };
}

function rangeOverlaps(range: ChroniclePartitionRange, query: ChronicleQuery): boolean {
  if (range.empty) return false;
  if (query.from && range.maxOccurredAt! < query.from) return false;
  if (query.to && range.minOccurredAt! > query.to) return false;
  return true;
}

// ── Streaming query engine (no pre-loaded events) ──────────────────────────

/** Queryable projection over immutable Chronicle JSONL partitions.
 *  Events are streamed on demand — no full-file load into memory. */
export interface ChronicleQueryEngineOptions {
  /** Shared, longer-lived cache of closed partitions' observed occurredAt ranges. */
  rangeCache?: ChroniclePartitionRangeCache;
}

export class ChronicleQueryEngine {
  private readonly partitionFiles: string[];
  private readonly rangeCache: ChroniclePartitionRangeCache | undefined;
  /** The one file (if any) that could still be actively appended to — never cache-checked or skipped. */
  private readonly activeFile: string | undefined;

  private constructor(
    files: string[],
    readonly diagnostics: { sourceFiles: number; invalidLines: number },
    rangeCache?: ChroniclePartitionRangeCache,
    activeFile?: string,
  ) {
    this.partitionFiles = files;
    this.rangeCache = rangeCache;
    this.activeFile = activeFile;
  }

  static async fromDirectory(
    directory: string,
    options?: ChronicleQueryEngineOptions,
  ): Promise<ChronicleQueryEngine> {
    const resolved = path.resolve(directory);
    const files = await findPartitions(resolved);
    const rangeCache = options?.rangeCache ?? new ChroniclePartitionRangeCache(resolved);
    return new ChronicleQueryEngine(
      files,
      { sourceFiles: files.length, invalidLines: 0 },
      rangeCache,
      files.at(-1),
    );
  }

  static async fromFiles(files: string[]): Promise<ChronicleQueryEngine> {
    return new ChronicleQueryEngine(files, { sourceFiles: files.length, invalidLines: 0 });
  }

  /**
   * Returns the file's observed (min, max) `occurredAt` range, computing and
   * caching it on first use. Only ever called for closed/immutable files
   * (never `this.activeFile`) — see the skip-check call sites.
   */
  private async getOrComputeRange(file: string, size: number): Promise<ChroniclePartitionRange> {
    const cached = await this.rangeCache!.get(file, size);
    if (cached) return cached;
    const computed = await computeOccurredAtRange(file, size);
    const range: ChroniclePartitionRange = computed
      ? { size, minOccurredAt: computed.min, maxOccurredAt: computed.max }
      : { size, empty: true };
    this.rangeCache!.set(file, range);
    return range;
  }

  /** True when a closed file's cached range provably cannot contain a match for `query`. */
  private async canSkip(file: string, size: number, query: ChronicleQuery): Promise<boolean> {
    if (!this.rangeCache || (!query.from && !query.to) || file === this.activeFile) return false;
    const range = await this.getOrComputeRange(file, size);
    return !rangeOverlaps(range, query);
  }

  /** Stream all partitions, filter, and return the requested page + summary. */
  async query(query: ChronicleQuery = {}): Promise<ChronicleQueryResult> {
    const order = query.order ?? 'desc';
    const limit = Math.max(1, Math.min(query.limit ?? 100, 10_000));
    const queryHash = hashQuery(query);
    const cursor = decodeCursor(query.cursor, order, queryHash);
    const snapshotFiles = cursor
      ? await resolveSnapshotFiles(this.partitionFiles, cursor.snapshot)
      : await captureSnapshot(this.partitionFiles);
    const files = order === 'asc' ? snapshotFiles : snapshotFiles.slice().reverse();
    const summaryAcc = createSummaryAccumulator();
    const orderedCandidates: ChronicleEvent[] = [];
    const pageOrder = (left: ChronicleEvent, right: ChronicleEvent) =>
      compareEvents(left, right) * (order === 'asc' ? 1 : -1);
    let totalCount = 0;
    let remainingCount = 0;
    let scannedEvents = 0;
    let invalidLines = 0;

    for (const snapshotFile of files) {
      try {
        if (snapshotFile.size === 0) continue;
        // A closed file whose observed occurredAt range can't overlap [from, to]
        // is skipped with zero I/O. scannedEvents/invalidLines below reflect
        // only lines actually read this call, so a skip legitimately lowers
        // them — that's the optimization working, not a regression.
        if (await this.canSkip(snapshotFile.file, snapshotFile.size, query)) continue;
        const lines =
          order === 'asc'
            ? streamLines(snapshotFile.file, snapshotFile.size)
            : reverseLines(snapshotFile.file, snapshotFile.size);

        for await (const line of lines) {
          if (!line.trim()) continue;
          let event: ChronicleEvent;
          try {
            event = JSON.parse(line) as ChronicleEvent;
            if (!isChronicleEvent(event)) {
              invalidLines++;
              continue;
            }
          } catch {
            invalidLines++;
            continue;
          }
          scannedEvents++;

          if (!matches(event, query)) continue;
          totalCount++;
          updateSummary(summaryAcc, event);

          if (cursor && compareEventToKey(event, cursor.after) * (order === 'asc' ? 1 : -1) <= 0) {
            continue;
          }
          remainingCount++;

          // Keyset pagination retains only this page's best `limit` matches.
          // Cursor depth and journal size therefore cannot grow page memory.
          const insertionIndex = findInsertionIndex(orderedCandidates, event, pageOrder);
          if (insertionIndex < limit) {
            orderedCandidates.splice(insertionIndex, 0, event);
            if (orderedCandidates.length > limit) orderedCandidates.pop();
          }
        }
      } catch {
        // Skip unreadable partitions
      }
    }

    const pageEvents = orderedCandidates;
    const lastEvent = pageEvents.at(-1);

    if (this.rangeCache) {
      this.rangeCache.prune(this.partitionFiles);
      await this.rangeCache.flush();
    }

    return {
      events: pageEvents,
      total: totalCount,
      summary: finalizeSummary(summaryAcc),
      ...(lastEvent && pageEvents.length < remainingCount
        ? {
            nextCursor: encodeCursor({
              version: 1,
              order,
              queryHash,
              after: orderKey(lastEvent),
              snapshot: snapshotFiles.map(({ id, size }) => ({ id, size })),
            }),
          }
        : {}),
      scannedEvents,
      sourceFiles: snapshotFiles.length,
      invalidLines,
    };
  }

  /** Stream all partitions once and compute value counts for every requested facet. */
  async facets(
    fields: readonly ChronicleFacet[],
    query: ChronicleQuery = {},
    limit = 100,
  ): Promise<ChronicleFacetResults> {
    const uniqueFields = [...new Set(fields)];
    if (uniqueFields.length === 0) return {};
    const counts = new Map(uniqueFields.map((field) => [field, new Map<string, number>()]));
    const snapshotFiles = await captureSnapshot(this.partitionFiles);
    let invalidLines = 0;
    for (const snapshotFile of snapshotFiles) {
      try {
        if (snapshotFile.size === 0) continue;
        if (await this.canSkip(snapshotFile.file, snapshotFile.size, query)) continue;
        for await (const line of streamLines(snapshotFile.file, snapshotFile.size)) {
          if (!line.trim()) continue;
          let event: ChronicleEvent;
          try {
            event = JSON.parse(line) as ChronicleEvent;
            if (!isChronicleEvent(event)) {
              invalidLines++;
              continue;
            }
          } catch {
            invalidLines++;
            continue;
          }
          if (!matches(event, query)) continue;
          for (const field of uniqueFields) {
            const value = facetValue(event, field);
            const fieldCounts = counts.get(field)!;
            if (value !== undefined) fieldCounts.set(value, (fieldCounts.get(value) ?? 0) + 1);
          }
        }
      } catch {
        /* skip unreadable */
      }
    }
    this.diagnostics.invalidLines = invalidLines;
    if (this.rangeCache) {
      this.rangeCache.prune(this.partitionFiles);
      await this.rangeCache.flush();
    }
    const result: ChronicleFacetResults = {};
    for (const field of uniqueFields) {
      result[field] = [...counts.get(field)!]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
        .slice(0, Math.max(0, limit));
    }
    return result;
  }

  /** Stream all partitions and compute one facet's value counts. */
  async facet(
    field: ChronicleFacet,
    query: ChronicleQuery = {},
    limit = 100,
  ): Promise<ChronicleFacetValue[]> {
    return (await this.facets([field], query, limit))[field] ?? [];
  }

  /** Expand explicit and typed correlation edges; temporal proximity alone never creates causality. */
  async graph(
    seed: ChronicleQuery = {},
    hops = 2,
    maxNodes = 1_000,
  ): Promise<ChronicleGraphResult> {
    const nodeLimit = Math.max(0, Math.floor(maxNodes));
    const selected = new Map<string, ChronicleEvent>();
    let seedCount = 0;

    // Pass 1 retains only the bounded seed set.
    for await (const event of streamEvents(this.partitionFiles)) {
      if (!matches(event, seed)) continue;
      seedCount++;
      if (selected.size < nodeLimit) selected.set(event.eventId, event);
    }

    let frontier = [...selected.values()];
    const depthLimit = Math.max(0, Math.min(hops, 10));
    for (
      let depth = 0;
      depth < depthLimit && frontier.length > 0 && selected.size < nodeLimit;
      depth++
    ) {
      const frontierKeys = new Set(
        frontier.flatMap((event) => relationKeys(event).map((relation) => relation.key)),
      );
      const next: ChronicleEvent[] = [];

      // Each hop is another streaming pass. Only related nodes up to maxNodes
      // are retained, so journal size cannot determine graph memory usage.
      for await (const event of streamEvents(this.partitionFiles)) {
        if (selected.has(event.eventId)) continue;
        if (!relationKeys(event).some((relation) => frontierKeys.has(relation.key))) continue;
        selected.set(event.eventId, event);
        next.push(event);
        if (selected.size >= nodeLimit) break;
      }
      frontier = next;
    }

    const nodes = [...selected.values()].sort(compareEvents);
    const byKey = new Map<string, ChronicleEvent[]>();
    for (const node of nodes)
      for (const relation of relationKeys(node)) {
        const related = byKey.get(relation.key) ?? [];
        related.push(node);
        byKey.set(relation.key, related);
      }

    const edges: ChronicleGraphEdge[] = [];
    const seen = new Set<string>();
    for (const node of nodes)
      for (const relation of relationKeys(node))
        for (const candidate of byKey.get(relation.key) ?? []) {
          if (candidate.eventId === node.eventId) continue;
          const [from, to] =
            compareEvents(node, candidate) <= 0 ? [node, candidate] : [candidate, node];
          const id = `${from.eventId}:${to.eventId}:${relation.kind}`;
          if (!seen.has(id)) {
            seen.add(id);
            edges.push({
              from: from.eventId,
              to: to.eventId,
              kind: relation.kind,
              confidence: relation.confidence,
            });
          }
        }
    return { nodes, edges, truncated: seedCount > nodeLimit || selected.size >= nodeLimit };
  }
}

async function* streamEvents(files: readonly string[]): AsyncGenerator<ChronicleEvent> {
  for (const file of files) {
    try {
      for await (const line of streamLines(file)) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as ChronicleEvent;
          if (isChronicleEvent(event)) yield event;
        } catch {
          /* skip invalid lines */
        }
      }
    } catch {
      /* skip unreadable partitions */
    }
  }
}

// ── Reverse line reader (reads a file from end to start) ───────────────────

async function* reverseLines(filePath: string, maxBytes?: number): AsyncGenerator<string> {
  const CHUNK = 64 * 1024;
  const NEWLINE = 0x0a;
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(filePath, 'r');
  } catch {
    return;
  }
  try {
    const fileSize = (await handle.stat()).size;
    const size = Math.min(fileSize, maxBytes ?? fileSize);
    let position = size;
    let suffix = Buffer.alloc(0);
    while (position > 0) {
      const length = Math.min(CHUNK, position);
      position -= length;
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      // A concurrent shrink (e.g. the retention purge running while a query
      // streams) can leave the recorded offset at or past the file's new EOF:
      // the OS then returns FEWER bytes than requested — zero at most — and
      // allocUnsafe leaves the unread tail uninitialized. Consuming the whole
      // buffer emitted garbage lines (invalidLines noise); honor bytesRead and
      // let the walk continue over the content that still exists below.
      const chunk = bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
      const data = suffix.length === 0 ? chunk : Buffer.concat([chunk, suffix]);
      let lineEnd = data.length;
      let firstNewline = -1;
      for (let index = data.length - 1; index >= 0; index--) {
        if (data[index] !== NEWLINE) continue;
        const trimmed = data
          .subarray(index + 1, lineEnd)
          .toString('utf8')
          .trim();
        if (trimmed) yield trimmed;
        lineEnd = index;
        firstNewline = index;
      }
      suffix = firstNewline >= 0 ? Buffer.from(data.subarray(0, firstNewline)) : data;
    }
    const trimmed = suffix.toString('utf8').trim();
    if (trimmed) yield trimmed;
  } finally {
    await handle.close();
  }
}

// ── Running summary accumulator (replaces scan-then-summarize) ─────────────

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
  /** One-per-scope token.accounted cost snapshot. Updated when a later
   *  token.accounted event has a later timestamp for the same scope. */
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

// ── Partition discovery (no pre-loading) ───────────────────────────────────

/** The partition files list is stored on the prototype for legacy callers
 *  that reference engine.partitionFiles directly. */
Object.defineProperty(ChronicleQueryEngine.prototype, 'partitionFiles', {
  get() {
    throw new Error(
      'ChronicleQueryEngine no longer loads events on construction. Use async query().',
    );
  },
  set(this: ChronicleQueryEngine, _val: string[]) {
    // Allow fromFiles/fromDirectory to attach the list for graph()
    Object.defineProperty(this, 'partitionFiles', {
      value: _val,
      writable: false,
      configurable: false,
    });
  },
});

/** Recursively locate journal partition files under a Chronicle directory,
 *  ordered family-first then rotation index. Shared with the metrics store. */
export async function findChroniclePartitions(root: string): Promise<string[]> {
  return findPartitions(root);
}

async function findPartitions(root: string): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile() && PARTITION_FILE_PATTERN.test(entry.name)) result.push(full);
    }
  };
  await visit(root);
  return result.sort(comparePartitionPaths);
}

// ── Helper functions ───────────────────────────────────────────────────────

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

/**
 * Exported for the SQLite engine. Which correlation keys an event carries — and
 * with what confidence — is the definition of a Chronicle edge; a second copy
 * would let the two engines draw different graphs from the same data.
 */
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
  // tool.resource.observed is windowed into one metrics.rollup event per
  // tool call (rollup-adapter.ts) carrying a bounded `resources` list rather
  // than a single top-level `resource` — surface each as its own edge so a
  // rolled-up "observed" touch still participates in the same resource
  // lineage group as a mutation event for the same resource id.
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

function equal<T>(expected: T | undefined, actual: T | undefined): boolean {
  return expected === undefined || expected === actual;
}
function normalize(value: string | undefined): string | undefined {
  return value?.replaceAll('\\', '/').toLocaleLowerCase();
}
function lineContains(event: ChronicleEvent, line: number): boolean {
  const start = event.resource?.lineStart;
  const end = event.resource?.lineEnd ?? start;
  return start !== undefined && end !== undefined && line >= start && line <= end;
}
function objectContains(
  actual: Record<string, unknown> | undefined,
  expected: Record<string, unknown>,
): boolean {
  return Boolean(
    actual &&
      Object.entries(expected).every(([key, value]) => deepEqual(readPath(actual, key), value)),
  );
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
function deepEqual(left: unknown, right: unknown): boolean {
  // Compare via stableStringify so OBJECT KEY ORDER never decides a match: a
  // nested attribute filter arrives from a client whose key insertion order
  // carries no meaning, while a raw JSON.stringify comparison made the
  // verdict depend on it (content-identical usage objects silently missed).
  // Array order is preserved — element order is semantic.
  return stableStringify(left) === stableStringify(right);
}
function findInsertionIndex(
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
function compareEventToKey(event: ChronicleEvent, key: ChronicleOrderKey): number {
  return (
    (event.occurredAt ?? event.observedAt).localeCompare(key.occurredAt) ||
    event.persistedAt.localeCompare(key.persistedAt) ||
    event.sequence - key.sequence ||
    event.eventId.localeCompare(key.eventId)
  );
}
function orderKey(event: ChronicleEvent): ChronicleOrderKey {
  return {
    occurredAt: event.occurredAt ?? event.observedAt,
    persistedAt: event.persistedAt,
    sequence: event.sequence,
    eventId: event.eventId,
  };
}
function hashQuery(query: ChronicleQuery): string {
  const { cursor: _cursor, limit: _limit, order: _order, ...filters } = query;
  return createHash('sha256').update(stableStringify(filters), 'utf8').digest('base64url');
}
function encodeCursor(cursor: ChronicleCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}
function decodeCursor(
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
function isCursor(value: unknown): value is ChronicleCursor {
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
async function captureSnapshot(files: readonly string[]): Promise<SnapshotFile[]> {
  if (files.length > MAX_CURSOR_SNAPSHOT_ENTRIES) {
    throw new Error('Chronicle snapshot contains too many partitions');
  }
  return Promise.all(
    files.map(async (file) => {
      let size = 0;
      try {
        size = (await fs.stat(file)).size;
      } catch {
        /* preserve missing source as empty */
      }
      return { file, id: fileId(file), size };
    }),
  );
}
async function resolveSnapshotFiles(
  files: readonly string[],
  snapshot: readonly ChronicleSnapshotEntry[],
): Promise<SnapshotFile[]> {
  const currentFiles = new Map(files.map((file) => [fileId(file), file]));
  return Promise.all(
    snapshot.map(async (entry) => {
      const file = currentFiles.get(entry.id);
      if (!file) throw new Error('Chronicle cursor snapshot has expired');
      let currentSize: number;
      try {
        currentSize = (await fs.stat(file)).size;
      } catch {
        throw new Error('Chronicle cursor snapshot has expired');
      }
      if (currentSize < entry.size) throw new Error('Chronicle cursor snapshot has expired');
      return { file, ...entry };
    }),
  );
}
function fileId(file: string): string {
  return createHash('sha256').update(path.resolve(file), 'utf8').digest('base64url');
}
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(',')}}`;
}
function isChronicleEvent(value: unknown): value is ChronicleEvent {
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
function isRuntime(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) &&
      optionalStrings(value, ['providerId', 'modelId', 'modelRevision']) &&
      optionalFiniteNumbers(value, ['processId', 'parentProcessId']))
  );
}
function isResource(value: unknown): boolean {
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
function optionalStrings(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => value[key] === undefined || typeof value[key] === 'string');
}
function optionalFiniteNumbers(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every(
    (key) =>
      value[key] === undefined || (typeof value[key] === 'number' && Number.isFinite(value[key])),
  );
}
function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}
function isRecord(value: unknown): value is Record<string, unknown> {
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

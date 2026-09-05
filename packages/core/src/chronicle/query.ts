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
import {
  compareEvents,
  compareEventToKey,
  decodeCursor,
  encodeCursor,
  facetValue,
  findInsertionIndex,
  hashQuery,
  isChronicleEvent,
  matches,
  orderKey,
  relationKeys,
} from './query-matching.js';
import { createSummaryAccumulator, finalizeSummary, updateSummary } from './query-summary.js';
import {
  type ChronicleFacet,
  type ChronicleFacetResults,
  type ChronicleFacetValue,
  type ChronicleGraphEdge,
  type ChronicleGraphResult,
  type ChronicleQuery,
  type ChronicleQueryEngineOptions,
  type ChronicleQueryResult,
  type ChronicleSnapshotEntry,
  MAX_CURSOR_SNAPSHOT_ENTRIES,
  type SnapshotFile,
} from './query-types.js';
import type { ChronicleEvent } from './types.js';

export { compareEvents, facetValue, matches, relationKeys } from './query-matching.js';
export * from './query-summary.js';
export * from './query-types.js';

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

/** The partition files list is stored on the prototype for legacy callers
 *  that reference engine.partitionFiles directly. */
Object.defineProperty(ChronicleQueryEngine.prototype, 'partitionFiles', {
  get() {
    throw new Error(
      'ChronicleQueryEngine no longer loads events on construction. Use async query().',
    );
  },
  set(this: ChronicleQueryEngine, _val: string[]) {
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

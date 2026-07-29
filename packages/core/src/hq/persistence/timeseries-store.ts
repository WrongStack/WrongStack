/**
 * Time-bucketed cost + activity samples for HQ trend charts.
 *
 * Split out of `hq/persistence.ts`; see that module for the shared design
 * constraints.
 *
 * @module hq/persistence/timeseries-store
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite, withFileLock } from '../../utils/atomic-write.js';
import { BestEffortLatestQueue } from '../write-queues.js';
import { countNonEmptyLines, readJsonlLines } from './jsonl-io.js';

export interface HqTimeseriesSample {
  /** Bucket start (epoch ms, floored to the bucket width). */
  ts: number;
  /** Total cost (USD) accumulated in this bucket. */
  costUsd: number;
  /** Total input tokens in this bucket. */
  inputTokens: number;
  /** Total output tokens in this bucket. */
  outputTokens: number;
  /** Number of tool executions in this bucket. */
  toolCalls: number;
  /** Snapshot of active agents at bucket close (last-write per bucket). */
  activeAgents?: number;
  /** Per-dimension cost/token breakdowns for richer trend charts. */
  byModel?: Record<string, HqTimeseriesBreakdownEntry>;
  byProvider?: Record<string, HqTimeseriesBreakdownEntry>;
}

/**
 * One row of a per-dimension breakdown inside a {@link HqTimeseriesSample}
 * (e.g. the cost + tokens attributed to a single model or provider within the
 * bucket). Sums of these across a dimension equal the bucket's totals when
 * every cost signal carried that dimension.
 */
export interface HqTimeseriesBreakdownEntry {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead?: number | undefined;
  cacheWrite?: number | undefined;
}

export interface HqTimeseriesStoreOptions {
  dataDir: string;
  /** Bucket width in ms. Default 5 minutes. */
  bucketMs?: number;
  /** How many buckets to retain. Default 2016 (1 week of 5-min buckets). */
  maxBuckets?: number;
}

/**
 * Time-bucketed cost + activity samples for trend charts. Each {@link record}
 * call folds a cost/tool signal into the current bucket; {@link flush} writes
 * the accumulated buckets to `timeseries.jsonl` (append under lock) and prunes
 * to `maxBuckets`.
 *
 * The store keeps an in-memory ring of buckets for cheap reads; {@link load}
 * rehydrates them on boot.
 */
export class HqTimeseriesStore {
  private readonly filePath: string;
  private readonly bucketMs: number;
  private readonly maxBuckets: number;
  private readonly buckets = new Map<number, HqTimeseriesSample>();
  private readonly dirtyVersions = new Map<number, number>();
  private readonly writer: BestEffortLatestQueue<{
    samples: HqTimeseriesSample[];
    versions: Map<number, number>;
  }>;
  private nextDirtyVersion = 0;
  private diskLineCount: number | undefined;
  private loaded = false;
  private loadPromise: Promise<void> | undefined;

  constructor(opts: HqTimeseriesStoreOptions) {
    this.filePath = path.join(opts.dataDir, 'timeseries.jsonl');
    this.bucketMs = opts.bucketMs ?? 5 * 60 * 1000;
    this.maxBuckets = opts.maxBuckets ?? 2016;
    this.writer = new BestEffortLatestQueue((snapshot) => this.flushInternal(snapshot));
  }

  private bucketStart(ts: number): number {
    return Math.floor(ts / this.bucketMs) * this.bucketMs;
  }

  /** Fold a cost/tool signal into the current bucket. Best-effort. */
  record(signal: {
    ts?: number;
    costUsd?: number;
    inputTokens?: number;
    outputTokens?: number;
    toolCalls?: number;
    activeAgents?: number;
    /** When present, this signal is also attributed to a model dimension. */
    model?: string;
    /** When present, this signal is also attributed to a provider dimension. */
    provider?: string;
    cacheRead?: number;
    cacheWrite?: number;
  }): void {
    const start = this.bucketStart(signal.ts ?? Date.now());
    let bucket = this.buckets.get(start);
    if (!bucket) {
      bucket = { ts: start, costUsd: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0 };
      this.buckets.set(start, bucket);
    }
    if (signal.costUsd !== undefined) bucket.costUsd += signal.costUsd;
    if (signal.inputTokens !== undefined) bucket.inputTokens += signal.inputTokens;
    if (signal.outputTokens !== undefined) bucket.outputTokens += signal.outputTokens;
    if (signal.toolCalls !== undefined) bucket.toolCalls += signal.toolCalls;
    if (signal.activeAgents !== undefined) bucket.activeAgents = signal.activeAgents;
    // Attribute this cost signal to its model / provider dimension when known,
    // so trend charts can break spend down without scraping the event log.
    if (signal.model !== undefined || signal.provider !== undefined) {
      const entry: HqTimeseriesBreakdownEntry = {
        costUsd: signal.costUsd ?? 0,
        inputTokens: signal.inputTokens ?? 0,
        outputTokens: signal.outputTokens ?? 0,
        ...(signal.cacheRead !== undefined ? { cacheRead: signal.cacheRead } : {}),
        ...(signal.cacheWrite !== undefined ? { cacheWrite: signal.cacheWrite } : {}),
      };
      if (signal.model !== undefined) {
        bucket.byModel = foldBreakdown(bucket.byModel, signal.model, entry);
      }
      if (signal.provider !== undefined) {
        bucket.byProvider = foldBreakdown(bucket.byProvider, signal.provider, entry);
      }
    }
    this.dirtyVersions.set(start, ++this.nextDirtyVersion);
    // Prune in-memory buckets beyond retention so a long-lived HQ doesn't
    // accumulate unbounded history. Keep the most-recent maxBuckets.
    this.pruneBuckets({ dropDirty: true });
  }

  /**
   * Drop the oldest buckets beyond `maxBuckets`.
   *
   * `dropDirty` also forgets the pending flush version for an evicted bucket —
   * correct when the eviction happens on the record path (the bucket is gone,
   * so there is nothing left to write). The load path leaves `dirtyVersions`
   * alone because it has not produced any.
   */
  private pruneBuckets(opts: { dropDirty?: boolean } = {}): void {
    if (this.buckets.size <= this.maxBuckets) return;
    const sorted = Array.from(this.buckets.keys()).sort((a, b) => a - b);
    while (this.buckets.size > this.maxBuckets && sorted.length > 0) {
      const oldest = sorted.shift();
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
      if (opts.dropDirty) this.dirtyVersions.delete(oldest);
    }
  }

  /**
   * Persist accumulated buckets to disk (append under lock), prune to maxBuckets.
   *
   * Note: this dispatcher coalesces — if `flush()` is called multiple times
   * before the previous flush settles, only the most-recent snapshot is
   * written. The dropped snapshots came from the same in-memory `buckets`
   * map, so their data is folded into the surviving snapshot rather than
   * lost. Callers that need every intermediate window on disk should use a
   * BestEffortBatchQueue instead of BestEffortLatestQueue here.
   */
  flush(): void {
    if (this.dirtyVersions.size === 0) return;
    const versions = new Map(this.dirtyVersions);
    for (const [timestamp, version] of versions) {
      if (this.buckets.has(timestamp)) continue;
      versions.delete(timestamp);
      if (this.dirtyVersions.get(timestamp) === version) this.dirtyVersions.delete(timestamp);
    }
    const samples = Array.from(versions.keys())
      .map((timestamp) => this.buckets.get(timestamp))
      .filter((sample): sample is HqTimeseriesSample => sample !== undefined)
      .map(cloneTimeseriesSample)
      .sort((a, b) => a.ts - b.ts);
    if (samples.length === 0) return;
    this.writer.enqueue({ samples, versions });
  }

  /** Resolves once all queued flushes have settled. For tests. */
  async drain(): Promise<void> {
    await this.writer.drain();
  }

  private async flushInternal(snapshot: {
    samples: HqTimeseriesSample[];
    versions: Map<number, number>;
  }): Promise<void> {
    const lines = snapshot.samples.map((bucket) => JSON.stringify(bucket)).join('\n') + '\n';
    await withFileLock(this.filePath, async () => {
      this.diskLineCount ??= await countNonEmptyLines(this.filePath);
      await fs.appendFile(this.filePath, lines, { encoding: 'utf8' });
      this.diskLineCount += snapshot.samples.length;
      const compactAt = Math.max(this.maxBuckets + 1, this.maxBuckets * 4);
      if (this.diskLineCount >= compactAt) {
        const retained = Array.from(this.buckets.values())
          .map(cloneTimeseriesSample)
          .sort((a, b) => a.ts - b.ts);
        await atomicWrite(
          this.filePath,
          retained.map((bucket) => JSON.stringify(bucket)).join('\n') + '\n',
          { mode: 0o600 },
        );
        this.diskLineCount = retained.length;
      }
    });
    for (const [timestamp, version] of snapshot.versions) {
      if (this.dirtyVersions.get(timestamp) === version) this.dirtyVersions.delete(timestamp);
    }
    // Prune in-memory buckets beyond retention.
    this.pruneBuckets();
  }

  /** Read buckets within `[since, now]`, oldest-first. */
  async read(sinceMs?: number): Promise<HqTimeseriesSample[]> {
    // Prefer in-memory (always most current); supplement from disk on first call.
    if (!this.loaded && this.buckets.size === 0) await this.load();
    const since = sinceMs ?? 0;
    return Array.from(this.buckets.values())
      .filter((b) => b.ts >= since)
      .sort((a, b) => a.ts - b.ts);
  }

  /** Rehydrate buckets from disk (deduped, latest-per-bucket wins). */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loadPromise ??= this.loadInternal();
    await this.loadPromise;
  }

  private async loadInternal(): Promise<void> {
    // Streamed, not `readFile(…, 'utf8')`. Two reasons, and the second one bit:
    //  1. The whole file would be resident as one string plus its split parts,
    //     for a store that only ever keeps `maxBuckets` samples.
    //  2. Node caps a single string at ~512 MB. This file had grown past that,
    //     so the read threw ERR_STRING_TOO_LONG — which the catch below turned
    //     into `diskLineCount = 0`, and compaction only fires once
    //     `diskLineCount` crosses a threshold. Too big to read meant too big to
    //     compact, so it grew forever and HQ silently lost all trend history on
    //     every restart. Streaming removes the ceiling that started it.
    let lineCount = 0;
    try {
      for await (const line of readJsonlLines(this.filePath)) {
        lineCount++;
        try {
          const sample = JSON.parse(line) as HqTimeseriesSample;
          // Last-write-wins per bucket (file is append-only, so later lines win).
          this.buckets.set(sample.ts, sample);
        } catch {
          /* skip malformed */
        }
        // Bound the working set during the scan itself: an oversized file must
        // not cost more than a healthy one just because it is being read.
        if (this.buckets.size > this.maxBuckets * 2) this.pruneBuckets();
      }
    } catch {
      // Missing/unreadable file. `lineCount` reflects whatever was consumed, so
      // a partial read still leaves compaction armed rather than disabled.
      this.diskLineCount = lineCount;
      this.loaded = true;
      return;
    }
    this.diskLineCount = lineCount;
    this.loaded = true;
    // Prune to retention.
    this.pruneBuckets();
  }
}

function cloneTimeseriesSample(sample: HqTimeseriesSample): HqTimeseriesSample {
  return {
    ...sample,
    ...(sample.byModel
      ? {
          byModel: Object.fromEntries(
            Object.entries(sample.byModel).map(([key, value]) => [key, { ...value }]),
          ),
        }
      : {}),
    ...(sample.byProvider
      ? {
          byProvider: Object.fromEntries(
            Object.entries(sample.byProvider).map(([key, value]) => [key, { ...value }]),
          ),
        }
      : {}),
  };
}

/**
 * Fold a breakdown entry into a per-dimension map (model or provider), summing
 * cost/token fields and merging cache counts. Returns a new map so the caller
 * can assign it back immutably.
 */
function foldBreakdown(
  map: Record<string, HqTimeseriesBreakdownEntry> | undefined,
  key: string,
  entry: HqTimeseriesBreakdownEntry,
): Record<string, HqTimeseriesBreakdownEntry> {
  const next: Record<string, HqTimeseriesBreakdownEntry> = { ...map };
  const existing = next[key];
  if (existing === undefined) {
    next[key] = { ...entry };
  } else {
    next[key] = {
      costUsd: existing.costUsd + entry.costUsd,
      inputTokens: existing.inputTokens + entry.inputTokens,
      outputTokens: existing.outputTokens + entry.outputTokens,
      cacheRead:
        existing.cacheRead !== undefined || entry.cacheRead !== undefined
          ? (existing.cacheRead ?? 0) + (entry.cacheRead ?? 0)
          : undefined,
      cacheWrite:
        existing.cacheWrite !== undefined || entry.cacheWrite !== undefined
          ? (existing.cacheWrite ?? 0) + (entry.cacheWrite ?? 0)
          : undefined,
    };
  }
  return next;
}

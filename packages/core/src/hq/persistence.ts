/**
 * HQ persistence layer — survives HQ server restarts so the command center
 * keeps its event history, snapshot state, cost/activity trends, and (later)
 * alert + command-audit logs across reboots.
 *
 * Three stores, all file-backed under the HQ dataDir
 * (`~/.wrongstack/hq/` by default — see {@link resolveHqDataDir}):
 *
 *  - {@link HqEventLog}       — append-only JSONL of every received event
 *                               envelope, rotated when it exceeds a cap.
 *  - {@link HqSnapshotStore}  — atomic checkpoint of the latest snapshot,
 *                               written on every debounced broadcast.
 *  - {@link HqTimeseriesStore}— time-bucketed cost + activity samples for
 *                               trend charts.
 *
 * Design constraints (mirrors the codebase conventions):
 *  - All disk writes go through {@link withFileLock} + {@link atomicWrite}
 *    (shared primitives from `utils/atomic-write.ts`) for cross-process safety.
 *  - Every write is best-effort and never throws into the HQ server hot path —
 *    callers wrap in try/catch and degrade to in-memory-only on failure.
 *  - Appends use a FIFO write chain (single in-flight writer) so concurrent
 *    event arrivals don't interleave lines.
 *
 * @module hq/persistence
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite, withFileLock } from '../utils/atomic-write.js';
import type { HqEventEnvelope, HqSnapshot } from './protocol.js';

/** Maximum event-log lines before a rotation compacts it down to the tail. */
const DEFAULT_EVENT_LOG_MAX_LINES = 50_000;
/** How many lines to retain after a rotation. */
const DEFAULT_EVENT_LOG_ROTATE_KEEP = 20_000;

// ── HqEventLog ──────────────────────────────────────────────────────────────

export interface HqEventLogOptions {
  dataDir: string;
  maxLines?: number;
  rotateKeep?: number;
}

/**
 * Append-only JSONL event log. Every received event envelope is appended to
 * `events.jsonl`; when the file exceeds `maxLines` it is rotated under a file
 * lock to keep only the most recent `rotateKeep` lines.
 *
 * Writes are serialized through a FIFO chain so concurrent appends never
 * interleave. All operations are best-effort: a rejected append resolves
 * (never rejects) and the caller's `await` never breaks the server loop.
 */
export class HqEventLog {
  private readonly filePath: string;
  private readonly maxLines: number;
  private readonly rotateKeep: number;
  private writeChain: Promise<void> = Promise.resolve();
  private lineCount = 0;
  private counted = false;

  constructor(opts: HqEventLogOptions) {
    this.filePath = path.join(opts.dataDir, 'events.jsonl');
    this.maxLines = opts.maxLines ?? DEFAULT_EVENT_LOG_MAX_LINES;
    this.rotateKeep = opts.rotateKeep ?? DEFAULT_EVENT_LOG_ROTATE_KEEP;
  }

  /** Append an event envelope as one JSON line. Best-effort, never rejects. */
  append(event: HqEventEnvelope): void {
    this.writeChain = this.writeChain
      .then(() => this.appendInternal(event))
      .catch(() => {
        /* best-effort: a failed append must not break the write chain */
      });
  }

  /** Resolves once all queued appends have settled. For tests. */
  async drain(): Promise<void> {
    await this.writeChain.catch(() => {
      /* best-effort */
    });
  }

  private async appendInternal(event: HqEventEnvelope): Promise<void> {
    if (!this.counted) {
      this.lineCount = await this.countLines();
      this.counted = true;
    }
    const line = JSON.stringify(event) + '\n';
    await fs.appendFile(this.filePath, line, { encoding: 'utf8' });
    this.lineCount += 1;
    if (this.lineCount >= this.maxLines) {
      await this.rotate();
    }
  }

  private async rotate(): Promise<void> {
    await withFileLock(this.filePath, async () => {
      try {
        const content = await fs.readFile(this.filePath, 'utf8');
        const lines = content.split('\n').filter((l) => l.length > 0);
        if (lines.length <= this.rotateKeep) {
          this.lineCount = lines.length;
          return;
        }
        const kept = lines.slice(lines.length - this.rotateKeep);
        await atomicWrite(this.filePath, kept.join('\n') + '\n');
        this.lineCount = kept.length;
      } catch {
        /* best-effort */
      }
    });
  }

  private async countLines(): Promise<number> {
    try {
      const content = await fs.readFile(this.filePath, 'utf8');
      return content.split('\n').filter((l) => l.length > 0).length;
    } catch {
      return 0;
    }
  }

  /**
   * Read the most recent `limit` events, optionally filtered by envelope
   * `type`. Newest first. Returns `[]` if the file doesn't exist yet.
   */
  async recent(limit: number, typeFilter?: string): Promise<HqEventEnvelope[]> {
    let content: string;
    try {
      content = await fs.readFile(this.filePath, 'utf8');
    } catch {
      return [];
    }
    const lines = content.split('\n').filter((l) => l.length > 0);
    const out: HqEventEnvelope[] = [];
    // Walk newest-first so we can stop early once we have `limit` matches.
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        const env = JSON.parse(lines[i]!) as HqEventEnvelope;
        if (typeFilter === undefined || env.type === typeFilter) {
          out.push(env);
        }
      } catch {
        /* skip malformed lines */
      }
    }
    return out;
  }

  /** Initialize the line count cache from disk (call once at boot). */
  async hydrate(): Promise<void> {
    this.lineCount = await this.countLines();
    this.counted = true;
  }
}

// ── HqSnapshotStore ──────────────────────────────────────────────────────────

export interface HqSnapshotStoreOptions {
  dataDir: string;
}

/**
 * Atomic checkpoint of the latest snapshot, written to `snapshot.json`.
 * The HQ server writes on every debounced broadcast and reads on boot to
 * re-seed its in-memory state. Best-effort, never rejects.
 */
export class HqSnapshotStore {
  private readonly filePath: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(opts: HqSnapshotStoreOptions) {
    this.filePath = path.join(opts.dataDir, 'snapshot.json');
  }

  /** Persist a snapshot. Best-effort, never rejects. */
  save(snapshot: HqSnapshot): void {
    this.writeChain = this.writeChain
      .then(() => atomicWrite(this.filePath, JSON.stringify(snapshot), { mode: 0o600 }))
      .catch(() => {
        /* best-effort */
      });
  }

  /** Resolves once all queued saves have settled. For tests. */
  async drain(): Promise<void> {
    await this.writeChain.catch(() => {
      /* best-effort */
    });
  }

  /** Read the last persisted snapshot, or `null` if none. */
  async load(): Promise<HqSnapshot | null> {
    try {
      const content = await fs.readFile(this.filePath, 'utf8');
      return JSON.parse(content) as HqSnapshot;
    } catch {
      return null;
    }
  }
}

// ── HqTimeseriesStore ────────────────────────────────────────────────────────

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
  private flushChain: Promise<void> = Promise.resolve();

  constructor(opts: HqTimeseriesStoreOptions) {
    this.filePath = path.join(opts.dataDir, 'timeseries.jsonl');
    this.bucketMs = opts.bucketMs ?? 5 * 60 * 1000;
    this.maxBuckets = opts.maxBuckets ?? 2016;
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
    // Prune in-memory buckets beyond retention so a long-lived HQ doesn't
    // accumulate unbounded history. Keep the most-recent maxBuckets.
    if (this.buckets.size > this.maxBuckets) {
      const sorted = Array.from(this.buckets.keys()).sort((a, b) => a - b);
      while (this.buckets.size > this.maxBuckets && sorted.length > 0) {
        const oldest = sorted.shift();
        if (oldest === undefined) break;
        this.buckets.delete(oldest);
      }
    }
  }

  /** Persist accumulated buckets to disk (append under lock), prune to maxBuckets. */
  flush(): void {
    const snapshot = Array.from(this.buckets.values()).sort((a, b) => a.ts - b.ts);
    if (snapshot.length === 0) return;
    this.flushChain = this.flushChain
      .then(() => this.flushInternal(snapshot))
      .catch(() => {
        /* best-effort */
      });
  }

  /** Resolves once all queued flushes have settled. For tests. */
  async drain(): Promise<void> {
    await this.flushChain.catch(() => {
      /* best-effort */
    });
  }

  private async flushInternal(toWrite: HqTimeseriesSample[]): Promise<void> {
    const lines = toWrite.map((b) => JSON.stringify(b)).join('\n') + '\n';
    await withFileLock(this.filePath, async () => {
      await fs.appendFile(this.filePath, lines, { encoding: 'utf8' });
    });
    // Prune in-memory buckets beyond retention.
    const sorted = Array.from(this.buckets.keys()).sort((a, b) => a - b);
    while (this.buckets.size > this.maxBuckets) {
      const oldest = sorted.shift();
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
  }

  /** Read buckets within `[since, now]`, oldest-first. */
  async read(sinceMs?: number): Promise<HqTimeseriesSample[]> {
    // Prefer in-memory (always most current); supplement from disk on first call.
    if (this.buckets.size === 0) await this.load();
    const since = sinceMs ?? 0;
    return Array.from(this.buckets.values())
      .filter((b) => b.ts >= since)
      .sort((a, b) => a.ts - b.ts);
  }

  /** Rehydrate buckets from disk (deduped, latest-per-bucket wins). */
  async load(): Promise<void> {
    let content: string;
    try {
      content = await fs.readFile(this.filePath, 'utf8');
    } catch {
      return;
    }
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const sample = JSON.parse(trimmed) as HqTimeseriesSample;
        // Last-write-wins per bucket (file is append-only, so later lines win).
        this.buckets.set(sample.ts, sample);
      } catch {
        /* skip malformed */
      }
    }
    // Prune to retention.
    const sorted = Array.from(this.buckets.keys()).sort((a, b) => a - b);
    while (this.buckets.size > this.maxBuckets) {
      const oldest = sorted.shift();
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
  }
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

// ── HqSimpleLog (generic append-only JSONL for audit/alert records) ──────────

/**
 * A minimal append-only JSONL log used for records that don't need rotation
 * compaction — command-audit entries and fired alerts. Each record is one
 * JSON line appended under a FIFO write chain; {@link readAll} parses them
 * oldest-first. Best-effort: a rejected append resolves (never rejects) so the
 * HQ server hot path is never broken.
 */
export class HqSimpleLog<T> {
  private readonly filePath: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(dataDir: string, filename: string) {
    this.filePath = path.join(dataDir, filename);
  }

  /** Append one record as a JSON line. Best-effort, never rejects. */
  append(record: T): void {
    this.writeChain = this.writeChain
      .then(() => fs.appendFile(this.filePath, `${JSON.stringify(record)}\n`, { encoding: 'utf8' }))
      .catch(() => {
        /* best-effort: a failed append must not break the write chain */
      });
  }

  /** Resolves once all queued appends have settled. For tests. */
  async drain(): Promise<void> {
    await this.writeChain.catch(() => {
      /* best-effort */
    });
  }

  /** Read all records oldest-first. Returns `[]` if the file doesn't exist. */
  async readAll(): Promise<T[]> {
    let content: string;
    try {
      content = await fs.readFile(this.filePath, 'utf8');
    } catch {
      return [];
    }
    const out: T[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as T);
      } catch {
        /* skip malformed lines */
      }
    }
    return out;
  }
}

// ── Aggregate persistence facade ─────────────────────────────────────────────

export interface HqPersistence {
  eventLog: HqEventLog;
  snapshotStore: HqSnapshotStore;
  timeseries: HqTimeseriesStore;
  commandLog: HqSimpleLog<unknown>;
  alertLog: HqSimpleLog<unknown>;
}

export function createHqPersistence(dataDir: string): HqPersistence {
  return {
    eventLog: new HqEventLog({ dataDir }),
    snapshotStore: new HqSnapshotStore({ dataDir }),
    timeseries: new HqTimeseriesStore({ dataDir }),
    commandLog: new HqSimpleLog(dataDir, 'commands.jsonl'),
    alertLog: new HqSimpleLog(dataDir, 'alerts.jsonl'),
  };
}

/**
 * Generic append-only JSONL log for HQ audit/alert records.
 *
 * Split out of `hq/persistence.ts`; see that module for the shared design
 * constraints.
 *
 * @module hq/persistence/simple-log
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite, withFileLock } from '../../utils/atomic-write.js';
import { BestEffortBatchQueue } from '../write-queues.js';
import { countNonEmptyLines, readTailNonEmptyLines } from './jsonl-io.js';

/**
 * A minimal append-only JSONL log used for records that don't need rotation
 * compaction — command-audit entries and fired alerts. Each record is one
 * JSON line appended under a FIFO write chain; {@link HqSimpleLog.readAll}
 * parses them oldest-first. Best-effort: a rejected append resolves (never
 * rejects) so the HQ server hot path is never broken.
 */
export interface HqSimpleLogOptions {
  dataDir: string;
  filename: string;
  maxLines?: number;
  rotateKeep?: number;
  readLimit?: number;
}

export class HqSimpleLog<T> {
  private readonly filePath: string;
  private readonly maxLines: number;
  private readonly rotateKeep: number;
  private readonly readLimit: number;
  private readonly writer: BestEffortBatchQueue<T>;
  private lineCount = 0;
  private counted = false;
  private hydration: Promise<void> | undefined;

  constructor(opts: HqSimpleLogOptions) {
    this.filePath = path.join(opts.dataDir, opts.filename);
    this.maxLines = opts.maxLines ?? Infinity;
    this.rotateKeep = opts.rotateKeep ?? this.maxLines;
    this.readLimit = opts.readLimit ?? Infinity;
    this.writer = new BestEffortBatchQueue((records) => this.appendInternal(records));
  }

  /** Append one record as a JSON line. Best-effort, never rejects. */
  append(record: T): void {
    this.writer.enqueue(record);
  }

  /** Resolves once all queued appends have settled. For tests. */
  async drain(): Promise<void> {
    await this.writer.drain();
  }

  private async appendInternal(records: T[]): Promise<void> {
    if (Number.isFinite(this.maxLines)) await this.ensureLineCount();
    await fs.appendFile(
      this.filePath,
      records.map((record) => JSON.stringify(record)).join('\n') + '\n',
      { encoding: 'utf8' },
    );
    this.lineCount += records.length;
    if (this.lineCount < this.maxLines) return;
    await withFileLock(this.filePath, async () => {
      const retainCount = Math.max(0, Math.floor(this.rotateKeep));
      const newest = await readTailNonEmptyLines(this.filePath, retainCount + 1, this.lineCount);
      if (newest.length <= retainCount) {
        this.lineCount = newest.length;
        return;
      }
      const kept = newest.slice(0, retainCount).reverse();
      await atomicWrite(this.filePath, kept.join('\n') + '\n', { mode: 0o600 });
      this.lineCount = kept.length;
    });
  }

  private async ensureLineCount(): Promise<void> {
    if (this.counted) return;
    this.hydration ??= countNonEmptyLines(this.filePath)
      .catch(() => 0)
      .then((count) => {
        this.lineCount = count;
        this.counted = true;
      });
    await this.hydration;
  }

  /** Read all records oldest-first. Returns `[]` if the file doesn't exist. */
  async readAll(): Promise<T[]> {
    let lines: string[];
    try {
      lines = (
        await readTailNonEmptyLines(
          this.filePath,
          this.readLimit,
          this.counted ? this.lineCount : 0,
        )
      ).reverse();
    } catch {
      return [];
    }
    const out: T[] = [];
    for (const line of lines) {
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

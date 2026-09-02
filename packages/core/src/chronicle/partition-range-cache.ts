import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite, withFileLock } from '../utils/atomic-write.js';

const CACHE_VERSION = 1;

export interface ChroniclePartitionRange {
  size: number;
  minOccurredAt?: string;
  maxOccurredAt?: string;
  /** No valid events were found in the file. */
  empty?: boolean;
}

interface CacheFile {
  version: number;
  entries: Record<string, ChroniclePartitionRange>;
}

function isRange(value: unknown): value is ChroniclePartitionRange {
  if (!value || typeof value !== 'object') return false;
  const range = value as Partial<ChroniclePartitionRange>;
  return (
    typeof range.size === 'number' &&
    (range.minOccurredAt === undefined || typeof range.minOccurredAt === 'string') &&
    (range.maxOccurredAt === undefined || typeof range.maxOccurredAt === 'string') &&
    (range.empty === undefined || typeof range.empty === 'boolean')
  );
}

/**
 * Persisted cache of each closed (immutable) Chronicle partition file's
 * observed min/max `occurredAt`, so query()/facets() can skip a file
 * entirely instead of re-streaming its contents when it can't overlap a
 * time-bounded query. Keyed by (path, size) so a file whose size ever
 * unexpectedly changes just misses and gets recomputed.
 */
export class ChroniclePartitionRangeCache {
  private readonly cachePath: string;
  private entries: Map<string, ChroniclePartitionRange> | undefined;
  private dirty = false;

  constructor(private readonly directory: string) {
    this.cachePath = path.join(directory, 'range-cache.json');
  }

  private toKey(filePath: string): string {
    return path.relative(this.directory, filePath).split(path.sep).join('/');
  }

  private async load(): Promise<Map<string, ChroniclePartitionRange>> {
    if (this.entries) return this.entries;
    const entries = new Map<string, ChroniclePartitionRange>();
    try {
      const raw = await fs.readFile(this.cachePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<CacheFile>;
      if (
        parsed.version === CACHE_VERSION &&
        parsed.entries &&
        typeof parsed.entries === 'object'
      ) {
        for (const [key, range] of Object.entries(parsed.entries)) {
          if (isRange(range)) entries.set(key, range);
        }
      }
    } catch {
      // Missing, corrupt, or unreadable sidecar: self-heal by starting
      // empty rather than failing the query it's meant to speed up.
    }
    this.entries = entries;
    return entries;
  }

  async get(filePath: string, currentSize: number): Promise<ChroniclePartitionRange | undefined> {
    const entries = await this.load();
    const range = entries.get(this.toKey(filePath));
    return range && range.size === currentSize ? range : undefined;
  }

  set(filePath: string, range: ChroniclePartitionRange): void {
    this.entries ??= new Map();
    this.entries.set(this.toKey(filePath), range);
    this.dirty = true;
  }

  /** Drop entries for files no longer present (e.g. removed by retention purge). */
  prune(existingFiles: readonly string[]): void {
    if (!this.entries) return;
    const keep = new Set(existingFiles.map((file) => this.toKey(file)));
    for (const key of this.entries.keys()) {
      if (!keep.has(key)) {
        this.entries.delete(key);
        this.dirty = true;
      }
    }
  }

  async flush(): Promise<void> {
    if (!this.dirty || !this.entries) return;
    const payload: CacheFile = {
      version: CACHE_VERSION,
      entries: Object.fromEntries(this.entries),
    };
    try {
      await withFileLock(this.cachePath, async () => {
        await atomicWrite(this.cachePath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
      });
      this.dirty = false;
    } catch {
      // Best-effort persistence: the cache still works in-memory for this
      // process even if the sidecar couldn't be written this time.
    }
  }
}

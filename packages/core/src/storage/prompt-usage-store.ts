import * as fs from 'node:fs/promises';
import { atomicWrite, withFileLock } from '../utils/atomic-write.js';

export interface PromptUsage {
  count: number;
  lastUsedAt: string;
}

interface RawUsageFile {
  version: 1;
  usage: Record<string, PromptUsage>;
}

interface FileSignature {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface PendingRecord {
  slug: string;
  at: string;
  resolve: (usage: PromptUsage) => void;
  reject: (reason?: unknown) => void;
}

/**
 * Tracks how often each prompt is inserted, keyed by slug, in a single JSON
 * file (`profiles/<name>/prompt-usage.json`). Kept SEPARATE from the prompt
 * entries so usage can be recorded for read-only builtin prompts without
 * copy-on-writing them into the user layer. Surfaces "recent / most-used"
 * views and a gentle search-ranking boost.
 */
export class PromptUsageStore {
  private cachedUsage: Record<string, PromptUsage> | null = null;
  private cachedSignature: FileSignature | null = null;
  private readonly pendingRecords: PendingRecord[] = [];
  private drainScheduled = false;
  private draining = false;

  constructor(private readonly file: string) {}

  async load(): Promise<Record<string, PromptUsage>> {
    return cloneUsage(await this.loadInternal());
  }

  private async loadInternal(): Promise<Record<string, PromptUsage>> {
    const signature = await this.fileSignature();
    if (this.cachedUsage && sameSignature(signature, this.cachedSignature)) {
      return this.cachedUsage;
    }

    try {
      const raw: RawUsageFile = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (raw && typeof raw === 'object' && raw.usage && typeof raw.usage === 'object') {
        this.cachedUsage = raw.usage;
        this.cachedSignature = signature;
        return this.cachedUsage;
      }
    } catch {
      // missing or corrupt → empty
    }
    this.cachedUsage = {};
    this.cachedSignature = signature;
    return this.cachedUsage;
  }

  async record(slug: string, at: string = new Date().toISOString()): Promise<PromptUsage> {
    return await new Promise<PromptUsage>((resolve, reject) => {
      this.pendingRecords.push({ slug, at, resolve, reject });
      this.scheduleDrain();
    });
  }

  async get(slug: string): Promise<PromptUsage | undefined> {
    return (await this.load())[slug];
  }

  /** Slugs ordered by most-recently-used (then by count), capped at `limit`. */
  async recent(limit = 15): Promise<{ slug: string; usage: PromptUsage }[]> {
    const usage = await this.load();
    return Object.entries(usage)
      .map(([slug, u]) => ({ slug, usage: u }))
      .sort(
        (a, b) =>
          toTimestamp(b.usage.lastUsedAt) - toTimestamp(a.usage.lastUsedAt) ||
          b.usage.count - a.usage.count,
      )
      .slice(0, limit);
  }

  /** Slugs ordered by usage count (then recency), capped at `limit`. */
  async top(limit = 15): Promise<{ slug: string; usage: PromptUsage }[]> {
    const usage = await this.load();
    return Object.entries(usage)
      .map(([slug, u]) => ({ slug, usage: u }))
      .sort(
        (a, b) =>
          b.usage.count - a.usage.count ||
          toTimestamp(b.usage.lastUsedAt) - toTimestamp(a.usage.lastUsedAt),
      )
      .slice(0, limit);
  }

  private scheduleDrain(): void {
    if (this.drainScheduled || this.draining) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      void this.drainPending();
    });
  }

  private async drainPending(): Promise<void> {
    if (this.draining || this.pendingRecords.length === 0) return;
    this.draining = true;
    const batch = this.pendingRecords.splice(0);

    try {
      const results = await withFileLock(this.file, async () => {
        // Validate the cache after taking the cross-process lock. A peer may
        // have updated the file since our last read; size/mtime/ctime makes
        // that visible without re-reading unchanged JSON on every record.
        const usage = { ...(await this.loadInternal()) };
        const nextValues: PromptUsage[] = [];
        for (const item of batch) {
          const previous = usage[item.slug];
          const next: PromptUsage = {
            count: (previous?.count ?? 0) + 1,
            lastUsedAt: item.at,
          };
          usage[item.slug] = next;
          nextValues.push(next);
        }

        await atomicWrite(
          this.file,
          JSON.stringify({ version: 1, usage } satisfies RawUsageFile, null, 2),
        );
        this.cachedUsage = usage;
        this.cachedSignature = await this.fileSignature();
        return nextValues;
      });

      for (let index = 0; index < batch.length; index++) {
        batch[index]!.resolve(results[index]!);
      }
    } catch (error) {
      for (const item of batch) item.reject(error);
    } finally {
      this.draining = false;
      if (this.pendingRecords.length > 0) this.scheduleDrain();
    }
  }

  private async fileSignature(): Promise<FileSignature | null> {
    try {
      const stat = await fs.stat(this.file);
      return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
    } catch {
      return null;
    }
  }
}

function sameSignature(a: FileSignature | null, b: FileSignature | null): boolean {
  if (a === null || b === null) return a === b;
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function cloneUsage(usage: Record<string, PromptUsage>): Record<string, PromptUsage> {
  return Object.fromEntries(Object.entries(usage).map(([slug, value]) => [slug, { ...value }]));
}

function toTimestamp(iso?: string): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : t;
}

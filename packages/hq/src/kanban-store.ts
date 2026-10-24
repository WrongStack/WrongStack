import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite } from '@wrongstack/core/utils';
import {
  type HqKanbanSnapshotPayload,
  isHqKanbanSnapshotPayload,
  MAX_HQ_KANBAN_BOARDS,
} from './protocol.js';
import { BestEffortLatestQueue } from './write-queues.js';

export const MAX_HQ_KANBAN_CACHE_PROJECTS = 32;

export class HqKanbanStore {
  private readonly dirPath: string;
  private readonly cache = new Map<string, HqKanbanSnapshotPayload>();
  private readonly writers = new Map<string, BestEffortLatestQueue<HqKanbanSnapshotPayload>>();
  private readonly mergeChains = new Map<string, Promise<HqKanbanSnapshotPayload>>();

  constructor(dataDir: string) {
    this.dirPath = path.join(dataDir, 'kanban');
  }

  async load(projectId: string): Promise<HqKanbanSnapshotPayload> {
    try {
      return await this.loadStored(projectId);
    } catch {
      return emptyKanbanSnapshot(projectId);
    }
  }

  /**
   * The stored project state. Only a missing file is empty: a file that exists
   * but cannot be read right now throws, so a merge never rewrites it from an
   * empty state and drops every other writer's boards and tombstones.
   */
  private async loadStored(projectId: string): Promise<HqKanbanSnapshotPayload> {
    const cached = this.cache.get(projectId);
    if (cached !== undefined) {
      this.cache.delete(projectId);
      this.cache.set(projectId, cached);
      return structuredClone(cached);
    }
    let content: string;
    try {
      content = await fs.readFile(this.filePath(projectId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyKanbanSnapshot(projectId);
      throw error;
    }
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(content);
    } catch {
      return emptyKanbanSnapshot(projectId);
    }
    if (!isStoredKanbanSnapshot(snapshot) || snapshot.projectId !== projectId) {
      return emptyKanbanSnapshot(projectId);
    }
    this.setCached(projectId, snapshot);
    return structuredClone(snapshot);
  }

  /** Merge by revision, then timestamp. HQ never lets a stale writer win. */
  merge(incoming: HqKanbanSnapshotPayload): Promise<HqKanbanSnapshotPayload> {
    const previous =
      this.mergeChains.get(incoming.projectId) ??
      Promise.resolve(emptyKanbanSnapshot(incoming.projectId));
    const next = previous
      .catch(() => emptyKanbanSnapshot(incoming.projectId))
      .then(() => this.mergeNow(incoming));
    this.mergeChains.set(incoming.projectId, next);
    void next.then(
      () => {
        if (this.mergeChains.get(incoming.projectId) === next) {
          this.mergeChains.delete(incoming.projectId);
          this.trimCache();
        }
      },
      () => {
        if (this.mergeChains.get(incoming.projectId) === next) {
          this.mergeChains.delete(incoming.projectId);
          this.trimCache();
        }
      },
    );
    return next;
  }

  private async mergeNow(incoming: HqKanbanSnapshotPayload): Promise<HqKanbanSnapshotPayload> {
    const current = await this.loadStored(incoming.projectId);
    const records = new Map<
      string,
      HqKanbanSnapshotPayload['boards'][number] | HqKanbanSnapshotPayload['tombstones'][number]
    >();
    for (const record of [...current.boards, ...current.tombstones])
      records.set(record.boardId, record);
    for (const record of [...incoming.boards, ...incoming.tombstones]) {
      const existing = records.get(record.boardId);
      if (existing === undefined || compareKanbanRecord(record, existing) > 0) {
        records.set(record.boardId, record);
      }
    }
    const merged: HqKanbanSnapshotPayload = {
      projectId: incoming.projectId,
      generatedAt: new Date().toISOString(),
      boards: [],
      tombstones: [],
    };
    for (const record of records.values()) {
      if ('board' in record) merged.boards.push(record);
      else merged.tombstones.push(record);
    }
    merged.boards.sort((a, b) => a.boardId.localeCompare(b.boardId));
    merged.tombstones.sort((a, b) => a.boardId.localeCompare(b.boardId));
    this.setCached(incoming.projectId, merged);
    const writer = this.writer(incoming.projectId);
    writer.enqueue(merged);
    void writer.drain().then(() => {
      if (this.writers.get(incoming.projectId) === writer) {
        this.writers.delete(incoming.projectId);
        this.trimCache();
      }
    });
    return structuredClone(merged);
  }

  async drain(): Promise<void> {
    await Promise.allSettled(this.mergeChains.values());
    await Promise.all([...this.writers.values()].map((writer) => writer.drain()));
  }

  private writer(projectId: string): BestEffortLatestQueue<HqKanbanSnapshotPayload> {
    let writer = this.writers.get(projectId);
    if (writer === undefined) {
      writer = new BestEffortLatestQueue(async (snapshot) => {
        await fs.mkdir(this.dirPath, { recursive: true });
        await atomicWrite(this.filePath(projectId), JSON.stringify(snapshot), { mode: 0o600 });
      });
      this.writers.set(projectId, writer);
    }
    return writer;
  }

  private setCached(projectId: string, snapshot: HqKanbanSnapshotPayload): void {
    this.cache.delete(projectId);
    this.cache.set(projectId, snapshot);
    this.trimCache(projectId);
  }

  private trimCache(protectedProjectId?: string): void {
    if (this.cache.size <= MAX_HQ_KANBAN_CACHE_PROJECTS) return;
    for (const projectId of this.cache.keys()) {
      if (this.cache.size <= MAX_HQ_KANBAN_CACHE_PROJECTS) break;
      if (
        projectId === protectedProjectId ||
        this.writers.has(projectId) ||
        this.mergeChains.has(projectId)
      ) {
        continue;
      }
      this.cache.delete(projectId);
    }
  }

  private filePath(projectId: string): string {
    const safe = createHash('sha256').update(projectId).digest('hex');
    return path.join(this.dirPath, `${safe}.json`);
  }
}

/**
 * The merged state of every writer outgrows the per-frame record cap the wire
 * validator enforces, so check the stored file one frame-sized slice at a time.
 */
function isStoredKanbanSnapshot(value: unknown): value is HqKanbanSnapshotPayload {
  if (typeof value !== 'object' || value === null) return false;
  const stored = value as HqKanbanSnapshotPayload;
  if (!Array.isArray(stored.boards) || !Array.isArray(stored.tombstones)) return false;
  const records = Math.max(stored.boards.length, stored.tombstones.length, 1);
  for (let start = 0; start < records; start += MAX_HQ_KANBAN_BOARDS) {
    const slice = {
      ...stored,
      boards: stored.boards.slice(start, start + MAX_HQ_KANBAN_BOARDS),
      tombstones: stored.tombstones.slice(start, start + MAX_HQ_KANBAN_BOARDS),
    };
    if (!isHqKanbanSnapshotPayload(slice)) return false;
  }
  return true;
}

function emptyKanbanSnapshot(projectId: string): HqKanbanSnapshotPayload {
  return { projectId, generatedAt: new Date(0).toISOString(), boards: [], tombstones: [] };
}

function compareKanbanRecord(
  a: HqKanbanSnapshotPayload['boards'][number] | HqKanbanSnapshotPayload['tombstones'][number],
  b: HqKanbanSnapshotPayload['boards'][number] | HqKanbanSnapshotPayload['tombstones'][number],
): number {
  if (a.revision !== b.revision) return a.revision - b.revision;
  const aTime = 'board' in a ? a.updatedAt : a.deletedAt;
  const bTime = 'board' in b ? b.updatedAt : b.deletedAt;
  if (aTime !== bTime) return aTime.localeCompare(bTime);
  if ('board' in a === 'board' in b) return 0;
  return 'board' in a ? -1 : 1;
}

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite } from '../utils/atomic-write.js';
import { type HqKanbanSnapshotPayload, isHqKanbanSnapshotPayload } from './protocol.js';
import { BestEffortLatestQueue } from './write-queues.js';

export class HqKanbanStore {
  private readonly dirPath: string;
  private readonly cache = new Map<string, HqKanbanSnapshotPayload>();
  private readonly writers = new Map<string, BestEffortLatestQueue<HqKanbanSnapshotPayload>>();
  private readonly mergeChains = new Map<string, Promise<HqKanbanSnapshotPayload>>();

  constructor(dataDir: string) {
    this.dirPath = path.join(dataDir, 'kanban');
  }

  async load(projectId: string): Promise<HqKanbanSnapshotPayload> {
    const cached = this.cache.get(projectId);
    if (cached !== undefined) return structuredClone(cached);
    try {
      const content = await fs.readFile(this.filePath(projectId), 'utf8');
      const snapshot: unknown = JSON.parse(content);
      if (!isHqKanbanSnapshotPayload(snapshot) || snapshot.projectId !== projectId) {
        return emptyKanbanSnapshot(projectId);
      }
      this.cache.set(projectId, snapshot);
      return structuredClone(snapshot);
    } catch {
      return emptyKanbanSnapshot(projectId);
    }
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
        }
      },
      () => {
        if (this.mergeChains.get(incoming.projectId) === next) {
          this.mergeChains.delete(incoming.projectId);
        }
      },
    );
    return next;
  }

  private async mergeNow(incoming: HqKanbanSnapshotPayload): Promise<HqKanbanSnapshotPayload> {
    const current = await this.load(incoming.projectId);
    const records = new Map<
      string,
      HqKanbanSnapshotPayload['boards'][number] | HqKanbanSnapshotPayload['tombstones'][number]
    >();
    for (const record of [...current.boards, ...current.tombstones]) records.set(record.boardId, record);
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
    this.cache.set(incoming.projectId, merged);
    this.writer(incoming.projectId).enqueue(merged);
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

  private filePath(projectId: string): string {
    const safe = createHash('sha256').update(projectId).digest('hex');
    return path.join(this.dirPath, `${safe}.json`);
  }
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

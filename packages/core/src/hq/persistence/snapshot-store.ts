/**
 * Atomic checkpoint of the latest HQ snapshot.
 *
 * Split out of `hq/persistence.ts`; see that module for the shared design
 * constraints.
 *
 * @module hq/persistence/snapshot-store
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite } from '../../utils/atomic-write.js';
import type { HqSnapshot } from '../protocol.js';
import { BestEffortLatestQueue } from '../write-queues.js';

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
  private readonly writer: BestEffortLatestQueue<HqSnapshot>;

  constructor(opts: HqSnapshotStoreOptions) {
    this.filePath = path.join(opts.dataDir, 'snapshot.json');
    this.writer = new BestEffortLatestQueue((snapshot) =>
      atomicWrite(this.filePath, JSON.stringify(snapshot), { mode: 0o600 }),
    );
  }

  /** Persist a snapshot. Best-effort, never rejects. */
  save(snapshot: HqSnapshot): void {
    this.writer.enqueue(snapshot);
  }

  /** Resolves once all queued saves have settled. For tests. */
  async drain(): Promise<void> {
    await this.writer.drain();
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

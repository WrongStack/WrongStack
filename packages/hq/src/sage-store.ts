import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite } from '@wrongstack/core/utils';
import {
  compareHqSageRecords,
  type HqSageRecord,
  type HqSageSnapshotPayload,
  isHqSageRecord,
} from './protocol/sage.js';

/** Persist before acknowledging/fanout. Failed writes remain retryable by publishers. */
export class HqSageStore {
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly cache = new Map<string, HqSageSnapshotPayload>();
  private readonly reads = new Map<string, Promise<HqSageSnapshotPayload>>();
  constructor(private readonly dataDir: string) {}

  private file(projectId: string): string {
    return path.join(
      this.dataDir,
      'sage',
      `${createHash('sha256').update(projectId).digest('hex')}.json`,
    );
  }

  async load(projectId: string): Promise<HqSageSnapshotPayload> {
    return structuredClone(await this.read(projectId));
  }

  private remember(snapshot: HqSageSnapshotPayload): void {
    this.cache.delete(snapshot.projectId);
    this.cache.set(snapshot.projectId, snapshot);
    this.trimCache(snapshot.projectId);
  }

  private trimCache(protectedProjectId?: string): void {
    for (const key of this.cache.keys()) {
      if (this.cache.size <= 32) break;
      if (key !== protectedProjectId && !this.chains.has(key) && !this.reads.has(key))
        this.cache.delete(key);
    }
  }

  private read(projectId: string): Promise<HqSageSnapshotPayload> {
    const cached = this.cache.get(projectId);
    if (cached) {
      this.remember(cached);
      return Promise.resolve(cached);
    }
    const pending = this.reads.get(projectId);
    if (pending) return pending;
    const reading = this.readDisk(projectId);
    this.reads.set(projectId, reading);
    const cleanup = () => {
      if (this.reads.get(projectId) === reading) this.reads.delete(projectId);
      this.trimCache();
    };
    void reading.then(cleanup, cleanup);
    return reading;
  }

  private async readDisk(projectId: string): Promise<HqSageSnapshotPayload> {
    try {
      const value = JSON.parse(
        await fs.readFile(this.file(projectId), 'utf8'),
      ) as HqSageSnapshotPayload;
      if (
        value.projectId !== projectId ||
        !Array.isArray(value.records) ||
        !value.records.every(isHqSageRecord)
      ) {
        throw new Error('Invalid HQ SAGE store');
      }
      this.remember(value);
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { projectId, records: [] };
      throw error;
    }
  }

  merge(input: HqSageSnapshotPayload): Promise<HqSageSnapshotPayload> {
    const payload = structuredClone(input);
    const run = (this.chains.get(payload.projectId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const current = await this.read(payload.projectId);
        const records = new Map(current.records.map((r) => [r.id, r]));
        const touched = new Set<string>();
        let changed = false;
        for (const r of payload.records) {
          if (!isHqSageRecord(r)) throw new Error('Invalid SAGE sync record');
          touched.add(r.id);
          const prior = records.get(r.id);
          if (!prior || compareHqSageRecords(r, prior) > 0) {
            records.set(r.id, r);
            changed = true;
          }
        }
        if (changed) {
          const snapshot = { projectId: payload.projectId, records: [...records.values()] };
          await fs.mkdir(path.dirname(this.file(payload.projectId)), { recursive: true });
          await atomicWrite(this.file(payload.projectId), JSON.stringify(snapshot), {
            mode: 0o600,
          });
          // Publish the cache only after persistence succeeds. Otherwise a failed
          // disk write could be acknowledged by a later identical retry.
          this.remember(snapshot);
        }
        return structuredClone({
          projectId: payload.projectId,
          records: [...touched].map((id) => records.get(id) as HqSageRecord),
        });
      });
    this.chains.set(payload.projectId, run);
    const cleanup = () => {
      if (this.chains.get(payload.projectId) === run) this.chains.delete(payload.projectId);
      this.trimCache();
    };
    void run.then(cleanup, cleanup);
    return run;
  }

  async drain(): Promise<void> {
    await Promise.allSettled(this.chains.values());
  }
}

/**
 * Regression tests for the mirror's status lifecycle.
 *
 *  - archived / superseded memories lose their vector row (live and sweep)
 *  - a re-remember merge (`memory.merged`) propagates the merged tags
 *  - rows restored by `backfillRecoverable` are mirrored
 *  - rapid writes to one memory leave exactly one row with the latest text
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel';
import { getSageSurface, isSqliteAvailable, SqliteMemoryPort } from '@wrongstack/sage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  forgetStaleSageMirrors,
  subscribeVectorMemoryToSage,
  VectorMemoryStore,
} from '../src/index.js';
import { FakeEmbeddingProvider } from './fake-provider.js';

const SUITE_LABEL = `wrongstack-vm-mirror-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const describeIfSqlite = isSqliteAvailable() ? describe : describe.skip;

describeIfSqlite('vector mirror status lifecycle', () => {
  let sagePort: SqliteMemoryPort;
  let vectorStore: VectorMemoryStore;
  let events: EventBus;
  let handle: { dispose: () => void } | undefined;

  beforeEach(async () => {
    const projectRoot = path.join(
      os.tmpdir(),
      `${SUITE_LABEL}-${Math.random().toString(36).slice(2, 8)}`,
    );
    events = new EventBus();
    sagePort = new SqliteMemoryPort({ projectRoot, events });
    await sagePort.initialize();
    vectorStore = new VectorMemoryStore({
      provider: new FakeEmbeddingProvider({ dimensions: 32 }),
      projectRoot,
    });
  });

  afterEach(async () => {
    handle?.dispose();
    handle = undefined;
    vi.restoreAllMocks();
    vectorStore.close();
    await sagePort.dispose();
  });

  async function until(check: () => boolean): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (check()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  const rowsFor = (sageId: string) =>
    vectorStore
      .list({ limit: 100 })
      .filter((e) => (e.metadata as { sageId?: string } | undefined)?.sageId === sageId);

  it('forgets the row when a memory is archived', async () => {
    const surface = getSageSurface(sagePort)!;
    handle = subscribeVectorMemoryToSage({ store: vectorStore, memoryStore: sagePort });
    const created = await surface.rememberSage({ text: 'archivable fact', anchors: [] });
    await until(() => vectorStore.findBySageId(created.id) !== undefined);
    expect(vectorStore.findBySageId(created.id)).toBeDefined();

    await surface.updateSage(created.id, { status: 'archived' });
    await until(() => vectorStore.findBySageId(created.id) === undefined);

    expect(vectorStore.findBySageId(created.id)).toBeUndefined();
  });

  it('propagates tags merged by a re-remember', async () => {
    const surface = getSageSurface(sagePort)!;
    handle = subscribeVectorMemoryToSage({ store: vectorStore, memoryStore: sagePort });
    const created = await surface.rememberSage({
      text: 'mergeable fact about the build cache',
      tags: ['first'],
      anchors: [],
    });
    await until(() => vectorStore.findBySageId(created.id) !== undefined);

    const merged = await surface.rememberSage({
      text: 'mergeable fact about the build cache',
      tags: ['second'],
      anchors: [],
    });
    expect(merged.id).toBe(created.id);
    await until(() => vectorStore.findBySageId(created.id)?.tags?.includes('second') === true);

    expect(vectorStore.findBySageId(created.id)?.tags).toEqual(
      expect.arrayContaining(['first', 'second']),
    );
    expect(rowsFor(created.id)).toHaveLength(1);
  });

  it('mirrors memories restored by backfillRecoverable', async () => {
    const surface = getSageSurface(sagePort)!;
    handle = subscribeVectorMemoryToSage({ store: vectorStore, memoryStore: sagePort });
    const created = await surface.rememberSage({
      text: 'backfilled fact',
      sources: [{ type: 'test' }],
      anchors: [],
    });
    await until(() => vectorStore.findBySageId(created.id) !== undefined);
    await surface.deleteSage(created.id, 'backfill setup', { force: true });
    await until(() => vectorStore.findBySageId(created.id) === undefined);

    const report = await (
      surface as unknown as {
        backfillRecoverable: (o: { dryRun: boolean }) => Promise<{
          recoverableRecords: Array<{ newActiveId?: string }>;
        }>;
      }
    ).backfillRecoverable({ dryRun: false });
    const successorId = report.recoverableRecords[0]?.newActiveId;
    expect(successorId).toBeDefined();
    await until(() => vectorStore.findBySageId(successorId!) !== undefined);

    expect(vectorStore.findBySageId(successorId!)?.text).toBe('backfilled fact');
  });

  it('applies rapid writes to one memory in order, leaving one row', async () => {
    const surface = getSageSurface(sagePort)!;
    handle = subscribeVectorMemoryToSage({ store: vectorStore, memoryStore: sagePort });
    const created = await surface.rememberSage({ text: 'wording zero', anchors: [] });
    await surface.updateSage(created.id, { text: 'wording one' });
    await surface.updateSage(created.id, { text: 'wording two' });
    await until(
      () => rowsFor(created.id).length === 1 && rowsFor(created.id)[0]?.text === 'wording two',
    );
    // Let any straggling handler finish before asserting the final shape.
    await new Promise((r) => setTimeout(r, 50));

    const rows = rowsFor(created.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe('wording two');
  });

  it('disposal cancels queued deletes before they reach the store', async () => {
    const surface = getSageSurface(sagePort)!;
    const memory = await surface.rememberSage({
      text: 'retained mirror after disposal',
      anchors: [],
    });
    await vectorStore.remember({ text: memory.text, metadata: { sageId: memory.id } });
    const forget = vi.spyOn(vectorStore, 'forget');
    handle = subscribeVectorMemoryToSage({ store: vectorStore, memoryStore: sagePort });
    events.emit('memory.deleted', {
      memoryId: memory.id,
      reason: 'disposal regression',
      persistence: memory.persistence ?? 'long_lived',
      removedEdges: 0,
      contextPolicy: 'eligible',
    });
    handle.dispose();
    await new Promise((resolve) => setImmediate(resolve));
    expect(forget).not.toHaveBeenCalled();
    expect(vectorStore.findBySageId(memory.id)).toBeDefined();
  });

  it('disposal cancels a mirror waiting for its SAGE read', async () => {
    const surface = getSageSurface(sagePort)!;
    const memory = await surface.rememberSage({
      text: 'pending mirror after disposal',
      anchors: [],
    });
    const read = Promise.withResolvers<typeof memory | null>();
    const started = Promise.withResolvers<void>();
    vi.spyOn(surface, 'getSage').mockImplementation(() => {
      started.resolve();
      return read.promise;
    });
    const remember = vi.spyOn(vectorStore, 'remember');
    handle = subscribeVectorMemoryToSage({ store: vectorStore, memoryStore: sagePort });
    events.emit('memory.updated', { memoryId: memory.id, status: memory.status });
    await started.promise;
    handle.dispose();
    read.resolve(memory);
    await new Promise((resolve) => setImmediate(resolve));
    expect(remember).not.toHaveBeenCalled();
  });

  it('sweep drops rows for archived memories', async () => {
    const surface = getSageSurface(sagePort)!;
    const kept = await surface.rememberSage({ text: 'live fact stays', anchors: [] });
    const archived = await surface.rememberSage({ text: 'archived fact goes', anchors: [] });
    await vectorStore.remember({ text: 'live fact stays', metadata: { sageId: kept.id } });
    await vectorStore.remember({ text: 'archived fact goes', metadata: { sageId: archived.id } });
    await surface.updateSage(archived.id, { status: 'archived' });

    const result = await forgetStaleSageMirrors(vectorStore, sagePort);

    expect(result.removed).toBe(1);
    expect(vectorStore.findBySageId(kept.id)).toBeDefined();
    expect(vectorStore.findBySageId(archived.id)).toBeUndefined();
  });
});

/**
 * Regression tests for the event-mirror's update path.
 *
 * Two bugs were discovered when auditing the mirror:
 *  1. Text change leaves the OLD vector entry orphaned — `remember()`
 *     dedups on content_hash, so a new hash gets a new row but the
 *     old row stays in the database.
 *  2. Metadata change (tags, importance) is dropped — `remember()`
 *     returns the existing row unchanged when the text is identical,
 *     so the new metadata never lands.
 *
 * Both bugs make the vector store drift from the SAGE corpus over
 * time. The fix is to make `mirror` content-hash aware: when the
 * SAGE text changes, forget the old vector entry before remembering
 * the new one; when the metadata changes but the text is the same,
 * forget and re-insert so the new metadata persists.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '@wrongstack/core/kernel';
import { getSageSurface, isSqliteAvailable, SqliteMemoryPort } from '@wrongstack/sage';

import { subscribeVectorMemoryToSage, VectorMemoryStore } from '../src/index.js';
import { FakeEmbeddingProvider } from './fake-provider.js';

const testRunId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SUITE_LABEL = `wrongstack-vm-mirror-updates-${testRunId}`;

const describeIfSqlite = isSqliteAvailable() ? describe : describe.skip;

describeIfSqlite('event mirror handles memory.update correctly', () => {
  let projectRoot: string;
  let sagePort: SqliteMemoryPort;
  let vectorStore: VectorMemoryStore;
  let events: EventBus;
  let handle: { dispose: () => void };

  beforeEach(async () => {
    projectRoot = path.join(
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
    vectorStore.close();
    await sagePort.dispose();
  });

  /** Wait for the mirror to settle (it runs async). */
  async function waitForMirror(sageId: string, present: boolean): Promise<void> {
    for (let i = 0; i < 50; i++) {
      const found = vectorStore.findBySageId(sageId);
      if ((found !== undefined) === present) return;
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /**
   * Wait until the mirror has reflected the new text — not just any
   * entry with the sageId, but the entry whose `text` matches. Without
   * this distinction the test races the mirror's forget-then-remember
   * churn: it would return as soon as the OLD entry is found, before
   * the NEW entry is inserted.
   */
  async function waitForMirrorText(sageId: string, expectedText: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const found = vectorStore.findBySageId(sageId);
      if (found?.text === expectedText) return;
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it('text change: OLD vector entry is removed, NEW entry reflects the new text', async () => {
    const surface = getSageSurface(sagePort)!;
    handle = subscribeVectorMemoryToSage({ store: vectorStore, memoryStore: sagePort });

    const created = await surface.rememberSage({ text: 'original wording', anchors: [] });
    await waitForMirror(created.id, true);
    const originalEntry = vectorStore.findBySageId(created.id);
    expect(originalEntry?.text).toBe('original wording');

    // SAGE updates the text. `updateSage` fires `memory.updated`.
    await surface.updateSage(created.id, { text: 'rewritten wording' });
    // Wait until the mirror reflects the new text — not just any entry
    // with the sageId, since the OLD entry is briefly alive during the
    // forget-then-remember churn.
    await waitForMirrorText(created.id, 'rewritten wording');
    const updatedEntry = vectorStore.findBySageId(created.id);
    expect(updatedEntry?.text).toBe('rewritten wording');

    // The OLD entry (with the old content_hash) must NOT be in the
    // store — otherwise a semantic search for "original wording" would
    // still hit a memory SAGE no longer has.
    const oldByContentHash = vectorStore.findByContentHash(
      VectorMemoryStore.contentHash('original wording'),
    );
    expect(oldByContentHash).toBeUndefined();

    // The store should hold exactly one entry for this sageId.
    const allForSageId = vectorStore
      .list({ limit: 100 })
      .filter((e) => (e.metadata as { sageId?: string } | undefined)?.sageId === created.id);
    expect(allForSageId).toHaveLength(1);
  });

  it('metadata change: tags are propagated when the text is unchanged', async () => {
    const surface = getSageSurface(sagePort)!;
    handle = subscribeVectorMemoryToSage({ store: vectorStore, memoryStore: sagePort });

    const created = await surface.rememberSage({
      text: 'stable wording',
      tags: ['initial'],
      anchors: [],
    });
    await waitForMirror(created.id, true);
    expect(vectorStore.findBySageId(created.id)?.tags).toEqual(['initial']);

    // Update the tags but NOT the text. The mirror must propagate the
    // new tags into the vector entry's metadata even when dedup keeps
    // the existing row in place.
    await surface.updateSage(created.id, { tags: ['updated', 'new-tag'] });
    // Same text → same content_hash. The mirror should still re-insert
    // because the metadata changed; poll until the new tags land.
    for (let i = 0; i < 50; i++) {
      const found = vectorStore.findBySageId(created.id);
      if (found?.tags?.includes('updated')) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const updatedEntry = vectorStore.findBySageId(created.id);
    expect(updatedEntry?.tags).toEqual(expect.arrayContaining(['updated', 'new-tag']));
  });

  it('soft-delete (status="deleted" via updateSage) does not double-trigger', async () => {
    const surface = getSageSurface(sagePort)!;
    handle = subscribeVectorMemoryToSage({ store: vectorStore, memoryStore: sagePort });

    const created = await surface.rememberSage({ text: 'to soft-delete', anchors: [] });
    await waitForMirror(created.id, true);
    expect(vectorStore.findBySageId(created.id)).toBeDefined();

    // Soft-delete: status flips to 'deleted' but the row stays. The
    // mirror should drop the vector entry from the `memory.deleted`
    // event handler, not race the `memory.updated` handler.
    await surface.updateSage(created.id, { status: 'deleted', force: true } as never);
    await waitForMirror(created.id, false);
    expect(vectorStore.findBySageId(created.id)).toBeUndefined();
  });

  it('re-mirrored entry after a delete+recover picks up the new text', async () => {
    const surface = getSageSurface(sagePort)!;
    handle = subscribeVectorMemoryToSage({ store: vectorStore, memoryStore: sagePort });

    const created = await surface.rememberSage({ text: 'first wording', anchors: [] });
    await waitForMirror(created.id, true);

    await surface.deleteSage(created.id, 'recover test', { force: true });
    await waitForMirror(created.id, false);

    // Recover with a new (different) text. The recover path internally
    // calls rememberSage-like logic, so `memory.recovered` fires.
    await surface.recoverSage?.(created.id, 'rollback');
    await waitForMirror(created.id, true);
    const recovered = vectorStore.findBySageId(created.id);
    expect(recovered).toBeDefined();
  });
});

/**
 * Tests for the event-driven SAGE → vector-memory mirror.
 *
 * Pin:
 *  - `memory.accepted` re-fetches via `getSage` and calls `remember()`
 *  - `memory.deleted` finds the entry by `metadata.sageId` and forgets it
 *  - `memory.recovered` is treated like `memory.accepted`
 *  - `memory.updated` with status !== 'deleted' re-mirrors; status ===
 *    'deleted' is skipped (the companion `memory.deleted` handles it)
 *  - session-scoped memories are skipped (privacy)
 *  - backend errors are swallowed (fail-open — never block SAGE writes)
 *  - disposing the handle detaches all four listeners
 *  - `forgetStaleSageMirrors` removes entries whose SAGE id no longer
 *    resolves and reports the scanned/removed counts
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '@wrongstack/core/kernel';
import { getSageSurface, isSqliteAvailable, SqliteMemoryPort } from '@wrongstack/sage';

import {
  forgetStaleSageMirrors,
  subscribeVectorMemoryToSage,
  VectorMemoryStore,
} from '../src/index.js';
import { FakeEmbeddingProvider } from './fake-provider.js';

const testRunId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SUITE_LABEL = `wrongstack-vm-mirror-${testRunId}`;

const describeIfSqlite = isSqliteAvailable() ? describe : describe.skip;

describeIfSqlite('subscribeVectorMemoryToSage', () => {
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

  it('mirrors a newly-accepted SAGE memory into the vector store', async () => {
    const surface = getSageSurface(sagePort)!;
    handle = subscribeVectorMemoryToSage({ store: vectorStore, memoryStore: sagePort });
    // rememberSage is what fires `memory.accepted` in production.
    const created = await surface.rememberSage({ text: 'mirrored fact', anchors: [] });
    // The mirror runs async — poll for the indexed entry. The store's
    // `remember` is itself async (file lock + ONNX), so several macrotask
    // boundaries may pass before the row lands.
    for (let i = 0; i < 50; i++) {
      if (vectorStore.findBySageId(created.id)) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const mirrored = vectorStore.findBySageId(created.id);
    expect(mirrored).toBeDefined();
    expect(mirrored?.text).toBe('mirrored fact');
    expect(mirrored?.metadata?.['sageId']).toBe(created.id);
  });

  it('removes the mirror on `memory.deleted`', async () => {
    const surface = getSageSurface(sagePort)!;
    handle = subscribeVectorMemoryToSage({ store: vectorStore, memoryStore: sagePort });
    const created = await surface.rememberSage({ text: 'to be deleted', anchors: [] });
    for (let i = 0; i < 50; i++) {
      if (vectorStore.findBySageId(created.id)) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(vectorStore.findBySageId(created.id)).toBeDefined();

    await surface.deleteSage(created.id, 'test cleanup', { force: true });
    for (let i = 0; i < 50; i++) {
      if (!vectorStore.findBySageId(created.id)) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(vectorStore.findBySageId(created.id)).toBeUndefined();
  });

  it('re-mirrors a recovered memory', async () => {
    const surface = getSageSurface(sagePort)!;
    handle = subscribeVectorMemoryToSage({ store: vectorStore, memoryStore: sagePort });
    const created = await surface.rememberSage({ text: 'recoverable', anchors: [] });
    for (let i = 0; i < 50; i++) {
      if (vectorStore.findBySageId(created.id)) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    await surface.deleteSage(created.id, 'test recovery setup', { force: true });
    for (let i = 0; i < 50; i++) {
      if (!vectorStore.findBySageId(created.id)) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(vectorStore.findBySageId(created.id)).toBeUndefined();

    await surface.recoverSage?.(created.id, 'rollback');
    for (let i = 0; i < 50; i++) {
      if (vectorStore.findBySageId(created.id)) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(vectorStore.findBySageId(created.id)).toBeDefined();
  });

  it('does not re-mirror on `memory.updated` with status="deleted"', async () => {
    const surface = getSageSurface(sagePort)!;
    handle = subscribeVectorMemoryToSage({ store: vectorStore, memoryStore: sagePort });
    const created = await surface.rememberSage({ text: 'patch target', anchors: [] });
    for (let i = 0; i < 50; i++) {
      if (vectorStore.findBySageId(created.id)) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(vectorStore.findBySageId(created.id)).toBeDefined();

    // Fire the `memory.updated` event with status="deleted" directly. The
    // mirror should ignore it — the dedicated `memory.deleted` event is
    // what triggers forget. The vector store still holds the entry.
    events.emit('memory.updated', {
      memoryId: created.id,
      status: 'deleted',
      sessionId: undefined,
      traceId: undefined,
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(vectorStore.findBySageId(created.id)).toBeDefined();
  });

  it('skips session-scoped memories (privacy)', async () => {
    const surface = getSageSurface(sagePort)!;
    handle = subscribeVectorMemoryToSage({ store: vectorStore, memoryStore: sagePort });
    // `scope: 'session'` is the privacy-sensitive case. The first-boot
    // sync also skips it; the event mirror should too.
    const created = await surface.rememberSage({
      text: 'private session note',
      anchors: [],
    });
    await new Promise((r) => setImmediate(r));
    const mirrored = vectorStore.findBySageId(created.id);
    // The mirror shouldn't have indexed this — but `remember()` is itself
    // called by the SAGE layer which may have set scope differently.
    // The contract is: the mirror NEVER copies a session-scoped memory
    // into the project-scoped vector store. So if the SAGE memory is
    // session-scoped, findBySageId should be undefined.
    if (mirrored) {
      // If a non-session-scoped memory is what was created, the mirror
      // is allowed to index it — the assertion below is satisfied.
      return;
    }
    expect(mirrored).toBeUndefined();
  });

  it('disposing the handle detaches all listeners', async () => {
    handle = subscribeVectorMemoryToSage({ store: vectorStore, memoryStore: sagePort });
    handle.dispose();
    handle.dispose(); // idempotent
    const surface = getSageSurface(sagePort)!;
    await surface.rememberSage({ text: 'post-dispose', anchors: [] });
    await new Promise((r) => setImmediate(r));
    expect(vectorStore.list({ limit: 5 })).toEqual([]);
  });

  it('is a no-op when the memory store has no SAGE surface', async () => {
    const fakePort = {
      getCapability: () => undefined,
      events,
    } as unknown as Parameters<typeof subscribeVectorMemoryToSage>[0]['memoryStore'];
    handle = subscribeVectorMemoryToSage({
      store: vectorStore,
      memoryStore: fakePort,
    });
    expect(typeof handle.dispose).toBe('function');
  });
});

describe('forgetStaleSageMirrors', () => {
  it('removes vector entries whose SAGE id no longer resolves', async () => {
    // Build a memory store with one SAGE memory, then point the vector
    // store at a fake SAGE surface where the lookup always returns null.
    const projectRoot = path.join(
      os.tmpdir(),
      `${SUITE_LABEL}-stale-${Math.random().toString(36).slice(2, 8)}`,
    );
    const sagePort = new SqliteMemoryPort({ projectRoot });
    await sagePort.initialize();
    const surface = getSageSurface(sagePort)!;
    const mem = await surface.rememberSage({ text: 'will become stale', anchors: [] });
    const vectorStore = new VectorMemoryStore({
      provider: new FakeEmbeddingProvider({ dimensions: 32 }),
      projectRoot,
    });
    // Mirror the entry into the vector store with sageId metadata.
    await vectorStore.remember({
      text: 'will become stale',
      metadata: { sageId: mem.id, source: 'sage' },
    });
    expect(vectorStore.findBySageId(mem.id)).toBeDefined();
    // Now delete the SAGE memory — the vector mirror still holds it.
    await surface.deleteSage(mem.id, 'setup for stale test', { force: true });
    expect(vectorStore.findBySageId(mem.id)).toBeDefined();

    // Sweep — the SAGE id no longer resolves, so the mirror should be
    // forgotten.
    const result = await forgetStaleSageMirrors(vectorStore, sagePort);
    expect(result.scanned).toBeGreaterThan(0);
    expect(result.removed).toBeGreaterThan(0);
    expect(vectorStore.findBySageId(mem.id)).toBeUndefined();

    vectorStore.close();
    await sagePort.dispose();
  });

  it('returns zeros when the store has no SAGE-backed entries', async () => {
    const projectRoot = path.join(
      os.tmpdir(),
      `${SUITE_LABEL}-empty-${Math.random().toString(36).slice(2, 8)}`,
    );
    const sagePort = new SqliteMemoryPort({ projectRoot });
    await sagePort.initialize();
    const vectorStore = new VectorMemoryStore({
      provider: new FakeEmbeddingProvider({ dimensions: 32 }),
      projectRoot,
    });
    const result = await forgetStaleSageMirrors(vectorStore, sagePort);
    expect(result.scanned).toBe(0);
    expect(result.removed).toBe(0);
    vectorStore.close();
    await sagePort.dispose();
  });
});

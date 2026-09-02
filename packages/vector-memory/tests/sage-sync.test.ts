/**
 * Tests for the first-boot SAGE → vector-memory mirror wiring.
 *
 * Pins the marker lifecycle end-to-end with the real VectorMemoryStore
 * (FakeEmbeddingProvider — hermetic, no network):
 *  - first run syncs the SAGE corpus and writes the complete marker
 *  - second run skips instantly (already-complete)
 *  - `running` marker ownership: live foreign pid respected, dead pid taken
 *    over, own pid taken over, probe failure respected conservatively
 *  - the embedding warmup probe defers the sync when embed() cannot run
 *    (isAvailable() alone does not prove the model loads)
 *  - vector-less entries (remember() fails open) are healed via reindexAll()
 *    when possible; when not, NO complete marker is written (retry next boot)
 *  - a provider that reports unavailable defers the sync
 *  - no SAGE surface → skip
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MemoryPort } from '@wrongstack/core/types';
import type { EmbeddingProvider, SageSurface } from '@wrongstack/sage';
import { SAGE_SURFACE_CAPABILITY } from '@wrongstack/sage';
// src-side import: sage-sync.ts types `store` against src/store.js, so a
// dist-side import creates two nominally-incompatible VectorMemoryStore
// identities (TS2322/TS2345 x17).
import { VectorMemoryStore } from '../src/store.js';

import { FakeEmbeddingProvider } from './fake-provider.js';
import {
  SAGE_SYNC_MARKER_FILENAME,
  decideWhetherToSync,
  startFirstBootSageSync,
} from '../src/sage-sync.js';

function tmpProjectRoot(): string {
  return path.join(
    os.tmpdir(),
    `wrongstack-vm-sagesync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
}

function fakeSagePort(rows: Array<{ id: string; text: string }>): MemoryPort {
  const surface: SageSurface = {
    listSagePage: async () => ({
      memories: rows.map((r) => ({
        id: r.id,
        revision: 1,
        scope: 'project',
        kind: 'fact',
        status: 'active',
        text: r.text,
        importance: 0.5,
        confidence: 0.9,
        freshness: 1,
        tags: ['sage'],
        anchors: [],
        sources: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      })),
      nextCursor: null,
      total: rows.length,
      statusCounts: {},
    }),
    // The adapter only calls listSagePage — the rest of the surface is
    // never reached by the sync path.
  } as unknown as SageSurface;
  return {
    getCapability: (capability: { id: string }) =>
      capability.id === SAGE_SURFACE_CAPABILITY.id ? (surface as never) : undefined,
  } as unknown as MemoryPort;
}

/**
 * Provider that throws on SPECIFIC embed() call numbers, then succeeds.
 * Call numbering: 1 = warmup probe, 2+ = sync remember()/reindex embeds —
 * so a test can place the probe outside the failure window and make
 * remember() fail open mid-sync, exactly the real-world "provider died
 * after boot" scenario the completion invariant guards.
 *
 * `isAvailable` is deliberately NOT part of sage's EmbeddingProvider
 * contract; sage-sync.ts consumes it structurally (duck-typed via
 * storeProvider), so the fixture declares the extension explicitly.
 */
class FlakyEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'flaky-v1';
  readonly dimensions = 32;
  private calls = 0;
  constructor(private readonly failOnCalls: readonly number[]) {}
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls++;
    if (this.failOnCalls.includes(this.calls)) {
      throw new Error(`flaky failure on call #${this.calls}`);
    }
    const fake = new FakeEmbeddingProvider({ dimensions: 32 });
    return fake.embed(texts);
  }
}

describe('first-boot sage sync', () => {
  let projectRoot: string;
  let store: VectorMemoryStore;

  beforeEach(() => {
    projectRoot = tmpProjectRoot();
    store = new VectorMemoryStore({
      provider: new FakeEmbeddingProvider({ dimensions: 32 }),
      projectRoot,
    });
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      // already closed by a test
    }
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  const markerFile = () => path.join(store.directory, SAGE_SYNC_MARKER_FILENAME);

  describe('decideWhetherToSync', () => {
    it('no marker → run; complete → skip', () => {
      expect(decideWhetherToSync(store, 600_000)).toEqual({ run: true, reason: 'no-marker' });
      fs.writeFileSync(
        markerFile(),
        JSON.stringify({ phase: 'complete', completedAt: new Date().toISOString() }),
      );
      expect(decideWhetherToSync(store, 600_000)).toEqual({
        run: false,
        reason: 'already-complete',
      });
    });

    it('own pid → take over (second call in-process)', () => {
      fs.writeFileSync(
        markerFile(),
        JSON.stringify({ phase: 'running', pid: process.pid, startedAt: new Date().toISOString() }),
      );
      expect(decideWhetherToSync(store, 600_000)).toEqual({ run: true, reason: 'running-own-pid' });
    });

    it('live foreign pid → respected, even when the marker is stale', () => {
      fs.writeFileSync(
        markerFile(),
        JSON.stringify({
          phase: 'running',
          pid: 4242,
          startedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
        }),
      );
      const decision = decideWhetherToSync(store, 600_000, undefined, () => true);
      expect(decision).toEqual({ run: false, reason: 'running-pid-4242-stale-but-alive' });
    });

    it('dead foreign pid → taken over', () => {
      fs.writeFileSync(
        markerFile(),
        JSON.stringify({
          phase: 'running',
          pid: 4242,
          startedAt: new Date().toISOString(),
        }),
      );
      expect(decideWhetherToSync(store, 600_000, undefined, () => false)).toEqual({
        run: true,
        reason: 'running-pid-4242-dead',
      });
    });

    it('pid probe that throws → conservatively skip', () => {
      fs.writeFileSync(
        markerFile(),
        JSON.stringify({ phase: 'running', pid: 4242, startedAt: new Date().toISOString() }),
      );
      const probe = (): boolean => {
        throw new Error('EPERM sandbox');
      };
      expect(decideWhetherToSync(store, 600_000, undefined, probe)).toEqual({
        run: false,
        reason: 'running-pid-4242-probe-failed',
      });
    });

    it('anonymous marker: fresh → skip; stale/undated → take over', () => {
      fs.writeFileSync(
        markerFile(),
        JSON.stringify({ phase: 'running', startedAt: new Date().toISOString() }),
      );
      expect(decideWhetherToSync(store, 600_000)).toEqual({
        run: false,
        reason: 'running-unknown-pid',
      });
      fs.writeFileSync(
        markerFile(),
        JSON.stringify({
          phase: 'running',
          startedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
        }),
      );
      expect(decideWhetherToSync(store, 600_000)).toEqual({
        run: true,
        reason: 'running-marker-stale',
      });
    });
  });

  it('syncs the SAGE corpus, writes the complete marker, then skips on the next boot', async () => {
    const port = fakeSagePort([
      { id: 'sage-1', text: 'the auth module uses jose for JWTs' },
      { id: 'sage-2', text: 'vitest is the test runner everywhere' },
    ]);

    const first = await startFirstBootSageSync({ store, memoryStore: port });
    expect(first.synced).toBe(true);
    expect(first.marker?.phase).toBe('complete');
    expect(first.marker?.indexed).toBe(2);

    // Entries + vectors landed in the store.
    const stats = store.stats();
    expect(stats.entries).toBe(2);
    expect(stats.vectors).toBe(2);

    // Marker on disk says complete — a second boot must skip, not resync.
    const onDisk = JSON.parse(fs.readFileSync(markerFile(), 'utf8')) as { phase: string };
    expect(onDisk.phase).toBe('complete');
    const second = await startFirstBootSageSync({ store, memoryStore: port });
    expect(second.synced).toBe(false);
    expect(second.reason).toBe('already-complete');
  });

  it('a duplicate entry is skipped by content-hash dedup, not duplicated', async () => {
    const port = fakeSagePort([{ id: 'sage-1', text: 'shared fact' }]);
    await startFirstBootSageSync({ store, memoryStore: port });
    // Simulate a retry boot: wipe the marker but keep the data.
    fs.rmSync(markerFile());
    const retry = await startFirstBootSageSync({ store, memoryStore: port });
    expect(retry.synced).toBe(true);
    expect(retry.marker?.indexed).toBe(0);
    expect(retry.marker?.skipped).toBe(1);
    expect(store.stats().entries).toBe(1);
  });

  it('defers when the warmup embed probe fails, even though isAvailable() is true', async () => {
    // isAvailable() lies — the model cannot actually embed. The probe is the
    // authoritative gate; without it the fail-open remember() would store
    // vector-less entries and mark the mirror complete.
    const probeFailsStore = new VectorMemoryStore({
      provider: new FlakyEmbeddingProvider([1]),
      projectRoot,
    });
    try {
      const result = await startFirstBootSageSync({
        store: probeFailsStore,
        memoryStore: fakeSagePort([{ id: 'sage-1', text: 'text' }]),
      });
      expect(result.synced).toBe(false);
      expect(result.reason).toBe('provider-unavailable');
      expect(fs.existsSync(path.join(probeFailsStore.directory, SAGE_SYNC_MARKER_FILENAME))).toBe(
        false,
      );
      expect(probeFailsStore.stats().entries).toBe(0);
    } finally {
      probeFailsStore.close();
    }
  });

  it('heals vector-less entries via reindexAll() and still completes', async () => {
    // Call 1: warmup probe (OK). Call 2: first sync embed (fails → remember()
    // stores the entry WITHOUT a vector). Call 3+: everything works. The
    // completion invariant must notice vectors < entries and backfill.
    const flakyStore = new VectorMemoryStore({
      provider: new FlakyEmbeddingProvider([2]),
      projectRoot,
    });
    try {
      const result = await startFirstBootSageSync({
        store: flakyStore,
        memoryStore: fakeSagePort([
          { id: 'sage-1', text: 'first memory lost its vector' },
          { id: 'sage-2', text: 'second memory is fine' },
        ]),
      });
      expect(result.synced).toBe(true);
      const stats = flakyStore.stats();
      expect(stats.entries).toBe(2);
      expect(stats.vectors).toBe(2);
      const onDisk = JSON.parse(
        fs.readFileSync(path.join(flakyStore.directory, SAGE_SYNC_MARKER_FILENAME), 'utf8'),
      ) as { phase: string };
      expect(onDisk.phase).toBe('complete');
    } finally {
      flakyStore.close();
    }
  });

  it('leaves NO complete marker when vector-less entries cannot be healed', async () => {
    // The provider embeds the probe fine but throws for poisoned texts —
    // forever. remember() fails open, reindexAll() cannot fix it either, so
    // the sync must refuse to write `complete` (retry next boot).
    //
    // `isAvailable` is not part of the EmbeddingProvider contract — the
    // sync duck-types it via storeProvider — so the fixture declares the
    // extension explicitly instead of relying on excess-property inference.
    const poisoned: EmbeddingProvider & { isAvailable(): Promise<boolean> } = {
      id: 'poisoned-v1',
      dimensions: 32,
      async isAvailable() {
        return true;
      },
      async embed(texts: string[]) {
        if (texts.some((t) => t.includes('poison'))) throw new Error('poisoned text');
        return new FakeEmbeddingProvider({ dimensions: 32 }).embed(texts);
      },
    };
    const poisonedStore = new VectorMemoryStore({ provider: poisoned, projectRoot });
    try {
      const result = await startFirstBootSageSync({
        store: poisonedStore,
        memoryStore: fakeSagePort([
          { id: 'sage-1', text: 'healthy memory' },
          { id: 'sage-2', text: 'poison entry that can never embed' },
        ]),
      });
      expect(result.synced).toBe(false);
      expect(result.reason).toBe('vector-incomplete');
      const stats = poisonedStore.stats();
      expect(stats.entries).toBe(2);
      expect(stats.vectors).toBe(1);
      const onDisk = JSON.parse(
        fs.readFileSync(path.join(poisonedStore.directory, SAGE_SYNC_MARKER_FILENAME), 'utf8'),
      ) as { phase: string };
      expect(onDisk.phase).toBe('running');
    } finally {
      poisonedStore.close();
    }
  });

  it('defers when the embedding provider reports unavailable (fail-open guard)', async () => {
    // Same isAvailable-extension pattern as above: declared explicitly
    // because the contract type does not include it.
    const unavailable: EmbeddingProvider & { isAvailable(): Promise<boolean> } = {
      id: 'unavailable-v1',
      dimensions: 8,
      async isAvailable() {
        return false;
      },
      async embed() {
        throw new Error('provider down');
      },
    };
    const unavailableStore = new VectorMemoryStore({ provider: unavailable, projectRoot });
    try {
      const result = await startFirstBootSageSync({
        store: unavailableStore,
        memoryStore: fakeSagePort([{ id: 'sage-1', text: 'text' }]),
      });
      expect(result.synced).toBe(false);
      expect(result.reason).toBe('provider-unavailable');
      expect(fs.existsSync(path.join(unavailableStore.directory, SAGE_SYNC_MARKER_FILENAME))).toBe(
        false,
      );
      expect(unavailableStore.stats().entries).toBe(0);
    } finally {
      unavailableStore.close();
    }
  });

  it('skips cleanly when the memory port exposes no SAGE surface', async () => {
    const result = await startFirstBootSageSync({
      store,
      memoryStore: { getCapability: () => undefined } as unknown as MemoryPort,
    });
    expect(result.synced).toBe(false);
    expect(result.reason).toBe('no-sage-surface');
    expect(fs.existsSync(markerFile())).toBe(false);
  });
});

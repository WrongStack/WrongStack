import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  type MemoryPort,
  SAGE_SURFACE_CAPABILITY,
  type Sage,
  type SageSurface,
} from '@wrongstack/sage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSageSurfaceSyncSource,
  decideWhetherToSync,
  decodeVector,
  fallbackHashingProvider,
  forgetStaleSageMirrors,
  fuseWithVectorMemory,
  runSearchRace,
  startFirstBootSageSync,
  subscribeVectorMemoryToSage,
  sweepStaleSageMirrors,
  TransformersEmbeddingProvider,
  VectorMemoryProviderUnavailableError,
  VectorMemoryStore,
} from '../src/index.js';
import { FakeEmbeddingProvider } from './fake-provider.js';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vm-test-100-'));
}

function makeStore(dir: string): VectorMemoryStore {
  return new VectorMemoryStore({
    projectRoot: dir,
    provider: new FakeEmbeddingProvider({ dimensions: 4 }),
  });
}

function makeMemoryPort(surface?: Partial<SageSurface>): MemoryPort {
  return {
    getCapability: (cap: unknown) => {
      if (cap === SAGE_SURFACE_CAPABILITY) {
        return surface as SageSurface;
      }
      return undefined;
    },
  } as unknown as MemoryPort;
}

describe('vector-memory 100% coverage suite', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
    vi.restoreAllMocks();
  });

  describe('schema.ts decodeVector', () => {
    it('throws when byteLength is not a multiple of 4', () => {
      const invalidBuf = Buffer.from([1, 2, 3]);
      expect(() => decodeVector(invalidBuf)).toThrow(/invalid vector byteLength 3/);
    });
  });

  describe('search-race.ts previewText', () => {
    it('truncates text exceeding maxLen with ellipsis', async () => {
      const store = makeStore(tmpDir);
      const longText = 'A'.repeat(200);
      await store.remember({
        text: longText,
        vector: new Float32Array([1, 0, 0, 0]),
        metadata: { sageId: 's1' },
      });

      const lexicalHits: Sage[] = [
        {
          id: 's1',
          text: longText,
          kind: 'fact',
          scope: 'project',
          importance: 1,
          confidence: 1,
          status: 'active',
          provenance: { source: 'test' },
          audit: { createdAt: new Date().toISOString(), accessCount: 1 },
        },
      ];

      const race = await runSearchRace('A', lexicalHits, store, {
        limit: 5,
      });

      expect(race.overlap[0]?.preview.endsWith('…')).toBe(true);
      await store.close();
    });
  });

  describe('sage-sync-source.ts noProgressPages break', () => {
    it('breaks when empty pages repeat > 3 times with a nextCursor', async () => {
      let calls = 0;
      const fakeSage: Partial<SageSurface> = {
        listSagePage: vi.fn(async () => {
          calls++;
          return {
            memories: [],
            nextCursor: `cursor-${calls}`,
            total: 10,
          };
        }),
      };

      const source = createSageSurfaceSyncSource(fakeSage as SageSurface, {
        pageSize: 5,
      });

      const memories = await source.listActiveMemories({ limit: 10 });
      expect(memories).toHaveLength(0);
      expect(calls).toBeGreaterThanOrEqual(4);
    });
  });

  describe('sage-fusion.ts ranking and clamp01', () => {
    it('boosts a vector hit that maps to a SAGE memory present in lexical', async () => {
      const mem1: Sage = {
        id: 's1',
        text: 'Lexical and vector match',
        kind: 'fact',
        scope: 'project',
        importance: 1,
        confidence: 1,
        status: 'active',
        provenance: { source: 'test' },
        audit: { createdAt: new Date().toISOString(), accessCount: 1 },
      };

      const hits = await fuseWithVectorMemory('query', [mem1], {
        vectorHits: [
          {
            id: 'v1',
            score: 0.8,
            entry: {
              id: 'v1',
              text: mem1.text,
              metadata: { sageId: 's1' },
            },
          },
        ],
      });

      expect(hits).toHaveLength(1);
      expect(hits[0]?.memory.id).toBe('s1');
      expect(hits[0]?.source).toBe('both');
    });

    it('covers __testing ranking and clamp01 edge cases', async () => {
      const { __testing } = await import('../src/sage-fusion.js');
      expect(__testing.lexicalRankScore(0, 1)).toBe(1);
      expect(__testing.lexicalRankScore(1, 3)).toBe(0.5);
      expect(__testing.vectorRankScore(0, 1)).toBe(1);
      expect(__testing.vectorRankScore(1, 3)).toBe(0.5);
      expect(__testing.clamp01(Number.NaN)).toBe(0.3);
      expect(__testing.clamp01(-0.5)).toBe(0);
      expect(__testing.clamp01(1.5)).toBe(1);
      expect(__testing.clamp01(0.7)).toBe(0.7);
    });
  });

  describe('store.ts fallbackHashingProvider and error paths', () => {
    it('creates fallbackHashingProvider', () => {
      const p = fallbackHashingProvider(16);
      expect(p.dimensions).toBe(16);
    });

    it('handles store syncFromSage remember errors gracefully', async () => {
      const store = makeStore(tmpDir);

      // Spy on rememberUnlocked to throw on first call
      vi.spyOn(
        store as unknown as { rememberUnlocked: () => Promise<unknown> },
        'rememberUnlocked',
      ).mockRejectedValueOnce(new Error('simulated remember failure'));

      const syncSource = {
        listActiveMemories: async () => [
          { id: 'm1', text: 'memory 1' },
          { id: 'm2', text: 'memory 2' },
        ],
      };

      const report = await store.syncFromSage(syncSource);
      expect(report.failed).toBe(1);
      expect(report.indexed).toBe(1);
      expect(report.errors[0]?.message).toContain('simulated remember failure');

      // Test evictCache with negative keepMostRecent
      await expect(store.evictCache(-1)).rejects.toThrow(/keepMostRecent must be >= 0/);

      // Test reindexAll when provider returns empty array
      vi.spyOn(store.provider, 'embed').mockResolvedValueOnce([]);
      const reindexReport = await store.reindexAll();
      expect(reindexReport.errors).toBeGreaterThanOrEqual(1);

      await store.close();
    });
  });

  describe('sage-event-mirror.ts forgetStaleSageMirrors and sweepStaleSageMirrors', () => {
    it('handles memoryStore throwing, tombstoned memory, and non-string sageId in forgetStaleSageMirrors', async () => {
      const store = makeStore(tmpDir);

      await store.remember({
        text: 'Valid active',
        vector: new Float32Array([1, 0, 0, 0]),
        metadata: { sageId: 'active-1' },
      });
      await store.remember({
        text: 'Deleted tombstone',
        vector: new Float32Array([0, 1, 0, 0]),
        metadata: { sageId: 'deleted-1' },
      });
      await store.remember({
        text: 'Throws error',
        vector: new Float32Array([0, 0, 1, 0]),
        metadata: { sageId: 'throws-1' },
      });
      await store.remember({
        text: 'Missing sageId',
        vector: new Float32Array([0, 0, 0, 1]),
        metadata: { sageId: 123 as unknown as string },
      });

      const warnCalls: string[] = [];
      const logger = {
        warn: (msg: string) => {
          warnCalls.push(msg);
        },
      };

      const surface: Partial<SageSurface> = {
        getSage: vi.fn(async (id: string) => {
          if (id === 'active-1') {
            return {
              id: 'active-1',
              text: 'still active',
              status: 'active',
            } as Sage;
          }
          if (id === 'deleted-1') {
            return {
              id: 'deleted-1',
              text: 'tombstone',
              status: 'deleted',
            } as Sage;
          }
          if (id === 'throws-1') {
            throw new Error('Database locked');
          }
          return null;
        }),
      };

      const memoryPort = makeMemoryPort(surface);

      const res = await forgetStaleSageMirrors(store, memoryPort, logger);
      expect(res.scanned).toBe(4);
      expect(res.removed).toBe(1); // deleted-1 was removed
      expect(warnCalls.some((msg) => msg.includes('Database locked'))).toBe(true);

      await store.close();
    });

    it('sweeps stale mirrors, throttles subsequent runs, and honors force: true', async () => {
      const store = makeStore(tmpDir);

      const surface: Partial<SageSurface> = {
        getSage: vi.fn(async () => null),
      };
      const memoryPort = makeMemoryPort(surface);

      const debugCalls: string[] = [];
      const logger = {
        debug: (msg: string) => {
          debugCalls.push(msg);
        },
      };

      // 1. Initial sweep runs and sets marker
      const sweep1 = await sweepStaleSageMirrors({
        store,
        memoryStore: memoryPort,
        logger,
      });
      expect(sweep1.swept).toBe(true);
      expect(debugCalls.length).toBeGreaterThan(0);

      // 2. Immediate second sweep should be throttled
      const sweep2 = await sweepStaleSageMirrors({
        store,
        memoryStore: memoryPort,
        logger,
      });
      expect(sweep2.swept).toBe(false);
      expect(sweep2.reason).toBe('throttled');

      // 3. Forced sweep runs regardless of throttle
      const sweep3 = await sweepStaleSageMirrors({
        store,
        memoryStore: memoryPort,
        logger,
        force: true,
      });
      expect(sweep3.swept).toBe(true);

      // 4. Corrupt marker handles gracefully
      const markerPath = path.join(store.directory, 'sage-mirror-sweep.json');
      fs.writeFileSync(markerPath, '{invalid-json', 'utf8');
      const sweep4 = await sweepStaleSageMirrors({
        store,
        memoryStore: memoryPort,
        logger,
      });
      expect(sweep4.swept).toBe(true);

      await store.close();
    });

    it('handles sweep failure gracefully and returns swept: false', async () => {
      const store = makeStore(tmpDir);

      const surface: Partial<SageSurface> = {
        getSage: vi.fn(async () => {
          throw new Error('Permanent failure');
        }),
      };
      const memoryPort = makeMemoryPort(surface);

      // Mock store.list to throw inside forgetStaleSageMirrors
      vi.spyOn(store, 'list').mockImplementationOnce(() => {
        throw new Error('Store list failed');
      });

      const warnCalls: string[] = [];
      const res = await sweepStaleSageMirrors({
        store,
        memoryStore: memoryPort,
        logger: { warn: (msg: string) => warnCalls.push(msg) },
      });
      expect(res.swept).toBe(false);
      expect(res.reason).toContain('Store list failed');
      expect(warnCalls.some((msg) => msg.includes('Store list failed'))).toBe(true);

      await store.close();
    });

    it('handles subscribeVectorMemoryToSage when event bus is missing, or fetch/forget throws', async () => {
      const store = makeStore(tmpDir);
      const surface: Partial<SageSurface> = {
        getSage: vi.fn(async (id: string) => {
          if (id === 'throws') throw new Error('Fetch failed');
          return null;
        }),
      };
      const portNoBus = makeMemoryPort(surface);

      const debugCalls: string[] = [];
      const warnCalls: string[] = [];
      const logger = {
        debug: (msg: string) => debugCalls.push(msg),
        warn: (msg: string) => warnCalls.push(msg),
      };

      // 1. Missing events bus
      const { subscribeVectorMemoryToSage } = await import('../src/sage-event-mirror.js');
      const handle1 = subscribeVectorMemoryToSage({ store, memoryStore: portNoBus, logger });
      expect(debugCalls.some((msg) => msg.includes('has no event bus'))).toBe(true);
      handle1.dispose();

      // 2. Events bus with throwing getSage and throwing forget
      const listeners: Record<string, Array<(event: string, payload: unknown) => void>> = {};
      const events = {
        onPattern: (pattern: string, cb: (event: string, payload: unknown) => void) => {
          listeners[pattern] = listeners[pattern] ?? [];
          listeners[pattern].push(cb);
          return () => {
            listeners[pattern] = (listeners[pattern] ?? []).filter((f) => f !== cb);
          };
        },
        emit: (pattern: string, payload: unknown) => {
          for (const cb of listeners[pattern] ?? []) {
            cb(pattern, payload);
          }
        },
      };
      const portWithBus = Object.assign(makeMemoryPort(surface), { events });

      const handle2 = subscribeVectorMemoryToSage({ store, memoryStore: portWithBus, logger });

      // Trigger memory.accepted with id 'throws' -> fetch throws
      events.emit('memory.accepted', { memoryId: 'throws' });
      await new Promise((r) => setTimeout(r, 30));
      expect(warnCalls.some((msg) => msg.includes('mirror fetch failed'))).toBe(true);

      // Trigger memory.deleted with throwing findBySageId
      vi.spyOn(store, 'findBySageId').mockImplementationOnce(() => {
        throw new Error('Find failed');
      });
      events.emit('memory.deleted', { memoryId: 'del-1' });
      await new Promise((r) => setTimeout(r, 30));
      expect(warnCalls.some((msg) => msg.includes('mirror forget failed'))).toBe(true);

      handle2.dispose();
      await store.close();
    });
  });

  describe('sage-sync.ts edge cases', () => {
    it('handles sync partial-failure when report has failures', async () => {
      const store = makeStore(tmpDir);

      const surface: Partial<SageSurface> = {
        listSagePage: vi.fn(async () => ({
          memories: [
            {
              id: 'm1',
              revision: 1,
              scope: 'project',
              kind: 'fact',
              status: 'active',
              text: 'test mem',
              importance: 1,
              confidence: 1,
              freshness: 1,
              tags: [],
              anchors: [],
              sources: [],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
          nextCursor: null,
          total: 1,
        })),
      };
      const memoryPort = makeMemoryPort(surface);

      // Make syncFromSage report failed > 0
      vi.spyOn(store, 'syncFromSage').mockResolvedValueOnce({
        scanned: 1,
        indexed: 0,
        skipped: 0,
        failed: 1,
        errors: [{ memoryId: 'm1', message: 'failed' }],
      });

      const warnCalls: string[] = [];
      const res = await startFirstBootSageSync({
        store,
        memoryStore: memoryPort,
        logger: { warn: (msg: string) => warnCalls.push(msg) },
      });
      expect(res.synced).toBe(false);
      expect(res.reason).toBe('partial-failure');
      expect(warnCalls.some((msg) => msg.includes('failure(s)'))).toBe(true);
      await store.close();
    });

    it('covers decideWhetherToSync with defaultPidAlive', async () => {
      const store = makeStore(tmpDir);
      const markerPath = path.join(store.directory, 'sage-sync.complete.json');

      // 1. Running marker with dead pid (999999999) using default pidAlive
      fs.writeFileSync(
        markerPath,
        JSON.stringify({
          phase: 'running',
          pid: 999999999,
          startedAt: new Date().toISOString(),
        }),
        'utf8',
      );
      const d1 = decideWhetherToSync(store, 60000);
      expect(d1.run).toBe(true);
      expect(d1.reason).toBe('running-pid-999999999-dead');

      // 2. Running marker with EPERM error on process.kill
      const killSpy = vi.spyOn(process, 'kill').mockImplementationOnce(() => {
        const err = Object.assign(new Error('Operation not permitted'), { code: 'EPERM' });
        throw err;
      });
      const d2 = decideWhetherToSync(store, 60000);
      expect(d2.run).toBe(false);
      expect(d2.reason).toBe('running-pid-999999999');
      killSpy.mockRestore();

      await store.close();
    });

    it('handles memory store without sage surface', async () => {
      const store = makeStore(tmpDir);

      const memoryPort = makeMemoryPort(undefined);

      const res = await startFirstBootSageSync({
        store,
        memoryStore: memoryPort,
      });
      expect(res.synced).toBe(false);
      expect(res.reason).toBe('no-sage-surface');
      await store.close();
    });
  });

  describe('TransformersEmbeddingProvider full coverage', () => {
    it('returns empty array when embed is called with empty texts', async () => {
      const provider = new TransformersEmbeddingProvider();
      expect(await provider.embed([])).toEqual([]);
    });

    it('truncates texts exceeding maxChars and handles empty string', async () => {
      const provider = new TransformersEmbeddingProvider({
        maxChars: 10,
      });
      const prepare = (provider as unknown as { prepare: (t: string) => string }).prepare.bind(
        provider,
      );
      expect(prepare('')).toBe('');
      expect(prepare('abcdefghijklm')).toBe('abcdefghij');
      expect(prepare('  spaced  ')).toBe('spaced');
    });

    it('tensorToVectors handles tolist nested array, tolist flat array, Float32Array, and invalid shape', () => {
      const provider = new TransformersEmbeddingProvider({ batchSize: 2 });
      const tensorToVectors = (
        provider as unknown as {
          tensorToVectors: (out: unknown, batchSize: number) => Float32Array[];
        }
      ).tensorToVectors.bind(provider);

      // 1. tolist nested
      const nestedOut = {
        tolist: () => [
          [0.1, 0.2],
          [0.3, 0.4],
        ],
      };
      const r1 = tensorToVectors(nestedOut, 2);
      expect(r1).toHaveLength(2);
      expect(r1[0]![0]).toBeCloseTo(0.1);

      // 2. tolist flat
      const flatOut = {
        tolist: () => [0.5, 0.6],
      };
      const r2 = tensorToVectors(flatOut, 1);
      expect(r2).toHaveLength(1);
      expect(r2[0]![0]).toBeCloseTo(0.5);

      // 3. data flat Float32Array batchSize = 1
      const f32Single = {
        data: new Float32Array([1.1, 1.2]),
      };
      const r3 = tensorToVectors(f32Single, 1);
      expect(r3).toHaveLength(1);
      expect(r3[0]![0]).toBeCloseTo(1.1);

      // 4. data flat Float32Array batchSize = 2
      const f32Batch = {
        data: new Float32Array([2.1, 2.2, 2.3, 2.4]),
      };
      const r4 = tensorToVectors(f32Batch, 2);
      expect(r4).toHaveLength(2);
      expect(r4[1]![0]).toBeCloseTo(2.3);

      // 5. data Array of arrays
      const arrNested = {
        data: [[3.1, 3.2]],
      };
      const r5 = tensorToVectors(arrNested, 1);
      expect(r5).toHaveLength(1);
      expect(r5[0]![0]).toBeCloseTo(3.1);

      // 6. data flat Array of numbers
      const arrFlat = {
        data: [4.1, 4.2],
      };
      const r6 = tensorToVectors(arrFlat, 1);
      expect(r6).toHaveLength(1);
      expect(r6[0]![0]).toBeCloseTo(4.1);

      // 7. unexpected shape throws
      expect(() => tensorToVectors({ data: 'invalid' }, 1)).toThrow(
        /unexpected pipeline output shape/,
      );
    });

    it('embeds batches using mock extractor with options and custom cacheDir / allowRemoteModels', async () => {
      const provider = new TransformersEmbeddingProvider({
        batchSize: 2,
        cacheDir: '/custom/cache',
        allowRemoteModels: false,
      });

      const mockPipe = vi.fn(async (batch: string[]) => ({
        tolist: () => batch.map(() => [0.1, 0.2, 0.3, 0.4]),
      }));

      const mockModule = {
        env: {} as Record<string, unknown>,
        pipeline: vi.fn(async () => mockPipe),
      };

      (provider as unknown as { loadModule: () => Promise<unknown> }).loadModule = async () =>
        mockModule;

      const vectors = await provider.embed(['t1', 't2', 't3']);
      expect(vectors).toHaveLength(3);
      expect(mockModule.env.cacheDir).toBe('/custom/cache');
      expect(mockModule.env.allowRemoteModels).toBe(false);
      expect(mockModule.env.localModelPath).toBe('/custom/cache');
      expect(mockPipe).toHaveBeenCalledTimes(2);
    });

    it('isAvailable returns false and embed throws when loadModule rejects', async () => {
      const provider = new TransformersEmbeddingProvider();
      (provider as unknown as { loadModule: () => Promise<unknown> }).loadModule = async () => {
        throw new VectorMemoryProviderUnavailableError('test missing dep');
      };

      expect(await provider.isAvailable()).toBe(false);
      await expect(provider.embed(['test'])).rejects.toThrow(VectorMemoryProviderUnavailableError);
    });

    it('disables mirror when enabled is false', () => {
      const store = makeStore(tmpDir);
      const port = makeMemoryPort();
      const handle = subscribeVectorMemoryToSage({
        store,
        memoryStore: port,
        enabled: false,
      });
      expect(handle.dispose()).toBeUndefined();
    });

    it('handles startFirstBootSageSync when sync throws', async () => {
      const store = makeStore(tmpDir);
      const surface: Partial<SageSurface> = {
        listSagePage: vi.fn(async () => ({ items: [], nextCursor: null })),
      };
      const port = makeMemoryPort(surface);
      vi.spyOn(store, 'syncFromSage').mockRejectedValueOnce(new Error('sync crash'));
      const warns: string[] = [];
      const res = await startFirstBootSageSync({
        store,
        memoryStore: port,
        logger: { warn: (msg) => warns.push(msg) },
      });
      expect(res.synced).toBe(false);
      expect(res.reason).toBe('error');
      expect(warns.some((w) => w.includes('sync crash'))).toBe(true);
    });

    it('handles storeProvider returning undefined when provider has no id and handles force: true', async () => {
      const storeWithoutProviderId = {
        directory: tmpDir,
        provider: {},
      } as unknown as VectorMemoryStore;
      // First, write a dummy marker file
      const { SAGE_SYNC_MARKER_FILENAME } = await import('../src/index.js');
      fs.writeFileSync(path.join(tmpDir, SAGE_SYNC_MARKER_FILENAME), '{}', 'utf8');

      const res = await startFirstBootSageSync({
        store: storeWithoutProviderId,
        memoryStore: makeMemoryPort(),
        force: true,
      });
      expect(res.synced).toBe(false);
      expect(res.reason).toBe('no-sage-surface');
      // Verify marker was unlinked by force: true
      expect(fs.existsSync(path.join(tmpDir, SAGE_SYNC_MARKER_FILENAME))).toBe(false);
    });

    it('covers markerPath throwing when directory is missing or invalid', async () => {
      const invalidStore = {} as unknown as VectorMemoryStore;
      // decideWhetherToSync calls readMarker(invalidStore) -> markerPath throws and readMarker catches it
      const decision = decideWhetherToSync(invalidStore, 1000);
      expect(decision.run).toBe(true);
      expect(decision.reason).toBe('no-marker');
    });

    it('filters list and search by scope and kind, and safeParseJson catches malformed JSON', async () => {
      const store = makeStore(tmpDir);
      const e1 = await store.remember({
        text: 'note text',
        scope: 'project',
        kind: 'note',
        metadata: { a: 1 },
      });
      const e2 = await store.remember({
        text: 'rule text',
        scope: 'session',
        kind: 'rule',
      });

      const projectNotes = store.list({ scope: 'project', kind: 'note' });
      expect(projectNotes.some((e) => e.id === e1.id)).toBe(true);
      expect(projectNotes.some((e) => e.id === e2.id)).toBe(false);

      const sessionRules = store.list({ scope: 'session', kind: 'rule' });
      expect(sessionRules.some((e) => e.id === e2.id)).toBe(true);

      // Also exercise search with scope and kind filters
      const searchResults = await store.search('note', { scope: 'project', kind: 'note' });
      expect(searchResults.some((hit) => hit.entry.id === e1.id)).toBe(true);
      expect(searchResults.some((hit) => hit.entry.id === e2.id)).toBe(false);

      // Corrupt JSON in sqlite table directly
      const db = (store as unknown as { db: any }).db;
      db.prepare(
        "UPDATE entries SET metadata = 'malformed json {', tags = 'bad tags [' WHERE id = ?",
      ).run(e1.id);

      const fetched = store.get(e1.id);
      expect(fetched?.metadata).toEqual({});
      expect(fetched?.tags).toEqual([]);

      // Test normalizeLimit with negative and NaN
      const resNeg = await store.search('note', { limit: -5 });
      expect(Array.isArray(resNeg)).toBe(true);
      const resNan = await store.search('note', { limit: Number.NaN });
      expect(Array.isArray(resNan)).toBe(true);
    });

    it('rolls back and rethrows on transaction error in remember and forget', async () => {
      const store = makeStore(tmpDir);
      const db = (store as unknown as { db: any }).db;
      const origPrepare = db.prepare.bind(db);

      // 1. Error in rememberUnlocked during INSERT INTO vectors
      vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('INSERT INTO vectors')) {
          throw new Error('mock vectors insert error');
        }
        return origPrepare(sql);
      });

      await expect(store.remember({ text: 'text causing rollback' })).rejects.toThrow(
        'mock vectors insert error',
      );

      // 2. Error in forget during DELETE FROM entries
      vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.includes('DELETE FROM entries')) {
          throw new Error('mock delete error');
        }
        return origPrepare(sql);
      });

      await expect(store.forget('some-id')).rejects.toThrow('mock delete error');
    });

    it('exercises databasePath getter and recordActiveProvider rollback', () => {
      const store = makeStore(tmpDir);
      expect(store.databasePath).toContain('vector-memory.db');

      const db = (store as unknown as { db: any }).db;
      vi.spyOn(db, 'prepare').mockImplementationOnce(() => {
        throw new Error('mock schema_meta insert error');
      });
      expect(() => (store as any).recordActiveProvider()).toThrow('mock schema_meta insert error');
    });

    it('rejects remember with empty or whitespace text', async () => {
      const store = makeStore(tmpDir);
      await expect(store.remember({ text: '   ' })).rejects.toThrow(/text must be non-empty/);
      await expect(store.remember({ text: '' })).rejects.toThrow(/text must be non-empty/);
    });

    it('rejects absolute directory or directory escaping project root', () => {
      const provider = new FakeEmbeddingProvider({ dimensions: 4 });
      const absDir = process.platform === 'win32' ? 'C:\\escaped\\dir' : '/escaped/dir';
      expect(
        () =>
          new VectorMemoryStore({
            projectRoot: tmpDir,
            directory: absDir,
            provider,
          }),
      ).toThrow(/Vector memory directory must be project-relative/);

      expect(
        () =>
          new VectorMemoryStore({
            projectRoot: tmpDir,
            directory: '../outside',
            provider,
          }),
      ).toThrow(/Vector memory directory must stay inside the project root/);
    });
  });
});

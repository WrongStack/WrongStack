import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MemoryCapability, MemoryStore } from '@wrongstack/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createProjectSageMemoryPort,
  createSqliteMemoryPort,
  getSageRetrieval,
  getSageService,
  getSageSurface,
  LegacyMemoryPortAdapter,
  ProjectSageMemoryPort,
  SqliteMemoryPort,
} from '../src/memory-port.js';
import { isSqliteAvailable } from '../src/sqlite-store.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe('LegacyMemoryPortAdapter coverage', () => {
  it('delegates every legacy operation and exposes its configured backend', async () => {
    const store = {
      readAll: vi.fn(async () => 'all'),
      read: vi.fn(async () => 'read'),
      remember: vi.fn(async () => {}),
      forget: vi.fn(async () => 2),
      consolidate: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
      list: vi.fn(async () => []),
      search: vi.fn(async () => []),
      getBackend: vi.fn(() => ({ kind: 'fixture' })),
      findRelated: vi.fn(async () => []),
      scoreRelevant: vi.fn(async () => []),
      hygiene: vi.fn(async () => ({ reviewed: 0 })),
      withTraceId: vi.fn(),
    } as unknown as MemoryStore;
    const adapter = new LegacyMemoryPortAdapter(store, 'fixture');

    await adapter.initialize();
    await expect(adapter.readAll()).resolves.toBe('all');
    await expect(adapter.read('project-memory')).resolves.toBe('read');
    await adapter.remember('text', 'project-memory');
    await expect(adapter.forget('text', 'project-memory')).resolves.toBe(2);
    await adapter.consolidate('project-memory');
    await adapter.clear('project-memory');
    await expect(adapter.list('project-memory')).resolves.toEqual([]);
    await expect(adapter.search('text', 'project-memory')).resolves.toEqual([]);
    expect(adapter.getBackend()).toEqual({ kind: 'fixture' });
    await expect(adapter.findRelated('text', 'project-memory')).resolves.toEqual([]);
    await expect(adapter.scoreRelevant({ currentTask: 'text' }, 'project-memory')).resolves.toEqual(
      [],
    );
    await expect(adapter.hygiene()).resolves.toEqual({ reviewed: 0 });
    expect(adapter.withTraceId('trace')).toBe(adapter);
    expect(adapter.getCapability({ id: 'missing' } as MemoryCapability<unknown>)).toBeUndefined();
    await expect(adapter.health()).resolves.toEqual({ status: 'ready', backend: 'fixture' });
    await expect(adapter.dispose()).resolves.toBeUndefined();
  });

  it('uses safe fallbacks when optional legacy methods are absent', async () => {
    const store = {
      readAll: vi.fn(async () => ''),
      read: vi.fn(async () => ''),
      remember: vi.fn(async () => {}),
      forget: vi.fn(async () => 0),
      consolidate: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
      list: vi.fn(async () => []),
      search: vi.fn(async () => []),
      withTraceId: vi.fn(),
    } as unknown as MemoryStore;
    const adapter = new LegacyMemoryPortAdapter(store);

    expect(adapter.getBackend()).toBeUndefined();
    await expect(adapter.findRelated('query')).resolves.toEqual([]);
    await expect(adapter.scoreRelevant({ currentTask: 'query' })).resolves.toEqual([]);
    await expect(adapter.hygiene()).resolves.toBeUndefined();
    await expect(adapter.health()).resolves.toEqual({ status: 'ready', backend: 'legacy' });
  });
});

describe('SqliteMemoryPort coverage', () => {
  it('creates the production port and exercises every capability adapter', async () => {
    if (!isSqliteAvailable()) return;
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wrongstack-sage-port-'));
    temporaryDirectories.push(projectRoot);
    const port = createSqliteMemoryPort({ projectRoot });
    expect(port).toBeInstanceOf(SqliteMemoryPort);
    await port.initialize();

    try {
      const sqlite = port as SqliteMemoryPort;
      expect(sqlite.withTraceId('capability-trace')).toBe(sqlite);
      await expect(sqlite.health()).resolves.toEqual({ status: 'ready', backend: 'sqlite' });
      const surface = getSageSurface(sqlite)!;
      const retrieval = getSageRetrieval(sqlite)!;
      const memory = await surface.rememberSage({
        text: 'Capability adapter memory',
        anchors: [{ type: 'file', path: 'src/example.ts' }],
      });

      await expect(
        retrieval.retrieveForPath({
          path: 'src/example.ts',
          limit: 5,
          includeAncestors: true,
          includeStatuses: ['active'],
          includeAudienceScoped: true,
        }),
      ).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: memory.id })]));
      await expect(retrieval.searchSage('Capability')).resolves.toHaveLength(1);
      await expect(retrieval.findRelatedSage!([memory.id])).resolves.toEqual(expect.any(Array));
      await retrieval.recordInjection!([memory.id], 'test', 'session');
      await retrieval.recordUse!([memory.id], 'test', 'session');
      await retrieval.flushPendingCounters?.();
      await expect(retrieval.retrieveForAudience!({}, 3)).resolves.toEqual(expect.any(Array));
      await expect(retrieval.retrieveForAudience!({})).resolves.toEqual(expect.any(Array));

      await expect(surface.stats()).resolves.toEqual(expect.objectContaining({ total: 1 }));
      await expect(surface.listSage()).resolves.toHaveLength(1);
      await expect(surface.listSagePage!({ limit: 1 })).resolves.toEqual(
        expect.objectContaining({ memories: expect.any(Array) }),
      );
      await expect(surface.getSage(memory.id)).resolves.toEqual(
        expect.objectContaining({ id: memory.id }),
      );
      await expect(
        surface.updateSage(memory.id, { text: 'Capability adapter memory updated' }),
      ).resolves.toEqual(expect.objectContaining({ text: 'Capability adapter memory updated' }));
      await expect(
        surface.retrieveForPath({ path: 'src/example.ts', includeAncestors: false }),
      ).resolves.toHaveLength(1);
      await expect(surface.searchSage('adapter')).resolves.toHaveLength(1);
      await expect(surface.retrieveForAudience({}, 2)).resolves.toEqual(expect.any(Array));
      await expect(surface.retrieveForAudience({})).resolves.toEqual(expect.any(Array));
      await expect(surface.hygiene()).resolves.toEqual(expect.any(Object));
      await expect(surface.listCandidates(false)).resolves.toEqual([]);
      await expect(surface.listCandidates(true)).resolves.toEqual([]);
      await expect(surface.graphFor!(memory.id, 1, 10)).resolves.toEqual(expect.any(Array));
      await expect(surface.verify!(memory.id)).resolves.toEqual(expect.any(Array));
      await expect(surface.readAudit!(10)).resolves.toEqual(expect.any(Array));
      await expect(surface.acceptCandidate('missing')).resolves.toBeUndefined();
      await expect(surface.rejectCandidate('missing', 'reason')).resolves.toBe(false);
      await expect(
        surface.deleteSage(memory.id, 'cleanup', { force: true }),
      ).resolves.toBeUndefined();
      // Test remaining surface capability delegates
      await expect(surface.searchSageWithBreakdown('adapter')).resolves.toEqual(expect.any(Array));
      const cand = await surface.createCandidate({
        text: 'candidate text',
        suggestedAction: 'archive',
        reviewReason: 'test candidate',
        targetMemoryId: memory.id,
      });
      await expect(surface.findMemoriesForFile!('src/example.ts')).resolves.toEqual(
        expect.objectContaining({ totalCount: expect.any(Number) }),
      );
      await expect(surface.backfillRecoverable!({ dryRun: true })).resolves.toBeDefined();
      await expect(surface.recoverSage!(memory.id)).resolves.toEqual(
        expect.objectContaining({ id: memory.id }),
      );

      // Test importLegacyFiles via surface.importLegacy
      const legacyFile = path.join(projectRoot, 'legacy-memories.md');
      await fs.writeFile(legacyFile, '# Memories\n- [project] A legacy memory\n', 'utf8');
      const importResult = await surface.importLegacy!([legacyFile]);
      expect(importResult).toEqual(expect.objectContaining({ files: 1, imported: 1 }));

      // Test remaining retrieval capability delegates
      await expect(retrieval.searchSageWithBreakdown!('Capability')).resolves.toEqual(
        expect.any(Array),
      );

      // Test unknown capability
      expect(sqlite.getCapability({ id: 'unknown-cap' } as never)).toBeUndefined();

      // Test complete service capability delegates
      const service = getSageService(sqlite)!;
      expect(service.withTraceId('service-trace')).toBe(service);
      await expect(service.unifiedSearchService({ text: 'Capability' })).resolves.toBeDefined();
      await expect(service.readAll()).resolves.toBeDefined();
      await expect(service.read('project-memory')).resolves.toBeDefined();
      await expect(service.remember('Service text', 'project-memory')).resolves.toBeUndefined();
      await expect(service.search('Service', 'project-memory')).resolves.toBeDefined();
      await expect(service.findRelated!('Service', 'project-memory')).resolves.toBeDefined();
      await expect(
        service.scoreRelevant!({ currentTask: 'Service' }, 'project-memory'),
      ).resolves.toBeDefined();
      await expect(service.list('project-memory')).resolves.toBeDefined();
      await expect(service.forget('Service', 'project-memory')).resolves.toBeDefined();
      await expect(service.consolidate('project-memory')).resolves.toBeUndefined();
      await expect(service.clear('project-memory')).resolves.toBeUndefined();
      await expect(service.hygiene()).resolves.toBeDefined();
      await expect(service.retrieveForPath({ path: 'src/example.ts' })).resolves.toBeDefined();
      await expect(service.searchSage('Capability')).resolves.toBeDefined();
      await expect(service.searchSageWithBreakdown!('Capability')).resolves.toBeDefined();
      await expect(service.retrieveForAudience!({})).resolves.toBeDefined();
      await expect(service.graphFor(memory.id, 1, 10)).resolves.toBeDefined();
      await expect(service.verify(memory.id)).resolves.toBeDefined();
      await expect(service.listCandidates(true)).resolves.toBeDefined();
      const cand2 = await service.createCandidate({
        text: 'service candidate text',
        suggestedAction: 'investigate',
        reviewReason: 'service candidate',
        targetMemoryId: memory.id,
      });
      await expect(service.resolveCandidate(cand.id, 'archive', 'test')).resolves.toBeDefined();
      await expect(service.acceptCandidate(cand2.id)).resolves.toBeDefined();
      await expect(service.rejectCandidate(cand2.id, 'test reject')).resolves.toBe(false);
      const rem2 = await service.rememberSage({ text: 'service remember sage' });
      await expect(service.getSage(rem2.id)).resolves.toBeDefined();
      await expect(
        service.updateSage(rem2.id, { text: 'service updated text' }),
      ).resolves.toBeDefined();
      await expect(service.listSagePage({ limit: 5 })).resolves.toBeDefined();
      await expect(
        service.deleteSage(rem2.id, 'service cleanup', { force: true }),
      ).resolves.toBeUndefined();
      await expect(service.recoverSage(rem2.id)).resolves.toBeDefined();
      await expect(service.backfillRecoverable({ dryRun: true })).resolves.toBeDefined();
      await expect(service.findMemoriesForFile('src/example.ts')).resolves.toBeDefined();
    } finally {
      await port.dispose();
    }
  });

  it('reports unavailable health for Error and non-Error failures', async () => {
    const first = new SqliteMemoryPort({ projectRoot: 'health-error' });
    first.initialize = vi.fn(async () => {
      throw new Error('database failed');
    });
    await expect(first.health()).resolves.toEqual({
      status: 'unavailable',
      backend: 'sqlite',
      details: { error: 'database failed' },
    });

    const second = new SqliteMemoryPort({ projectRoot: 'health-string' });
    second.initialize = vi.fn(async () => {
      throw 'database failed as text';
    });
    await expect(second.health()).resolves.toEqual({
      status: 'unavailable',
      backend: 'sqlite',
      details: { error: 'database failed as text' },
    });
  });

  it('exercises createProjectSageMemoryPort factory across both inline and remote branches', () => {
    // Default test env -> SqliteMemoryPort
    const inlinePort = createProjectSageMemoryPort({ projectRoot: 'D:/repo' });
    expect(inlinePort).toBeInstanceOf(SqliteMemoryPort);

    // Production non-test env -> ProjectSageMemoryPort
    const savedVitest = process.env['VITEST'];
    const savedWorker = process.env['VITEST_WORKER_ID'];
    const savedNodeEnv = process.env['NODE_ENV'];
    const savedInline = process.env['WRONGSTACK_SAGE_INLINE'];
    try {
      delete process.env['VITEST'];
      delete process.env['VITEST_WORKER_ID'];
      process.env['WRONGSTACK_SAGE_INLINE'] = '0';
      process.env['NODE_ENV'] = 'production';

      const remotePort = createProjectSageMemoryPort({ projectRoot: 'D:/repo' });
      expect(remotePort).toBeInstanceOf(ProjectSageMemoryPort);
    } finally {
      if (savedVitest !== undefined) process.env['VITEST'] = savedVitest;
      else delete process.env['VITEST'];
      if (savedWorker !== undefined) process.env['VITEST_WORKER_ID'] = savedWorker;
      else delete process.env['VITEST_WORKER_ID'];
      if (savedNodeEnv !== undefined) process.env['NODE_ENV'] = savedNodeEnv;
      else delete process.env['NODE_ENV'];
      if (savedInline !== undefined) process.env['WRONGSTACK_SAGE_INLINE'] = savedInline;
      else delete process.env['WRONGSTACK_SAGE_INLINE'];
    }
  });
});

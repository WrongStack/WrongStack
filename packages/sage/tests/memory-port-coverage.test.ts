import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MemoryCapability, MemoryStore } from '@wrongstack/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSqliteMemoryPort,
  getSageRetrieval,
  getSageService,
  getSageSurface,
  LegacyMemoryPortAdapter,
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

  it('exposes the complete service capability through its typed adapter', () => {
    const port = new SqliteMemoryPort({ projectRoot: 'complete-service' });
    const service = getSageService(port);
    expect(service).toBeDefined();
    expect(service).not.toBe(port);
    expect(service?.recoverSage).toEqual(expect.any(Function));
    expect(service?.backfillRecoverable).toEqual(expect.any(Function));
    expect(service?.findMemoriesForFile).toEqual(expect.any(Function));
  });
});

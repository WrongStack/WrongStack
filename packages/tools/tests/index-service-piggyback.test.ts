/**
 * P2.5 regression: `searchService` piggybacks a minimal index summary
 * (`{ totalFiles, lastIndexed }`) on search responses — but ONLY when the
 * search yields zero hits. Hit responses omit it: they already prove the
 * index exists, and the extra payload would ride every search over IPC.
 *
 * Drives the REAL searchService against a REAL IndexStore (the worker-src
 * suite mocks it, so this contract had no unmocked coverage — Chimera M).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { searchService } from '../src/codebase-index/index-service.js';
import { IndexStore, indexStorePool } from '../src/codebase-index/writer.js';

const roots: string[] = [];

afterAll(() => {
  // searchService acquires a POOLED store; the pool keeps a warm connection
  // to index.db after release, and an open handle blocks rmSync on Windows.
  indexStorePool.closeAll();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeIndex(): { projectRoot: string; indexDir: string } {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wstack-piggyback-'));
  roots.push(projectRoot);
  const indexDir = path.join(projectRoot, '.idx');
  return { projectRoot, indexDir };
}

function symbolRow(n: number) {
  return {
    id: 0,
    lang: 'ts' as const,
    kind: 'function' as const,
    name: `resolver_${n}`,
    file: `src/file_${n}.ts`,
    line: n + 1,
    col: 1,
    signature: '',
    docComment: '',
    scope: '',
    text: `resolver_${n}`,
  };
}

describe('P2.5 zero-hit indexSummary piggyback (searchService)', () => {
  it('attaches indexSummary on a zero-hit query and reflects the persisted index', async () => {
    const { projectRoot, indexDir } = makeIndex();
    const store = new IndexStore(projectRoot, { indexDir });
    try {
      // commitBatch (not insertSymbols) — the summary's totalFiles counts
      // `files` rows, which only the file-writing paths create.
      store.commitBatch(
        [
          {
            file: 'src/file_1.ts',
            lang: 'ts',
            symbols: [symbolRow(1)],
            refs: [],
            mtimeMs: Date.now(),
            symbolCount: 1,
          },
          {
            file: 'src/file_2.ts',
            lang: 'ts',
            symbols: [symbolRow(2)],
            refs: [],
            mtimeMs: Date.now(),
            symbolCount: 1,
          },
        ],
        { deleteForFiles: ['src/file_1.ts', 'src/file_2.ts'] },
      );
      store.setLastIndexed(12345);

      const miss = await searchService({
        projectRoot,
        indexDir,
        query: 'nothing_matches_this',
        limit: 20,
      });
      expect(miss.total).toBe(0);
      expect(miss.results).toEqual([]);
      expect(miss.indexSummary).toBeDefined();
      expect(miss.indexSummary?.totalFiles).toBeGreaterThan(0);
      expect(miss.indexSummary?.lastIndexed).toBe(12345);
    } finally {
      store.close();
    }
  });

  it('omits indexSummary on hit responses (no payload on every search)', async () => {
    const { projectRoot, indexDir } = makeIndex();
    const store = new IndexStore(projectRoot, { indexDir });
    try {
      store.commitBatch(
        [
          {
            file: 'src/file_1.ts',
            lang: 'ts',
            symbols: [symbolRow(1)],
            refs: [],
            mtimeMs: Date.now(),
            symbolCount: 1,
          },
        ],
        { deleteForFiles: ['src/file_1.ts'] },
      );
      const hit = await searchService({ projectRoot, indexDir, query: 'resolver', limit: 20 });
      expect(hit.total).toBeGreaterThan(0);
      expect(hit.indexSummary).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('reports an empty-but-present index honestly on a fresh store', async () => {
    const { projectRoot, indexDir } = makeIndex();
    const store = new IndexStore(projectRoot, { indexDir });
    try {
      const miss = await searchService({ projectRoot, indexDir, query: 'anything', limit: 20 });
      expect(miss.total).toBe(0);
      expect(miss.indexSummary).toEqual({ totalFiles: 0, lastIndexed: null });
    } finally {
      store.close();
    }
  });
});

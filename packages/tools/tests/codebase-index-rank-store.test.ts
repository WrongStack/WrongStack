import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  aggregateFileRank,
  buildWiringGraph,
  pageRank,
  RANK_VERSION,
  RANK_VERSION_KEY,
  runGraphRankPass,
  shouldRefreshRanks,
  toSymbolRankRows,
} from '../src/codebase-index/index.js';
import type {
  Symbol as IndexSymbol,
  Ref,
  SymbolKind,
  SymbolLang,
} from '../src/codebase-index/schema.js';
import { IndexStore } from '../src/codebase-index/writer.js';

let store: IndexStore;
let tmpDir: string;
let indexDir: string;

const sym = (over: Partial<IndexSymbol> & { name: string; file: string }): IndexSymbol => ({
  id: 0,
  lang: (over.lang ?? 'ts') as SymbolLang,
  kind: (over.kind ?? 'function') as SymbolKind,
  name: over.name,
  file: over.file,
  line: over.line ?? 1,
  col: over.col ?? 0,
  signature: over.signature ?? `${over.name}()`,
  docComment: over.docComment ?? '',
  scope: over.scope ?? '',
  text: over.text ?? `${over.name} function`,
});

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-rank-'));
  indexDir = path.join(tmpDir, '.idx');
  store = new IndexStore(tmpDir, { indexDir });
});

afterEach(async () => {
  store.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/**
 * Seed a tiny repo: `hub.ts` exports one symbol that both leaves call.
 * Returns the assigned symbol ids by name.
 */
function seedHubAndLeaves(): Map<string, number> {
  const inserted = store.insertSymbols([
    sym({ name: 'hub', file: 'hub.ts' }),
    sym({ name: 'leafA', file: 'a.ts' }),
    sym({ name: 'leafB', file: 'b.ts' }),
  ]);
  const ids = new Map(inserted.map((s) => [s.name, s.id]));
  // Refs are stored per declaring symbol, so each leaf writes its own row.
  for (const [leaf, line] of [
    ['leafA', 3],
    ['leafB', 4],
  ] as const) {
    const fromId = ids.get(leaf) as number;
    const refs: Ref[] = [
      {
        fromId,
        toName: 'hub',
        toId: ids.get('hub') as number,
        callType: 'call',
        line,
        lang: 'ts',
      },
    ];
    store.insertRefs(fromId, refs);
  }
  return ids;
}

describe('rank schema is additive', () => {
  it('creates both rank tables on a fresh index', () => {
    const db = new DatabaseSync(path.join(indexDir, 'index.db'), { readOnly: true });
    try {
      const names = (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%rank'")
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(names.sort()).toEqual(['file_rank', 'symbol_rank']);
    } finally {
      db.close();
    }
  });

  it('adds the tables to an index written before the layer existed, keeping its rows', () => {
    // Simulate the pre-rank on-disk shape: same SCHEMA_VERSION, no rank tables.
    seedHubAndLeaves();
    store.close();
    const raw = new DatabaseSync(path.join(indexDir, 'index.db'));
    raw.exec('DROP TABLE IF EXISTS symbol_rank; DROP TABLE IF EXISTS file_rank;');
    raw.close();

    // Reopening must repair the schema WITHOUT dropping the existing index —
    // a SCHEMA_VERSION bump would have wiped these rows instead.
    store = new IndexStore(tmpDir, { indexDir });
    expect(store.getAllSymbols()).toHaveLength(3);
    expect(store.getRankCounts()).toEqual({ symbols: 0, files: 0 });
  });
});

describe('rank persistence', () => {
  it('round-trips symbol and file ranks through SQLite', () => {
    const ids = seedHubAndLeaves();
    const graph = buildWiringGraph(store.getAllResolvedRefs());
    const symbolRows = toSymbolRankRows(graph, pageRank(graph));
    const fileOf = new Map(store.getAllSymbols().map((s) => [s.id, s.file]));
    const fileRows = aggregateFileRank(symbolRows, fileOf);

    store.replaceRanks(symbolRows, fileRows);

    expect(store.getRankCounts()).toEqual({ symbols: 3, files: 3 });
    const topSymbol = store.getTopSymbolRanks(1)[0];
    expect(topSymbol?.symbolId).toBe(ids.get('hub'));
    expect(topSymbol?.rank).toBeCloseTo(1, 10);
    // Both leaves reference the hub, so its in-degree is 2.
    expect(topSymbol?.inDeg).toBe(2);

    expect(store.getTopFileRanks(1)[0]?.file).toBe('hub.ts');
    expect(store.getFileRankMap().get('hub.ts')).toBeCloseTo(1, 10);
  });

  it('replaces rather than accumulates on a second write', () => {
    seedHubAndLeaves();
    store.replaceRanks(
      [{ symbolId: 1, rank: 1, inDeg: 0, outDeg: 0 }],
      [{ file: 'x.ts', rank: 1, inDeg: 0, outDeg: 0 }],
    );
    store.replaceRanks(
      [{ symbolId: 2, rank: 1, inDeg: 0, outDeg: 0 }],
      [{ file: 'y.ts', rank: 1, inDeg: 0, outDeg: 0 }],
    );
    expect(store.getRankCounts()).toEqual({ symbols: 1, files: 1 });
    expect(store.getTopFileRanks(5).map((r) => r.file)).toEqual(['y.ts']);
  });

  it('clears rank tables with the rest of the index', () => {
    seedHubAndLeaves();
    store.replaceRanks(
      [{ symbolId: 1, rank: 1, inDeg: 0, outDeg: 0 }],
      [{ file: 'x.ts', rank: 1, inDeg: 0, outDeg: 0 }],
    );
    store.clearAll();
    expect(store.getRankCounts()).toEqual({ symbols: 0, files: 0 });
  });
});

describe('runGraphRankPass', () => {
  it('computes, persists and stamps the data version', () => {
    const ids = seedHubAndLeaves();
    const errors: string[] = [];
    const result = runGraphRankPass(store, errors);

    expect(errors).toEqual([]);
    expect(result.computed).toBe(true);
    expect(result.symbols).toBe(3);
    expect(store.getMetadata(RANK_VERSION_KEY)).toBe(RANK_VERSION);
    expect(store.getTopSymbolRanks(1)[0]?.symbolId).toBe(ids.get('hub'));
  });

  it('records the failure in errors instead of failing the index run', () => {
    seedHubAndLeaves();
    const broken = {
      getAllResolvedRefs() {
        throw new Error('refs unavailable');
      },
    } as unknown as IndexStore;
    const errors: string[] = [];

    const result = runGraphRankPass(broken, errors);

    expect(result.computed).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('refs unavailable');
  });
});

describe('shouldRefreshRanks', () => {
  it('always refreshes a full-project run', () => {
    expect(shouldRefreshRanks(store, {})).toBe(true);
  });

  it('always refreshes a forced run', () => {
    expect(shouldRefreshRanks(store, { files: ['a.ts'], force: true })).toBe(true);
  });

  it('refreshes a targeted run when the data version is missing', () => {
    expect(shouldRefreshRanks(store, { files: ['a.ts'] })).toBe(true);
  });

  it('refreshes a targeted run when the tables are empty', () => {
    store.setMetadata(RANK_VERSION_KEY, RANK_VERSION);
    expect(shouldRefreshRanks(store, { files: ['a.ts'] })).toBe(true);
  });

  it('skips a small targeted run once ranks exist', () => {
    seedHubAndLeaves();
    runGraphRankPass(store, []);
    // One edited file barely moves any score; recomputing the whole graph for
    // it is the waste this gate exists to prevent.
    expect(shouldRefreshRanks(store, { files: ['a.ts'] })).toBe(false);
  });

  it('refreshes a bulk targeted run, which is a full run in disguise', () => {
    seedHubAndLeaves();
    runGraphRankPass(store, []);
    const many = Array.from({ length: 40 }, (_, i) => `f${i}.ts`);
    expect(shouldRefreshRanks(store, { files: many })).toBe(true);
  });
});

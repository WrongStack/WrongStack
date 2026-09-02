import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  Symbol as IndexSymbol,
  SymbolKind,
  SymbolLang,
} from '../src/codebase-index/schema.js';
import {
  codebaseIndexDirOverride,
  IndexStore,
  resolveIndexDir,
} from '../src/codebase-index/writer.js';
import {
  indexedFileMatchArgs,
  inListChunks,
  ladderChunkSizes,
  matchesIndexedPackageFilter,
  padToInBucket,
  posixIndexPath,
} from '../src/codebase-index/writer-helpers.js';

let store: IndexStore;
let tmpDir: string;

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
  text: over.text ?? `${over.name} ${over.kind ?? 'function'}`,
});

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-writer-'));
  store = new IndexStore(tmpDir, { indexDir: path.join(tmpDir, '.idx') });
});
afterEach(async () => {
  store.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('indexed file filter matching', () => {
  it('normalizes slashes and builds a suffix LIKE pattern', () => {
    expect(posixIndexPath('.\\src\\calc.ts')).toBe('src/calc.ts');
    const [, posix, like] = indexedFileMatchArgs('src/calc.ts');
    expect(posix).toBe('src/calc.ts');
    expect(like).toBe('%/src/calc.ts');
  });

  it('treats a path fragment as a package filter', () => {
    expect(matchesIndexedPackageFilter('C:\\proj\\src\\calc.ts', 'fixture', 'src')).toBe(true);
    expect(matchesIndexedPackageFilter('C:\\proj\\src\\calc.ts', 'fixture', 'fixture')).toBe(true);
    expect(matchesIndexedPackageFilter('C:\\proj\\src\\calc.ts', 'fixture', 'other')).toBe(false);
  });
});

describe('IndexStore search filters', () => {
  beforeEach(() => {
    store.insertSymbols(
      [
        sym({
          name: 'UserClass',
          kind: 'class',
          lang: 'ts',
          file: '/p/user.ts',
          docComment: 'entity docs',
        }),
        sym({
          name: 'helperFn',
          kind: 'function',
          lang: 'ts',
          file: '/p/util.ts',
          text: 'helperFn util',
        }),
        sym({
          name: 'goThing',
          kind: 'function',
          lang: 'go',
          file: '/p/main.go',
          text: 'goThing main',
        }),
      ],
      1,
    );
  });

  it('filters by kind', () => {
    const r = store.search('', { kind: 'class' });
    expect(r.every((x) => x.kind === 'class')).toBe(true);
    expect(r.length).toBe(1);
  });

  it('filters by lang', () => {
    const r = store.search('', { lang: 'go' });
    expect(r.map((x) => x.name)).toEqual(['goThing']);
  });

  it('filters by file substring', () => {
    const r = store.search('', { file: 'util' });
    expect(r.map((x) => x.name)).toEqual(['helperFn']);
  });

  it('maps an lspKind to an internal kind', () => {
    const r = store.search('', { lspKind: 5 }); // 5 = Class
    expect(r.map((x) => x.name)).toEqual(['UserClass']);
  });

  it('returns nothing for an lspKind with no internal mapping', () => {
    expect(store.search('', { lspKind: 15 })).toEqual([]); // 15 = String → null
  });

  it('matches text tokens in the query', () => {
    // P4: the searchable "text" domain is now name + signature + doc_comment.
    const r = store.search('entity');
    expect(r.map((x) => x.name)).toContain('UserClass');
  });
});

describe('IndexStore searchRanked filters', () => {
  beforeEach(() => {
    store.insertSymbols(
      [
        sym({
          name: 'parseConfig',
          kind: 'function',
          lang: 'ts',
          file: '/p/cfg.ts',
          text: 'parseConfig config loader',
        }),
        sym({
          name: 'ConfigType',
          kind: 'type',
          lang: 'ts',
          file: '/p/types.ts',
          text: 'ConfigType config shape',
        }),
      ],
      1,
    );
  });

  it('returns nothing when the lspKind has no mapping', () => {
    const r = store.searchRanked('config', { lspKind: 15 }, 10);
    expect(r.results).toEqual([]);
    expect(r.total).toBe(0);
  });

  it('applies kind/lang/file filters', () => {
    const byKind = store.searchRanked('config', { kind: 'function' }, 10);
    expect(byKind.results.every((x) => x.kind === 'function')).toBe(true);
    const byLang = store.searchRanked('config', { lang: 'ts' }, 10);
    expect(byLang.total).toBeGreaterThan(0);
    const byFile = store.searchRanked('config', { file: 'types' }, 10);
    expect(byFile.results.every((x) => x.file.includes('types'))).toBe(true);
  });

  it('maps an lspKind to an internal kind (FTS path)', () => {
    const r = store.searchRanked('config', { lspKind: 12 }, 10); // 12 = Function
    expect(r.results.every((x) => x.kind === 'function')).toBe(true);
  });

  it('getAllIndexable returns id/text rows', () => {
    const rows = store.getAllIndexable();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toHaveProperty('text');
  });
});

describe('IndexStore refs', () => {
  let callerId: number;
  let calleeId: number;

  beforeEach(() => {
    store.insertSymbols(
      [sym({ name: 'caller', file: '/p/a.ts' }), sym({ name: 'callee', file: '/p/b.ts' })],
      1,
    );
    const all = store.search('', {});
    callerId = all.find((s) => s.name === 'caller')!.id;
    calleeId = all.find((s) => s.name === 'callee')!.id;
  });

  it('inserts, resolves, and queries references by name', () => {
    store.insertRefs(callerId, [{ fromId: callerId, toName: 'callee', callType: 'call', line: 3 }]);
    const resolved = store.resolveRefs();
    expect(resolved).toBeGreaterThanOrEqual(1);

    const from = store.findRefsFrom(callerId);
    expect(from.map((r) => r.toName)).toContain('callee');

    const to = store.findRefsTo(calleeId);
    expect(to.some((r) => r.fromId === callerId)).toBe(true);
  });

  it('insertRefs with an empty list clears existing refs only', () => {
    store.insertRefs(callerId, [{ fromId: callerId, toName: 'callee', callType: 'call', line: 1 }]);
    store.insertRefs(callerId, []); // delete-only path
    expect(store.findRefsFrom(callerId)).toEqual([]);
  });

  it('re-resolves inbound refs when a target file is replaced', () => {
    store.insertRefs(callerId, [{ fromId: callerId, toName: 'callee', callType: 'call', line: 3 }]);
    store.resolveRefs();
    const previousTarget = store.findRefsFrom(callerId)[0]?.toId;

    const replacement = store.commitBatch(
      [
        {
          file: '/p/b.ts',
          lang: 'ts',
          symbols: [sym({ name: 'callee', file: '/p/b.ts', line: 10 })],
          refs: [],
          mtimeMs: 2,
          symbolCount: 1,
        },
      ],
      { deleteForFiles: ['/p/b.ts'] },
    );

    expect(replacement[0]?.id).not.toBe(previousTarget);
    expect(store.findRefsFrom(callerId)[0]?.toId).toBe(replacement[0]?.id);
  });

  it('resolves existing unresolved refs when a matching symbol arrives', () => {
    store.insertRefs(callerId, [
      { fromId: callerId, toName: 'futureTarget', callType: 'call', line: 4 },
    ]);
    expect(store.findRefsFrom(callerId)[0]?.toId).toBeUndefined();

    const inserted = store.commitBatch([
      {
        file: '/p/future.ts',
        lang: 'ts',
        symbols: [sym({ name: 'futureTarget', file: '/p/future.ts' })],
        refs: [],
        mtimeMs: 1,
        symbolCount: 1,
      },
    ]);

    expect(store.findRefsFrom(callerId)[0]?.toId).toBe(inserted[0]?.id);
  });

  it('scopes name resolution to the ref language family across collisions', () => {
    // Same name in two families: the ts ref must bind to the TS symbol, the
    // go ref to the Go symbol — never cross-family.
    const inserted = store.insertSymbols([
      sym({ name: 'Config', lang: 'ts', file: '/p/ts-config.ts' }),
      sym({ name: 'Config', lang: 'go', file: '/p/go-config.go' }),
    ]);
    const tsConfig = inserted[0]!;
    const goConfig = inserted[1]!;
    store.insertRefs(callerId, [
      { fromId: callerId, toName: 'Config', callType: 'type_ref', line: 5, lang: 'ts' },
      { fromId: callerId, toName: 'Config', callType: 'call', line: 6, lang: 'go' },
    ]);
    store.resolveRefs();

    const byTs = store.findRefsFrom(callerId).find((r) => r.line === 5)!;
    const byGo = store.findRefsFrom(callerId).find((r) => r.line === 6)!;
    expect(byTs.toId).toBe(tsConfig.id);
    expect(byGo.toId).toBe(goConfig.id);
    expect(tsConfig.id).not.toBe(goConfig.id);
  });

  it('resolves a language-less ref deterministically to the global minimum id', () => {
    // A ref without a lang hits the ('', '*') wildcard row and matches every
    // family. Both the UPDATE-FROM fast path and the <3.33 fallback must agree
    // on global MIN(id) — assert the id of the first-inserted symbol.
    const tsConfig = store.insertSymbols([
      sym({ name: 'Config', lang: 'ts', file: '/p/ts-config.ts' }),
      sym({ name: 'Config', lang: 'go', file: '/p/go-config.go' }),
    ])[0]!;
    store.insertRefs(callerId, [{ fromId: callerId, toName: 'Config', callType: 'call', line: 7 }]);
    store.resolveRefs();

    expect(store.findRefsFrom(callerId)[0]?.toId).toBe(tsConfig.id);
  });

  it('deleteRefsForFile removes refs originating in that file', () => {
    store.insertRefs(callerId, [{ fromId: callerId, toName: 'callee', callType: 'call', line: 1 }]);
    store.deleteRefsForFile('/p/a.ts');
    expect(store.findRefsFrom(callerId)).toEqual([]);
  });

  it('deleteRefsForFile is a no-op for a file with no symbols', () => {
    expect(() => store.deleteRefsForFile('/p/nonexistent.ts')).not.toThrow();
  });
});

describe('IndexStore CodeMap graphs', () => {
  const coreFile = '/workspace/packages/core/src/agent.ts';
  const siblingFile = '/workspace/packages/core/src/sibling.ts';
  const toolsFile = '/workspace/packages/tools/src/read.ts';

  beforeEach(() => {
    store.insertSymbols(
      [
        sym({ name: 'runAgent', file: coreFile, line: 10, signature: 'function runAgent(): void' }),
        sym({ name: 'sibling', file: siblingFile, line: 5 }),
        sym({
          name: 'readFile',
          file: toolsFile,
          line: 20,
          signature: 'function readFile(path: string): string',
        }),
      ],
      1,
    );
    const all = store.search('', {});
    const callerId = all.find((symbol) => symbol.name === 'runAgent')!.id;
    // Import refs carry the specifier in `module` and its resolved target in
    // `toFile`. `toName` holds the imported *symbol*, not the module path —
    // the indexer's module-resolution pass is what fills `toFile`, so a store
    // test supplies it directly rather than expecting the store to re-derive it.
    store.insertRefs(callerId, [
      { fromId: callerId, toName: 'readFile', callType: 'call', line: 11, lang: 'ts' },
      {
        fromId: callerId,
        toName: 'sibling',
        callType: 'import',
        line: 1,
        lang: 'ts',
        module: './sibling.js',
        toFile: siblingFile,
      },
      {
        fromId: callerId,
        toName: 'readFile',
        callType: 'import',
        line: 2,
        lang: 'ts',
        module: '@wrongstack/tools',
        toFile: toolsFile,
      },
    ]);
    store.resolveRefs();
  });

  it('keeps direct external files when a package graph is opened', () => {
    const graph = store.getFileGraph('@wrongstack/core');

    expect(graph.nodes.find((node) => node.file === coreFile)?.external).toBe(false);
    expect(graph.nodes.find((node) => node.file === toolsFile)?.external).toBe(true);
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: `file:${coreFile}`,
          target: `file:${toolsFile}`,
          refType: 'call',
        }),
        expect.objectContaining({
          source: `file:${coreFile}`,
          target: `file:${siblingFile}`,
          refType: 'import',
        }),
      ]),
    );
  });

  it('builds package edges from resolved cross-package imports', () => {
    const graph = store.getPackageGraph();
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'pkg:@wrongstack/core',
          target: 'pkg:@wrongstack/tools',
          weight: 2,
        }),
      ]),
    );
  });

  it('resolves a project-relative file filter for the symbol graph', () => {
    const graph = store.getSymbolGraph('packages/core/src/agent.ts');
    expect(graph.nodes.some((node) => node.label === 'readFile' && node.external)).toBe(true);
    expect(graph.nodes.some((node) => node.file === coreFile && node.external === false)).toBe(
      true,
    );
  });

  it('accepts a path fragment for the file graph', () => {
    const graph = store.getFileGraph('packages/core');
    expect(graph.nodes.find((node) => node.file === coreFile)?.external).toBe(false);
  });

  it('materializes cross-file symbol neighbours with declaration metadata', () => {
    const graph = store.getSymbolGraph(coreFile);
    const external = graph.nodes.find((node) => node.label === 'readFile');

    expect(external).toEqual(
      expect.objectContaining({
        file: toolsFile,
        line: 20,
        lang: 'ts',
        signature: 'function readFile(path: string): string',
        external: true,
      }),
    );
    // `import { readFile } … ` followed by a `readFile()` call is two distinct
    // relations to the same symbol, so the symbol graph carries both.
    expect(graph.edges.map((edge) => edge.refType).sort()).toEqual(['call', 'import']);
    expect(graph.edges.every((edge) => graph.nodes.some((node) => node.id === edge.target))).toBe(
      true,
    );
  });
});

describe('IndexStore file ops + ranked fallback', () => {
  it('compacts only when the configured size and free-page thresholds allow it', () => {
    store.insertSymbols(
      Array.from({ length: 100 }, (_, index) =>
        sym({ name: `Temporary${index}`, file: `/p/temp-${index % 5}.ts` }),
      ),
    );
    store.clearAll();

    expect(store.compactIfNeeded({ minBytes: Number.MAX_SAFE_INTEGER })).toBe(false);
    expect(store.compactIfNeeded({ minBytes: 0, minFreeRatio: 0 })).toBe(true);
  });

  it('deleteFile removes symbols, refs, and the file row', () => {
    const inserted = store.insertSymbols([sym({ name: 'gone', file: '/p/gone.ts' })]);
    const id = inserted[0].id;
    store.upsertFile({
      file: '/p/gone.ts',
      mtimeMs: 1,
      lang: 'ts',
      symbolCount: 1,
      lastIndexed: 1,
    });
    store.insertRefs(id, [{ fromId: id, toName: 'x', callType: 'call', line: 1 }]);
    store.deleteFile('/p/gone.ts');
    expect(store.search('', { file: 'gone' })).toEqual([]);
    expect(store.getFileMeta('/p/gone.ts')).toBeNull();
  });

  it('getFileMeta returns null for an unknown file', () => {
    expect(store.getFileMeta('/p/never.ts')).toBeNull();
  });

  it('searchRanked with an empty query lists candidates via the fallback', () => {
    store.insertSymbols([sym({ name: 'Listed', kind: 'class', file: '/p/l.ts' })], 1);
    const r = store.searchRanked('   ', undefined, 10); // whitespace → no tokens → fallback
    expect(r.total).toBeGreaterThan(0);
    expect(r.results.length).toBeGreaterThan(0);
  });

  it('searchRanked fallback returns empty when there are no candidates', () => {
    // Whitespace query → fallback path; empty store → zero candidates → early out.
    const r = store.searchRanked('   ', undefined, 10);
    expect(r).toEqual({ results: [], total: 0 });
  });

  it('searchRanked returns empty when nothing matches', () => {
    store.insertSymbols([sym({ name: 'present', kind: 'function', file: '/p/f.ts' })], 1);
    const miss = store.searchRanked('zzznomatchzzz', undefined, 10);
    expect(miss.results).toEqual([]);
    expect(miss.total).toBe(0);
  });
});

describe('writer helpers', () => {
  it('resolveIndexDir honours an explicit override', () => {
    expect(resolveIndexDir('/p', '/custom/idx')).toBe('/custom/idx');
  });

  it('resolveIndexDir falls back to the per-project location', () => {
    expect(resolveIndexDir('/p').length).toBeGreaterThan(0); // resolved per-project dir
  });

  it('codebaseIndexDirOverride reads a string from meta, else undefined', () => {
    expect(codebaseIndexDirOverride({ meta: { codebaseIndexDir: '/x' } })).toBe('/x');
    expect(codebaseIndexDirOverride({ meta: { codebaseIndexDir: 42 } })).toBeUndefined();
    expect(codebaseIndexDirOverride({})).toBeUndefined();
  });
});

describe('IndexStore.runWithRetry', () => {
  it('returns the callback result on success', () => {
    expect(store.runWithRetry(() => 7)).toBe(7);
  });

  it('rethrows a non-lock error immediately', () => {
    expect(() =>
      store.runWithRetry(() => {
        throw new Error('not a lock');
      }),
    ).toThrow('not a lock');
  });

  it('rethrows a non-Error throw immediately', () => {
    expect(() =>
      store.runWithRetry(() => {
        throw 'string failure';
      }),
    ).toThrow();
  });

  it('retries a lock error then succeeds', () => {
    let calls = 0;
    const out = store.runWithRetry(() => {
      calls++;
      if (calls === 1) throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' });
      return 'ok';
    });
    expect(out).toBe('ok');
    expect(calls).toBe(2);
  });

  it('wraps a persistent lock conflict in a LockError after exhausting retries', () => {
    expect(() =>
      store.runWithRetry(() => {
        throw Object.assign(new Error('locked'), { sqliteCode: 6 }); // numeric SQLITE_LOCKED
      }),
    ).toThrow(/lock conflict after/);
  });

  it('detects a lock error reported only in the message', () => {
    let n = 0;
    const out = store.runWithRetry(() => {
      n++;
      if (n === 1) throw new Error('database is SQLITE_BUSY right now'); // no code, message only
      return 'recovered';
    });
    expect(out).toBe('recovered');
  });
});

describe('IndexStore stats and clear', () => {
  it('reports byLang/byKind breakdowns and a positive size', () => {
    store.insertSymbols(
      [
        sym({ name: 'A', kind: 'class', lang: 'ts', file: '/p/a.ts' }),
        sym({ name: 'B', kind: 'function', lang: 'go', file: '/p/b.go' }),
      ],
      1,
    );
    store.upsertFile({
      file: '/p/a.ts',
      mtimeMs: 1,
      lang: 'ts',
      symbolCount: 1,
      lastIndexed: 2000,
    });
    store.setLastIndexed(123);
    const stats = store.getStats();
    expect(stats.totalSymbols).toBe(2);
    expect(stats.byLang.ts).toBeGreaterThanOrEqual(1);
    expect(stats.byKind.class).toBeGreaterThanOrEqual(1);
    expect(stats.sizeBytes).toBeGreaterThan(0);
    expect(stats.lastIndexed).toBe(123);
  });

  it('clearAll empties the index', () => {
    store.insertSymbols([sym({ name: 'X', file: '/p/x.ts' })], 1);
    store.clearAll();
    expect(store.getStats().totalSymbols).toBe(0);
  });
});

describe('IndexStore search LIKE escaping', () => {
  beforeEach(() => {
    store.insertSymbols(
      [
        sym({ name: 'fn', kind: 'function', file: '/p/a%b.ts' }),
        sym({ name: 'fn', kind: 'function', file: '/p/a_b.ts' }),
        sym({ name: 'fn', kind: 'function', file: '/p/aXb.ts' }),
      ],
      1,
    );
  });

  it('matches file paths literally (% and _ are not wildcards)', () => {
    // Each file filter is matched *literally* now: `%` no longer matches anything.
    const wildcardPct = store.search('', { file: 'a%b' }).map((s) => s.file);
    expect(wildcardPct).toEqual(['/p/a%b.ts']);

    const wildcard_ = store.search('', { file: 'a_b' }).map((s) => s.file);
    expect(wildcard_).toEqual(['/p/a_b.ts']);
  });
});

describe('IndexStore searchRanking exact/prefix boost', () => {
  beforeEach(() => {
    store.insertSymbols(
      [
        sym({ name: 'handle', kind: 'function', file: '/p/handle.ts' }),
        sym({ name: 'handleRequest', kind: 'function', file: '/p/handle-request.ts' }),
        sym({ name: 'unrelatedThing', kind: 'function', file: '/p/unrelated.ts' }),
      ],
      1,
    );
  });

  it('ranks exact name ahead of prefix', () => {
    const r = store.searchRanked('handle', undefined, 10);
    expect(r.results.map((s) => s.name)).toEqual(['handle', 'handleRequest']);
  });

  it('clamps the limit into 1..100 even on bogus inputs', () => {
    store.searchRanked('handle', undefined, 1000);
    store.searchRanked('handle', undefined, -3);
    store.searchRanked('handle', undefined, Number.NaN);
    // No throw, and a sensible result still produced.
    const r = store.searchRanked('handle', undefined, 0);
    expect(r.results.length).toBeLessThanOrEqual(100);
  });
});

// ─── FTS backfill ─────────────────────────────────────────────────────────

describe('FTS backfill drift detection', () => {
  let ftsDir: string;
  beforeEach(async () => {
    ftsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-fts-backfill-'));
  });
  afterEach(async () => {
    await fs.rm(ftsDir, { recursive: true, force: true });
  });
  it('backfills the FTS index when reopening detects drift between symbols and symbols_fts', () => {
    const idxDir = path.join(ftsDir, '.codebase-index');
    // Phase 1: populate
    const a = new IndexStore(ftsDir, { indexDir: idxDir });
    a.insertSymbols([
      sym({ name: 'Alpha', kind: 'function', file: '/p/a.ts' }),
      sym({ name: 'Beta', kind: 'function', file: '/p/b.ts' }),
    ]);
    const before = a.searchRanked('Alpha', undefined, 10);
    expect(before.total).toBeGreaterThan(0);
    const storePath = path.join(idxDir, 'index.db');
    a.close();

    // Phase 2: simulate drift by deleting FTS rows directly
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void };
    };
    const raw = new DatabaseSync(storePath);
    try {
      raw.exec('DELETE FROM symbols_fts');
      raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      raw.close();
    }

    // Phase 3: reopen — initSchema detects drift and backfills
    const b = new IndexStore(ftsDir, { indexDir: idxDir });
    const after = b.searchRanked('Alpha', undefined, 10);
    expect(after.total).toBeGreaterThan(0);
    expect(after.results[0]?.name).toBe('Alpha');
    b.close();
  });
});

// ─── P4.12: fixed placeholder buckets ────────────────────────────────────────

describe('P4.12 statement-cache buckets', () => {
  it('ladderChunkSizes splits into powers of two, largest first, summing to total', () => {
    const sizes = ladderChunkSizes(1000, 450);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(1000);
    for (const s of sizes) expect(Number.isInteger(Math.log2(s))).toBe(true);
    for (const s of sizes) expect(s).toBeLessThanOrEqual(450);
    expect(ladderChunkSizes(0, 100)).toEqual([]);
    expect(ladderChunkSizes(1, 100)).toEqual([1]);
    expect(ladderChunkSizes(1024, 1024)).toEqual([1024]);
  });

  it('padToInBucket pads to the next power of two by repeating values[0]', () => {
    expect(padToInBucket([1])).toEqual([1]);
    expect(padToInBucket([1, 2, 3])).toEqual([1, 2, 3, 1]);
    expect(padToInBucket(['a', 'b'])).toEqual(['a', 'b']);
    expect(padToInBucket([1, 2, 3, 4, 5])).toHaveLength(8);
    expect(padToInBucket([1, 2, 3, 4, 5])[5]).toBe(1);
    // Original array is never mutated.
    const original = [1, 2, 3];
    padToInBucket(original);
    expect(original).toEqual([1, 2, 3]);
  });

  it('inListChunks keeps a fitting list one chunk and never lets padding cross the budget', () => {
    // Small list: padded bucket (4) fits under 900 → ONE chunk, one statement.
    expect(inListChunks(3, 900)).toEqual([3]);
    // 512 is already a power of two and fits → one chunk.
    expect(inListChunks(512, 900)).toEqual([512]);
    // 513 would pad to 1024 > 900: the fast path must NOT fire. The ladder
    // caps at the largest pow2 ≤ 900 (512), so every chunk pads to itself.
    const split = inListChunks(513, 900);
    expect(split).not.toEqual([513]);
    expect(split.reduce((a, b) => a + b, 0)).toBe(513);
    for (const take of split) {
      expect(take).toBeLessThanOrEqual(512);
      expect(Number.isInteger(Math.log2(take))).toBe(true);
    }
    // 900 (not a pow2) pads to 1024 → ladder; 880 pads to 1024 → ladder;
    // 768 is NOT a power of two (3×256) — nextPow2(768)=1024 > 900 → ladder.
    // The largest single-chunk case under 900 is 512 itself.
    expect(inListChunks(768, 900).length).toBeGreaterThan(1);
    expect(inListChunks(880, 900).length).toBeGreaterThan(1);
  });

  it('bulk inserts across many batch sizes stop growing the statement cache', async () => {
    const bucketRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-p412-'));
    const store = new IndexStore(bucketRoot);
    try {
      const cache = (store as unknown as { stmtCache: Map<string, unknown> }).stmtCache;
      const before = cache.size;
      // Insert prime-count batches — the worst case for `slice(i, i+n)`
      // chunking, since every final chunk length is distinct. With ladder
      // chunking the distinct SQL strings are bounded by log2(maxChunk).
      for (const n of [1, 3, 7, 13, 29, 61, 127, 251, 509]) {
        const rows = Array.from({ length: n }, (_, i) => ({
          id: 0,
          lang: 'ts' as const,
          kind: 'function' as const,
          name: `sym${i}_${n}`,
          file: 'src/bucket.ts',
          line: i + 1,
          col: 1,
          signature: '',
          docComment: '',
          scope: '',
          text: '',
        }));
        store.insertSymbols(rows);
      }
      const after = cache.size;
      // Old behavior: each batch size contributed ≥1 new SQL string per shape
      // (often two — full + remainder chunks). Ladder: bounded by ~10 sizes.
      // Allow generous headroom for unrelated statements, but the growth must
      // be sub-linear in the number of DISTINCT batch sizes (9 here).
      expect(after - before).toBeLessThanOrEqual(20);
    } finally {
      store.close();
      await fs.rm(bucketRoot, { recursive: true, force: true });
    }
  });
});

describe('IndexStore.optimizeFtsIfNeeded (P2 churn gate)', () => {
  it('records churn on inserts and deletes and stays gated below the threshold', () => {
    store.insertSymbols([
      sym({ name: 'alpha', file: '/w/a.ts' }),
      sym({ name: 'beta', file: '/w/a.ts' }),
    ]);
    expect(Number(store.getMetadata('fts_churn_since_maintain') ?? '0')).toBe(2);
    store.deleteFile('/w/a.ts');
    expect(Number(store.getMetadata('fts_churn_since_maintain') ?? '0')).toBe(4);
    // 4 rows of churn sit far below the 5,000-row floor: gated off, no reset.
    expect(store.optimizeFtsIfNeeded()).toBe(false);
    expect(Number(store.getMetadata('fts_churn_since_maintain') ?? '0')).toBe(4);
  });

  it('merges once churn crosses the gate, resets the counter, and keeps search working', () => {
    store.insertSymbols([
      sym({ name: 'gamma', file: '/w/b.ts' }),
      sym({ name: 'delta', file: '/w/b.ts' }),
    ]);
    store.setMetadata('fts_churn_since_maintain', '9000');
    expect(store.optimizeFtsIfNeeded()).toBe(true);
    expect(Number(store.getMetadata('fts_churn_since_maintain') ?? '-1')).toBe(0);
    const hits = store.search('gamma');
    expect(hits.some((h) => h.name === 'gamma')).toBe(true);
  });

  it('reclaims tombstoned FTS postings measurably (dbstat) when the gate runs', () => {
    const sig = 'x'.repeat(400);
    store.insertSymbols(
      Array.from({ length: 1200 }, (_, i) =>
        sym({ name: `bulk${i}`, file: '/w/bulk.ts', signature: sig }),
      ),
    );
    const dbPath = path.join(tmpDir, '.idx', 'index.db');
    const ftsDataKb = (): number => {
      const probe = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const row = probe
          .prepare(`SELECT SUM(pgsize)/1024.0 AS kb FROM dbstat WHERE name = 'symbols_fts_data'`)
          .get() as { kb: number };
        return row.kb;
      } finally {
        probe.close();
      }
    };
    const beforeDelete = ftsDataKb();
    store.deleteFile('/w/bulk.ts');
    const afterDelete = ftsDataKb();
    // All 1,200 rows are gone but their postings remain: FTS5 does not shrink
    // on delete, and neither VACUUM nor PRAGMA optimize would reclaim them.
    expect(afterDelete).toBeGreaterThanOrEqual(beforeDelete * 0.9);
    store.setMetadata('fts_churn_since_maintain', '9000');
    expect(store.optimizeFtsIfNeeded()).toBe(true);
    const afterOptimize = ftsDataKb();
    expect(afterOptimize).toBeLessThan(afterDelete * 0.5);
  });
});

describe('symbols.text deprecation (P4)', () => {
  it('drops the legacy text column on open and keeps reads and writes working', async () => {
    const legacyRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-p4-legacy-'));
    try {
      // Simulate a pre-P4 database: symbols still carrying the `text` column.
      // The .idx directory does not exist yet — IndexStore creates it, but the
      // legacy DB must be in place first.
      await fs.mkdir(path.join(legacyRoot, '.idx'), { recursive: true });
      const legacy = new DatabaseSync(path.join(legacyRoot, '.idx', 'index.db'));
      legacy.exec(`
        CREATE TABLE symbols (
          id INTEGER PRIMARY KEY,
          lang TEXT NOT NULL,
          kind TEXT NOT NULL,
          name TEXT NOT NULL,
          file TEXT NOT NULL,
          line INTEGER NOT NULL,
          col INTEGER NOT NULL,
          signature TEXT NOT NULL DEFAULT '',
          doc_comment TEXT NOT NULL DEFAULT '',
          scope TEXT NOT NULL DEFAULT '',
          text TEXT NOT NULL DEFAULT ''
        );
        INSERT INTO symbols(id, lang, kind, name, file, line, col)
        VALUES (1, 'ts', 'function', 'legacyFn', '/w/legacy.ts', 1, 0);
      `);
      legacy.close();

      const store = new IndexStore(legacyRoot, { indexDir: path.join(legacyRoot, '.idx') });
      try {
        store.insertSymbols([sym({ name: 'postP4', file: '/w/new.ts' })]);
        const hits = store.search('legacyFn');
        expect(hits.some((h) => h.name === 'legacyFn')).toBe(true);
      } finally {
        store.close();
      }

      const probe = new DatabaseSync(path.join(legacyRoot, '.idx', 'index.db'), {
        readOnly: true,
      });
      try {
        const colNames = (
          probe.prepare('PRAGMA table_info(symbols)').all() as Array<{ name: string }>
        ).map((c) => c.name);
        expect(colNames).not.toContain('text');
        expect(colNames).toContain('name');
      } finally {
        probe.close();
      }
    } finally {
      await fs.rm(legacyRoot, { recursive: true, force: true });
    }
  });

  it('short-token filter matches derived columns after the text column removal', () => {
    store.insertSymbols([
      sym({ name: 'zetaRun', file: '/w/z.ts', signature: 'zetaRun(alphaId: string): void' }),
      sym({ name: 'unrelated', file: '/w/u.ts', signature: 'unrelated(): void' }),
    ]);
    // 'al' only exists inside the first symbol's signature — matched via the
    // derived signature LIKE now that symbols.text is gone.
    const { results } = store.searchRanked('zeta al', undefined, 10);
    expect(results.some((r) => r.name === 'zetaRun')).toBe(true);
    expect(results.every((r) => r.name !== 'unrelated')).toBe(true);
  });
});

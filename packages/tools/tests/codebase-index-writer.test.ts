import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  Symbol as IndexSymbol,
  SymbolKind,
  SymbolLang,
} from '../src/codebase-index/schema.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  IndexStore,
  codebaseIndexDirOverride,
  resolveIndexDir,
} from '../src/codebase-index/writer.js';

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

describe('IndexStore search filters', () => {
  beforeEach(() => {
    store.insertSymbols(
      [
        sym({
          name: 'UserClass',
          kind: 'class',
          lang: 'ts',
          file: '/p/user.ts',
          text: 'UserClass entity',
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
    store.insertRefs(callerId, [
      { fromId: callerId, toName: 'readFile', callType: 'call', line: 11 },
      { fromId: callerId, toName: './sibling.js', callType: 'import', line: 1 },
      { fromId: callerId, toName: '@wrongstack/tools', callType: 'import', line: 2 },
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

  it('builds package edges directly from unresolved workspace imports', () => {
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
    expect(graph.edges).toHaveLength(1);
    expect(graph.nodes.some((node) => node.id === graph.edges[0]?.target)).toBe(true);
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

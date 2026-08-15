/**
 * Performance-oriented codebase-index SQLite tests.
 *
 * Asserts bulk write/search/graph paths stay within soft budgets under a
 * synthetic multi-file corpus, and logs timings for CI visibility.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  Symbol as IndexSymbol,
  SymbolKind,
  SymbolLang,
} from '../src/codebase-index/schema.js';
import { IndexStore } from '../src/codebase-index/writer.js';

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

function elapsedMs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-idx-perf-'));
  store = new IndexStore(tmpDir, { indexDir: path.join(tmpDir, '.idx') });
});

afterEach(async () => {
  store.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('IndexStore performance paths', () => {
  it('commitBatch inserts thousands of symbols via multi-row writes', () => {
    const FILES = 40;
    const SYMS_PER_FILE = 50;
    const entries = [];
    for (let f = 0; f < FILES; f++) {
      const file = path.join(tmpDir, 'packages', `pkg${f % 5}`, `file-${f}.ts`);
      const symbols = Array.from({ length: SYMS_PER_FILE }, (_, i) =>
        sym({
          name: `fn_${f}_${i}`,
          file,
          line: i + 1,
          text: `fn_${f}_${i} helper utility topic${i % 10}`,
        }),
      );
      entries.push({
        file,
        lang: 'ts' as const,
        symbols,
        refs: [],
        mtimeMs: Date.now(),
        symbolCount: symbols.length,
      });
    }

    const t0 = process.hrtime.bigint();
    const inserted = store.commitBatch(entries, {
      deleteForFiles: entries.map((e) => e.file),
    });
    const writeMs = elapsedMs(t0);

    expect(inserted).toHaveLength(FILES * SYMS_PER_FILE);
    expect(store.getStats().totalSymbols).toBe(FILES * SYMS_PER_FILE);
    expect(writeMs).toBeLessThan(5_000);
    // eslint-disable-next-line no-console
    console.log(
      `[codebase-index-perf] commitBatch ${FILES}×${SYMS_PER_FILE}=${inserted.length} symbols in ${writeMs.toFixed(0)}ms`,
    );
  });

  it('searchRanked empty filter uses SQL LIMIT (no full table materialize)', () => {
    const N = 800;
    store.insertSymbols(
      Array.from({ length: N }, (_, i) =>
        sym({
          name: `Symbol${i}`,
          file: path.join(tmpDir, `f${i % 20}.ts`),
          kind: i % 3 === 0 ? 'class' : 'function',
          text: `Symbol${i} entity`,
        }),
      ),
    );

    const t0 = process.hrtime.bigint();
    const { results, total } = store.searchRanked('', { kind: 'class' }, 15);
    const ms = elapsedMs(t0);

    expect(total).toBeGreaterThan(15);
    expect(results).toHaveLength(15);
    expect(results.every((r) => r.kind === 'class')).toBe(true);
    expect(ms).toBeLessThan(500);
    // eslint-disable-next-line no-console
    console.log(
      `[codebase-index-perf] searchRanked('', class, 15) total=${total} in ${ms.toFixed(1)}ms`,
    );
  });

  it('FTS ranked search stays fast on bulk corpus', () => {
    const N = 600;
    store.insertSymbols(
      Array.from({ length: N }, (_, i) =>
        sym({
          name: i % 40 === 0 ? `AuthHandler${i}` : `Util${i}`,
          file: path.join(tmpDir, `src/mod${i % 30}.ts`),
          text:
            i % 40 === 0 ? `AuthHandler${i} authentication session token` : `Util${i} helper misc`,
        }),
      ),
    );

    const t0 = process.hrtime.bigint();
    const { results, total } = store.searchRanked('AuthHandler authentication', undefined, 10);
    const ms = elapsedMs(t0);

    expect(total).toBeGreaterThan(0);
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(10);
    expect(ms).toBeLessThan(500);
    // eslint-disable-next-line no-console
    console.log(
      `[codebase-index-perf] searchRanked FTS N=${N} → ${results.length}/${total} in ${ms.toFixed(1)}ms`,
    );
  });

  it('getPackageGraph aggregates without loading every symbol id', () => {
    const entries = [];
    for (let p = 0; p < 4; p++) {
      for (let f = 0; f < 10; f++) {
        const file = path.join(tmpDir, 'packages', `pkg${p}`, `file${f}.ts`);
        const symbols = Array.from({ length: 30 }, (_, i) =>
          sym({ name: `p${p}_f${f}_s${i}`, file, line: i + 1 }),
        );
        entries.push({
          file,
          lang: 'ts' as const,
          symbols,
          refs: [],
          mtimeMs: Date.now(),
          symbolCount: symbols.length,
        });
      }
    }
    store.commitBatch(entries);

    // Wire a few cross-package refs
    const all = store.search('');
    const a = all.find((s) => s.file.includes(`${path.sep}pkg0${path.sep}`));
    const b = all.find((s) => s.file.includes(`${path.sep}pkg1${path.sep}`));
    expect(a && b).toBeTruthy();
    if (a && b) {
      store.insertRefsBatch([
        { fromId: a.id, toName: b.name, toId: b.id, callType: 'call', line: 1 },
      ]);
    }

    const t0 = process.hrtime.bigint();
    const graph = store.getPackageGraph();
    const ms = elapsedMs(t0);

    expect(graph.nodes.length).toBeGreaterThanOrEqual(4);
    expect(ms).toBeLessThan(1_000);
    // eslint-disable-next-line no-console
    console.log(
      `[codebase-index-perf] getPackageGraph nodes=${graph.nodes.length} edges=${graph.edges.length} in ${ms.toFixed(1)}ms`,
    );
  });

  it('getFileGraph and getSymbolGraph stay within soft budgets on dense packages', () => {
    const pkg = 'core';
    const files: string[] = [];
    const entries = [];
    for (let f = 0; f < 25; f++) {
      const file = path.join(tmpDir, 'packages', pkg, `mod${f}.ts`);
      files.push(file);
      const symbols = Array.from({ length: 40 }, (_, i) =>
        sym({ name: `fn_${f}_${i}`, file, line: i + 1 }),
      );
      entries.push({
        file,
        lang: 'ts' as const,
        symbols,
        refs: [],
        mtimeMs: Date.now(),
        symbolCount: symbols.length,
      });
    }
    store.commitBatch(entries);

    const all = store.search('');
    const byFile = new Map<string, typeof all>();
    for (const s of all) {
      const list = byFile.get(s.file) ?? [];
      list.push(s);
      byFile.set(s.file, list);
    }
    // Cross-file call mesh: each file's first symbol calls the next file's first.
    const refBatch: Array<{
      fromId: number;
      toName: string;
      toId: number;
      callType: 'call';
      line: number;
    }> = [];
    for (let f = 0; f < files.length - 1; f++) {
      const from = byFile.get(files[f]!)?.[0];
      const to = byFile.get(files[f + 1]!)?.[0];
      if (!from || !to) continue;
      // Duplicate identical call edges to exercise SQL GROUP BY aggregation.
      for (let d = 0; d < 5; d++) {
        refBatch.push({
          fromId: from.id,
          toName: to.name,
          toId: to.id,
          callType: 'call',
          line: d + 1,
        });
      }
    }
    // Intra-file fan-out for symbol graph density.
    const denseFile = files[0]!;
    const denseSyms = byFile.get(denseFile) ?? [];
    for (let i = 1; i < Math.min(20, denseSyms.length); i++) {
      const from = denseSyms[0]!;
      const to = denseSyms[i]!;
      for (let d = 0; d < 3; d++) {
        refBatch.push({
          fromId: from.id,
          toName: to.name,
          toId: to.id,
          callType: 'call',
          line: 100 + i * 3 + d,
        });
      }
    }
    store.insertRefsBatch(refBatch);

    const tFile = process.hrtime.bigint();
    const fileGraph = store.getFileGraph('@wrongstack/core');
    const fileMs = elapsedMs(tFile);
    expect(fileGraph.nodes.length).toBeGreaterThanOrEqual(25);
    expect(fileGraph.edges.length).toBeGreaterThan(0);
    // Aggregated edge weight should collapse 5 duplicate refs into weight 5.
    const bridge = fileGraph.edges.find(
      (edge) => edge.source === `file:${files[0]}` && edge.target === `file:${files[1]}`,
    );
    expect(bridge?.weight).toBe(5);
    expect(fileMs).toBeLessThan(1_000);
    // eslint-disable-next-line no-console
    console.log(
      `[codebase-index-perf] getFileGraph nodes=${fileGraph.nodes.length} edges=${fileGraph.edges.length} in ${fileMs.toFixed(1)}ms`,
    );

    const tSym = process.hrtime.bigint();
    const symbolGraph = store.getSymbolGraph(denseFile);
    const symMs = elapsedMs(tSym);
    expect(symbolGraph.nodes.length).toBeGreaterThan(1);
    expect(symbolGraph.edges.length).toBeGreaterThan(0);
    const fan = symbolGraph.edges.find((edge) => edge.source.startsWith('sym:'));
    expect(fan?.weight).toBeGreaterThanOrEqual(3);
    expect(symMs).toBeLessThan(1_000);
    // eslint-disable-next-line no-console
    console.log(
      `[codebase-index-perf] getSymbolGraph nodes=${symbolGraph.nodes.length} edges=${symbolGraph.edges.length} in ${symMs.toFixed(1)}ms`,
    );
  });

  it('replaceEmptyFile clears stale symbols in one transaction', () => {
    const file = path.join(tmpDir, 'empty-later.ts');
    store.insertSymbols([sym({ name: 'WillVanish', file })]);
    expect(store.search('', { file: 'empty-later' })).toHaveLength(1);

    const t0 = process.hrtime.bigint();
    store.replaceEmptyFile({
      file,
      lang: 'ts',
      mtimeMs: Date.now(),
      symbolCount: 0,
      lastIndexed: Date.now(),
    });
    const ms = elapsedMs(t0);

    expect(store.search('', { file: 'empty-later' })).toHaveLength(0);
    expect(store.getAllFileMetas().some((m) => m.file === file && m.symbolCount === 0)).toBe(true);
    expect(ms).toBeLessThan(200);
  });
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cancelPendingReindexes,
  enqueueReindex,
  isIndexing,
  resetIndexStateForTesting,
  runStartupIndex,
  searchCodebaseIndex,
  shutdownCodebaseIndexHost,
} from '../src/background-indexer.js';

describe('background-indexer lifecycle', () => {
  it('keeps isIndexing() true while a second concurrent runStartupIndex is still active', async () => {
    const prev = process.env['WRONGSTACK_INDEX_INLINE'];
    process.env['WRONGSTACK_INDEX_INLINE'] = '1';
    const dir = mkdtempSync(join(tmpdir(), 'ws-bgidx-concurrent-'));
    try {
      for (let i = 0; i < 4; i++) {
        writeFileSync(join(dir, `f${i}.ts`), `export const v${i} = ${i};\n`, 'utf8');
      }
      resetIndexStateForTesting();
      let indexingAfterFirst: boolean | undefined;
      const runA = runStartupIndex({
        projectRoot: dir,
        indexDir: join(dir, '.idx-a'),
        force: true,
      }).then((r) => {
        indexingAfterFirst = isIndexing();
        return r;
      });
      const runB = runStartupIndex({
        projectRoot: dir,
        indexDir: join(dir, '.idx-b'),
        force: true,
      });
      await runA;
      expect(indexingAfterFirst).toBe(true);
      await runB;
      expect(isIndexing()).toBe(false);
    } finally {
      await shutdownCodebaseIndexHost();
      resetIndexStateForTesting();
      if (prev === undefined) delete process.env['WRONGSTACK_INDEX_INLINE'];
      else process.env['WRONGSTACK_INDEX_INLINE'] = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not resolve enqueueReindex before all of its files have been indexed', async () => {
    const prev = process.env['WRONGSTACK_INDEX_INLINE'];
    process.env['WRONGSTACK_INDEX_INLINE'] = '1';
    const dir = mkdtempSync(join(tmpdir(), 'ws-bgidx-enqueue-'));
    try {
      const fileA = join(dir, 'a.ts');
      const fileB = join(dir, 'b.ts');
      writeFileSync(fileA, 'export function alphaRegSym() { return 1; }\n', 'utf8');
      writeFileSync(fileB, 'export function betaRegSym() { return 2; }\n', 'utf8');
      resetIndexStateForTesting();
      const idx = join(dir, '.idx');
      const p1 = enqueueReindex({
        projectRoot: dir,
        indexDir: idx,
        files: [fileA],
        debounceMs: 10,
        coalesceWindowMs: 5,
      });
      const p2 = enqueueReindex({
        projectRoot: dir,
        indexDir: idx,
        files: [fileB],
        debounceMs: 100,
        coalesceWindowMs: 5,
      });
      await p2;
      const res = await searchCodebaseIndex({
        projectRoot: dir,
        indexDir: idx,
        query: 'betaRegSym',
      });
      expect(res.results.length).toBeGreaterThan(0);
      await p1;

      const pCancel = enqueueReindex({
        projectRoot: dir,
        indexDir: idx,
        files: [fileA, fileB],
        debounceMs: 5_000,
        coalesceWindowMs: 5,
      });
      cancelPendingReindexes();
      await pCancel;
    } finally {
      await shutdownCodebaseIndexHost();
      resetIndexStateForTesting();
      if (prev === undefined) delete process.env['WRONGSTACK_INDEX_INLINE'];
      else process.env['WRONGSTACK_INDEX_INLINE'] = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

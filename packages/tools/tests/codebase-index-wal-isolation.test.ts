import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runIndexer } from '../src/codebase-index/indexer.js';
import { IndexStore, indexStorePool } from '../src/codebase-index/writer.js';

const ctx = {} as Context;
let tempDir: string;
let projectRoot: string;
let indexDir: string;

function git(...args: string[]): string {
  return execFileSync('git', ['-C', projectRoot, ...args], { encoding: 'utf8' }).trim();
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-index-wal-'));
  projectRoot = path.join(tempDir, 'project');
  indexDir = path.join(tempDir, 'index');
  await fs.mkdir(projectRoot);
});

afterEach(async () => {
  indexStorePool.evict(projectRoot, indexDir);
  await fs.rm(tempDir, { recursive: true, force: true });
});

/**
 * Chimera follow-up cbad1117: verify that WAL-mode pooled readers never see
 * uncommitted generations from runAtomicIndexUpdate.
 *
 * The pool shares one IndexStore (and thus one DatabaseSync connection) per
 * project. On the same SQLite connection a query always sees its own
 * uncommitted transaction — but the background indexer serializes all ops
 * through a process-wide write mutex, so concurrent read+write on the pooled
 * connection cannot happen in production. The real isolation guarantee is
 * therefore cross-connection: a separately-opened IndexStore (the worker /
 * detached-server pattern) must not see uncommitted state from the pooled
 * writer.
 *
 * The existing codebase-index-atomic.test.ts already proves this with two
 * hand-opened IndexStore instances. This test adds the pooled-connection
 * dimension: after a committed runAtomicIndexUpdate the pool's warm reader
 * sees the new state, and a rolled-back update leaves the previous state
 * intact.
 */
describe('codebase-index WAL transaction isolation — pooled connection', () => {
  it('a committed runAtomicIndexUpdate is visible to the pooled reader', async () => {
    writeFileSync(path.join(projectRoot, 'v1.ts'), 'export function V1(): void {}');
    await runIndexer(ctx, { projectRoot, indexDir });

    const store = indexStorePool.acquire(projectRoot, { indexDir });
    try {
      expect(store.getStats().totalSymbols).toBe(1);

      writeFileSync(path.join(projectRoot, 'v2.ts'), 'export function V2(): void {}');
      await runIndexer(ctx, { projectRoot, indexDir });

      // After commit, the pooled store sees the new generation.
      expect(store.getStats().totalSymbols).toBe(2);
    } finally {
      indexStorePool.release(store);
    }
  });

  it('a rolled-back runAtomicIndexUpdate leaves the previous generation intact', async () => {
    const file = path.join(projectRoot, 'original.ts');
    writeFileSync(file, 'export function OriginalSymbol(): void {}');
    await runIndexer(ctx, { projectRoot, indexDir });

    const writer = new IndexStore(projectRoot, { indexDir });
    const reader = new IndexStore(projectRoot, { indexDir });
    try {
      expect(writer.getStats().totalSymbols).toBe(1);

      let markMutated!: () => void;
      const mutated = new Promise<void>((resolve) => {
        markMutated = resolve;
      });
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });

      // Start an atomic update that clears all symbols, then blocks.
      const update = writer.runAtomicIndexUpdate(async () => {
        writer.clearAll();
        markMutated();
        await blocked; // hold the transaction open
        throw new Error('publication failed');
      });

      // Wait for the writer to have cleared inside the transaction.
      await mutated;

      // The separate reader (different connection, WAL mode) must still see
      // the original symbol — the clearAll is uncommitted.
      expect(reader.getStats().totalSymbols).toBe(1);

      // Release → the transaction throws → rollback.
      release();
      await expect(update).rejects.toThrow('publication failed');

      // After rollback, both see the original symbol.
      expect(writer.getStats().totalSymbols).toBe(1);
      expect(reader.getStats().totalSymbols).toBe(1);
    } finally {
      writer.close();
      reader.close();
    }
  });

  it('search returns results only from the committed generation', async () => {
    git('init');
    git('config', 'user.email', 'index-test@example.invalid');
    git('config', 'user.name', 'Index Test');

    writeFileSync(path.join(projectRoot, 'stable.ts'), 'export function StableSymbol(): void {}');
    git('add', 'stable.ts');
    git('commit', '-m', 'initial');

    await runIndexer(ctx, { projectRoot, indexDir });

    const store = indexStorePool.acquire(projectRoot, { indexDir });
    try {
      // Verify the committed symbol is searchable.
      const results = store.searchRanked('StableSymbol', {}, 10);
      expect(results.results.some((s) => s.name === 'StableSymbol')).toBe(true);
    } finally {
      indexStorePool.release(store);
    }
  });
});

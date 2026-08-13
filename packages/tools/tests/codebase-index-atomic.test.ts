import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runIndexer } from '../src/codebase-index/indexer.js';
import { IndexStore } from '../src/codebase-index/writer.js';

const ctx = {} as Context;
let tempDir: string;
let projectRoot: string;
let indexDir: string;

function git(...args: string[]): string {
  return execFileSync('git', ['-C', projectRoot, ...args], { encoding: 'utf8' }).trim();
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-index-atomic-'));
  projectRoot = path.join(tempDir, 'project');
  indexDir = path.join(tempDir, 'index');
  await fs.mkdir(projectRoot);
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('atomic index generations', () => {
  it('keeps the previous snapshot visible and rolls back a failed publication', async () => {
    const file = path.join(projectRoot, 'old.ts');
    await fs.writeFile(file, 'export function OldSymbol(): void {}');
    await runIndexer(ctx, { projectRoot, indexDir });

    const writer = new IndexStore(projectRoot, { indexDir });
    const reader = new IndexStore(projectRoot, { indexDir });
    let markMutated!: () => void;
    const mutated = new Promise<void>((resolve) => {
      markMutated = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      const update = writer.runAtomicIndexUpdate(async () => {
        writer.clearAll();
        markMutated();
        await blocked;
        throw new Error('publication failed');
      });

      await mutated;
      expect(reader.getStats().totalSymbols).toBe(1);
      release();
      await expect(update).rejects.toThrow('publication failed');
      expect(reader.getStats().totalSymbols).toBe(1);

      await writer.runAtomicIndexUpdate(async () => {
        writer.clearAll();
      });
      expect(reader.getStats().totalSymbols).toBe(0);
    } finally {
      writer.close();
      reader.close();
    }
  });

  it('invalidates clean-file fast skipping when the Git snapshot changes', async () => {
    git('init');
    git('config', 'user.email', 'index-test@example.invalid');
    git('config', 'user.name', 'Index Test');
    const file = path.join(projectRoot, 'symbol.ts');
    await fs.writeFile(file, 'export function BeforePull(): void {}');
    git('add', 'symbol.ts');
    git('commit', '-m', 'before');

    const first = await runIndexer(ctx, { projectRoot, indexDir });
    expect(first.errors).toEqual([]);

    await fs.writeFile(file, 'export function AfterPull(): void {}');
    git('add', 'symbol.ts');
    git('commit', '-m', 'after');

    const refreshed = await runIndexer(ctx, { projectRoot, indexDir });
    expect(refreshed.errors).toEqual([]);
    expect(refreshed.fileOutcomes?.parsed).toBe(1);

    const store = new IndexStore(projectRoot, { indexDir });
    try {
      expect(
        store.searchRanked('AfterPull', {}, 10).results.some((s) => s.name === 'AfterPull'),
      ).toBe(true);
      expect(
        store.searchRanked('BeforePull', {}, 10).results.some((s) => s.name === 'BeforePull'),
      ).toBe(false);
    } finally {
      store.close();
    }

    const unchanged = await runIndexer(ctx, { projectRoot, indexDir });
    expect(unchanged.fileOutcomes?.skipped).toBe(1);
    expect(unchanged.fileOutcomes?.parsed).toBe(0);
  });

  it('retries instead of publishing when source changes during discovery', async () => {
    git('init');
    git('config', 'user.email', 'index-test@example.invalid');
    git('config', 'user.name', 'Index Test');
    const file = path.join(projectRoot, 'racing.ts');
    await fs.writeFile(file, 'export function BeforeRace(): void {}');
    git('add', 'racing.ts');
    git('commit', '-m', 'before-race');

    let changed = false;
    const result = await runIndexer(ctx, {
      projectRoot,
      indexDir,
      onProgress: () => {
        if (changed) return;
        changed = true;
        writeFileSync(file, 'export function AfterRace(): void {}');
      },
    });

    expect(result.errors).toEqual([]);
    const store = new IndexStore(projectRoot, { indexDir });
    try {
      expect(
        store.searchRanked('AfterRace', {}, 10).results.some((s) => s.name === 'AfterRace'),
      ).toBe(true);
      expect(
        store.searchRanked('BeforeRace', {}, 10).results.some((s) => s.name === 'BeforeRace'),
      ).toBe(false);
    } finally {
      store.close();
    }
  });
});

import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { Context } from '@wrongstack/core/agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runIndexer, shouldUseParserWorkerPool } from '../src/codebase-index/indexer.js';
import { IndexStore } from '../src/codebase-index/writer.js';

const ctx = {} as Context; // runIndexer ignores ctx (prefixed _ctx)
const execFileAsync = promisify(execFile);
let dir: string;
const indexDir = () => path.join(dir, '.codebase-index');

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-indexer-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('runIndexer', () => {
  it('gates parser workers by the complete run size rather than the capped batch size', () => {
    const previous = process.env['WRONGSTACK_PERF_PROFILE'];
    process.env['WRONGSTACK_PERF_PROFILE'] = 'balanced';
    try {
      expect(shouldUseParserWorkerPool(499, 40)).toBe(false);
      expect(shouldUseParserWorkerPool(500, 2)).toBe(true);
      expect(shouldUseParserWorkerPool(500, 1)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env['WRONGSTACK_PERF_PROFILE'];
      else process.env['WRONGSTACK_PERF_PROFILE'] = previous;
    }
  });

  // Audit T-04: the threshold is env-configurable via
  // WRONGSTACK_INDEX_WORKER_THRESHOLD, default-preserving, with 0 as an
  // explicit opt-out (the WRONGSTACK_*=0 convention) and garbage falling
  // back to the documented 500 default rather than disabling or exploding.
  it('pool threshold is env-configurable with a preserved default (audit T-04)', () => {
    const prevProfile = process.env['WRONGSTACK_PERF_PROFILE'];
    const prevThreshold = process.env['WRONGSTACK_INDEX_WORKER_THRESHOLD'];
    process.env['WRONGSTACK_PERF_PROFILE'] = 'balanced';
    try {
      // Default preserved when unset.
      delete process.env['WRONGSTACK_INDEX_WORKER_THRESHOLD'];
      expect(shouldUseParserWorkerPool(499, 40)).toBe(false);
      expect(shouldUseParserWorkerPool(500, 2)).toBe(true);

      // Explicit override moves the gate.
      process.env['WRONGSTACK_INDEX_WORKER_THRESHOLD'] = '10';
      expect(shouldUseParserWorkerPool(9, 2)).toBe(false);
      expect(shouldUseParserWorkerPool(10, 2)).toBe(true);

      // 0 disables the worker path outright — even a huge run.
      process.env['WRONGSTACK_INDEX_WORKER_THRESHOLD'] = '0';
      expect(shouldUseParserWorkerPool(100_000, 40)).toBe(false);

      // Malformed values fall back to the default, never disable or
      // parse-prefix (Chimera follow-up: parseInt('0junk') === 0 silently
      // disabled the worker path; parseInt('10foo') === 10 honored junk).
      process.env['WRONGSTACK_INDEX_WORKER_THRESHOLD'] = 'not-a-number';
      expect(shouldUseParserWorkerPool(499, 2)).toBe(false);
      expect(shouldUseParserWorkerPool(500, 2)).toBe(true);
      for (const junk of ['0junk', '10foo', '1.5', '1e3', '-5', '']) {
        process.env['WRONGSTACK_INDEX_WORKER_THRESHOLD'] = junk;
        expect(shouldUseParserWorkerPool(499, 2), `junk=${junk}`).toBe(false);
        expect(shouldUseParserWorkerPool(500, 2), `junk=${junk}`).toBe(true);
      }
    } finally {
      if (prevProfile === undefined) delete process.env['WRONGSTACK_PERF_PROFILE'];
      else process.env['WRONGSTACK_PERF_PROFILE'] = prevProfile;
      if (prevThreshold === undefined) delete process.env['WRONGSTACK_INDEX_WORKER_THRESHOLD'];
      else process.env['WRONGSTACK_INDEX_WORKER_THRESHOLD'] = prevThreshold;
    }
  });

  it('indexes a project, supports force reindex, and skips unchanged files incrementally', async () => {
    await fs.writeFile(path.join(dir, 'a.ts'), 'export class Alpha {}');
    await fs.writeFile(path.join(dir, 'b.ts'), 'export function beta() {}');

    const first = await runIndexer(ctx, { projectRoot: dir, indexDir: indexDir() });
    expect(first.filesIndexed).toBe(2);
    expect(first.fileOutcomes).toEqual({ parsed: 2, skipped: 0, empty: 0, failed: 0 });
    expect(first.symbolsIndexed).toBeGreaterThan(0);

    // Second run: nothing changed → files counted from cached meta (incremental).
    // P5.15: skipped files no longer inflate filesIndexed — the headline is
    // files parsed this run; reuse lives in fileOutcomes.skipped.
    const second = await runIndexer(ctx, { projectRoot: dir, indexDir: indexDir() });
    expect(second.filesIndexed).toBe(0);
    expect(second.fileOutcomes).toEqual({ parsed: 0, skipped: 2, empty: 0, failed: 0 });

    // Force: clears and rebuilds.
    const forced = await runIndexer(ctx, { projectRoot: dir, indexDir: indexDir(), force: true });
    expect(forced.filesIndexed).toBe(2);
  });

  it('dispatches every supported language parser', async () => {
    await fs.writeFile(path.join(dir, 'a.ts'), 'export class A {}');
    await fs.writeFile(path.join(dir, 'b.go'), 'package main\nfunc Beta() {}\n');
    await fs.writeFile(path.join(dir, 'c.py'), 'class Gamma:\n  pass\n');
    await fs.writeFile(path.join(dir, 'd.rs'), 'fn delta() {}\n');
    await fs.writeFile(path.join(dir, 'e.json'), '{"k": 1}');
    await fs.writeFile(path.join(dir, 'f.yaml'), 'key: value\n');
    await fs.writeFile(path.join(dir, 'g.yml'), 'other: thing\n');

    const res = await runIndexer(ctx, { projectRoot: dir, indexDir: indexDir() });
    expect(res.filesIndexed).toBe(7);
    expect(Object.keys(res.langStats).sort()).toEqual(
      ['go', 'json', 'py', 'rs', 'ts', 'yaml'].sort(),
    );
  });

  it('filters by language', async () => {
    await fs.writeFile(path.join(dir, 'a.ts'), 'export class Alpha {}');
    await fs.writeFile(path.join(dir, 'b.py'), 'class Beta:\n  pass\n');
    const res = await runIndexer(ctx, { projectRoot: dir, indexDir: indexDir(), langs: ['ts'] });
    expect(res.langStats.ts).toBeGreaterThan(0);
    expect(res.langStats.py).toBeUndefined();
  });

  it('skips ignored directories during the walk', async () => {
    await fs.mkdir(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
    await fs.writeFile(path.join(dir, 'node_modules', 'pkg', 'dep.ts'), 'export const x = 1;');
    await fs.writeFile(path.join(dir, 'keep.ts'), 'export const y = 2;');
    const res = await runIndexer(ctx, { projectRoot: dir, indexDir: indexDir() });
    expect(res.filesIndexed).toBe(1); // node_modules pruned
  });

  it('uses the Git file index while retaining tracked, untracked, and ignore semantics', async () => {
    await execFileAsync('git', ['init', '--quiet'], { cwd: dir, windowsHide: true });
    await fs.writeFile(path.join(dir, '.gitignore'), 'ignored.ts\nignored-dir/\n');
    await fs.writeFile(path.join(dir, 'tracked.ts'), 'export const tracked = 1;');
    await fs.writeFile(path.join(dir, 'untracked.ts'), 'export const untracked = 2;');
    await fs.writeFile(path.join(dir, 'ignored.ts'), 'export const ignored = 3;');
    await fs.mkdir(path.join(dir, 'ignored-dir'));
    await fs.writeFile(
      path.join(dir, 'ignored-dir', 'nested.ts'),
      'export const ignoredNested = 4;',
    );
    await execFileAsync('git', ['add', '.gitignore', 'tracked.ts'], {
      cwd: dir,
      windowsHide: true,
    });
    await execFileAsync(
      'git',
      [
        '-c',
        'user.name=WrongStack Test',
        '-c',
        'user.email=test@wrongstack.dev',
        'commit',
        '--quiet',
        '-m',
        'fixture',
      ],
      { cwd: dir, windowsHide: true },
    );

    const res = await runIndexer(ctx, { projectRoot: dir, indexDir: indexDir() });

    expect(res.filesIndexed).toBe(2);
    const store = new IndexStore(dir, { indexDir: indexDir() });
    try {
      // Trigram FTS5 matches substrings: 'tracked' appears in both 'tracked'
      // and 'untracked', so the query returns both. The RRF fusion re-ranks
      // the exact-match ahead of the substring-match.
      const trackedResults = store.searchRanked('tracked', {}, 10).results;
      expect(trackedResults.length).toBeGreaterThanOrEqual(1);
      expect(trackedResults[0]?.name).toBe('tracked');
      expect(store.searchRanked('untracked', {}, 10).results).toHaveLength(1);
      expect(store.searchRanked('ignored', {}, 10).results).toHaveLength(0);
    } finally {
      store.close();
    }

    await fs.writeFile(path.join(dir, 'tracked.ts'), 'export const trackedUpdated = 5;');
    const updated = await runIndexer(ctx, { projectRoot: dir, indexDir: indexDir() });
    expect(updated.errors).toEqual([]);
    const updatedStore = new IndexStore(dir, { indexDir: indexDir() });
    try {
      expect(updatedStore.searchRanked('trackedUpdated', {}, 10).results).toHaveLength(1);
    } finally {
      updatedStore.close();
    }

    await fs.rm(path.join(dir, 'tracked.ts'));
    const deleted = await runIndexer(ctx, { projectRoot: dir, indexDir: indexDir() });
    expect(deleted.errors).toEqual([]);
    // P5.15: nothing was parsed (one file pruned as stale, the rest skipped) —
    // the prune is validated by the search result below, not the counter.
    expect(deleted.filesIndexed).toBe(0);
    const deletedStore = new IndexStore(dir, { indexDir: indexDir() });
    try {
      expect(deletedStore.searchRanked('trackedUpdated', {}, 10).results).toHaveLength(0);
    } finally {
      deletedStore.close();
    }
  });

  it('walks deep trees, reports progress, and yields the event loop', async () => {
    // > YIELD_EVERY_N (50) directories *and* files exercises both yield paths.
    await Promise.all(
      Array.from({ length: 60 }, async (_, i) => {
        const sub = path.join(dir, `d${i}`);
        await fs.mkdir(sub, { recursive: true });
        await fs.writeFile(path.join(sub, `f${i}.ts`), `export const v${i} = ${i};`);
      }),
    );
    const seen: Array<[number, number]> = [];
    const res = await runIndexer(ctx, {
      projectRoot: dir,
      indexDir: indexDir(),
      onProgress: (c, t) => seen.push([c, t]),
    });
    expect(res.filesIndexed).toBe(60);
    expect(seen.length).toBeGreaterThan(0);
  });

  it('handles an explicit file list with gitignored, directory, extensionless, and missing entries', async () => {
    await fs.writeFile(path.join(dir, '.gitignore'), 'ignored.ts\n');
    const ignored = path.join(dir, 'ignored.ts');
    await fs.writeFile(ignored, 'class Ig {}');
    const subdir = path.join(dir, 'adir');
    await fs.mkdir(subdir);
    const noLang = path.join(dir, 'note.txt');
    await fs.writeFile(noLang, 'plain text, no parser');
    const real = path.join(dir, 'real.ts');
    await fs.writeFile(real, 'export const ok = 1;');
    const missing = path.join(dir, 'does-not-exist.ts');

    const res = await runIndexer(ctx, {
      projectRoot: dir,
      indexDir: indexDir(),
      files: [ignored, subdir, noLang, real, missing],
    });
    // ignored→gitignore, adir→not a file, note.txt→no lang, missing→stat fails;
    // only real.ts is indexed.
    expect(res.filesIndexed).toBe(1);
  });

  it('makes a targeted reindex immediately searchable with stale symbols removed', async () => {
    const file = path.join(dir, 'probe.ts');
    const oldSymbol = 'TargetedReindexOldSymbol';
    const newSymbol = 'TargetedReindexNewSymbol';

    await fs.writeFile(file, `export const ${oldSymbol} = 1;\n`);
    await runIndexer(ctx, { projectRoot: dir, indexDir: indexDir(), files: [file] });

    await fs.writeFile(file, `export const ${newSymbol} = 2;\n`);
    const newer = new Date(Date.now() + 2000);
    await fs.utimes(file, newer, newer);
    const result = await runIndexer(ctx, { projectRoot: dir, indexDir: indexDir(), files: [file] });

    expect(result.errors).toEqual([]);
    expect(result.filesIndexed).toBe(1);
    expect(result.symbolsIndexed).toBe(1);

    const store = new IndexStore(dir, { indexDir: indexDir() });
    try {
      const fresh = store.searchRanked(newSymbol, { file }, 10);
      const stale = store.searchRanked(oldSymbol, { file }, 10);
      expect(fresh.results.some((hit) => hit.name === newSymbol)).toBe(true);
      expect(stale.results.some((hit) => hit.name === oldSymbol)).toBe(false);
    } finally {
      store.close();
    }
  });

  it('records a file with zero symbols', async () => {
    await fs.writeFile(path.join(dir, 'empty.ts'), '\n\n');
    const res = await runIndexer(ctx, { projectRoot: dir, indexDir: indexDir() });
    // P5.15: empty files are indexed (file row written, searchable absence)
    // but don't count toward the parsed headline — see fileOutcomes.empty.
    expect(res.filesIndexed).toBe(0);
    expect(res.symbolsIndexed).toBe(0);
    expect(res.fileOutcomes).toEqual({ parsed: 0, skipped: 0, empty: 1, failed: 0 });
  });

  it('prunes files deleted since the previous run', async () => {
    const gone = path.join(dir, 'gone.ts');
    await fs.writeFile(gone, 'export class Gone {}');
    await fs.writeFile(path.join(dir, 'stay.ts'), 'export class Stay {}');
    const first = await runIndexer(ctx, { projectRoot: dir, indexDir: indexDir() });
    expect(first.filesIndexed).toBe(2);

    await fs.rm(gone);
    const second = await runIndexer(ctx, { projectRoot: dir, indexDir: indexDir() });
    // P5.15: gone.ts was pruned as stale and stay.ts was skipped (unchanged) —
    // nothing parsed. The prune itself is validated by the store checks in the
    // targeted-reindex test; this assertion pins the new counter semantics.
    expect(second.filesIndexed).toBe(0);
    expect(second.fileOutcomes?.skipped).toBe(1);
  });

  it('returns no files when the project root does not exist', async () => {
    const res = await runIndexer(ctx, {
      projectRoot: path.join(dir, 'nope'),
      indexDir: indexDir(),
    });
    expect(res.filesIndexed).toBe(0); // readdir of a missing dir is swallowed
  });

  it('throws when the signal is already aborted (Error reason, walk path)', async () => {
    await fs.writeFile(path.join(dir, 'a.ts'), 'export class Alpha {}');
    const ac = new AbortController();
    ac.abort(new Error('cancelled by test'));
    await expect(
      runIndexer(ctx, { projectRoot: dir, indexDir: indexDir(), signal: ac.signal }),
    ).rejects.toThrow('cancelled by test');
  });

  it('throws with a string abort reason', async () => {
    await fs.writeFile(path.join(dir, 'a.ts'), 'export class Alpha {}');
    const ac = new AbortController();
    ac.abort('stop now');
    await expect(
      runIndexer(ctx, { projectRoot: dir, indexDir: indexDir(), signal: ac.signal }),
    ).rejects.toThrow('stop now');
  });

  it('throws a generic message for a non-string non-Error abort reason', async () => {
    await fs.writeFile(path.join(dir, 'a.ts'), 'export class Alpha {}');
    const ac = new AbortController();
    ac.abort(12345);
    await expect(
      runIndexer(ctx, { projectRoot: dir, indexDir: indexDir(), signal: ac.signal }),
    ).rejects.toThrow('Indexing cancelled');
  });

  it('records a read error when fs.readFile fails on an aborted signal', async () => {
    const f = path.join(dir, 'a.ts');
    await fs.writeFile(f, 'export class Alpha {}');
    const ac = new AbortController();
    ac.abort();
    // Node's fs.stat resolves despite the aborted signal, but readFile rejects
    // with a (non-DOMException) AbortError → caught as an ordinary read error.
    const res = await runIndexer(ctx, {
      projectRoot: dir,
      indexDir: indexDir(),
      files: [f],
      signal: ac.signal,
    });
    expect(res.filesIndexed).toBe(0);
    expect(res.errors.some((e) => /read error/.test(e))).toBe(true);
  });
});

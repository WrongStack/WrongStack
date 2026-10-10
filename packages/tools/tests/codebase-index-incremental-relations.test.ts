import { loadRuntimeDatabaseSync as loadTestDatabaseSync } from '@wrongstack/persistence';
/**
 * The relation pass is proportional to what a run changed.
 *
 * It used to redo the whole repository on every run — structure detection, a
 * package-label write for every file and a resolution of every import — so a
 * one-file watcher edit cost ~450 ms and a full scan over an unchanged
 * checkout ~1.5 s of pure rework. These tests pin the cases where a narrow
 * pass must still reach beyond the files it was handed.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const DatabaseSync = loadTestDatabaseSync();

import type { Context } from '@wrongstack/core/agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runIndexer } from '../src/codebase-index/indexer.js';

const ctx = {} as Context;
let root: string;
let indexDir: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-incr-rel-'));
  indexDir = path.join(root, '.idx');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function write(relative: string, content: string): Promise<string> {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  return file;
}

function query<T>(sql: string, ...args: string[]): T[] {
  const db = new DatabaseSync(path.join(indexDir, 'index.db'));
  try {
    return db.prepare(sql).all(...args) as T[];
  } finally {
    db.close();
  }
}

/** Resolved target of every import `fromRelative` makes, by specifier. */
function importTargets(fromRelative: string): Record<string, string | null> {
  const rows = query<{ module: string; toFile: string | null }>(
    `SELECT r.module AS module, r.to_file AS toFile
       FROM refs r JOIN symbols s ON s.id = r.from_id
      WHERE r.call_type = 'import' AND s.file = ?`,
    path.join(root, fromRelative),
  );
  return Object.fromEntries(
    rows.map((row) => [row.module, row.toFile ? path.relative(root, row.toFile) : null]),
  );
}

function packageOf(relative: string): string | undefined {
  return query<{ package: string }>(
    'SELECT package FROM files WHERE file = ?',
    path.join(root, relative),
  )[0]?.package;
}

function metadata(key: string): string | undefined {
  return query<{ value: string }>('SELECT value FROM metadata WHERE key = ?', key)[0]?.value;
}

const index = (files?: string[]) => runIndexer(ctx, { projectRoot: root, indexDir, files });

describe('incremental relation pass', () => {
  it('resolves an older import once its target file appears in a targeted run', async () => {
    await write('src/a.ts', "import { b } from './b';\nexport const a = () => b;\n");
    await index();
    expect(importTargets('src/a.ts')).toEqual({ './b': null });

    // The watcher hands the run only the NEW file; the importer is untouched.
    const b = await write('src/b.ts', 'export const b = 1;\n');
    const result = await index([b]);

    expect(result.changedFiles).toBe(1);
    expect(importTargets('src/a.ts')).toEqual({ './b': path.join('src', 'b.ts') });
  });

  it('clears the importers of a deleted file in a targeted run', async () => {
    await write('src/a.ts', "import { b } from './b';\nexport const a = () => b;\n");
    const b = await write('src/b.ts', 'export const b = 1;\n');
    await index();
    expect(importTargets('src/a.ts')).toEqual({ './b': path.join('src', 'b.ts') });

    await fs.rm(b);
    const result = await index([b]);

    expect(result.changedFiles).toBe(1);
    expect(importTargets('src/a.ts')).toEqual({ './b': null });
  });

  it('reports no change, and keeps the content stamp, for an unchanged targeted run', async () => {
    const a = await write('src/a.ts', 'export const a = 1;\n');
    await index();
    const stamp = metadata('last_indexed');

    // The watcher's echo of an edit a tool already indexed.
    const result = await index([a]);

    expect(result.changedFiles).toBe(0);
    expect(metadata('last_indexed')).toBe(stamp);
  });

  it('keeps labels and edges intact across a full scan that changed nothing', async () => {
    await write('packages/p1/package.json', '{ "name": "@x/p1" }\n');
    await write('packages/p1/src/a.ts', "import { b } from './b';\nexport const a = () => b;\n");
    await write('packages/p1/src/b.ts', 'export const b = 1;\n');
    await index();
    const epoch = metadata('relation_epoch');

    const result = await index();

    expect(result.changedFiles).toBe(0);
    expect(packageOf('packages/p1/src/a.ts')).toBe('@x/p1');
    expect(importTargets('packages/p1/src/a.ts')).toEqual({
      './b': path.join('packages', 'p1', 'src', 'b.ts'),
    });
    // Nothing moved, so other processes' cached structure stays valid.
    expect(metadata('relation_epoch')).toBe(epoch);
  });

  it('relabels every file when a manifest renames its package', async () => {
    const manifest = await write('packages/p1/package.json', '{ "name": "@x/p1" }\n');
    await write('packages/p1/src/a.ts', 'export const a = 1;\n');
    await index();
    expect(packageOf('packages/p1/src/a.ts')).toBe('@x/p1');

    await fs.writeFile(manifest, '{ "name": "@x/renamed" }\n');
    await index([manifest]);

    expect(packageOf('packages/p1/src/a.ts')).toBe('@x/renamed');
  });

  it('labels a file added by a targeted run', async () => {
    await write('packages/p1/package.json', '{ "name": "@x/p1" }\n');
    await write('packages/p1/src/a.ts', 'export const a = 1;\n');
    await index();

    const added = await write('packages/p1/src/new.ts', 'export const n = 1;\n');
    await index([added]);

    expect(packageOf('packages/p1/src/new.ts')).toBe('@x/p1');
  });

  it('restores every secondary index after a forced rebuild into an empty index', async () => {
    await write('src/a.ts', "import { b } from './b';\nexport const a = () => b();\n");
    await write('src/b.ts', 'export function b() { return 1; }\n');
    const expected = (table: string) =>
      query<{ name: string }>(`PRAGMA index_list(${table})`)
        .map((row) => row.name)
        .filter((name) => name.startsWith('idx_'))
        .sort();
    await index();
    const before = { symbols: expected('symbols'), refs: expected('refs') };

    // The rebuild bulk-inserts with these dropped and must build them again;
    // a missing one keeps every answer right and every lookup a table scan.
    await runIndexer(ctx, { projectRoot: root, indexDir, force: true });

    expect({ symbols: expected('symbols'), refs: expected('refs') }).toEqual(before);
    expect(before.refs.length).toBeGreaterThan(3);
    expect(importTargets('src/a.ts')).toEqual({ './b': path.join('src', 'b.ts') });
  });
});

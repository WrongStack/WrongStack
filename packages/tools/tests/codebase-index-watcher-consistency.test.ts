/**
 * Index consistency across watcher-style targeted runs.
 *
 * Exercises the real indexer end to end and asserts relational invariants on
 * the database after each step, rather than individual return values.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadRuntimeDatabaseSync as loadTestDatabaseSync } from '@wrongstack/persistence';

const DatabaseSync = loadTestDatabaseSync();

import type { Context } from '@wrongstack/core/agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runIndexer } from '../src/codebase-index/indexer.js';

const ctx = {} as Context;

function query<T>(indexDir: string, sql: string): T[] {
  const db = new DatabaseSync(path.join(indexDir, 'index.db'), { readOnly: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}

function orphanProblems(indexDir: string): string[] {
  const checks: Record<string, string> = {
    'symbol_rank orphan':
      'SELECT symbol_id FROM symbol_rank WHERE symbol_id NOT IN (SELECT id FROM symbols)',
    'file_rank orphan': 'SELECT file FROM file_rank WHERE file NOT IN (SELECT file FROM files)',
    'orphan refs': 'SELECT id FROM refs WHERE from_id NOT IN (SELECT id FROM symbols)',
    'dangling to_id':
      'SELECT id FROM refs WHERE to_id IS NOT NULL AND to_id NOT IN (SELECT id FROM symbols)',
    'fts drift': 'SELECT rowid FROM symbols_fts WHERE rowid NOT IN (SELECT id FROM symbols)',
    // '' is the binding pass's "bound outside the index" marker, not a path.
    'to_file not indexed':
      "SELECT to_file FROM refs WHERE to_file IS NOT NULL AND to_file <> '' AND to_file NOT IN (SELECT file FROM files)",
  };
  return Object.entries(checks).flatMap(([label, sql]) =>
    query(indexDir, sql).length > 0 ? [label] : [],
  );
}

describe('watcher runs keep the index consistent', () => {
  let root: string;
  let indexDir: string;
  const abs = (rel: string) => path.join(root, rel);

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-watch-consistency-'));
    indexDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-watch-consistency-idx-'));
    await fs.mkdir(abs('src'), { recursive: true });
    await fs.writeFile(
      abs('src/a.ts'),
      "import { helper } from './b';\nexport function main() { return helper(); }\n",
    );
    await fs.writeFile(abs('src/b.ts'), 'export function helper() { return 1; }\n');
    const full = await runIndexer(ctx, { projectRoot: root, indexDir });
    expect(full.errors).toEqual([]);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(indexDir, { recursive: true, force: true });
  });

  const rankedNamesIn = (file: string) =>
    query<{ name: string }>(
      indexDir,
      `SELECT s.name FROM symbol_rank r JOIN symbols s ON s.id = r.symbol_id WHERE s.file = '${file.replaceAll("'", "''")}' ORDER BY s.name`,
    ).map((row) => row.name);

  it('keeps an edited file ranked and leaves no orphan rank rows', async () => {
    const before = rankedNamesIn(abs('src/a.ts'));
    expect(before).toEqual(['main']);

    await fs.writeFile(
      abs('src/a.ts'),
      "import { helper } from './b';\n// edited\nexport function main() { return helper(); }\n",
    );
    const edit = await runIndexer(ctx, { projectRoot: root, indexDir, files: [abs('src/a.ts')] });
    expect(edit.errors).toEqual([]);
    expect(rankedNamesIn(abs('src/a.ts'))).toEqual(before);
    expect(orphanProblems(indexDir)).toEqual([]);
  });

  it('removes a deleted file without reporting an error', async () => {
    await fs.rm(abs('src/b.ts'));
    const removal = await runIndexer(ctx, {
      projectRoot: root,
      indexDir,
      files: [abs('src/b.ts')],
    });
    expect(removal.errors).toEqual([]);
    expect(
      query(indexDir, 'SELECT file FROM files').map((r) => (r as { file: string }).file),
    ).toEqual([abs('src/a.ts')]);
    expect(orphanProblems(indexDir)).toEqual([]);
  });
});

/**
 * Directory deletes and renames reach the index as ONE path naming the
 * directory. Targeted runs must expand it, or every file under it stays indexed.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadRuntimeDatabaseSync as loadTestDatabaseSync } from '@wrongstack/persistence';

const DatabaseSync = loadTestDatabaseSync();

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runIndexer } from '../src/codebase-index/indexer.js';
import { isDirectoryWatchCandidate } from '../src/codebase-index/project-server-watcher.js';
import { indexStorePool } from '../src/codebase-index/writer.js';

describe('targeted runs on directory paths', () => {
  let root: string;
  let indexDir: string;
  const abs = (rel: string) => path.join(root, rel);
  const indexedFiles = () => {
    const db = new DatabaseSync(path.join(indexDir, 'index.db'), { readOnly: true });
    try {
      return (db.prepare('SELECT file FROM files ORDER BY file').all() as Array<{ file: string }>)
        .map((row) => path.relative(root, row.file).replace(/\\/g, '/'))
        .sort();
    } finally {
      db.close();
    }
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-dir-events-'));
    indexDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-dir-events-idx-'));
    await fs.mkdir(abs('src/sub/deep'), { recursive: true });
    await fs.writeFile(abs('src/a.ts'), 'export function a(): number { return 1; }\n');
    await fs.writeFile(abs('src/sub/b.ts'), 'export function b(): number { return 2; }\n');
    await fs.writeFile(abs('src/sub/deep/c.ts'), 'export function c(): number { return 3; }\n');
    const full = await runIndexer({} as never, { projectRoot: root, indexDir });
    expect(full.errors).toEqual([]);
    expect(indexedFiles()).toEqual(['src/a.ts', 'src/sub/b.ts', 'src/sub/deep/c.ts']);
  });

  afterEach(async () => {
    indexStorePool.evict(root, indexDir);
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(indexDir, { recursive: true, force: true });
  });

  it('removes every file of a deleted directory', async () => {
    await fs.rm(abs('src/sub'), { recursive: true });
    const run = await runIndexer({} as never, {
      projectRoot: root,
      indexDir,
      files: [abs('src/sub')],
    });
    expect(run.errors).toEqual([]);
    expect(indexedFiles()).toEqual(['src/a.ts']);
  });

  it('moves the files of a renamed directory', async () => {
    await fs.rename(abs('src/sub'), abs('src/moved'));
    const run = await runIndexer({} as never, {
      projectRoot: root,
      indexDir,
      files: [abs('src/sub'), abs('src/moved')],
    });
    expect(run.errors).toEqual([]);
    expect(indexedFiles()).toEqual(['src/a.ts', 'src/moved/b.ts', 'src/moved/deep/c.ts']);
  });

  it('classifies watch paths that may be directories', async () => {
    await expect(isDirectoryWatchCandidate(abs('src/sub'))).resolves.toBe(true);
    await expect(isDirectoryWatchCandidate(abs('src/gone'))).resolves.toBe(true);
    await expect(isDirectoryWatchCandidate(abs('src/gone.png'))).resolves.toBe(false);
    await fs.writeFile(abs('README'), 'x');
    await expect(isDirectoryWatchCandidate(abs('README'))).resolves.toBe(false);
  });
});

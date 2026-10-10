import { loadRuntimeDatabaseSync as loadTestDatabaseSync } from '@wrongstack/persistence';
/**
 * Per-file Git trust (`files.git_blob`).
 *
 * A full run skips — no stat, no read — a file Git reports clean at the same
 * staged blob its rows were built from. Trust used to be one repository-wide
 * snapshot key, so any edit anywhere voided it and the run re-read the whole
 * tree; it also survived a targeted rewrite, which let an edit-then-revert
 * made while no watcher ran leave the edited symbols in the index.
 */

import { execFileSync } from 'node:child_process';
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

function git(...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...args],
    { cwd: root, encoding: 'utf8', windowsHide: true },
  );
}

beforeEach(async () => {
  // realpath: the indexer compares against `git rev-parse --show-toplevel`,
  // which resolves 8.3 short names and symlinked temp dirs.
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ws-git-blob-')));
  indexDir = path.join(os.tmpdir(), `${path.basename(root)}-idx`);
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  await fs.writeFile(path.join(root, 'a.ts'), 'export function alpha() {}\n');
  await fs.writeFile(path.join(root, 'b.ts'), 'export function bravo() {}\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(indexDir, { recursive: true, force: true });
});

const index = (files?: string[], onProgress?: (current: number, total: number) => void) =>
  runIndexer(ctx, { projectRoot: root, indexDir, files, onProgress });

function query<T>(sql: string, ...args: string[]): T[] {
  const db = new DatabaseSync(path.join(indexDir, 'index.db'));
  try {
    return db.prepare(sql).all(...args) as T[];
  } finally {
    db.close();
  }
}

const blobOf = (name: string) =>
  query<{ git_blob: string }>('SELECT git_blob FROM files WHERE file = ?', path.join(root, name))[0]
    ?.git_blob;
const symbolsOf = (name: string) =>
  query<{ name: string }>(
    'SELECT name FROM symbols WHERE file = ? ORDER BY name',
    path.join(root, name),
  ).map((row) => row.name);

describe('per-file Git trust', () => {
  it('stamps clean files with their staged blob and leaves dirty ones unknown', async () => {
    await fs.writeFile(path.join(root, 'b.ts'), 'export function bravo2() {}\n');
    await index();

    const stagedA = git('ls-files', '-s', 'a.ts').split(' ')[1];
    expect(blobOf('a.ts')).toMatch(new RegExp(`^${stagedA}:[0-9a-f]{16}$`));
    expect(blobOf('b.ts')).toBe('');
  });

  it('skips a clean file without reading it even while another file is dirty', async () => {
    await index();
    await fs.writeFile(path.join(root, 'b.ts'), 'export function bravo2() {}\n');

    const progress: Array<[number, number]> = [];
    const result = await index(undefined, (current, total) => progress.push([current, total]));

    // The first progress report is the pre-read skip: a.ts, vouched for by Git.
    expect(progress[0]).toEqual([1, 2]);
    expect(result.fileOutcomes?.parsed).toBe(1);
    expect(symbolsOf('b.ts')).toEqual(['bravo2']);
  });

  it('does not trust a file a targeted run rewrote, so a revert is re-indexed', async () => {
    await index();
    const a = path.join(root, 'a.ts');
    await fs.writeFile(a, 'export function edited() {}\n');
    await index([a]); // the watcher sees the edit
    expect(symbolsOf('a.ts')).toEqual(['edited']);

    // Reverted while no watcher ran: Git reports a.ts clean at its old blob.
    git('checkout', '--', 'a.ts');
    await index();

    expect(symbolsOf('a.ts')).toEqual(['alpha']);
  });

  it('never trusts a row that has no content hash', async () => {
    await index();
    // A legacy row: never hashed, never stamped, and missing its symbols.
    const db = new DatabaseSync(path.join(indexDir, 'index.db'));
    try {
      const a = path.join(root, 'a.ts');
      db.prepare("UPDATE files SET content_hash = '', git_blob = '' WHERE file = ?").run(a);
      db.prepare('DELETE FROM symbols WHERE file = ?').run(a);
    } finally {
      db.close();
    }

    await index();

    // gitBlobStamp(blob, '') is '' as well; equality alone skipped this file.
    expect(symbolsOf('a.ts')).toEqual(['alpha']);
  });

  it('re-reads only the files a branch switch changed', async () => {
    await index();
    git('checkout', '-qb', 'other');
    await fs.writeFile(path.join(root, 'b.ts'), 'export function other() {}\n');
    git('commit', '-qam', 'other');

    const progress: Array<[number, number]> = [];
    await index(undefined, (current, total) => progress.push([current, total]));

    expect(progress[0]).toEqual([1, 2]);
    expect(symbolsOf('b.ts')).toEqual(['other']);
    expect(symbolsOf('a.ts')).toEqual(['alpha']);
  });
});

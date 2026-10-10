import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteSageStore } from '../src/sqlite-store.js';

/**
 * Anchor verification, `existence` depth (the DEFAULT), must judge every
 * anchor type that names a path on disk.
 *
 * `verifyHygieneMemories` gated the active pass on a four-member type list —
 * `file | symbol | test | git` — so a `directory` or `package` anchor made the
 * guard vacuously TRUE for ANY path. Those anchors were never collected into
 * `existingPaths` either, so they could not fail: a memory whose anchored
 * directory or package was deleted stayed `active` forever and kept being
 * injected, even though the surrounding subsystem says it is stale:
 *
 *  - `existenceProvesAnchors` (sqlite-hygiene-anchors.ts) lists `directory`
 *    and `package` among the types existence IS able to prove;
 *  - `anchorsPresentOnDisk` stats them and requires `isDirectory()`;
 *  - the deep pass (`anchors/verify.ts`) returns stale for a missing or
 *    non-directory one.
 *
 * These tests run the real `store.hygiene()` facade over a real SQLite store
 * in a real tempdir — no mocks — so the result is the production path.
 */

const temps: Array<{ dir: string; store: SqliteSageStore }> = [];

async function newStore(): Promise<{ dir: string; store: SqliteSageStore }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sage-existence-anchor-'));
  const store = new SqliteSageStore({ projectRoot: dir });
  await store.initialize();
  const entry = { dir, store };
  temps.push(entry);
  return entry;
}

// Suppress every hygiene pass except anchor verification, so `staled` can only
// be moved by the verification result under test.
const VERIFY_ONLY = {
  verify: true,
  verifyDepth: 'existence',
  retentionDays: 3650,
  archiveLowConfidenceAfterDays: 3650,
  archiveUnusedAfterDays: 3650,
  unusedMinInjections: 100,
} as const;

afterEach(async () => {
  for (const entry of temps.splice(0)) {
    // Close before removing: the SQLite -shm/-wal sidecars stay locked on
    // Windows and `rm -r` then fails with EBUSY (teardown artifact, not result).
    entry.store.close();
    await fs.rm(entry.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe('existence-depth anchor verification', () => {
  it('keeps a directory-anchored memory active while the directory exists', async () => {
    const { dir, store } = await newStore();
    await fs.mkdir(path.join(dir, 'src', 'feature'), { recursive: true });

    const mem = await store.rememberSage({
      text: 'the feature module lives under src/feature',
      kind: 'fact',
      importance: 0.7,
      anchors: [{ type: 'directory', path: 'src/feature' }],
    });

    const report = await store.hygiene(VERIFY_ONLY);

    expect(report.staled).toBe(0);
    expect((await store.getSage(mem.id))?.status).toBe('active');
  });

  it('demotes a directory-anchored memory whose directory was deleted', async () => {
    const { dir, store } = await newStore();
    await fs.mkdir(path.join(dir, 'src', 'feature'), { recursive: true });

    const mem = await store.rememberSage({
      text: 'the feature module lives under src/feature',
      kind: 'fact',
      importance: 0.7,
      anchors: [{ type: 'directory', path: 'src/feature' }],
    });

    await fs.rm(path.join(dir, 'src', 'feature'), { recursive: true, force: true });

    const report = await store.hygiene(VERIFY_ONLY);

    expect(report.staled).toBe(1);
    expect((await store.getSage(mem.id))?.status).toBe('stale');
  });

  it('demotes a package-anchored memory whose directory was deleted', async () => {
    const { dir, store } = await newStore();
    await fs.mkdir(path.join(dir, 'node_modules', 'left-pad'), { recursive: true });

    const mem = await store.rememberSage({
      text: 'left-pad is vendored in this repo',
      kind: 'fact',
      importance: 0.7,
      anchors: [{ type: 'package', path: 'node_modules/left-pad' }],
    });

    await fs.rm(path.join(dir, 'node_modules', 'left-pad'), { recursive: true, force: true });

    const report = await store.hygiene(VERIFY_ONLY);

    expect(report.staled).toBe(1);
    expect((await store.getSage(mem.id))?.status).toBe('stale');
  });

  // Boundary: the anchor path exists but is no longer a directory. The deep
  // pass already refuses this shape; existence must agree.
  it('demotes a directory-anchored memory whose path became a file', async () => {
    const { dir, store } = await newStore();
    const anchor = path.join(dir, 'src', 'feature');
    await fs.mkdir(anchor, { recursive: true });

    const mem = await store.rememberSage({
      text: 'the feature module lives under src/feature',
      kind: 'fact',
      importance: 0.7,
      anchors: [{ type: 'directory', path: 'src/feature' }],
    });

    await fs.rm(anchor, { recursive: true, force: true });
    await fs.writeFile(anchor, 'not a directory\n');

    const report = await store.hygiene(VERIFY_ONLY);

    expect(report.staled).toBe(1);
    expect((await store.getSage(mem.id))?.status).toBe('stale');
  });

  // Control (unaffected path): a `file` anchor was always judged correctly.
  it('CONTROL: demotes a file-anchored memory whose file was deleted', async () => {
    const { dir, store } = await newStore();
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await fs.writeFile(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n');

    const mem = await store.rememberSage({
      text: 'a.ts exports the constant a',
      kind: 'fact',
      importance: 0.7,
      anchors: [{ type: 'file', path: 'src/a.ts' }],
    });

    await fs.rm(path.join(dir, 'src', 'a.ts'), { force: true });

    await store.hygiene(VERIFY_ONLY);

    expect((await store.getSage(mem.id))?.status).toBe('stale');
  });

  // Secondary branch: a `command` anchor carries no path, so existence must
  // leave it alone rather than resolving an unrelated path and judging on it.
  it('leaves a command-anchored memory to the deep pass', async () => {
    const { dir, store } = await newStore();
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });

    const mem = await store.rememberSage({
      text: 'run the contract test suite before release',
      kind: 'workflow',
      importance: 0.7,
      anchors: [{ type: 'command', command: 'pnpm test:contract' }],
    });

    const report = await store.hygiene(VERIFY_ONLY);

    expect(report.staled).toBe(0);
    expect((await store.getSage(mem.id))?.status).toBe('active');
  });
});

/**
 * Retention sweep for browser artifacts.
 *
 * Screenshots, traces and downloads had no prune anywhere in the repo, so an
 * artifact root grew for the life of the project (measured: 2.1 GB across 247
 * files). The sweep is detached and best-effort, so these tests await its
 * observable effect rather than the call itself — a sweep that silently does
 * nothing is exactly the failure being guarded against.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeProjectFixtureDirectory } from '../../core/tests/helpers/project-server-harness.js';
import { _resetArtifactSweepForTests, BrowserArtifactStore } from '../src/browser/artifacts.js';

let root: string;
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-artifacts-'));
  _resetArtifactSweepForTests();
});

afterEach(async () => {
  await removeProjectFixtureDirectory(root, { maxRetries: 10, retryDelay: 50 });
});

async function seed(session: string, name: string, ageDays: number): Promise<string> {
  const dir = path.join(root, session);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await fs.writeFile(file, 'x');
  const when = new Date(Date.now() - ageDays * DAY_MS);
  await fs.utimes(file, when, when);
  return file;
}

const exists = (file: string) =>
  fs.stat(file).then(
    () => true,
    () => false,
  );

/**
 * The sweep is fire-and-forget, so its effect has to be waited for.
 *
 * With a predicate this polls until the effect lands, which returns in a few
 * milliseconds normally and still tolerates a runner under load — a flat sleep
 * asserts at a fixed instant and fails whenever the sweep needs one tick more.
 * Without one (asserting a sweep did *not* happen) a quiet window is the only
 * thing that can be waited for, so that case keeps the fixed delay.
 */
async function settle(until?: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + (until ? 10_000 : 500);
  do {
    if (until && (await until())) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
}

describe('browser artifact retention', () => {
  it('removes artifacts past the retention window and keeps recent ones', async () => {
    const stale = await seed('sess-a', 'old.png', 30);
    const staleMeta = await seed('sess-a', 'old.metadata.json', 30);
    const fresh = await seed('sess-a', 'new.png', 1);

    new BrowserArtifactStore(root);
    await settle(async () => !(await exists(stale)) && !(await exists(staleMeta)));

    expect(await exists(stale)).toBe(false);
    expect(await exists(staleMeta)).toBe(false);
    expect(await exists(fresh)).toBe(true);
  });

  it('drops a session directory once every artifact in it has aged out', async () => {
    await seed('sess-empty', 'a.png', 30);
    await seed('sess-empty', 'b.png', 30);
    await seed('sess-keep', 'c.png', 1);

    new BrowserArtifactStore(root);
    await settle(async () => !(await exists(path.join(root, 'sess-empty'))));

    expect(await exists(path.join(root, 'sess-empty'))).toBe(false);
    expect(await exists(path.join(root, 'sess-keep'))).toBe(true);
  });

  it('sweeps a root only once per process', async () => {
    const stale = await seed('sess-a', 'old.png', 30);
    new BrowserArtifactStore(root);
    await settle(async () => !(await exists(stale)));
    expect(await exists(stale)).toBe(false);

    // A second store for the same root must not re-walk the tree.
    const reintroduced = await seed('sess-a', 'old.png', 30);
    new BrowserArtifactStore(root);
    await settle();
    expect(await exists(reintroduced)).toBe(true);
  });

  it('bounds the per-process swept-root memo and permits an evicted root to sweep again', async () => {
    const stale = await seed('sess-a', 'old.png', 30);
    new BrowserArtifactStore(root);
    await settle(async () => !(await exists(stale)));
    expect(await exists(stale)).toBe(false);

    for (let index = 0; index < 128; index++) {
      new BrowserArtifactStore(path.join(root, `missing-root-${index}`));
    }
    await settle();

    const reintroduced = await seed('sess-a', 'old.png', 30);
    new BrowserArtifactStore(root);
    await settle(async () => !(await exists(reintroduced)));
    expect(await exists(reintroduced)).toBe(false);
  });

  it('does not throw when the artifact root does not exist yet', async () => {
    const missing = path.join(root, 'not-created-yet');
    expect(() => new BrowserArtifactStore(missing)).not.toThrow();
    await settle();
  });

  it('routes empty or dot-only sessionIds to a default subdirectory and sanitizes extensions', async () => {
    const store = new BrowserArtifactStore(root);
    const derived = store.pathFor('', '..//../evil.png');
    expect(path.dirname(derived.path)).toBe(path.join(root, 'default'));
    expect(derived.path.endsWith('.evil.png')).toBe(true);

    const written = await store.write(
      '...',
      'screenshot',
      '...',
      'image/png',
      new Uint8Array([1, 2]),
    );
    expect(path.dirname(written.path)).toBe(path.join(root, 'default'));
    expect(written.path.endsWith('.bin')).toBe(true);
  });
});

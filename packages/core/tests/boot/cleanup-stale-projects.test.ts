/**
 * Keep/delete decisions of the per-project state-directory cleanup.
 *
 * This function recursively deletes directories under `~/.wrongstack/projects`,
 * so both halves matter equally: it must retire dirs that can no longer
 * describe a real project, and it must never touch one that can. The phantom
 * `<slug>-<hash>` case (root pointing back inside the state namespace) is the
 * residue of the bug `assertProjectRootOutsideStateDir` now refuses at boot —
 * the guard stops new ones but cannot retire what is already on disk, and the
 * older "root is gone" rule never matched them because their root exists.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupStaleProjects } from '../../src/boot.js';
import type { WstackPaths } from '../../src/utils/wstack-paths.js';

let globalRoot: string;
let projectsRoot: string;

beforeEach(async () => {
  globalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-cleanup-'));
  projectsRoot = path.join(globalRoot, 'projects');
  await fs.mkdir(projectsRoot, { recursive: true });
});

afterEach(async () => {
  await fs.rm(globalRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** `cleanupStaleProjects` only reads `path.dirname(wpaths.projectDir)`. */
function pathsFor(slug: string): WstackPaths {
  return { projectDir: path.join(projectsRoot, slug) } as never as WstackPaths;
}

async function seedProject(slug: string, meta: Record<string, unknown> | null): Promise<string> {
  const dir = path.join(projectsRoot, slug);
  await fs.mkdir(dir, { recursive: true });
  if (meta !== null) await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta));
  return dir;
}

const exists = (p: string) =>
  fs.stat(p).then(
    () => true,
    () => false,
  );

describe('cleanupStaleProjects', () => {
  it('removes a phantom project whose root points inside the state namespace', async () => {
    const real = await seedProject('proj-aaaa', { slug: 'proj-aaaa', root: globalRoot });
    const phantom = await seedProject('proj-aaaa-bbbb', {
      slug: 'proj-aaaa-bbbb',
      // The exact shape observed on disk: root is the real project's own
      // state directory, which very much exists — so the "root is gone" rule
      // never fired and these accumulated forever.
      root: path.join(projectsRoot, 'proj-aaaa'),
    });

    await cleanupStaleProjects(pathsFor('proj-aaaa'));

    expect(await exists(phantom)).toBe(false);
    expect(await exists(real)).toBe(true);
  });

  it('still removes a project whose root vanished', async () => {
    const gone = await seedProject('proj-gone', {
      root: path.join(globalRoot, 'no-such-working-copy'),
    });

    await cleanupStaleProjects(pathsFor('proj-gone'));

    expect(await exists(gone)).toBe(false);
  });

  it('keeps a project whose root still exists outside the state namespace', async () => {
    const workingCopy = path.join(globalRoot, 'real-repo');
    await fs.mkdir(workingCopy, { recursive: true });
    const kept = await seedProject('proj-live', { root: workingCopy });

    await cleanupStaleProjects(pathsFor('proj-live'));

    expect(await exists(kept)).toBe(true);
  });

  it('leaves directories with no readable meta.json alone', async () => {
    // Ambiguous — deleting these would be the destructive failure mode.
    const noMeta = await seedProject('proj-no-meta', null);
    const badMeta = path.join(projectsRoot, 'proj-bad-meta');
    await fs.mkdir(badMeta, { recursive: true });
    await fs.writeFile(path.join(badMeta, 'meta.json'), '{ not json');

    await cleanupStaleProjects(pathsFor('proj-no-meta'));

    expect(await exists(noMeta)).toBe(true);
    expect(await exists(badMeta)).toBe(true);
  });

  it('leaves a project whose meta.json has no root field', async () => {
    const kept = await seedProject('proj-rootless', { slug: 'proj-rootless' });

    await cleanupStaleProjects(pathsFor('proj-rootless'));

    expect(await exists(kept)).toBe(true);
  });
});

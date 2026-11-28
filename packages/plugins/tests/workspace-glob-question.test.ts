/**
 * Workspace glob expansion: `?` is a single-character wildcard.
 *
 * `resolveWorkspaces` reads npm/pnpm/yarn/bun `workspaces` declarations, where
 * `?` matches exactly one character and `*` zero or more. A `?` that leaks
 * into the matcher as a regex quantifier (or a `?`-only segment treated as a
 * literal directory name) selects the wrong package set for every collector
 * built on this helper — lockfile consistency, dependency drift, workspace
 * health, public API, release readiness, bundle budget and workflow manifests.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveWorkspaces } from '../src/evidence-analyzer/project.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Temp project with the given package directories and workspace patterns. */
async function project(dirs: string[], workspaces: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ws-glob-question-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'root', workspaces }), 'utf8');
  for (const name of dirs) {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, 'package.json'), JSON.stringify({ name }), 'utf8');
  }
  return root;
}

const DIRS = ['pk', 'pkg', 'pkg1', 'pkg12', 'glib'];

describe('resolveWorkspaces — `?` matches exactly one character', () => {
  it('selects only the directories the glob actually matches', async () => {
    const root = await project(DIRS, ['pkg?']);
    const info = await resolveWorkspaces(root, { workspaces: ['pkg?'] });
    expect(info.packages).toEqual(['pkg1']);
    expect(info.emptyPatterns).toEqual([]);
  });

  it('does not turn `?` into a regex quantifier in a mixed `*` pattern', async () => {
    const root = await project(DIRS, ['p?g*']);
    const info = await resolveWorkspaces(root, { workspaces: ['p?g*'] });
    // `p?g*` = p + one char + g + anything; `glib` must not match.
    expect(info.packages).toEqual(['pkg', 'pkg1', 'pkg12']);
  });

  it('honours repeated `?` as one character each', async () => {
    const root = await project(DIRS, ['p??']);
    const info = await resolveWorkspaces(root, { workspaces: ['p??'] });
    expect(info.packages).toEqual(['pkg']);
  });

  it('applies `?` in exclusion patterns too', async () => {
    const root = await project(DIRS, ['pkg*', '!pkg?']);
    const info = await resolveWorkspaces(root, { workspaces: ['pkg*', '!pkg?'] });
    expect(info.packages).toEqual(['pkg', 'pkg12']);
  });

  it('reports a genuinely unmatched `?` glob as an empty pattern', async () => {
    const root = await project(DIRS, ['zzz?']);
    const info = await resolveWorkspaces(root, { workspaces: ['zzz?'] });
    expect(info.packages).toEqual([]);
    expect(info.emptyPatterns).toEqual(['zzz?']);
  });
});

describe('controls — unaffected glob shapes keep working', () => {
  it('`*` still matches zero or more characters', async () => {
    const root = await project(DIRS, ['pkg*']);
    const info = await resolveWorkspaces(root, { workspaces: ['pkg*'] });
    expect(info.packages).toEqual(['pkg', 'pkg1', 'pkg12']);
  });

  it('a literal pattern still matches exactly its directory', async () => {
    const root = await project(DIRS, ['pkg']);
    const info = await resolveWorkspaces(root, { workspaces: ['pkg'] });
    expect(info.packages).toEqual(['pkg']);
  });

  it('regex metacharacters in a glob stay literal', async () => {
    const root = await project(['pkg+', 'pkgg'], ['pkg+']);
    const info = await resolveWorkspaces(root, { workspaces: ['pkg+'] });
    expect(info.packages).toEqual(['pkg+']);
  });
});

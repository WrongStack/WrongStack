import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectsCmd } from '../../src/subcommands/handlers/projects.js';

/**
 * `wstack projects` answers "which projects have I used WrongStack in".
 *
 * It used to enumerate the `projects/` directory, which also holds per-run
 * scratch state for ephemeral roots (Chimera review worktrees and the like).
 * On a working machine that printed 1,495 rows, 1,461 of them `(no meta)`,
 * against 30 real entries in the manifest. These tests pin the source.
 */
describe('wstack projects', () => {
  let globalRoot: string;
  let out: string[];

  const deps = () =>
    ({
      paths: { globalRoot },
      renderer: { write: (s: string) => out.push(s) },
    }) as never;

  beforeEach(async () => {
    globalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-projects-'));
    out = [];
  });

  afterEach(async () => {
    await fs.rm(globalRoot, { recursive: true, force: true });
  });

  async function writeManifest(projects: unknown[]): Promise<void> {
    await fs.writeFile(path.join(globalRoot, 'projects.json'), JSON.stringify({ projects }));
  }

  it('lists the manifest entries, not the projects directory', async () => {
    // Scratch dirs outnumber real projects on a working machine; none of them
    // belong in this listing.
    await fs.mkdir(path.join(globalRoot, 'projects', 'chimera-abc123-deadbe'), {
      recursive: true,
    });
    await fs.mkdir(path.join(globalRoot, 'projects', 'chimera-def456-c0ffee'), {
      recursive: true,
    });
    await writeManifest([
      { name: 'repo', root: 'D:/code/repo', slug: 'repo-abc123', lastSeen: '2026-09-01T00:00:00Z' },
    ]);

    expect(await projectsCmd([], deps())).toBe(0);
    const text = out.join('');
    expect(text).toContain('D:/code/repo');
    expect(text).not.toContain('chimera');
    expect(out).toHaveLength(1);
  });

  it('orders by last use, most recent first', async () => {
    await writeManifest([
      { name: 'old', root: 'D:/old', slug: 'old-1', lastSeen: '2026-01-01T00:00:00Z' },
      { name: 'new', root: 'D:/new', slug: 'new-1', lastSeen: '2026-09-01T00:00:00Z' },
      { name: 'mid', root: 'D:/mid', slug: 'mid-1', lastSeen: '2026-05-01T00:00:00Z' },
    ]);

    await projectsCmd([], deps());
    const roots = out.map((line) => line.trim().split(/\s+/).at(-1));
    expect(roots).toEqual(['D:/new', 'D:/mid', 'D:/old']);
  });

  it('reports an empty state instead of failing when there is no manifest', async () => {
    expect(await projectsCmd([], deps())).toBe(0);
    expect(out.join('')).toContain('No projects tracked yet.');
  });

  it('treats a malformed manifest as empty rather than throwing', async () => {
    await fs.writeFile(path.join(globalRoot, 'projects.json'), '{ not json');
    expect(await projectsCmd([], deps())).toBe(0);
    expect(out.join('')).toContain('No projects tracked yet.');
  });

  it('survives entries missing optional fields', async () => {
    await writeManifest([{ root: 'D:/partial' }, {}]);
    expect(await projectsCmd([], deps())).toBe(0);
    const text = out.join('');
    expect(text).toContain('D:/partial');
    expect(text).toContain('?');
  });
});

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetcherMocks = vi.hoisted(() => ({
  downloadGitHubTarball: vi.fn(),
}));

vi.mock('../../src/skills/github-fetcher.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    downloadGitHubTarball: fetcherMocks.downloadGitHubTarball,
  };
});

import { SkillInstaller } from '../../src/skills/skill-installer.js';

let tmpRoot: string;
let projectSkillsDir: string;
let globalSkillsDir: string;
let manifestPath: string;
let mockRepoDir: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-installer-'));
  projectSkillsDir = path.join(tmpRoot, 'project-skills');
  globalSkillsDir = path.join(tmpRoot, 'global-skills');
  manifestPath = path.join(tmpRoot, 'manifest.json');
  mockRepoDir = path.join(tmpRoot, 'repo-src');
  await fs.mkdir(mockRepoDir, { recursive: true });
  fetcherMocks.downloadGitHubTarball.mockReset();
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function mkInstaller(
  extra: Partial<{
    skillLoader: unknown;
    log: (m: string) => void;
    registryAdapters: SkillRegistryAdapter[];
  }> = {},
) {
  return new SkillInstaller({
    manifestPath,
    projectSkillsDir,
    globalSkillsDir,
    projectHash: 'hash-1',
    ...extra,
  } as never);
}

async function seedSingleSkillRepo(dir: string, name = 'my-skill', desc = 'd'): Promise<void> {
  await fs.writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${desc}\n---\nbody`,
  );
}

async function seedMultiSkillRepo(dir: string, names: string[]): Promise<void> {
  const sdir = path.join(dir, 'skills');
  await fs.mkdir(sdir, { recursive: true });
  for (const n of names) {
    const d = path.join(sdir, n);
    await fs.mkdir(d, { recursive: true });
    await fs.writeFile(
      path.join(d, 'SKILL.md'),
      `---\nname: ${n}\ndescription: ${n}-desc\n---\n# ${n}`,
    );
    await fs.writeFile(path.join(d, 'extra.md'), 'extra content');
  }
}

// ── install ─────────────────────────────────────────────────────────────────

describe('SkillInstaller.install', () => {
  it('installs a single-skill repo (SKILL.md at root) into project scope', async () => {
    await seedSingleSkillRepo(mockRepoDir, 'alpha');
    fetcherMocks.downloadGitHubTarball.mockResolvedValue({ tempDir: mockRepoDir });
    const inst = mkInstaller();
    const res = await inst.install('user/alpha@main');
    expect(res).toHaveLength(1);
    expect(res[0]!.name).toBe('alpha');
    expect(res[0]!.scope).toBe('project');
    expect(res[0]!.source).toBe('github:user/alpha');
    expect(res[0]!.ref).toBe('main');
    // File should exist at destination
    const installed = await fs.readFile(path.join(projectSkillsDir, 'alpha', 'SKILL.md'), 'utf8');
    expect(installed).toContain('name: alpha');
  });

  it('installs into user scope when global=true', async () => {
    await seedSingleSkillRepo(mockRepoDir);
    fetcherMocks.downloadGitHubTarball.mockResolvedValue({ tempDir: mockRepoDir });
    const inst = mkInstaller();
    const [res] = await inst.install('user/my-skill', { global: true });
    expect(res.scope).toBe('user');
    expect(res.path.startsWith(globalSkillsDir)).toBe(true);
  });

  it('installs every skill from a multi-skill repo (skills/ subdirectory)', async () => {
    await seedMultiSkillRepo(mockRepoDir, ['a', 'b', 'c']);
    fetcherMocks.downloadGitHubTarball.mockResolvedValue({ tempDir: mockRepoDir });
    const inst = mkInstaller();
    const res = await inst.install('user/repo');
    expect(res).toHaveLength(3);
    expect(res.map((r) => r.name).sort()).toEqual(['a', 'b', 'c']);
    // Extra files copied
    const extra = await fs.readFile(path.join(projectSkillsDir, 'a', 'extra.md'), 'utf8');
    expect(extra).toContain('extra content');
  });

  it('throws when no skills are found in the repository', async () => {
    // Empty repo
    fetcherMocks.downloadGitHubTarball.mockResolvedValue({ tempDir: mockRepoDir });
    const inst = mkInstaller();
    await expect(inst.install('user/empty')).rejects.toThrow(/No skills found/);
  });

  it('overwrites an existing skill in the same scope (logs a message)', async () => {
    await seedSingleSkillRepo(mockRepoDir, 'over');
    fetcherMocks.downloadGitHubTarball.mockResolvedValue({ tempDir: mockRepoDir });
    const log = vi.fn();
    const inst = mkInstaller({ log });
    await inst.install('user/over');
    // Reset mock so a fresh temp dir is used for the 2nd call
    const tmp2 = path.join(tmpRoot, 'repo-src2');
    await fs.mkdir(tmp2, { recursive: true });
    await seedSingleSkillRepo(tmp2, 'over', 'd2');
    fetcherMocks.downloadGitHubTarball.mockResolvedValue({ tempDir: tmp2 });
    await inst.install('user/over@v2');
    expect(log.mock.calls.flat().join(' ')).toContain('Overwriting');
  });

  it('invalidates the skill loader cache when one is wired', async () => {
    await seedSingleSkillRepo(mockRepoDir);
    fetcherMocks.downloadGitHubTarball.mockResolvedValue({ tempDir: mockRepoDir });
    const invalidateCache = vi.fn();
    const inst = mkInstaller({ skillLoader: { invalidateCache } });
    await inst.install('user/my-skill');
    expect(invalidateCache).toHaveBeenCalled();
  });

  it('cleans up the temp directory even on failure', async () => {
    // Empty temp dir → throws "No skills found"
    fetcherMocks.downloadGitHubTarball.mockResolvedValue({ tempDir: mockRepoDir });
    const inst = mkInstaller();
    await expect(inst.install('user/x')).rejects.toThrow();
    // tempDir should have been removed
    await expect(fs.access(mockRepoDir)).rejects.toThrow();
  });

  it('rejects skill files larger than the 100KB limit', async () => {
    // Build a multi-skill layout where one file is too large
    const sdir = path.join(mockRepoDir, 'skills', 'big');
    await fs.mkdir(sdir, { recursive: true });
    await fs.writeFile(
      path.join(sdir, 'SKILL.md'),
      `---\nname: big\ndescription: too-big\n---\n# big`,
    );
    await fs.writeFile(path.join(sdir, 'huge.bin'), 'x'.repeat(150 * 1024));
    fetcherMocks.downloadGitHubTarball.mockResolvedValue({ tempDir: mockRepoDir });
    const inst = mkInstaller();
    await expect(inst.install('user/big')).rejects.toThrow(/too large/);
  });

  it('uses the parsed ref string in the install result', async () => {
    await seedSingleSkillRepo(mockRepoDir, 's');
    fetcherMocks.downloadGitHubTarball.mockResolvedValue({ tempDir: mockRepoDir });
    const inst = mkInstaller();
    const [res] = await inst.install('user/s@feature-branch');
    expect(res.ref).toBe('feature-branch');
  });
});

// ── listInstalled ───────────────────────────────────────────────────────────

describe('SkillInstaller.listInstalled', () => {
  it('returns an empty array when nothing is installed', async () => {
    const inst = mkInstaller();
    expect(await inst.listInstalled()).toEqual([]);
  });

  it('lists every installed skill after install', async () => {
    await seedMultiSkillRepo(mockRepoDir, ['x', 'y']);
    fetcherMocks.downloadGitHubTarball.mockResolvedValue({ tempDir: mockRepoDir });
    const inst = mkInstaller();
    await inst.install('user/repo');
    const list = await inst.listInstalled();
    expect(list.map((e) => e.name).sort()).toEqual(['x', 'y']);
    for (const entry of list) {
      expect(entry.scope).toBe('project');
      expect(entry.source).toBe('github:user/repo');
    }
  });
});

// ── uninstall ───────────────────────────────────────────────────────────────

describe('SkillInstaller.uninstall', () => {
  it('removes the skill files and manifest entry', async () => {
    await seedSingleSkillRepo(mockRepoDir, 'rm');
    fetcherMocks.downloadGitHubTarball.mockResolvedValue({ tempDir: mockRepoDir });
    const inst = mkInstaller();
    await inst.install('user/rm');
    await inst.uninstall('rm');
    // Files gone
    await expect(fs.access(path.join(projectSkillsDir, 'rm'))).rejects.toThrow();
    // Manifest empty
    expect(await inst.listInstalled()).toEqual([]);
  });

  it('throws when skill is not installed in the requested scope', async () => {
    const inst = mkInstaller();
    await expect(inst.uninstall('ghost')).rejects.toThrow(/not installed/);
    await expect(inst.uninstall('ghost', { global: true })).rejects.toThrow(/\(global\)/);
  });

  it('invalidates the loader cache on uninstall too', async () => {
    await seedSingleSkillRepo(mockRepoDir, 'x');
    fetcherMocks.downloadGitHubTarball.mockResolvedValue({ tempDir: mockRepoDir });
    const invalidateCache = vi.fn();
    const inst = mkInstaller({ skillLoader: { invalidateCache } });
    await inst.install('user/x');
    invalidateCache.mockReset();
    await inst.uninstall('x');
    expect(invalidateCache).toHaveBeenCalled();
  });
});

// ── update ──────────────────────────────────────────────────────────────────

describe('SkillInstaller.update', () => {
  it('reports an "invalid reference" error when the argument is unparseable', async () => {
    const inst = mkInstaller();
    const res = await inst.update('does-not-exist');
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]!.error).toMatch(/Invalid reference/);
  });

  it('reports "no installed skills found" when arg parses but matches no source', async () => {
    const inst = mkInstaller();
    const res = await inst.update('owner/repo@v1');
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]!.error).toMatch(/No installed skills found/);
  });

  it('updates an installed skill by name (re-install at the original ref)', async () => {
    await seedSingleSkillRepo(mockRepoDir, 'upd');
    fetcherMocks.downloadGitHubTarball.mockResolvedValue({ tempDir: mockRepoDir });
    const inst = mkInstaller();
    await inst.install('user/upd@v1');
    // Prepare a fresh temp dir for the update download
    const tmp2 = path.join(tmpRoot, 'repo-src-update');
    await fs.mkdir(tmp2, { recursive: true });
    await seedSingleSkillRepo(tmp2, 'upd', 'updated');
    fetcherMocks.downloadGitHubTarball.mockResolvedValue({ tempDir: tmp2 });
    const res = await inst.update('upd');
    expect(res.updated).toHaveLength(1);
    expect(res.updated[0]!.name).toBe('upd');
    expect(res.errors).toEqual([]);
  });

  it('updates all installed skills when no argument is given', async () => {
    await seedMultiSkillRepo(mockRepoDir, ['m', 'n']);
    fetcherMocks.downloadGitHubTarball.mockResolvedValue({ tempDir: mockRepoDir });
    const inst = mkInstaller();
    await inst.install('user/r');
    // Fresh dir for re-install
    const tmp2 = path.join(tmpRoot, 'repo-src-all');
    await fs.mkdir(tmp2, { recursive: true });
    await seedMultiSkillRepo(tmp2, ['m', 'n']);
    fetcherMocks.downloadGitHubTarball.mockResolvedValue({ tempDir: tmp2 });
    const res = await inst.update();
    expect(res.updated.map((u) => u.name).sort()).toEqual(['m', 'n']);
  });

  it('records errors from the download step against every matching entry', async () => {
    await seedSingleSkillRepo(mockRepoDir, 'broken');
    fetcherMocks.downloadGitHubTarball.mockResolvedValue({ tempDir: mockRepoDir });
    const inst = mkInstaller();
    await inst.install('user/broken@v1');
    // Make the next download fail
    fetcherMocks.downloadGitHubTarball.mockRejectedValue(new Error('network down'));
    const res = await inst.update('broken');
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]!.name).toBe('broken');
    expect(res.errors[0]!.error).toContain('network down');
  });
});

// ── importFromDir ────────────────────────────────────────────────────────────

describe('SkillInstaller.importFromDir', () => {
  it('copies valid skills from a local directory, skipping invalid names', async () => {
    const src = path.join(tmpRoot, 'claude-skills');
    await fs.mkdir(path.join(src, 'valid-skill', 'references'), { recursive: true });
    await fs.writeFile(
      path.join(src, 'valid-skill', 'SKILL.md'),
      '---\nname: valid-skill\ndescription: d\n---\nimported body',
    );
    await fs.writeFile(path.join(src, 'valid-skill', 'references', 'REF.md'), '# ref');
    // Invalid name (uppercase) → skipped
    await fs.mkdir(path.join(src, 'BadName'), { recursive: true });
    await fs.writeFile(
      path.join(src, 'BadName', 'SKILL.md'),
      '---\nname: BadName\ndescription: d\n---\nbody',
    );
    // Non-skill subdir (no SKILL.md) → skipped
    await fs.mkdir(path.join(src, 'not-a-skill'), { recursive: true });

    const inst = mkInstaller();
    const results = await inst.importFromDir(src);
    expect(results.map((r) => r.name)).toEqual(['valid-skill']);

    const dest = path.join(projectSkillsDir, 'valid-skill', 'SKILL.md');
    expect(await fs.readFile(dest, 'utf8')).toContain('imported body');
    await expect(
      fs.access(path.join(projectSkillsDir, 'valid-skill', 'references', 'REF.md')),
    ).resolves.toBeUndefined();
    const installed = await inst.listInstalled();
    expect(installed.find((e) => e.name === 'valid-skill')?.scope).toBe('project');
  });

  it('targets the global dir when --global is requested', async () => {
    const src = path.join(tmpRoot, 'src2');
    await fs.mkdir(path.join(src, 'g-skill'), { recursive: true });
    await fs.writeFile(
      path.join(src, 'g-skill', 'SKILL.md'),
      '---\nname: g-skill\ndescription: d\n---\nbody',
    );

    const inst = mkInstaller();
    await inst.importFromDir(src, { global: true });
    await expect(
      fs.access(path.join(globalSkillsDir, 'g-skill', 'SKILL.md')),
    ).resolves.toBeUndefined();
    expect((await inst.listInstalled()).find((e) => e.name === 'g-skill')?.scope).toBe('user');
  });

  it('throws when the source directory does not exist', async () => {
    const inst = mkInstaller();
    await expect(inst.importFromDir(path.join(tmpRoot, 'nope'))).rejects.toThrow(
      /not found or not readable/,
    );
  });
});

// ── registry adapters + search() ───────────────────────────────────────────

import { githubDirectAdapter } from '../../src/skills/registry/github-direct-adapter.js';
import type { SkillRegistryAdapter } from '../../src/skills/registry/registry-adapter.js';

function stubAdapter(
  id: string,
  overrides: Partial<SkillRegistryAdapter> = {},
): SkillRegistryAdapter {
  return {
    id,
    displayName: id,
    search: vi.fn().mockResolvedValue({ adapterId: id, results: [] }),
    resolveInstallRef: vi.fn((ref: string) => ref),
    ...overrides,
  };
}

describe('SkillInstaller — registry ref resolution', () => {
  it('resolves skills.sh:<id> through the adapter before installing', async () => {
    const resolved: string[] = [];
    const skillsSh = stubAdapter('skills.sh', {
      resolveInstallRef: (id) => {
        resolved.push(id);
        return 'octocat/registry-skill';
      },
    });
    await seedSingleSkillRepo(mockRepoDir, 'registry-skill');
    fetcherMocks.downloadGitHubTarball.mockResolvedValue({ tempDir: mockRepoDir });

    const inst = mkInstaller({ registryAdapters: [githubDirectAdapter, skillsSh] } as never);
    const res = await inst.install('skills.sh:octocat/registry-skill@v1');
    expect(resolved).toEqual(['octocat/registry-skill@v1']);
    expect(res[0]?.source).toBe('github:octocat/registry-skill');
    // manifest carries the registry provenance
    const installed = await inst.listInstalled();
    expect(installed[0]?.registryFrom?.adapterId).toBe('skills.sh');
  });

  it('passes a bare user/repo ref straight to github (no adapter resolution)', async () => {
    const skillsSh = stubAdapter('skills.sh');
    await seedSingleSkillRepo(mockRepoDir, 'direct');
    fetcherMocks.downloadGitHubTarball.mockResolvedValue({ tempDir: mockRepoDir });

    const inst = mkInstaller({ registryAdapters: [githubDirectAdapter, skillsSh] } as never);
    const res = await inst.install('user/direct');
    expect(res[0]?.source).toBe('github:user/direct');
    expect(skillsSh.resolveInstallRef).not.toHaveBeenCalled();
    const installed = await inst.listInstalled();
    expect(installed[0]?.registryFrom).toBeUndefined();
  });

  it('does not treat a plain owner/repo with no adapter prefix as a registry ref', async () => {
    // An adapter id of "github" exists, but "user/repo" has no colon → not a
    // registry ref. Guards against misreading URLs / paths.
    const github = stubAdapter('github');
    await seedSingleSkillRepo(mockRepoDir, 'plain');
    fetcherMocks.downloadGitHubTarball.mockResolvedValue({ tempDir: mockRepoDir });
    const inst = mkInstaller({ registryAdapters: [github] } as never);
    const res = await inst.install('user/plain');
    expect(res[0]?.name).toBe('plain');
    expect(github.resolveInstallRef).not.toHaveBeenCalled();
  });
});

describe('SkillInstaller.search', () => {
  it('merges results across adapters and dedupes by installRef', async () => {
    const a = stubAdapter('a', {
      search: vi.fn().mockResolvedValue({
        adapterId: 'a',
        results: [
          { id: '1', name: 'shared', description: 'd', installRef: 'o/repo' },
          { id: '2', name: 'a-only', description: 'd', installRef: 'o/a-only' },
        ],
      }),
    });
    const b = stubAdapter('b', {
      search: vi.fn().mockResolvedValue({
        adapterId: 'b',
        results: [
          { id: '1', name: 'shared-dup', description: 'd', installRef: 'o/repo' }, // dup
          { id: '3', name: 'b-only', description: 'd', installRef: 'o/b-only' },
        ],
      }),
    });
    const inst = mkInstaller({ registryAdapters: [a, b] } as never);
    const blocks = await inst.search('x');
    const all = blocks.flatMap((bl) => bl.results);
    expect(all.map((r) => r.installRef).sort()).toEqual(['o/a-only', 'o/b-only', 'o/repo']);
    // adapter a won the dedup for o/repo
    const sharedBlock = blocks.find((bl) => bl.adapterId === 'a');
    expect(sharedBlock?.results.find((r) => r.installRef === 'o/repo')?.name).toBe('shared');
  });

  it('continues when one adapter rejects (logs, keeps others)', async () => {
    const a = stubAdapter('a', {
      search: vi.fn().mockResolvedValue({
        adapterId: 'a',
        results: [{ id: '1', name: 'ok', description: 'd', installRef: 'o/ok' }],
      }),
    });
    const b = stubAdapter('b', { search: vi.fn().mockRejectedValue(new Error('down')) });
    const inst = mkInstaller({
      registryAdapters: [a, b],
      log: () => {},
    } as never);
    const blocks = await inst.search('x');
    expect(blocks).toHaveLength(1); // only adapter a's results survived
    expect(blocks[0]?.results[0]?.name).toBe('ok');
  });

  it('uses only the github-direct adapter when none are configured', async () => {
    const inst = mkInstaller(); // default → [githubDirectAdapter]
    const blocks = await inst.search('anything');
    // github-direct returns empty
    expect(blocks.flatMap((b) => b.results)).toEqual([]);
  });
});

// ── delete containment (WS-097) ─────────────────────────────────────────────

/**
 * `removeSkillFiles` runs `fs.rm(dir, { recursive: true, force: true })` on a
 * path built from a skill NAME taken from manifest frontmatter. `path.join`
 * normalises `..`, so a crafted name escaped the skills directory and took the
 * recursive delete with it. The file already had `isInside` and applied it on
 * the copy path, but not here.
 *
 * Reached through the private method directly: the install path only calls it
 * when overwriting an already-installed skill, and the guard is what is under
 * test, not the route to it.
 */
describe('SkillInstaller delete containment (WS-097)', () => {
  const callRemove = (inst: SkillInstaller, name: string, scope: 'project' | 'user') =>
    (
      inst as unknown as {
        removeSkillFiles(n: string, s: 'project' | 'user'): Promise<void>;
      }
    ).removeSkillFiles(name, scope);

  it('refuses a traversing skill name', async () => {
    const inst = mkInstaller();
    const outside = path.join(tmpRoot, 'DO-NOT-DELETE');
    await fs.mkdir(outside, { recursive: true });

    await expect(callRemove(inst, '../DO-NOT-DELETE', 'project')).rejects.toThrow(
      /outside the skills directory/,
    );
    // The directory it aimed at is still there.
    await expect(fs.stat(outside)).resolves.toBeDefined();
  });

  it('refuses a name that resolves to the skills directory itself', async () => {
    // `isInside` allows equality by design, so an empty or `.` name would have
    // deleted every installed skill.
    const inst = mkInstaller();
    await fs.mkdir(projectSkillsDir, { recursive: true });
    await fs.mkdir(path.join(projectSkillsDir, 'keeper'), { recursive: true });

    for (const name of ['', '.', './']) {
      await expect(callRemove(inst, name, 'project')).rejects.toThrow(
        /outside the skills directory/,
      );
    }
    await expect(fs.stat(path.join(projectSkillsDir, 'keeper'))).resolves.toBeDefined();
  });

  it('still removes an ordinary skill directory', async () => {
    const inst = mkInstaller();
    const dir = path.join(projectSkillsDir, 'ordinary');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), 'x');

    await callRemove(inst, 'ordinary', 'project');
    await expect(fs.stat(dir)).rejects.toThrow();
  });
});

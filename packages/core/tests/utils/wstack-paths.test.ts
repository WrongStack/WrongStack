import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canonicalProjectRoot,
  projectHash,
  projectSlug,
  resolveWstackPaths,
  wstackGlobalRoot,
} from '../../src/utils/wstack-paths.js';

describe('wstack-paths', () => {
  it('projectHash is stable for the same absolute path', () => {
    const a = projectHash('/some/project');
    const b = projectHash('/some/project');
    expect(a).toBe(b);
  });

  it('projectHash differs across paths', () => {
    expect(projectHash('/a')).not.toBe(projectHash('/b'));
  });

  it('projectSlug uses folder basename + short hash', () => {
    const slug = projectSlug('/work/my-project');
    expect(slug).toMatch(/^my-project-[a-f0-9]{6}$/);
  });

  it('projectSlug is stable for the same path', () => {
    expect(projectSlug('/a/b/c')).toBe(projectSlug('/a/b/c'));
  });

  it('projectSlug differs when basenames differ', () => {
    expect(projectSlug('/work/foo')).not.toBe(projectSlug('/work/bar'));
  });

  it('slugify collapses special chars', () => {
    // imported indirectly via projectSlug
    const s = projectSlug('/tmp/My Cool Project!');
    expect(s).toMatch(/^my-cool-project-[a-f0-9]{6}$/);
  });

  it('shares global project identity across linked Git worktrees', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-worktree-identity-'));
    const main = path.join(tmp, 'main-repo');
    const linked = path.join(tmp, 'task-checkout');
    const linkedGitDir = path.join(main, '.git', 'worktrees', 'task-checkout');
    try {
      await fs.mkdir(linkedGitDir, { recursive: true });
      await fs.mkdir(linked, { recursive: true });
      await fs.writeFile(path.join(linked, '.git'), `gitdir: ${linkedGitDir}\n`);
      await fs.writeFile(path.join(linkedGitDir, 'commondir'), '../..\n');
      await fs.writeFile(path.join(linkedGitDir, 'gitdir'), `${path.join(linked, '.git')}\n`);

      expect(canonicalProjectRoot(linked)).toBe(path.resolve(main));
      expect(projectHash(linked)).toBe(projectHash(main));
      expect(projectSlug(linked)).toBe(projectSlug(main));

      const mainPaths = resolveWstackPaths({
        projectRoot: main,
        globalRoot: path.join(tmp, 'home'),
      });
      const linkedPaths = resolveWstackPaths({
        projectRoot: linked,
        globalRoot: path.join(tmp, 'home'),
      });
      expect(linkedPaths.projectDir).toBe(mainPaths.projectDir);
      expect(linkedPaths.inProjectAgentsFile).not.toBe(mainPaths.inProjectAgentsFile);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('keeps its own identity when a .git file or symlink borrows another worktree entry', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-worktree-backlink-'));
    const main = path.join(tmp, 'main-repo');
    const linked = path.join(tmp, 'task-checkout');
    const linkedGitDir = path.join(main, '.git', 'worktrees', 'task-checkout');
    try {
      await fs.mkdir(linkedGitDir, { recursive: true });
      await fs.mkdir(linked, { recursive: true });
      await fs.writeFile(path.join(linked, '.git'), `gitdir: ${linkedGitDir}\n`);
      await fs.writeFile(path.join(linkedGitDir, 'commondir'), '../..\n');
      await fs.writeFile(path.join(linkedGitDir, 'gitdir'), `${path.join(linked, '.git')}\n`);
      expect(canonicalProjectRoot(linked)).toBe(path.resolve(main));

      // The same `.git` file in an unrelated directory: Git's back-link
      // (`worktrees/task-checkout/gitdir`) names the real worktree only.
      const planted = path.join(tmp, 'planted');
      await fs.mkdir(planted, { recursive: true });
      await fs.copyFile(path.join(linked, '.git'), path.join(planted, '.git'));
      expect(canonicalProjectRoot(planted)).toBe(path.resolve(planted));
      expect(projectHash(planted)).not.toBe(projectHash(main));

      // A symlink to the real worktree's `.git` file is not this checkout's own.
      const symlinked = path.join(tmp, 'symlinked');
      await fs.mkdir(symlinked, { recursive: true });
      const made = await fs
        .symlink(path.join(linked, '.git'), path.join(symlinked, '.git'), 'file')
        .then(() => true)
        .catch(() => false); // Windows without the symlink privilege
      if (made) expect(canonicalProjectRoot(symlinked)).toBe(path.resolve(symlinked));

      // A worktree entry that records another checkout (a moved worktree that
      // was not repaired) no longer shares the identity either.
      await fs.writeFile(
        path.join(linkedGitDir, 'gitdir'),
        `${path.join(tmp, 'elsewhere', '.git')}\n`,
      );
      expect(canonicalProjectRoot(linked)).toBe(path.resolve(linked));
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('accepts a relative worktree back-link (worktree.useRelativePaths)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-worktree-relative-'));
    const main = path.join(tmp, 'main-repo');
    const linked = path.join(tmp, 'task-checkout');
    const linkedGitDir = path.join(main, '.git', 'worktrees', 'task-checkout');
    try {
      await fs.mkdir(linkedGitDir, { recursive: true });
      await fs.mkdir(linked, { recursive: true });
      await fs.writeFile(
        path.join(linked, '.git'),
        'gitdir: ../main-repo/.git/worktrees/task-checkout\n',
      );
      await fs.writeFile(path.join(linkedGitDir, 'commondir'), '../..\n');
      await fs.writeFile(path.join(linkedGitDir, 'gitdir'), '../../../../task-checkout/.git\n');
      expect(canonicalProjectRoot(linked)).toBe(path.resolve(main));
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('keys the path-bearing codebase index by checkout, not by shared project identity (#414)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-worktree-index-'));
    const main = path.join(tmp, 'main-repo');
    const globalRoot = path.join(tmp, 'home');
    try {
      const linkWorktree = async (name: string): Promise<string> => {
        const checkout = path.join(tmp, name);
        const gitDir = path.join(main, '.git', 'worktrees', name);
        await fs.mkdir(gitDir, { recursive: true });
        await fs.mkdir(checkout, { recursive: true });
        await fs.writeFile(path.join(checkout, '.git'), `gitdir: ${gitDir}\n`);
        await fs.writeFile(path.join(gitDir, 'commondir'), '../..\n');
        await fs.writeFile(path.join(gitDir, 'gitdir'), `${path.join(checkout, '.git')}\n`);
        return checkout;
      };
      const featureX = await linkWorktree('repo-feature-x');
      const featureY = await linkWorktree('repo-feature-y');
      const indexOf = (root: string) =>
        resolveWstackPaths({ projectRoot: root, globalRoot }).projectCodebaseIndex;

      // The main checkout keeps its existing location, so current indexes stay valid.
      expect(indexOf(main)).toBe(
        path.join(
          resolveWstackPaths({ projectRoot: main, globalRoot }).projectDir,
          'codebase-index',
        ),
      );
      // Each linked worktree gets a distinct index of its own.
      const dirs = new Set([indexOf(main), indexOf(featureX), indexOf(featureY)]);
      expect(dirs.size).toBe(3);
      // Stable for the same checkout, and still under the shared project dir.
      expect(indexOf(featureX)).toBe(indexOf(featureX));
      expect(path.dirname(path.dirname(indexOf(featureX)))).toBe(
        resolveWstackPaths({ projectRoot: main, globalRoot }).projectDir,
      );
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('keeps Git submodules distinct from their superproject identity', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-submodule-identity-'));
    const main = path.join(tmp, 'main-repo');
    const submodule = path.join(main, 'vendor', 'child');
    const gitDir = path.join(main, '.git', 'modules', 'child');
    try {
      await fs.mkdir(gitDir, { recursive: true });
      await fs.mkdir(submodule, { recursive: true });
      await fs.writeFile(path.join(submodule, '.git'), `gitdir: ${gitDir}\n`);
      await fs.writeFile(path.join(gitDir, 'commondir'), '../..\n');
      expect(canonicalProjectRoot(submodule)).toBe(path.resolve(submodule));
      expect(projectSlug(submodule)).not.toBe(projectSlug(main));
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  // NTFS ignores case but the identity hash did not: `D:\Repo` and `d:\repo`
  // (cmd.exe keeps the typed casing) were two projects with two session stores.
  it.runIf(process.platform === 'win32')(
    'gives one directory one identity whatever the path casing',
    async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-case-identity-'));
      const dir = path.join(tmp, 'MyRepo');
      try {
        await fs.mkdir(dir);
        const spellings = [dir, dir.toLowerCase(), dir.toUpperCase()];
        expect(new Set(spellings.map((s) => projectSlug(s))).size).toBe(1);
        expect(new Set(spellings.map((s) => projectHash(s))).size).toBe(1);
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    },
  );

  it('resolves global + project dirs under user home', () => {
    const userHome = path.resolve('/home/dev');
    const projectRoot = path.resolve('/work/x');
    const paths = resolveWstackPaths({
      userHome,
      projectRoot,
    });
    expect(paths.globalRoot).toBe(path.join(userHome, '.wrongstack'));
    expect(paths.profileName).toBe('default');
    expect(paths.profileDir).toBe(path.join(userHome, '.wrongstack', 'profiles', 'default'));
    expect(paths.globalSkills).toBe(
      path.join(userHome, '.wrongstack', 'profiles', 'default', 'skills'),
    );
    expect(paths.inProjectSkills).toBe(path.join(projectRoot, '.wrongstack', 'skills'));
    expect(paths.modelsCache).toContain('cache');
    expect(paths.projectDir).toContain('projects');
    expect(paths.projectDir).toContain(paths.projectSlug);
  });

  it('resolves every user-owned path under the active profile bootstrap', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-profile-paths-'));
    const globalRoot = path.join(tmp, '.wrongstack');
    try {
      await fs.mkdir(globalRoot, { recursive: true });
      await fs.writeFile(
        path.join(globalRoot, 'config.json'),
        JSON.stringify({ version: 1, activeProfile: 'work' }),
      );
      const paths = resolveWstackPaths({ projectRoot: path.join(tmp, 'project'), globalRoot });
      const profileDir = path.join(globalRoot, 'profiles', 'work');

      expect(paths.profileName).toBe('work');
      expect(paths.configDir).toBe(profileDir);
      expect(paths.globalMemory).toBe(path.join(profileDir, 'memory.md'));
      expect(paths.globalSkills).toBe(path.join(profileDir, 'skills'));
      expect(paths.globalDesignKits).toBe(path.join(profileDir, 'design-kits'));
      expect(paths.globalPrompts).toBe(path.join(profileDir, 'prompts'));
      expect(paths.globalInstructions).toBe(path.join(profileDir, 'instructions'));
      expect(paths.promptUsage).toBe(path.join(profileDir, 'prompt-usage.json'));
      expect(paths.historyFile).toBe(path.join(profileDir, 'history'));
      expect(paths.syncConfig).toBe(path.join(profileDir, 'sync.json'));
      expect(paths.secretsKey).toBe(path.join(globalRoot, '.key'));
      expect(paths.modelsCache).toBe(path.join(globalRoot, 'cache', 'models.dev.json'));
      expect(paths.projectDir).toContain(path.join(globalRoot, 'projects'));
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('validates project status slugs before constructing a path', () => {
    const paths = resolveWstackPaths({ userHome: '/home/dev', projectRoot: '/work/x' });
    expect(paths.projectStatus('wrongstack-a1b2c3')).toBe(
      path.join(
        path.resolve('/home/dev'),
        '.wrongstack',
        'projects',
        'wrongstack-a1b2c3',
        'status.json',
      ),
    );
    expect(() => paths.projectStatus('../escape')).toThrow('Invalid project slug');
    expect(() => paths.projectStatus(paths.projectHash)).toThrow('Invalid project slug');
  });

  it('only AGENTS.md and skills are project-local', () => {
    const paths = resolveWstackPaths({
      userHome: '/home/dev',
      projectRoot: '/work/x',
    });
    const sep = path.sep;
    const projSeg = `${sep}work${sep}x`;
    expect(paths.inProjectAgentsFile).toContain(projSeg);
    expect(paths.inProjectSkills).toContain(projSeg);
    expect(paths.projectSessions).not.toContain(projSeg);
    expect(paths.projectTrust).not.toContain(projSeg);
    expect(paths.projectMemory).not.toContain(projSeg);
  });

  it('keeps AutoPhase state under the per-project dir', () => {
    const paths = resolveWstackPaths({
      userHome: '/home/dev',
      projectRoot: '/work/x',
    });
    expect(paths.projectAutophase).toBe(path.join(paths.projectDir, 'autophase'));
    expect(paths.projectAutophase).toContain(paths.projectSlug);
  });
});

describe('wstackGlobalRoot', () => {
  // wstackGlobalRoot honours the WRONGSTACK_HOME env var so tests and
  // sandboxed runs can redirect ALL global state (~/.wrongstack) away
  // from the real user home. See the function's docstring for the
  // original motivation (~20k orphaned fixture dirs under projects/ in
  // the pre-env-var days).
  const prev = process.env['WRONGSTACK_HOME'];
  const restore = () => {
    if (prev === undefined) delete process.env['WRONGSTACK_HOME'];
    else process.env['WRONGSTACK_HOME'] = prev;
  };

  it('returns WRONGSTACK_HOME when set (absolute path resolved)', () => {
    // Use an absolute path that path.resolve() preserves cross-platform.
    // On Linux/macOS `/tmp/wstack-override-1234` stays as-is; on Windows
    // path.resolve('/foo') prepends the cwd drive, so we use the cwd
    // explicitly to keep the test hermetic.
    const hermeticAbs = path.resolve(os.tmpdir(), 'wstack-override-1234');
    try {
      process.env['WRONGSTACK_HOME'] = hermeticAbs;
      expect(wstackGlobalRoot()).toBe(hermeticAbs);
    } finally {
      restore();
    }
  });

  it('resolves a relative WRONGSTACK_HOME against cwd', () => {
    // path.resolve('/some/cwd', 'rel') → '/some/cwd/rel'. Use a known
    // absolute cwd to keep this cross-platform.
    try {
      process.env['WRONGSTACK_HOME'] = 'rel/.wrongstack';
      const got = wstackGlobalRoot();
      // Should be the absolute resolved form, not the relative literal.
      expect(path.isAbsolute(got)).toBe(true);
      expect(got).toMatch(/rel[/\\].?wrongstack$/);
    } finally {
      restore();
    }
  });

  it('treats a whitespace-only WRONGSTACK_HOME as unset', () => {
    try {
      process.env['WRONGSTACK_HOME'] = '   ';
      // Should fall through to the homedir fallback, NOT to "   ".
      const got = wstackGlobalRoot();
      expect(got).not.toBe('   ');
      expect(got.endsWith('.wrongstack')).toBe(true);
    } finally {
      restore();
    }
  });

  it('falls back to ~/.wrongstack (cross-platform via os.homedir) when unset', () => {
    try {
      delete process.env['WRONGSTACK_HOME'];
      const got = wstackGlobalRoot();
      // On Linux/macOS: <homedir>/.wrongstack. On Windows: also
      // <homedir>/.wrongstack (os.homedir() reads USERPROFILE). The
      // contract is "<homedir>/.wrongstack" — the path module handles
      // the separator.
      expect(got.endsWith(`${path.sep}.wrongstack`)).toBe(true);
    } finally {
      restore();
    }
  });
});

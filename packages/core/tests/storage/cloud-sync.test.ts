import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { WstackPaths } from '../../src/utils/wstack-paths.js';
import type { SyncCategory, SyncConfig } from '../../src/types/config.js';
import { CloudSync } from '../../src/storage/cloud-sync.js';

const mockSyncConfig: SyncConfig = {
  enabled: true,
  repo: 'testuser/testrepo',
  categories: ['settings', 'prompts'],
};

const mockPaths: WstackPaths = {
  globalRoot: '',
  profileName: 'default',
  profileDir: '',
  configDir: '',
  globalConfig: '',
  globalSkills: '',
  globalPrompts: '',
  globalMemory: '',
  historyFile: '',
  sessionDir: '',
  logsDir: '',
  pluginsDir: '',
};

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudsync-test-'));
  try {
    mockPaths.configDir = dir;
    await fn(dir);
  } finally {
    mockPaths.configDir = '';
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('CloudSync', () => {
  describe('constructor', () => {
    it('stores paths and config callbacks without calling them', async () => {
      await withTempDir(async (dir) => {
        const paths: WstackPaths = { ...mockPaths, globalRoot: dir };
        const getConfig = vi.fn<() => SyncConfig | null>(() => mockSyncConfig);
        const setConfig = vi.fn<(_: SyncConfig) => Promise<void>>();

        const sync = new CloudSync(paths, getConfig, setConfig);

        expect(getConfig).not.toHaveBeenCalled();
        expect(setConfig).not.toHaveBeenCalled();

        await sync.status();
        expect(getConfig).toHaveBeenCalledTimes(1);
      });
    });

    it('resolves the settings category to the active profile, not the root bootstrap', async () => {
      await withTempDir(async (dir) => {
        const bootstrapPath = path.join(dir, 'config.json');
        const profilePath = path.join(dir, 'profiles', 'work', 'config.json');
        await fs.mkdir(path.dirname(profilePath), { recursive: true });
        await fs.writeFile(bootstrapPath, JSON.stringify({ version: 1, activeProfile: 'work' }));
        await fs.writeFile(profilePath, JSON.stringify({ provider: 'anthropic' }));
        const paths = {
          ...mockPaths,
          globalRoot: dir,
          globalConfig: bootstrapPath,
          profileConfig: (name: string) => path.join(dir, 'profiles', name, 'config.json'),
        } as WstackPaths;
        const sync = new CloudSync(
          paths,
          () => mockSyncConfig,
          vi.fn(),
          () => profilePath,
        );

        const tree = await (
          sync as unknown as {
            buildLocalTree(categories: SyncCategory[]): Promise<{
              treeEntries: Array<{ path: string; content: string; mode: string }>;
            }>;
          }
        ).buildLocalTree(['settings']);

        expect(tree.treeEntries).toEqual([
          {
            path: 'data/settings',
            content: JSON.stringify({ provider: 'anthropic' }),
            mode: '100644',
          },
        ]);
        expect(tree.treeEntries[0]?.content).not.toContain('activeProfile');
      });
    });
  });

  describe('status()', () => {
    it('returns disabled message when config is null', async () => {
      await withTempDir(async (dir) => {
        const sync = new CloudSync({ ...mockPaths, globalRoot: dir }, () => null, vi.fn());
        const result = await sync.status();
        expect(result).toContain('disabled');
      });
    });

    it('returns disabled message when enabled is false', async () => {
      await withTempDir(async (dir) => {
        const sync = new CloudSync(
          { ...mockPaths, globalRoot: dir },
          () => ({ ...mockSyncConfig, enabled: false }),
          vi.fn(),
        );
        const result = await sync.status();
        expect(result).toContain('disabled');
      });
    });

    it('includes repo and categories when enabled', async () => {
      await withTempDir(async (dir) => {
        const sync = new CloudSync(
          { ...mockPaths, globalRoot: dir },
          () => mockSyncConfig,
          vi.fn(),
        );
        const result = await sync.status();
        expect(result).toContain('enabled');
        expect(result).toContain('testuser/testrepo');
        expect(result).toContain('settings');
        expect(result).toContain('prompts');
      });
    });

    it('shows "never" when no state file exists', async () => {
      await withTempDir(async (dir) => {
        const sync = new CloudSync(
          { ...mockPaths, globalRoot: dir },
          () => mockSyncConfig,
          vi.fn(),
        );
        await sync.loadState();
        const result = await sync.status();
        expect(result).toContain('never');
      });
    });

    it('shows time-ago string when state file exists', async () => {
      await withTempDir(async (dir) => {
        const twoMinsAgo = new Date(Date.now() - 2 * 60_000).toISOString();
        await fs.writeFile(
          path.join(dir, 'sync-state.json'),
          JSON.stringify({ version: 1, sha: 'abc123', lastSyncedAt: twoMinsAgo, localRev: 'rev1' }),
        );
        const sync = new CloudSync(
          { ...mockPaths, globalRoot: dir },
          () => mockSyncConfig,
          vi.fn(),
        );
        await sync.loadState();
        const result = await sync.status();
        expect(result).toContain('2m ago');
      });
    });
  });

  describe('loadState()', () => {
    it('loads and parses a valid state file', async () => {
      await withTempDir(async (dir) => {
        // Use a date computed relative to now so the day-count assertion does
        // not drift as wall-clock time advances.
        const daysAgo = 880;
        const lastSyncedAt = new Date(Date.now() - daysAgo * 24 * 60 * 60_000).toISOString();
        await fs.writeFile(
          path.join(dir, 'sync-state.json'),
          JSON.stringify({ version: 1, sha: 'abc', lastSyncedAt, localRev: 'r1' }),
        );
        const sync = new CloudSync(
          { ...mockPaths, globalRoot: dir },
          () => mockSyncConfig,
          vi.fn(),
        );
        await sync.loadState();
        const result = await sync.status();
        expect(result).toContain(`${daysAgo}d ago`);
      });
    });

    it('sets state to null when file does not exist', async () => {
      await withTempDir(async (dir) => {
        const sync = new CloudSync(
          { ...mockPaths, globalRoot: dir },
          () => mockSyncConfig,
          vi.fn(),
        );
        await sync.loadState();
        const result = await sync.status();
        expect(result).toContain('never');
      });
    });

    it('sets state to null when file is malformed JSON', async () => {
      await withTempDir(async (dir) => {
        await fs.writeFile(path.join(dir, 'sync-state.json'), 'not valid json');
        const sync = new CloudSync(
          { ...mockPaths, globalRoot: dir },
          () => mockSyncConfig,
          vi.fn(),
        );
        await sync.loadState();
        const result = await sync.status();
        expect(result).toContain('never');
      });
    });
  });

  describe('disable()', () => {
    it('calls setConfig with enabled: false', async () => {
      await withTempDir(async (dir) => {
        const setConfig = vi.fn<(_: SyncConfig) => Promise<void>>();
        const sync = new CloudSync(
          { ...mockPaths, globalRoot: dir },
          () => mockSyncConfig,
          setConfig,
        );

        await sync.disable();

        expect(setConfig).toHaveBeenCalledTimes(1);
        const [cfg] = setConfig.mock.calls[0]!;
        expect(cfg.enabled).toBe(false);
        expect(cfg.repo).toBe('testuser/testrepo');
      });
    });

    it('returns error message when config is null', async () => {
      await withTempDir(async (dir) => {
        const sync = new CloudSync({ ...mockPaths, globalRoot: dir }, () => null, vi.fn());
        const result = await sync.disable();
        expect(result).toContain('not configured');
      });
    });
  });

  describe('hasLocalChanges()', () => {
    it('returns false immediately after a successful push', async () => {
      await withTempDir(async (dir) => {
        const promptsPath = path.join(dir, 'prompts');
        await fs.mkdir(promptsPath, { recursive: true });
        await fs.writeFile(path.join(promptsPath, 'note.txt'), 'hello');
        const paths = { ...mockPaths, configDir: dir, globalPrompts: promptsPath } as WstackPaths;
        const sync = new CloudSync(
          paths,
          () => ({ enabled: true, repo: 'testuser/testrepo', categories: ['prompts'] }),
          vi.fn(),
        );
        vi.spyOn(sync, 'githubFetch' as keyof CloudSync).mockImplementation((async (
          _t: string,
          _o: string,
          _r: string,
          method: string,
          segment: string,
        ) => {
          if (method === 'GET' && segment.includes('/git/refs/heads/main')) {
            throw new Error('GitHub API GET failed (404): missing');
          }
          if (method === 'POST' && segment === '/git/trees') return { sha: 'tree' };
          if (method === 'POST' && segment === '/git/commits') return { sha: 'commit' };
          return {};
        }) as never);

        await sync.push('token');
        expect(await sync.hasLocalChanges()).toBe(false);
      });
    });

    it('returns true when state is null', async () => {
      await withTempDir(async (dir) => {
        const sync = new CloudSync({ ...mockPaths, globalRoot: dir }, () => null, vi.fn());
        await sync.loadState();
        expect(await sync.hasLocalChanges()).toBe(true);
      });
    });

    it('returns true when getConfig returns null even with existing state', async () => {
      await withTempDir(async (dir) => {
        await fs.writeFile(
          path.join(dir, 'sync-state.json'),
          JSON.stringify({
            version: 1,
            sha: 'abc',
            lastSyncedAt: '2024-01-01T00:00:00Z',
            localRev: 'rev1',
          }),
        );
        const sync = new CloudSync({ ...mockPaths, globalRoot: dir }, () => null, vi.fn());
        await sync.loadState();
        expect(await sync.hasLocalChanges()).toBe(true);
      });
    });
  });

  describe('push() — state file writing', () => {
    it('writes sync-state.json after a successful push', async () => {
      await withTempDir(async (dir) => {
        const promptsPath = path.join(dir, 'prompts');
        await fs.mkdir(promptsPath, { recursive: true });
        await fs.writeFile(path.join(promptsPath, 'note.txt'), 'hello');

        const paths: WstackPaths = {
          ...mockPaths,
          globalRoot: dir,
          globalConfig: path.join(dir, 'config.json'),
          globalSkills: path.join(dir, 'skills'),
          globalPrompts: promptsPath,
          globalMemory: path.join(dir, 'memory'),
          historyFile: path.join(dir, 'history.json'),
        };
        await fs.writeFile(paths.globalConfig, '{}');
        await fs.writeFile(paths.historyFile, '[]');

        const sync = new CloudSync(
          paths,
          () => ({
            enabled: true,
            repo: 'testuser/testrepo',
            categories: ['prompts'],
          }),
          vi.fn(),
        );

        // Mock GitHub API calls via spy on private githubFetch
        vi.spyOn(sync, 'githubFetch' as keyof CloudSync).mockImplementation((async (
          _t: string,
          _o: string,
          _r: string,
          method: string,
          seg: string,
        ) => {
          if (method === 'GET' && seg === '/git/refs/heads/main')
            return { object: { sha: 'remote-commit' } };
          if (method === 'GET' && seg === '/git/commits/remote-commit')
            return { tree: { sha: 'remote-tree' }, message: 'm' };
          if (method === 'POST' && seg === '/git/trees') return { sha: 'tree-sha-abc' };
          if (method === 'POST' && seg === '/git/commits') return { sha: 'commit-sha-abc' };
          if (method === 'PATCH' && seg === '/git/refs/heads/main') return {};
          return {};
        }) as never);

        const result = await sync.push('fake-token');

        expect(result.ok).toBe(true);
        expect(result.action).toBe('push');
        expect(result.message).toMatch(/commit/i);

        const stateRaw = await fs.readFile(path.join(dir, 'sync-state.json'), 'utf8');
        const state = JSON.parse(stateRaw);
        expect(state.version).toBe(1);
        expect(state.sha).toBe('commit-sha-abc');
        expect(state.lastSyncedAt).toBeTruthy();
        expect(state.localRev).toBeTruthy();
      });
    });
  });

  describe('pull() — state file writing', () => {
    it('writes sync-state.json after a successful pull', async () => {
      await withTempDir(async (dir) => {
        const promptsPath = path.join(dir, 'prompts');
        await fs.mkdir(promptsPath, { recursive: true });
        const paths: WstackPaths = {
          ...mockPaths,
          globalRoot: dir,
          globalConfig: path.join(dir, 'config.json'),
          globalSkills: path.join(dir, 'skills'),
          globalPrompts: promptsPath,
          globalMemory: path.join(dir, 'memory'),
          historyFile: path.join(dir, 'history.json'),
        };
        await fs.writeFile(paths.globalConfig, '{}');
        await fs.writeFile(paths.historyFile, '[]');

        const sync = new CloudSync(
          paths,
          () => ({
            enabled: true,
            repo: 'testuser/testrepo',
            categories: ['prompts'],
          }),
          vi.fn(),
        );

        vi.spyOn(sync, 'githubFetch' as keyof CloudSync).mockImplementation((async (
          _t: string,
          _o: string,
          _r: string,
          method: string,
          seg: string,
        ) => {
          if (method === 'GET' && seg.startsWith('/git/refs/heads/')) {
            return { object: { sha: 'remote-commit-sha' } };
          }
          if (method === 'GET' && seg.startsWith('/git/commits/')) {
            return { tree: { sha: 'tree-sha-xyz' } };
          }
          if (method === 'GET' && seg.startsWith('/git/trees/')) return [];
          return {};
        }) as never);

        const result = await sync.pull('fake-token');

        expect(result.ok).toBe(true);
        expect(result.action).toBe('pull');

        const stateRaw = await fs.readFile(path.join(dir, 'sync-state.json'), 'utf8');
        const state = JSON.parse(stateRaw);
        expect(state.sha).toBe('remote-commit-sha');
        expect(state.lastSyncedAt).toBeTruthy();
      });
    });
  });

  describe('getConfig callback — called on every relevant operation', () => {
    it('is called by status()', async () => {
      await withTempDir(async (dir) => {
        const getConfig = vi.fn<() => SyncConfig | null>(() => mockSyncConfig);
        const sync = new CloudSync({ ...mockPaths, globalRoot: dir }, getConfig, vi.fn());
        await sync.status();
        expect(getConfig).toHaveBeenCalledTimes(1);
      });
    });

    it('is called by disable()', async () => {
      await withTempDir(async (dir) => {
        const getConfig = vi.fn<() => SyncConfig | null>(() => mockSyncConfig);
        const sync = new CloudSync({ ...mockPaths, globalRoot: dir }, getConfig, vi.fn());
        await sync.disable();
        expect(getConfig).toHaveBeenCalledTimes(1);
      });
    });

    it('is called by push()', async () => {
      await withTempDir(async (dir) => {
        const promptsPath = path.join(dir, 'prompts');
        await fs.mkdir(promptsPath, { recursive: true });
        await fs.writeFile(path.join(promptsPath, 'note.txt'), 'hello');

        const paths: WstackPaths = {
          ...mockPaths,
          globalRoot: dir,
          globalConfig: path.join(dir, 'config.json'),
          globalSkills: path.join(dir, 'skills'),
          globalPrompts: promptsPath,
          globalMemory: path.join(dir, 'memory'),
          historyFile: path.join(dir, 'history.json'),
        };
        await fs.writeFile(paths.globalConfig, '{}');
        await fs.writeFile(paths.historyFile, '[]');

        const getConfig = vi.fn<() => SyncConfig | null>(() => ({
          enabled: true,
          repo: 'u/r',
          categories: ['prompts'],
        }));
        const sync = new CloudSync(paths, getConfig, vi.fn());

        vi.spyOn(sync, 'githubFetch' as keyof CloudSync).mockImplementation((async (
          _t: string,
          _o: string,
          _r: string,
          method: string,
          segment: string,
        ) => {
          if (method === 'GET' && segment === '/git/refs/heads/main') {
            return { object: { sha: 'remote-commit' } };
          }
          if (method === 'GET' && segment === '/git/commits/remote-commit') {
            return { tree: { sha: 'remote-tree' }, message: 'm' };
          }
          return { sha: 'c' };
        }) as never);

        await sync.push('tok');
        expect(getConfig).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('setConfig callback — called when config changes', () => {
    it('is called by disable() with enabled: false and preserved fields', async () => {
      await withTempDir(async (dir) => {
        const setConfig = vi.fn<(_: SyncConfig) => Promise<void>>();
        const getConfig = vi.fn<() => SyncConfig | null>(() => ({
          enabled: true,
          repo: 'my/repo',
          categories: ['memory'],
        }));
        const sync = new CloudSync({ ...mockPaths, globalRoot: dir }, getConfig, setConfig);

        await sync.disable();

        expect(setConfig).toHaveBeenCalledTimes(1);
        const [sent] = setConfig.mock.calls[0]!;
        expect(sent.enabled).toBe(false);
        expect(sent.repo).toBe('my/repo');
        expect(sent.categories).toEqual(['memory']);
      });
    });

    it('preserves categories when disabling', async () => {
      await withTempDir(async (dir) => {
        const setConfig = vi.fn<(_: SyncConfig) => Promise<void>>();
        const sync = new CloudSync(
          { ...mockPaths, globalRoot: dir },
          () => ({ enabled: true, repo: 'a/b', categories: ['skills', 'history'] }),
          setConfig,
        );

        await sync.disable();

        const [sent] = setConfig.mock.calls[0]!;
        expect(sent.categories).toEqual(['skills', 'history']);
      });
    });
  });

  describe('timeAgo() formatting in status()', () => {
    it('returns "just now" for recent timestamps', async () => {
      await withTempDir(async (dir) => {
        const justNow = new Date(Date.now() - 30_000).toISOString();
        await fs.writeFile(
          path.join(dir, 'sync-state.json'),
          JSON.stringify({ version: 1, sha: 'x', lastSyncedAt: justNow, localRev: 'r' }),
        );
        const sync = new CloudSync(
          { ...mockPaths, globalRoot: dir },
          () => mockSyncConfig,
          vi.fn(),
        );
        await sync.loadState();
        const result = await sync.status();
        expect(result).toContain('just now');
      });
    });

    it('returns Xh ago for hours-old timestamps', async () => {
      await withTempDir(async (dir) => {
        const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
        await fs.writeFile(
          path.join(dir, 'sync-state.json'),
          JSON.stringify({ version: 1, sha: 'x', lastSyncedAt: threeHoursAgo, localRev: 'r' }),
        );
        const sync = new CloudSync(
          { ...mockPaths, globalRoot: dir },
          () => mockSyncConfig,
          vi.fn(),
        );
        await sync.loadState();
        const result = await sync.status();
        expect(result).toMatch(/\d+h ago/);
      });
    });

    it('returns Xd ago for day-old timestamps', async () => {
      await withTempDir(async (dir) => {
        const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60_000).toISOString();
        await fs.writeFile(
          path.join(dir, 'sync-state.json'),
          JSON.stringify({ version: 1, sha: 'x', lastSyncedAt: fiveDaysAgo, localRev: 'r' }),
        );
        const sync = new CloudSync(
          { ...mockPaths, globalRoot: dir },
          () => mockSyncConfig,
          vi.fn(),
        );
        await sync.loadState();
        const result = await sync.status();
        expect(result).toContain('5d ago');
      });
    });
  });

  describe('directory traversal safety', () => {
    it('does not upload a category whose root is a symlink', async ({ skip }) => {
      await withTempDir(async (dir) => {
        const outsidePrompts = path.join(dir, 'outside-prompts');
        const promptsLink = path.join(dir, 'prompts-link');
        await fs.mkdir(outsidePrompts, { recursive: true });
        await fs.writeFile(path.join(outsidePrompts, 'secret.txt'), 'secret outside the profile');
        try {
          await fs.symlink(outsidePrompts, promptsLink, 'junction');
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EPERM') {
            skip('symlink creation is not permitted on this platform');
            return;
          }
          throw err;
        }
        const paths = { ...mockPaths, configDir: dir, globalPrompts: promptsLink } as WstackPaths;
        const sync = new CloudSync(
          paths,
          () => ({ enabled: true, repo: 'testuser/testrepo', categories: ['prompts'] }),
          vi.fn(),
        );

        const tree = await (
          sync as unknown as {
            buildLocalTree(categories: SyncCategory[]): Promise<{
              treeEntries: Array<{ path: string; content: string; mode: string }>;
            }>;
          }
        ).buildLocalTree(['prompts']);

        expect(tree.treeEntries).toEqual([]);
      });
    });

    it('does not upload files reached through symlinks', async ({ skip }) => {
      await withTempDir(async (dir) => {
        const promptsPath = path.join(dir, 'prompts');
        const outsidePath = path.join(dir, 'outside.txt');
        await fs.mkdir(promptsPath, { recursive: true });
        await fs.writeFile(outsidePath, 'secret outside the profile');
        try {
          await fs.symlink(outsidePath, path.join(promptsPath, 'outside-link.txt'));
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EPERM') {
            skip('symlink creation is not permitted on this platform');
            return;
          }
          throw err;
        }
        const paths = { ...mockPaths, configDir: dir, globalPrompts: promptsPath } as WstackPaths;
        const sync = new CloudSync(
          paths,
          () => ({ enabled: true, repo: 'testuser/testrepo', categories: ['prompts'] }),
          vi.fn(),
        );

        const tree = await (
          sync as unknown as {
            buildLocalTree(categories: SyncCategory[]): Promise<{
              treeEntries: Array<{ path: string; content: string; mode: string }>;
            }>;
          }
        ).buildLocalTree(['prompts']);

        expect(tree.treeEntries).toEqual([]);
      });
    });
  });

  describe('pull() path safety', () => {
    it('rejects a symlinked category root before downloading the blob', async ({ skip }) => {
      await withTempDir(async (dir) => {
        const outsideSkills = path.join(dir, 'outside-skills');
        const skillsLink = path.join(dir, 'skills-link');
        await fs.mkdir(outsideSkills, { recursive: true });
        try {
          await fs.symlink(outsideSkills, skillsLink, 'junction');
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EPERM') {
            skip('symlink creation is not permitted on this platform');
            return;
          }
          throw err;
        }
        const sync = new CloudSync(
          { ...mockPaths, globalRoot: dir, globalSkills: skillsLink } as WstackPaths,
          () => ({ enabled: true, repo: 'testuser/testrepo', categories: ['skills'] }),
          vi.fn(),
        );
        vi.spyOn(sync, 'getRef' as keyof CloudSync).mockResolvedValue({
          object: { sha: 'commit' },
        } as never);
        vi.spyOn(sync, 'getCommit' as keyof CloudSync).mockResolvedValue({
          tree: { sha: 'tree' },
        } as never);
        vi.spyOn(sync, 'getTreeEntries' as keyof CloudSync).mockResolvedValue([
          { path: 'data/skills/a.txt', sha: 'blob', type: 'blob' },
        ] as never);
        const getBlob = vi
          .spyOn(sync, 'getBlob' as keyof CloudSync)
          .mockResolvedValue(Buffer.from('owned').toString('base64') as never);

        await expect(sync.pull('fake-token')).rejects.toThrow(/symlink/i);
        expect(getBlob).not.toHaveBeenCalled();
        await expect(fs.readFile(path.join(outsideSkills, 'a.txt'), 'utf8')).rejects.toThrow();
      });
    });

    it('rejects an existing symlink destination before downloading the blob', async ({ skip }) => {
      await withTempDir(async (dir) => {
        const skillsPath = path.join(dir, 'skills');
        const outsideFile = path.join(dir, 'outside.txt');
        await fs.mkdir(skillsPath, { recursive: true });
        await fs.writeFile(outsideFile, 'safe');
        try {
          await fs.symlink(outsideFile, path.join(skillsPath, 'a.txt'));
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EPERM') {
            skip('symlink creation is not permitted on this platform');
            return;
          }
          throw err;
        }
        const sync = new CloudSync(
          { ...mockPaths, globalRoot: dir, globalSkills: skillsPath } as WstackPaths,
          () => ({ enabled: true, repo: 'testuser/testrepo', categories: ['skills'] }),
          vi.fn(),
        );
        vi.spyOn(sync, 'getRef' as keyof CloudSync).mockResolvedValue({
          object: { sha: 'commit' },
        } as never);
        vi.spyOn(sync, 'getCommit' as keyof CloudSync).mockResolvedValue({
          tree: { sha: 'tree' },
        } as never);
        vi.spyOn(sync, 'getTreeEntries' as keyof CloudSync).mockResolvedValue([
          { path: 'data/skills/a.txt', sha: 'blob', type: 'blob' },
        ] as never);
        const getBlob = vi
          .spyOn(sync, 'getBlob' as keyof CloudSync)
          .mockResolvedValue(Buffer.from('owned').toString('base64') as never);

        await expect(sync.pull('fake-token')).rejects.toThrow(/symlink/i);
        expect(getBlob).not.toHaveBeenCalled();
        expect(await fs.readFile(outsideFile, 'utf8')).toBe('safe');
      });
    });

    it('rejects backslash traversal that reaches the final containment guard', async () => {
      await withTempDir(async (dir) => {
        const paths: WstackPaths = {
          ...mockPaths,
          globalRoot: dir,
          globalSkills: path.join(dir, 'skills'),
        };
        const sync = new CloudSync(
          paths,
          () => ({ enabled: true, repo: 'testuser/testrepo', categories: ['skills'] }),
          vi.fn(),
        );

        vi.spyOn(sync, 'getRef' as keyof CloudSync).mockResolvedValue({
          object: { sha: 'commit' },
        } as never);
        vi.spyOn(sync, 'getCommit' as keyof CloudSync).mockResolvedValue({
          tree: { sha: 'tree' },
        } as never);
        vi.spyOn(sync, 'getTreeEntries' as keyof CloudSync).mockResolvedValue([
          { path: 'data/skills/..\\escape.txt', sha: 'blob', type: 'blob' },
        ] as never);

        await expect(sync.pull('fake-token')).rejects.toThrow(
          /outside category root|path traversal/i,
        );
      });
    });

    it('rejects remote tree paths that escape a directory-backed category root', async () => {
      await withTempDir(async (dir) => {
        const paths: WstackPaths = {
          ...mockPaths,
          globalRoot: dir,
          globalConfig: path.join(dir, 'config.json'),
          globalSkills: path.join(dir, 'skills'),
        };
        const sync = new CloudSync(
          paths,
          () => ({ enabled: true, repo: 'testuser/testrepo', categories: ['skills'] }),
          vi.fn(),
        );

        vi.spyOn(sync, 'getRef' as keyof CloudSync).mockResolvedValue({
          object: { sha: 'commit' },
        } as never);
        vi.spyOn(sync, 'getCommit' as keyof CloudSync).mockResolvedValue({
          tree: { sha: 'tree' },
        } as never);
        vi.spyOn(sync, 'getTreeEntries' as keyof CloudSync).mockResolvedValue([
          { path: 'data/skills/../../config.json', sha: 'blob', type: 'blob' },
        ] as never);
        vi.spyOn(sync, 'getBlob' as keyof CloudSync).mockResolvedValue(
          Buffer.from('owned').toString('base64') as never,
        );

        await expect(sync.pull('fake-token')).rejects.toThrow(/path traversal/i);
        await expect(fs.readFile(path.join(dir, 'config.json'), 'utf8')).rejects.toThrow();
      });
    });

    it('rejects nested remote paths for file-backed categories', async () => {
      await withTempDir(async (dir) => {
        const paths: WstackPaths = {
          ...mockPaths,
          globalRoot: dir,
          globalConfig: path.join(dir, 'config.json'),
        };
        const sync = new CloudSync(
          paths,
          () => ({ enabled: true, repo: 'testuser/testrepo', categories: ['settings'] }),
          vi.fn(),
        );

        vi.spyOn(sync, 'getRef' as keyof CloudSync).mockResolvedValue({
          object: { sha: 'commit' },
        } as never);
        vi.spyOn(sync, 'getCommit' as keyof CloudSync).mockResolvedValue({
          tree: { sha: 'tree' },
        } as never);
        vi.spyOn(sync, 'getTreeEntries' as keyof CloudSync).mockResolvedValue([
          { path: 'data/settings/nested/config.json', sha: 'blob', type: 'blob' },
        ] as never);

        await expect(sync.pull('fake-token')).rejects.toThrow(/file category/i);
      });
    });
  });
});

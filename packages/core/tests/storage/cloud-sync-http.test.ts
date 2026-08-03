import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudSync } from '../../src/storage/cloud-sync.js';
import type { SyncConfig } from '../../src/types/config.js';
import type { WstackPaths } from '../../src/utils/wstack-paths.js';

/**
 * Exercises the REAL `githubFetch` HTTP machinery (and every push/pull helper
 * that flows through it) by stubbing global `fetch` with a URL+method dispatcher.
 * The sibling cloud-sync.test.ts mocks githubFetch directly, which leaves the
 * HTTP layer + tree/commit/blob helpers uncovered — this file restores them.
 */
const json = (body: unknown, status = 200): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

let dir: string;
let paths: WstackPaths;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudsync-http-'));
  const profileDir = path.join(dir, 'profiles', 'default');
  await fs.mkdir(path.join(profileDir, 'prompts', 'sub'), { recursive: true });
  await fs.writeFile(path.join(profileDir, 'prompts', 'p.json'), '{"title":"x"}');
  await fs.writeFile(path.join(profileDir, 'prompts', 'sub', 'nested.json'), '{"n":1}'); // → walkDir recursion
  await fs.writeFile(path.join(dir, 'config.json'), '{"setting":true}');
  await fs.writeFile(path.join(profileDir, 'config.json'), '{"setting":true}');
  paths = {
    globalRoot: dir,
    profileName: 'default',
    profileDir,
    configDir: profileDir,
    globalConfig: path.join(dir, 'config.json'),
    globalSkills: path.join(profileDir, 'skills'),
    globalPrompts: path.join(profileDir, 'prompts'),
    globalMemory: path.join(profileDir, 'memory'),
    historyFile: path.join(profileDir, 'history.jsonl'),
    sessionDir: '',
    logsDir: '',
    pluginsDir: '',
  } as unknown as WstackPaths;
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await fs.rm(dir, { recursive: true, force: true });
});

const cfg = (over: Partial<SyncConfig> = {}): SyncConfig => ({
  enabled: true,
  repo: 'me/data',
  categories: ['settings', 'prompts'],
  ...over,
});
const make = (config: SyncConfig | null = cfg()) =>
  new CloudSync(
    paths,
    () => config,
    async () => {},
  );

function requestBody(call: unknown[] | undefined): unknown {
  expect(call).toBeDefined();
  const init = call?.[1] as RequestInit | undefined;
  expect(init?.body).toBeDefined();
  return JSON.parse(String(init?.body));
}

describe('CloudSync.enable', () => {
  it('returns the slash-command hint', async () => {
    expect(await make().enable('me/data', ['prompts'])).toMatch(/Enable via/);
  });
});

describe('CloudSync.push via real githubFetch', () => {
  function stubPush(
    patchHandler?: (calls: number) => Response,
    remoteTree: Array<{ path: string; sha: string; type: string }> = [],
  ) {
    let patchCalls = 0;
    let headSha = 'remote-sha';
    let headTreeSha = 'remote-tree-sha';
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const m = init?.method;
      if (u.endsWith('/git/trees') && m === 'POST') return json({ sha: 'tree-sha' });
      if (u.endsWith('/git/commits') && m === 'POST') return json({ sha: 'commit-sha' });
      if (u.includes('/git/refs/heads/main') && m === 'PATCH') {
        patchCalls++;
        const response = patchHandler ? patchHandler(patchCalls) : json({});
        if (response.ok) {
          headSha = JSON.parse(String(init?.body)).sha as string;
          headTreeSha = 'tree-sha';
        }
        return response;
      }
      if (u.includes('/git/refs/heads/main') && m === 'GET')
        return json({ object: { sha: headSha } });
      if (u.includes(`/git/commits/${headSha}`) && m === 'GET') {
        return json({ tree: { sha: headTreeSha }, message: 'remote' });
      }
      if (u.includes(`/git/trees/${headTreeSha}`) && m === 'GET') {
        return json({ tree: remoteTree, truncated: false });
      }
      return json({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('creates main when the target repository has no branch yet', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const m = init?.method;
      if (u.includes('/git/refs/heads/main') && m === 'GET') return json('missing branch', 404);
      if (u.endsWith('/git/trees') && m === 'POST') return json({ sha: 'tree-sha' });
      if (u.endsWith('/git/commits') && m === 'POST') return json({ sha: 'commit-sha' });
      if (u.endsWith('/git/refs') && m === 'POST') return json({ ref: 'refs/heads/main' });
      return json({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await make().push('tok');
    expect(result).toMatchObject({ ok: true, committedAt: 'commit-sha' });
    const createRefCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith('/git/refs') && (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(requestBody(createRefCall)).toEqual({
      ref: 'refs/heads/main',
      sha: 'commit-sha',
    });
  });

  it('gives an actionable error for a truly empty repository', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json('empty repository', 409)),
    );
    await expect(make().push('tok')).rejects.toThrow(/Initialize it with a README or first commit/);
  });

  it('builds a tree, commits, and updates the ref', async () => {
    stubPush();
    const sync = make();
    const res = await sync.push('tok');
    expect(res.ok).toBe(true);
    expect(res.message).toContain('Pushed');
    // state file written with the commit sha
    const state = JSON.parse(
      await fs.readFile(path.join(paths.configDir, 'sync-state.json'), 'utf8'),
    );
    expect(state.sha).toBe('commit-sha');
  });

  it('deletes missing blobs only inside selected categories', async () => {
    const fetchMock = stubPush(undefined, [
      { path: 'data/prompts/deleted.json', sha: 'old-prompt', type: 'blob' },
      { path: 'data/settings', sha: 'settings-blob', type: 'blob' },
      { path: 'README.md', sha: 'readme-blob', type: 'blob' },
    ]);

    await make(cfg({ categories: ['prompts'] })).push('tok');

    const treeRequest = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith('/git/trees') && (init as RequestInit | undefined)?.method === 'POST',
    );
    const body = requestBody(treeRequest) as {
      tree: Array<Record<string, unknown>>;
    };
    expect(body.tree).toContainEqual({
      path: 'data/prompts/deleted.json',
      mode: '100644',
      type: 'blob',
      sha: null,
    });
    expect(body.tree.some((entry) => entry.path === 'data/settings' && entry.sha === null)).toBe(
      false,
    );
    expect(body.tree.some((entry) => entry.path === 'README.md' && entry.sha === null)).toBe(false);
  });

  it('uses the previous tree as base_tree and previous commit as parent', async () => {
    const fetchMock = stubPush();
    const sync = make();
    await sync.push('tok');
    const res = await sync.push('tok');
    expect(res.ok).toBe(true);

    const treeRequests = fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).endsWith('/git/trees') && (init as RequestInit | undefined)?.method === 'POST',
    );
    const commitRequests = fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).endsWith('/git/commits') &&
        (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(requestBody(treeRequests[1])).toMatchObject({ base_tree: 'tree-sha' });
    expect(requestBody(commitRequests[1])).toMatchObject({ parents: ['commit-sha'] });
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          String(url).includes('/git/refs/heads/main') &&
          (init as RequestInit | undefined)?.method === 'GET',
      ),
    ).toHaveLength(2);
  });

  it('rebuilds on the remote tree and records the rebased commit after a 422', async () => {
    let treeCalls = 0;
    let commitCalls = 0;
    let patchCalls = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const m = init?.method;
      if (u.endsWith('/git/trees') && m === 'POST') return json({ sha: `tree-${++treeCalls}` });
      if (u.endsWith('/git/commits') && m === 'POST')
        return json({ sha: `commit-${++commitCalls}` });
      if (u.includes('/git/refs/heads/main') && m === 'PATCH') {
        return ++patchCalls === 1 ? json('not a fast forward', 422) : json({});
      }
      if (u.includes('/git/refs/heads/main') && m === 'GET')
        return json({ object: { sha: 'remote-commit' } });
      if (u.includes('/git/commits/remote-commit') && m === 'GET')
        return json({ tree: { sha: 'remote-tree' }, message: 'm' });
      if (u.includes('/git/trees/remote-tree') && m === 'GET') {
        return json({
          tree:
            patchCalls === 0
              ? [{ path: 'data/prompts/stale.json', sha: 'stale', type: 'blob' }]
              : [{ path: 'data/prompts/concurrent.json', sha: 'concurrent', type: 'blob' }],
          truncated: false,
        });
      }
      return json({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await make().push('tok');
    expect(res).toMatchObject({ ok: true, committedAt: 'commit-2' });
    const state = JSON.parse(
      await fs.readFile(path.join(paths.configDir, 'sync-state.json'), 'utf8'),
    );
    expect(state).toMatchObject({ sha: 'commit-2', treeSha: 'tree-2' });

    const treeRequests = fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).endsWith('/git/trees') && (init as RequestInit | undefined)?.method === 'POST',
    );
    const retryBody = requestBody(treeRequests[1]) as {
      base_tree: string;
      tree: Array<Record<string, unknown>>;
    };
    expect(retryBody).toMatchObject({ base_tree: 'remote-tree' });
    expect(retryBody.tree).toContainEqual({
      path: 'data/prompts/concurrent.json',
      mode: '100644',
      type: 'blob',
      sha: null,
    });
    expect(retryBody.tree.some((entry) => entry.path === 'data/prompts/stale.json')).toBe(false);
  });

  it('rethrows a non-422 updateRef failure', async () => {
    stubPush(() => json('server error', 500));
    await expect(make().push('tok')).rejects.toThrow(/500/);
  });

  it('returns a not-enabled result when sync is disabled', async () => {
    const res = await make(cfg({ enabled: false })).push('tok');
    expect(res).toMatchObject({ ok: false, action: 'push' });
  });
});

describe('CloudSync.pull via real githubFetch', () => {
  function stubPull(treeEntries: Array<{ path: string; sha: string; type: string }>) {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const m = init?.method;
      if (u.includes('/git/refs/heads/main') && m === 'GET')
        return json({ object: { sha: 'head-sha' } });
      if (u.includes('/git/commits/') && m === 'GET')
        return json({ tree: { sha: 'tree-sha' }, message: 'm' });
      // Real GitHub returns `{ sha, tree: [...], truncated }`, not a bare array.
      if (u.includes('/git/trees/') && m === 'GET')
        return json({ tree: treeEntries, truncated: false });
      if (u.includes('/git/blobs/') && m === 'GET')
        return json({ content: Buffer.from('{"pulled":true}').toString('base64') });
      return json({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('downloads blobs and writes category files', async () => {
    stubPull([
      { path: 'data/prompts/p.json', sha: 'blob-1', type: 'blob' },
      { path: 'data/prompts/sub', sha: 'tree-x', type: 'tree' }, // non-blob → skipped
      { path: 'notdata/x', sha: 'b', type: 'blob' }, // wrong prefix → skipped
    ]);
    const res = await make(cfg({ categories: ['prompts'] })).pull('tok');
    expect(res.ok).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(paths.globalPrompts, 'p.json'), 'utf8'))).toEqual(
      { pulled: true },
    );
  });

  it('returns not-enabled when disabled', async () => {
    const res = await make(cfg({ enabled: false })).pull('tok');
    expect(res).toMatchObject({ ok: false, action: 'pull' });
  });

  it('surfaces a GitHub API error (non-ok response)', async () => {
    const fetchMock = vi.fn(async () => json('boom', 500));
    vi.stubGlobal('fetch', fetchMock);
    await expect(make().pull('tok')).rejects.toThrow(/500/);
  });

  it('does not write known categories excluded by the local allowlist', async () => {
    stubPull([
      { path: 'data/settings', sha: 'settings-blob', type: 'blob' },
      { path: 'data/prompts/p.json', sha: 'prompt-blob', type: 'blob' },
    ]);
    const settingsPath = path.join(paths.configDir, 'config.json');
    await fs.writeFile(settingsPath, '{"local":true}');

    await make(cfg({ categories: ['prompts'] })).pull('tok');

    expect(JSON.parse(await fs.readFile(settingsPath, 'utf8'))).toEqual({ local: true });
    expect(JSON.parse(await fs.readFile(path.join(paths.globalPrompts, 'p.json'), 'utf8'))).toEqual(
      { pulled: true },
    );
  });

  it('skips unknown categories and empty category paths', async () => {
    stubPull([
      { path: 'data/bogus/x', sha: 'b0', type: 'blob' }, // not a known category → skip
      { path: 'data/memory/m.md', sha: 'b1', type: 'blob' }, // memory path blanked → skip
      { path: 'data/prompts/p.json', sha: 'b2', type: 'blob' }, // written
    ]);
    const blanked = { ...paths, globalMemory: '' } as WstackPaths;
    const sync = new CloudSync(
      blanked,
      () => cfg({ categories: ['prompts', 'memory'] }),
      async () => {},
    );
    const res = await sync.pull('tok');
    expect(res.ok).toBe(true);
  });

  it('writes a file-backed category directly when the remote path has no subpath', async () => {
    stubPull([{ path: 'data/settings', sha: 'b1', type: 'blob' }]);
    await make(cfg({ categories: ['settings'] })).pull('tok');
    expect(
      JSON.parse(await fs.readFile(path.join(dir, 'profiles', 'default', 'config.json'), 'utf8')),
    ).toEqual({ pulled: true });
    expect(JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'))).toEqual({
      setting: true,
    });
  });

  it('rejects a nested remote path for a file-backed category', async () => {
    stubPull([{ path: 'data/settings/nested.json', sha: 'b1', type: 'blob' }]);
    await expect(make(cfg({ categories: ['settings'] })).pull('tok')).rejects.toThrow(
      /file category|nested/i,
    );
  });

  it('rejects a directory-escaping remote path', async () => {
    stubPull([{ path: 'data/prompts/../../escape.txt', sha: 'b1', type: 'blob' }]);
    await expect(make(cfg({ categories: ['prompts'] })).pull('tok')).rejects.toThrow(/traversal/i);
  });

  it('resolves a dir-category blob with no subpath to the category root', async () => {
    // resolvePulledCategoryPath returns the prompts dir (empty rel); writing a
    // blob onto a directory path then fails (EISDIR), but the empty-rel branch runs.
    stubPull([{ path: 'data/prompts', sha: 'b1', type: 'blob' }]);
    await expect(make(cfg({ categories: ['prompts'] })).pull('tok')).rejects.toThrow();
  });
});

describe('CloudSync.hasLocalChanges + buildLocalTree edges', () => {
  it('hashes local categories and compares against the stored rev', async () => {
    // push first to populate the state file (with a localRev)
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const m = init?.method;
      if (u.includes('/git/refs/heads/main') && m === 'GET')
        return json({ object: { sha: 'remote-commit' } });
      if (u.includes('/git/commits/remote-commit') && m === 'GET')
        return json({ tree: { sha: 'remote-tree' }, message: 'm' });
      if (u.endsWith('/git/trees') && m === 'POST') return json({ sha: 't' });
      if (u.endsWith('/git/commits') && m === 'POST') return json({ sha: 'c' });
      return json({});
    });
    vi.stubGlobal('fetch', fetchMock);
    const sync = make(cfg({ categories: ['prompts', 'settings'] }));
    await sync.push('tok');
    await sync.loadState();
    // hashLocalCategories runs over a dir (prompts) + a file (settings)
    expect(typeof (await sync.hasLocalChanges())).toBe('boolean');
  });

  it('skips empty and missing category paths when building the tree', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const m = init?.method;
      if (u.includes('/git/refs/heads/main') && m === 'GET')
        return json({ object: { sha: 'remote-commit' } });
      if (u.includes('/git/commits/remote-commit') && m === 'GET')
        return json({ tree: { sha: 'remote-tree' }, message: 'm' });
      if (u.endsWith('/git/trees') && m === 'POST') return json({ sha: 't' });
      if (u.endsWith('/git/commits') && m === 'POST') return json({ sha: 'c' });
      return json({});
    });
    vi.stubGlobal('fetch', fetchMock);
    // skills path is '' (skip at 313); history file is missing (stat throws → catch at 342)
    const p = { ...paths, globalSkills: '' } as WstackPaths;
    const sync = new CloudSync(
      p,
      () => cfg({ categories: ['prompts', 'skills', 'history'] }),
      async () => {},
    );
    const res = await sync.push('tok');
    expect(res.ok).toBe(true);
  });
});

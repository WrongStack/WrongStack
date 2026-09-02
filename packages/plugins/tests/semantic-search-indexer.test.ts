import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
}));

const { readdir, readFile, stat } = await import('node:fs/promises');
const { semanticIndexerCoverage, readConfig } = await import(
  '../src/semantic-search-indexer/index.js'
);
const plugin = (await import('../src/semantic-search-indexer/index.js')).default;

interface MockApi {
  tools: { register: ReturnType<typeof vi.fn> };
  registerHook: ReturnType<typeof vi.fn>;
  config: { extensions: Record<string, unknown> };
  log: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  metrics: {
    counter: ReturnType<typeof vi.fn>;
  };
}

interface TreeEntry {
  type: 'dir';
  entries?: string[];
}

interface FileEntry {
  type: 'file';
  content: string;
  size?: number;
}

type Tree = Record<string, TreeEntry | FileEntry>;

function makeApi(overrides: { extensions?: Record<string, unknown> } = {}): MockApi {
  return {
    tools: { register: vi.fn() },
    registerHook: vi.fn(() => vi.fn()),
    config: { extensions: overrides.extensions ?? {} },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn() },
  };
}

function getTool(api: MockApi, name: string): (input: unknown) => Promise<unknown> {
  const call = api.tools.register.mock.calls.find((c) => (c[0] as { name: string }).name === name);
  if (!call) throw new Error(`tool ${name} not registered`);
  return (call[0] as { execute: (input: unknown) => Promise<unknown> }).execute;
}

function createDirent(name: string, kind: 'dir' | 'file') {
  return {
    name,
    isDirectory: () => kind === 'dir',
    isFile: () => kind === 'file',
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

function mockTree(tree: Tree) {
  vi.mocked(readdir).mockImplementation(async (path) => {
    const entry = tree[path as string];
    if (entry?.type !== 'dir') {
      const err = new Error(`ENOTDIR ${path}`) as Error & { code: string };
      err.code = 'ENOTDIR';
      throw err;
    }
    const names = entry.entries ?? [];
    return names.map((name) => {
      const childPath = `${path}/${name}`;
      const child = tree[childPath];
      const kind = child?.type === 'dir' ? 'dir' : 'file';
      return createDirent(name, kind);
    }) as never;
  });

  vi.mocked(stat).mockImplementation(async (path) => {
    const entry = tree[path as string];
    if (!entry) {
      const err = new Error(`ENOENT ${path}`) as Error & { code: string };
      err.code = 'ENOENT';
      throw err;
    }
    const size = entry.type === 'file' ? (entry.size ?? entry.content.length) : 0;
    return {
      isFile: () => entry.type === 'file',
      isDirectory: () => entry.type === 'dir',
      size,
    } as never;
  });

  vi.mocked(readFile).mockImplementation(async (path) => {
    const entry = tree[path as string];
    if (entry?.type !== 'file') {
      const err = new Error(`EISDIR ${path}`) as Error & { code: string };
      err.code = 'EISDIR';
      throw err;
    }
    return entry.content;
  });
}

describe('semantic-search-indexer plugin', () => {
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/project');
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const api = makeApi();
    await plugin.teardown?.(api as never);
    cwdSpy.mockRestore();
  });

  it('registers semantic_search and semantic_index_status tools', () => {
    const api = makeApi();
    plugin.setup(api as never);
    const names = api.tools.register.mock.calls.map((c) => (c[0] as { name: string }).name);
    expect(names).toContain('semantic_search');
    expect(names).toContain('semantic_index_status');
    expect(api.tools.register).toHaveBeenCalledTimes(2);
  });

  it('prunes deleted files from the index without a rebuild', async () => {
    const tree: Tree = {
      '/project': { type: 'dir', entries: ['src'] },
      '/project/src': { type: 'dir', entries: ['auth.ts', 'utils.ts'] },
      '/project/src/auth.ts': { type: 'file', content: 'const auth = true;\n' },
      '/project/src/utils.ts': { type: 'file', content: 'const auth = false;\n' },
    };
    mockTree(tree);

    const api = makeApi();
    plugin.setup(api as never);
    const search = getTool(api, 'semantic_search');
    const before = (await search({ query: 'auth' })) as { totalResults: number };
    expect(before.totalResults).toBe(2);

    // The file is deleted on disk: the tree entry disappears, so the stat
    // mock now rejects for it (ENOENT) — exactly like a real delete.
    delete (tree as Record<string, unknown>)['/project/src/auth.ts'];

    const removed = await semanticIndexerCoverage.pruneDeletedFiles(
      '/project',
      readConfig(undefined),
      { force: true },
    );
    expect(removed).toBe(1);

    const after = (await search({ query: 'auth' })) as {
      totalResults: number;
      results: Array<{ path: string }>;
    };
    expect(after.totalResults).toBe(1);
    expect(after.results[0]?.path).toBe('src/utils.ts');
  });

  it('registers a PostToolUse prune hook for deletion-capable tools', async () => {
    mockTree({
      '/project': { type: 'dir', entries: ['src'] },
      '/project/src': { type: 'dir', entries: ['auth.ts'] },
      '/project/src/auth.ts': { type: 'file', content: 'const auth = true;\n' },
    });

    const api = makeApi();
    plugin.setup(api as never);
    // Write-invalidation hook + deletion-prune hook.
    expect(api.registerHook).toHaveBeenCalledTimes(2);
    const deleteCall = api.registerHook.mock.calls.find((c) => String(c[1]).includes('bash'));
    expect(deleteCall).toBeDefined();
    expect(deleteCall?.[0]).toBe('PostToolUse');
    // Firing the hook (fire-and-forget prune) must not throw with no index loaded.
    const deleteHook = deleteCall?.[2] as (() => void) | undefined;
    expect(() => deleteHook?.()).not.toThrow();
  });

  it('returns ranked results with matched lines for a basic query', async () => {
    mockTree({
      '/project': { type: 'dir', entries: ['src'] },
      '/project/src': { type: 'dir', entries: ['auth.ts', 'utils.ts'] },
      '/project/src/auth.ts': {
        type: 'file',
        content: 'export function login() {}\nconst auth = true;\n',
      },
      '/project/src/utils.ts': { type: 'file', content: 'export function helper() {}\n' },
    });

    const api = makeApi();
    plugin.setup(api as never);
    const search = getTool(api, 'semantic_search');
    const result = (await search({ query: 'auth' })) as {
      ok: boolean;
      totalResults: number;
      results: Array<{
        path: string;
        score: number;
        matchedLines: Array<{ lineNumber: number; text: string }>;
      }>;
    };

    expect(result.ok).toBe(true);
    expect(result.totalResults).toBe(1);
    expect(result.results[0]?.path).toBe('src/auth.ts');
    expect(result.results[0]?.score).toBeGreaterThan(0);
    expect(result.results[0]?.matchedLines).toEqual([
      { lineNumber: 2, text: 'const auth = true;' },
    ]);
  });

  it('ranks files by term frequency', async () => {
    mockTree({
      '/project': { type: 'dir', entries: ['src'] },
      '/project/src': { type: 'dir', entries: ['helpers.ts', 'utils.ts'] },
      '/project/src/helpers.ts': {
        type: 'file',
        content: 'function helper() {}\nfunction helper() {}\n',
      },
      '/project/src/utils.ts': { type: 'file', content: 'function helper() {}\n' },
    });

    const api = makeApi();
    plugin.setup(api as never);
    const search = getTool(api, 'semantic_search');
    const result = (await search({ query: 'helper', limit: 1 })) as {
      ok: boolean;
      results: Array<{ path: string; score: number }>;
    };

    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.path).toBe('src/helpers.ts');
    expect(result.results[0]?.score).toBe(2);
  });

  it('returns bounded top results ordered by score then path', async () => {
    mockTree({
      '/project': { type: 'dir', entries: ['src'] },
      '/project/src': { type: 'dir', entries: ['z.ts', 'b.ts', 'c.ts', 'a.ts'] },
      '/project/src/z.ts': { type: 'file', content: 'function helper() {}\n' },
      '/project/src/b.ts': {
        type: 'file',
        content: 'function helper() {}\nfunction helper() {}\n',
      },
      '/project/src/c.ts': { type: 'file', content: 'function helper() {}\n' },
      '/project/src/a.ts': {
        type: 'file',
        content: 'function helper() {}\nfunction helper() {}\n',
      },
    });

    const api = makeApi();
    plugin.setup(api as never);
    const search = getTool(api, 'semantic_search');
    const result = (await search({ query: 'helper', limit: 2 })) as {
      ok: boolean;
      results: Array<{ path: string; score: number }>;
    };

    expect(result.ok).toBe(true);
    expect(result.results).toEqual([
      expect.objectContaining({ path: 'src/a.ts', score: 2 }),
      expect.objectContaining({ path: 'src/b.ts', score: 2 }),
    ]);
  });

  it('respects the path input and excludes configured patterns', async () => {
    mockTree({
      '/project': { type: 'dir', entries: ['src', 'dist'] },
      '/project/src': { type: 'dir', entries: ['auth.ts'] },
      '/project/src/auth.ts': { type: 'file', content: 'const auth = true;\n' },
      '/project/dist': { type: 'dir', entries: ['auth.js'] },
      '/project/dist/auth.js': { type: 'file', content: 'const auth = true;\n' },
    });

    const api = makeApi();
    plugin.setup(api as never);
    const search = getTool(api, 'semantic_search');
    const result = (await search({ query: 'auth', path: 'src' })) as {
      ok: boolean;
      results: Array<{ path: string }>;
    };

    expect(result.ok).toBe(true);
    expect(result.results.map((r) => r.path)).toEqual(['src/auth.ts']);
  });

  it('semantic_index_status reports index counters', async () => {
    mockTree({
      '/project': { type: 'dir', entries: ['src'] },
      '/project/src': { type: 'dir', entries: ['auth.ts'] },
      '/project/src/auth.ts': { type: 'file', content: 'const auth = true;\n' },
    });

    const api = makeApi();
    plugin.setup(api as never);
    const search = getTool(api, 'semantic_search');
    const status = getTool(api, 'semantic_index_status');

    await search({ query: 'auth' });
    const result = (await status({})) as {
      ok: boolean;
      fileCount: number;
      termCount: number;
      counters: { queries: number; reindexes: number };
    };

    expect(result.ok).toBe(true);
    expect(result.fileCount).toBe(1);
    expect(result.termCount).toBeGreaterThan(0);
    expect(result.counters.queries).toBe(1);
    expect(result.counters.reindexes).toBe(1);
  });

  it('returns an error when disabled', async () => {
    const api = makeApi({ extensions: { 'semantic-search-indexer': { enabled: false } } });
    plugin.setup(api as never);
    const search = getTool(api, 'semantic_search');
    const result = (await search({ query: 'auth' })) as { ok: boolean; error: string };

    expect(result.ok).toBe(false);
    expect(result.error).toContain('disabled');
  });

  it('returns an error for paths outside the project', async () => {
    const api = makeApi();
    plugin.setup(api as never);
    const search = getTool(api, 'semantic_search');
    const result = (await search({ query: 'auth', path: '/etc' })) as {
      ok: boolean;
      error: string;
    };

    expect(result.ok).toBe(false);
    expect(result.error).toContain('outside project root');
  });

  it('teardown zeros state and logs', async () => {
    const api = makeApi();
    plugin.setup(api as never);
    await plugin.teardown?.(api as never);
    const health = (await plugin.health!()) as unknown as { counters: Record<string, number> };

    expect(health.counters['fileCount']).toBe(0);
    expect(health.counters['termCount']).toBe(0);
    expect(api.log.info).toHaveBeenCalledWith(
      'semantic-search-indexer: teardown complete',
      expect.any(Object),
    );
  });

  it('declares query/path aliases in the tool schema for schema-validating hosts', () => {
    const api = makeApi();
    plugin.setup(api as never);
    const reg = api.tools.register.mock.calls.find(
      (c) => (c[0] as { name: string }).name === 'semantic_search',
    );
    expect(reg).toBeDefined();
    const schema = (
      reg![0] as {
        inputSchema: {
          properties: Record<string, unknown>;
          anyOf: Array<Record<string, string[]>>;
        };
      }
    ).inputSchema;

    for (const alias of ['q', 'text', 'keyword', 'keywords', 'search']) {
      expect(schema.properties[alias]).toBeDefined();
    }
    for (const alias of ['directory', 'dir', 'SearchDirectory', 'SearchPath']) {
      expect(schema.properties[alias]).toBeDefined();
    }
    const requiredAlternatives = schema.anyOf.map((entry) => entry.required?.[0]);
    for (const q of ['query', 'q', 'text', 'keyword', 'keywords', 'search']) {
      expect(requiredAlternatives).toContain(q);
    }
  });

  it('does not serve a stale in-flight build after an invalidation lands mid-build', async () => {
    // Tree v1: only alpha. The first build starts and hangs at readdir.
    mockTree({
      '/project': { type: 'dir', entries: ['src'] },
      '/project/src': { type: 'dir', entries: ['a.ts'] },
      '/project/src/a.ts': { type: 'file', content: 'const alpha = true;\n' },
    });

    // makeApi has no registerHook — add a capturing one so the invalidation
    // hook can be fired mid-build.
    const invalidations: Array<{ matcher: unknown; hook: () => void }> = [];
    const api = makeApi();
    (api as unknown as { registerHook: (...args: unknown[]) => () => void }).registerHook = (
      ...args: unknown[]
    ) => {
      invalidations.push({ matcher: args[1], hook: args[2] as () => void });
      return () => {};
    };
    plugin.setup(api as never);
    const search = getTool(api, 'semantic_search');

    // Deferred readdir: the first build blocks mid-walk with buildPromise set.
    let releaseRead: (() => void) | undefined;
    vi.mocked(readdir).mockImplementationOnce(
      () =>
        new Promise((resolveReaddir) => {
          releaseRead = () => resolveReaddir([] as never);
        }) as never,
    );

    const staleQuery = search({ query: 'alpha', path: 'src' });
    await new Promise((r) => setTimeout(r, 0));
    expect(releaseRead).toBeDefined();

    // A write lands mid-build: the hook invalidates (generation bump).
    // Select the WRITE hook by matcher: the deletion-prune hook registered
    // after it does not bump the generation.
    const writeHook = invalidations.find((entry) => String(entry.matcher).includes('write'));
    writeHook?.hook();

    // Swap to the post-write tree and let the blocked (stale) build finish.
    mockTree({
      '/project': { type: 'dir', entries: ['src'] },
      '/project/src': { type: 'dir', entries: ['b.ts'] },
      '/project/src/b.ts': { type: 'file', content: 'const bravo = true;\n' },
    });
    releaseRead?.();

    // The stale build completes with an EMPTY index and cachedPath === 'src'.
    // Without the generation guard, ensureIndex would short-circuit on it and
    // the query for the NEW token would return zero results.
    await staleQuery;
    const result = (await search({ query: 'bravo', path: 'src' })) as {
      ok: boolean;
      totalResults: number;
    };

    expect(result.ok).toBe(true);
    expect(result.totalResults).toBe(1);
  });

  it('rebuilds after an idle invalidation with no build in flight', async () => {
    // Regression (chimera HIGH): the invalidation hook used to bump the
    // generation while the fast path checked only index+cachedPath — an edit
    // landing between builds was never examined and the stale index was
    // served indefinitely.
    mockTree({
      '/project': { type: 'dir', entries: ['src'] },
      '/project/src': { type: 'dir', entries: ['a.ts'] },
      '/project/src/a.ts': { type: 'file', content: 'const alpha = true;\n' },
    });

    const invalidations: Array<{ matcher: unknown; hook: () => void }> = [];
    const api = makeApi();
    (api as unknown as { registerHook: (...args: unknown[]) => () => void }).registerHook = (
      ...args: unknown[]
    ) => {
      invalidations.push({ matcher: args[1], hook: args[2] as () => void });
      return () => {};
    };
    plugin.setup(api as never);
    const search = getTool(api, 'semantic_search');

    // First search builds and publishes the index (no pending invalidation).
    const first = (await search({ query: 'alpha', path: 'src' })) as { ok: boolean };
    expect(first.ok).toBe(true);

    // An edit lands with NO build in flight — generation bumps only.
    // Select the WRITE hook by matcher: the deletion-prune hook registered
    // after it does not bump the generation.
    const writeHook = invalidations.find((entry) => String(entry.matcher).includes('write'));
    writeHook?.hook();

    // The post-edit content must be indexed, not the stale pre-edit index.
    mockTree({
      '/project': { type: 'dir', entries: ['src'] },
      '/project/src': { type: 'dir', entries: ['b.ts'] },
      '/project/src/b.ts': { type: 'file', content: 'const bravo = true;\n' },
    });
    const result = (await search({ query: 'bravo', path: 'src' })) as {
      ok: boolean;
      totalResults: number;
    };

    expect(result.ok).toBe(true);
    expect(result.totalResults).toBe(1);
  });
});

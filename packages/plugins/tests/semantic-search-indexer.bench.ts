import { bench, describe, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
}));

const { readdir, readFile, stat } = await import('node:fs/promises');
const plugin = (await import('../src/semantic-search-indexer')).default;

interface MockApi {
  tools: { register: ReturnType<typeof vi.fn> };
  config: { extensions: Record<string, unknown> };
  log: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  metrics: { counter: ReturnType<typeof vi.fn> };
}

interface TreeEntry {
  type: 'dir';
  entries: string[];
}

interface FileEntry {
  type: 'file';
  content: string;
  size: number;
}

type Tree = Record<string, TreeEntry | FileEntry>;

function makeApi(maxFiles: number): MockApi {
  return {
    tools: { register: vi.fn() },
    config: {
      extensions: {
        'semantic-search-indexer': {
          includeExtensions: ['.ts'],
          excludePatterns: ['node_modules', '\\.git', '\\.wrongstack', 'dist'],
          maxFileBytes: 1_000_000,
          maxFiles,
        },
      },
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn() },
  };
}

function getSearchTool(api: MockApi): (input: unknown) => Promise<unknown> {
  const call = api.tools.register.mock.calls.find(
    (c) => (c[0] as { name: string }).name === 'semantic_search',
  );
  if (!call) throw new Error('semantic_search tool not registered');
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

function makeSyntheticTree(fileCount: number): Tree {
  const tree: Tree = {
    '/project': { type: 'dir', entries: ['src'] },
    '/project/src': { type: 'dir', entries: [] },
  };
  const src = tree['/project/src'] as TreeEntry;
  for (let i = 0; i < fileCount; i += 1) {
    const name = `file-${i}.ts`;
    src.entries.push(name);
    const content = [
      `export function helper${i}() {`,
      `  const authToken${i} = 'token-${i}';`,
      `  return authToken${i};`,
      '}',
      '',
    ].join('\n');
    tree[`/project/src/${name}`] = { type: 'file', content, size: content.length };
  }
  return tree;
}

function mockTree(tree: Tree): void {
  vi.mocked(readdir).mockImplementation(async (path) => {
    const entry = tree[path as string];
    if (entry?.type !== 'dir') {
      const err = new Error(`ENOTDIR ${path}`) as Error & { code: string };
      err.code = 'ENOTDIR';
      throw err;
    }
    return entry.entries.map((name) => {
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
    return {
      isFile: () => entry.type === 'file',
      isDirectory: () => entry.type === 'dir',
      size: entry.type === 'file' ? entry.size : 0,
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

async function buildIndexViaSearch(fileCount: number): Promise<void> {
  vi.clearAllMocks();
  vi.spyOn(process, 'cwd').mockReturnValue('/project');
  mockTree(makeSyntheticTree(fileCount));
  const api = makeApi(fileCount + 10);
  plugin.setup(api as never);
  const search = getSearchTool(api);
  await search({ query: 'authToken', path: '.' });
  await plugin.teardown?.(api as never);
  vi.mocked(process.cwd).mockRestore();
}

// ── semantic-search-indexer async build throughput ─────────────────────────
//
// Locks in the async/batched fs.promises build path. Before the refactor, the
// indexer used sync readdir/stat/readFile recursively, so a large initial query
// could block the event loop until the full tree was scanned and tokenized.
// These synthetic trees exercise the full build path without touching disk.

describe('semantic-search-indexer — async batched index build', () => {
  bench('1k synthetic .ts files', async () => {
    await buildIndexViaSearch(1_000);
  });

  bench('5k synthetic .ts files', async () => {
    await buildIndexViaSearch(5_000);
  });
});

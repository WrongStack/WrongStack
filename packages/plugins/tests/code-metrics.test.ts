import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Virtual filesystem mock
// ---------------------------------------------------------------------------

type FsEntry = { type: 'file'; content: string } | { type: 'dir' };

let mockFs: Record<string, FsEntry> = {};

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

function mockReaddirSync(p: string, options?: { withFileTypes?: boolean }) {
  const dir = normalizePath(p).replace(/\/$/, '') || '/';
  const entries: { name: string; isDirectory: () => boolean; isFile: () => boolean }[] = [];
  for (const [path, entry] of Object.entries(mockFs)) {
    const normalized = normalizePath(path).replace(/\/$/, '') || '/';
    const parent = normalized.includes('/')
      ? normalized.slice(0, normalized.lastIndexOf('/')) || '/'
      : '/';
    if (parent === dir) {
      const name = normalized.split('/').pop()!;
      entries.push({
        name,
        isDirectory: () => entry.type === 'dir',
        isFile: () => entry.type === 'file',
      });
    }
  }
  if (options?.withFileTypes) return entries;
  return entries.map((e) => e.name);
}

function mockReadFileSync(p: string, encoding?: string) {
  const normalized = normalizePath(p);
  const entry = mockFs[normalized];
  if (entry?.type !== 'file') {
    const err = new Error(`ENOENT: ${normalized}`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  }
  if (encoding === 'utf-8' || encoding === 'utf8') return entry.content;
  return Buffer.from(entry.content);
}

function mockExistsSync(p: string) {
  return normalizePath(p) in mockFs;
}

function mockStatSync(p: string) {
  const normalized = normalizePath(p);
  const entry = mockFs[normalized];
  if (!entry) {
    const err = new Error(`ENOENT: ${normalized}`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  }
  return {
    isDirectory: () => entry.type === 'dir',
    isFile: () => entry.type === 'file',
  };
}

vi.mock('node:fs', () => ({
  existsSync: vi.fn(mockExistsSync),
  readFileSync: vi.fn(mockReadFileSync),
  readdirSync: vi.fn(mockReaddirSync),
  statSync: vi.fn(mockStatSync),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async (p: string, encoding?: string) => mockReadFileSync(p, encoding)),
  readdir: vi.fn(async (p: string, options?: { withFileTypes?: boolean }) =>
    mockReaddirSync(p, options),
  ),
  stat: vi.fn(async (p: string) => mockStatSync(p)),
}));

const plugin = (await import('../src/code-metrics')).default;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface MockApi {
  tools: { register: ReturnType<typeof vi.fn> };
  config: { extensions: Record<string, unknown> };
  log: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  metrics: { counter: ReturnType<typeof vi.fn> };
  registerHook: ReturnType<typeof vi.fn>;
}

function makeApi(overrides: { extensions?: Record<string, unknown> } = {}): MockApi {
  return {
    tools: { register: vi.fn() },
    config: {
      extensions: {
        'code-metrics': { enabled: true },
        ...(overrides.extensions ?? {}),
      },
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn() },
    registerHook: vi.fn(() => vi.fn()),
  };
}

function getTool(api: MockApi, name: string): (input: unknown) => Promise<unknown> {
  const call = api.tools.register.mock.calls.find(
    ([t]: unknown[]) => (t as { name: string }).name === name,
  );
  if (!call) throw new Error(`tool ${name} not registered`);
  return (call[0] as { execute: (input: unknown) => Promise<unknown> }).execute;
}

type HookResult = { decision?: string; reason?: string; additionalContext?: string } | undefined;

function getHook(api: MockApi): (input: unknown) => Promise<HookResult> {
  const call = api.registerHook.mock.calls[0];
  if (!call) throw new Error('hook not registered');
  return (call as unknown[])[2] as (input: unknown) => Promise<HookResult>;
}

function setFilesystem(files: Record<string, string>) {
  mockFs = { '/project': { type: 'dir' } };
  for (const [path, content] of Object.entries(files)) {
    const normalized = normalizePath(path);
    let current = '/project';
    const parts = normalized.slice('/project/'.length).split('/');
    for (let i = 0; i < parts.length - 1; i++) {
      current = `${current}/${parts[i]}`;
      if (!mockFs[current]) mockFs[current] = { type: 'dir' };
    }
    mockFs[normalized] = { type: 'file', content };
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(process, 'cwd').mockReturnValue('/project');
  mockFs = { '/project': { type: 'dir' } };
});

afterEach(async () => {
  const api = makeApi();
  await plugin.teardown?.(api as never);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('code-metrics plugin shape', () => {
  it('has name, apiVersion, setup function', () => {
    expect(plugin.name).toBe('code-metrics');
    expect(plugin.apiVersion).toBe('^0.1.10');
    expect(plugin.version).toBe('0.1.0');
    expect(typeof plugin.setup).toBe('function');
  });

  it('registers two tools and a PostToolUse hook', () => {
    const api = makeApi();
    plugin.setup(api as never);
    expect(api.tools.register).toHaveBeenCalledTimes(2);
    const names = api.tools.register.mock.calls.map(
      ([t]: unknown[]) => (t as { name: string }).name,
    );
    expect(names).toContain('measure_code_metrics');
    expect(names).toContain('metrics_status');
    const [event, matcher] = api.registerHook.mock.calls[0]!;
    expect(event).toBe('PostToolUse');
    expect(matcher).toBe('write|edit');
  });
});

describe('measure_code_metrics tool', () => {
  it('measures a single file with functions and complexity', async () => {
    setFilesystem({
      '/project/src/util.ts':
        'export function add(a: number, b: number) {\n' +
        '  if (a > 0 && b > 0) {\n' +
        '    return a + b;\n' +
        '  }\n' +
        '  return 0;\n' +
        '}\n',
    });

    const api = makeApi();
    plugin.setup(api as never);
    const measure = getTool(api, 'measure_code_metrics');
    const result = (await measure({ path: 'src/util.ts' })) as {
      ok: boolean;
      files: Array<{
        file: string;
        lines: number;
        codeLines: number;
        functionCount: number;
        complexity: number;
      }>;
    };
    expect(result.ok).toBe(true);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.file).toBe('src/util.ts');
    expect(result.files[0]!.lines).toBe(7);
    expect(result.files[0]!.codeLines).toBeGreaterThan(0);
    expect(result.files[0]!.functionCount).toBeGreaterThan(0);
    expect(result.files[0]!.complexity).toBeGreaterThan(0);
  });

  it('measures a directory and caps at maxFiles', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 5; i++) {
      files[`/project/src/f${i}.ts`] = `export const v${i} = ${i};\n`;
    }
    setFilesystem(files);

    const api = makeApi({ extensions: { 'code-metrics': { maxFiles: 2 } } });
    plugin.setup(api as never);
    const measure = getTool(api, 'measure_code_metrics');
    const result = (await measure({ path: 'src' })) as {
      ok: boolean;
      files: unknown[];
      totalFiles: number;
      capped: boolean;
    };
    expect(result.ok).toBe(true);
    expect(result.files).toHaveLength(2);
    expect(result.totalFiles).toBe(5);
    expect(result.capped).toBe(true);
  });

  it('counts blank and comment lines', async () => {
    setFilesystem({
      '/project/src/doc.ts': '// header comment\nexport const x = 1;\n\n/* block\ncomment */\n',
    });

    const api = makeApi();
    plugin.setup(api as never);
    const measure = getTool(api, 'measure_code_metrics');
    const result = (await measure({ path: 'src/doc.ts' })) as {
      ok: boolean;
      files: Array<{ lines: number; commentLines: number; blankLines: number; codeLines: number }>;
    };
    expect(result.files[0]!.commentLines).toBeGreaterThan(0);
    expect(result.files[0]!.blankLines).toBe(2);
    expect(result.files[0]!.codeLines).toBeGreaterThan(0);
    expect(result.files[0]!.lines).toBe(6);
  });

  it('rejects paths outside the project root', async () => {
    const api = makeApi();
    plugin.setup(api as never);
    const measure = getTool(api, 'measure_code_metrics');
    const outside = process.platform === 'win32' ? 'C:\\Windows\\evil.ts' : '/etc/evil.ts';
    const result = (await measure({ path: outside })) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('outside');
  });

  it('enabled:false disables the tool', async () => {
    const api = makeApi({ extensions: { 'code-metrics': { enabled: false } } });
    plugin.setup(api as never);
    const measure = getTool(api, 'measure_code_metrics');
    const result = (await measure({})) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('disabled');
  });
});

describe('metrics_status tool', () => {
  it('returns config and zero counters before use', async () => {
    const api = makeApi();
    plugin.setup(api as never);
    const status = getTool(api, 'metrics_status');
    const result = (await status({})) as {
      ok: boolean;
      enabled: boolean;
      maxFiles: number;
      counters: Record<string, number>;
    };
    expect(result.ok).toBe(true);
    expect(result.enabled).toBe(true);
    expect(result.maxFiles).toBe(50);
    expect(result.counters['measures']).toBe(0);
  });

  it('reflects measurements in counters', async () => {
    setFilesystem({
      '/project/src/a.ts': 'export const a = 1;\n',
      '/project/src/b.ts': 'export const b = 2;\n',
    });

    const api = makeApi();
    plugin.setup(api as never);
    const measure = getTool(api, 'measure_code_metrics');
    const status = getTool(api, 'metrics_status');
    await measure({ path: 'src' });
    const result = (await status({})) as { ok: boolean; counters: Record<string, number> };
    expect(result.counters['measures']).toBe(1);
    expect(result.counters['files']).toBe(2);
  });
});

describe('PostToolUse hook behavior', () => {
  it('injects a one-line metric summary after a write', async () => {
    setFilesystem({
      '/project/src/feature.ts': 'export function foo() {\n  return 1;\n}\n',
    });

    const api = makeApi();
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'write',
      toolInput: { path: 'src/feature.ts', content: 'x' },
      toolResult: { content: 'ok', isError: false },
    });
    expect(result?.additionalContext).toContain('code-metrics');
    expect(result?.additionalContext).toContain('src/feature.ts');
    expect(result?.additionalContext).toContain('function(s)');
  });

  it('stays silent when the mutating tool errored', async () => {
    setFilesystem({
      '/project/src/feature.ts': 'export const x = 1;\n',
    });

    const api = makeApi();
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'write',
      toolInput: { path: 'src/feature.ts', content: 'x' },
      toolResult: { content: 'error', isError: true },
    });
    expect(result).toBeUndefined();
  });

  it('skips non-source files', async () => {
    const api = makeApi();
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'write',
      toolInput: { path: 'README.md', content: '# hello' },
      toolResult: { content: 'ok', isError: false },
    });
    expect(result).toBeUndefined();
  });

  it('skips paths outside the project root', async () => {
    const api = makeApi();
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'write',
      toolInput: { path: '/etc/evil.ts', content: 'x' },
      toolResult: { content: 'ok', isError: false },
    });
    expect(result).toBeUndefined();
  });
});

describe('teardown + counters', () => {
  it('logs completion and zeros counters', async () => {
    const api = makeApi();
    plugin.setup(api as never);
    plugin.teardown!(api as never);
    expect(api.log.info).toHaveBeenCalledWith(
      'code-metrics: teardown complete',
      expect.any(Object),
    );
    const health = (await plugin.health!()) as { counters: Record<string, number> };
    expect(health.counters['measures']).toBe(0);
    expect(health.counters['files']).toBe(0);
  });

  it('teardown is safe before setup', () => {
    const api = makeApi();
    expect(() => plugin.teardown!(api as never)).not.toThrow();
  });
});

describe('config parsing', () => {
  it('reads custom extensions and maxFiles', async () => {
    const api = makeApi({
      extensions: { 'code-metrics': { extensions: ['.ts'], maxFiles: 10 } },
    });
    plugin.setup(api as never);
    const status = getTool(api, 'metrics_status');
    const result = (await status({})) as { extensions: string[]; maxFiles: number };
    expect(result.extensions).toEqual(['.ts']);
    expect(result.maxFiles).toBe(10);
  });

  it('falls back to defaults for invalid values', async () => {
    const api = makeApi({
      extensions: {
        'code-metrics': { maxFiles: -1, extensions: 'not-an-array' as unknown as string[] },
      },
    });
    plugin.setup(api as never);
    const status = getTool(api, 'metrics_status');
    const result = (await status({})) as { maxFiles: number; extensions: string[] };
    expect(result.maxFiles).toBe(50);
    expect(result.extensions).toEqual(['.ts', '.tsx', '.js', '.jsx']);
  });
});

describe('issue #368 complexity + classification fixtures', () => {
  it('counts a?.b ?? c as 1 (nullish only; optional chaining is not a branch)', async () => {
    setFilesystem({ '/project/src/nullish.ts': 'export const v = a?.b ?? c;\n' });
    const api = makeApi();
    plugin.setup(api as never);
    const measure = getTool(api, 'measure_code_metrics');
    const result = (await measure({ path: 'src/nullish.ts' })) as {
      files: Array<{ complexity: number }>;
    };
    expect(result.files[0]!.complexity).toBe(1);
  });

  it('counts ||= and ??= as one decision each', async () => {
    setFilesystem({ '/project/src/assign.ts': 'x ||= y;\nz ??= w;\n' });
    const api = makeApi();
    plugin.setup(api as never);
    const measure = getTool(api, 'measure_code_metrics');
    const result = (await measure({ path: 'src/assign.ts' })) as {
      files: Array<{ complexity: number }>;
    };
    expect(result.files[0]!.complexity).toBe(2);
  });

  it('counts a 5-level nested ternary as 5', async () => {
    setFilesystem({
      '/project/src/jsx.ts':
        'export const C = () => (a ? b ? c ? d ? e ? 1 : 0 : 0 : 0 : 0 : 0);\n',
    });
    const api = makeApi();
    plugin.setup(api as never);
    const measure = getTool(api, 'measure_code_metrics');
    const result = (await measure({ path: 'src/jsx.ts' })) as {
      files: Array<{ complexity: number }>;
    };
    expect(result.files[0]!.complexity).toBe(5);
  });

  it('classifies // TODO as a comment line, not code', async () => {
    setFilesystem({ '/project/src/todo.ts': '// TODO: handle error\n' });
    const api = makeApi();
    plugin.setup(api as never);
    const measure = getTool(api, 'measure_code_metrics');
    const result = (await measure({ path: 'src/todo.ts' })) as {
      files: Array<{ codeLines: number; commentLines: number }>;
    };
    expect(result.files[0]!.commentLines).toBe(1);
    expect(result.files[0]!.codeLines).toBe(0);
  });

  it('does not classify a shebang as code', async () => {
    setFilesystem({ '/project/src/cli.ts': '#! /usr/bin/env node\n' });
    const api = makeApi();
    plugin.setup(api as never);
    const measure = getTool(api, 'measure_code_metrics');
    const result = (await measure({ path: 'src/cli.ts' })) as {
      files: Array<{ codeLines: number; commentLines: number; lines: number }>;
    };
    expect(result.files[0]!.lines).toBe(2);
    expect(result.files[0]!.codeLines).toBe(0);
    expect(result.files[0]!.commentLines).toBe(0);
  });

  it('returns zeros for a 0-line file without throwing', async () => {
    setFilesystem({ '/project/src/empty.ts': '' });
    const api = makeApi();
    plugin.setup(api as never);
    const measure = getTool(api, 'measure_code_metrics');
    const result = (await measure({ path: 'src/empty.ts' })) as {
      ok: boolean;
      files: Array<{ lines: number; codeLines: number; complexity: number }>;
    };
    expect(result.ok).toBe(true);
    expect(result.files[0]).toMatchObject({ lines: 0, codeLines: 0, complexity: 0 });
  });

  it('exposes the complexity formula on metrics_status', async () => {
    const api = makeApi();
    plugin.setup(api as never);
    const status = getTool(api, 'metrics_status');
    const result = (await status({})) as { complexityFormula: string };
    expect(result.complexityFormula).toContain('optional chaining');
    expect(result.complexityFormula).toContain('??=');
  });
});

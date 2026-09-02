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

const plugin = (await import('../src/refactor-suggester')).default;

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

function makeApi(
  overrides: { extensions?: Record<string, unknown>; enabled?: boolean } = {},
): MockApi {
  return {
    tools: { register: vi.fn() },
    config: {
      extensions:
        overrides.extensions ??
        (overrides.enabled === true ? { 'refactor-suggester': { enabled: true } } : {}),
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

describe('refactor-suggester plugin shape', () => {
  it('has name, apiVersion, setup function', () => {
    expect(plugin.name).toBe('refactor-suggester');
    expect(plugin.apiVersion).toBe('^0.1.10');
    expect(plugin.version).toBe('0.1.0');
    expect(typeof plugin.setup).toBe('function');
  });

  it('registers two tools and a PostToolUse hook', () => {
    const api = makeApi({ enabled: true });
    plugin.setup(api as never);
    expect(api.tools.register).toHaveBeenCalledTimes(2);
    const names = api.tools.register.mock.calls.map(
      ([t]: unknown[]) => (t as { name: string }).name,
    );
    expect(names).toContain('suggest_refactors');
    expect(names).toContain('refactor_status');
    const [event, matcher] = api.registerHook.mock.calls[0]!;
    expect(event).toBe('PostToolUse');
    expect(matcher).toBe('write|edit');
  });
});

describe('suggest_refactors tool', () => {
  it('detects many parameters', async () => {
    setFilesystem({
      '/project/src/api.ts': 'export function save(a,b,c,d,e,f) { return 1; }\n',
    });

    const api = makeApi({ enabled: true });
    plugin.setup(api as never);
    const suggest = getTool(api, 'suggest_refactors');
    const result = (await suggest({ path: 'src/api.ts' })) as {
      ok: boolean;
      suggestions: Array<{ type: string; message: string }>;
    };
    expect(result.ok).toBe(true);
    expect(result.suggestions.some((s) => s.type === 'many-parameters')).toBe(true);
  });

  it('detects magic numbers and console.log', async () => {
    setFilesystem({
      '/project/src/app.ts': 'export function run() {\n  console.log("start");\n  return 42;\n}\n',
    });

    const api = makeApi({ enabled: true });
    plugin.setup(api as never);
    const suggest = getTool(api, 'suggest_refactors');
    const result = (await suggest({ path: 'src/app.ts' })) as {
      ok: boolean;
      suggestions: Array<{ type: string }>;
    };
    expect(result.suggestions.some((s) => s.type === 'magic-number')).toBe(true);
    expect(result.suggestions.some((s) => s.type === 'console-log')).toBe(true);
  });

  it('skips allowed numbers and array indices', async () => {
    setFilesystem({
      '/project/src/list.ts': 'export const xs = [0,1,2];\nexport const y = xs[1];\n',
    });

    const api = makeApi({ enabled: true });
    plugin.setup(api as never);
    const suggest = getTool(api, 'suggest_refactors');
    const result = (await suggest({ path: 'src/list.ts' })) as {
      ok: boolean;
      suggestions: Array<{ type: string }>;
    };
    expect(result.suggestions).not.toContainEqual(
      expect.objectContaining({ type: 'magic-number' }),
    );
  });

  it('caps suggestions at maxSuggestions', async () => {
    const content = Array.from({ length: 30 }, (_, i) => `console.log(${i + 10});`).join('\n');
    setFilesystem({ '/project/src/noisy.ts': content });

    const api = makeApi({
      extensions: { 'refactor-suggester': { enabled: true, maxSuggestions: 5 } },
    });
    plugin.setup(api as never);
    const suggest = getTool(api, 'suggest_refactors');
    const result = (await suggest({ path: 'src/noisy.ts' })) as {
      ok: boolean;
      suggestions: unknown[];
    };
    expect(result.suggestions.length).toBeLessThanOrEqual(5);
  });

  it('rejects paths outside the project root', async () => {
    const api = makeApi({ enabled: true });
    plugin.setup(api as never);
    const suggest = getTool(api, 'suggest_refactors');
    const outside = process.platform === 'win32' ? 'C:\\Windows\\evil.ts' : '/etc/evil.ts';
    const result = (await suggest({ path: outside })) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('outside');
  });

  it('enabled:false disables the tool', async () => {
    const api = makeApi({ extensions: { 'refactor-suggester': { enabled: false } } });
    plugin.setup(api as never);
    const suggest = getTool(api, 'suggest_refactors');
    const result = (await suggest({})) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('disabled');
  });
});

describe('refactor_status tool', () => {
  it('returns config and zero counters before use', async () => {
    const api = makeApi({ enabled: true });
    plugin.setup(api as never);
    const status = getTool(api, 'refactor_status');
    const result = (await status({})) as {
      ok: boolean;
      rules: Record<string, number>;
      counters: Record<string, number>;
    };
    expect(result.ok).toBe(true);
    expect(result.rules['maxParams']).toBe(5);
    expect(result.counters['scans']).toBe(0);
  });

  it('reflects suggestion count after a scan', async () => {
    setFilesystem({
      '/project/src/app.ts': 'export function run() { console.log(99); }\n',
    });

    const api = makeApi({ enabled: true });
    plugin.setup(api as never);
    const suggest = getTool(api, 'suggest_refactors');
    const status = getTool(api, 'refactor_status');
    await suggest({ path: 'src/app.ts' });
    const result = (await status({})) as { counters: Record<string, number> };
    expect(result.counters['scans']).toBe(1);
    expect(result.counters['suggestions']).toBeGreaterThan(0);
  });
});

describe('PostToolUse hook behavior', () => {
  it('injects suggestions for a changed file', async () => {
    setFilesystem({
      '/project/src/feature.ts': 'export function run() { console.log(99); }\n',
    });

    const api = makeApi({ enabled: true });
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'write',
      toolInput: { path: 'src/feature.ts', content: 'x' },
      toolResult: { content: 'ok', isError: false },
    });
    expect(result?.additionalContext).toContain('refactor-suggester');
    expect(result?.additionalContext).toContain('suggestion(s) for src/feature.ts');
    expect(result?.additionalContext).toContain('Run suggest_refactors for the full list.');
  });

  it('stays silent when there are no smells', async () => {
    setFilesystem({
      '/project/src/clean.ts': 'export const x = 1;\n',
    });

    const api = makeApi({ enabled: true });
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'edit',
      toolInput: { path: 'src/clean.ts', old_string: 'x', new_string: 'y' },
      toolResult: { content: 'ok', isError: false },
    });
    expect(result).toBeUndefined();
  });

  it('skips non-source files', async () => {
    const api = makeApi({ enabled: true });
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'write',
      toolInput: { path: 'README.md', content: '# hello' },
      toolResult: { content: 'ok', isError: false },
    });
    expect(result).toBeUndefined();
  });

  it('skips when the mutating tool errored', async () => {
    setFilesystem({
      '/project/src/smelly.ts': 'export function run() { console.log(99); }\n',
    });

    const api = makeApi({ enabled: true });
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'write',
      toolInput: { path: 'src/smelly.ts', content: 'x' },
      toolResult: { content: 'error', isError: true },
    });
    expect(result).toBeUndefined();
  });
});

describe('teardown + counters', () => {
  it('logs completion and zeros counters', async () => {
    const api = makeApi({ enabled: true });
    plugin.setup(api as never);
    plugin.teardown!(api as never);
    expect(api.log.info).toHaveBeenCalledWith(
      'refactor-suggester: teardown complete',
      expect.any(Object),
    );
    const health = (await plugin.health!()) as { counters: Record<string, number> };
    expect(health.counters['scans']).toBe(0);
    expect(health.counters['suggestions']).toBe(0);
  });

  it('teardown is safe before setup', () => {
    const api = makeApi();
    expect(() => plugin.teardown!(api as never)).not.toThrow();
  });
});

describe('config parsing', () => {
  it('reads custom rules', async () => {
    const api = makeApi({
      extensions: { 'refactor-suggester': { rules: { maxParams: 3, longFunctionLines: 20 } } },
    });
    plugin.setup(api as never);
    const status = getTool(api, 'refactor_status');
    const result = (await status({})) as { rules: Record<string, number> };
    expect(result.rules['maxParams']).toBe(3);
    expect(result.rules['longFunctionLines']).toBe(20);
  });

  it('falls back to defaults for invalid rules', async () => {
    const api = makeApi({
      extensions: { 'refactor-suggester': { rules: { maxParams: -1, maxNesting: 'x' } } },
    });
    plugin.setup(api as never);
    const status = getTool(api, 'refactor_status');
    const result = (await status({})) as { rules: Record<string, number> };
    expect(result.rules['maxParams']).toBe(5);
    expect(result.rules['maxNesting']).toBe(3);
  });
});

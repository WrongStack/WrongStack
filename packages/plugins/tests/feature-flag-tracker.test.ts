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

const plugin = (await import('../src/feature-flag-tracker')).default;

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
        'feature-flag-tracker': { enabled: true },
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

describe('feature-flag-tracker plugin shape', () => {
  it('has name, apiVersion, setup function', () => {
    expect(plugin.name).toBe('feature-flag-tracker');
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
    expect(names).toContain('scan_feature_flags');
    expect(names).toContain('feature_flag_status');
    const [event, matcher] = api.registerHook.mock.calls[0]!;
    expect(event).toBe('PostToolUse');
    expect(matcher).toBe('write|edit');
  });
});

describe('scan_feature_flags tool', () => {
  it('detects built-in feature flag patterns', async () => {
    setFilesystem({
      '/project/src/app.ts':
        'if (isFeatureEnabled("new-ui")) {\n' +
        '  const value = featureFlags.betaAccess;\n' +
        '  const flag = useFeatureFlag("dark-mode");\n' +
        '  const other = flags.showBanner;\n' +
        '}\n',
    });

    const api = makeApi();
    plugin.setup(api as never);
    const scan = getTool(api, 'scan_feature_flags');
    const result = (await scan({ path: 'src/app.ts' })) as {
      ok: boolean;
      usages: Array<{ flag: string }>;
    };
    expect(result.ok).toBe(true);
    const flags = result.usages.map((u) => u.flag);
    expect(flags).toContain('new-ui');
    expect(flags).toContain('betaAccess');
    expect(flags).toContain('dark-mode');
    expect(flags).toContain('showBanner');
  });

  it('merges custom regex patterns', async () => {
    setFilesystem({
      '/project/src/app.ts': 'const x = myCustomFlag("custom-flag");\n',
    });

    const api = makeApi({
      extensions: {
        'feature-flag-tracker': { patterns: [String.raw`myCustomFlag\(['"]([^'"]+)['"]\)`] },
      },
    });
    plugin.setup(api as never);
    const scan = getTool(api, 'scan_feature_flags');
    const result = (await scan({ path: 'src/app.ts' })) as {
      ok: boolean;
      usages: Array<{ flag: string }>;
    };
    expect(result.usages.map((u) => u.flag)).toContain('custom-flag');
  });

  it('caps findings at maxFindings', async () => {
    const content = Array.from({ length: 20 }, (_, i) => `isFeatureEnabled("flag-${i}");`).join(
      '\n',
    );
    setFilesystem({ '/project/src/flags.ts': content });

    const api = makeApi({ extensions: { 'feature-flag-tracker': { maxFindings: 3 } } });
    plugin.setup(api as never);
    const scan = getTool(api, 'scan_feature_flags');
    const result = (await scan({ path: 'src/flags.ts' })) as { ok: boolean; usages: unknown[] };
    expect(result.usages.length).toBeLessThanOrEqual(3);
  });

  it('rejects paths outside the project root', async () => {
    const api = makeApi();
    plugin.setup(api as never);
    const scan = getTool(api, 'scan_feature_flags');
    const outside = process.platform === 'win32' ? 'C:\\Windows\\evil.ts' : '/etc/evil.ts';
    const result = (await scan({ path: outside })) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('outside');
  });

  it('enabled:false disables the tool', async () => {
    const api = makeApi({ extensions: { 'feature-flag-tracker': { enabled: false } } });
    plugin.setup(api as never);
    const scan = getTool(api, 'scan_feature_flags');
    const result = (await scan({})) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('disabled');
  });
});

describe('feature_flag_status tool', () => {
  it('returns config and zero counters before use', async () => {
    const api = makeApi();
    plugin.setup(api as never);
    const status = getTool(api, 'feature_flag_status');
    const result = (await status({})) as {
      ok: boolean;
      enabled: boolean;
      maxFindings: number;
      counters: Record<string, number>;
    };
    expect(result.ok).toBe(true);
    expect(result.enabled).toBe(true);
    expect(result.maxFindings).toBe(50);
    expect(result.counters['scans']).toBe(0);
  });

  it('reflects scan count after a scan', async () => {
    setFilesystem({ '/project/src/app.ts': 'isFeatureEnabled("x");\n' });

    const api = makeApi();
    plugin.setup(api as never);
    const scan = getTool(api, 'scan_feature_flags');
    const status = getTool(api, 'feature_flag_status');
    await scan({ path: 'src' });
    const result = (await status({})) as { counters: Record<string, number> };
    expect(result.counters['scans']).toBe(1);
    expect(result.counters['flags']).toBeGreaterThan(0);
  });
});

describe('PostToolUse hook behavior', () => {
  it('notes feature flags in the changed file', async () => {
    setFilesystem({
      '/project/src/feature.ts': 'if (isFeatureEnabled("beta")) { doThing(); }\n',
    });

    const api = makeApi();
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'write',
      toolInput: { path: 'src/feature.ts', content: 'x' },
      toolResult: { content: 'ok', isError: false },
    });
    expect(result?.additionalContext).toContain('feature-flag-tracker');
    expect(result?.additionalContext).toContain('beta');
  });

  it('stays silent when no flags are present', async () => {
    setFilesystem({
      '/project/src/clean.ts': 'export const x = 1;\n',
    });

    const api = makeApi();
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

  it('skips when the mutating tool errored', async () => {
    setFilesystem({
      '/project/src/feature.ts': 'isFeatureEnabled("beta");\n',
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
});

describe('teardown + counters', () => {
  it('logs completion and zeros counters', async () => {
    const api = makeApi();
    plugin.setup(api as never);
    plugin.teardown!(api as never);
    expect(api.log.info).toHaveBeenCalledWith(
      'feature-flag-tracker: teardown complete',
      expect.any(Object),
    );
    const health = (await plugin.health!()) as { counters: Record<string, number> };
    expect(health.counters['scans']).toBe(0);
    expect(health.counters['flags']).toBe(0);
  });

  it('teardown is safe before setup', () => {
    const api = makeApi();
    expect(() => plugin.teardown!(api as never)).not.toThrow();
  });
});

describe('config parsing', () => {
  it('reads custom patterns and maxFindings', async () => {
    const api = makeApi({
      extensions: { 'feature-flag-tracker': { patterns: ['a'], maxFindings: 10 } },
    });
    plugin.setup(api as never);
    const status = getTool(api, 'feature_flag_status');
    const result = (await status({})) as { patterns: string[]; maxFindings: number };
    expect(result.patterns).toEqual(['a']);
    expect(result.maxFindings).toBe(10);
  });
});

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

const plugin = (await import('../src/interface-contract-guard')).default;

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
        'interface-contract-guard': { enabled: true },
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

describe('interface-contract-guard plugin shape', () => {
  it('has name, apiVersion, setup function', () => {
    expect(plugin.name).toBe('interface-contract-guard');
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
    expect(names).toContain('check_interface_contracts');
    expect(names).toContain('interface_contract_status');
    const [event, matcher] = api.registerHook.mock.calls[0]!;
    expect(event).toBe('PostToolUse');
    expect(matcher).toBe('write|edit');
  });
});

describe('check_interface_contracts tool', () => {
  it('reports an unimplemented interface', async () => {
    setFilesystem({
      '/project/src/types.ts': 'export interface Lonely {}\n',
      '/project/src/main.ts': 'import { Lonely } from "./types";\n',
    });

    const api = makeApi();
    plugin.setup(api as never);
    const check = getTool(api, 'check_interface_contracts');
    const result = (await check({ path: 'src' })) as {
      ok: boolean;
      findings: Array<{ interfaceName: string; message: string }>;
    };
    expect(result.ok).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.interfaceName).toBe('Lonely');
    expect(result.findings[0]!.message).toContain('no visible implementer');
  });

  it('does not report an interface with an implementer', async () => {
    setFilesystem({
      '/project/src/types.ts': 'export interface Used {}\n',
      '/project/src/main.ts': 'class Impl implements Used {}\n',
    });

    const api = makeApi();
    plugin.setup(api as never);
    const check = getTool(api, 'check_interface_contracts');
    const result = (await check({ path: 'src' })) as { ok: boolean; findings: unknown[] };
    expect(result.ok).toBe(true);
    expect(result.findings).toHaveLength(0);
  });

  it('recognizes satisfies and as as implementation signals', async () => {
    setFilesystem({
      '/project/src/a.ts': 'export interface Config {}\n',
      '/project/src/b.ts': 'const cfg = {} satisfies Config;\n',
    });

    const api = makeApi();
    plugin.setup(api as never);
    const check = getTool(api, 'check_interface_contracts');
    const result = (await check({ path: 'src' })) as { ok: boolean; findings: unknown[] };
    expect(result.findings).toHaveLength(0);
  });

  it('caps findings at maxFindings', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) {
      files[`/project/src/i${i}.ts`] = `export interface Iface${i} {}\n`;
    }
    setFilesystem(files);

    const api = makeApi({ extensions: { 'interface-contract-guard': { maxFindings: 2 } } });
    plugin.setup(api as never);
    const check = getTool(api, 'check_interface_contracts');
    const result = (await check({ path: 'src' })) as { ok: boolean; findings: unknown[] };
    expect(result.findings.length).toBeLessThanOrEqual(2);
  });

  it('rejects paths outside the project root', async () => {
    const api = makeApi();
    plugin.setup(api as never);
    const check = getTool(api, 'check_interface_contracts');
    const outside = process.platform === 'win32' ? 'C:\\Windows\\evil.ts' : '/etc/evil.ts';
    const result = (await check({ path: outside })) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('outside');
  });

  it('enabled:false disables the tool', async () => {
    const api = makeApi({ extensions: { 'interface-contract-guard': { enabled: false } } });
    plugin.setup(api as never);
    const check = getTool(api, 'check_interface_contracts');
    const result = (await check({})) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('disabled');
  });
});

describe('interface_contract_status tool', () => {
  it('returns config and zero counters before use', async () => {
    const api = makeApi();
    plugin.setup(api as never);
    const status = getTool(api, 'interface_contract_status');
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
    setFilesystem({
      '/project/src/types.ts': 'export interface Lonely {}\n',
    });

    const api = makeApi();
    plugin.setup(api as never);
    const check = getTool(api, 'check_interface_contracts');
    const status = getTool(api, 'interface_contract_status');
    await check({ path: 'src' });
    const result = (await status({})) as { counters: Record<string, number> };
    expect(result.counters['scans']).toBe(1);
    expect(result.counters['findings']).toBe(1);
  });
});

describe('PostToolUse hook behavior', () => {
  it('warns when a changed file contains interface declarations', async () => {
    setFilesystem({
      '/project/src/types.ts': 'export interface Updated {}\n',
    });

    const api = makeApi();
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'write',
      toolInput: { path: 'src/types.ts', content: 'x' },
      toolResult: { content: 'ok', isError: false },
    });
    expect(result?.additionalContext).toContain('interface-contract-guard');
    expect(result?.additionalContext).toContain('Updated');
  });

  it('stays silent when no interfaces are present', async () => {
    setFilesystem({
      '/project/src/util.ts': 'export const x = 1;\n',
    });

    const api = makeApi();
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'edit',
      toolInput: { path: 'src/util.ts', old_string: 'x', new_string: 'y' },
      toolResult: { content: 'ok', isError: false },
    });
    expect(result).toBeUndefined();
  });

  it('skips non-ts files', async () => {
    const api = makeApi();
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'write',
      toolInput: { path: 'src/util.js', content: 'interface Fake {}' },
      toolResult: { content: 'ok', isError: false },
    });
    expect(result).toBeUndefined();
  });

  it('skips when the mutating tool errored', async () => {
    setFilesystem({
      '/project/src/types.ts': 'export interface Updated {}\n',
    });

    const api = makeApi();
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'write',
      toolInput: { path: 'src/types.ts', content: 'x' },
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
      'interface-contract-guard: teardown complete',
      expect.any(Object),
    );
    const health = (await plugin.health!()) as { counters: Record<string, number> };
    expect(health.counters['scans']).toBe(0);
    expect(health.counters['findings']).toBe(0);
  });

  it('teardown is safe before setup', () => {
    const api = makeApi();
    expect(() => plugin.teardown!(api as never)).not.toThrow();
  });
});

describe('config parsing', () => {
  it('reads custom extensions and maxFindings', async () => {
    const api = makeApi({
      extensions: { 'interface-contract-guard': { extensions: ['.ts'], maxFindings: 10 } },
    });
    plugin.setup(api as never);
    const status = getTool(api, 'interface_contract_status');
    const result = (await status({})) as { extensions: string[]; maxFindings: number };
    expect(result.extensions).toEqual(['.ts']);
    expect(result.maxFindings).toBe(10);
  });
});

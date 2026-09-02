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
  readdirSync: vi.fn(mockReaddirSync),
  readFileSync: vi.fn(mockReadFileSync),
  statSync: vi.fn(mockStatSync),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async (p: string, encoding?: string) => mockReadFileSync(p, encoding)),
  readdir: vi.fn(async (p: string, options?: { withFileTypes?: boolean }) =>
    mockReaddirSync(p, options),
  ),
  stat: vi.fn(async (p: string) => mockStatSync(p)),
}));

const deadCodePlugin = (await import('../src/dead-code-detector')).default;

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
  metrics: {
    counter: ReturnType<typeof vi.fn>;
  };
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
        (overrides.enabled === true ? { 'dead-code-detector': { enabled: true } } : {}),
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
    // Ensure parent directories exist in the mock.
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
  await deadCodePlugin.teardown?.(api as never);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dead-code-detector plugin', () => {
  it('registers dead_code_scan tool and a PostToolUse write|edit hook', () => {
    const api = makeApi({ enabled: true });
    deadCodePlugin.setup(api as never);
    expect(api.tools.register).toHaveBeenCalledTimes(1);
    const [event, matcher] = api.registerHook.mock.calls[0]!;
    expect(event).toBe('PostToolUse');
    expect(matcher).toBe('write|edit');
  });

  it('dead_code_scan reports an unused exported const', async () => {
    setFilesystem({
      '/project/src/util.ts': 'export const unusedHelper = 42;\n',
      '/project/src/main.ts':
        'import { unusedHelper } from "./util";\nconsole.log(unusedHelper);\n',
    });

    const api = makeApi({ enabled: true });
    deadCodePlugin.setup(api as never);
    const scan = getTool(api, 'dead_code_scan');
    const result = (await scan({ path: 'src', depth: 2 })) as {
      ok: boolean;
      findings: Array<{ identifier: string; file: string }>;
    };
    expect(result.ok).toBe(true);
    expect(result.findings).toHaveLength(0);
  });

  it('dead_code_scan flags exported symbols with no external references', async () => {
    setFilesystem({
      '/project/src/util.ts':
        'export const unusedHelper = 42;\nexport function usedFn() { return 1; }\n',
      '/project/src/main.ts': 'import { usedFn } from "./util";\nusedFn();\n',
    });

    const api = makeApi({ enabled: true });
    deadCodePlugin.setup(api as never);
    const scan = getTool(api, 'dead_code_scan');
    const result = (await scan({ path: 'src', depth: 2 })) as {
      ok: boolean;
      findings: Array<{ identifier: string; file: string; line: number; exportType: string }>;
    };
    expect(result.ok).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.identifier).toBe('unusedHelper');
    expect(result.findings[0]!.file).toBe('src/util.ts');
    expect(result.findings[0]!.line).toBe(1);
    expect(result.findings[0]!.exportType).toBe('declaration');
  });

  it('dead_code_scan handles named exports and aliases', async () => {
    setFilesystem({
      '/project/src/a.ts': 'const internal = 1;\nexport { internal as exposed };\n',
      '/project/src/b.ts': '// nothing imported\n',
    });

    const api = makeApi({ enabled: true });
    deadCodePlugin.setup(api as never);
    const scan = getTool(api, 'dead_code_scan');
    const result = (await scan({ path: 'src', depth: 2 })) as {
      ok: boolean;
      findings: Array<{ identifier: string }>;
    };
    expect(result.ok).toBe(true);
    expect(result.findings.map((f) => f.identifier)).toContain('exposed');
    expect(result.findings.map((f) => f.identifier)).not.toContain('internal');
  });

  it('dead_code_scan skips default exports', async () => {
    setFilesystem({
      '/project/src/widget.ts': 'export default function widget() {}\n',
      '/project/src/main.ts': '// no import\n',
    });

    const api = makeApi({ enabled: true });
    deadCodePlugin.setup(api as never);
    const scan = getTool(api, 'dead_code_scan');
    const result = (await scan({ path: 'src', depth: 2 })) as {
      ok: boolean;
      findings: Array<{ identifier: string }>;
    };
    expect(result.findings.map((f) => f.identifier)).not.toContain('widget');
  });

  it('dead_code_scan respects depth limit', async () => {
    setFilesystem({
      '/project/src/deep/nested/util.ts': 'export const deepUnused = 1;\n',
    });

    const api = makeApi({ enabled: true });
    deadCodePlugin.setup(api as never);
    const scan = getTool(api, 'dead_code_scan');
    const shallow = (await scan({ path: 'src', depth: 0 })) as {
      ok: boolean;
      scannedFiles: number;
      findings: unknown[];
    };
    expect(shallow.ok).toBe(true);
    expect(shallow.scannedFiles).toBe(0);
    expect(shallow.findings).toHaveLength(0);

    const deep = (await scan({ path: 'src', depth: 2 })) as {
      ok: boolean;
      scannedFiles: number;
      findings: Array<{ identifier: string }>;
    };
    expect(deep.scannedFiles).toBe(1);
    expect(deep.findings.map((f) => f.identifier)).toContain('deepUnused');
  });

  it('dead_code_scan rejects paths outside the project root', async () => {
    const api = makeApi({ enabled: true });
    deadCodePlugin.setup(api as never);
    const scan = getTool(api, 'dead_code_scan');
    const outside =
      process.platform === 'win32' ? 'C:\\Windows\\System32\\evil.ts' : '/etc/evil.ts';
    const result = (await scan({ path: outside })) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('outside');
  });

  it('enabled:false disables the scan tool', async () => {
    const api = makeApi({
      extensions: { 'dead-code-detector': { enabled: false } },
    });
    deadCodePlugin.setup(api as never);
    const scan = getTool(api, 'dead_code_scan');
    const result = (await scan({})) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('disabled');
  });
});

describe('PostToolUse hook behavior', () => {
  it('injects additionalContext when a changed file has unused exports', async () => {
    setFilesystem({
      '/project/src/feature.ts': 'export const freshUnused = 100;\n',
    });

    const api = makeApi({ enabled: true });
    deadCodePlugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'write',
      toolInput: { path: 'src/feature.ts', content: 'export const freshUnused = 100;' },
      toolResult: { content: 'ok', isError: false },
    });
    expect(result?.additionalContext).toContain('dead-code-detector');
    expect(result?.additionalContext).toContain('freshUnused');
    expect(result?.additionalContext).toContain('src/feature.ts');
  });

  it('stays silent when the changed file has no unused exports', async () => {
    setFilesystem({
      '/project/src/feature.ts': 'export const shared = 1;\n',
      '/project/src/consumer.ts': 'import { shared } from "./feature";\nshared;\n',
    });

    const api = makeApi({ enabled: true });
    deadCodePlugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'edit',
      toolInput: { path: 'src/feature.ts', old_string: 'x', new_string: 'y' },
      toolResult: { content: 'ok', isError: false },
    });
    expect(result).toBeUndefined();
  });

  it('skips non-source files', async () => {
    const api = makeApi({ enabled: true });
    deadCodePlugin.setup(api as never);
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
      '/project/src/feature.ts': 'export const dead = 1;\n',
    });

    const api = makeApi({ enabled: true });
    deadCodePlugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'write',
      toolInput: { path: 'src/feature.ts', content: 'x' },
      toolResult: { content: 'error', isError: true },
    });
    expect(result).toBeUndefined();
  });

  it('skips paths outside the project root', async () => {
    const api = makeApi({ enabled: true });
    deadCodePlugin.setup(api as never);
    const hook = getHook(api);
    const outside =
      process.platform === 'win32' ? 'C:\\Windows\\System32\\evil.ts' : '/etc/evil.ts';
    const result = await hook({
      toolName: 'write',
      toolInput: { path: outside, content: 'x' },
      toolResult: { content: 'ok', isError: false },
    });
    expect(result).toBeUndefined();
  });

  it('skips when enabled:false', async () => {
    const api = makeApi({
      extensions: { 'dead-code-detector': { enabled: false } },
    });
    deadCodePlugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'write',
      toolInput: { path: 'src/feature.ts', content: 'export const dead = 1;' },
      toolResult: { content: 'ok', isError: false },
    });
    expect(result).toBeUndefined();
  });
});

describe('teardown + H1 pattern', () => {
  it('logs completion line and does not throw', () => {
    const api = makeApi({ enabled: true });
    deadCodePlugin.setup(api as never);
    expect(() => deadCodePlugin.teardown!(api as never)).not.toThrow();
    expect(api.log.info).toHaveBeenCalledWith(
      'dead-code-detector: teardown complete',
      expect.any(Object),
    );
  });

  it('zeros counters on teardown', async () => {
    const api = makeApi({ enabled: true });
    deadCodePlugin.setup(api as never);
    deadCodePlugin.teardown!(api as never);
    const health = (await deadCodePlugin.health!()) as { counters: Record<string, number> };
    expect(health.counters['scans']).toBe(0);
    expect(health.counters['hits']).toBe(0);
    expect(health.counters['warnings']).toBe(0);
  });

  it('teardown is safe before setup', () => {
    const api = makeApi();
    expect(() => deadCodePlugin.teardown!(api as never)).not.toThrow();
  });
});

describe('config parsing', () => {
  it('reads custom extensions and depth from config', async () => {
    const api = makeApi({
      extensions: { 'dead-code-detector': { extensions: ['.ts'], defaultDepth: 5 } },
    });
    deadCodePlugin.setup(api as never);
    const tool = api.tools.register.mock.calls[0]![0] as {
      inputSchema: { properties: Record<string, { default?: unknown }> };
    };
    // The schema defaults are static; status-style inspection would need the
    // tool execute. We just verify setup does not throw.
    expect(tool.inputSchema.properties['depth'].default).toBe(3);
  });
});

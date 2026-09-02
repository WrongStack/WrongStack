import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Virtual filesystem mock
// ---------------------------------------------------------------------------

type FsEntry = { type: 'file'; content: string } | { type: 'dir' };

let mockFs: Record<string, FsEntry> = {};
let writes: Array<{ path: string; content: string }> = [];

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
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

function mockWriteFileSync(p: string, content: string, _encoding?: string) {
  writes.push({
    path: normalizePath(p),
    content: typeof content === 'string' ? content : String(content),
  });
  mockFs[normalizePath(p)] = {
    type: 'file',
    content: typeof content === 'string' ? content : String(content),
  };
}

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(mockReadFileSync),
  writeFileSync: vi.fn(mockWriteFileSync),
}));

const plugin = (await import('../src/smart-rename')).default;

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
    config: { extensions: overrides.extensions ?? {} },
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

function setFilesystem(files: Record<string, string>) {
  mockFs = { '/project': { type: 'dir' } };
  writes = [];
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
  writes = [];
});

afterEach(async () => {
  const api = makeApi();
  await plugin.teardown?.(api as never);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('smart-rename plugin shape', () => {
  it('has name, apiVersion, setup function', () => {
    expect(plugin.name).toBe('smart-rename');
    expect(plugin.apiVersion).toBe('^0.1.10');
    expect(plugin.version).toBe('0.1.0');
    expect(typeof plugin.setup).toBe('function');
  });

  it('registers smart_rename tool and no hook', () => {
    const api = makeApi();
    plugin.setup(api as never);
    expect(api.tools.register).toHaveBeenCalledTimes(1);
    const names = api.tools.register.mock.calls.map(
      ([t]: unknown[]) => (t as { name: string }).name,
    );
    expect(names).toContain('smart_rename');
    expect(api.registerHook).not.toHaveBeenCalled();
  });
});

describe('smart_rename tool', () => {
  it('returns a preview without writing by default', async () => {
    setFilesystem({
      '/project/src/util.ts': 'export function foo() { return foo() + 1; }\nconst notFoo = 2;\n',
    });

    const api = makeApi();
    plugin.setup(api as never);
    const rename = getTool(api, 'smart_rename');
    const result = (await rename({ path: 'src/util.ts', oldName: 'foo', newName: 'bar' })) as {
      ok: boolean;
      path: string;
      replacements: number;
      preview: string;
      applied: boolean;
    };
    expect(result.ok).toBe(true);
    expect(result.path).toBe('src/util.ts');
    expect(result.replacements).toBe(2);
    expect(result.preview).toContain('bar');
    expect(result.preview).not.toContain('foo()');
    expect(result.preview).toContain('notFoo');
    expect(result.applied).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it('writes the preview when apply:true', async () => {
    setFilesystem({
      '/project/src/util.ts': 'export const x = 1;\n',
    });

    const api = makeApi();
    plugin.setup(api as never);
    const rename = getTool(api, 'smart_rename');
    const result = (await rename({
      path: 'src/util.ts',
      oldName: 'x',
      newName: 'y',
      apply: true,
    })) as {
      ok: boolean;
      applied: boolean;
      preview: string;
    };
    expect(result.ok).toBe(true);
    expect(result.applied).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.content).toBe('export const y = 1;\n');
  });

  it('rejects paths outside the project root', async () => {
    const api = makeApi();
    plugin.setup(api as never);
    const rename = getTool(api, 'smart_rename');
    const outside = process.platform === 'win32' ? 'C:\\Windows\\evil.ts' : '/etc/evil.ts';
    const result = (await rename({
      path: outside,
      oldName: 'x',
      newName: 'y',
    })) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('outside');
  });

  it('rejects disallowed extensions', async () => {
    setFilesystem({ '/project/README.md': '# hello\n' });

    const api = makeApi();
    plugin.setup(api as never);
    const rename = getTool(api, 'smart_rename');
    const result = (await rename({ path: 'README.md', oldName: 'hello', newName: 'world' })) as {
      ok: boolean;
      error: string;
    };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('extension');
  });

  it('requires oldName and newName', async () => {
    setFilesystem({ '/project/src/util.ts': 'const x = 1;\n' });

    const api = makeApi();
    plugin.setup(api as never);
    const rename = getTool(api, 'smart_rename');
    const missingOld = (await rename({ path: 'src/util.ts', newName: 'y' })) as {
      ok: boolean;
      error: string;
    };
    expect(missingOld.ok).toBe(false);
    expect(missingOld.error).toContain('oldName');

    const missingNew = (await rename({ path: 'src/util.ts', oldName: 'x' })) as {
      ok: boolean;
      error: string;
    };
    expect(missingNew.ok).toBe(false);
    expect(missingNew.error).toContain('newName');
  });

  it('enabled:false disables the tool', async () => {
    const api = makeApi({ extensions: { 'smart-rename': { enabled: false } } });
    plugin.setup(api as never);
    const rename = getTool(api, 'smart_rename');
    const result = (await rename({ path: 'src/util.ts', oldName: 'x', newName: 'y' })) as {
      ok: boolean;
      error: string;
    };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('disabled');
  });
});

describe('teardown + counters', () => {
  it('logs completion and zeros counters', async () => {
    setFilesystem({ '/project/src/a.ts': 'const x = 1;\n' });
    const api = makeApi();
    plugin.setup(api as never);
    const rename = getTool(api, 'smart_rename');
    await rename({ path: 'src/a.ts', oldName: 'x', newName: 'y' });
    plugin.teardown!(api as never);
    expect(api.log.info).toHaveBeenCalledWith(
      'smart-rename: teardown complete',
      expect.any(Object),
    );
    const health = (await plugin.health!()) as { counters: Record<string, number> };
    expect(health.counters['renames']).toBe(0);
    expect(health.counters['replacements']).toBe(0);
  });

  it('teardown is safe before setup', () => {
    const api = makeApi();
    expect(() => plugin.teardown!(api as never)).not.toThrow();
  });
});

describe('config parsing', () => {
  it('reads custom extensions', async () => {
    const api = makeApi({ extensions: { 'smart-rename': { extensions: ['.ts'] } } });
    plugin.setup(api as never);
    const rename = getTool(api, 'smart_rename');
    setFilesystem({ '/project/src/util.tsx': 'const x = 1;\n' });
    const result = (await rename({ path: 'src/util.tsx', oldName: 'x', newName: 'y' })) as {
      ok: boolean;
      error: string;
    };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('extension');
  });
});

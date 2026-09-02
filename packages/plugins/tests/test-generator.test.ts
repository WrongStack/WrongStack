import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Virtual filesystem mock
// ---------------------------------------------------------------------------

type FsEntry = { type: 'file'; content: string } | { type: 'dir' };

let mockFs: Record<string, FsEntry> = {};

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

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(mockReadFileSync),
}));

const plugin = (await import('../src/test-generator')).default;

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
  llm?: { complete: ReturnType<typeof vi.fn> };
}

function makeApi(
  overrides: {
    extensions?: Record<string, unknown>;
    llm?: { complete: ReturnType<typeof vi.fn> };
  } = {},
): MockApi {
  return {
    tools: { register: vi.fn() },
    config: { extensions: overrides.extensions ?? {} },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn() },
    registerHook: vi.fn(() => vi.fn()),
    llm: overrides.llm,
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

describe('test-generator plugin shape', () => {
  it('has name, apiVersion, setup function', () => {
    expect(plugin.name).toBe('test-generator');
    expect(plugin.apiVersion).toBe('^0.1.10');
    expect(plugin.version).toBe('0.2.0');
    expect(typeof plugin.setup).toBe('function');
  });

  it('registers generate_unit_tests tool and no hook', () => {
    const api = makeApi();
    plugin.setup(api as never);
    expect(api.tools.register).toHaveBeenCalledTimes(1);
    const names = api.tools.register.mock.calls.map(
      ([t]: unknown[]) => (t as { name: string }).name,
    );
    expect(names).toContain('generate_unit_tests');
    expect(api.registerHook).not.toHaveBeenCalled();
  });
});

describe('generate_unit_tests tool', () => {
  it('generates tests for exported functions, arrows, and classes', async () => {
    setFilesystem({
      '/project/src/math.ts':
        'export function add(a: number, b: number) { return a + b; }\n' +
        'export const sub = (a: number, b: number) => a - b;\n' +
        'export const PI = 3.14;\n' +
        'export class Calculator {}\n' +
        'export { add as addAlias };\n',
    });

    const api = makeApi();
    plugin.setup(api as never);
    const generate = getTool(api, 'generate_unit_tests');
    const result = (await generate({ path: 'src/math.ts' })) as {
      ok: boolean;
      testFile: string;
      exports: Array<{ name: string; kind: string }>;
      content: string;
    };
    expect(result.ok).toBe(true);
    expect(result.testFile).toBe('src/math.test.ts');
    expect(result.exports.map((e) => e.name)).toContain('add');
    expect(result.exports.map((e) => e.name)).toContain('sub');
    expect(result.exports.map((e) => e.name)).toContain('PI');
    expect(result.exports.map((e) => e.name)).toContain('Calculator');
    expect(result.content).toContain("import { describe, it, expect } from 'vitest';");
    expect(result.content).toContain(
      "import { add, sub, PI, Calculator, addAlias } from './math';",
    );
    expect(result.content).toContain("it('add behaves as expected'");
    expect(result.content).toContain('new Calculator()');
  });

  it('generates a placeholder when no exports are found', async () => {
    setFilesystem({
      '/project/src/empty.ts': 'const hidden = 1;\n',
    });

    const api = makeApi();
    plugin.setup(api as never);
    const generate = getTool(api, 'generate_unit_tests');
    const result = (await generate({ path: 'src/empty.ts' })) as {
      ok: boolean;
      exports: unknown[];
      content: string;
    };
    expect(result.ok).toBe(true);
    expect(result.exports).toHaveLength(0);
    expect(result.content).toContain('has no exported symbols to test');
  });

  it('respects framework and testSuffix config', async () => {
    setFilesystem({
      '/project/src/util.ts': 'export function foo() { return 1; }\n',
    });

    const api = makeApi({
      extensions: { 'test-generator': { framework: 'node:test', testSuffix: '.spec' } },
    });
    plugin.setup(api as never);
    const generate = getTool(api, 'generate_unit_tests');
    const result = (await generate({ path: 'src/util.ts' })) as {
      ok: boolean;
      testFile: string;
      content: string;
    };
    expect(result.testFile).toBe('src/util.spec.ts');
    expect(result.content).toContain("import { describe, it } from 'node:test';");
    expect(result.content).toContain("import assert from 'node:assert/strict';");
    expect(result.content).toContain('assert.ok(foo)');
  });

  it('omits imports when includeImports is false', async () => {
    setFilesystem({
      '/project/src/util.ts': 'export function foo() { return 1; }\n',
    });

    const api = makeApi({
      extensions: { 'test-generator': { includeImports: false } },
    });
    plugin.setup(api as never);
    const generate = getTool(api, 'generate_unit_tests');
    const result = (await generate({ path: 'src/util.ts' })) as { ok: boolean; content: string };
    expect(result.content).not.toContain("import { foo } from './util';");
  });

  it('preserves the source extension for JavaScript test files', async () => {
    setFilesystem({ '/project/src/value.js': 'export const value = 1;\n' });
    const api = makeApi();
    plugin.setup(api as never);

    const result = (await getTool(api, 'generate_unit_tests')({ path: 'src/value.js' })) as {
      testFile: string;
      content: string;
    };

    expect(result.testFile).toBe('src/value.test.js');
    expect(result.content).toContain("import { value } from './value';");
  });

  it('rejects paths outside the project root', async () => {
    const api = makeApi();
    plugin.setup(api as never);
    const generate = getTool(api, 'generate_unit_tests');
    const outside = process.platform === 'win32' ? 'C:\\Windows\\evil.ts' : '/etc/evil.ts';
    const result = (await generate({ path: outside })) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('outside');
  });

  it('enabled:false disables the tool', async () => {
    const api = makeApi({ extensions: { 'test-generator': { enabled: false } } });
    plugin.setup(api as never);
    const generate = getTool(api, 'generate_unit_tests');
    const result = (await generate({ path: 'src/x.ts' })) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('disabled');
  });

  it('uses api.llm for behavior-focused tests and strips an outer code fence', async () => {
    setFilesystem({
      '/project/src/math.ts': 'export function add(a: number, b: number) { return a + b; }\n',
    });
    const complete = vi.fn().mockResolvedValue({
      text: "```ts\nimport { describe, expect, it } from 'vitest';\nimport { add } from './math';\ndescribe('add', () => { it('adds', () => expect(add(1, 2)).toBe(3)); });\n```",
    });
    const api = makeApi({
      extensions: { 'test-generator': { useLlm: true } },
      llm: { complete },
    });
    plugin.setup(api as never);

    const generate = getTool(api, 'generate_unit_tests');
    const result = (await generate({ path: 'src/math.ts' })) as {
      content: string;
      llm: { used: boolean; fallbackReason: string | null };
    };

    expect(result.llm).toEqual({ used: true, fallbackReason: null, requested: true });
    expect(result.content).toContain('expect(add(1, 2)).toBe(3)');
    expect(result.content).not.toContain('```');
    expect(complete).toHaveBeenCalledWith(
      expect.stringContaining('<source>'),
      expect.objectContaining({ maxTokens: 4_096, temperature: 0.1 }),
    );
  });

  it('falls back to the deterministic skeleton when the LLM response is invalid', async () => {
    setFilesystem({ '/project/src/x.ts': 'export function x() { return 1; }\n' });
    const api = makeApi({ llm: { complete: vi.fn().mockResolvedValue({ text: 'not a test' }) } });
    plugin.setup(api as never);

    const result = (await getTool(
      api,
      'generate_unit_tests',
    )({
      path: 'src/x.ts',
      use_llm: true,
    })) as { content: string; llm: { used: boolean; fallbackReason: string } };

    expect(result.llm.used).toBe(false);
    expect(result.llm.fallbackReason).toBe('invalid-response');
    expect(result.content).toContain('TODO: replace with a real assertion for x');
  });
});

describe('teardown + counters', () => {
  it('logs completion and zeros counters', async () => {
    setFilesystem({ '/project/src/a.ts': 'export const a = 1;\n' });
    const api = makeApi();
    plugin.setup(api as never);
    const generate = getTool(api, 'generate_unit_tests');
    await generate({ path: 'src/a.ts' });
    plugin.teardown!(api as never);
    expect(api.log.info).toHaveBeenCalledWith(
      'test-generator: teardown complete',
      expect.any(Object),
    );
    const health = (await plugin.health!()) as { counters: Record<string, number> };
    expect(health.counters['generated']).toBe(0);
    expect(health.counters['exports']).toBe(0);
  });

  it('teardown is safe before setup', () => {
    const api = makeApi();
    expect(() => plugin.teardown!(api as never)).not.toThrow();
  });
});

describe('config parsing', () => {
  it('reads custom framework and suffix', async () => {
    const api = makeApi({
      extensions: { 'test-generator': { framework: 'jest', testSuffix: '.integration' } },
    });
    plugin.setup(api as never);
    setFilesystem({ '/project/src/x.ts': 'export function x() {}\n' });
    const generate = getTool(api, 'generate_unit_tests');
    const result = (await generate({ path: 'src/x.ts' })) as {
      ok: boolean;
      testFile: string;
      content: string;
    };
    expect(result.testFile).toBe('src/x.integration.ts');
    expect(result.content).toContain("from '@jest/globals'");
  });
});

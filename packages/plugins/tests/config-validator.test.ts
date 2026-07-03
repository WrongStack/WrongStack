import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const configValidatorPlugin = (await import('../src/config-validator')).default;
const { validateJson, validateYaml, validateToml } = await import('../src/config-validator');

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
    histogram: ReturnType<typeof vi.fn>;
    gauge: ReturnType<typeof vi.fn>;
  };
  registerHook: ReturnType<typeof vi.fn>;
}

function makeApi(overrides: { extensions?: Record<string, unknown> } = {}): MockApi {
  return {
    tools: { register: vi.fn() },
    config: { extensions: overrides.extensions ?? {} },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
    registerHook: vi.fn(() => vi.fn()),
  };
}

type HookResult = { additionalContext?: string } | undefined;

function getHook(api: MockApi): (input: unknown) => HookResult {
  const call = api.registerHook.mock.calls[0];
  if (!call) throw new Error('hook not registered');
  return (call as unknown[])[2] as (input: unknown) => HookResult;
}

let tmp: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmp = mkdtempSync(join(tmpdir(), 'config-validator-'));
});

afterEach(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // best-effort on Windows
  }
});

describe('validateJson', () => {
  it('accepts valid JSON and reports line/column for broken JSON', () => {
    expect(validateJson('{"a": 1}', false, 'x.json')).toHaveLength(0);
    const problems = validateJson('{\n  "a": 1,\n  "b": ,\n}', false, 'x.json');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('line');
  });

  it('accepts JSONC comments and trailing commas in .jsonc', () => {
    const jsonc = '{\n  // comment\n  "a": 1, /* block */\n  "b": [1, 2,],\n}';
    expect(validateJson(jsonc, true, 'x.jsonc')).toHaveLength(0);
  });

  it('checks package.json shape', () => {
    expect(validateJson('{"version": "1.0.0"}', false, 'package.json')[0]).toContain('"name"');
    expect(validateJson('{"name": "x", "dependencies": []}', false, 'package.json')[0]).toContain(
      'dependencies',
    );
    expect(validateJson('{"name": "x", "dependencies": {}}', false, 'package.json')).toHaveLength(
      0,
    );
  });
});

describe('validateYaml', () => {
  it('flags tab indentation', () => {
    const problems = validateYaml('a: 1\n\tb: 2');
    expect(problems[0]).toContain('tab');
  });

  it('flags duplicate keys at the same level, not across scopes', () => {
    expect(validateYaml('a: 1\nb: 2\na: 3')[0]).toContain('duplicate key "a"');
    // Same key under different parents is fine.
    expect(validateYaml('a:\n  x: 1\nb:\n  x: 2')).toHaveLength(0);
  });

  it('does not flag repeated keys across list items', () => {
    const yaml = 'items:\n  - name: a\n    port: 1\n  - name: b\n    port: 2';
    expect(validateYaml(yaml)).toHaveLength(0);
  });

  it('accepts a normal document', () => {
    expect(validateYaml('name: test\nsteps:\n  - run: build\n  - run: test')).toHaveLength(0);
  });
});

describe('validateToml', () => {
  it('flags duplicate tables and duplicate keys', () => {
    expect(validateToml('[a]\nx = 1\n[a]\ny = 2')[0]).toContain('duplicate table');
    expect(validateToml('[a]\nx = 1\nx = 2')[0]).toContain('duplicate key');
  });

  it('accepts valid TOML with array tables', () => {
    expect(validateToml('[a]\nx = 1\n[[items]]\nn = 1\n[[items]]\nn = 2')).toHaveLength(0);
  });
});

describe('config-validator plugin', () => {
  it('registers a status tool and a PostToolUse write|edit hook', () => {
    const api = makeApi();
    configValidatorPlugin.setup(api as never);
    expect(api.tools.register).toHaveBeenCalledTimes(1);
    const [event, matcher] = api.registerHook.mock.calls[0]!;
    expect(event).toBe('PostToolUse');
    expect(matcher).toBe('write|edit');
  });

  it('reports problems for a broken JSON file on disk', () => {
    const api = makeApi();
    configValidatorPlugin.setup(api as never);
    const hook = getHook(api);
    const file = join(tmp, 'broken.json');
    writeFileSync(file, '{"a": }');
    const result = hook({ toolName: 'write', toolInput: { path: file } });
    expect(result?.additionalContext).toContain('config-validator');
    expect(result?.additionalContext).toContain('JSON parse error');
  });

  it('stays silent for a valid file', () => {
    const api = makeApi();
    configValidatorPlugin.setup(api as never);
    const hook = getHook(api);
    const file = join(tmp, 'ok.json');
    writeFileSync(file, '{"a": 1}');
    expect(hook({ toolName: 'write', toolInput: { path: file } })).toBeUndefined();
  });

  it('ignores non-config extensions and missing files', () => {
    const api = makeApi();
    configValidatorPlugin.setup(api as never);
    const hook = getHook(api);
    expect(hook({ toolName: 'write', toolInput: { path: join(tmp, 'x.ts') } })).toBeUndefined();
    expect(
      hook({ toolName: 'write', toolInput: { path: join(tmp, 'gone.json') } }),
    ).toBeUndefined();
  });

  it('enabled:false disables validation', () => {
    const api = makeApi({ extensions: { 'config-validator': { enabled: false } } });
    configValidatorPlugin.setup(api as never);
    const hook = getHook(api);
    const file = join(tmp, 'broken.json');
    writeFileSync(file, '{"a": }');
    expect(hook({ toolName: 'write', toolInput: { path: file } })).toBeUndefined();
  });

  it('teardown zeros counters and logs', async () => {
    const api = makeApi();
    configValidatorPlugin.setup(api as never);
    configValidatorPlugin.teardown!(api as never);
    const health = (await configValidatorPlugin.health!()) as { counters: Record<string, number> };
    expect(health.counters['filesChecked']).toBe(0);
    expect(api.log.info).toHaveBeenCalledWith(
      'config-validator: teardown complete',
      expect.any(Object),
    );
  });
});

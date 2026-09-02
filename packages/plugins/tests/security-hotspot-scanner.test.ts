import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
}));

const promiseFs = vi.hoisted(() => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({
  readFile: promiseFs.readFile,
  readdir: promiseFs.readdir,
  stat: promiseFs.stat,
}));

const { readFileSync, readdirSync, statSync } = await import('node:fs');
const plugin = (await import('../src/security-hotspot-scanner')).default;

promiseFs.readFile.mockImplementation(async (p: string, encoding?: BufferEncoding) =>
  vi.mocked(readFileSync)(p, encoding ?? 'utf8'),
);
promiseFs.readdir.mockImplementation(async (p: string) => vi.mocked(readdirSync)(p));
promiseFs.stat.mockImplementation(async (p: string) => vi.mocked(statSync)(p));

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
        (overrides.enabled === true ? { 'security-hotspot-scanner': { enabled: true } } : {}),
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn() },
    registerHook: vi.fn(() => vi.fn()),
  };
}

function getRegisteredTool(
  api: MockApi,
  name: string,
): {
  execute: (input: unknown) => Promise<unknown>;
} {
  const call = api.tools.register.mock.calls.find(
    ([t]: unknown[]) => (t as { name: string }).name === name,
  );
  if (!call) throw new Error(`tool ${name} not registered`);
  return call[0] as { execute: (input: unknown) => Promise<unknown> };
}

function getHook(
  api: MockApi,
): (
  input: unknown,
) => Promise<{ decision?: string; reason?: string; additionalContext?: string } | void> {
  const call = api.registerHook.mock.calls[0];
  if (!call) throw new Error('hook not registered');
  return (call as unknown[])[2] as (
    input: unknown,
  ) => Promise<{ decision?: string; reason?: string; additionalContext?: string } | void>;
}

function mockFile(content: string, isDir = false) {
  vi.mocked(statSync).mockReturnValue({
    isDirectory: () => isDir,
    isFile: () => !isDir,
  } as unknown as ReturnType<typeof statSync>);
  vi.mocked(readFileSync).mockReturnValue(content);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  const api = makeApi();
  await plugin.teardown?.(api as never);
});

describe('security-hotspot-scanner plugin', () => {
  it('registers security_hotspot_scan, security_hotspot_status and a PostToolUse write|edit hook', () => {
    const api = makeApi({ enabled: true });
    plugin.setup(api as never);
    const names = api.tools.register.mock.calls.map(
      ([t]: unknown[]) => (t as { name: string }).name,
    );
    expect(names).toContain('security_hotspot_scan');
    expect(names).toContain('security_hotspot_status');
    const [event, matcher] = api.registerHook.mock.calls[0]!;
    expect(event).toBe('PostToolUse');
    expect(matcher).toBe('write|edit');
  });

  it('status tool reports config and counters', async () => {
    const api = makeApi({ enabled: true });
    plugin.setup(api as never);
    const tool = getRegisteredTool(api, 'security_hotspot_status');
    const result = (await tool.execute({})) as {
      ok: boolean;
      enabled: boolean;
      severity: string;
      patternTypes: string[];
      counters: Record<string, number>;
    };
    expect(result.ok).toBe(true);
    expect(result.enabled).toBe(true);
    expect(result.severity).toBe('warn');
    expect(result.patternTypes).toContain('eval_call');
    expect(result.patternTypes).toContain('sql_concatenation');
    expect(result.counters.scans).toBe(0);
  });

  it('scan tool detects eval and Function constructor', async () => {
    mockFile('const x = eval(code);\nconst y = new Function("a", "return a");');
    const api = makeApi({ enabled: true });
    plugin.setup(api as never);
    const tool = getRegisteredTool(api, 'security_hotspot_scan');
    const result = (await tool.execute({ path: 'src/bad.js' })) as {
      ok: boolean;
      findings: { type: string; line: number }[];
      findingCount: number;
    };
    expect(result.ok).toBe(true);
    expect(result.findings.some((f) => f.type === 'eval_call')).toBe(true);
    expect(result.findings.some((f) => f.type === 'function_constructor')).toBe(true);
    expect(result.findingCount).toBeGreaterThanOrEqual(2);
  });

  it('scan tool detects innerHTML, dangerouslySetInnerHTML and SQL concatenation', async () => {
    mockFile(
      'element.innerHTML = userInput;\n' +
        'return <div dangerouslySetInnerHTML={{__html: html}} />;\n' +
        'db.query("SELECT * FROM users WHERE id = " + id);',
    );
    const api = makeApi({ enabled: true });
    plugin.setup(api as never);
    const tool = getRegisteredTool(api, 'security_hotspot_scan');
    const result = (await tool.execute({ path: 'src/xss.js' })) as {
      ok: boolean;
      findings: { type: string }[];
    };
    expect(result.ok).toBe(true);
    expect(result.findings.some((f) => f.type === 'unsafe_html')).toBe(true);
    expect(result.findings.some((f) => f.type === 'sql_concatenation')).toBe(true);
  });

  it('scan tool detects hardcoded http URLs, credential logging and variable exec', async () => {
    mockFile(
      'const url = "http://example.com/api";\n' +
        'console.log("password", user.password);\n' +
        'exec(`rm -rf ' +
        String.fromCharCode(36) +
        '{dir}`);',
    );
    const api = makeApi({ enabled: true });
    plugin.setup(api as never);
    const tool = getRegisteredTool(api, 'security_hotspot_scan');
    const result = (await tool.execute({ path: 'src/mixed.js' })) as {
      ok: boolean;
      findings: { type: string }[];
    };
    expect(result.ok).toBe(true);
    expect(result.findings.some((f) => f.type === 'hardcoded_http')).toBe(true);
    expect(result.findings.some((f) => f.type === 'console_log_credentials')).toBe(true);
    expect(result.findings.some((f) => f.type === 'exec_variable_command')).toBe(true);
  });

  it('scan tool returns no findings for clean code', async () => {
    mockFile('const add = (a: number, b: number) => a + b;\nconsole.log("hello");');
    const api = makeApi({ enabled: true });
    plugin.setup(api as never);
    const tool = getRegisteredTool(api, 'security_hotspot_scan');
    const result = (await tool.execute({ path: 'src/clean.ts' })) as {
      ok: boolean;
      findingCount: number;
    };
    expect(result.ok).toBe(true);
    expect(result.findingCount).toBe(0);
  });

  it('scan tool rejects paths outside the project', async () => {
    const api = makeApi({ enabled: true });
    plugin.setup(api as never);
    const tool = getRegisteredTool(api, 'security_hotspot_scan');
    const result = (await tool.execute({ path: '/etc/passwd' })) as {
      ok: boolean;
      error: string;
    };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('outside');
  });

  it('scan tool handles missing paths gracefully', async () => {
    vi.mocked(statSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const api = makeApi({ enabled: true });
    plugin.setup(api as never);
    const tool = getRegisteredTool(api, 'security_hotspot_scan');
    const result = (await tool.execute({ path: 'src/missing.js' })) as {
      ok: boolean;
      error: string;
    };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('does not exist');
  });

  it('scan tool recurses into directories', async () => {
    vi.mocked(statSync).mockImplementation((p: string | Buffer | URL) => {
      const path = String(p);
      if (path.endsWith('src')) {
        return { isDirectory: () => true, isFile: () => false } as ReturnType<typeof statSync>;
      }
      return { isDirectory: () => false, isFile: () => true } as ReturnType<typeof statSync>;
    });
    vi.mocked(readdirSync).mockReturnValue(['a.js', 'b.ts'] as unknown[] as ReturnType<
      typeof readdirSync
    >);
    vi.mocked(readFileSync).mockImplementation((p: string | Buffer | URL) => {
      const path = String(p);
      if (path.endsWith('a.js')) return 'eval(x);';
      if (path.endsWith('b.ts')) return 'const url = "http://bad.com";';
      return '';
    });
    const api = makeApi({ enabled: true });
    plugin.setup(api as never);
    const tool = getRegisteredTool(api, 'security_hotspot_scan');
    const result = (await tool.execute({ path: 'src' })) as {
      ok: boolean;
      filesScanned: number;
      findings: { type: string }[];
    };
    expect(result.ok).toBe(true);
    expect(result.filesScanned).toBe(2);
    expect(result.findings.some((f) => f.type === 'eval_call')).toBe(true);
    expect(result.findings.some((f) => f.type === 'hardcoded_http')).toBe(true);
  });

  it('PostToolUse hook injects additionalContext for new hotspots', async () => {
    mockFile('const x = eval(userCode);');
    const api = makeApi({ enabled: true });
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'write',
      toolInput: { path: 'src/new.js' },
      toolResult: { content: 'ok', isError: false },
    });
    expect(result).toBeDefined();
    expect(result?.additionalContext).toContain('eval_call');
    expect(result?.additionalContext).toContain('new security hotspot');
  });

  it('PostToolUse hook returns block decision when severity is block', async () => {
    mockFile('element.innerHTML = payload;');
    const api = makeApi({
      extensions: { 'security-hotspot-scanner': { enabled: true, severity: 'block' } },
    });
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'edit',
      toolInput: { path: 'src/xss.js' },
      toolResult: { content: 'ok', isError: false },
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('unsafe_html');
  });

  it('PostToolUse hook skips when the underlying tool errored', async () => {
    mockFile('eval(x);');
    const api = makeApi({ enabled: true });
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'write',
      toolInput: { path: 'src/bad.js' },
      toolResult: { content: 'error', isError: true },
    });
    expect(result).toBeUndefined();
  });

  it('PostToolUse hook skips non-source files by extension', async () => {
    const api = makeApi({ enabled: true });
    plugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'write',
      toolInput: { path: 'README.md' },
      toolResult: { content: 'ok', isError: false },
    });
    expect(result).toBeUndefined();
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it('PostToolUse hook does not repeat the same hotspot', async () => {
    mockFile('eval(x);');
    const api = makeApi({ enabled: true });
    plugin.setup(api as never);
    const hook = getHook(api);
    const first = await hook({
      toolName: 'write',
      toolInput: { path: 'src/bad.js' },
      toolResult: { content: 'ok', isError: false },
    });
    expect(first?.additionalContext).toContain('eval_call');
    const second = await hook({
      toolName: 'edit',
      toolInput: { path: 'src/bad.js' },
      toolResult: { content: 'ok', isError: false },
    });
    expect(second).toBeUndefined();
  });

  it('enabled:false disables the hook and scan tool', async () => {
    mockFile('eval(x);');
    const api = makeApi({ extensions: { 'security-hotspot-scanner': { enabled: false } } });
    plugin.setup(api as never);
    const hook = getHook(api);
    const hookResult = await hook({
      toolName: 'write',
      toolInput: { path: 'src/bad.js' },
      toolResult: { content: 'ok', isError: false },
    });
    expect(hookResult).toBeUndefined();

    const tool = getRegisteredTool(api, 'security_hotspot_scan');
    const scanResult = (await tool.execute({ path: 'src/bad.js' })) as {
      ok: boolean;
      error: string;
    };
    expect(scanResult.ok).toBe(false);
    expect(scanResult.error).toContain('disabled');
  });

  it('teardown unregisters the hook and zeros state', async () => {
    const api = makeApi({ enabled: true });
    plugin.setup(api as never);
    const unregister = api.registerHook.mock.results[0]?.value;
    expect(typeof unregister).toBe('function');

    plugin.teardown!(api as never);
    expect(unregister).toHaveBeenCalled();
    const health = (await plugin.health!()) as { counters: Record<string, number> };
    expect(health.counters.scans).toBe(0);
    expect(health.counters.findings).toBe(0);
    expect(api.log.info).toHaveBeenCalledWith(
      'security-hotspot-scanner: teardown complete',
      expect.any(Object),
    );
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}));

const { readFileSync } = await import('node:fs');
const licenseAuditPlugin = (await import('../src/license-audit-gate')).default;

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

type HookResult = { decision?: string; reason?: string; additionalContext?: string } | undefined;

function getHook(api: MockApi): (input: unknown) => HookResult {
  const call = api.registerHook.mock.calls[0];
  if (!call) throw new Error('hook not registered');
  return (call as unknown[])[2] as (input: unknown) => HookResult;
}

function getStatusTool(api: MockApi): { execute: (input: unknown) => Promise<unknown> } {
  const call = api.tools.register.mock.calls.find(
    ([t]: unknown[]) => (t as { name: string }).name === 'license_audit_status',
  );
  if (!call) throw new Error('license_audit_status not registered');
  return call[0] as { execute: (input: unknown) => Promise<unknown> };
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

function mockPackage(name: string, pkg: Record<string, unknown>) {
  vi.mocked(readFileSync).mockImplementation((path: string | Buffer | URL) => {
    if (
      typeof path === 'string' &&
      normalizePath(path).endsWith(`node_modules/${name}/package.json`)
    ) {
      return JSON.stringify(pkg);
    }
    throw new Error(`ENOENT: ${String(path)}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readFileSync).mockReset();
});

describe('license-audit-gate plugin', () => {
  it('registers license_audit_status and a PostToolUse bash|exec hook', () => {
    const api = makeApi();
    licenseAuditPlugin.setup(api as never);
    expect(api.tools.register).toHaveBeenCalledTimes(1);
    const [event, matcher] = api.registerHook.mock.calls[0]!;
    expect(event).toBe('PostToolUse');
    expect(matcher).toBe('bash|exec');
  });

  it('passes through non-install commands silently', () => {
    const api = makeApi();
    licenseAuditPlugin.setup(api as never);
    const hook = getHook(api);
    expect(hook({ toolName: 'bash', toolInput: { command: 'npm test' } })).toBeUndefined();
    expect(hook({ toolName: 'bash', toolInput: { command: 'ls -la' } })).toBeUndefined();
    expect(hook({ toolName: 'write', toolInput: { path: 'src/index.ts' } })).toBeUndefined();
  });

  it('passes through when install command has no packages', () => {
    const api = makeApi();
    licenseAuditPlugin.setup(api as never);
    const hook = getHook(api);
    expect(hook({ toolName: 'bash', toolInput: { command: 'npm install' } })).toBeUndefined();
  });

  it('allows packages whose licenses are in the allowlist', () => {
    mockPackage('lodash', { name: 'lodash', license: 'MIT' });
    const api = makeApi();
    licenseAuditPlugin.setup(api as never);
    const hook = getHook(api);
    const result = hook({
      toolName: 'bash',
      toolInput: { command: 'npm install lodash' },
      toolResult: { content: '', isError: false },
    });
    expect(result).toBeUndefined();
  });

  it('blocks disallowed licenses in block mode (default)', () => {
    mockPackage('proprietary-pkg', { name: 'proprietary-pkg', license: 'Proprietary' });
    const api = makeApi();
    licenseAuditPlugin.setup(api as never);
    const hook = getHook(api);
    const result = hook({
      toolName: 'bash',
      toolInput: { command: 'npm install proprietary-pkg' },
      toolResult: { content: '', isError: false },
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('Proprietary');
    expect(result?.reason).toContain('not in allowlist');
  });

  it('warns instead of blocks when block:false', () => {
    mockPackage('gpl-pkg', { name: 'gpl-pkg', license: 'GPL-3.0' });
    const api = makeApi({ extensions: { 'license-audit-gate': { block: false } } });
    licenseAuditPlugin.setup(api as never);
    const hook = getHook(api);
    const result = hook({
      toolName: 'bash',
      toolInput: { command: 'pnpm add gpl-pkg' },
      toolResult: { content: '', isError: false },
    });
    expect(result?.decision).toBeUndefined();
    expect(result?.additionalContext).toContain('GPL-3.0');
    expect(result?.additionalContext).toContain('not in allowlist');
  });

  it('treats missing license as denied', () => {
    mockPackage('mystery-pkg', { name: 'mystery-pkg' });
    const api = makeApi();
    licenseAuditPlugin.setup(api as never);
    const hook = getHook(api);
    const result = hook({
      toolName: 'bash',
      toolInput: { command: 'yarn add mystery-pkg' },
      toolResult: { content: '', isError: false },
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('no license found');
  });

  it('reads license object and licenses array forms', () => {
    vi.mocked(readFileSync).mockImplementation((path: string | Buffer | URL) => {
      const p = normalizePath(String(path));
      if (p.endsWith('node_modules/obj-pkg/package.json')) {
        return JSON.stringify({
          name: 'obj-pkg',
          license: { type: 'MIT', url: 'https://mit.edu' },
        });
      }
      if (p.endsWith('node_modules/arr-pkg/package.json')) {
        return JSON.stringify({
          name: 'arr-pkg',
          licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }],
        });
      }
      throw new Error(`ENOENT: ${p}`);
    });
    const api = makeApi();
    licenseAuditPlugin.setup(api as never);
    const hook = getHook(api);
    const result = hook({
      toolName: 'bash',
      toolInput: { command: 'bun add obj-pkg arr-pkg' },
      toolResult: { content: '', isError: false },
    });
    expect(result).toBeUndefined();
  });

  it('blocks when one of multiple licenses is disallowed', () => {
    vi.mocked(readFileSync).mockImplementation((path: string | Buffer | URL) => {
      const p = normalizePath(String(path));
      if (p.endsWith('node_modules/mixed-pkg/package.json')) {
        return JSON.stringify({
          name: 'mixed-pkg',
          licenses: [{ type: 'MIT' }, { type: 'GPL-2.0' }],
        });
      }
      throw new Error(`ENOENT: ${p}`);
    });
    const api = makeApi();
    licenseAuditPlugin.setup(api as never);
    const hook = getHook(api);
    const result = hook({
      toolName: 'bash',
      toolInput: { command: 'npm install mixed-pkg' },
      toolResult: { content: '', isError: false },
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('GPL-2.0');
  });

  it('blocks when package.json cannot be read', () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const api = makeApi();
    licenseAuditPlugin.setup(api as never);
    const hook = getHook(api);
    const result = hook({
      toolName: 'bash',
      toolInput: { command: 'npm install missing-pkg' },
      toolResult: { content: '', isError: false },
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('could not read package.json');
  });

  it('uses custom allowedLicenses config', () => {
    mockPackage('custom-pkg', { name: 'custom-pkg', license: 'Custom-1.0' });
    const api = makeApi({
      extensions: { 'license-audit-gate': { allowedLicenses: ['Custom-1.0'] } },
    });
    licenseAuditPlugin.setup(api as never);
    const hook = getHook(api);
    const result = hook({
      toolName: 'bash',
      toolInput: { command: 'npm install custom-pkg' },
      toolResult: { content: '', isError: false },
    });
    expect(result).toBeUndefined();
  });

  it('enabled:false disables the hook', () => {
    mockPackage('gpl-pkg', { name: 'gpl-pkg', license: 'GPL-3.0' });
    const api = makeApi({ extensions: { 'license-audit-gate': { enabled: false } } });
    licenseAuditPlugin.setup(api as never);
    const hook = getHook(api);
    const result = hook({
      toolName: 'bash',
      toolInput: { command: 'npm install gpl-pkg' },
      toolResult: { content: '', isError: false },
    });
    expect(result).toBeUndefined();
  });

  it('strips version suffixes and scopes from package specifiers', () => {
    mockPackage('@types/node', { name: '@types/node', license: 'MIT' });
    const api = makeApi();
    licenseAuditPlugin.setup(api as never);
    const hook = getHook(api);
    const result = hook({
      toolName: 'bash',
      toolInput: { command: 'npm install @types/node@22.0.0' },
      toolResult: { content: '', isError: false },
    });
    expect(result).toBeUndefined();
  });

  it('license_audit_status reports config and counters', async () => {
    const api = makeApi({
      extensions: { 'license-audit-gate': { allowedLicenses: ['MIT'], block: false } },
    });
    licenseAuditPlugin.setup(api as never);
    const result = await getStatusTool(api).execute({});
    expect(result).toMatchObject({
      ok: true,
      enabled: true,
      allowedLicenses: ['MIT'],
      block: false,
      counters: {
        invocations: 0,
        installsSeen: 0,
        packagesAudited: 0,
        allowed: 0,
        denied: 0,
        blocked: 0,
        errors: 0,
      },
    });
  });

  it('teardown zeros state and logs', async () => {
    const api = makeApi();
    licenseAuditPlugin.setup(api as never);
    licenseAuditPlugin.teardown!(api as never);
    const health = (await licenseAuditPlugin.health!()) as { counters: Record<string, number> };
    expect(health.counters['invocations']).toBe(0);
    expect(api.log.info).toHaveBeenCalledWith(
      'license-audit-gate: teardown complete',
      expect.any(Object),
    );
  });

  it('teardown is safe before setup', () => {
    const api = makeApi();
    expect(() => licenseAuditPlugin.teardown!(api as never)).not.toThrow();
  });

  it('denies (A OR B) AND C when only one OR branch is allow-listed', () => {
    // Regression: the old parser stripped parentheses, so this collapsed to
    // `MIT OR Apache-2.0 AND GPL-3.0` and the OR-branch short-circuit allowed
    // the package despite the non-allow-listed GPL AND-clause.
    mockPackage('dual', { name: 'dual', license: '(MIT OR Apache-2.0) AND GPL-3.0' });
    const api = makeApi({
      extensions: { 'license-audit-gate': { allowedLicenses: ['MIT'] } },
    });
    licenseAuditPlugin.setup(api as never);
    const hook = getHook(api);
    const result = hook({
      toolName: 'bash',
      toolInput: { command: 'npm install dual' },
      toolResult: { content: '', isError: false },
    }) as HookResult;
    expect(result?.decision).toBe('block');
  });

  it('allows (A OR B) AND C when every AND branch is allow-listed', () => {
    mockPackage('dual', { name: 'dual', license: '(MIT OR Apache-2.0) AND GPL-3.0' });
    const api = makeApi({
      extensions: { 'license-audit-gate': { allowedLicenses: ['MIT', 'GPL-3.0'] } },
    });
    licenseAuditPlugin.setup(api as never);
    const hook = getHook(api);
    expect(
      hook({
        toolName: 'bash',
        toolInput: { command: 'npm install dual' },
        toolResult: { content: '', isError: false },
      }),
    ).toBeUndefined();
  });

  it('keeps OR semantics for grouped sub-expressions', () => {
    mockPackage('grouped', { name: 'grouped', license: 'MIT OR (GPL-3.0 AND Apache-2.0)' });
    const api = makeApi({
      extensions: { 'license-audit-gate': { allowedLicenses: ['MIT'] } },
    });
    licenseAuditPlugin.setup(api as never);
    const hook = getHook(api);
    expect(
      hook({
        toolName: 'bash',
        toolInput: { command: 'npm install grouped' },
        toolResult: { content: '', isError: false },
      }),
    ).toBeUndefined();
  });
});

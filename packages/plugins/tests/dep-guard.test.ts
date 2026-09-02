import { beforeEach, describe, expect, it, vi } from 'vitest';

const depGuardPlugin = (await import('../src/dep-guard/index.js')).default;
const { parseInstallCommands, editDistance, typosquatOf } = await import(
  '../src/dep-guard/index.js'
);

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
  llm?: {
    complete: ReturnType<typeof vi.fn>;
    council?: ReturnType<typeof vi.fn>;
  };
}

function makeApi(
  overrides: { extensions?: Record<string, unknown>; llm?: MockApi['llm'] } = {},
): MockApi {
  return {
    tools: { register: vi.fn() },
    config: { extensions: overrides.extensions ?? {} },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
    registerHook: vi.fn(() => vi.fn()),
    ...(overrides.llm ? { llm: overrides.llm } : {}),
  };
}

type HookResult = { decision?: string; reason?: string; additionalContext?: string } | undefined;

function getHook(api: MockApi): (input: unknown) => HookResult {
  const call = api.registerHook.mock.calls[0];
  if (!call) throw new Error('hook not registered');
  return (call as unknown[])[2] as (input: unknown) => HookResult;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('parseInstallCommands', () => {
  it('parses npm/pnpm/yarn adds with and without versions', async () => {
    const [npm] = parseInstallCommands('npm install lodash@4.17.21');
    expect(npm?.packages).toEqual([{ name: 'lodash', version: '4.17.21' }]);
    const [pnpm] = parseInstallCommands('pnpm add zod react');
    expect(pnpm?.packages.map((p) => p.name)).toEqual(['zod', 'react']);
    const [scoped] = parseInstallCommands('yarn add @types/node@22');
    expect(scoped?.packages).toEqual([{ name: '@types/node', version: '22' }]);
  });

  it('parses pip and cargo', async () => {
    const [pip] = parseInstallCommands('pip install requests==2.31.0');
    expect(pip?.packages).toEqual([{ name: 'requests', version: '2.31.0' }]);
    const [cargo] = parseInstallCommands('cargo add serde');
    expect(cargo?.packages.map((p) => p.name)).toEqual(['serde']);
  });

  it('bare npm install (lockfile restore) has no packages', async () => {
    const parsed = parseInstallCommands('npm install');
    expect(parsed.flatMap((p) => p.packages)).toHaveLength(0);
  });

  it('skips flags, paths, and urls', async () => {
    const [only] = parseInstallCommands('pnpm add --save-dev ./local-pkg https://x.test/a.tgz zod');
    expect(only?.packages.map((p) => p.name)).toEqual(['zod']);
  });

  it('finds installs inside compound commands', async () => {
    const parsed = parseInstallCommands('cd app && npm i left-pad && npm test');
    expect(parsed.flatMap((p) => p.packages).map((p) => p.name)).toEqual(['left-pad']);
  });

  it('parses caret / scoped / pip / cargo / bun edge cases (issue #364)', () => {
    expect(parseInstallCommands('pnpm add foo@^1.2.3')[0]?.packages).toEqual([
      { name: 'foo', version: '^1.2.3' },
    ]);
    expect(parseInstallCommands('pnpm add @types/node')[0]?.packages).toEqual([
      { name: '@types/node', version: null },
    ]);
    expect(parseInstallCommands('pnpm add @types/node@^20.0.0')[0]?.packages).toEqual([
      { name: '@types/node', version: '^20.0.0' },
    ]);
    expect(parseInstallCommands('pip install foo>=1.0')[0]?.packages).toEqual([
      { name: 'foo', version: '>=1.0' },
    ]);
    expect(parseInstallCommands('pip install foo~=1.0')[0]?.packages).toEqual([
      { name: 'foo', version: '~=1.0' },
    ]);
    expect(parseInstallCommands('pip install "foo[bar]>=1.0"')[0]?.packages).toEqual([
      { name: 'foo[bar]', version: '>=1.0' },
    ]);
    expect(parseInstallCommands('cargo add foo@^1.0')[0]?.packages).toEqual([
      { name: 'foo', version: '^1.0' },
    ]);
    expect(parseInstallCommands('bun add foo')[0]?.packages).toEqual([
      { name: 'foo', version: null },
    ]);
    expect(parseInstallCommands('bun add foo@latest')[0]?.packages).toEqual([
      { name: 'foo', version: 'latest' },
    ]);
    expect(parseInstallCommands('npm install').flatMap((p) => p.packages)).toEqual([]);
  });
});

describe('cross-plugin install parse parity (issue #364)', () => {
  it('license-audit-gate and dep-guard extract the same package names', async () => {
    const { parsePackageNames } = await import('../src/license-audit-gate/index.js');
    const { isInstallCommand } = await import('../src/dependency-vulnerability-gate/index.js');
    const commands = [
      'pnpm add foo@^1.2.3 @types/node@^20.0.0',
      'bun add foo@latest',
      'pip install foo>=1.0',
      'cargo add foo@^1.0',
      'npm install',
    ];
    for (const command of commands) {
      const fromDep = parseInstallCommands(command)
        .flatMap((e) => e.packages.map((p) => p.name))
        .sort();
      expect(parsePackageNames(command).sort()).toEqual(fromDep);
      expect(isInstallCommand({ toolName: 'bash', toolInput: { command } })).toBe(
        parseInstallCommands(command).length > 0,
      );
    }
  });
});

describe('typosquat detection', () => {
  it('editDistance basics', async () => {
    expect(editDistance('react', 'react')).toBe(0);
    expect(editDistance('raect', 'react')).toBeGreaterThanOrEqual(1);
    expect(editDistance('completely', 'different')).toBeGreaterThan(2);
  });

  it('flags one-edit lookalikes, not exact names', async () => {
    expect(typosquatOf('lodahs')).toBe('lodash');
    expect(typosquatOf('lodash')).toBeNull();
    expect(typosquatOf('some-random-package')).toBeNull();
  });
});

describe('dep-guard plugin', () => {
  it('registers dep_guard_status and a PreToolUse bash|exec hook', async () => {
    const api = makeApi();
    depGuardPlugin.setup(api as never);
    expect(api.tools.register).toHaveBeenCalledTimes(1);
    const [event, matcher] = api.registerHook.mock.calls[0]!;
    expect(event).toBe('PreToolUse');
    expect(matcher).toBe('bash|exec');
  });

  it('passes through non-install commands silently', async () => {
    const api = makeApi();
    depGuardPlugin.setup(api as never);
    const hook = getHook(api);
    expect(await hook({ toolName: 'bash', toolInput: { command: 'npm test' } })).toBeUndefined();
    expect(await hook({ toolName: 'bash', toolInput: { command: 'ls -la' } })).toBeUndefined();
  });

  it('blocks deny-listed packages', async () => {
    const api = makeApi({ extensions: { 'dep-guard': { deny: ['left-pad'] } } });
    depGuardPlugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({ toolName: 'bash', toolInput: { command: 'npm i left-pad' } });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('left-pad');
  });

  it('deny supports prefix globs and allow overrides', async () => {
    const api = makeApi({
      extensions: { 'dep-guard': { deny: ['@evil/*'], allow: ['@evil/but-fine'] } },
    });
    depGuardPlugin.setup(api as never);
    const hook = getHook(api);
    expect(
      (await hook({ toolName: 'bash', toolInput: { command: 'pnpm add @evil/pkg' } }))?.decision,
    ).toBe('block');
    const allowed = await hook({
      toolName: 'bash',
      toolInput: { command: 'pnpm add @evil/but-fine' },
    });
    expect(allowed?.decision).not.toBe('block');
  });

  it('warn mode annotates instead of blocking', async () => {
    const api = makeApi({ extensions: { 'dep-guard': { deny: ['left-pad'], mode: 'warn' } } });
    depGuardPlugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({ toolName: 'bash', toolInput: { command: 'npm i left-pad' } });
    expect(result?.decision).toBe('allow');
    expect(result?.additionalContext).toContain('DENY-LISTED');
  });

  it('warns on typosquat lookalikes', async () => {
    const api = makeApi();
    depGuardPlugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({ toolName: 'bash', toolInput: { command: 'npm i lodahs' } });
    expect(result?.decision).toBe('allow');
    expect(result?.additionalContext).toContain('typosquat');
  });

  it('uses the risk-review Council for opt-in typosquat confirmation', async () => {
    const council = vi.fn().mockResolvedValue({
      status: 'decided',
      optionId: 'uncertain',
      answer: 'Insufficient evidence',
      reason: 'Edit distance alone cannot establish package provenance.',
    });
    const complete = vi.fn();
    const api = makeApi({
      extensions: { 'dep-guard': { confirmTyposquatsWithLlm: true } },
      llm: { complete, council },
    });
    depGuardPlugin.setup(api as never);

    const result = await getHook(api)({
      toolName: 'bash',
      toolInput: { command: 'npm i lodahs' },
    });

    expect(result?.additionalContext).toContain('UNCERTAIN:');
    expect(council).toHaveBeenCalledWith(
      expect.stringContaining('lodahs'),
      expect.objectContaining({ profile: 'risk-review' }),
    );
    expect(complete).not.toHaveBeenCalled();
  });

  it('warnOnUnpinned flags versionless installs', async () => {
    const api = makeApi({
      extensions: { 'dep-guard': { warnOnUnpinned: true, typosquatCheck: false } },
    });
    depGuardPlugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({ toolName: 'bash', toolInput: { command: 'npm i some-clean-pkg' } });
    expect(result?.additionalContext).toContain('no pinned version');
  });

  it('clean installs still get a confirmation note', async () => {
    const api = makeApi();
    depGuardPlugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({ toolName: 'bash', toolInput: { command: 'pnpm add zod@3.23.8' } });
    expect(result?.decision).toBe('allow');
    expect(result?.additionalContext).toContain('adds 1 dependency');
  });

  it('enabled:false disables the guard', async () => {
    const api = makeApi({ extensions: { 'dep-guard': { enabled: false, deny: ['left-pad'] } } });
    depGuardPlugin.setup(api as never);
    const hook = getHook(api);
    expect(
      await hook({ toolName: 'bash', toolInput: { command: 'npm i left-pad' } }),
    ).toBeUndefined();
  });

  it('teardown zeros counters and logs', async () => {
    const api = makeApi();
    depGuardPlugin.setup(api as never);
    depGuardPlugin.teardown!(api as never);
    const health = (await depGuardPlugin.health!()) as unknown as {
      counters: Record<string, number>;
    };
    expect(health.counters['installsSeen']).toBe(0);
    expect(api.log.info).toHaveBeenCalledWith('dep-guard: teardown complete', expect.any(Object));
  });
});

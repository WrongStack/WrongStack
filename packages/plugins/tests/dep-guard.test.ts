import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const depGuardPlugin = (await import('../src/dep-guard/index.js')).default;
const { parseInstallCommands, isTreeInstallCommand, editDistance, typosquatOf } = await import(
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

function getHook(
  api: MockApi,
): (input: unknown, runtime?: { signal: AbortSignal; deadlineAt: number }) => Promise<HookResult> {
  const call = api.registerHook.mock.calls[0];
  if (!call) throw new Error('hook not registered');
  return (call as unknown[])[2] as ReturnType<typeof getHook>;
}

/**
 * The registry check is on by default. Tests never reach the network: this
 * stub answers every registry as an established package with no advisories,
 * so the offline-check expectations below are unaffected. Registry tests
 * install their own stub.
 */
function registryStub(
  answer: (url: string) => { status: number; body?: unknown } = (url) =>
    url.includes('osv.dev')
      ? { status: 200, body: { vulns: [] } }
      : {
          status: 200,
          body: { time: { created: '2015-01-01T00:00:00Z' }, 'dist-tags': { latest: '1.0.0' } },
        },
) {
  return vi.fn(async (url: string | URL, _init?: RequestInit) => {
    const { status, body } = answer(String(url));
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', registryStub());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('registry check (hallucinated / just-published / vulnerable packages)', () => {
  const DAY = 86_400_000;
  async function runInstall(command: string, extensions: Record<string, unknown> = {}) {
    const api = makeApi({ extensions: { 'dep-guard': extensions } });
    depGuardPlugin.setup(api as never);
    return getHook(api)({ toolName: 'bash', toolInput: { command } });
  }

  it('refuses a package first published days ago (block mode)', async () => {
    const created = new Date(Date.now() - 2 * DAY).toISOString();
    vi.stubGlobal(
      'fetch',
      registryStub((url) =>
        url.includes('osv.dev')
          ? { status: 200, body: { vulns: [] } }
          : { status: 200, body: { time: { created }, 'dist-tags': { latest: '0.0.1' } } },
      ),
    );
    const out = await runInstall('pnpm add react-query-utilz');
    expect(out?.decision).toBe('block');
    expect(out?.reason).toMatch(/first published 2 day\(s\) ago/);
    expect(out?.reason).toMatch(/allow/);
  });

  it.each([35 * DAY, 2 ** 32])(
    'still refuses a just-published package with registryTimeoutMs=%d',
    async (registryTimeoutMs) => {
      // Past 2^31-1 ms AbortSignal.timeout fires after ~1 ms (every lookup
      // "unchecked", the install let through); 2^32 threw ERR_OUT_OF_RANGE.
      const created = new Date(Date.now() - 2 * DAY).toISOString();
      const respond = registryStub(() => ({
        status: 200,
        body: { time: { created }, 'dist-tags': { latest: '0.0.1' } },
      }));
      vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        init?.signal?.throwIfAborted();
        return respond(url, init);
      });
      const out = await runInstall('pnpm add react-query-utilz', {
        registryTimeoutMs,
        vulnerabilityCheck: false,
      });
      expect(out?.decision).toBe('block');
      expect(out?.reason).toMatch(/first published 2 day\(s\) ago/);
    },
  );

  it('only warns about a just-published package in warn mode', async () => {
    const created = new Date(Date.now() - DAY).toISOString();
    vi.stubGlobal(
      'fetch',
      registryStub((url) =>
        url.includes('osv.dev')
          ? { status: 200, body: { vulns: [] } }
          : { status: 200, body: { time: { created } } },
      ),
    );
    const out = await runInstall('npm i fresh-pkg', { mode: 'warn' });
    expect(out?.decision).toBe('allow');
    expect(out?.additionalContext).toMatch(/fresh-pkg.*first published/);
  });

  it('flags a name the registry does not know, without blocking', async () => {
    vi.stubGlobal(
      'fetch',
      registryStub(() => ({ status: 404 })),
    );
    const out = await runInstall('pip install reqeusts-oauthlibx');
    expect(out?.decision).toBe('allow');
    expect(out?.additionalContext).toMatch(/no package named "reqeusts-oauthlibx".*hallucinated/);
  });

  it('flags a pinned version with OSV advisories', async () => {
    vi.stubGlobal(
      'fetch',
      registryStub((url) =>
        url.includes('osv.dev')
          ? { status: 200, body: { vulns: [{ id: 'GHSA-p6mc-m468-83gw' }] } }
          : { status: 200, body: { time: { created: '2012-01-01T00:00:00Z' } } },
      ),
    );
    const out = await runInstall('npm i lodash@4.17.15');
    expect(out?.decision).toBe('allow');
    expect(out?.additionalContext).toMatch(
      /lodash@4\.17\.15 has known advisories: GHSA-p6mc-m468-83gw/,
    );
  });

  it('fails open when the registry cannot answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const out = await runInstall('pnpm add zod');
    expect(out?.decision).toBe('allow');
    expect(out?.additionalContext).toMatch(/registry check did not run for: zod \(fetch failed\)/);
  });

  it('does not ask about allow-listed packages or workspace protocols', async () => {
    const fetchSpy = registryStub(() => ({ status: 404 }));
    vi.stubGlobal('fetch', fetchSpy);
    await runInstall('pnpm add internal-lib @me/core@workspace:*', { allow: ['internal-lib'] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('can be switched off', async () => {
    const fetchSpy = registryStub(() => ({ status: 404 }));
    vi.stubGlobal('fetch', fetchSpy);
    const out = await runInstall('npm i whatever', { registryCheck: false });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out?.additionalContext).toMatch(/adds 1 dependency/);
  });
});

describe('install parsing reaches past launchers, grouping and newlines', () => {
  // Probe-verified gap (2026-09-22): the install pattern anchored on
  // `(?:^|[;&|]\s*)`, which knows neither a NEWLINE nor shell grouping, and
  // required the manager to sit AT that boundary. 10 of 16 probed forms parsed
  // to zero packages -- including `sudo npm install x` and any multi-line bash
  // script, which is the ordinary shape for anything with more than one step.
  it.each([
    ['plain', 'npm install evil-pkg'],
    ['after &&', 'cd /tmp && npm i evil-pkg'],
    ['after ;', 'echo hi; npm i evil-pkg'],
    ['pip', 'pip install evil-pkg'],
    // Launchers.
    ['sudo', 'sudo npm install evil-pkg'],
    ['nohup', 'nohup npm install evil-pkg'],
    ['env', 'env npm install evil-pkg'],
    ['timeout with operand', 'timeout 60 npm install evil-pkg'],
    ['nice', 'nice npm install evil-pkg'],
    // Grouping and newlines.
    ['subshell', '(npm install evil-pkg)'],
    ['brace group', '{ npm install evil-pkg; }'],
    ['newline separated', 'cd /tmp\nnpm install evil-pkg'],
    ['multi-line script', '#!/bin/bash\nset -e\ncd /app\nnpm install evil-pkg\n'],
    ['sudo after newline', 'echo start\nsudo npm install evil-pkg'],
    // Path-qualified manager and global installs.
    ['absolute path', '/usr/local/bin/npm install evil-pkg'],
    ['npm -g', 'npm install -g evil-pkg'],
    ['yarn global add', 'yarn global add evil-pkg'],
  ])('extracts the package from %s', (_name, command) => {
    const names = parseInstallCommands(command).flatMap((entry) =>
      entry.packages.map((pkg) => pkg.name),
    );
    expect(names).toContain('evil-pkg');
  });

  // Widening the boundary must not turn a lockfile restore, a script run, or
  // prose about installing into an "adding dependencies" event.
  it.each([
    ['bare install', 'npm install'],
    ['ci', 'npm ci'],
    ['run script', 'npm run build'],
    ['prose', 'echo "run npm install evil-pkg yourself"'],
    ['grep', 'grep -r "npm install" docs/'],
  ])('stays quiet on %s', (_name, command) => {
    const names = parseInstallCommands(command).flatMap((entry) =>
      entry.packages.map((pkg) => pkg.name),
    );
    expect(names).toEqual([]);
  });
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
      // PEP 508 extras are not part of the distribution name: the deny/allow,
      // typosquat, registry and license checks all key on this value.
      { name: 'foo', version: '>=1.0' },
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
      // The audit trigger is dep-guard's grammar too: a named install, or a
      // package-less one (`npm install`) that re-resolves the whole tree.
      expect(isInstallCommand({ toolName: 'bash', toolInput: { command } })).toBe(
        parseInstallCommands(command).length > 0 || isTreeInstallCommand(command),
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

  it('compares against the installing ecosystem and skips known distinct neighbours', async () => {
    // `request` is an npm package; `requests` is the pip anchor.
    expect(typosquatOf('request', 'npm')).toBeNull();
    expect(typosquatOf('request', 'PyPI')).toBe('requests');
    expect(typosquatOf('preact', 'npm')).toBeNull();
    expect(typosquatOf('vuex', 'npm')).toBeNull();
    expect(typosquatOf('raect', 'npm')).toBe('react');
  });
});

describe('dep-guard plugin', () => {
  it('registers dep_guard_status and a PreToolUse hook on every tool', async () => {
    // Every tool, not `bash|exec`: shell-surface plugin tools (workflow
    // recipes, acceptance checks, upgrade sandboxes) run installs too, and a
    // name list would miss the next one (WS-2026-09-26-03).
    const api = makeApi();
    depGuardPlugin.setup(api as never);
    expect(api.tools.register).toHaveBeenCalledTimes(1);
    const [event, matcher] = api.registerHook.mock.calls[0]!;
    expect(event).toBe('PreToolUse');
    expect(matcher).toBe('*');
  });

  it.each([
    ['exec argv', 'exec', { command: 'npm', args: ['install', 'left-pad'] }],
    [
      'workflow command',
      'workspace_recipe_run',
      { command: { program: 'npm', args: ['i', 'left-pad'] } },
    ],
    [
      'nested workflow check',
      'dependency_upgrade_try',
      {
        checks: [
          { program: 'pnpm', args: ['test'] },
          { program: 'pnpm', args: ['add', 'left-pad'] },
        ],
      },
    ],
  ])('blocks a deny-listed install in the %s shape', async (_label, toolName, toolInput) => {
    const api = makeApi({ extensions: { 'dep-guard': { deny: ['left-pad'] } } });
    depGuardPlugin.setup(api as never);
    const result = await getHook(api)({ toolName, toolInput });
    expect(result?.decision).toBe('block');
  });

  it('refuses to certify a call whose command scan was truncated (deny buried past the budget)', async () => {
    const api = makeApi({ extensions: { 'dep-guard': { deny: ['left-pad'] } } });
    depGuardPlugin.setup(api as never);
    const hook = getHook(api);
    // 12 nesting levels > MAX_COMMAND_SCAN_DEPTH (8): the walk stops before
    // reading the install, so only the discarded `truncated` flag knew.
    let buried: Record<string, unknown> = { program: 'npm', args: ['install', 'left-pad'] };
    for (let i = 0; i < 12; i++) buried = { buried };
    const result = await hook({ toolName: 'workspace_recipe_run', toolInput: buried });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('incomplete scan');
  });

  it('warn mode annotates a truncated scan instead of passing it silently', async () => {
    const api = makeApi({ extensions: { 'dep-guard': { deny: ['left-pad'], mode: 'warn' } } });
    depGuardPlugin.setup(api as never);
    const hook = getHook(api);
    let buried: Record<string, unknown> = { program: 'npm', args: ['install', 'left-pad'] };
    for (let i = 0; i < 12; i++) buried = { buried };
    const result = await hook({ toolName: 'workspace_recipe_run', toolInput: buried });
    expect(result?.decision).toBe('allow');
    expect(result?.additionalContext).toContain('TRUNCATED');
  });

  it('ignores tools with no command line at all', async () => {
    const api = makeApi({ extensions: { 'dep-guard': { deny: ['left-pad'] } } });
    depGuardPlugin.setup(api as never);
    const hook = getHook(api);
    expect(await hook({ toolName: 'read', toolInput: { path: 'left-pad.md' } })).toBeUndefined();
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

  it('discards Council advice received after hook cancellation', async () => {
    let resolveCouncil: ((value: unknown) => void) | undefined;
    const council = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCouncil = resolve;
        }),
    );
    const api = makeApi({
      extensions: { 'dep-guard': { confirmTyposquatsWithLlm: true } },
      llm: { complete: vi.fn(), council },
    });
    depGuardPlugin.setup(api as never);
    const abort = new AbortController();
    const pending = getHook(api)(
      { toolName: 'bash', toolInput: { command: 'npm i lodahs' } },
      { signal: abort.signal, deadlineAt: Date.now() + 5000 },
    );
    await vi.waitFor(() => expect(council).toHaveBeenCalledTimes(1));
    expect(council.mock.calls[0]?.[1]).toMatchObject({ signal: expect.any(AbortSignal) });
    abort.abort();
    resolveCouncil?.({ status: 'decided', optionId: 'real', reason: 'late decision' });
    const result = await pending;
    expect(result?.additionalContext).toContain('possible typosquat');
    expect(result?.additionalContext).not.toContain('late decision');
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

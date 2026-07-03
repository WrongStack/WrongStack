import { beforeEach, describe, expect, it, vi } from 'vitest';

const pathGuardPlugin = (await import('../src/path-guard')).default;
const { compilePathGlob, destructiveTargets } = await import('../src/path-guard');

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

type HookResult = { decision?: string; reason?: string; additionalContext?: string } | undefined;

function getHook(api: MockApi): (input: unknown) => HookResult {
  const call = api.registerHook.mock.calls[0];
  if (!call) throw new Error('hook not registered');
  return (call as unknown[])[2] as (input: unknown) => HookResult;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('compilePathGlob', () => {
  it('matches basenames at any depth', () => {
    const re = compilePathGlob('.env');
    expect(re.test('.env')).toBe(true);
    expect(re.test('sub/dir/.env')).toBe(true);
    expect(re.test('.envrc')).toBe(false);
  });

  it('supports * within a segment and ** across segments', () => {
    expect(compilePathGlob('.env.*').test('.env.local')).toBe(true);
    expect(compilePathGlob('**/migrations/**').test('db/migrations/001.sql')).toBe(true);
    expect(compilePathGlob('.git/**').test('.git/HEAD')).toBe(true);
    expect(compilePathGlob('.git/**').test('repo/.git/config')).toBe(true);
  });
});

describe('destructiveTargets', () => {
  it('extracts rm and redirect targets', () => {
    expect(destructiveTargets('rm -rf pnpm-lock.yaml')).toContain('pnpm-lock.yaml');
    expect(destructiveTargets('echo hi > .env')).toContain('.env');
    expect(destructiveTargets('mv .env .env.bak')).toEqual(
      expect.arrayContaining(['.env', '.env.bak']),
    );
  });

  it('ignores non-destructive commands and /dev/null', () => {
    expect(destructiveTargets('cat .env')).toHaveLength(0);
    expect(destructiveTargets('ls -la > /dev/null')).toHaveLength(0);
  });
});

describe('path-guard plugin', () => {
  it('registers a status tool and a PreToolUse hook', () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    expect(api.tools.register).toHaveBeenCalledTimes(1);
    const [event, matcher] = api.registerHook.mock.calls[0]!;
    expect(event).toBe('PreToolUse');
    expect(matcher).toBe('write|edit|bash|exec');
  });

  it('blocks writes to a default-protected lockfile', () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const hook = getHook(api);
    const result = hook({ toolName: 'write', toolInput: { path: 'pnpm-lock.yaml' } });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('pnpm-lock.yaml');
  });

  it('blocks edits to .env at any depth', () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const hook = getHook(api);
    const result = hook({ toolName: 'edit', toolInput: { file_path: 'apps/web/.env' } });
    expect(result?.decision).toBe('block');
  });

  it('blocks destructive bash on protected paths, allows reads', () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const hook = getHook(api);
    expect(hook({ toolName: 'bash', toolInput: { command: 'rm -f .env' } })?.decision).toBe(
      'block',
    );
    expect(hook({ toolName: 'bash', toolInput: { command: 'cat .env' } })).toBeUndefined();
  });

  it('allows writes to unprotected files', () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const hook = getHook(api);
    expect(hook({ toolName: 'write', toolInput: { path: 'src/index.ts' } })).toBeUndefined();
  });

  it('warn mode injects context instead of blocking', () => {
    const api = makeApi({ extensions: { 'path-guard': { mode: 'warn' } } });
    pathGuardPlugin.setup(api as never);
    const hook = getHook(api);
    const result = hook({ toolName: 'write', toolInput: { path: '.env' } });
    expect(result?.decision).toBe('allow');
    expect(result?.additionalContext).toContain('path-guard');
  });

  it('allow globs override protect', () => {
    const api = makeApi({
      extensions: {
        'path-guard': { protect: ['**/migrations/**'], allow: ['**/migrations/dev/**'] },
      },
    });
    pathGuardPlugin.setup(api as never);
    const hook = getHook(api);
    expect(
      hook({ toolName: 'write', toolInput: { path: 'db/migrations/001.sql' } })?.decision,
    ).toBe('block');
    expect(
      hook({ toolName: 'write', toolInput: { path: 'db/migrations/dev/001.sql' } }),
    ).toBeUndefined();
  });

  it('enabled:false disables the guard', () => {
    const api = makeApi({ extensions: { 'path-guard': { enabled: false } } });
    pathGuardPlugin.setup(api as never);
    const hook = getHook(api);
    expect(hook({ toolName: 'write', toolInput: { path: '.env' } })).toBeUndefined();
  });

  it('teardown zeros counters and logs', async () => {
    const api = makeApi();
    pathGuardPlugin.setup(api as never);
    const hook = getHook(api);
    hook({ toolName: 'write', toolInput: { path: '.env' } });
    pathGuardPlugin.teardown!(api as never);
    const health = (await pathGuardPlugin.health!()) as { counters: Record<string, number> };
    expect(health.counters['blocks']).toBe(0);
    expect(api.log.info).toHaveBeenCalledWith('path-guard: teardown complete', expect.any(Object));
  });
});

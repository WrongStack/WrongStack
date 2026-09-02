import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cp = vi.hoisted(() => ({ execFile: vi.fn(), result: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: cp.execFile }));

const execFileSync = cp.result;
const typeGatePlugin = (await import('../src/type-gate')).default;
const { expectedInvocation } = await import('./helpers/exec-invocation.js');

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
        (overrides.enabled === true ? { 'type-gate': { enabled: true } } : {}),
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn() },
    registerHook: vi.fn(() => vi.fn()),
  };
}

type HookResult = { decision?: string; reason?: string; additionalContext?: string } | undefined;

function getHook(api: MockApi): (input: unknown) => Promise<HookResult> {
  const call = api.registerHook.mock.calls[0];
  if (!call) throw new Error('hook not registered');
  return (call as unknown[])[2] as (input: unknown) => HookResult;
}

beforeEach(() => {
  vi.clearAllMocks();
  execFileSync.mockReset();
  execFileSync.mockReturnValue('');
  cp.execFile.mockImplementation(
    (
      bin: string,
      args: string[],
      options: Record<string, unknown>,
      callback: (error: Error | null) => void,
    ) => {
      const childHandlers = new Map<string, (...args: unknown[]) => void>();
      const stdoutHandlers = new Map<string, (chunk: Buffer) => void>();
      const stderrHandlers = new Map<string, (chunk: Buffer) => void>();
      const child = {
        stdout: {
          on: (event: string, handler: (chunk: Buffer) => void) =>
            void stdoutHandlers.set(event, handler),
        },
        stderr: {
          on: (event: string, handler: (chunk: Buffer) => void) =>
            void stderrHandlers.set(event, handler),
        },
        on: (event: string, handler: (...args: unknown[]) => void) => {
          childHandlers.set(event, handler);
          return child;
        },
      };
      queueMicrotask(() => {
        try {
          const output = String(execFileSync(bin, args, options) ?? '');
          if (output) stdoutHandlers.get('data')?.(Buffer.from(output));
          callback(null);
        } catch (error) {
          const e = error as Error & { stdout?: string; stderr?: string; code?: string };
          if (e.stdout) stdoutHandlers.get('data')?.(Buffer.from(e.stdout));
          if (e.stderr) stderrHandlers.get('data')?.(Buffer.from(e.stderr));
          if (e.code && ['ENOENT', 'EPERM', 'EACCES'].includes(e.code)) {
            childHandlers.get('error')?.(e);
          }
          callback(e);
        }
      });
      return child;
    },
  );
});

afterEach(async () => {
  const api = makeApi();
  await typeGatePlugin.teardown?.(api as never);
});

describe('type-gate plugin', () => {
  it('registers type_gate_status and a PostToolUse write|edit hook', async () => {
    const api = makeApi();
    typeGatePlugin.setup(api as never);
    expect(api.tools.register).toHaveBeenCalledTimes(1);
    const [event, matcher] = api.registerHook.mock.calls[0]!;
    expect(event).toBe('PostToolUse');
    expect(matcher).toBe('write|edit');
  });

  it('skips non-source files by extension when enabled', async () => {
    const api = makeApi({ enabled: true });
    typeGatePlugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'write',
      toolInput: { path: 'README.md' },
      toolResult: { content: '', isError: false },
    });
    expect(result).toBeUndefined();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('passes silently when type check has no errors', async () => {
    vi.mocked(execFileSync).mockReturnValue('');
    const api = makeApi({ enabled: true });
    typeGatePlugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'write',
      toolInput: { path: 'src/foo.ts' },
      toolResult: { content: '', isError: false },
    });
    expect(result).toBeUndefined();
    expect(execFileSync).toHaveBeenCalled();
  });

  it('warn severity injects additionalContext on type errors', async () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw Object.assign(new Error('tsc failed'), {
        stdout: 'src/foo.ts(1,1): error TS1234: test error',
      });
    });
    const api = makeApi({ enabled: true });
    typeGatePlugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'write',
      toolInput: { path: 'src/foo.ts' },
      toolResult: { content: '', isError: false },
    });
    expect(result?.additionalContext).toContain('error TS1234');
  });

  it('block severity returns a block decision on type errors', async () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw Object.assign(new Error('tsc failed'), {
        stdout: 'src/foo.ts(1,1): error TS1234: test error',
      });
    });
    const api = makeApi({ extensions: { 'type-gate': { enabled: true, failSeverity: 'block' } } });
    typeGatePlugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'write',
      toolInput: { path: 'src/foo.ts' },
      toolResult: { content: '', isError: false },
    });
    expect(result?.decision).toBe('block');
  });

  it('does not run by default', async () => {
    const api = makeApi();
    typeGatePlugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'write',
      toolInput: { path: 'src/foo.ts' },
      toolResult: { content: '', isError: false },
    });
    expect(result).toBeUndefined();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('enabled:false disables the hook', async () => {
    const api = makeApi({ extensions: { 'type-gate': { enabled: false } } });
    typeGatePlugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({
      toolName: 'write',
      toolInput: { path: 'src/foo.ts' },
      toolResult: { content: '', isError: false },
    });
    expect(result).toBeUndefined();
  });

  it('teardown zeros state and logs', async () => {
    const api = makeApi();
    typeGatePlugin.setup(api as never);
    typeGatePlugin.teardown!(api as never);
    const health = (await typeGatePlugin.health!()) as { counters: Record<string, number> };
    expect(health.counters['runs']).toBe(0);
    expect(api.log.info).toHaveBeenCalledWith('type-gate: teardown complete', expect.any(Object));
  });

  it.each([
    { command: "node -e \"require('child_process').exec('calc.exe')\"" },
    { command: 'tsx ./attacker.ts' },
    { command: 'npx vitest run' },
    { command: 'npx tsc --config=../../evil.tsconfig.json' },
    { command: 'pnpm tsc --project=evil.json' },
    { command: 'yarn tsc --isolatedModules' },
    { command: 'pnpm --filter evil tsc' },
    { command: 'pnpm exec tsc --eval "evil"' },
    { command: 'npx' },
    { command: 'pnpm' },
    { command: 'npm malicious-package' },
    { command: 'yarn' },
    { command: 'bun run tsc' },
    { command: 'pnpm exec tsc --eval "evil"' },
    { command: 'npx exec tsc --print "evil"' },
    { command: 'pnpm tsc --project=../../evil.json' },
  ])('rejects unsafe custom command %#', async ({ command }) => {
    vi.mocked(execFileSync).mockReturnValue('');
    const api = makeApi({
      extensions: { 'type-gate': { enabled: true, command } },
    });
    typeGatePlugin.setup(api as never);
    const hook = getHook(api);
    await hook({
      toolName: 'write',
      toolInput: { path: 'src/foo.ts' },
      toolResult: { content: '', isError: false },
    });
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('passes argv with shell:false for the canonical pnpm exec tsc command', async () => {
    vi.mocked(execFileSync).mockReturnValue('');
    const api = makeApi({
      extensions: { 'type-gate': { enabled: true, command: 'pnpm exec tsc --noEmit --pretty' } },
    });
    typeGatePlugin.setup(api as never);
    const hook = getHook(api);
    await hook({
      toolName: 'write',
      toolInput: { path: 'src/foo.ts' },
      toolResult: { content: '', isError: false },
    });
    // Helper returns the launcher as `cmd` and the runner+flags as `args`
    // for bare-launcher spellings; the plugin concatenates verbatim. On
    // Windows `pnpm` is a .cmd shim, so the invocation is routed through
    // cmd.exe — assert the platform-resolved form, not the raw spelling.
    const pnpmTsc = expectedInvocation('pnpm', ['exec', 'tsc', '--noEmit', '--pretty']);
    expect(execFileSync).toHaveBeenCalledWith(
      pnpmTsc.cmd,
      pnpmTsc.args,
      expect.objectContaining({ shell: false }),
    );
  });

  it.each(['../evil/tsconfig.json', '--config=evil.json', '/etc/passwd'])(
    'rejects unsafe tsConfigPath %#',
    async (tsConfigPath) => {
      vi.mocked(execFileSync).mockReturnValue('');
      const api = makeApi({
        extensions: { 'type-gate': { enabled: true, tsConfigPath } },
      });
      typeGatePlugin.setup(api as never);
      const hook = getHook(api);
      await hook({
        toolName: 'write',
        toolInput: { path: 'src/foo.ts' },
        toolResult: { content: '', isError: false },
      });
      expect(execFileSync).not.toHaveBeenCalled();
    },
  );
});

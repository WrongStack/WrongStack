import type { Tool } from '@wrongstack/contracts/types/tool';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildWindowsAclPlan,
  buildWindowsRoute,
  configureSandboxPolicy,
  createSandboxExecWrapper,
  createWindowsNativeSandboxBackend,
  resetSandboxPolicy,
  resolveSandboxConfig,
  windowsNativeSandboxBackend,
} from '../../src/sandbox/index.js';
import { type SandboxConfig, SandboxDeniedError } from '../../src/sandbox/types.js';

// Re-exported types live here in tests via the barrel; Tool is structural.

afterEach(() => {
  resetSandboxPolicy();
});

function cfg(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
  return resolveSandboxConfig({
    mode: 'enforced',
    tier: 'workspace-write',
    backend: 'windows-native',
    writableRoots: ['D:/ws', 'D:/ext'],
    ...overrides,
  });
}

describe('windows-native ACL plan builder (plan 28 T5, always-run)', () => {
  it('workspace-write emits one icacls grant per writable root + Low-IL dirs', () => {
    const plan = buildWindowsAclPlan(cfg());
    expect(plan.grants).toEqual([
      ['icacls', 'D:/ws', '/grant', 'WrongStackSandbox:(OI)(CI)M'],
      ['icacls', 'D:/ext', '/grant', 'WrongStackSandbox:(OI)(CI)M'],
    ]);
    expect(plan.lowIntegrityDirs).toEqual(['D:/ws', 'D:/ext']);
  });

  it('read-only emits no grants (no writable grant exists anywhere)', () => {
    const plan = buildWindowsAclPlan(cfg({ tier: 'read-only' }));
    expect(plan.grants).toEqual([]);
    expect(plan.lowIntegrityDirs).toEqual([]);
  });
});

describe('windows-native route builder (plan 28 T5, always-run)', () => {
  it('full-access never routes', () => {
    expect(
      buildWindowsRoute(
        { tool: 'bash', kind: 'shell', command: 'x' },
        cfg({ tier: 'full-access' }),
      ),
    ).toBeUndefined();
  });

  it('bash (shell form) routes as a cmd.exe line with cmd double-quote escaping', () => {
    const route = buildWindowsRoute({ tool: 'bash', kind: 'shell', command: 'dir "a b"' }, cfg());
    expect(route).toEqual({ command: 'cmd.exe /d /s /c "dir ""a b"""' });
  });

  it('exec (argv form) routes as cmd argv without a shell join', () => {
    const route = buildWindowsRoute(
      { tool: 'exec', kind: 'argv', command: 'node', argv: ['node', '-e', '1+1'] },
      cfg(),
    );
    expect(route).toEqual({ argv: ['cmd.exe', '/d', '/s', '/c', 'node', '-e', '1+1'] });
  });
});

describe('windows-native enforceExec fail-closed matrix (plan 28 T5)', () => {
  it('denies on non-win32 hosts with an actionable reason', async () => {
    const backend = createWindowsNativeSandboxBackend({ platform: 'linux' });
    const decision = await backend.enforceExec({ tool: 'stub-exec' });
    expect(decision.outcome).toBe('deny');
    if (decision.outcome === 'deny') expect(decision.reason).toContain('requires Windows');
  });

  it('denies on win32 when no helper runner is configured (T5.1 pending)', async () => {
    const backend = createWindowsNativeSandboxBackend({ platform: 'win32' });
    const decision = await backend.enforceExec({ tool: 'stub-exec' });
    expect(decision.outcome).toBe('deny');
    if (decision.outcome === 'deny') expect(decision.reason).toContain('T5.1');
  });

  it('allows when a helper runner is configured, and full-access always allows', async () => {
    const backend = createWindowsNativeSandboxBackend({
      platform: 'win32',
      helperRunner: async () => {},
    });
    await expect(backend.enforceExec({ tool: 'stub-exec' })).resolves.toEqual({ outcome: 'allow' });
    configureSandboxPolicy({ mode: 'enforced', tier: 'full-access', backend: 'windows-native' });
    const linuxBackend = createWindowsNativeSandboxBackend({ platform: 'linux' });
    await expect(linuxBackend.enforceExec({ tool: 'stub-exec' })).resolves.toEqual({
      outcome: 'allow',
    });
  });
});

describe('choke point selects the windows-native backend (plan 28 T5/T5.1)', () => {
  function execStub(): Tool<{ v: number }, { v: number }> {
    return {
      name: 'stub-exec',
      description: 'stub',
      permission: 'confirm',
      mutating: false,
      execute: async (input: { v: number }) => ({ v: input.v }),
    } as unknown as Tool<{ v: number }, { v: number }>;
  }

  it('a windows-native backend WITHOUT a helper still fails closed at the choke point', async () => {
    configureSandboxPolicy({
      mode: 'enforced',
      tier: 'workspace-write',
      backend: 'windows-native',
    });
    const noHelper = createWindowsNativeSandboxBackend({ platform: process.platform });
    const wrapped = createSandboxExecWrapper({ backend: noHelper })(execStub());
    await expect(
      wrapped.execute({ v: 1 }, {} as never, { signal: new AbortController().signal } as never),
    ).rejects.toThrow(SandboxDeniedError);
  });

  it('the production singleton wires the default helper on win32 (T5.1)', async () => {
    configureSandboxPolicy({
      mode: 'enforced',
      tier: 'workspace-write',
      backend: 'windows-native',
    });
    const config = resolveSandboxConfig({
      mode: 'enforced',
      tier: 'workspace-write',
      backend: 'windows-native',
    });
    if (process.platform === 'win32') {
      await expect(
        windowsNativeSandboxBackend.enforceExec({ tool: 'stub-exec', config }),
      ).resolves.toEqual({ outcome: 'allow' });
    } else {
      // enforceExec returns a decision; only the choke point (wrap.ts) throws.
      const decision = await windowsNativeSandboxBackend.enforceExec({ tool: 'stub-exec', config });
      expect(decision.outcome).toBe('deny');
      if (decision.outcome === 'deny') expect(decision.reason).toContain('requires Windows');
    }
  });

  it('an explicit helper-equipped backend executes the call', async () => {
    configureSandboxPolicy({
      mode: 'enforced',
      tier: 'workspace-write',
      backend: 'windows-native',
    });
    const helper = createWindowsNativeSandboxBackend({
      platform: 'win32',
      helperRunner: async () => {},
    });
    const wrapped = createSandboxExecWrapper({ backend: helper })(execStub());
    await expect(
      wrapped.execute({ v: 7 }, {} as never, { signal: new AbortController().signal } as never),
    ).resolves.toEqual({ v: 7 });
  });

  it('rewrites bash input.command when applyHelper returns an argv-based launcher route', async () => {
    configureSandboxPolicy({
      mode: 'enforced',
      tier: 'workspace-write',
      backend: 'windows-native',
      writableRoots: ['D:/ws'],
    });
    let executedCommand = '';
    const bashTool: Tool<{ command: string }, { command: string }> = {
      name: 'bash',
      description: 'bash',
      permission: 'confirm',
      mutating: true,
      execute: async (input: { command: string }) => {
        executedCommand = input.command;
        return { command: input.command };
      },
    } as unknown as Tool<{ command: string }, { command: string }>;

    const helper = createWindowsNativeSandboxBackend({
      platform: 'win32',
      helperRunner: async ({ command: _command, ...route }) => ({
        ...route,
        argv: [
          'powershell.exe',
          '-File',
          'C:\\Program Files\\helper.ps1',
          '-EncodedPayload',
          'abc',
        ],
      }),
    });
    const wrapped = createSandboxExecWrapper({ backend: helper })(bashTool);
    await wrapped.execute(
      { command: 'echo hi' },
      { cwd: 'D:/ws' } as never,
      { signal: new AbortController().signal } as never,
    );
    expect(executedCommand).toBe(
      'powershell.exe -File "C:\\Program Files\\helper.ps1" -EncodedPayload abc',
    );
  });
});

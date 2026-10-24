// Tool re-exported through the sandbox barrel? It is not — pull from types.
import type { Tool as CoreTool } from '@wrongstack/contracts/types/tool';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildContainerRoute,
  configureSandboxPolicy,
  containerSandboxBackend,
  createSandboxBrowserTierGate,
  getResolvedSandboxConfig,
  resetContainerRunnerCache,
  resetSandboxPolicy,
} from '../../src/sandbox/index.js';
import type { SandboxRouteRequest } from '../../src/sandbox/types.js';
import { SandboxDeniedError } from '../../src/sandbox/types.js';

// Plan 28 T4 — container backend argv builder (pure, no Docker required) and
// the browser_*-disabled tier gate. Runner-dependent paths are covered by the
// WRONGSTACK_SANDBOX_INTEGRATION=1-gated suite in packages/tools/tests.

afterEach(() => {
  resetSandboxPolicy();
  resetContainerRunnerCache();
});

function request(over: Partial<SandboxRouteRequest> = {}): SandboxRouteRequest {
  return {
    tool: 'exec',
    kind: 'argv',
    command: 'echo',
    argv: ['echo', 'hi'],
    cwd: 'D:/work/proj',
    ...over,
  };
}

function routeNow(): ReturnType<typeof buildContainerRoute> {
  return buildContainerRoute(request(), getResolvedSandboxConfig());
}

describe('buildContainerRoute (plan 28 T4)', () => {
  it('returns undefined for full-access — no containment intended', () => {
    configureSandboxPolicy({
      mode: 'enforced',
      tier: 'full-access',
      backend: 'container',
      image: 'alpine:3.19',
    });
    expect(routeNow()).toBeUndefined();
  });

  it('returns undefined without an image; enforceExec denies fail-closed with a reason', async () => {
    configureSandboxPolicy({ mode: 'enforced', tier: 'workspace-write', backend: 'container' });
    expect(routeNow()).toBeUndefined();
    const decision = await containerSandboxBackend.enforceExec({ tool: 'exec' });
    expect(decision.outcome).toBe('deny');
    if (decision.outcome === 'deny') {
      expect(decision.reason).toContain('image');
    }
  });

  it('builds the workspace-write docker argv: same-path mounts, deny-by-default network', () => {
    configureSandboxPolicy({
      mode: 'enforced',
      tier: 'workspace-write',
      backend: 'container',
      image: 'alpine:3.19',
      writableRoots: ['D:/work/extra'],
    });
    const route = routeNow();
    if (process.platform === 'win32') {
      // Windows host + Linux container: fixed container-side mounts (/w0, /w1),
      // double-quoted because the route line runs through cmd.exe.
      expect(route?.argv?.slice(0, 11)).toEqual([
        'docker',
        'run',
        '--rm',
        '--network',
        'none',
        '-v',
        '"D:/work/proj:/w0"',
        '-v',
        '"D:/work/extra:/w1"',
        '-w',
        '"/w0"',
      ]);
    } else {
      expect(route?.argv?.slice(0, 11)).toEqual([
        'docker',
        'run',
        '--rm',
        '--network',
        'none',
        '-v',
        "'D:/work/proj:D:/work/proj'",
        '-v',
        "'D:/work/extra:D:/work/extra'",
        '-w',
        "'D:/work/proj'",
      ]);
    }
    expect(route?.argv?.slice(11, 13)).toEqual(['alpine:3.19', 'echo']);
    expect(route?.argv?.at(-1)).toBe('hi');
  });

  it('mounts everything read-only in the read-only tier and drops writableRoots', () => {
    configureSandboxPolicy({
      mode: 'enforced',
      tier: 'read-only',
      backend: 'container',
      image: 'alpine:3.19',
      writableRoots: ['D:/work/extra'],
    });
    const route = routeNow();
    const joined = route?.argv?.join(' ') ?? '';
    expect(joined).toContain(
      process.platform === 'win32' ? '"D:/work/proj:/w0:ro"' : "'D:/work/proj:D:/work/proj:ro'",
    );
    expect(joined).not.toContain('D:/work/extra');
    expect(joined).toContain('--network none');
  });

  it('wraps shell-form (bash) commands with sh -lc and shell-appropriate quoting', () => {
    configureSandboxPolicy({
      mode: 'enforced',
      tier: 'workspace-write',
      backend: 'container',
      image: 'alpine:3.19',
    });
    const route = buildContainerRoute(
      { tool: 'bash', kind: 'shell', command: "echo 'hi' > f", cwd: 'D:/work/proj' },
      getResolvedSandboxConfig(),
    );
    expect(route?.command).toContain(
      process.platform === 'win32'
        ? '-w "/w0" alpine:3.19 sh -lc "echo'
        : "-w 'D:/work/proj' alpine:3.19 sh -lc 'echo",
    );
    expect(route?.command).toContain(process.platform === 'win32' ? '> f"' : "> f'");
  });

  it('doubles embedded double quotes in the cmd.exe-quoted inner command (win32 boundary)', () => {
    configureSandboxPolicy({
      mode: 'enforced',
      tier: 'workspace-write',
      backend: 'container',
      image: 'alpine:3.19',
    });
    const route = buildContainerRoute(
      { tool: 'bash', kind: 'shell', command: 'echo "a b" > f', cwd: 'D:/work/proj' },
      getResolvedSandboxConfig(),
    );
    // quoteToken doubles embedded quotes so cmd.exe cannot terminate the
    // quoted region early; sh inside the container then sees the original
    // text. POSIX keeps the single-quoted form unchanged.
    expect(route?.command).toContain(
      process.platform === 'win32' ? 'sh -lc "echo ""a b"" > f"' : 'sh -lc \'echo "a b" > f\'',
    );
  });
});

describe('browser_*-disabled tier gate (plan 28 T4)', () => {
  function browserStub(): CoreTool<{ q: string }, { ok: boolean }> {
    return {
      name: 'browser_navigate',
      description: 'stub',
      permission: 'confirm',
      mutating: true,
      execute: async () => ({ ok: true }),
    } as unknown as CoreTool<{ q: string }, { ok: boolean }>;
  }

  function run(tool: CoreTool<{ q: string }, { ok: boolean }>): Promise<{ ok: boolean }> {
    return tool.execute(
      { q: 'x' },
      undefined as never,
      {
        signal: new AbortController().signal,
      } as never,
    ) as Promise<{ ok: boolean }>;
  }

  it('passes browser tools through under policy-only', () => {
    configureSandboxPolicy({ mode: 'enforced', tier: 'workspace-write', backend: 'policy-only' });
    const result = run(createSandboxBrowserTierGate()(browserStub()));
    return expect(result).resolves.toEqual({ ok: true });
  });

  it('denies browser tools with sandbox_denied under enforced container tier', async () => {
    configureSandboxPolicy({
      mode: 'enforced',
      tier: 'workspace-write',
      backend: 'container',
      image: 'alpine:3.19',
    });
    await expect(run(createSandboxBrowserTierGate()(browserStub()))).rejects.toThrow(
      SandboxDeniedError,
    );
  });

  it('re-enables browser tools when the tier is switched off at runtime', async () => {
    configureSandboxPolicy({
      mode: 'enforced',
      tier: 'workspace-write',
      backend: 'container',
      image: 'alpine:3.19',
    });
    resetSandboxPolicy();
    await expect(run(createSandboxBrowserTierGate()(browserStub()))).resolves.toEqual({ ok: true });
  });
});

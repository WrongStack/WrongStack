import type { Tool } from '@wrongstack/contracts/types/tool';
import { afterEach, describe, expect, it } from 'vitest';
import { runShellHookDetailed } from '../../src/hooks/shell-executor.js';
import {
  clearSandboxAgentOverrides,
  forgetSandboxAgentOverride,
  getSandboxAgentOverride,
  sandboxTierForAgent,
  setSandboxAgentOverride,
} from '../../src/sandbox/agent-overrides.js';
import { requestSandboxExpansion } from '../../src/sandbox/audit.js';
import {
  buildContainerRoute,
  buildWindowsAclPlan,
  configureSandboxPolicy,
  createSandboxExecWrapper,
  getResolvedSandboxConfig,
  resetSandboxPolicy,
  setSandboxExpansionApprover,
} from '../../src/sandbox/index.js';
import {
  DEFAULT_SANDBOX_CONFIG,
  type SandboxBackend,
  SandboxDeniedError,
  type SandboxExecCall,
  type SandboxRouteRequest,
} from '../../src/sandbox/types.js';

interface EchoInput {
  v: number;
}
interface EchoOutput {
  v: number;
}

function echoTool(calls: EchoInput[]): Tool<EchoInput, EchoOutput> {
  return {
    name: 'stub-exec',
    description: 'stub',
    permission: 'confirm',
    mutating: false,
    execute: async (input: EchoInput) => {
      calls.push(input);
      return { v: input.v };
    },
  } as unknown as Tool<EchoInput, EchoOutput>;
}

const denyBackend: SandboxBackend = {
  id: 'policy-only',
  enforceExec: async () => ({ outcome: 'deny', reason: 'unit-test deny', missing: [] }),
};

afterEach(() => {
  resetSandboxPolicy();
});

describe('sandbox config resolution (T1)', () => {
  it('resolves defaults when unconfigured', () => {
    expect(getResolvedSandboxConfig()).toEqual({
      mode: 'off',
      tier: 'read-only',
      writableRoots: [],
      backend: 'policy-only',
    });
    expect(DEFAULT_SANDBOX_CONFIG.mode).toBe('off');
  });

  it('merges a partial config over the defaults', () => {
    configureSandboxPolicy({ mode: 'enforced', tier: 'workspace-write' });
    expect(getResolvedSandboxConfig()).toEqual({
      mode: 'enforced',
      tier: 'workspace-write',
      writableRoots: [],
      backend: 'policy-only',
    });
  });

  it('rejects invalid enum values', () => {
    configureSandboxPolicy({ tier: 'yolo-tier' } as never);
    expect(() => getResolvedSandboxConfig()).toThrow(TypeError);
    configureSandboxPolicy({ backend: 'docker' } as never);
    expect(() => getResolvedSandboxConfig()).toThrow(TypeError);
  });

  it('rejects non-string writableRoots', () => {
    configureSandboxPolicy({ writableRoots: [1] } as never);
    expect(() => getResolvedSandboxConfig()).toThrow(TypeError);
  });
});

describe('sandbox choke point (T2, policy-only backend)', () => {
  it('mode off (default) passes the call through untouched', async () => {
    const calls: EchoInput[] = [];
    const tool = echoTool(calls);
    const wrapped = createSandboxExecWrapper()(tool);
    const out = await wrapped.execute({ v: 7 }, undefined as never, {
      signal: new AbortController().signal,
    });
    expect(out).toEqual({ v: 7 });
    expect(calls).toEqual([{ v: 7 }]);
    expect(getResolvedSandboxConfig().mode).toBe('off');
  });

  it('enforced + policy-only backend also passes through (never denies)', async () => {
    configureSandboxPolicy({ mode: 'enforced', tier: 'workspace-write' });
    const calls: EchoInput[] = [];
    const tool = echoTool(calls);
    const wrapped = createSandboxExecWrapper()(tool);
    const out = await wrapped.execute({ v: 3 }, undefined as never, {
      signal: new AbortController().signal,
    });
    expect(out).toEqual({ v: 3 });
    expect(calls).toEqual([{ v: 3 }]);
  });

  it('a denying backend throws SandboxDeniedError and never reaches the tool', async () => {
    configureSandboxPolicy({ mode: 'enforced', tier: 'workspace-write' });
    const calls: EchoInput[] = [];
    const tool = echoTool(calls);
    const wrapped = createSandboxExecWrapper({ backend: denyBackend })(tool);
    await expect(
      wrapped.execute({ v: 1 }, undefined as never, { signal: new AbortController().signal }),
    ).rejects.toThrow(SandboxDeniedError);
    expect(calls).toEqual([]);
  });

  it('resetSandboxPolicy returns to mode off after enforcement', async () => {
    configureSandboxPolicy({ mode: 'enforced', tier: 'workspace-write' });
    resetSandboxPolicy();
    const calls: EchoInput[] = [];
    const wrapped = createSandboxExecWrapper({ backend: denyBackend })(echoTool(calls));
    const out = await wrapped.execute({ v: 9 }, undefined as never, {
      signal: new AbortController().signal,
    });
    expect(out).toEqual({ v: 9 });
    expect(calls).toEqual([{ v: 9 }]);
  });

  it('SandboxDeniedError carries tool + structured decision', () => {
    const err = new SandboxDeniedError('exec', {
      outcome: 'deny',
      reason: 'outside writable roots',
      missing: [{ type: 'path', value: 'D:/elsewhere' }],
    });
    expect(err.kind).toBe('sandbox_denied');
    expect(err.tool).toBe('exec');
    expect(err.message).toContain('outside writable roots');
    expect(err.decision.missing[0]?.type).toBe('path');
  });

  it('forwards input.cwd > ctx.cwd > ctx.workingDir to routeExec, passes resolved config on deny expansion, and trims/filters blank writableRoots (F92)', async () => {
    try {
      configureSandboxPolicy({
        mode: 'enforced',
        tier: 'workspace-write',
        backend: 'container',
        image: 'alpine:3.20',
        writableRoots: ['/proj/out'],
      });
      const baseTool: Tool<{ command: string; cwd?: string }, string> = {
        name: 'bash',
        description: 'bash',
        permission: 'confirm',
        mutating: true,
        inputSchema: { type: 'object', properties: {} },
        execute: async (input) => `ran:${input.command}`,
      };
      const capturedRequests: SandboxRouteRequest[] = [];
      const customBackend: SandboxBackend = {
        id: 'container',
        enforceExec: async () => ({ outcome: 'allow' }),
        routeExec: (req) => {
          capturedRequests.push(req);
          return { command: `routed:${req.cwd ?? 'NONE'}` };
        },
      };
      const wrapped = createSandboxExecWrapper({ backend: customBackend })(baseTool);
      const options = { signal: new AbortController().signal };
      await wrapped.execute(
        { command: 'ls', cwd: '/explicit/input-cwd' },
        { workingDir: '/ctx/working-dir' } as never,
        options,
      );
      await wrapped.execute(
        { command: 'pwd' },
        { workingDir: '/ctx/working-dir' } as never,
        options,
      );
      expect(capturedRequests[0]?.cwd).toBe('/explicit/input-cwd');
      expect(capturedRequests[1]?.cwd).toBe('/ctx/working-dir');

      let capturedExpansionCall: SandboxExecCall | undefined;
      setSandboxExpansionApprover(async (call) => {
        capturedExpansionCall = call;
        return { granted: true, decidedBy: 'test' };
      });
      const wrappedDeny = createSandboxExecWrapper({ backend: denyBackend })(baseTool);
      await wrappedDeny.execute(
        { command: 'ls' },
        { workingDir: '/ctx/working-dir' } as never,
        options,
      );
      expect(capturedExpansionCall?.config?.tier).toBe('workspace-write');

      const route = buildContainerRoute(
        { tool: 'exec', kind: 'argv', argv: ['ls'], cwd: '/work' },
        {
          mode: 'enforced',
          tier: 'workspace-write',
          backend: 'container',
          image: 'alpine:3.20',
          writableRoots: ['', '   ', ' /work/out '],
        },
      );
      const volumeArgs = (route?.argv ?? []).filter(
        (_, idx, arr) => idx > 0 && arr[idx - 1] === '-v',
      );
      expect(volumeArgs).toHaveLength(2);
      expect(volumeArgs.some((v) => v.includes('/work/out:'))).toBe(true);

      const aclPlan = buildWindowsAclPlan({
        mode: 'enforced',
        tier: 'workspace-write',
        backend: 'windows-native',
        writableRoots: ['', '  ', ' D:\\work '],
      });
      expect(aclPlan.grants).toHaveLength(1);
      expect(aclPlan.lowIntegrityDirs).toEqual(['D:\\work']);
    } finally {
      setSandboxExpansionApprover(undefined);
    }
  });

  it('validates sandboxTierForAgent via resolveSandboxConfigForAgent, trims agentId, rejects malformed expansion approver payloads, and guards NaN hook timeoutMs (F148)', async () => {
    clearSandboxAgentOverrides();
    try {
      setSandboxAgentOverride('agent-bad', { tier: 'bogus-tier' as never });
      expect(() => sandboxTierForAgent('agent-bad')).toThrow(TypeError);

      setSandboxAgentOverride('  agent-ws  ', { tier: 'workspace-write' });
      expect(getSandboxAgentOverride('agent-ws')?.tier).toBe('workspace-write');
      expect(sandboxTierForAgent('agent-ws')).toBe('workspace-write');
      forgetSandboxAgentOverride(' agent-ws ');
      expect(getSandboxAgentOverride('agent-ws')).toBeUndefined();

      setSandboxExpansionApprover(async () => ({ granted: 'yes' as never, decidedBy: '   ' }));
      const denied = await requestSandboxExpansion(
        { tool: 'bash' },
        { outcome: 'deny', reason: 'denied', missing: [] },
      );
      expect(denied).toEqual({ granted: false, decidedBy: 'approver-error:invalid-response' });

      const shellRes = await runShellHookDetailed(
        { command: 'node -e "setTimeout(() => process.exit(0), 20)"', timeoutMs: Number.NaN },
        { event: 'PreToolUse', cwd: process.cwd() } as never,
      );
      expect(shellRes.failure).toBeUndefined();
    } finally {
      clearSandboxAgentOverrides();
      setSandboxExpansionApprover(undefined);
    }
  });
});

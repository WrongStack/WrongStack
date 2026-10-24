import type { Tool } from '@wrongstack/contracts/types/tool';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearSandboxAgentOverrides,
  configureSandboxPolicy,
  containerSandboxBackend,
  createSandboxBrowserTierGate,
  createSandboxExecWrapper,
  forgetSandboxAgentOverride,
  resetSandboxPolicy,
  resolveSandboxConfigForAgent,
  sandboxTierForAgent,
  setSandboxAgentOverride,
} from '../../src/sandbox/index.js';
import { type SandboxBackend, SandboxDeniedError } from '../../src/sandbox/types.js';

// Plan 28 T7 — per-agent sandbox overrides: ctx.agentId-keyed resolution at
// the choke point, AC5 inheritance (no override ⇒ leader tier), and the
// /fleet status tier label.

afterEach(() => {
  resetSandboxPolicy();
  clearSandboxAgentOverrides();
});

const denyBackend: SandboxBackend = {
  id: 'policy-only',
  async enforceExec() {
    return {
      outcome: 'deny',
      reason: 'outside writable roots',
      missing: [{ type: 'path' as const, value: 'D:/x' }],
    };
  },
};

function execStub(): Tool<{ v: number }, { v: number }> {
  return {
    name: 'stub-exec',
    description: 'stub',
    permission: 'confirm',
    mutating: false,
    execute: async (input: { v: number }) => ({ v: input.v }),
  } as unknown as Tool<{ v: number }, { v: number }>;
}

function run(tool: Tool<{ v: number }, { v: number }>, agentId?: string): Promise<{ v: number }> {
  return tool.execute(
    { v: 1 },
    { agentId } as never,
    {
      signal: new AbortController().signal,
    } as never,
  ) as Promise<{ v: number }>;
}

describe('agent sandbox overrides (plan 28 T7)', () => {
  beforeEach(() => {
    configureSandboxPolicy({ mode: 'enforced', tier: 'workspace-write' });
  });

  it('a subagent WITHOUT an override inherits the leader tier (AC5 inheritance)', async () => {
    const resolved = resolveSandboxConfigForAgent('agent-a');
    expect(resolved.tier).toBe('workspace-write');
    await expect(
      run(createSandboxExecWrapper({ backend: denyBackend })(execStub()), 'agent-a'),
    ).rejects.toThrow(SandboxDeniedError);
  });

  it('an override merges over the global policy for that agent only', () => {
    setSandboxAgentOverride('agent-b', { tier: 'full-access' });
    expect(resolveSandboxConfigForAgent('agent-b').tier).toBe('full-access');
    // Inheritance: unspecified fields (mode) still come from the global policy.
    expect(resolveSandboxConfigForAgent('agent-b').mode).toBe('enforced');
    // Siblings without an override keep the leader tier.
    expect(resolveSandboxConfigForAgent('agent-a').tier).toBe('workspace-write');
  });

  it('wrap.ts resolves per ctx.agentId: overridden agent executes, others deny', async () => {
    setSandboxAgentOverride('agent-off', { mode: 'off' });
    const wrapped = createSandboxExecWrapper({ backend: denyBackend })(execStub());
    await expect(run(wrapped, 'agent-plain')).rejects.toThrow(SandboxDeniedError);
    await expect(run(wrapped, 'agent-off')).resolves.toEqual({ v: 1 });
  });

  it('forgetting the override restores the leader tier', () => {
    setSandboxAgentOverride('agent-c', { tier: 'full-access' });
    expect(sandboxTierForAgent('agent-c')).toBe('full-access');
    forgetSandboxAgentOverride('agent-c');
    expect(sandboxTierForAgent('agent-c')).toBe('workspace-write');
  });

  it('sandboxTierForAgent falls back to the global tier without an override', () => {
    expect(sandboxTierForAgent('nobody')).toBe('workspace-write');
    expect(sandboxTierForAgent(undefined)).toBe('workspace-write');
  });

  it('backend gates honor the per-agent config over the global policy (split-brain fix)', async () => {
    // Global policy carries an image; the agent's tightened config does not.
    // The gate must decide on the AGENT config (deny: requires image), not the
    // global one (which would pass the image check) — chimera HIGH, 2026-10-04.
    configureSandboxPolicy({
      mode: 'enforced',
      tier: 'workspace-write',
      backend: 'container',
      image: 'alpine:3.19',
    });
    setSandboxAgentOverride('agent-tight', { writableRoots: ['D:/ws'], image: '' });
    const agentCfg = resolveSandboxConfigForAgent('agent-tight');
    const decision = await containerSandboxBackend.enforceExec({
      tool: 'bash',
      config: { ...agentCfg },
    });
    expect(decision.outcome).toBe('deny');
    if (decision.outcome === 'deny') expect(decision.reason).toContain('image');
  });
});

describe('browser tier gate is agent-aware (plan 28 T7)', () => {
  function browserStub(): Tool<{ q: string }, { ok: boolean }> {
    return {
      name: 'browser_navigate',
      description: 'stub',
      permission: 'confirm',
      mutating: true,
      execute: async () => ({ ok: true }),
    } as unknown as Tool<{ q: string }, { ok: boolean }>;
  }

  function runBrowser(tool: Tool<{ q: string }, { ok: boolean }>, agentId?: string) {
    return tool.execute(
      { q: 'x' },
      { agentId } as never,
      {
        signal: new AbortController().signal,
      } as never,
    ) as Promise<{ ok: boolean }>;
  }

  it('container-tier global policy denies browser tools', async () => {
    configureSandboxPolicy({
      mode: 'enforced',
      tier: 'workspace-write',
      backend: 'container',
      image: 'alpine:3.19',
    });
    const gated = createSandboxBrowserTierGate()(browserStub());
    await expect(runBrowser(gated, 'agent-container')).rejects.toThrow(SandboxDeniedError);
  });

  it('a policy-only backend override re-enables browsers for that agent only', async () => {
    configureSandboxPolicy({
      mode: 'enforced',
      tier: 'workspace-write',
      backend: 'container',
      image: 'alpine:3.19',
    });
    setSandboxAgentOverride('agent-po', { backend: 'policy-only' });
    const gated = createSandboxBrowserTierGate()(browserStub());
    await expect(runBrowser(gated, 'agent-po')).resolves.toEqual({ ok: true });
    // Sibling without the override stays denied under the container tier.
    await expect(runBrowser(gated, 'agent-other')).rejects.toThrow(SandboxDeniedError);
  });
});

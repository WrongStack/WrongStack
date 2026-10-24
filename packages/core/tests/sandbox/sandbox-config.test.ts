import type { Tool } from '@wrongstack/contracts/types/tool';
import { afterEach, describe, expect, it } from 'vitest';
import {
  configureSandboxPolicy,
  createSandboxExecWrapper,
  getResolvedSandboxConfig,
  resetSandboxPolicy,
} from '../../src/sandbox/index.js';
import {
  DEFAULT_SANDBOX_CONFIG,
  type SandboxBackend,
  SandboxDeniedError,
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
});

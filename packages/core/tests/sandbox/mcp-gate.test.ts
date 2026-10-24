import type { Tool } from '@wrongstack/contracts/types/tool';
import { afterEach, describe, expect, it } from 'vitest';
import {
  configureSandboxPolicy,
  createSandboxMcpGate,
  getSandboxAuditLog,
  resetSandboxPolicy,
  SandboxDeniedError,
  setSandboxExpansionApprover,
} from '../../src/sandbox/index.js';

interface EchoInput {
  v?: string;
}
interface EchoOutput {
  echoed: string;
}

function mcpTool(calls: string[]): Tool<EchoInput, EchoOutput> {
  return {
    name: 'mcp__srv__run',
    description: 'stub MCP tool',
    inputSchema: { type: 'object' },
    async execute(input: EchoInput | undefined) {
      calls.push(input?.v ?? '');
      return { echoed: input?.v ?? '' };
    },
  } as unknown as Tool<EchoInput, EchoOutput>;
}

const gate = createSandboxMcpGate();
type ExecCtx = Parameters<Tool<EchoInput, EchoOutput>['execute']>[1];
const ctx = {} as ExecCtx;
const opts = { signal: new AbortController().signal };

afterEach(() => {
  resetSandboxPolicy();
  setSandboxExpansionApprover(undefined);
});

describe('MCP sandbox gate (plan 28 conflict analysis — denied, not routed)', () => {
  it('mode off (default): pure pass-through, identical outcome', async () => {
    const calls: string[] = [];
    const result = await gate(mcpTool(calls)).execute({ v: 'a' }, ctx, opts);
    expect(result).toEqual({ echoed: 'a' });
    expect(calls).toEqual(['a']);
  });

  it('mode enforced: denied with a structured sandbox_denied error + audit record', async () => {
    configureSandboxPolicy({ mode: 'enforced', tier: 'workspace-write', backend: 'policy-only' });
    const calls: string[] = [];
    const err = await gate(mcpTool(calls))
      .execute({ v: 'a' }, ctx, opts)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxDeniedError);
    expect((err as SandboxDeniedError).kind).toBe('sandbox_denied');
    expect((err as SandboxDeniedError).decision.reason).toContain('server process');
    expect(calls).toEqual([]);
    expect(
      getSandboxAuditLog().some((r) => r.kind === 'sandbox.denied' && r.tool === 'mcp__srv__run'),
    ).toBe(true);
  });

  it('mode enforced: T6 one-call expansion elevates when a host approver is registered', async () => {
    configureSandboxPolicy({ mode: 'enforced', tier: 'workspace-write', backend: 'policy-only' });
    setSandboxExpansionApprover(async () => ({ granted: true, decidedBy: 'test' }));
    const calls: string[] = [];
    const result = await gate(mcpTool(calls)).execute({ v: 'elevated' }, ctx, opts);
    expect(result).toEqual({ echoed: 'elevated' });
    expect(calls).toEqual(['elevated']);
    const log = getSandboxAuditLog();
    expect(log.some((r) => r.kind === 'sandbox.expansion_requested')).toBe(true);
    expect(log.some((r) => r.kind === 'sandbox.expansion_outcome')).toBe(true);
  });

  it('mode enforced + trusted: gate is an identity bypass (mcpServers.*.sandboxTrust)', async () => {
    configureSandboxPolicy({ mode: 'enforced', tier: 'workspace-write', backend: 'policy-only' });
    const trustedGate = createSandboxMcpGate({ trusted: true });
    const calls: string[] = [];
    // The audit ring persists across tests — compare denial counts, not truth.
    const denialsBefore = getSandboxAuditLog().filter((r) => r.kind === 'sandbox.denied').length;
    const result = await trustedGate(mcpTool(calls)).execute({ v: 'trusted' }, ctx, opts);
    expect(result).toEqual({ echoed: 'trusted' });
    expect(calls).toEqual(['trusted']);
    expect(getSandboxAuditLog().filter((r) => r.kind === 'sandbox.denied').length).toBe(
      denialsBefore,
    );
  });

  it('mode enforced: a streaming MCP tool is denied before its first event', async () => {
    configureSandboxPolicy({ mode: 'enforced', tier: 'workspace-write', backend: 'policy-only' });
    const streamed: string[] = [];
    const tool = {
      name: 'mcp__srv__stream',
      description: 'stub',
      inputSchema: { type: 'object' },
      async *executeStream() {
        streamed.push('event');
        yield { type: 'final' as const, output: { echoed: 'x' } };
      },
    } as unknown as Tool<EchoInput, EchoOutput>;
    const wrapped = gate(tool);
    let caught: unknown;
    try {
      for await (const _ of wrapped.executeStream!({ v: 'a' }, ctx, opts)) void _;
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SandboxDeniedError);
    expect(streamed).toEqual([]);
  });

  it('trusted: a streaming MCP tool passes through untouched', async () => {
    configureSandboxPolicy({ mode: 'enforced', tier: 'workspace-write', backend: 'policy-only' });
    const streamed: string[] = [];
    const tool = {
      name: 'mcp__srv__stream',
      description: 'stub',
      inputSchema: { type: 'object' },
      async *executeStream() {
        streamed.push('event');
        yield { type: 'final' as const, output: { echoed: 'x' } };
      },
    } as unknown as Tool<EchoInput, EchoOutput>;
    const trustedGate = createSandboxMcpGate({ trusted: true });
    let first: unknown;
    for await (const ev of trustedGate(tool).executeStream!({ v: 'a' }, ctx, opts)) {
      first = ev;
      break;
    }
    expect(streamed).toEqual(['event']);
    expect(first).toBeDefined();
  });

  it('tools without execute pass through unchanged (identity)', () => {
    const bare = {
      name: 'mcp__srv__bare',
      description: 'd',
      inputSchema: { type: 'object' },
    } as unknown as Tool<Record<string, never>, unknown>;
    expect(gate(bare)).toBe(bare);
  });
});

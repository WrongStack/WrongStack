import { EventBus } from '@wrongstack/contracts/kernel/events';
import type { Tool } from '@wrongstack/contracts/types/tool';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearSandboxAuditLog,
  configureSandboxPolicy,
  createSandboxExecWrapper,
  getSandboxAuditLog,
  requestSandboxExpansion,
  resetSandboxPolicy,
  setSandboxAuditEvents,
  setSandboxExpansionApprover,
} from '../../src/sandbox/index.js';
import { type SandboxBackend, SandboxDeniedError } from '../../src/sandbox/types.js';

interface EchoInput {
  v: number;
}
interface EchoOutput {
  v: number;
}

const denyBackend: SandboxBackend = {
  id: 'policy-only',
  async enforceExec() {
    return {
      outcome: 'deny',
      reason: 'outside writable roots',
      missing: [{ type: 'path', value: 'D:/elsewhere' }],
    };
  },
};

function echoTool(): Tool<EchoInput, EchoOutput> {
  return {
    name: 'stub-exec',
    description: 'stub',
    permission: 'confirm',
    mutating: false,
    execute: async (input: EchoInput) => ({ v: input.v }),
  } as unknown as Tool<EchoInput, EchoOutput>;
}

afterEach(() => {
  resetSandboxPolicy();
  setSandboxAuditEvents(undefined);
  setSandboxExpansionApprover(undefined);
  clearSandboxAuditLog();
});

describe('sandbox audit events (plan 28 T3)', () => {
  it('denial emits sandbox.denied on the bus and records to the audit log', async () => {
    const bus = new EventBus();
    const seen: Array<{ tool: string; tier: string; reason: string }> = [];
    bus.on('sandbox.denied', (p) => seen.push(p));
    setSandboxAuditEvents(bus);
    configureSandboxPolicy({ mode: 'enforced', tier: 'workspace-write' });
    await expect(
      createSandboxExecWrapper({ backend: denyBackend })(echoTool()).execute(
        { v: 1 },
        undefined as never,
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow(SandboxDeniedError);
    expect(seen.length).toBe(1);
    expect(seen[0]?.tool).toBe('stub-exec');
    expect(seen[0]?.tier).toBe('workspace-write');
    expect(seen[0]?.reason).toContain('writable roots');
    const log = getSandboxAuditLog();
    expect(log.length).toBe(1);
    expect(log[0]?.kind).toBe('sandbox.denied');
  });

  it('requestSandboxExpansion auto-denies without an approver and emits requested+outcome', async () => {
    const bus = new EventBus();
    const names: string[] = [];
    bus.onPattern('sandbox.*', (name) => names.push(name));
    setSandboxAuditEvents(bus);
    const result = await requestSandboxExpansion(
      { tool: 'exec' },
      {
        outcome: 'deny',
        reason: 'outside writable roots',
        missing: [{ type: 'path', value: 'D:/x' }],
      },
    );
    expect(result.granted).toBe(false);
    expect(result.decidedBy).toBe('auto:no-approver');
    expect(names).toEqual(['sandbox.expansion_requested', 'sandbox.expansion_outcome']);
    expect(getSandboxAuditLog().map((r) => r.kind)).toEqual([
      'sandbox.expansion_requested',
      'sandbox.expansion_outcome',
    ]);
  });

  it('a registered approver can grant; the outcome event carries the decision', async () => {
    const bus = new EventBus();
    const outcomes: Array<{ granted: boolean; tool: string }> = [];
    bus.on('sandbox.expansion_outcome', (p) => outcomes.push(p));
    setSandboxAuditEvents(bus);
    setSandboxExpansionApprover(async () => ({ granted: true, decidedBy: 'unit-test' }));
    const result = await requestSandboxExpansion(
      { tool: 'bash' },
      {
        outcome: 'deny',
        reason: 'network egress',
        missing: [{ type: 'network', value: 'example.com' }],
      },
    );
    expect(result).toEqual({ granted: true, decidedBy: 'unit-test' });
    expect(outcomes.length).toBe(1);
    expect(outcomes[0]?.granted).toBe(true);
    expect(outcomes[0]?.tool).toBe('bash');
  });

  it('a throwing approver fails closed with an approver-error marker', async () => {
    setSandboxExpansionApprover(async () => {
      throw new Error('boom');
    });
    const result = await requestSandboxExpansion(
      { tool: 'exec' },
      { outcome: 'deny', reason: 'x', missing: [] },
    );
    expect(result.granted).toBe(false);
    expect(result.decidedBy).toContain('approver-error');
  });

  it('audit works without a wired bus (ring buffer only, fail-open)', async () => {
    setSandboxAuditEvents(undefined);
    await requestSandboxExpansion({ tool: 'exec' }, { outcome: 'deny', reason: 'x', missing: [] });
    expect(getSandboxAuditLog().length).toBe(2);
  });
});

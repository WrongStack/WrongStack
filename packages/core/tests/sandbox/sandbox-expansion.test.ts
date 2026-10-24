import type { Tool } from '@wrongstack/contracts/types/tool';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearSandboxAuditLog,
  configureSandboxPolicy,
  createPolicySandboxApprover,
  createSandboxExecWrapper,
  getSandboxAuditLog,
  resetSandboxPolicy,
  setSandboxExpansionApprover,
} from '../../src/sandbox/index.js';
import { type SandboxBackend, SandboxDeniedError } from '../../src/sandbox/types.js';

// Plan 28 T6 — expansion-request flow: deny → (approver) → one-call elevation
// or SandboxDeniedError; request + outcome mirrored into the session journal.

afterEach(() => {
  resetSandboxPolicy();
  setSandboxExpansionApprover(undefined);
  clearSandboxAuditLog();
});

// The expansion flow lives past the choke point's mode gate — enforce first.
beforeEach(() => {
  configureSandboxPolicy({ mode: 'enforced', tier: 'workspace-write' });
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

function echoTool(): Tool<{ v: number }, { v: number }> {
  return {
    name: 'stub-exec',
    description: 'stub',
    permission: 'confirm',
    mutating: false,
    execute: async (input: { v: number }) => ({ v: input.v }),
  } as unknown as Tool<{ v: number }, { v: number }>;
}

function run(tool: Tool<{ v: number }, { v: number }>, ctx?: unknown): Promise<{ v: number }> {
  return tool.execute(
    { v: 1 },
    ctx as never,
    { signal: new AbortController().signal } as never,
  ) as Promise<{ v: number }>;
}

describe('sandbox expansion flow (plan 28 T6)', () => {
  it('auto-denies without a registered approver and emits no expansion events', async () => {
    await expect(
      run(createSandboxExecWrapper({ backend: denyBackend })(echoTool())),
    ).rejects.toThrow(SandboxDeniedError);
    expect(getSandboxAuditLog().some((r) => r.kind === 'sandbox.expansion_requested')).toBe(false);
  });

  it('elevates exactly once when the approver grants', async () => {
    setSandboxExpansionApprover(async () => ({ granted: true, decidedBy: 'test' }));
    const result = await run(createSandboxExecWrapper({ backend: denyBackend })(echoTool()));
    expect(result).toEqual({ v: 1 });
    const kinds = getSandboxAuditLog().map((r) => r.kind);
    expect(kinds).toContain('sandbox.expansion_requested');
    expect(kinds).toContain('sandbox.expansion_outcome');
  });

  it('throws when the approver denies, with the outcome recorded', async () => {
    setSandboxExpansionApprover(async () => ({ granted: false, decidedBy: 'test-deny' }));
    await expect(
      run(createSandboxExecWrapper({ backend: denyBackend })(echoTool())),
    ).rejects.toThrow(SandboxDeniedError);
    const outcome = getSandboxAuditLog().find((r) => r.kind === 'sandbox.expansion_outcome');
    expect(outcome?.detail).toMatchObject({ granted: false, decidedBy: 'test-deny' });
  });

  it('mirrors request + outcome into the session journal when one is wired', async () => {
    const appended: unknown[] = [];
    setSandboxExpansionApprover(async () => ({ granted: false, decidedBy: 'test-deny' }));
    await expect(
      run(createSandboxExecWrapper({ backend: denyBackend })(echoTool()), {
        session: {
          append: async (event: unknown) => {
            appended.push(event);
          },
        },
      }),
    ).rejects.toThrow(SandboxDeniedError);
    const journal = appended.filter((e) => (e as { type?: string }).type === 'sandbox_audit');
    expect(journal.length).toBeGreaterThanOrEqual(2);
    expect(
      journal.some((e) => (e as { event?: string }).event === 'sandbox.expansion_requested'),
    ).toBe(true);
    expect(
      journal.some((e) => (e as { event?: string }).event === 'sandbox.expansion_outcome'),
    ).toBe(true);
  });
});

function streamTool(): Tool<{ v: number }, { v: number }> {
  return {
    name: 'stub-stream',
    description: 'stub',
    permission: 'confirm',
    mutating: false,
    execute: async (input: { v: number }) => ({ v: input.v }),
    executeStream: async function* (input: { v: number }) {
      yield { type: 'log', text: 'start' };
      yield { type: 'final', output: { v: input.v } };
    },
  } as unknown as Tool<{ v: number }, { v: number }>;
}

async function drain(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const event of gen) out.push(event);
  return out;
}

describe('sandbox streaming enforcement (plan 28 — choke point covers executeStream)', () => {
  it('passes the stream through untouched while mode is off', async () => {
    resetSandboxPolicy(); // file-level beforeEach enforces; this test pins the off-mode delta
    const events = await drain(
      createSandboxExecWrapper({ backend: denyBackend })(streamTool()).executeStream?.(
        { v: 7 },
        undefined as never,
        { signal: new AbortController().signal } as never,
      ) as AsyncGenerator<unknown>,
    );
    expect(events.length).toBe(2);
  });

  it('throws before the first event under a denying backend, without an approver', async () => {
    configureSandboxPolicy({ mode: 'enforced', tier: 'workspace-write' });
    const gen = createSandboxExecWrapper({ backend: denyBackend })(streamTool()).executeStream?.(
      { v: 7 },
      undefined as never,
      { signal: new AbortController().signal } as never,
    ) as AsyncGenerator<unknown>;
    await expect(gen.next()).rejects.toThrow(SandboxDeniedError);
  });

  it('elevates and streams through when the approver grants', async () => {
    configureSandboxPolicy({ mode: 'enforced', tier: 'workspace-write' });
    setSandboxExpansionApprover(async () => ({ granted: true, decidedBy: 'test' }));
    const events = await drain(
      createSandboxExecWrapper({ backend: denyBackend })(streamTool()).executeStream?.(
        { v: 7 },
        undefined as never,
        { signal: new AbortController().signal } as never,
      ) as AsyncGenerator<unknown>,
    );
    expect(events.length).toBe(2);
    expect(getSandboxAuditLog().some((r) => r.kind === 'sandbox.expansion_outcome')).toBe(true);
  });

  it('denies a stream-only tool before its first event', async () => {
    let ran = false;
    const tool = {
      name: 'exec',
      description: 'stub',
      permission: 'confirm',
      mutating: false,
      inputSchema: { type: 'object' },
      async *executeStream() {
        ran = true;
        yield { type: 'final' as const, output: { v: 1 } };
      },
    } as unknown as Tool<{ v: number }, { v: number }>;
    const gen = createSandboxExecWrapper({ backend: denyBackend })(tool).executeStream?.(
      { v: 1 },
      undefined as never,
      { signal: new AbortController().signal } as never,
    ) as AsyncGenerator<unknown>;
    await expect(gen.next()).rejects.toThrow(SandboxDeniedError);
    expect(ran).toBe(false);
  });
});

describe('createPolicySandboxApprover (plan 28 T6)', () => {
  it('grants only on an explicit allow verdict', async () => {
    const allow = createPolicySandboxApprover({
      evaluate: async () => ({ permission: 'allow' }),
    });
    await expect(
      allow({ tool: 'exec' }, { outcome: 'deny', reason: 'r', missing: [] }),
    ).resolves.toMatchObject({ granted: true, decidedBy: 'policy:allow' });

    const confirm = createPolicySandboxApprover({
      evaluate: async () => ({ permission: 'confirm' }),
    });
    await expect(
      confirm({ tool: 'exec' }, { outcome: 'deny', reason: 'r', missing: [] }),
    ).resolves.toMatchObject({ granted: false });
  });

  it('fails closed when the policy throws', async () => {
    const approver = createPolicySandboxApprover({
      evaluate: async () => {
        throw new Error('headless');
      },
    });
    const result = await approver({ tool: 'exec' }, { outcome: 'deny', reason: 'r', missing: [] });
    expect(result.granted).toBe(false);
    expect(result.decidedBy).toContain('approver-error');
  });

  it('judges the sandbox-expansion pseudo-tool through the standard path', async () => {
    const seen: unknown[] = [];
    const approver = createPolicySandboxApprover({
      evaluate: async (tool: unknown) => {
        seen.push(tool);
        return { permission: 'deny' };
      },
    });
    await approver({ tool: 'bash' }, { outcome: 'deny', reason: 'r', missing: [] });
    expect((seen[0] as { name?: string }).name).toBe('sandbox-expansion');
  });
});

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Tool } from '@wrongstack/contracts/types';
import type { PermissionTrace } from '@wrongstack/contracts/types/permission';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '../../src/core/context.js';
import { ToolExecutor } from '../../src/execution/tool-executor.js';
import { withExecutorGate } from '../../src/security/permission-explain.js';
import { DefaultPermissionPolicy } from '../../src/security/permission-policy.js';

/**
 * "Always allow" at a confirm prompt must stick, also for tools with a
 * dangerous capability. The executor turned every trust `auto` for bash,
 * write or edit back into a confirm while YOLO was off, so the user was asked
 * again on the very next identical call.
 */

function ctx(): Context {
  return {
    messages: [],
    todos: [],
    readFiles: new Set(),
    fileMtimes: new Map(),
    systemPrompt: [],
    provider: { id: 'test', capabilities: {}, complete: vi.fn(), stream: vi.fn() } as never,
    session: { id: 'grant-session', append: vi.fn(), close: vi.fn() } as never,
    signal: new AbortController().signal,
    tokenCounter: {
      account: vi.fn(),
      total: vi.fn().mockReturnValue({ input: 0, output: 0 }),
      estimateCost: vi.fn().mockReturnValue({ total: 0 }),
    } as never,
    cwd: '/test',
    projectRoot: '/test',
    model: 'm',
    tools: [],
    meta: {},
    registerAbortHook: vi.fn().mockReturnValue(() => {}),
    drainAbortHooks: vi.fn(),
    recordRead: vi.fn(),
    hasRead: vi.fn(),
    lastReadMtime: vi.fn(),
    usage: vi.fn().mockReturnValue({ input: 0, output: 0 }),
    agentId: undefined,
    traceId: undefined,
    contextEvidence: undefined,
    state: undefined as never,
  } as never as Context;
}

describe('approvals given at a confirm prompt', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'approval-grant-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function setup(answer: string, trust?: unknown, shape: Partial<Tool> = {}) {
    // Shaped like the real bash tool, destructive tier included.
    const bash = {
      name: 'bash',
      description: 'bash',
      inputSchema: { type: 'object' },
      permission: 'confirm',
      mutating: true,
      riskTier: 'destructive',
      capabilities: ['shell.arbitrary'],
      subjectKey: 'command',
      execute: vi.fn(async () => 'ok'),
      ...shape,
    } as unknown as Tool;
    const trustFile = path.join(dir, 'trust.json');
    const ready =
      trust === undefined ? Promise.resolve() : fs.writeFile(trustFile, JSON.stringify(trust));
    const confirmAwaiter = vi.fn(async () => answer);
    const executor = new ToolExecutor(
      { get: () => bash, list: () => [bash] } as never,
      {
        permissionPolicy: new DefaultPermissionPolicy({ trustFile }),
        secretScrubber: { scrub: (s: string) => s } as never,
        perIterationOutputCapBytes: 50_000,
        confirmAwaiter,
      } as never,
    );
    let n = 0;
    const run = async (command: string) => {
      await ready;
      await executor.executeBatch(
        [{ type: 'tool_use', id: `u${++n}`, name: 'bash', input: { command } }],
        ctx(),
        'sequential',
      );
    };
    return { run, confirmAwaiter, bash };
  }

  for (const answer of ['always-exact', 'always-command', 'always-tool']) {
    it(`does not ask again after "${answer}"`, async () => {
      const { run, confirmAwaiter, bash } = setup(answer);
      await run('pnpm test');
      await run('pnpm test');
      expect(confirmAwaiter).toHaveBeenCalledTimes(1);
      expect(bash.execute).toHaveBeenCalledTimes(2);
    });
  }

  it('still asks for a destructive call under a broad "this tool" approval', async () => {
    const { run, confirmAwaiter } = setup('always-tool');
    await run('pnpm test');
    // git-history is a destructive kind; a broad approval never covers one.
    await run('git push --force origin main');
    expect(confirmAwaiter).toHaveBeenCalledTimes(2);
  });

  it('judges a shell per command, but keeps the tier of a tool it cannot judge', async () => {
    // "[t] tool, any input" on a destructive-tier tool without a per-call
    // classifier (a package installer) still asks every time.
    const { run, confirmAwaiter } = setup('always-tool', undefined, {
      name: 'installer',
      capabilities: ['package.install'],
    });
    await run('left-pad');
    await run('left-pad');
    expect(confirmAwaiter).toHaveBeenCalledTimes(2);
  });

  it('asks once when the policy itself prompted (the REPL wires both prompts)', async () => {
    const bash = {
      name: 'bash',
      description: 'bash',
      inputSchema: { type: 'object' },
      permission: 'confirm',
      mutating: true,
      riskTier: 'destructive',
      capabilities: ['shell.arbitrary'],
      subjectKey: 'command',
      execute: vi.fn(async () => 'ok'),
    } as unknown as Tool;
    const promptDelegate = vi.fn(async () => 'yes' as const);
    const confirmAwaiter = vi.fn(async () => 'yes');
    const executor = new ToolExecutor(
      { get: () => bash, list: () => [bash] } as never,
      {
        permissionPolicy: new DefaultPermissionPolicy({
          trustFile: path.join(dir, 'trust.json'),
          promptDelegate,
        }),
        secretScrubber: { scrub: (s: string) => s } as never,
        perIterationOutputCapBytes: 50_000,
        confirmAwaiter,
      } as never,
    );
    await executor.executeBatch(
      [{ type: 'tool_use', id: 'u1', name: 'bash', input: { command: 'pnpm test' } }],
      ctx(),
      'sequential',
    );
    expect(promptDelegate).toHaveBeenCalledTimes(1);
    expect(confirmAwaiter).not.toHaveBeenCalled();
    expect(bash.execute).toHaveBeenCalledTimes(1);
  });

  it('still asks when only a hand-written trust pattern allows the call', async () => {
    const { run, confirmAwaiter } = setup('yes', { bash: { allow: ['pnpm *'] } });
    await run('pnpm test');
    expect(confirmAwaiter).toHaveBeenCalledTimes(1);
  });
});

describe('withExecutorGate', () => {
  const bash = { name: 'bash', capabilities: ['shell.arbitrary'] } as unknown as Tool;
  const trace = (decision: PermissionTrace['decision']): PermissionTrace => ({
    toolName: 'bash',
    subject: 'pnpm test',
    steps: [{ rule: 'trust allow', matched: true, decision: 'auto', source: 'trust', detail: '' }],
    winnerIndex: 0,
    decision,
  });

  it('adds the confirmation the executor will ask for', () => {
    const gated = withExecutorGate(trace({ permission: 'auto', source: 'trust' }), bash, false);
    expect(gated.decision.permission).toBe('confirm');
    expect(gated.steps[gated.winnerIndex]).toMatchObject({
      rule: 'dangerous capability',
      source: 'executor',
    });
  });

  it('leaves a grant the user made, YOLO and harmless tools alone', () => {
    const approved = trace({ permission: 'auto', source: 'trust', approvalGrant: true });
    expect(withExecutorGate(approved, bash, false)).toBe(approved);
    const plain = trace({ permission: 'auto', source: 'trust' });
    expect(withExecutorGate(plain, bash, true)).toBe(plain);
    expect(
      withExecutorGate(plain, { name: 'read', capabilities: ['fs.read'] } as never, false),
    ).toBe(plain);
  });
});

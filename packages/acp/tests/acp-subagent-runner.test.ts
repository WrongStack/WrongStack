/**
 * Tests for the rewritten ACPSubagentRunner.
 *
 * Strategy: vi.mock the ACPSession class so the runner's behavior
 * (input shape → ACPSession.start / prompt call → output) is the
 * unit under test, with no child processes involved.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SubagentError, SubagentRunContext, TaskSpec } from '@wrongstack/core/types';

interface MockSession {
  prompt: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  getAgentInfo: ReturnType<typeof vi.fn>;
}

const hoisted = vi.hoisted(() => ({
  startCalls: [] as Array<{
    command: string;
    args?: readonly string[];
    env?: Record<string, string>;
    cwd?: string;
    projectRoot: string;
    timeoutMs: number;
  }>,
  session: undefined as MockSession | undefined,
  errorKind: undefined as undefined | string,
  errorMessage: undefined as undefined | string,
  startError: undefined as unknown,
  closeError: undefined as unknown,
  agentInfo: undefined as { name: string; title?: string; version: string } | undefined,
  progressEvent: undefined as unknown,
  promptResult: undefined as
    | {
        text: string;
        stopReason: string;
        hasText: boolean;
        toolCalls: unknown[];
        diffs: unknown[];
        thoughts: string;
        plan?: unknown[];
        usage?: { used: number; size: number };
      }
    | undefined,
  promptError: undefined as unknown,
}));

vi.mock('../src/client/acp-session.js', () => {
  class ACPSessionError extends Error {
    readonly kind: string;
    constructor(kind: string, message: string) {
      super(message);
      this.name = 'ACPSessionError';
      this.kind = kind;
    }
  }
  class ACPSession {
    prompt = vi.fn(
      async (_content: unknown, _signal: AbortSignal, onProgress?: (event: unknown) => void) => {
        if (hoisted.progressEvent !== undefined) onProgress?.(hoisted.progressEvent);
        if (hoisted.promptError) throw hoisted.promptError;
        return hoisted.promptResult;
      },
    );
    close = vi.fn(async () => {
      if (hoisted.closeError !== undefined) throw hoisted.closeError;
    });
    getAgentInfo = vi.fn(() => hoisted.agentInfo);
    static start = vi.fn(
      async (opts: {
        command: string;
        args?: readonly string[];
        env?: Record<string, string>;
        cwd?: string;
        projectRoot: string;
        timeoutMs: number;
      }) => {
        hoisted.startCalls.push({
          command: opts.command,
          ...(opts.args !== undefined ? { args: opts.args } : {}),
          ...(opts.env !== undefined ? { env: opts.env } : {}),
          ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
          projectRoot: opts.projectRoot,
          timeoutMs: opts.timeoutMs,
        });
        if (hoisted.errorKind) {
          throw new ACPSessionError(hoisted.errorKind, hoisted.errorMessage ?? 'mock error');
        }
        if (hoisted.startError !== undefined) throw hoisted.startError;
        const session = new ACPSession();
        hoisted.session = session;
        return session;
      },
    );
  }
  return { ACPSession, ACPSessionError, textContent: (t: string) => ({ type: 'text', text: t }) };
});

import {
  ACP_AGENT_COMMANDS,
  describeAgent,
  makeACPSubagentRunner,
  makeACPSubagentRunnerWithStop,
  probeAcpAgent,
  probeAcpAgents,
  REGISTRY_ID_ALIASES,
  resolveAcpAgentCommand,
} from '../src/integration/acp-subagent-runner.js';
import { ACPSessionError } from '../src/client/acp-session.js';
import { runOneAcpTask } from '../src/integration/run-one-acp-task.js';
import { findAgentDescriptor } from '../src/registry/agents.catalog.js';

const TASK: TaskSpec = { id: 't1', description: 'do the thing' };

function makeCtx(timeoutMs?: number): { ctx: SubagentRunContext; controller: AbortController } {
  const controller = new AbortController();
  const ctx = {
    subagentId: 'sub-1',
    config: {
      id: 'sub-1',
      name: 'sub-1',
      role: 'sub-1',
      provider: 'acp',
      prompt: '',
    },
    signal: controller.signal,
    budget: {
      limits: { timeoutMs },
      markActivity: () => {},
    },
    bridge: null,
  } as never as SubagentRunContext;
  return { ctx, controller };
}

beforeEach(() => {
  hoisted.startCalls.length = 0;
  hoisted.session = undefined;
  hoisted.errorKind = undefined;
  hoisted.errorMessage = undefined;
  hoisted.startError = undefined;
  hoisted.closeError = undefined;
  hoisted.agentInfo = undefined;
  hoisted.progressEvent = undefined;
  hoisted.promptError = undefined;
  hoisted.promptResult = {
    text: 'ok',
    stopReason: 'end_turn',
    hasText: true,
    toolCalls: [],
    diffs: [],
    thoughts: '',
  };
});

describe('describeAgent', () => {
  it('returns the command for a known agent', () => {
    const cmd = describeAgent('cline');
    expect(cmd).not.toBeNull();
    expect(cmd?.command).toBe('npx');
    expect(cmd?.role).toBe('cline');
  });

  it('returns null for an unknown agent', () => {
    expect(describeAgent('not-a-real-agent')).toBeNull();
  });

  it('uses empty args and the id as role when legacy metadata omits them', () => {
    ACP_AGENT_COMMANDS.minimal = { command: 'minimal' };
    try {
      expect(describeAgent('minimal')).toEqual({
        command: 'minimal',
        args: [],
        role: 'minimal',
      });
    } finally {
      delete ACP_AGENT_COMMANDS.minimal;
    }
  });
});

describe('ACP_AGENT_COMMANDS', () => {
  it('maps known roles to spawn options', () => {
    expect(ACP_AGENT_COMMANDS.cline).toMatchObject({ command: 'npx', role: 'cline' });
    expect(ACP_AGENT_COMMANDS['gemini-cli']).toMatchObject({ command: 'gemini' });
    expect(ACP_AGENT_COMMANDS.copilot).toMatchObject({ command: 'gh', args: ['copilot', 'agent'] });
    expect(Object.keys(ACP_AGENT_COMMANDS)).toEqual(
      expect.arrayContaining(['cline', 'gemini-cli', 'copilot', 'openhands', 'goose']),
    );
  });
});

describe('makeACPSubagentRunner', () => {
  it('forwards only the defined options to ACPSession.start', async () => {
    const runner = await makeACPSubagentRunner({ command: 'gemini' });
    await runner(TASK, makeCtx(5000).ctx);
    expect(hoisted.startCalls).toHaveLength(1);
    expect(hoisted.startCalls[0]).toMatchObject({
      command: 'gemini',
      projectRoot: process.cwd(),
      timeoutMs: 5 * 60_000,
    });
    expect(hoisted.startCalls[0]?.args).toBeUndefined();

    hoisted.startCalls.length = 0;
    const runner2 = await makeACPSubagentRunner({
      command: 'npx',
      args: ['-y', 'x'],
      env: { FOO: 'bar' },
      cwd: '/tmp/proj',
      projectRoot: '/tmp/proj',
    });
    await runner2(TASK, makeCtx(5000).ctx);
    expect(hoisted.startCalls[0]).toMatchObject({
      command: 'npx',
      args: ['-y', 'x'],
      env: { FOO: 'bar' },
      cwd: '/tmp/proj',
      projectRoot: '/tmp/proj',
    });
  });

  it('runs a task and returns the prompt result text', async () => {
    hoisted.promptResult = {
      text: 'hello world',
      stopReason: 'end_turn',
      hasText: true,
      toolCalls: [],
      diffs: [],
      thoughts: '',
    };
    const runner = await makeACPSubagentRunner({ command: 'gemini' });
    const result = await runner(TASK, makeCtx(5000).ctx);
    expect(result.result).toBe('hello world');
    expect(result.iterations).toBe(1);
    expect(result.toolCalls).toBe(0);
    // session was closed in the finally block
    expect(hoisted.session?.close).toHaveBeenCalled();
  });

  it('reports the real tool-call count captured from the stream', async () => {
    hoisted.promptResult = {
      text: 'done',
      stopReason: 'end_turn',
      hasText: true,
      toolCalls: [
        { toolCallId: 'a', title: 'read x', status: 'completed' },
        { toolCallId: 'b', title: 'edit y', status: 'completed' },
      ],
      diffs: [],
      thoughts: '',
    };
    const runner = await makeACPSubagentRunner({ command: 'gemini' });
    const result = await runner(TASK, makeCtx(5000).ctx);
    expect(result.toolCalls).toBe(2);
  });

  it('throws SubagentError when ACPSession.start fails with spawn_failed', async () => {
    hoisted.errorKind = 'spawn_failed';
    hoisted.errorMessage = 'spawn failed';
    const runner = await makeACPSubagentRunner({ command: 'gemini' });
    let caught: unknown;
    try {
      await runner(TASK, makeCtx(5000).ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const subagentError = caught as SubagentError;
    expect(subagentError.kind).toBe('bridge_failed');
    expect(subagentError.message).toContain('spawn failed');
    expect(subagentError.retryable).toBe(false);
  });

  it('throws SubagentError when the prompt is aborted (kind=aborted → aborted_by_parent)', async () => {
    // Make the session's prompt throw a real ACPSessionError(aborted).
    hoisted.promptError = new ACPSessionError('aborted', 'aborted by parent');
    hoisted.errorKind = undefined;
    const runner = await makeACPSubagentRunner({ command: 'gemini' });
    let caught: unknown;
    try {
      await runner(TASK, makeCtx(5000).ctx);
    } catch (err) {
      caught = err;
    }
    const subagentError = caught as SubagentError;
    expect(subagentError.kind).toBe('aborted_by_parent');
  });

  it('maps prompt_failed to tool_failed', async () => {
    hoisted.promptError = new ACPSessionError('prompt_failed', 'oops');
    hoisted.errorKind = undefined;
    const runner = await makeACPSubagentRunner({ command: 'gemini' });
    let caught: unknown;
    try {
      await runner(TASK, makeCtx(5000).ctx);
    } catch (err) {
      caught = err;
    }
    const subagentError = caught as SubagentError;
    expect(subagentError.kind).toBe('tool_failed');
  });
});

describe('makeACPSubagentRunnerWithStop', () => {
  it('returns a stop() that is a no-op (sessions are per-call)', async () => {
    const { runner, stop } = await makeACPSubagentRunnerWithStop({ command: 'gemini' });
    expect(typeof stop).toBe('function');
    // Running the task completes normally
    const result = await runner(TASK, makeCtx(5000).ctx);
    expect(result.result).toBe('ok');
    // stop() doesn't throw
    expect(() => stop()).not.toThrow();
  });

  it('respects the explicit timeoutMs option', async () => {
    const { runner } = await makeACPSubagentRunnerWithStop({
      command: 'gemini',
      timeoutMs: 12_345,
    });
    await runner(TASK, makeCtx(5000).ctx);
    expect(hoisted.startCalls[0]?.timeoutMs).toBe(12_345);
  });

  it('forwards permission, MCP, progress, and activity updates', async () => {
    const onProgress = vi.fn();
    const permissionPolicy = vi.fn();
    const mcpServers = [{ name: 'tools', command: 'server', args: [] }];
    hoisted.progressEvent = { kind: 'text', text: 'working' };
    const { ctx } = makeCtx();
    const markActivity = vi.fn();
    (ctx.budget as { markActivity: () => void }).markActivity = markActivity;
    const { runner } = await makeACPSubagentRunnerWithStop({
      command: 'agent',
      role: 'worker',
      permissionPolicy: permissionPolicy as never,
      mcpServers,
      onProgress,
    });

    await runner(TASK, ctx);
    expect(markActivity).toHaveBeenCalledOnce();
    expect(onProgress).toHaveBeenCalledWith(hoisted.progressEvent);
    expect(hoisted.startCalls).toHaveLength(1);
  });

  it('guards activity and one-shot close failures', async () => {
    hoisted.progressEvent = { kind: 'tool' };
    hoisted.closeError = new Error('close failed');
    const { ctx } = makeCtx();
    (ctx.budget as { markActivity: () => void }).markActivity = () => {
      throw new Error('budget disposed');
    };
    const { runner } = await makeACPSubagentRunnerWithStop({ command: 'agent' });
    await expect(runner(TASK, ctx)).resolves.toMatchObject({ result: 'ok' });
  });

  it('reuses and explicitly closes a persistent session', async () => {
    const { runner, stop } = await makeACPSubagentRunnerWithStop({
      command: 'agent',
      cwd: '/workspace',
      persistent: true,
    });
    await runner(TASK, makeCtx().ctx);
    const first = hoisted.session;
    await runner(TASK, makeCtx().ctx);
    expect(hoisted.startCalls).toHaveLength(1);
    expect(first?.close).not.toHaveBeenCalled();
    await stop();
    expect(first?.close).toHaveBeenCalledOnce();
    await stop();
  });

  it('tolerates close failure when stopping a persistent session', async () => {
    const { runner, stop } = await makeACPSubagentRunnerWithStop({
      command: 'agent',
      persistent: true,
    });
    await runner(TASK, makeCtx().ctx);
    hoisted.closeError = new Error('close failed');
    await expect(stop()).resolves.toBeUndefined();
  });

  it('maps arbitrary start and prompt failures with the fallback role', async () => {
    hoisted.startError = 'start exploded';
    const first = await makeACPSubagentRunnerWithStop({ command: 'agent' });
    await expect(first.runner(TASK, makeCtx().ctx)).rejects.toMatchObject({
      kind: 'bridge_failed',
      message: 'acp-subagent: start exploded',
      cause: { name: 'Error' },
    });

    hoisted.startError = undefined;
    hoisted.promptError = new Error('prompt exploded');
    const second = await makeACPSubagentRunnerWithStop({ command: 'agent', role: 'custom' });
    await expect(second.runner(TASK, makeCtx().ctx)).rejects.toMatchObject({
      kind: 'bridge_failed',
      message: 'custom: prompt exploded',
    });
  });

  it.each([
    ['init_failed', 'bridge_failed'],
    ['session_create_failed', 'bridge_failed'],
    ['agent_died', 'bridge_failed'],
    ['protocol_error', 'bridge_failed'],
    ['auth_failed', 'bridge_failed'],
    ['logout_failed', 'bridge_failed'],
    ['closed', 'unknown'],
    ['unsupported_capability', 'unknown'],
  ])('maps ACP error %s to %s', async (kind, expected) => {
    const error = new ACPSessionError(kind as never, 'failed');
    if (kind === 'closed') delete error.stack;
    hoisted.promptError = error;
    const { runner } = await makeACPSubagentRunnerWithStop({ command: 'agent' });
    await expect(runner(TASK, makeCtx().ctx)).rejects.toMatchObject({
      kind: expected,
      retryable: false,
    });
  });
});

describe('runOneAcpTask', () => {
  it('runs a single task and returns the result', async () => {
    hoisted.promptResult = {
      text: 'task done',
      stopReason: 'end_turn',
      hasText: true,
      toolCalls: [{ toolCallId: 'a', title: 'read', status: 'completed' }],
      diffs: [],
      thoughts: '',
    };
    hoisted.errorKind = undefined;
    const result = await runOneAcpTask({ command: 'gemini', task: 'do something' });
    expect(result.result).toBe('task done');
    expect(result.iterations).toBe(1);
    expect(result.toolCalls).toBe(1);
  });

  it('throws SubagentError when the session fails to start', async () => {
    hoisted.errorKind = 'spawn_failed';
    hoisted.errorMessage = 'ENOENT';
    await expect(runOneAcpTask({ command: 'missing', task: 'x' })).rejects.toThrow();
  });
});

describe('resolveAcpAgentCommand — Kimi', () => {
  it('resolves the kimi catalog entry to kimi acp', () => {
    const resolved = resolveAcpAgentCommand('kimi');
    expect(resolved).not.toBeNull();
    expect(resolved!.command).toBe('kimi');
    expect(resolved!.args).toEqual(['acp']);
    expect(resolved!.role).toBe('kimi');
  });

  it('returns null for an unknown agent id', () => {
    expect(resolveAcpAgentCommand('not-a-real-agent')).toBeNull();
    expect(resolveAcpAgentCommand('not-a-real-agent', undefined, {})).toBeNull();
  });

  it('applies valid user overrides including optional env', () => {
    expect(
      resolveAcpAgentCommand('custom', {
        custom: { command: 'custom-bin', env: { TOKEN: 'x' } },
      }),
    ).toEqual({
      command: 'custom-bin',
      args: [],
      env: { TOKEN: 'x' },
      role: 'custom',
    });
    expect(resolveAcpAgentCommand('plain', { plain: { command: 'plain-bin' } })).toMatchObject({
      command: 'plain-bin',
      args: [],
    });
  });

  it('ignores an invalid override and uses the catalog', () => {
    expect(resolveAcpAgentCommand('kimi', { kimi: { command: '', args: ['bad'] } })).toMatchObject({
      command: 'kimi',
    });
  });

  it('copies catalog env when present', () => {
    const descriptor = findAgentDescriptor('kimi')!;
    descriptor.acp.env = { CATALOG: 'yes' };
    try {
      expect(resolveAcpAgentCommand('kimi')?.env).toEqual({ CATALOG: 'yes' });
    } finally {
      delete descriptor.acp.env;
    }
  });

  it('uses empty args when catalog metadata omits them', () => {
    const descriptor = findAgentDescriptor('kimi')!;
    const args = descriptor.acp.args;
    delete descriptor.acp.args;
    try {
      expect(resolveAcpAgentCommand('kimi')?.args).toEqual([]);
    } finally {
      if (args === undefined) delete descriptor.acp.args;
      else descriptor.acp.args = args;
    }
  });

  it('resolves direct and aliased live entries with optional fields', () => {
    expect(
      resolveAcpAgentCommand('registry-only', undefined, {
        'registry-only': { command: 'live', env: { LIVE: 'yes' } },
      }),
    ).toEqual({
      command: 'live',
      args: [],
      env: { LIVE: 'yes' },
      role: 'registry-only',
    });
    const aliases = REGISTRY_ID_ALIASES as Record<string, string>;
    aliases['alias-only'] = 'live-alias';
    try {
      expect(
        resolveAcpAgentCommand('alias-only', undefined, {
          'live-alias': { command: 'live-aliased', args: ['acp'] },
        }),
      ).toMatchObject({ command: 'live-aliased', args: ['acp'] });
    } finally {
      delete aliases['alias-only'];
    }
  });

  it('falls back to the legacy map for a legacy-only id', () => {
    ACP_AGENT_COMMANDS.legacy = { command: 'legacy-bin', role: 'legacy' };
    try {
      expect(resolveAcpAgentCommand('legacy')).toBe(ACP_AGENT_COMMANDS.legacy);
    } finally {
      delete ACP_AGENT_COMMANDS.legacy;
    }
  });
});

describe('probeAcpAgent', () => {
  it('reports an unknown string id without starting a session', async () => {
    await expect(probeAcpAgent('missing-agent')).resolves.toEqual({
      id: 'missing-agent',
      ok: false,
      ms: 0,
      error: 'unknown agent',
    });
  });

  it('probes an explicit command and returns agent info', async () => {
    hoisted.agentInfo = { name: 'agent', title: 'Agent', version: '1.0' };
    const result = await probeAcpAgent(
      {
        command: 'agent',
        args: ['--acp'],
        env: { TOKEN: 'x' },
        role: 'role',
      },
      { timeoutMs: 123, projectRoot: '/project' },
    );
    expect(result).toMatchObject({ id: 'role', ok: true, agentInfo: hoisted.agentInfo });
    expect(hoisted.startCalls[0]).toMatchObject({
      args: ['--acp'],
      env: { TOKEN: 'x' },
      projectRoot: '/project',
      timeoutMs: 123,
    });
    expect(hoisted.session?.close).toHaveBeenCalledOnce();
  });

  it('uses command/default options and omits absent agent info', async () => {
    const result = await probeAcpAgent({ command: 'agent' });
    expect(result).toMatchObject({ id: 'agent', ok: true });
    expect(result.agentInfo).toBeUndefined();
    expect(hoisted.startCalls[0]).toMatchObject({
      projectRoot: process.cwd(),
      timeoutMs: 8_000,
    });
  });

  it('resolves a known string id', async () => {
    await expect(probeAcpAgent('kimi')).resolves.toMatchObject({ id: 'kimi', ok: true });
  });

  it.each([new Error('start failed'), 'non-error failure'])(
    'returns a probe failure for %s',
    async (failure) => {
      hoisted.startError = failure;
      const result = await probeAcpAgent({ command: 'agent' });
      expect(result).toMatchObject({
        ok: false,
        error: failure instanceof Error ? failure.message : failure,
      });
    },
  );

  it('tolerates a close error after a successful probe', async () => {
    hoisted.closeError = new Error('close failed');
    await expect(probeAcpAgent({ command: 'agent' })).resolves.toMatchObject({ ok: true });
  });
});

describe('probeAcpAgents', () => {
  it('partitions local/package/unknown agents and preserves input order', async () => {
    const progress = vi.fn();
    const signal = new AbortController().signal;
    const results = await probeAcpAgents({
      agentIds: ['local', 'package', 'uv-package', 'unknown'],
      resolveCmd: (id) => {
        if (id === 'unknown') return null;
        if (id === 'package') return { command: 'npx', role: id };
        if (id === 'uv-package') return { command: 'uvx', role: id };
        return { command: 'local-bin', role: id };
      },
      projectRoot: '/project',
      concurrency: 0,
      timeoutMs: 11,
      packageTimeoutMs: 22,
      signal,
      onProgress: progress,
    });
    expect(results.map((result) => result.id)).toEqual([
      'local',
      'package',
      'uv-package',
      'unknown',
    ]);
    expect(results.every((result) => result.ok || result.error === 'unknown agent')).toBe(true);
    expect(progress).toHaveBeenCalledTimes(4);
    expect(hoisted.startCalls.map((call) => call.timeoutMs)).toEqual([11, 22, 22]);
  });

  it('marks work aborted before probing and supports default options', async () => {
    const controller = new AbortController();
    controller.abort();
    const results = await probeAcpAgents({
      agentIds: ['local'],
      resolveCmd: () => ({ command: 'local' }),
      signal: controller.signal,
    });
    expect(results).toEqual([{ id: 'local', ok: false, ms: 0, error: 'aborted' }]);
    expect(hoisted.startCalls).toHaveLength(0);
  });

  it('handles an empty list without invoking the resolver', async () => {
    const resolveCmd = vi.fn(() => null);
    await expect(probeAcpAgents({ agentIds: [], resolveCmd })).resolves.toEqual([]);
    expect(resolveCmd).not.toHaveBeenCalled();
  });

  it('probes with default root and timeout settings', async () => {
    const results = await probeAcpAgents({
      agentIds: ['local'],
      resolveCmd: () => ({ command: 'local' }),
    });
    expect(results[0]).toMatchObject({ id: 'local', ok: true });
    expect(hoisted.startCalls[0]).toMatchObject({
      projectRoot: process.cwd(),
      timeoutMs: 20_000,
    });
  });
});

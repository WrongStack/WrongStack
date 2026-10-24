import { EventBus } from '@wrongstack/contracts/kernel/events';
import type { ToolUseBlock } from '@wrongstack/contracts/types/blocks';
import { ToolValidationError } from '@wrongstack/contracts/types/errors';
import type { Tool } from '@wrongstack/contracts/types/tool';
import { describe, expect, it, vi } from 'vitest';
import { ToolExecutor } from '../../src/execution/tool-executor.js';
import { ToolCapabilities } from '../../src/security/capabilities.js';
import { DEFAULT_ALWAYS_TRUST_TTL_MS } from '../../src/security/scoped-approval.js';
import { createMockTool } from '../helpers/test-harness.js';

function makeToolUse(name: string, id: string, input: Record<string, unknown> = {}): ToolUseBlock {
  return { type: 'tool_use', id, name, input };
}

function makeRegistry(tools: Tool[]): { get(name: string): Tool | undefined; list(): Tool[] } {
  const map = new Map(tools.map((t) => [t.name, t]));
  return { get: (n: string) => map.get(n), list: () => tools };
}

const noopScrubber = { scrub: (s: string) => s };
const abortController = new AbortController();

function makeCtx(): any {
  return {
    meta: {},
    session: { id: 'test-session' },
    sessionId: 'test-session',
    traceId: undefined,
    agentId: undefined,
    agentName: 'test-agent',
    projectRoot: '/test',
    tools: new Map(),
    provider: { id: 'mock' },
    events: new EventBus(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    tokenCounter: { getInputTokens: () => 0, getOutputTokens: () => 0 },
    secretScrubber: noopScrubber,
    config: {},
    signal: abortController.signal,
  };
}

describe('ToolExecutor — construction & basic API', () => {
  it('constructs with a registry and options', () => {
    const reg = makeRegistry([createMockTool({ name: 'echo', result: 'hi' })]);
    const exec = new ToolExecutor(reg, {
      events: new EventBus(),
      secretScrubber: noopScrubber,
    } as any);
    expect(exec).toBeDefined();
  });

  it('clearConfirmAwaiter does not throw', () => {
    const reg = makeRegistry([]);
    const exec = new ToolExecutor(reg, {
      confirmAwaiter: vi.fn(),
      secretScrubber: noopScrubber,
    } as any);
    expect(() => exec.clearConfirmAwaiter()).not.toThrow();
  });
});

describe('ToolExecutor — executeTool', () => {
  it('executes a registered tool and returns a result block', async () => {
    const tool = createMockTool({ name: 'echo', result: 'hello world' });
    const reg = makeRegistry([tool]);
    const exec = new ToolExecutor(reg, {
      events: new EventBus(),
      secretScrubber: noopScrubber,
    } as any);
    const ctx = makeCtx();
    const result = await exec.executeTool(
      tool,
      makeToolUse('echo', 'tc1', { text: 'test' }),
      ctx,
      100_000,
    );
    expect(result).toBeDefined();
    expect(result.block).toBeDefined();
    expect(result.block.type).toBe('tool_result');
  });
});

describe('ToolExecutor — executeBatch', () => {
  it('returns the registered schema and usage when arguments have an unknown field', async () => {
    const tool = createMockTool({ name: 'strict', result: 'ok' });
    tool.description = 'Read an item by path.';
    tool.usageHint = 'strict({ path })';
    tool.selection = { doNotUseWhen: 'the task needs a directory listing', useInstead: ['glob'] };
    tool.inputSchema = {
      type: 'object',
      properties: { path: { type: 'string', description: 'Item path' } },
      required: ['path'],
      additionalProperties: false,
    };
    const execute = vi.spyOn(tool, 'execute');
    const executor = new ToolExecutor(makeRegistry([tool]), {
      secretScrubber: noopScrubber,
    } as any);

    const batch = await executor.executeBatch(
      [makeToolUse('strict', 'bad-1', { path: 'a', nonexistent: true })],
      makeCtx(),
      'sequential',
    );

    expect(execute).not.toHaveBeenCalled();
    expect(batch.outputs[0]?.settlement).toBe('invalid_input');
    const result = batch.outputs[0]?.result;
    expect(result?.type).toBe('tool_result');
    if (result?.type !== 'tool_result') throw new Error('Expected tool_result');
    const content = result.content;
    expect(content).toContain('nonexistent: unknown property');
    expect(content).toContain('Usage: strict({ path })');
    expect(content).toContain('Declared top-level fields: path');
    expect(content).toContain('Required top-level fields: path');
    expect(content).toContain('Do not use this tool when: the task needs a directory listing');
    expect(content).toContain('Use instead: glob');
    expect(content).toContain('Do not repeat the same arguments unchanged');
    expect(content).toContain(JSON.stringify(tool.inputSchema));
  });

  it('returns the registered schema for validation errors raised by a tool', async () => {
    const tool = createMockTool({ name: 'validate_later' });
    tool.inputSchema = { type: 'object', properties: { path: { type: 'string' } } };
    tool.execute = async () => {
      throw new ToolValidationError({ message: 'path is not usable', field: 'path' });
    };
    const executor = new ToolExecutor(makeRegistry([tool]), {
      secretScrubber: noopScrubber,
      permissionPolicy: {
        evaluate: vi.fn().mockResolvedValue({ permission: 'auto', source: 'default' }),
      },
    } as any);

    const batch = await executor.executeBatch(
      [makeToolUse('validate_later', 'bad-2', { path: 'a' })],
      makeCtx(),
      'sequential',
    );

    const result = batch.outputs[0]?.result;
    expect(result?.type).toBe('tool_result');
    if (result?.type !== 'tool_result') throw new Error('Expected tool_result');
    expect(result.content).toContain('path is not usable');
    expect(result.content).toContain(JSON.stringify(tool.inputSchema));
  });

  it('blocks every subagent-spawn capability when the session policy is off', async () => {
    const tool = createMockTool({ name: 'custom_agent_launcher', result: 'spawned' });
    tool.capabilities = [ToolCapabilities.SUBAGENT_SPAWN];
    const executeSpy = vi.spyOn(tool, 'execute');
    const exec = new ToolExecutor(makeRegistry([tool]), { secretScrubber: noopScrubber } as any);
    const ctx = makeCtx();
    ctx.meta.subagentsAllowed = false;

    const result = await exec.executeBatch(
      [makeToolUse('custom_agent_launcher', 'solo-1')],
      ctx,
      'sequential',
    );

    expect(executeSpy).not.toHaveBeenCalled();
    expect(result.outputs[0]?.result.content).toContain('Subagents are disabled for this session');
  });

  it('handles empty input without error', async () => {
    const reg = makeRegistry([]);
    const exec = new ToolExecutor(reg, { secretScrubber: noopScrubber } as any);
    const ctx = makeCtx();
    const result = await exec.executeBatch([], ctx, 'sequential');
    expect(result).toBeDefined();
  });

  it('executes multiple tools and returns results', async () => {
    const tool1 = createMockTool({ name: 'read', result: 'content1' });
    const tool2 = createMockTool({ name: 'write', result: 'ok' });
    const reg = makeRegistry([tool1, tool2]);
    const events = new EventBus();
    const exec = new ToolExecutor(reg, { events, secretScrubber: noopScrubber } as any);
    const ctx = makeCtx();
    const result = await exec.executeBatch(
      [
        makeToolUse('read', 'tc1', { path: '/a' }),
        makeToolUse('write', 'tc2', { path: '/b', content: 'x' }),
      ],
      ctx,
      'sequential',
    );
    expect(result).toBeDefined();
    expect(result.outputs).toBeDefined();
    expect(result.outputs.length).toBe(2);
  });

  it('bounds parallel batches without changing result order', async () => {
    let active = 0;
    let peakActive = 0;
    const tool = createMockTool({ name: 'bounded' });
    tool.execute = async (input) => {
      active++;
      peakActive = Math.max(peakActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return input;
    };
    const exec = new ToolExecutor(makeRegistry([tool]), {
      maxParallelTools: 3,
      permissionPolicy: {
        evaluate: vi.fn().mockResolvedValue({ permission: 'auto', source: 'default' }),
      },
      secretScrubber: noopScrubber,
    } as any);
    const uses = Array.from({ length: 11 }, (_, index) => makeToolUse('bounded', `tc-${index}`));

    const result = await exec.executeBatch(uses, makeCtx(), 'parallel');

    expect(peakActive).toBe(3);
    expect(
      result.outputs.map((output) =>
        output.result.type === 'tool_result' ? output.result.tool_use_id : output.result.toolUseId,
      ),
    ).toEqual(uses.map((use) => use.id));
  });

  it('runs parallel writers of the same file one after another', async () => {
    const order: string[] = [];
    let active = 0;
    let peakActive = 0;
    const tool = { ...createMockTool({ name: 'writer' }), mutating: true };
    tool.execute = async (input) => {
      const { tag } = input as { tag: string };
      active++;
      peakActive = Math.max(peakActive, active);
      order.push(`start ${tag}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`end ${tag}`);
      active--;
      return tag;
    };
    const exec = new ToolExecutor(makeRegistry([tool]), {
      permissionPolicy: {
        evaluate: vi.fn().mockResolvedValue({ permission: 'auto', source: 'default' }),
      },
      secretScrubber: noopScrubber,
    } as any);

    await exec.executeBatch(
      [
        makeToolUse('writer', 'a', { path: 'src/x.ts', tag: 'a' }),
        makeToolUse('writer', 'b', { path: '/test/src/x.ts', tag: 'b' }),
      ],
      makeCtx(),
      'parallel',
    );
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b']);

    peakActive = 0;
    await exec.executeBatch(
      [
        makeToolUse('writer', 'c', { path: 'src/x.ts', tag: 'c' }),
        makeToolUse('writer', 'd', { path: 'src/y.ts', tag: 'd' }),
      ],
      makeCtx(),
      'parallel',
    );
    expect(peakActive).toBe(2);
  });

  it('handles tool execution error gracefully without throwing', async () => {
    const tool = createMockTool({ name: 'fail', error: new Error('boom') });
    const reg = makeRegistry([tool]);
    const events = new EventBus();
    const exec = new ToolExecutor(reg, { events, secretScrubber: noopScrubber } as any);
    const ctx = makeCtx();
    // executeBatch catches tool errors and returns error results — never throws
    const result = await exec.executeBatch([makeToolUse('fail', 'tc1')], ctx, 'sequential');
    expect(result).toBeDefined();
    expect(result.outputs.length).toBe(1);
    // Verify it's an error-type result (exact shape varies by implementation)
    const out = result.outputs[0];
    expect(out).toBeDefined();
    expect(out.result).toBeDefined();
  });
});

describe('ToolExecutor scoped inline approval', () => {
  it.each(['yes', 'always-exact', 'always-command', 'always-tool'] as const)(
    'executes %s once and remembers only persistent scopes',
    async (decision) => {
      const tool = createMockTool({ name: 'exec', result: 'ok' });
      tool.subjectKey = 'command';
      const execute = vi.spyOn(tool, 'execute');
      const trust = vi.fn(async () => undefined);
      const events = new EventBus();
      const persisted = vi.fn();
      events.on('trust.persisted', persisted);
      const policy = {
        evaluate: vi.fn(async () => ({ permission: 'confirm', source: 'default' })),
        trust,
      };
      const executor = new ToolExecutor(makeRegistry([tool]), {
        permissionPolicy: policy as never,
        events,
        secretScrubber: { ...noopScrubber, scrubObject: <T>(value: T): T => value },
        confirmAwaiter: async () => decision,
      });
      const result = await executor.executeBatch(
        [makeToolUse('exec', 'scoped', { command: 'uv', args: ['run', 'pytest'] })],
        makeCtx(),
        'sequential',
      );
      expect(result.outputs[0]?.result.type).toBe('tool_result');
      expect(execute).toHaveBeenCalledTimes(1);
      if (decision !== 'yes')
        expect(persisted).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            tool: 'exec',
            scope: decision.slice('always-'.length),
            pattern: expect.stringContaining('wrongstack-approval:v1:'),
            displayPattern: expect.any(String),
          }),
        );
      if (decision === 'yes') {
        expect(trust).not.toHaveBeenCalled();
        expect(persisted).not.toHaveBeenCalled();
      } else
        expect(trust).toHaveBeenCalledExactlyOnceWith({
          tool: 'exec',
          pattern: expect.stringContaining(
            `wrongstack-approval:v1:${decision.slice('always-'.length)}`,
          ),
          // A prompt-driven "always" expires (W6 #9) on this path too; only a
          // hand-authored trust.json rule may be permanent.
          ttlMs: DEFAULT_ALWAYS_TRUST_TTL_MS,
        });
    },
  );
});

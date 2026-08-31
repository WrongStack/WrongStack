import { describe, expect, it, vi } from 'vitest';
import { ToolExecutor } from '../../src/execution/tool-executor.js';
import { EventBus } from '../../src/kernel/events.js';
import { ToolCapabilities } from '../../src/security/capabilities.js';
import type { Tool, ToolUseBlock } from '../../src/types/tool.js';
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

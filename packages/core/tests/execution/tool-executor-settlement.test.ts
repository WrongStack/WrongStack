/**
 * Every tool call settles with a typed reason — including the ones that never
 * ran. Before, a denied, declined, blocked or aborted call was only a sentence
 * inside an error `tool_result`, indistinguishable from a tool that ran and
 * broke.
 */

import { EventBus } from '@wrongstack/contracts/kernel/events';
import type { ToolUseBlock } from '@wrongstack/contracts/types/blocks';
import type { Tool, ToolSettlement } from '@wrongstack/contracts/types/tool';
import { describe, expect, it, vi } from 'vitest';
import { ToolExecutor } from '../../src/execution/tool-executor.js';
import { HookRegistry } from '../../src/hooks/registry.js';
import { HookRunner } from '../../src/hooks/runner.js';
import { ToolCapabilities } from '../../src/security/capabilities.js';
import { createMockTool } from '../helpers/test-harness.js';

const scrubber = { scrub: (s: string) => s, scrubObject: <T>(v: T): T => v };

function use(name: string, input: Record<string, unknown> = {}): ToolUseBlock {
  return { type: 'tool_use', id: `id-${name}`, name, input };
}

function registry(tools: Tool[]) {
  const map = new Map(tools.map((t) => [t.name, t]));
  return { get: (n: string) => map.get(n), list: () => tools };
}

function ctx(signal = new AbortController().signal): any {
  return {
    meta: {},
    session: { id: 's' },
    projectRoot: '/p',
    cwd: '/p',
    provider: { id: 'mock' },
    events: new EventBus(),
    signal,
  };
}

function allow(permission: 'auto' | 'deny' | 'confirm' = 'auto') {
  return {
    evaluate: vi.fn(async () => ({ permission, source: 'default', reason: 'policy says no' })),
    trust: vi.fn(async () => undefined),
  } as never;
}

async function settle(
  tools: Tool[],
  call: ToolUseBlock,
  opts: Record<string, unknown> = {},
  context = ctx(),
): Promise<ToolSettlement | undefined> {
  const executor = new ToolExecutor(registry(tools), {
    permissionPolicy: allow(),
    secretScrubber: scrubber,
    ...opts,
  } as never);
  const { outputs } = await executor.executeBatch([call], context, 'sequential');
  return outputs[0]?.settlement;
}

describe('ToolExecutor settlement', () => {
  it('unknown_tool for a name nobody registered', async () => {
    expect(await settle([], use('nope'))).toBe('unknown_tool');
  });

  it('invalid_input for arguments that fail the schema', async () => {
    const tool = createMockTool({ name: 'strict' });
    tool.inputSchema = {
      type: 'object',
      properties: { n: { type: 'number' } },
      required: ['n'],
    };
    expect(await settle([tool], use('strict', {}))).toBe('invalid_input');
  });

  it('blocked_by_hook when a PreToolUse hook denies', async () => {
    const hooks = new HookRegistry();
    hooks.registerInProcess('PreToolUse', '*', () => ({ action: 'deny', reason: 'nope' }));
    const tool = createMockTool({ name: 'echo' });
    expect(
      await settle([tool], use('echo'), { hookRunner: new HookRunner({ registry: hooks }) }),
    ).toBe('blocked_by_hook');
  });

  it('denied_by_policy when the permission policy denies', async () => {
    const tool = createMockTool({ name: 'echo' });
    expect(await settle([tool], use('echo'), { permissionPolicy: allow('deny') })).toBe(
      'denied_by_policy',
    );
  });

  it('denied_by_policy when a session lock forbids the capability', async () => {
    const tool = createMockTool({ name: 'spawner' });
    tool.capabilities = [ToolCapabilities.SUBAGENT_SPAWN];
    const context = ctx();
    context.meta.subagentsAllowed = false;
    expect(await settle([tool], use('spawner'), {}, context)).toBe('denied_by_policy');
  });

  it('declined when the confirmation prompt says no, aborted when the run stops there', async () => {
    const tool = createMockTool({ name: 'echo' });
    expect(
      await settle([tool], use('echo'), {
        permissionPolicy: allow('confirm'),
        confirmAwaiter: async () => 'no',
      }),
    ).toBe('declined');
    expect(
      await settle([tool], use('echo'), {
        permissionPolicy: allow('confirm'),
        confirmAwaiter: async () => 'abort',
      }),
    ).toBe('aborted');
  });

  it('failed when the tool throws, aborted when it throws because the run aborted', async () => {
    const broken = createMockTool({ name: 'boom', error: new Error('kaput') });
    expect(await settle([broken], use('boom'))).toBe('failed');

    const controller = new AbortController();
    const aborting = createMockTool({ name: 'slow' });
    aborting.execute = async () => {
      controller.abort();
      throw new Error('aborted mid-flight');
    };
    expect(await settle([aborting], use('slow'), {}, ctx(controller.signal))).toBe('aborted');
  });

  it('leaves a tool that ran cleanly for the consumer to call completed', async () => {
    const tool = createMockTool({ name: 'echo', result: 'hi' });
    expect(await settle([tool], use('echo'))).toBeUndefined();
  });
});

import type { Tool, ToolResultBlock, ToolUseBlock } from '@wrongstack/contracts/types';
import { ToolValidationError } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import { toolErrorResult } from '../../src/execution/tool-error-taxonomy.js';
import { ToolExecutor } from '../../src/execution/tool-executor.js';

const use: ToolUseBlock = { type: 'tool_use', id: 'u1', name: 'probe', input: {} };

describe('tool error content says each thing once', () => {
  it('drops a detail suffix that only restates the message', () => {
    const block = toolErrorResult(use, new Error('tree: cannot list "src": ENOTDIR'));
    expect(block.content).toBe('Error: tree: cannot list "src": ENOTDIR');
  });

  it('keeps a detail that adds information', () => {
    const err = Object.assign(new Error('connect failed'), { code: 'ETIMEDOUT' });
    expect(toolErrorResult(use, err).content).toContain('[ETIMEDOUT]');
  });

  it('never re-shows a session-scrubbed secret through the detail copy', () => {
    const block = toolErrorResult(use, new Error('token tok-session-77 rejected by upstream'), {
      scrubber: (s) => s.replaceAll('tok-session-77', '[REDACTED]'),
    });
    expect(block.content).not.toContain('tok-session-77');
    expect(block.content).toContain('[REDACTED]');
  });
});

describe('the registered contract rides only on shape errors', () => {
  function probeTool(err: Error): Tool {
    return {
      name: 'probe',
      description: 'probe tool',
      usageHint: 'PROBE USAGE HINT',
      permission: 'auto',
      mutating: false,
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      async execute() {
        throw err;
      },
    } as Tool;
  }

  async function run(err: Error): Promise<string> {
    const tool = probeTool(err);
    const executor = new ToolExecutor(
      { get: (n: string) => (n === 'probe' ? tool : undefined), list: () => [tool] } as never,
      {
        permissionPolicy: { evaluate: async () => ({ permission: 'auto', source: 'default' }) },
        confirmAwaiter: async () => 'yes' as const,
        secretScrubber: { scrub: (s: string) => s },
        perIterationOutputCapBytes: 200_000,
        maxToolTimeoutMs: 10_000,
      } as never,
    );
    const ctx = {
      messages: [],
      signal: new AbortController().signal,
      registerAbortHook: () => () => {},
      drainAbortHooks: () => {},
      cwd: process.cwd(),
      projectRoot: process.cwd(),
      meta: {},
      session: { id: 's', append: async () => {}, recordFileChange: () => {} },
    };
    const result = await executor.executeBatch([{ ...use, input: { path: 'x' } }], ctx as never);
    return (result.outputs[0]?.result as ToolResultBlock).content as string;
  }

  it('appends usage to a cross-field validation error', async () => {
    const content = await run(
      new ToolValidationError({ message: 'probe: provide a or b', field: 'a' }),
    );
    expect(content).toContain('Registered usage for "probe"');
  });

  it('omits it for a world-state failure the contract cannot fix', async () => {
    const content = await run(
      new ToolValidationError({
        message: 'probe: path "x" does not exist',
        field: 'path',
        context: { contract: false },
      }),
    );
    expect(content).toContain('does not exist');
    expect(content).not.toContain('Registered usage');
    expect(content).not.toContain('PROBE USAGE HINT');
    // The routing flag itself is not shown to the model.
    expect(content).not.toContain('contract=');
    expect(content).toContain('field=path');
  });
});

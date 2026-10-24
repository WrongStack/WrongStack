import type { Tool, ToolResultBlock, ToolUseBlock } from '@wrongstack/contracts/types';
import type { Context } from '@wrongstack/core/agent';
import { ToolExecutor } from '@wrongstack/core/execution';
import { toolUseTool } from '@wrongstack/tools/tool-use';
import { describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from '../src/anthropic.js';
import { contentFromOpenAI } from '../src/tool-format/from-openai.js';

const envelope = { tool: 'memory_search', input: { query: 'package dependency' } };

async function run(use: ToolUseBlock) {
  const execute = vi.fn(async (_input: Record<string, unknown>) => 'current matches');
  const target: Tool = {
    name: 'memory_search',
    description: '',
    permission: 'auto',
    mutating: false,
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    execute,
  };
  const tools = [toolUseTool, target];
  const executor = new ToolExecutor(
    { get: (name) => tools.find((t) => t.name === name), list: () => tools },
    {
      permissionPolicy: {
        getYolo: () => true,
        evaluate: async () => ({ permission: 'auto', source: 'default' }),
      } as never,
      secretScrubber: { scrub: (s: string) => s } as never,
    },
  );
  const ctx = {
    tools,
    catalogTools: tools,
    meta: {},
    cwd: '/test',
    projectRoot: '/test',
    session: { id: 'test' },
    signal: new AbortController().signal,
  } as unknown as Context;
  const { outputs } = await executor.executeBatch([use], ctx, 'sequential');
  const result = outputs[0]!.result as ToolResultBlock;
  expect(result.type).toBe('tool_result');
  expect(result.is_error, String(result.content)).not.toBe(true);
  expect(execute.mock.calls[0]?.[0]).toEqual(envelope.input);
  return result;
}

describe('tool_use argument envelope (#400)', () => {
  it('preserves the envelope from OpenAI JSON through validation and governed execution', async () => {
    const [use] = contentFromOpenAI({
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call',
            type: 'function',
            function: { name: 'tool_use', arguments: JSON.stringify(envelope) },
          },
        ],
      },
      finish_reason: 'tool_calls',
    });
    await run(use as ToolUseBlock);
  });

  it.each(['start', 'deltas', 'both', 'start-string'] as const)(
    'preserves the envelope in an Anthropic %s payload through governed execution',
    async (placement) => {
      const events = [
        { type: 'message_start', message: { model: 'test', usage: { input_tokens: 1 } } },
        {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'call',
            name: 'tool_use',
            input:
              placement === 'start'
                ? envelope
                : placement === 'start-string'
                  ? JSON.stringify(envelope)
                  : placement === 'both'
                    ? { tool: 'obsolete', input: {} }
                    : {},
          },
        },
        ...(placement === 'deltas' || placement === 'both'
          ? [
              {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'input_json_delta', partial_json: JSON.stringify(envelope) },
              },
            ]
          : []),
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ];
      const sse = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
      const provider = new AnthropicProvider({
        apiKey: 'test',
        fetchImpl: (async () =>
          new Response(sse, { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch,
      });
      const response = await provider.complete(
        {
          model: 'test',
          messages: [{ role: 'user', content: 'search' }],
          tools: [toolUseTool],
          maxTokens: 100,
        },
        { signal: new AbortController().signal },
      );
      await run(response.content.find((b) => b.type === 'tool_use') as ToolUseBlock);
    },
  );
});

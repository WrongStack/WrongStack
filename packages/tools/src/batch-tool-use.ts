import type { Tool } from '@wrongstack/core';

interface BatchToolUseInput {
  calls: {
    tool: string;
    input: Record<string, unknown>;
  }[];
  stop_on_error?: boolean | undefined;
  parallel?: boolean | undefined;
}

interface BatchToolUseOutput {
  results: {
    tool: string;
    success: boolean;
    result?: unknown | undefined;
    error?: string | undefined;
    executionMs: number;
  }[];
  total: number;
  succeeded: number;
  failed: number;
  stop_on_error: boolean;
}

export const batchToolUseTool: Tool<BatchToolUseInput, BatchToolUseOutput> = {
  name: 'batch_tool_use',
  category: 'Meta',
  description:
    'Execute a batch of tool calls either sequentially or in parallel. Returns structured results for every call.',
  usageHint:
    'ADVANCED / POWER USER TOOL:\n\n' +
    '- Useful when you have a clear list of independent operations to perform.\n' +
    '- `parallel: true` (default) runs them concurrently for speed.\n' +
    '- `stop_on_error: true` makes it fail fast on the first error.\n' +
    'Use with care — batching many mutating operations can be risky. Prefer explicit sequential steps for important work.',
  permission: 'confirm',
  mutating: true,
  timeoutMs: 120_000,
  capabilities: ['tool.mutate.any'],
  inputSchema: {
    type: 'object',
    properties: {
      calls: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            tool: { type: 'string' },
            input: { type: 'object' },
          },
          required: ['tool'],
        },
        description: 'Array of tool calls to execute',
      },
      stop_on_error: {
        type: 'boolean',
        description: 'Stop execution on first error (default: false)',
      },
      parallel: {
        type: 'boolean',
        description: 'Execute calls in parallel (default: true)',
      },
    },
    required: ['calls'],
  },
  async execute(input, ctx, opts) {
    if (!input?.calls || input.calls.length === 0) {
      return {
        results: [],
        total: 0,
        succeeded: 0,
        failed: 0,
        stop_on_error: false,
      };
    }

    const results: BatchToolUseOutput['results'] = [];
    let succeeded = 0;
    let failed = 0;

    if (input.parallel !== false) {
      const promises = input.calls.map(async (call) => executeSingle(call, ctx, opts));
      const allResults = await Promise.all(promises);
      results.push(...allResults);
      succeeded = allResults.filter((r) => r.success).length;
      failed = allResults.filter((r) => !r.success).length;
    } else {
      for (const call of input.calls) {
        const result = await executeSingle(call, ctx, opts);
        results.push(result);
        if (result.success) {
          succeeded++;
        } else {
          failed++;
          if (input.stop_on_error) break;
        }
      }
    }

    return {
      results,
      total: input.calls.length,
      succeeded,
      failed,
      stop_on_error: input.stop_on_error ?? false,
    };
  },
};

async function executeSingle(
  call: { tool: string; input: Record<string, unknown> },
  ctx: import('@wrongstack/core').Context,
  opts: { signal: AbortSignal },
): Promise<BatchToolUseOutput['results'][0]> {
  const start = Date.now();
  const tool = ctx.tools.find((t: Tool) => t.name === call.tool);

  if (!tool) {
    return {
      tool: call.tool,
      success: false,
      error: `tool "${call.tool}" not found`,
      executionMs: Date.now() - start,
    };
  }

  try {
    const result = await tool.execute(call.input, ctx, opts);
    return {
      tool: call.tool,
      success: true,
      result,
      executionMs: Date.now() - start,
    };
  } catch (e) {
    return {
      tool: call.tool,
      success: false,
      error: e instanceof Error ? e.message : String(e),
      executionMs: Date.now() - start,
    };
  }
}

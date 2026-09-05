import {
  GOVERNED_TOOL_EXECUTOR_META_KEY,
  type GovernedToolExecutor,
  type Tool,
} from '@wrongstack/core/types';

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

const BATCHABLE_TOOL_NAMES = [
  'read',
  'glob',
  'grep',
  'tree',
  'codebase-stats',
  'codebase-search',
  'language_info',
  'tool_search',
  'memory_for_file',
  'memory_for_path',
  'memory_search',
] as const;
const BATCHABLE_TOOLS = new Set<string>(BATCHABLE_TOOL_NAMES);
const MAX_BATCH_CALLS = 8;
const MAX_PARALLEL_BATCH_CALLS = 3;

export const batchToolUseTool: Tool<BatchToolUseInput, BatchToolUseOutput> = {
  name: 'batch_tool_use',
  category: 'Meta',
  description:
    'Execute a small batch of independent, read-only discovery calls. Process, mutation, browser-action, MCP, delegation, and nested meta tools are not eligible.',
  usageHint:
    'BOUNDED READ-ONLY BATCHING:\n\n' +
    '- Use only for a small set of independent reads or searches that are all needed now.\n' +
    '- Do not wrap normal sequential reasoning or every tool call in a batch.\n' +
    '- `parallel: true` (default) runs at most three eligible calls concurrently.\n' +
    '- `stop_on_error: true` makes it fail fast on the first error.\n' +
    `- Eligible tools: ${BATCHABLE_TOOL_NAMES.join(', ')}.`,
  permission: 'confirm',
  // Scheduling barrier: keep the outer meta-call out of ToolExecutor's
  // non-mutating fan-out even though every eligible inner tool is read-only.
  mutating: true,
  timeoutMs: 120_000,
  capabilities: ['tool.meta'],
  icon: 'meta',
  inputSchema: {
    type: 'object',
    properties: {
      calls: {
        type: 'array',
        maxItems: MAX_BATCH_CALLS,
        items: {
          type: 'object',
          properties: {
            tool: {
              type: 'string',
              enum: [...BATCHABLE_TOOL_NAMES],
              description: 'An explicitly batch-safe, read-only discovery tool.',
            },
            input: { type: 'object' },
          },
          required: ['tool'],
        },
        description: `Up to ${MAX_BATCH_CALLS} independent, batch-safe read calls.`,
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
  async execute(input, ctx, _opts) {
    if (!input?.calls || input.calls.length === 0) {
      return {
        results: [],
        total: 0,
        succeeded: 0,
        failed: 0,
        stop_on_error: false,
      };
    }
    if (input.calls.length > MAX_BATCH_CALLS) {
      throw new Error(`batch_tool_use: calls must contain at most ${MAX_BATCH_CALLS} items`);
    }

    const governedExecute = ctx.meta?.[GOVERNED_TOOL_EXECUTOR_META_KEY] as
      | GovernedToolExecutor
      | undefined;
    if (typeof governedExecute !== 'function') {
      return {
        results: input.calls.map((call) => ({
          tool: call.tool,
          success: false,
          error: 'governed nested execution is unavailable; call the tool directly',
          executionMs: 0,
        })),
        total: input.calls.length,
        succeeded: 0,
        failed: input.calls.length,
        stop_on_error: input.stop_on_error ?? false,
      };
    }

    const results: BatchToolUseOutput['results'] = [];
    let succeeded = 0;
    let failed = 0;

    if (input.parallel !== false) {
      // stop_on_error must hold in parallel mode too: calls already in flight
      // finish (they cannot be un-run), but once a failure is recorded the
      // pool stops STARTING queued calls — the same semantics as the serial
      // path's `break`, which also omits unexecuted calls from `results`.
      let stopRequested = false;
      const allResults = await mapWithConcurrency(
        input.calls,
        MAX_PARALLEL_BATCH_CALLS,
        async (call) => {
          const result = await executeSingle(call, ctx, governedExecute);
          if (input.stop_on_error && !result.success) stopRequested = true;
          return result;
        },
        () => stopRequested,
      );
      // Workers that exited before claiming a call leave holes in the indexed
      // array — drop them so `results` mirrors the serial path.
      const executed = allResults.filter(
        (r): r is BatchToolUseOutput['results'][number] => r !== undefined,
      );
      results.push(...executed);
      succeeded = executed.filter((r) => r.success).length;
      failed = executed.filter((r) => !r.success).length;
    } else {
      for (const call of input.calls) {
        const result = await executeSingle(call, ctx, governedExecute);
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

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
  shouldStop?: () => boolean,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      if (shouldStop?.()) return;
      const index = nextIndex++;
      results[index] = await run(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function executeSingle(
  call: { tool: string; input: Record<string, unknown> },
  ctx: import('@wrongstack/core/agent').Context,
  governedExecute: GovernedToolExecutor,
): Promise<BatchToolUseOutput['results'][0]> {
  const start = Date.now();
  if (call.tool === batchToolUseTool.name) {
    return {
      tool: call.tool,
      success: false,
      error: 'recursive batch_tool_use execution is not allowed',
      executionMs: Date.now() - start,
    };
  }
  const tool = (ctx.catalogTools ?? ctx.tools).find(
    (candidate: Tool) => candidate.name === call.tool,
  );

  if (!tool) {
    return {
      tool: call.tool,
      success: false,
      error: `tool "${call.tool}" not found`,
      executionMs: Date.now() - start,
    };
  }
  if (!BATCHABLE_TOOLS.has(tool.name) || tool.mutating) {
    return {
      tool: call.tool,
      success: false,
      error:
        `tool "${call.tool}" is not eligible for batch execution; ` +
        `call it directly. Allowed: ${BATCHABLE_TOOL_NAMES.join(', ')}`,
      executionMs: Date.now() - start,
    };
  }

  try {
    const result = await governedExecute(call.tool, call.input);
    return {
      tool: call.tool,
      success: result.success,
      ...(result.success
        ? { result: result.result }
        : { error: result.error ?? 'nested tool failed' }),
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

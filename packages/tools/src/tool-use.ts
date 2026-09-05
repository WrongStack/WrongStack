import {
  GOVERNED_TOOL_EXECUTOR_META_KEY,
  type GovernedToolExecutor,
  type Tool,
} from '@wrongstack/core/types';

export interface ToolUseInput {
  tool: string;
  input: Record<string, unknown>;
}

export interface ToolUseOutput {
  tool: string;
  success: boolean;
  result?: unknown | undefined;
  error?: string | undefined;
  executionMs: number;
}

export const toolUseTool: Tool<ToolUseInput, ToolUseOutput> = {
  name: 'tool_use',
  category: 'Meta',
  description:
    'Directly execute any registered tool by its exact name, bypassing normal discovery. ' +
    'This is a powerful meta-tool intended for cases where the agent has a clear plan and knows precisely which tool to invoke.',
  usageHint:
    'ADVANCED META TOOL — USE WITH CARE:\n\n' +
    '- Only use when you are certain of the exact tool name and its expected input shape.\n' +
    '- Prefer using the normal tool calling mechanism when possible.\n' +
    '- Very useful in batch-tool-use or when orchestrating complex workflows programmatically.\n' +
    '- The call still goes through full permission checks and capability validation.',
  permission: 'confirm',
  // WS-046: gives permission decisions something to key on.
  // The tool being invoked through this indirection — the whole point of a
  // permission decision here is WHICH tool is being reached.
  subjectKey: 'tool',
  mutating: true,
  timeoutMs: 60_000,
  capabilities: ['tool.mutate.any'],
  icon: 'meta',
  inputSchema: {
    type: 'object',
    properties: {
      tool: {
        type: 'string',
        description:
          'The exact registered name of the tool to invoke (e.g. "bash", "read", "codebase-search").',
      },
      input: {
        type: 'object',
        description: "The input object matching the target tool's inputSchema.",
      },
    },
    required: ['tool'],
  },
  async execute(input, ctx) {
    const start = Date.now();

    if (!input?.tool) {
      return {
        tool: 'unknown',
        success: false,
        error: 'tool_use: tool name is required',
        executionMs: 0,
      };
    }

    const tool = (ctx.catalogTools ?? ctx.tools).find((t: Tool) => t.name === input.tool);
    if (!tool) {
      return {
        tool: input.tool,
        success: false,
        error: `tool_use: tool "${input.tool}" not found`,
        executionMs: Date.now() - start,
      };
    }
    if (tool.name === toolUseTool.name) {
      return {
        tool: input.tool,
        success: false,
        error: 'tool_use: recursive meta-tool execution is not allowed',
        executionMs: Date.now() - start,
      };
    }

    // `deny` is a hard policy gate — bypassing it through a meta-tool
    // would defeat the whole point of the permission system. Keep this
    // check even though the outer `tool_use` already requires `confirm`.
    if (tool.permission === 'deny') {
      return {
        tool: input.tool,
        success: false,
        error: `tool_use: tool "${input.tool}" is denied by policy`,
        executionMs: Date.now() - start,
      };
    }

    const governedExecute = ctx.meta?.[GOVERNED_TOOL_EXECUTOR_META_KEY] as
      | GovernedToolExecutor
      | undefined;
    if (typeof governedExecute !== 'function') {
      return {
        tool: input.tool,
        success: false,
        error: 'tool_use: governed nested execution is unavailable; call the tool directly',
        executionMs: Date.now() - start,
      };
    }

    try {
      const result = await governedExecute(input.tool, input.input ?? {});
      return {
        tool: input.tool,
        success: result.success,
        ...(result.success
          ? { result: result.result }
          : { error: result.error ?? 'nested tool failed' }),
        executionMs: Date.now() - start,
      };
    } catch (e) {
      return {
        tool: input.tool,
        success: false,
        error: e instanceof Error ? e.message : String(e),
        executionMs: Date.now() - start,
      };
    }
  },
};

import type { Tool } from '@wrongstack/core';

interface ToolUseInput {
  tool: string;
  input: Record<string, unknown>;
}

interface ToolUseOutput {
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
  mutating: true,
  timeoutMs: 60_000,
  capabilities: ['tool.mutate.any'],
  inputSchema: {
    type: 'object',
    properties: {
      tool: {
        type: 'string',
        description: 'The exact registered name of the tool to invoke (e.g. "bash", "read", "codebase-search").',
      },
      input: {
        type: 'object',
        description: 'The input object matching the target tool\'s inputSchema.',
      },
    },
    required: ['tool'],
  },
  async execute(input, ctx, opts) {
    const start = Date.now();

    if (!input?.tool) {
      return {
        tool: 'unknown',
        success: false,
        error: 'tool_use: tool name is required',
        executionMs: 0,
      };
    }

    const tool = ctx.tools.find((t: Tool) => t.name === input.tool);
    if (!tool) {
      return {
        tool: input.tool,
        success: false,
        error: `tool_use: tool "${input.tool}" not found`,
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

    // Note: inner `permission === 'confirm'` is intentionally NOT short-
    // circuited here. The outer `tool_use` itself has `permission: 'confirm'`,
    // so the user already saw the full args (including which inner tool will
    // run, and with what input) before approving the meta-call. Duplicating
    // the check inside execute() turned every confirm-tool dispatch through
    // `tool_use` into a hard failure — the model would see "requires
    // confirmation" with no way to proceed, even after the user said yes.
    // `batch_tool_use` already follows this same model.

    try {
      const result = await tool.execute(input.input, ctx, opts);
      return {
        tool: input.tool,
        success: true,
        result,
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

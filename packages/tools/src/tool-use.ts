import {
  GOVERNED_TOOL_EXECUTOR_META_KEY,
  type GovernedToolExecutor,
  type NestedToolCaller,
  type Tool,
  ToolValidationError,
} from '@wrongstack/contracts/types';

export interface ToolUseInput {
  tool: string;
  input: Record<string, unknown>;
}

export interface ToolUseOutput {
  tool: string;
  /** Always true: any refusal or nested failure is thrown, not returned. */
  success: true;
  result?: unknown | undefined;
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
  // The nested call runs under its own tool's timeout, and may wait for the
  // user's confirmation; a ceiling here would cut that wait short.
  managesOwnTimeout: true,
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
  async execute(input, ctx, opts) {
    const start = Date.now();

    // Every refusal and every nested failure THROWS: the executor marks a call
    // failed only when execute() throws, so a returned `success: false` payload
    // would surface a failed nested tool as a successful `tool_use` call.
    if (!input?.tool) {
      throw new ToolValidationError({ message: 'tool_use: tool name is required', field: 'tool' });
    }

    const tool = (ctx.catalogTools ?? ctx.tools).find((t: Tool) => t.name === input.tool);
    if (!tool) {
      throw new ToolValidationError({
        message: `tool_use: tool "${input.tool}" not found`,
        field: 'tool',
      });
    }
    if (tool.name === toolUseTool.name) {
      throw new ToolValidationError({
        message: 'tool_use: recursive meta-tool execution is not allowed',
        field: 'tool',
      });
    }

    // `deny` is a hard policy gate — bypassing it through a meta-tool
    // would defeat the whole point of the permission system. Keep this
    // check even though the outer `tool_use` already requires `confirm`.
    if (tool.permission === 'deny') {
      throw new Error(`tool_use: tool "${input.tool}" is denied by policy`);
    }

    // The agent's own gate first, as `tool_script` uses it: validation, hooks,
    // permission, a user confirmation when one is needed, and journaling as
    // `<id>~1`. The executor bridge below cannot ask the user, so a tool that
    // needs confirmation was refused there — and a tool the token-saving tier
    // withheld from the provider surface could not be called directly either.
    const caller = (ctx as { nestedToolCall?: NestedToolCaller | undefined }).nestedToolCall;
    if (caller) {
      const nested = await caller({
        name: input.tool,
        input: input.input ?? {},
        parentToolUseId: opts?.toolUseId ?? `tool-use-${start.toString(36)}`,
        index: 1,
      });
      if (nested.isError) {
        throw new Error(`tool_use: "${input.tool}" failed: ${nested.content}`);
      }
      return {
        tool: input.tool,
        success: true,
        result: nested.content,
        executionMs: Date.now() - start,
      };
    }

    const governedExecute = ctx.meta?.[GOVERNED_TOOL_EXECUTOR_META_KEY] as
      | GovernedToolExecutor
      | undefined;
    if (typeof governedExecute !== 'function') {
      throw new Error('tool_use: governed nested execution is unavailable; call the tool directly');
    }

    const result = await governedExecute(input.tool, input.input ?? {});
    if (!result.success) {
      throw new Error(`tool_use: "${input.tool}" failed: ${result.error ?? 'nested tool failed'}`);
    }
    return {
      tool: input.tool,
      success: true,
      result: result.result,
      executionMs: Date.now() - start,
    };
  },
};

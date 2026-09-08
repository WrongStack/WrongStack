import type { SubagentConfig } from '../types/multi-agent.js';
import type { JSONSchema, Tool } from '../types/tool.js';
import { ToolCapabilities } from '../security/capabilities.js';

export interface DefineSubagentInput {
  /** Unique name/role id for the subagent (letters, numbers, _, -, .). */
  name: string;
  /** Human-readable description of what this subagent does and when to use it. */
  description: string;
  /** Detailed system prompt with role instructions for the subagent. */
  system_prompt?: string | undefined;
  /** CamelCase alias for system_prompt. */
  systemPrompt?: string | undefined;
  /** Whether to grant file write / modification tools (default: false). */
  enable_write_tools?: boolean | undefined;
  /** Whether to grant subagent delegation tools (default: false). */
  enable_subagent_tools?: boolean | undefined;
  /** Whether to grant MCP tools (default: false). */
  enable_mcp_tools?: boolean | undefined;
  /** Explicit list of tool names allowed for this subagent. */
  tools?: string[] | undefined;
  /** Optional model override (e.g. "inherit", or specific model id). */
  model?: string | undefined;
  /** Optional provider override. */
  provider?: string | undefined;
  /** Max iterations budget. */
  maxIterations?: number | undefined;
  /** Max tool calls budget. */
  maxToolCalls?: number | undefined;
  /** Timeout in milliseconds. */
  timeoutMs?: number | undefined;
}

export interface DefineSubagentOutput {
  success: boolean;
  name: string;
  role: string;
  message: string;
}

export interface CreateDefineSubagentToolOptions {
  roster?: Record<string, SubagentConfig> | undefined;
  projectRoot?: string | undefined;
  events?: import('../kernel/events.js').EventBus | undefined;
}

export function createDefineSubagentTool(
  opts: CreateDefineSubagentToolOptions,
): Tool<DefineSubagentInput, DefineSubagentOutput> {
  const inputSchema: JSONSchema = {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description:
          'Unique identifier for the subagent. Must start with a letter or digit and contain only letters, digits, _, -, and .',
      },
      description: {
        type: 'string',
        description: 'Human-readable description of what this subagent does and when to use it.',
      },
      system_prompt: {
        type: 'string',
        description: 'Detailed instructions and system prompt for the subagent.',
      },
      systemPrompt: {
        type: 'string',
        description: 'CamelCase alias for system_prompt.',
      },
      enable_write_tools: {
        type: 'boolean',
        description: 'Set true to equip the subagent with file creation and editing tools.',
      },
      enable_subagent_tools: {
        type: 'boolean',
        description: 'Set true to equip the subagent with tools to delegate to further subagents.',
      },
      enable_mcp_tools: {
        type: 'boolean',
        description: 'Set true to equip the subagent with MCP tools.',
      },
      tools: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional explicit tool names to grant to this subagent.',
      },
      model: {
        type: 'string',
        description: 'Optional model override.',
      },
      provider: {
        type: 'string',
        description: 'Optional provider override.',
      },
      maxIterations: { type: 'number', minimum: 1 },
      maxToolCalls: { type: 'number', minimum: 1 },
      timeoutMs: { type: 'number', minimum: 1000 },
    },
    required: ['name', 'description'],
    additionalProperties: false,
  };

  return {
    name: 'define_subagent',
    category: 'Coordination',
    icon: 'meta',
    permission: 'auto',
    mutating: false,
    capabilities: [ToolCapabilities.SUBAGENT_SPAWN],
    description:
      'Defines a new custom or ad-hoc subagent type that can be invoked via `delegate` or `spawn_subagent`. ' +
      'Use this when you need a specialized subagent for a task and none of the existing catalog roles are suitable. ' +
      'Once defined, it is registered into the active session roster and can be invoked repeatedly.',
    usageHint:
      'Pass `name`, `description`, `system_prompt`, and capability toggles (`enable_write_tools`, `enable_mcp_tools`). ' +
      'After defining, call `delegate({ role: name, task, scope, outOfScope })` or `spawn_subagent({ role: name, ... })`.',
    inputSchema,
    async execute(input) {
      const rawName = input.name?.trim();
      if (!rawName || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(rawName)) {
        throw new Error(
          `Invalid subagent name "${input.name}". Must start with a letter or digit and contain only letters, digits, _, -, and .`,
        );
      }

      const prompt = (input.system_prompt ?? input.systemPrompt)?.trim();
      if (!prompt) {
        throw new Error('define_subagent requires a non-empty `system_prompt`.');
      }

      const capabilities: string[] = ['fs.read', 'net.outbound'];
      if (input.enable_write_tools) {
        capabilities.push('fs.write');
      }
      if (input.enable_subagent_tools) {
        capabilities.push(ToolCapabilities.SUBAGENT_SPAWN);
      }
      if (input.enable_mcp_tools) {
        capabilities.push('mcp.proxy');
      }

      // Default tools matching capabilities if not explicitly passed
      const baseTools = ['read', 'glob', 'grep', 'read_url_content'];
      if (input.enable_write_tools) {
        baseTools.push('write', 'edit', 'replace', 'diff', 'patch');
      }
      const tools = input.tools ? [...input.tools] : baseTools;

      const subagentConfig: SubagentConfig = {
        name: rawName,
        role: rawName,
        prompt,
        capabilities,
        allowedCapabilities: capabilities,
        tools,
        model: input.model,
        provider: input.provider,
        maxIterations: input.maxIterations ?? 25,
        maxToolCalls: input.maxToolCalls ?? 50,
        timeoutMs: input.timeoutMs ?? 300_000,
        dispatch: {
          summary: input.description,
          keywords: [
            rawName.toLowerCase(),
            ...input.description.toLowerCase().split(/\W+/).filter((w) => w.length > 3),
          ],
        },
      };

      if (opts.roster) {
        opts.roster[rawName] = subagentConfig;
      }

      return {
        success: true,
        name: rawName,
        role: rawName,
        message:
          `Ad-hoc subagent "${rawName}" defined successfully. ` +
          `You can now invoke it with delegate({ role: "${rawName}", task: "...", scope: "...", outOfScope: "..." }) ` +
          `or spawn_subagent({ role: "${rawName}", description: "..." }).`,
      };
    },
  };
}

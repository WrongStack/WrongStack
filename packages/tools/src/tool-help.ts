import type { Tool } from '@wrongstack/core';

interface ToolHelpInput {
  tool?: string | undefined;
  format?: 'short' | 'full' | 'markdown' | undefined;
  include_examples?: boolean | undefined;
}

interface ToolHelpOutput {
  tool?: string | undefined;
  help: string;
  tools: {
    name: string;
    description: string;
    usageHint: string;
    inputSchema: unknown;
    permission: string;
    mutating: boolean;
  }[];
  total: number;
}

export const toolHelpTool: Tool<ToolHelpInput, ToolHelpOutput> = {
  name: 'tool_help',
  category: 'Meta',
  description:
    'Get detailed help for one or more tools, including their full schema and usage guidance. ' +
    'This is the best way to understand exactly how to call a specific tool.',
  usageHint:
    'USE WHEN YOU NEED PRECISE TOOL INFORMATION:\n\n' +
    '- Call with a specific `tool` name when you want the full schema and current usageHint.\n' +
    '- Omit `tool` (or use a broad query) to get an overview of available tools.\n' +
    '- Different `format` options give you different levels of detail.\n' +
    'This tool is extremely valuable for self-correction when you are unsure about a tool\'s interface.',
  permission: 'auto',
  mutating: false,
  timeoutMs: 5_000,
  capabilities: ['tool.meta'],
  inputSchema: {
    type: 'object',
    properties: {
      tool: {
        type: 'string',
        description: 'Specific tool name to get detailed help for. Omit to get a list of all tools.',
      },
      format: {
        type: 'string',
        enum: ['short', 'full', 'markdown'],
        description: 'Level of detail: "short" (summary), "full" (with full schema), "markdown" (human readable).',
      },
      include_examples: {
        type: 'boolean',
        description: 'Whether to include example usage in the response.',
      },
    },
  },
  async execute(input, ctx) {
    const format = input.format ?? 'short';
    const includeExamples = input.include_examples ?? false;

    if (input.tool) {
      const tool = ctx.tools.find((t: Tool) => t.name === input.tool);
      if (!tool) {
        return {
          tool: input.tool,
          help: `No tool found with name "${input.tool}"`,
          tools: [],
          total: 0,
        };
      }

      return {
        tool: tool.name,
        help: formatToolHelp(tool, format, includeExamples),
        tools: [
          {
            name: tool.name,
            description: tool.description,
            usageHint: tool.usageHint ?? '',
            inputSchema: tool.inputSchema,
            permission: tool.permission,
            mutating: tool.mutating,
          },
        ],
        total: 1,
      };
    }

    const allTools = ctx.tools.map((t: Tool) => ({
      name: t.name,
      description: t.description,
      usageHint: t.usageHint ?? '',
      inputSchema: format === 'full' ? t.inputSchema : undefined,
      permission: t.permission,
      mutating: t.mutating,
    }));

    return {
      help:
        format === 'markdown' ? formatAllToolsMarkdown(allTools) : formatAllToolsShort(allTools),
      tools: allTools,
      total: allTools.length,
    };
  },
};

function formatToolHelp(tool: Tool, format: string, includeExamples: boolean): string {
  const lines: string[] = [];

  if (format === 'short') {
    lines.push(`${tool.name}: ${tool.description}`);
    if (tool.usageHint) lines.push(`Hint: ${tool.usageHint}`);
    return lines.join('\n');
  }

  if (format === 'markdown') {
    lines.push(`## ${tool.name}`);
    lines.push('');
    lines.push(tool.description);
    lines.push('');
    lines.push('**Permission:** ' + tool.permission);
    lines.push('**Mutating:** ' + (tool.mutating ? 'yes' : 'no'));
    if (tool.usageHint) {
      lines.push('');
      lines.push('### Usage Hint');
      lines.push(tool.usageHint);
    }
    if (includeExamples && tool.inputSchema) {
      lines.push('');
      lines.push('### Input Schema');
      lines.push('```json');
      lines.push(JSON.stringify(tool.inputSchema, null, 2));
      lines.push('```');
    }
    return lines.join('\n');
  }

  lines.push(`Tool: ${tool.name}`);
  lines.push(`Description: ${tool.description}`);
  lines.push(`Permission: ${tool.permission}`);
  lines.push(`Mutating: ${tool.mutating}`);
  if (tool.usageHint) lines.push(`Usage: ${tool.usageHint}`);
  if (format === 'full' && tool.inputSchema) {
    lines.push('Schema: ' + JSON.stringify(tool.inputSchema, null, 2));
  }
  return lines.join('\n');
}

function formatAllToolsShort(tools: { name: string; description: string }[]): string {
  return tools.map((t) => `  ${t.name.padEnd(16)} ${t.description}`).join('\n');
}

function formatAllToolsMarkdown(
  tools: { name: string; description: string; usageHint: string }[],
): string {
  const lines: string[] = ['## Available Tools', ''];
  lines.push('| Tool | Description |');
  lines.push('|------|-------------|');
  for (const t of tools) {
    lines.push(`| \`${t.name}\` | ${t.description} |`);
  }
  return lines.join('\n');
}

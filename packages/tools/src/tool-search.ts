import type { Tool } from '@wrongstack/core';

interface ToolSearchInput {
  query?: string | undefined;
  tags?: string[] | undefined;
  permission?: 'auto' | 'confirm' | 'deny' | undefined;
  mutating?: boolean | undefined;
  limit?: number | undefined;
}

interface ToolSearchOutput {
  tools: {
    name: string;
    description: string;
    permission: string;
    mutating: boolean;
  }[];
  total: number;
  truncated: boolean;
}

export const toolSearchTool: Tool<ToolSearchInput, ToolSearchOutput> = {
  name: 'tool_search',
  category: 'Meta',
  description:
    'Search the catalog of available tools. Very useful when you are unsure which tool to use for a task.',
  usageHint:
    'SELF-DISCOVERY TOOL:\n\n' +
    '- Use when you need to find the right tool for a job.\n' +
    '- `query` searches names and descriptions.\n' +
    '- You can filter by `tags` (category), `permission`, or `mutating`.\n' +
    'Call this before guessing tool names. It helps you discover the best tool for the current situation.',
  permission: 'auto',
  mutating: false,
  timeoutMs: 1_000,
  capabilities: ['tool.meta'],
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query for tool name or description',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Filter by tags (e.g. "filesystem", "network", "dev")',
      },
      permission: {
        type: 'string',
        enum: ['auto', 'confirm', 'deny'],
        description: 'Filter by required permission level',
      },
      mutating: {
        type: 'boolean',
        description: 'Filter by mutating flag (true=filters that modify, false=read-only)',
      },
      limit: {
        type: 'integer',
        description: 'Maximum results to return (default: 20)',
        minimum: 1,
        maximum: 100,
      },
    },
  },
  async execute(input, ctx) {
    const limit = Math.min(input.limit ?? 20, 100);
    const tools = ctx.tools;
    const query = input.query?.toLowerCase() ?? '';

    const filtered = tools.filter((t: Tool) => {
      if (
        query &&
        !t.name.toLowerCase().includes(query) &&
        !t.description.toLowerCase().includes(query)
      ) {
        return false;
      }
      if (input.tags && input.tags.length > 0) {
        const toolCat = (t.category ?? '').toLowerCase();
        if (!input.tags.some((tag: string) => toolCat.includes(tag.toLowerCase()))) {
          return false;
        }
      }
      if (input.permission && t.permission !== input.permission) {
        return false;
      }
      if (typeof input.mutating === 'boolean' && t.mutating !== input.mutating) {
        return false;
      }
      return true;
    });

    const results = filtered.slice(0, limit).map((t: Tool) => ({
      name: t.name,
      description: t.description,
      permission: t.permission,
      mutating: t.mutating,
    }));

    // When no tools match, give the model actionable guidance so it
    // doesn't spiral through random queries. Point it at tool-help
    // which lists every available tool with descriptions.
    const totalAvailable = tools.length;
    const hint =
      results.length === 0 && query
        ? `No tools matched "${input.query}". Use tool-help (without arguments) to see all ${totalAvailable} available tools.`
        : undefined;

    return {
      tools: results,
      total: filtered.length,
      truncated: filtered.length > limit,
      ...(hint ? { hint } : {}),
      _available: totalAvailable,
    };
  },
};
/**
 * Tools registry for ACP agent-side.
 *
 * Translates WrongStack Tool definitions → ACP ACPToolDefinition format.
 * Provides tool lookup and result assembly for the ACP protocol handler.
 */
import type { Tool } from '@wrongstack/core/types';
import type {
  ACPInputSchema,
  ACPToolDefinition,
  ACPToolList,
  ACPToolResult,
  ContentBlock,
} from '../types/acp-messages.js';

export class ACPToolsRegistry {
  private tools = new Map<string, Tool>();
  private readonly owner: string;

  constructor(owner = 'wrongstack') {
    this.owner = owner;
  }

  /**
   * Register one or more tools.
   * Throws on duplicate name unless force=true.
   */
  register(tools: Tool[]): void {
    for (const tool of tools) {
      this.tools.set(tool.name, tool);
    }
  }

  /**
   * Replace the current tool set.
   */
  setTools(tools: Tool[]): void {
    this.tools.clear();
    for (const tool of tools) this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  /** Build the ACP tools/list payload from registered tools. */
  buildToolList(): ACPToolList {
    return {
      tools: Array.from(this.tools.values()).map((t) => toACPToolDefinition(t, this.owner)),
    };
  }

  /**
   * Execute a tool by name and return ACP-formatted result.
   * Returns null if the tool is not found.
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: unknown,
    signal: AbortSignal,
  ): Promise<ACPToolResult | null> {
    const tool = this.tools.get(name);
    if (!tool) return null;

    try {
      const result = await tool.execute(args, ctx as Parameters<Tool['execute']>[1], {
        signal,
      });
      return toACPToolResult(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: msg }], isError: true } satisfies ACPToolResult;
    }
  }
}

/** Convert a WrongStack Tool → ACP ACPToolDefinition */
function toACPToolDefinition(tool: Tool, _owner: string): ACPToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: toACPInputSchema(tool.inputSchema),
    annotations: {
      title: tool.name,
      description: tool.usageHint ?? tool.description,
      priority: toolToPriority(tool),
      alwaysAccept: tool.permission === 'auto',
    },
  };
}

/** Minimal JSON Schema → ACP input schema. ACP uses JSON Schema draft-07. */
function toACPInputSchema(src: unknown): ACPInputSchema {
  if (!src || typeof src !== 'object') {
    return {};
  }
  const s = src as Record<string, unknown>;
  const out: ACPInputSchema = {};
  if (typeof s.type === 'string') out.type = s.type;
  if (Array.isArray(s.enum)) out.enum = s.enum;
  if (typeof s.description === 'string') out.description = s.description;
  if ('default' in s) out.default = s.default;
  if (typeof s.minimum === 'number') out.minimum = s.minimum;
  if (typeof s.maximum === 'number') out.maximum = s.maximum;
  if (s.items) out.items = toACPInputSchema(s.items);

  // Recursively convert properties
  if (s.properties && typeof s.properties === 'object') {
    const props: Record<string, ACPInputSchema> = {};
    for (const [k, v] of Object.entries(s.properties as Record<string, unknown>)) {
      props[k] = toACPInputSchema(v);
    }
    out.properties = props;
    if (Array.isArray(s.required)) out.required = s.required as string[];
  }

  return out;
}

/** Convert a WrongStack ToolResult → ACP ContentBlock[] */
function toACPToolResult(result: unknown): ACPToolResult {
  const blocks: ContentBlock[] = [];

  if (result === undefined || result === null) {
    return { content: [{ type: 'text', text: 'ok' }] };
  }

  if (typeof result === 'string') {
    blocks.push({ type: 'text', text: result });
  } else if (typeof result === 'object') {
    blocks.push({ type: 'text', text: JSON.stringify(result, null, 2) });
  } else {
    blocks.push({ type: 'text', text: String(result) });
  }

  return { content: blocks };
}

function toolToPriority(tool: Tool): 'high' | 'medium' | 'low' {
  if (tool.riskTier === 'destructive') return 'high';
  if (tool.riskTier === 'standard' || tool.permission === 'confirm') return 'medium';
  return 'low';
}

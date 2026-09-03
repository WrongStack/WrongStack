import type { Tool } from '@wrongstack/core/types';
import { compactToolDefinitionForWire } from '@wrongstack/core/utils';

export interface AnthropicToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/**
 * WeakMap cache keyed by the Tool[] array reference. The tool registry
 * returns the same array reference within a session, so after the first
 * call the serialized schemas are served from cache — no re-mapping or
 * object allocation on subsequent LLM calls. When tools are added or
 * removed the registry creates a new array, the old entry is GC'd by
 * the WeakMap, and the next call recomputes.
 */
const _cache = new WeakMap<Tool[], AnthropicToolSchema[]>();

export function toolsToAnthropic(tools: Tool[]): AnthropicToolSchema[] {
  const hit = _cache.get(tools);
  if (hit) return hit;
  const sorted =
    tools.length > 1 ? [...tools].sort((a, b) => a.name.localeCompare(b.name)) : tools;
  const result = sorted.map((t) => {
    const compact = compactToolDefinitionForWire(t);
    return {
      name: compact.name,
      description: compact.description,
      input_schema: compact.inputSchema,
    };
  });
  _cache.set(tools, result);
  return result;
}

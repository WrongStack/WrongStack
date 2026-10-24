import type { JSONSchema, Tool } from '@wrongstack/contracts/types';
import * as coordination from '@wrongstack/core/coordination';
import { contextManagerTool } from '@wrongstack/core/infrastructure';
import * as coreTools from '@wrongstack/tools/management';
import { SCHEMA_DESCRIPTION_MAX_CHARS, TOOL_DESCRIPTION_MAX_CHARS } from '@wrongstack/core/utils';
import { createSageTools } from '@wrongstack/sage';
import { builtinTools } from '@wrongstack/tools/builtin';
import {
  forgetTool,
  relatedMemoryTool,
  rememberTool,
  searchMemoryTool,
} from '@wrongstack/tools/memory';
import { createVectorMemoryTools } from '@wrongstack/vector-memory';
import { describe, expect, it } from 'vitest';

/**
 * Text past the wire budget never reaches the model: every provider format
 * compacts descriptions to these ceilings. At 400/120 the cut silently dropped
 * secret-handling and code-execution warnings, required value formats and enum
 * semantics from 60 tools (audit 2026-09-15). This keeps the catalog inside the
 * budget so a long description fails here instead of vanishing on the wire.
 */

/** Accepts any property access or call, so factories build without real ports. */
function stubPort(): never {
  const target = () => {};
  const proxy: unknown = new Proxy(target, {
    get: (_t, key) => {
      if (key === 'then') return undefined;
      if (key === Symbol.toPrimitive || key === 'toString' || key === 'valueOf')
        return () => 'stub';
      if (key === Symbol.iterator) return function* () {};
      return proxy;
    },
    apply: () => proxy,
  });
  return proxy as never;
}

function catalog(): Tool[] {
  const tools: Tool[] = [
    ...builtinTools,
    rememberTool(stubPort()),
    forgetTool(stubPort()),
    searchMemoryTool(stubPort()),
    relatedMemoryTool(stubPort()),
    ...createSageTools(stubPort()),
    ...createVectorMemoryTools(stubPort()),
    contextManagerTool,
    coreTools.createCouncilTool({ caller: async () => ({ text: '' }) } as never),
  ];
  const factories: Record<string, unknown> = { ...coordination, ...coreTools };
  for (const [name, factory] of Object.entries(factories)) {
    if (typeof factory !== 'function' || !/^(make|create)\w*Tools?$/.test(name)) continue;
    if (name === 'createCouncilTool') continue;
    const made = (factory as (...args: unknown[]) => Tool | Tool[])(stubPort(), stubPort());
    tools.push(...(Array.isArray(made) ? made : [made]));
  }
  return tools;
}

function normalizedLength(text: string): number {
  return text.replace(/\s+/g, ' ').trim().length;
}

function overBudgetSchemaDescriptions(schema: unknown, path: string, out: string[]): void {
  if (!schema || typeof schema !== 'object') return;
  if (Array.isArray(schema)) {
    for (const [i, node] of schema.entries()) {
      overBudgetSchemaDescriptions(node, `${path}[${i}]`, out);
    }
    return;
  }
  const node = schema as JSONSchema;
  if (
    typeof node.description === 'string' &&
    normalizedLength(node.description) > SCHEMA_DESCRIPTION_MAX_CHARS
  ) {
    out.push(`${path || '<root>'} (${normalizedLength(node.description)} chars)`);
  }
  for (const [key, value] of Object.entries(node)) {
    if (key !== 'description')
      overBudgetSchemaDescriptions(value, path ? `${path}.${key}` : key, out);
  }
}

describe('tool descriptions fit the provider wire budget', () => {
  const tools = catalog();

  it('covers the host catalog', () => {
    expect(tools.length).toBeGreaterThan(90);
  });

  it('keeps every tool description within TOOL_DESCRIPTION_MAX_CHARS', () => {
    const over = tools
      .filter((tool) => normalizedLength(tool.description) > TOOL_DESCRIPTION_MAX_CHARS)
      .map((tool) => `${tool.name} (${normalizedLength(tool.description)} chars)`);
    expect(over).toEqual([]);
  });

  it('keeps every schema description within SCHEMA_DESCRIPTION_MAX_CHARS', () => {
    const over: string[] = [];
    for (const tool of tools) {
      const found: string[] = [];
      overBudgetSchemaDescriptions(tool.inputSchema, '', found);
      over.push(...found.map((where) => `${tool.name}: ${where}`));
    }
    expect(over).toEqual([]);
  });
});

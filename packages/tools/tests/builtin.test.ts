import { describe, expect, it } from 'vitest';
import { BUILTIN_TOOL_DESCRIPTIONS, builtinTools } from '../src/builtin.js';

describe('builtinTools', () => {
  it('exports a non-empty array of Tool definitions', () => {
    expect(Array.isArray(builtinTools)).toBe(true);
    expect(builtinTools.length).toBeGreaterThan(20);
  });

  it('every tool has the required Tool fields', () => {
    for (const t of builtinTools) {
      expect(typeof t.name).toBe('string');
      expect(t.name.length).toBeGreaterThan(0);
      expect(typeof t.description).toBe('string');
      expect(t.description.trim().length).toBeGreaterThan(0);
      expect(typeof t.execute).toBe('function');
      expect(t.permission).toMatch(/^(auto|confirm|deny)$/);
    }
  });

  it('registers codebase-invariant-check in the agent catalog', () => {
    expect(builtinTools.map((t) => t.name)).toContain('codebase-invariant-check');
  });

  it('all tool names are unique', () => {
    const seen = new Set<string>();
    for (const t of builtinTools) {
      expect(seen.has(t.name)).toBe(false);
      seen.add(t.name);
    }
  });

  it('gives every built-in a reviewed provider-facing description', () => {
    expect(Object.keys(BUILTIN_TOOL_DESCRIPTIONS).sort()).toEqual(
      builtinTools.map((tool) => tool.name).sort(),
    );
    expect(
      builtinTools.every((tool) => tool.description === BUILTIN_TOOL_DESCRIPTIONS[tool.name]),
    ).toBe(true);
  });
});

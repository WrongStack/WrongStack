/**
 * Tests for tool-tier — built-in tool selection by token-saving tier.
 *
 * Coverage targets:
 * - selectBuiltinToolsForTier('off') returns all tools
 * - selectBuiltinToolsForTier('minimal'|'light') returns tier1-only tools
 * - selectBuiltinToolsForTier('medium') returns tier1+tier2 tools
 * - selectBuiltinToolsForTier('aggressive') stays within the tier1 surface
 * - registerBuiltinToolTier delegates to registry and returns selected tools
 * - empty/invalid allTools array is handled gracefully
 */

import type { Tool } from '@wrongstack/core/types';
import { describe, expect, it, vi } from 'vitest';
import { registerBuiltinToolTier, selectBuiltinToolsForTier } from '../src/tool-tier.js';

// Match the actual tier definitions in builtin.ts
// These match the actual tool.name values in builtin.ts / the individual tool files.
const TIER1_NAMES = [
  'read',
  'write',
  'edit',
  'codebase-stats',
  'codebase-search',
  'codebase-index',
  'bash',
  'grep',
  'glob',
  'diff',
  'patch',
  'json',
  'search',
];

const TIER2_NAMES = [
  'replace',
  'exec',
  'fetch',
  'git',
  'tree',
  'lint',
  'format',
  'typecheck',
  'test',
  'language_info',
  'language',
  'language_package',
  'todo',
  'plan',
  'kanban',
  'task',
  'install',
  'audit',
  'design',
];

const TIER3_NAMES = [
  'outdated',
  'logs',
  'document',
  'scaffold',
  'tool_search',
  'tool_use',
  'batch_tool_use',
  'tool_help',
  'set_working_dir',
];

const makeTool = (name: string): Tool =>
  ({ name, description: `tool-${name}`, execute: async () => ({}) }) as unknown as Tool;

const ALL_TOOLS: Tool[] = [
  ...TIER1_NAMES.map(makeTool),
  ...TIER2_NAMES.map(makeTool),
  ...TIER3_NAMES.map(makeTool),
  makeTool('custom-plugin-tool'),
];

describe('selectBuiltinToolsForTier', () => {
  it('tier "off" returns all tools', () => {
    const result = selectBuiltinToolsForTier('off', ALL_TOOLS);
    expect(result).toHaveLength(ALL_TOOLS.length);
    expect(result.map((t) => t.name).sort()).toEqual(ALL_TOOLS.map((t) => t.name).sort());
  });

  it('tier "off" returns a new array (not the same reference)', () => {
    const result = selectBuiltinToolsForTier('off', ALL_TOOLS);
    expect(result).not.toBe(ALL_TOOLS);
    expect(result).toEqual(ALL_TOOLS);
  });

  it('tier "minimal" returns only tier1 tools', () => {
    const result = selectBuiltinToolsForTier('minimal', ALL_TOOLS);
    expect(result.map((t) => t.name).sort()).toEqual([...TIER1_NAMES].sort());
  });

  it('tier "light" returns only tier1 tools (same as minimal)', () => {
    const light = selectBuiltinToolsForTier('light', ALL_TOOLS);
    const minimal = selectBuiltinToolsForTier('minimal', ALL_TOOLS);
    expect(light.map((t) => t.name).sort()).toEqual(minimal.map((t) => t.name).sort());
  });

  it('tier "medium" returns tier1 + tier2 tools', () => {
    const result = selectBuiltinToolsForTier('medium', ALL_TOOLS);
    const expected = [...TIER1_NAMES, ...TIER2_NAMES].sort();
    expect(result.map((t) => t.name).sort()).toEqual(expected);
  });

  it('tier "aggressive" is bounded to the essential tier1 surface', () => {
    const result = selectBuiltinToolsForTier('aggressive', ALL_TOOLS);
    const names = result.map((t) => t.name);
    expect(names.sort()).toEqual([...TIER1_NAMES].sort());
    expect(result.length).toBeLessThan(selectBuiltinToolsForTier('medium', ALL_TOOLS).length);
  });

  it('returns empty array for empty input', () => {
    const result = selectBuiltinToolsForTier('off', []);
    expect(result).toEqual([]);
  });

  it('tiers with empty input return empty', () => {
    expect(selectBuiltinToolsForTier('minimal', [])).toEqual([]);
    expect(selectBuiltinToolsForTier('medium', [])).toEqual([]);
    expect(selectBuiltinToolsForTier('aggressive', [])).toEqual([]);
  });

  it('preserves the original tool order within each tier', () => {
    const result = selectBuiltinToolsForTier('off', ALL_TOOLS);
    expect(result.map((t) => t.name)).toEqual(ALL_TOOLS.map((t) => t.name));
  });

  it('filters out unknown tools not in any tier for minimal', () => {
    const result = selectBuiltinToolsForTier('minimal', ALL_TOOLS);
    const names = result.map((t) => t.name);
    expect(names).not.toContain('custom-plugin-tool');
  });
});

describe('registerBuiltinToolTier', () => {
  it('registers tools and returns them', () => {
    const registry = { registerAllOrThrow: vi.fn() };
    const result = registerBuiltinToolTier({
      registry: registry as any,
      tier: 'medium',
      tools: ALL_TOOLS,
    });
    expect(registry.registerAllOrThrow).toHaveBeenCalledTimes(1);
    expect(registry.registerAllOrThrow).toHaveBeenCalledWith(
      expect.arrayContaining(result),
      expect.any(String),
    );
    expect(result.length).toBeGreaterThan(0);
  });

  it('uses builtinToolsPack when no explicit tools given', () => {
    const registry = { registerAllOrThrow: vi.fn() };
    const result = registerBuiltinToolTier({ registry: registry as any, tier: 'off' });
    expect(registry.registerAllOrThrow).toHaveBeenCalledTimes(1);
    expect(result.length).toBeGreaterThan(0);
  });

  it('passes the owner to registerAllOrThrow', () => {
    const registry = { registerAllOrThrow: vi.fn() };
    registerBuiltinToolTier({
      registry: registry as any,
      tier: 'off',
      tools: ALL_TOOLS,
      owner: 'test-host',
    });
    expect(registry.registerAllOrThrow).toHaveBeenCalledWith(expect.anything(), 'test-host');
  });
});

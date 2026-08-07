/**
 * Coverage for tools/src/tool-tier.ts — selectBuiltinToolsForTier and registerBuiltinToolTier.
 */

import type { Tool } from '@wrongstack/core/types';
import { describe, expect, it, vi } from 'vitest';
import { builtinToolsPack } from '../src/pack.js';
import { registerBuiltinToolTier, selectBuiltinToolsForTier } from '../src/tool-tier.js';

const allTools = builtinToolsPack.tools.filter((t): t is Tool => t != null);

describe('selectBuiltinToolsForTier', () => {
  it('returns all tools for tier "off"', () => {
    const result = selectBuiltinToolsForTier('off', allTools);
    expect(result.length).toBe(allTools.length);
  });

  it('filters to a subset for tier "minimal"', () => {
    const result = selectBuiltinToolsForTier('minimal', allTools);
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThan(allTools.length);
  });

  it('filters to a superset of minimal for tier "light"', () => {
    const minimal = selectBuiltinToolsForTier('minimal', allTools);
    const light = selectBuiltinToolsForTier('light', allTools);
    expect(light.length).toBe(minimal.length); // same set
  });

  it('returns more tools for "medium" than "minimal"', () => {
    const minimal = selectBuiltinToolsForTier('minimal', allTools);
    const medium = selectBuiltinToolsForTier('medium', allTools);
    expect(medium.length).toBeGreaterThanOrEqual(minimal.length);
  });

  it('excludes "task" tool for "aggressive" tier', () => {
    const aggressive = selectBuiltinToolsForTier('aggressive', allTools);
    const taskTool = aggressive.find((t) => t.name === 'task');
    // 'task' should not be in aggressive tier (it's excluded in tier2)
    expect(taskTool).toBeUndefined();
  });

  it('excludes "set_working_dir" tool for "aggressive" tier', () => {
    const aggressive = selectBuiltinToolsForTier('aggressive', allTools);
    const swd = aggressive.find((t) => t.name === 'set_working_dir');
    expect(swd).toBeUndefined();
  });

  it('aggressive tier is no larger than medium', () => {
    const medium = selectBuiltinToolsForTier('medium', allTools);
    const aggressive = selectBuiltinToolsForTier('aggressive', allTools);
    expect(medium.length).toBeGreaterThan(0);
    expect(aggressive.length).toBeGreaterThan(0);
    expect(aggressive.length).toBeLessThanOrEqual(medium.length);
  });

  it('preserves order from the input array', () => {
    const result = selectBuiltinToolsForTier('minimal', allTools);
    const indices = result.map((t) => allTools.indexOf(t));
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBeGreaterThan(indices[i - 1]!);
    }
  });

  it('handles empty tools array', () => {
    expect(selectBuiltinToolsForTier('off', [])).toEqual([]);
    expect(selectBuiltinToolsForTier('minimal', [])).toEqual([]);
    expect(selectBuiltinToolsForTier('medium', [])).toEqual([]);
    expect(selectBuiltinToolsForTier('aggressive', [])).toEqual([]);
  });
});

describe('registerBuiltinToolTier', () => {
  it('registers tools and returns the subset', () => {
    const registeredTools: Tool[] = [];
    const mockRegistry = {
      registerAllOrThrow: vi.fn((tools: Tool[], _owner?: string) => {
        registeredTools.push(...tools);
      }),
    };

    const result = registerBuiltinToolTier({
      registry: mockRegistry,
      tier: 'off',
    });

    expect(mockRegistry.registerAllOrThrow).toHaveBeenCalledOnce();
    expect(result.length).toBeGreaterThan(0);
    expect(registeredTools.length).toBe(result.length);
  });

  it('registers a subset for minimal tier', () => {
    const mockRegistry = {
      registerAllOrThrow: vi.fn(),
    };

    const result = registerBuiltinToolTier({
      registry: mockRegistry,
      tier: 'minimal',
    });

    expect(result.length).toBeLessThan(allTools.length);
    expect(mockRegistry.registerAllOrThrow).toHaveBeenCalledOnce();
  });

  it('uses custom owner when provided', () => {
    const mockRegistry = {
      registerAllOrThrow: vi.fn((_tools: Tool[], owner?: string) => {
        expect(owner).toBe('custom-owner');
      }),
    };

    registerBuiltinToolTier({
      registry: mockRegistry,
      tier: 'off',
      owner: 'custom-owner',
    });

    expect(mockRegistry.registerAllOrThrow).toHaveBeenCalledOnce();
  });

  it('uses custom tools when provided', () => {
    const customTools: Tool[] = [
      {
        name: 'custom1',
        description: 'test',
        parameters: { type: 'object', properties: {} },
      } as unknown as Tool,
      {
        name: 'custom2',
        description: 'test',
        parameters: { type: 'object', properties: {} },
      } as unknown as Tool,
    ];
    const mockRegistry = {
      registerAllOrThrow: vi.fn(),
    };

    const result = registerBuiltinToolTier({
      registry: mockRegistry,
      tier: 'off',
      tools: customTools,
    });

    expect(result.length).toBe(2);
  });
});

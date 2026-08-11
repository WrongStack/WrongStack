import { describe, expect, it } from 'vitest';
import {
  builtinTools,
  OFF_ONLY_TOOLS,
  OPTIONAL_TOOLS,
  TIER1_TOOLS,
  TIER2_TOOLS,
  TIER3_TOOLS,
} from '../src/builtin.js';

const CODEBASE_LIFECYCLE = ['codebase-stats', 'codebase-search', 'codebase-index'];

describe('builtin codebase tool priority', () => {
  it('classifies every built-in into exactly one provider-exposure tier', () => {
    const classified = [TIER1_TOOLS, TIER2_TOOLS, TIER3_TOOLS, OFF_ONLY_TOOLS]
      .flat()
      .map((tool) => tool.name);
    expect(new Set(classified).size).toBe(classified.length);
    expect([...classified].sort()).toEqual(builtinTools.map((tool) => tool.name).sort());
  });

  it('keeps the complete index lifecycle in Tier 1 instead of optional Tier 3', () => {
    const tier1Names = TIER1_TOOLS.map((tool) => tool.name);
    const tier3Names = TIER3_TOOLS.map((tool) => tool.name);
    const optionalNames = OPTIONAL_TOOLS.map((tool) => tool.name);

    expect(tier1Names).toEqual(expect.arrayContaining(CODEBASE_LIFECYCLE));
    for (const name of CODEBASE_LIFECYCLE) {
      expect(tier3Names).not.toContain(name);
      expect(optionalNames).not.toContain(name);
    }
  });

  it('presents index discovery before broad filesystem search tools', () => {
    const names = builtinTools.map((tool) => tool.name);
    const firstFallback = Math.min(
      names.indexOf('glob'),
      names.indexOf('grep'),
      names.indexOf('tree'),
    );

    for (const name of CODEBASE_LIFECYCLE) {
      expect(names.indexOf(name)).toBeGreaterThanOrEqual(0);
      expect(names.indexOf(name)).toBeLessThan(firstFallback);
    }
  });
});

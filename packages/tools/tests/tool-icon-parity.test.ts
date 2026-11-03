import { describe, expect, it } from 'vitest';
import { builtinTools } from '../src/builtin.js';
import * as legacy from '../src/tool-icon-map.js';
import * as canonical from '../src/tool-icons.js';

describe('canonical tool visual identity', () => {
  it('uses the same colors and identities through both public entry points', () => {
    for (const [id, config] of Object.entries(canonical.TOOL_ICON_CONFIG)) {
      expect(legacy.TOOL_ICON_CONFIG[id as canonical.ToolIconId].color, id).toBe(config.color);
    }
    for (const name of new Set([
      ...Object.keys(legacy.TOOL_ICON_MAP),
      ...Object.keys(canonical.TOOL_ICON_MAP),
    ])) {
      expect(legacy.getToolIcon(name), name).toBe(canonical.getToolIcon(name));
    }
  });

  it('gives every executable built-in a visual identity on name-only surfaces', () => {
    for (const tool of builtinTools) {
      expect(canonical.getToolIcon(tool.name), tool.name).not.toBe('fallback');
      if (tool.icon) expect(canonical.getToolIcon(tool.name), tool.name).toBe(tool.icon);
      for (const alias of tool.aliases ?? [])
        expect(canonical.getToolIcon(alias), alias).toBe(canonical.getToolIcon(tool.name));
    }
  });
});

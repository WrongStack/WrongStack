import { TOOL_ICON_MAP, type ToolIconId } from '@wrongstack/tools/tool-icons';
import { describe, expect, it } from 'vitest';
import { getToolVisual, TOOL_GLYPHS } from '../src/tool-glyph.js';

describe('tool-glyph (TUI per-tool glyph+color)', () => {
  it('every icon id used by the canonical map has a non-empty glyph', () => {
    const ids = new Set<ToolIconId>([...Object.values(TOOL_ICON_MAP), 'fallback']);
    for (const id of ids) {
      expect(TOOL_GLYPHS[id], `glyph for "${id}"`).toBeTypeOf('string');
      expect(TOOL_GLYPHS[id].length).toBeGreaterThan(0);
    }
  });

  it('resolves a known tool to its glyph + canonical color', () => {
    const v = getToolVisual('bash');
    expect(v.glyph).toBe(TOOL_GLYPHS.terminal);
    expect(v.color).toBe('#67e8f9'); // terminal = cyan-light, from TOOL_ICON_CONFIG
  });

  it('is case-insensitive and handles aliases', () => {
    expect(getToolVisual('GREP').glyph).toBe(TOOL_GLYPHS.search);
    expect(getToolVisual('shell').glyph).toBe(TOOL_GLYPHS.terminal);
  });

  it('falls back to the neutral glyph+color for unknown / MCP tools', () => {
    const v = getToolVisual('mcp__svc__do_thing');
    expect(v.glyph).toBe(TOOL_GLYPHS.fallback);
    expect(v.color).toBe('#9ca3af');
  });
});

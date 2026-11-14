import { TOOL_ICON_MAP, type ToolIconId } from '@wrongstack/tools/tool-icons';
import { describe, expect, it } from 'vitest';
import { displayWidth } from '../src/terminal-width.js';
import { getToolVisual, TOOL_GLYPHS, toolGlyphSet } from '../src/tool-glyph.js';
import { isBrowserSafeGlyph } from '../src/ui-glyphs.js';

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

describe('browser tool glyph profile', () => {
  const browser = toolGlyphSet('browser');
  const unicode = toolGlyphSet('unicode');
  const ids = new Set<ToolIconId>([...Object.values(TOOL_ICON_MAP), 'fallback']);

  it('covers every icon id with a non-empty glyph', () => {
    for (const id of ids) {
      expect(browser[id], `glyph for "${id}"`).toBeTypeOf('string');
      expect(browser[id].length).toBeGreaterThan(0);
    }
  });

  it('passes isBrowserSafeGlyph and occupies exactly one cell', () => {
    for (const [id, glyph] of Object.entries(browser)) {
      expect(isBrowserSafeGlyph(glyph), `${id} (${glyph})`).toBe(true);
      expect(displayWidth(glyph), `${id} (${glyph})`).toBe(1);
    }
  });

  it('stops tool cards from using the width-unstable search and terminal glyphs', () => {
    expect(browser.search).not.toBe('\u2315');
    expect(browser.terminal).not.toBe('\u2318');
    expect(Object.values(browser)).not.toContain('\u2315');
    expect(Object.values(browser)).not.toContain('\u2318');
  });

  it('maps every unsafe unicode glyph explicitly instead of falling back', () => {
    for (const [id, glyph] of Object.entries(unicode)) {
      if (isBrowserSafeGlyph(glyph)) continue;
      expect(browser[id as ToolIconId], id).not.toBe(glyph);
      expect(browser[id as ToolIconId], id).not.toBe('\u00B7');
    }
  });

  it('leaves already-safe unicode glyphs untouched', () => {
    for (const [id, glyph] of Object.entries(unicode)) {
      if (!isBrowserSafeGlyph(glyph)) continue;
      expect(browser[id as ToolIconId], id).toBe(glyph);
    }
    expect(unicode.search).toBe('\u2315');
  });
});

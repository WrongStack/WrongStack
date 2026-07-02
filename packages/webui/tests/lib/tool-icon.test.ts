import { TOOL_ICON_MAP, type ToolIconId } from '@wrongstack/tools/tool-icons';
import { describe, expect, it } from 'vitest';
import { getToolVisual, getToolTooltip, TOOL_CATEGORY_LABELS, TOOL_LUCIDE } from '@/lib/tool-icon';

describe('tool-icon (webui per-tool lucide + color)', () => {
  it('every icon id used by the canonical map has a lucide component', () => {
    const ids = new Set<ToolIconId>([...Object.values(TOOL_ICON_MAP), 'fallback']);
    for (const id of ids) {
      expect(TOOL_LUCIDE[id], `lucide component for "${id}"`).toBeDefined();
    }
  });

  it('resolves a known tool to its lucide component + canonical color', () => {
    const v = getToolVisual('bash');
    expect(v.Icon).toBe(TOOL_LUCIDE.terminal);
    expect(v.color).toBe('#67e8f9'); // terminal = cyan-light, from TOOL_ICON_CONFIG
  });

  it('is case-insensitive and handles aliases', () => {
    expect(getToolVisual('GREP').Icon).toBe(TOOL_LUCIDE.search);
    expect(getToolVisual('shell').Icon).toBe(TOOL_LUCIDE.terminal);
  });

  it('falls back for unknown / MCP tools', () => {
    const v = getToolVisual('mcp__svc__do_thing');
    expect(v.Icon).toBe(TOOL_LUCIDE.fallback);
    expect(v.color).toBe('#9ca3af');
  });
});

describe('getToolTooltip', () => {
  it('returns category and color name for known tools', () => {
    expect(getToolTooltip('bash')).toBe('shell commands — cyan-light');
    expect(getToolTooltip('read')).toBe('file read/write — blue');
    expect(getToolTooltip('grep')).toBe('search & grep — violet');
  });

  it('returns fallback description for unknown tools', () => {
    const tooltip = getToolTooltip('mcp__unknown__tool');
    expect(tooltip).toContain('external tool');
    expect(tooltip).toContain('gray');
  });

  it('handles case-insensitive tool names', () => {
    expect(getToolTooltip('BASH')).toBe('shell commands — cyan-light');
    expect(getToolTooltip('Shell')).toBe('shell commands — cyan-light');
  });
});

describe('TOOL_CATEGORY_LABELS', () => {
  it('has an entry for every ToolIconId', () => {
    const ids = new Set<ToolIconId>([...Object.values(TOOL_ICON_MAP), 'fallback']);
    for (const id of ids) {
      expect(TOOL_CATEGORY_LABELS[id], `category label for "${id}"`).toBeDefined();
      expect(typeof TOOL_CATEGORY_LABELS[id]).toBe('string');
      expect(TOOL_CATEGORY_LABELS[id].length).toBeGreaterThan(0);
    }
  });
});

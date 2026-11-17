// Per-tool glyph + color for the TUI.
//
// The terminal can't render SVGs, so each canonical ToolIconId maps to a single
// unicode glyph here. The COLOR comes from the shared `TOOL_ICON_CONFIG`
// (`@wrongstack/tools/tool-icons`) — the exact same hex the WebUI uses — so both
// surfaces stay in sync. Color is the primary differentiator: even if a glyph
// doesn't render in some font, the color still carries tool identity.
//
// Add new tools to TOOL_ICON_MAP in @wrongstack/tools, not here — this table is
// keyed by ToolIconId, which already covers every built-in.

import { getToolIcon, TOOL_ICON_CONFIG, type ToolIconId } from '@wrongstack/tools/tool-icons';
import { displayWidth } from './terminal-width.js';
import { type IconStyle, isBrowserSafeGlyph, resolveIconStyle } from './ui-glyphs.js';

/**
 * Canonical ToolIconId → single-width terminal glyph. Chosen from ranges with
 * broad monospace coverage (Geometric Shapes / Dingbats / Math Operators).
 */
const UNICODE_TOOL_GLYPHS: Record<ToolIconId, string> = {
  file: '▤',
  edit: '✎',
  search: '⌕',
  folder: '▣',
  terminal: '⌘',
  web: '◈',
  git: '⎇',
  tree: '☰',
  code: '⚙',
  test: '⚗',
  package: '⬢',
  document: '☷',
  scaffold: '✱',
  todo: '☐',
  plan: '❖',
  task: '▪',
  meta: '❏',
  index: '⊛',
  json: '⌗',
  diff: '∆',
  logs: '≡',
  settings: '⚙',
  brain: '✦',
  fallback: '•',
};

const NERD_TOOL_GLYPHS: Record<ToolIconId, string> = {
  file: '󰈙',
  edit: '󰏫',
  search: '',
  folder: '󰉋',
  terminal: '',
  web: '󰖟',
  git: '',
  tree: '󰙅',
  code: '',
  test: '󰙨',
  package: '',
  document: '󰈙',
  scaffold: '󰛦',
  todo: '󰄬',
  plan: '󰈙',
  task: '󰄬',
  meta: '󰒓',
  index: '󰌨',
  json: '',
  diff: '',
  logs: '󰌱',
  settings: '󰒓',
  brain: '󰧑',
  fallback: '•',
};

const ASCII_TOOL_GLYPHS: Record<ToolIconId, string> = Object.fromEntries(
  (Object.keys(UNICODE_TOOL_GLYPHS) as ToolIconId[]).map((id) => [id, '*']),
) as Record<ToolIconId, string>;

/**
 * Width-unstable tool symbols replaced on browser hosts: the same rule as the
 * chrome profile in `ui-glyphs.ts`. `⌕`, `⌘`, `⎇`, `☰`, `⚙`, `⛨`-class glyphs
 * have no coverage in the fonts an xterm.js surface defaults to, and `⚗`/`✱`
 * fall back to a different font whose cell width differs from what Yoga
 * measured. Safe glyphs (`▤`, `▣`, `◈`, `▪`, `•`) are inherited unchanged.
 */
const BROWSER_TOOL_REMAP: Partial<Record<ToolIconId, string>> = Object.freeze({
  edit: 'e',
  search: '?',
  terminal: '$',
  git: '╋',
  tree: '└',
  code: '<',
  test: 'T',
  package: '▫',
  document: '▥',
  scaffold: '+',
  todo: '□',
  plan: '◆',
  meta: '▢',
  index: '+',
  json: '{',
  diff: '±',
  logs: '=',
  settings: '*',
  brain: '*',
});

const BROWSER_TOOL_GLYPHS: Record<ToolIconId, string> = Object.fromEntries(
  (Object.keys(UNICODE_TOOL_GLYPHS) as ToolIconId[]).map((id) => {
    const substitute = BROWSER_TOOL_REMAP[id];
    if (substitute !== undefined) return [id, substitute];
    // Completeness is enforced by tool-glyph.test.ts; '·' stays narrow and
    // visible instead of painting tofu or a two-cell fallback.
    const value = UNICODE_TOOL_GLYPHS[id];
    return [id, isBrowserSafeGlyph(value) ? value : '·'];
  }),
) as Record<ToolIconId, string>;

/**
 * `icons = ascii`: the Nerd table with each glyph a browser-safe one of the same
 * cell width (the rule `ui-glyphs.ts` applies to the chrome).
 */
const NERD_FALLBACK_TOOL_GLYPHS: Record<ToolIconId, string> = Object.fromEntries(
  (Object.keys(NERD_TOOL_GLYPHS) as ToolIconId[]).map((id) => {
    const value = NERD_TOOL_GLYPHS[id];
    const safe = isBrowserSafeGlyph(value) ? value : BROWSER_TOOL_GLYPHS[id];
    const missing = displayWidth(value) - displayWidth(safe);
    return [id, missing > 0 ? safe + ' '.repeat(missing) : safe];
  }),
) as Record<ToolIconId, string>;

/** Tool-icon table for one icon style, independent of ambient environment. */
export function toolGlyphSet(style: IconStyle): Record<ToolIconId, string> {
  if (style === 'nerd') return NERD_TOOL_GLYPHS;
  if (style === 'fallback') return NERD_FALLBACK_TOOL_GLYPHS;
  if (style === 'ascii') return ASCII_TOOL_GLYPHS;
  if (style === 'browser') return BROWSER_TOOL_GLYPHS;
  return UNICODE_TOOL_GLYPHS;
}

/** Active per-tool glyph profile, selected once at TUI startup. */
export const TOOL_GLYPHS: Record<ToolIconId, string> = toolGlyphSet(resolveIconStyle());

export interface ToolVisual {
  /** Single-width terminal glyph for the tool. */
  glyph: string;
  /** Canonical hex color (same value the WebUI uses). */
  color: string;
}

/**
 * Resolve a tool name to its `{ glyph, color }` for TUI rendering.
 * Unknown / MCP / plugin tools fall back to the neutral `•` glyph + gray color.
 */
export function getToolVisual(name: string): ToolVisual {
  const id = getToolIcon(name);
  return { glyph: TOOL_GLYPHS[id], color: TOOL_ICON_CONFIG[id].color };
}

/** A coherent, switchable glyph language for TUI chrome. */

import { parseIconSetting } from '@wrongstack/contracts/types';
import { detectTerminalHost } from '@wrongstack/core/utils';
import { detectNerdFontTerminal } from './nerd-font-terminal.js';
import { displayWidth } from './terminal-width.js';

/**
 * - `nerd`: Nerd Font icons + Powerline separators.
 * - `fallback`: what `icons = ascii` selects; the Nerd layout with every glyph
 *   swapped for a browser-safe one of the same cell width.
 * - `unicode`, `browser`, `ascii`: picked only through `WRONGSTACK_TUI_ICON_STYLE`
 *   (and `browser` for browser-hosted terminals under `auto`); `ascii` is the
 *   full-output conversion behind `--ascii`.
 */
export type IconStyle = 'unicode' | 'nerd' | 'fallback' | 'ascii' | 'browser';

interface UiGlyphs {
  brand: string;
  prompt: string;
  success: string;
  failure: string;
  warning: string;
  info: string;
  idle: string;
  running: string;
  /** Paused — a process / phase / mission that is alive but not advancing. */
  pause: string;
  pending: string;
  folder: string;
  workingDirectory: string;
  goal: string;
  clock: string;
  gitBranch: string;
  sessions: string;
  tools: string;
  save: string;
  audit: string;
  plan: string;
  task: string;
  fleet: string;
  bug: string;
  mail: string;
  peers: string;
  desktop: string;
  web: string;
  terminal: string;
  context: string;
  cost: string;
  index: string;
  queue: string;
  process: string;
  cpu: string;
  brain: string;
  palette: string;
  auto: string;
  segmentStart: string;
  segmentTransition: string;
  segmentEnd: string;
  // ── Sidebar ornament set ────────────────────────────────────────────
  // A purpose-built glyph vocabulary for the right-rail cards: capsuled
  // status pills, modern dividers, accent corner brackets, micro spark
  // cells, and a four-step progress ladder. These are the atoms the
  // upgraded SidebarPanelFrame and SidebarContent compose into the
  // dense, "mission-control" feel.
  pillLeft: string;
  pillRight: string;
  pillDot: string;
  railHeavy: string;
  railMid: string;
  railLight: string;
  cornerTL: string;
  cornerTR: string;
  cornerBL: string;
  cornerBR: string;
  edgeT: string;
  edgeB: string;
  dividerDot: string;
  dividerDash: string;
  dividerWave: string;
  dividerDiamond: string;
  meterFull: string;
  meter7: string;
  meter5: string;
  meter3: string;
  meterEmpty: string;
  meterLight: string;
  ladder: string;
  ladderFull: string;
  ladderStep: string;
  arrowRight: string;
  arrowDoubleRight: string;
  arrowUp: string;
  arrowDown: string;
  pulseHigh: string;
  pulseMid: string;
  pulseLow: string;
  diamond: string;
  diamondOpen: string;
  triangleUp: string;
  triangleDown: string;
  triangleRight: string;
  barFull: string;
  barEmpty: string;
  barFade: string;
  blockStack: string;
  block: string;
  spike: string;
  star4: string;
  star8: string;
  ring: string;
  dot: string;
  target: string;
  hash: string;
  at: string;
  link: string;
  lock: string;
  unlock: string;
  bell: string;
  zap: string;
  filter: string;
  search: string;
  tag: string;
  flame: string;
  sparkle: string;
  pin: string;
  bookmark: string;
  flag: string;
  shield: string;
  check: string;
  cross: string;
  bullet: string;
  bulletOpen: string;
  bulletSquare: string;
  bulletHalf: string;
  bulletQuarter: string;
  bulletThreeQuarter: string;
  sparkHi: string;
  sparkMid: string;
  sparkLo: string;
  sparkEmpty: string;
  segmentStartLine: string;
  segmentTransitionLine: string;
  segmentEndLine: string;
  cell0: string;
  cell1: string;
  cell2: string;
  cell3: string;
  cell4: string;
  cell5: string;
  cell6: string;
  cell7: string;
  cell8: string;
  cellFull: string;
  cellEmpty: string;
  indent: string;
  treeLast: string;
  treeBranch: string;
  treeThrough: string;
}

const UNICODE: UiGlyphs = Object.freeze({
  brand: '◆',
  prompt: '❯',
  success: '✓',
  failure: '×',
  warning: '!',
  info: 'i',
  idle: '●',
  running: '▶',
  pause: '⏸',
  pending: '○',
  folder: '▣',
  workingDirectory: '⌁',
  goal: '◎',
  clock: '◷',
  gitBranch: '⎇',
  sessions: '⧉',
  tools: '⚙',
  save: '▰',
  audit: '△',
  plan: '☷',
  task: '◆',
  fleet: '◈',
  bug: '◇',
  mail: '✉',
  peers: '⧉',
  desktop: '▤',
  web: '◈',
  terminal: '⌘',
  context: '◔',
  cost: '$',
  index: '⊛',
  queue: '◴',
  process: '⚡',
  cpu: '▦',
  brain: '✦',
  palette: '🎨',
  auto: '◴',
  segmentStart: '◖',
  segmentTransition: '▶',
  segmentEnd: '◗',
  // ── Sidebar ornaments (unicode) ──
  pillLeft: '⟦',
  pillRight: '⟧',
  pillDot: '·',
  railHeavy: '▌',
  railMid: '▎',
  railLight: '▏',
  cornerTL: '╭',
  cornerTR: '╮',
  cornerBL: '╰',
  cornerBR: '╯',
  edgeT: '┬',
  edgeB: '┴',
  dividerDot: '·',
  dividerDash: '─',
  dividerWave: '〰',
  dividerDiamond: '◆',
  meterFull: '█',
  meter7: '▉',
  meter5: '▌',
  meter3: '▎',
  meterEmpty: '░',
  meterLight: '·',
  ladder: '▰',
  ladderFull: '▰',
  ladderStep: '▱',
  arrowRight: '▸',
  arrowDoubleRight: '▹',
  arrowUp: '△',
  arrowDown: '▽',
  pulseHigh: '●',
  pulseMid: '◉',
  pulseLow: '○',
  diamond: '◆',
  diamondOpen: '◇',
  triangleUp: '▲',
  triangleDown: '▼',
  triangleRight: '▶',
  barFull: '█',
  barEmpty: '░',
  barFade: '▒',
  blockStack: '▤',
  block: '▮',
  spike: '✦',
  star4: '✦',
  star8: '✸',
  ring: '◯',
  dot: '·',
  target: '◎',
  hash: '#',
  at: '@',
  link: '⌘',
  lock: '⚿',
  unlock: '⚷',
  bell: '◔',
  zap: '⚡',
  filter: '⌕',
  search: '⌕',
  tag: '◧',
  flame: '✷',
  sparkle: '✦',
  pin: '⎗',
  bookmark: '⎘',
  flag: '⚑',
  shield: '⛨',
  check: '✓',
  cross: '×',
  bullet: '●',
  bulletOpen: '○',
  bulletSquare: '▪',
  bulletHalf: '◐',
  bulletQuarter: '◓',
  bulletThreeQuarter: '◶',
  sparkHi: '◆',
  sparkMid: '◇',
  sparkLo: '○',
  sparkEmpty: '·',
  segmentStartLine: '◖',
  segmentTransitionLine: '◀',
  segmentEndLine: '◗',
  cell0: '▁',
  cell1: '▂',
  cell2: '▃',
  cell3: '▄',
  cell4: '▅',
  cell5: '▆',
  cell6: '▇',
  cell7: '█',
  cell8: '█',
  cellFull: '█',
  cellEmpty: '░',
  indent: '  ',
  treeLast: '└─',
  treeBranch: '├─',
  treeThrough: '│ ',
});

// Nerd Font profile: chosen by `icons = nerd`, or by `auto` on a terminal known
// to draw these glyphs (see resolveIconStyle). Unreadable without the font.
const NERD: UiGlyphs = Object.freeze({
  ...UNICODE,
  brand: '󰚩',
  prompt: '❯',
  folder: '󰉋',
  workingDirectory: '󰉋',
  goal: '󰄉',
  clock: '󰥔',
  gitBranch: '',
  sessions: '󰍹',
  tools: '󰒓',
  save: '󰆓',
  plan: '󰈙',
  task: '󰄬',
  fleet: '󰓾',
  bug: '󰃤',
  // Trailing space neutralises the wide private-use-area glyph bleeding
  // into the next cell on terminals that draw nerd-font PUA icons at 2
  // columns (e.g. Windows Terminal + Cascadia/Consolas fallbacks) so the
  // mailbox unread chip `mailbox  N new` keeps a visible gap before the
  // count. Unicode ✉ and ASCII 'm' are narrow, so this only matters here.
  mail: '󰇮 ',
  peers: '󰀉',
  desktop: '󰍹',
  web: '󰖟',
  terminal: '',
  context: '󰓡',
  index: '󰌨',
  brain: '󰧑',
  palette: '󰏘',
  segmentStart: '',
  segmentTransition: '',
  segmentEnd: '',
});

const ASCII: UiGlyphs = Object.freeze({
  brand: '*',
  prompt: '>',
  success: '+',
  failure: 'x',
  warning: '!',
  info: 'i',
  idle: 'o',
  running: '>',
  pause: '||',
  pending: '.',
  folder: 'd',
  workingDirectory: '/',
  goal: '@',
  clock: 't',
  gitBranch: 'git',
  sessions: '#',
  tools: '*',
  save: 's',
  audit: '!',
  plan: '=',
  task: '+',
  fleet: '%',
  bug: 'b',
  mail: 'm',
  peers: 'p',
  desktop: 'T',
  web: 'W',
  terminal: '$',
  context: 'c',
  cost: '$',
  index: 'i',
  queue: 'q',
  process: '!',
  cpu: 'c',
  brain: '*',
  palette: 'th:',
  auto: 'a',
  segmentStart: '[',
  segmentTransition: '>',
  segmentEnd: ']',
  // ── Sidebar ornaments (ASCII) ──
  pillLeft: '[',
  pillRight: ']',
  pillDot: '.',
  railHeavy: '|',
  railMid: '|',
  railLight: '|',
  cornerTL: '+',
  cornerTR: '+',
  cornerBL: '+',
  cornerBR: '+',
  edgeT: '+',
  edgeB: '+',
  dividerDot: '.',
  dividerDash: '-',
  dividerWave: '~',
  dividerDiamond: '*',
  meterFull: '#',
  meter7: '#',
  meter5: '#',
  meter3: '=',
  meterEmpty: '.',
  meterLight: '.',
  ladder: '#',
  ladderFull: '#',
  ladderStep: '=',
  arrowRight: '>',
  arrowDoubleRight: '>>',
  arrowUp: '^',
  arrowDown: 'v',
  pulseHigh: '@',
  pulseMid: 'o',
  pulseLow: '.',
  diamond: '*',
  diamondOpen: 'o',
  triangleUp: '^',
  triangleDown: 'v',
  triangleRight: '>',
  barFull: '#',
  barEmpty: '.',
  barFade: '=',
  blockStack: '#',
  block: '#',
  spike: '*',
  star4: '*',
  star8: '*',
  ring: 'o',
  dot: '.',
  target: '@',
  hash: '#',
  at: '@',
  link: '$',
  lock: 'L',
  unlock: 'l',
  bell: '!',
  zap: '!',
  filter: 'F',
  search: '?',
  tag: 'T',
  flame: 'F',
  sparkle: '*',
  pin: 'P',
  bookmark: 'B',
  flag: 'F',
  shield: 'S',
  check: '+',
  cross: 'x',
  bullet: 'o',
  bulletOpen: '.',
  bulletSquare: '#',
  bulletHalf: 'o',
  bulletQuarter: 'o',
  bulletThreeQuarter: 'o',
  sparkHi: '#',
  sparkMid: '*',
  sparkLo: 'o',
  sparkEmpty: '.',
  segmentStartLine: '[',
  segmentTransitionLine: '<',
  segmentEndLine: ']',
  cell0: '_',
  cell1: '.',
  cell2: ',',
  cell3: '-',
  cell4: '=',
  cell5: '+',
  cell6: '*',
  cell7: '#',
  cell8: '#',
  cellFull: '#',
  cellEmpty: '_',
  indent: '  ',
  treeLast: '`-',
  treeBranch: '|-',
  treeThrough: '| ',
});

/**
 * Code-point ranges a browser terminal can be relied on to render: the blocks
 * that monospace fonts must ship for terminal UIs. Anything outside them risks a
 * fallback font whose cell width disagrees with `string-width`, which reflows
 * rows and tears the frame apart — the failure mode this profile exists to stop.
 *
 * Claimed coverage: ASCII + Latin-1, dashes/ellipsis/bullet, arrows, `√`, box
 * drawing, block elements, geometric shapes, and `✓`/`✗` — present in Menlo,
 * Consolas, Cascadia Mono, DejaVu Sans Mono, Liberation Mono and JetBrains Mono,
 * the fonts xterm.js surfaces default to or fall back on.
 */
export const BROWSER_SAFE_CODE_POINTS: ReadonlyArray<readonly [number, number]> = Object.freeze([
  [0x0020, 0x007e], // ASCII printable
  [0x00a0, 0x00ff], // Latin-1 (×, ·, », ±)
  [0x2013, 0x2014], // – —
  [0x2016, 0x2016], // ‖
  [0x2022, 0x2022], // •
  [0x2026, 0x2026], // …
  [0x2190, 0x2195], // arrows
  [0x221a, 0x221a], // √
  [0x2500, 0x257f], // box drawing
  [0x2580, 0x259f], // block elements
  [0x25a0, 0x25ff], // geometric shapes
  [0x2713, 0x2713], // ✓
  [0x2717, 0x2717], // ✗
] as const);

function isBrowserSafeCodePoint(codePoint: number): boolean {
  return BROWSER_SAFE_CODE_POINTS.some(([low, high]) => codePoint >= low && codePoint <= high);
}

/** True when every code point of `glyph` sits in a browser-safe range. */
export function isBrowserSafeGlyph(glyph: string): boolean {
  if (glyph.length === 0) return false;
  for (const char of glyph) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined || !isBrowserSafeCodePoint(codePoint)) return false;
  }
  return true;
}

/**
 * Width-unstable base symbols replaced for browser hosts.
 *
 * Each entry is a symbol that either has no glyph in common monospace fonts
 * (⎇, ⌕, ⚿, ⚷, ⎗, ⎘, ⛨, ⌘, ❯, …) or has an emoji presentation whose cell
 * width differs between fonts and `string-width` (⚡, 🎨, ⚙, ✉). The substitutes
 * are deliberately plain; colour and placement carry the meaning instead.
 */
const BROWSER_REMAP: Partial<Record<keyof UiGlyphs, string>> = Object.freeze({
  prompt: '>',
  pause: '‖',
  workingDirectory: '/',
  gitBranch: '╋',
  sessions: '▥',
  peers: '▥',
  tools: '*',
  plan: '=',
  mail: '@',
  terminal: '$',
  index: '+',
  process: '!',
  brain: '*',
  palette: '◑',
  pillLeft: '[',
  pillRight: ']',
  dividerWave: '~',
  lock: 'L',
  unlock: 'l',
  link: '$',
  zap: '!',
  filter: 'F',
  search: '?',
  flame: '*',
  sparkle: '*',
  pin: 'P',
  bookmark: 'B',
  flag: 'F',
  shield: 'S',
  spike: '*',
  star4: '*',
  star8: '*',
});

function buildBrowserGlyphs(): UiGlyphs {
  const entries = Object.entries(UNICODE).map(([key, value]): [string, string] => {
    const substitute = BROWSER_REMAP[key as keyof UiGlyphs];
    if (substitute !== undefined) return [key, substitute];
    // Completeness is enforced by ui-glyphs.test.ts; '·' keeps an unmapped
    // newcomer narrow and visible instead of painting tofu.
    return [key, isBrowserSafeGlyph(value) ? value : '·'];
  });
  return Object.fromEntries(entries) as unknown as UiGlyphs;
}

/**
 * Browser profile: UNICODE with every width-unstable symbol replaced by a
 * single-cell glyph from a range common monospace fonts actually cover.
 */
const BROWSER: UiGlyphs = Object.freeze(buildBrowserGlyphs());

/**
 * The `icons = ascii` profile: the Nerd layout, readable in any monospace font.
 *
 * Built key by key from NERD, never by hand, so it cannot drift from the layout
 * it stands in for. A glyph that is already browser-safe is kept; anything else
 * (a private-use Nerd icon, a Powerline separator, a symbol common fonts lack)
 * takes the browser profile's single-cell substitute. Each result is padded to
 * the Nerd glyph's measured width, so every chip and rail measures exactly as it
 * does with Nerd icons and nothing shifts. `prompt` is exempt: the `❯` prompt is
 * matched by the tools that supervise WrongStack and stays as it is.
 */
function buildNerdFallbackGlyphs(): UiGlyphs {
  const entries = Object.entries(NERD).map(([key, value]): [string, string] => {
    if (key === 'prompt') return [key, value];
    const safe = isBrowserSafeGlyph(value) ? value : BROWSER[key as keyof UiGlyphs];
    const missing = displayWidth(value) - displayWidth(safe);
    return [key, missing > 0 ? safe + ' '.repeat(missing) : safe];
  });
  return Object.fromEntries(entries) as unknown as UiGlyphs;
}

const NERD_FALLBACK: UiGlyphs = Object.freeze(buildNerdFallbackGlyphs());

/** Environment variable that carries the `icons` setting (`--icons` writes it). */
const ICONS_ENV = 'WSTACK_ICONS';

function envFlag(value: string | undefined): boolean | undefined {
  const raw = value?.trim().toLowerCase();
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
  return undefined;
}

let processTerminalDrawsNerd: boolean | undefined;

/** Reads terminal config files at most once for the real process environment. */
function terminalDrawsNerd(env: NodeJS.ProcessEnv): boolean {
  if (env !== process.env) return detectNerdFontTerminal(env);
  processTerminalDrawsNerd ??= detectNerdFontTerminal(env);
  return processTerminalDrawsNerd;
}

/**
 * `icons = auto`. Nerd icons only on evidence that they will draw: an explicit
 * `NERD_FONT=1`, or a terminal known to render them (see nerd-font-terminal.ts).
 * Every other case gets readable characters rather than empty boxes.
 */
function autoIconStyle(
  env: NodeJS.ProcessEnv,
  detectNerdTerminal: (env: NodeJS.ProcessEnv) => boolean,
): IconStyle {
  const nerdFont = envFlag(env['NERD_FONT']);
  if (nerdFont === true) return 'nerd';
  // Browser-hosted terminals (VS Code webview and its Remote-SSH/Containers
  // variants, code-server, Codespaces, Gitpod, Theia, Jupyter, Cloud Shell,
  // Replit, Hyper, Tabby, self-hosted ttyd/gotty) paint with a CSS font stack
  // chosen by the page, so they keep the width-stable `browser` profile.
  if (detectTerminalHost(env).host === 'browser') return 'browser';
  if (nerdFont === undefined && detectNerdTerminal(env)) return 'nerd';
  return 'fallback';
}

/**
 * Precedence: `WSTACK_ICONS` (which `--icons` and the `icons` config key are
 * written into at startup) > `WRONGSTACK_TUI_ICON_STYLE` > auto.
 */
export function resolveIconStyle(
  env: NodeJS.ProcessEnv = process.env,
  detectNerdTerminal: (env: NodeJS.ProcessEnv) => boolean = terminalDrawsNerd,
): IconStyle {
  const source = env ?? {};
  const setting = parseIconSetting(source[ICONS_ENV]);
  if (setting === 'nerd') return 'nerd';
  if (setting === 'ascii') return 'fallback';
  if (setting === 'auto') return autoIconStyle(source, detectNerdTerminal);
  const raw = source['WRONGSTACK_TUI_ICON_STYLE']?.trim().toLowerCase();
  if (raw === 'nerd' || raw === 'nerd-font' || raw === 'nerdfont') return 'nerd';
  if (raw === 'ascii' || raw === 'plain') return 'ascii';
  // Escape hatch for a terminal whose font we cannot inspect: a native terminal
  // configured with a mono font that lacks the ornament glyphs, or a web
  // terminal that exports no host marker.
  if (raw === 'browser' || raw === 'width-safe' || raw === 'safe') return 'browser';
  if (raw) return 'unicode';
  return autoIconStyle(source, detectNerdTerminal);
}

export function glyphSet(style: IconStyle = resolveIconStyle()): UiGlyphs {
  if (style === 'nerd') return NERD;
  if (style === 'fallback') return NERD_FALLBACK;
  if (style === 'ascii') return ASCII;
  if (style === 'browser') return BROWSER;
  return UNICODE;
}

export const glyphs = glyphSet();

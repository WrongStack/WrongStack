/** A coherent, switchable glyph language for TUI chrome. */

import { readdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectTerminalHost } from '@wrongstack/core/utils';

export type IconStyle = 'unicode' | 'nerd' | 'ascii' | 'browser';

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

// Optional Nerd Font profile. Explicit env selection always wins; without it,
// local desktop installs are detected from the OS font directories below.
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

interface FontDirectoryEntry {
  name: string;
  isDirectory: boolean;
}

interface NerdFontDetectionOptions {
  platform?: NodeJS.Platform | undefined;
  homeDir?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  readDirectory?: ((directory: string) => readonly FontDirectoryEntry[]) | undefined;
}

const NERD_FONT_FILE_RE = /nerd[-_ ]?font/i;
const FONT_FILE_RE = /\.(?:otf|ttc|ttf)$/i;
const MAX_FONT_SCAN_ENTRIES = 8_192;
const MAX_FONT_SCAN_DEPTH = 4;

function isRemoteTerminal(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env['SSH_CONNECTION'] || env['SSH_CLIENT'] || env['SSH_TTY']);
}

function fontDirectories(
  platform: NodeJS.Platform,
  homeDir: string,
  env: NodeJS.ProcessEnv,
): string[] {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'win32') {
    return [
      env['LOCALAPPDATA'] ? paths.join(env['LOCALAPPDATA'], 'Microsoft', 'Windows', 'Fonts') : '',
      paths.join(env['SystemRoot'] || 'C:\\Windows', 'Fonts'),
    ].filter(Boolean);
  }
  if (platform === 'darwin') {
    return [paths.join(homeDir, 'Library', 'Fonts'), '/Library/Fonts', '/System/Library/Fonts'];
  }
  return [
    paths.join(homeDir, '.local', 'share', 'fonts'),
    paths.join(homeDir, '.fonts'),
    '/usr/local/share/fonts',
    '/usr/share/fonts',
    ...(env['WSL_DISTRO_NAME'] ? ['/mnt/c/Windows/Fonts'] : []),
  ];
}

function readFontDirectory(directory: string): FontDirectoryEntry[] {
  return readdirSync(directory, { withFileTypes: true }).map((entry) => ({
    name: entry.name,
    isDirectory: entry.isDirectory(),
  }));
}

/**
 * Best-effort local Nerd Font discovery.
 *
 * Font rendering belongs to the terminal host. An SSH server cannot inspect
 * the client's selected font, so remote sessions deliberately stay on the
 * portable Unicode profile unless `WRONGSTACK_TUI_ICON_STYLE=nerd` is set.
 * Local scans are bounded and ignore symlinks to keep TUI module startup fast
 * and deterministic even in unusually large system font trees.
 */
export function hasInstalledNerdFont(options: NerdFontDetectionOptions = {}): boolean {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const env = options.env ?? process.env;
  if (isRemoteTerminal(env)) return false;
  const paths = platform === 'win32' ? path.win32 : path.posix;

  const readDirectory = options.readDirectory ?? readFontDirectory;
  const pending = fontDirectories(platform, homeDir, env).map((directory) => ({
    directory,
    depth: 0,
  }));
  const visited = new Set<string>();
  let scanned = 0;

  while (pending.length > 0 && scanned < MAX_FONT_SCAN_ENTRIES) {
    const current = pending.shift();
    if (!current || visited.has(current.directory)) continue;
    visited.add(current.directory);
    let entries: readonly FontDirectoryEntry[];
    try {
      entries = readDirectory(current.directory);
    } catch {
      continue;
    }
    for (const entry of entries) {
      scanned += 1;
      if (scanned > MAX_FONT_SCAN_ENTRIES) return false;
      if (entry.isDirectory) {
        if (current.depth < MAX_FONT_SCAN_DEPTH) {
          pending.push({
            directory: paths.join(current.directory, entry.name),
            depth: current.depth + 1,
          });
        }
        continue;
      }
      if (FONT_FILE_RE.test(entry.name) && NERD_FONT_FILE_RE.test(entry.name)) return true;
    }
  }
  return false;
}

let installedNerdFont: boolean | undefined;

function detectInstalledNerdFont(env: NodeJS.ProcessEnv): boolean {
  if (env !== process.env) return hasInstalledNerdFont({ env });
  installedNerdFont ??= hasInstalledNerdFont({ env });
  return installedNerdFont;
}

export function resolveIconStyle(
  env: NodeJS.ProcessEnv = process.env,
  detectNerdFont: (env: NodeJS.ProcessEnv) => boolean = detectInstalledNerdFont,
): IconStyle {
  const raw = env.WRONGSTACK_TUI_ICON_STYLE?.trim().toLowerCase();
  if (raw === 'nerd' || raw === 'nerd-font' || raw === 'nerdfont') return 'nerd';
  if (raw === 'ascii' || raw === 'plain') return 'ascii';
  if (raw) return 'unicode';
  // Browser-hosted terminals (VS Code webview and its Remote-SSH/Containers
  // variants, code-server, Codespaces, Gitpod, Theia, Jupyter, Cloud Shell,
  // Replit, Hyper, Tabby, self-hosted ttyd/gotty) paint with a CSS font stack
  // chosen by the page, not a font this process can observe. Private-use Nerd
  // glyphs then render as tofu boxes whose width disagrees with what we
  // measured, breaking the chrome's alignment. Every browser host therefore
  // uses the width-stable `browser` profile; a user who configured a Nerd Font
  // in their editor opts back in with WRONGSTACK_TUI_ICON_STYLE=nerd.
  if (detectTerminalHost(env).host === 'browser') return 'browser';
  return detectNerdFont(env) ? 'nerd' : 'unicode';
}

export function glyphSet(style: IconStyle = resolveIconStyle()): UiGlyphs {
  if (style === 'nerd') return NERD;
  if (style === 'ascii') return ASCII;
  if (style === 'browser') return BROWSER;
  return UNICODE;
}

export const glyphs = glyphSet();

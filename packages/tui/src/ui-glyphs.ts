/** A coherent, switchable glyph language for TUI chrome. */

export type IconStyle = 'unicode' | 'nerd' | 'ascii';

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

// Optional Nerd Font profile. WrongStack never assumes this font is present;
// users opt in with WRONGSTACK_TUI_ICON_STYLE=nerd.
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

export function resolveIconStyle(env: NodeJS.ProcessEnv = process.env): IconStyle {
  const raw = env.WRONGSTACK_TUI_ICON_STYLE?.trim().toLowerCase();
  if (raw === 'nerd' || raw === 'nerd-font' || raw === 'nerdfont') return 'nerd';
  if (raw === 'ascii' || raw === 'plain') return 'ascii';
  return 'unicode';
}

export function glyphSet(style: IconStyle = resolveIconStyle()): UiGlyphs {
  if (style === 'nerd') return NERD;
  if (style === 'ascii') return ASCII;
  return UNICODE;
}

export const glyphs = glyphSet();

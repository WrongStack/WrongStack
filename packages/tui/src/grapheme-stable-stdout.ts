/**
 * Width-stable emoji below Ink.
 *
 * Ink lays text out with string-width, which measures a whole grapheme
 * cluster: `⚠️` (U+26A0 U+FE0F), `👍🏽` and the ZWJ family `👨‍👩‍👧` are each two
 * columns. Many terminals disagree. xterm.js, the emulator inside VS Code,
 * code-server, Codespaces, Jupyter, ttyd and most web terminals, measures code
 * point by code point: the family is six columns there, `⚠️` one, and with its
 * default Unicode 6 table even a plain `🚀` or `✅` is one. tmux, Alacritty,
 * GNOME Terminal and Konsole each have their own variant. Every disagreement
 * moves the rest of the row, borders and sidebar included.
 *
 * Where the terminal is not known to cluster graphemes, this layer rewrites
 * only the text Ink writes, never its escape sequences, and only in ways that
 * keep each cluster's string-width, so Ink's layout and cursor arithmetic stay
 * exactly as Ink computed them:
 *
 * - An emoji sequence (variation selector, skin-tone modifier, ZWJ, keycap or
 *   tag) becomes its first code point, padded with spaces to the cluster's
 *   width: `⚠️` → `⚠ `, `👍🏽` → `👍`, `👨‍👩‍👧` → `👨`, `1️⃣` → `1 `.
 * - A two-column pictograph is drawn from a saved cursor position and the
 *   cursor is then put two columns past it, whatever width the terminal gave
 *   the glyph: `ESC 7`, two blanks, `ESC 8`, glyph, `ESC 8`, `CSI 2 C`. The
 *   move is relative, so no column has to be tracked, and `CSI C` stops at the
 *   right margin. Ink and the TUI never save the cursor themselves.
 *
 * Terminals that cluster graphemes the way string-width does keep the
 * original text (see {@link resolveGraphemePolicy}).
 */

import { detectTerminalHost, type TerminalHostInfo } from '@wrongstack/core/utils';
import { displayWidth } from './terminal-width.js';

export type GraphemePolicy = 'full' | 'safe';

/**
 * Native terminals that segment grapheme clusters and give an emoji sequence
 * the two columns string-width does. Windows Terminal is included because its
 * ConPTY host clusters graphemes too; a browser surface never is.
 */
const GRAPHEME_CLUSTERING_TERMINALS: ReadonlySet<string> = new Set([
  'wezterm',
  'kitty',
  'ghostty',
  'iterm2',
  'windows-terminal',
  'warp',
]);

/**
 * `WRONGSTACK_TUI_GRAPHEMES=full|safe` decides explicitly. Otherwise a browser
 * surface, a multiplexer and any terminal that cannot be identified get the
 * width-stable output; a known clustering terminal gets the text unchanged.
 */
export function resolveGraphemePolicy(
  env: NodeJS.ProcessEnv = process.env,
  host: TerminalHostInfo = detectTerminalHost(env),
): GraphemePolicy {
  const override = env['WRONGSTACK_TUI_GRAPHEMES']?.trim().toLowerCase();
  if (override === 'full' || override === 'native' || override === 'off') return 'full';
  if (override === 'safe' || override === 'stable' || override === 'on') return 'safe';
  if (host.host === 'browser') return 'safe';
  return host.kind !== null && GRAPHEME_CLUSTERING_TERMINALS.has(host.kind) ? 'full' : 'safe';
}

/** Code points that turn a pictograph into a multi-code-point emoji sequence. */
const SEQUENCE_MARK_RE = /\u200D|\uFE0E|\uFE0F|\u20E3|[\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]/u;
const PICTOGRAPH_RE = /\p{Extended_Pictographic}/u;
/** Cheap gate: a chunk without either class passes through untouched. */
const NEEDS_WORK_RE = /\p{Extended_Pictographic}|\u200D|\uFE0E|\uFE0F|\u20E3/u;

/**
 * Escape sequences Ink and the TUI write: CSI, OSC (BEL or ST terminated),
 * DCS/SOS/PM/APC strings and two-byte escapes. Bodies are bounded so an
 * unterminated introducer cannot make the scan quadratic.
 */
const ESCAPE_RE =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]{0,4096}(?:\x07|\x1b\\)|\x1b[P^_X][^\x1b]{0,4096}\x1b\\|\x1b[ -/]*[0-~]/g;

const SAVE_CURSOR = '\x1b7';
const RESTORE_CURSOR = '\x1b8';
const FORWARD_TWO = '\x1b[2C';

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** A two-column pictograph placed so the cursor lands two columns on. */
function pinnedWide(glyph: string): string {
  return `${SAVE_CURSOR}  ${RESTORE_CURSOR}${glyph}${RESTORE_CURSOR}${FORWARD_TWO}`;
}

function stableCluster(cluster: string): string {
  const width = displayWidth(cluster);
  let glyph = cluster;
  let pad = 0;
  if (SEQUENCE_MARK_RE.test(cluster) && cluster.length > 1) {
    const base = String.fromCodePoint(cluster.codePointAt(0) ?? 0x20);
    const baseWidth = displayWidth(base);
    if (baseWidth === 0 || baseWidth > width || SEQUENCE_MARK_RE.test(base)) {
      return ' '.repeat(width);
    }
    glyph = base;
    pad = width - baseWidth;
  }
  const glyphWidth = width - pad;
  const drawn = glyphWidth === 2 && PICTOGRAPH_RE.test(glyph) ? pinnedWide(glyph) : glyph;
  return pad > 0 ? `${drawn}${' '.repeat(pad)}` : drawn;
}

/** Width-stable form of escape-free text; every cluster keeps its string-width. */
export function stabilizeGraphemes(text: string): string {
  if (!NEEDS_WORK_RE.test(text)) return text;
  let out = '';
  for (const { segment } of GRAPHEMES.segment(text)) {
    out += NEEDS_WORK_RE.test(segment) ? stableCluster(segment) : segment;
  }
  return out;
}

/** Applies {@link stabilizeGraphemes} to the text between escape sequences. */
export function stabilizeTerminalOutput(chunk: string): string {
  if (!NEEDS_WORK_RE.test(chunk)) return chunk;
  let out = '';
  let last = 0;
  ESCAPE_RE.lastIndex = 0;
  for (let match = ESCAPE_RE.exec(chunk); match; match = ESCAPE_RE.exec(chunk)) {
    out += stabilizeGraphemes(chunk.slice(last, match.index)) + match[0];
    last = match.index + match[0].length;
  }
  return out + stabilizeGraphemes(chunk.slice(last));
}

type WriteCallback = ((err?: Error | null) => void) | undefined;

/**
 * Stream for Ink's `render({ stdout })` that writes {@link stabilizeTerminalOutput}
 * of every chunk. `enabled: false` returns the target untouched.
 */
export function createGraphemeStableStdout(
  target: NodeJS.WriteStream,
  opts: { enabled?: boolean | undefined } = {},
): NodeJS.WriteStream {
  if (opts.enabled === false) return target;
  const write = (
    chunk: Uint8Array | string,
    encodingOrCb?: BufferEncoding | WriteCallback,
    cb?: WriteCallback,
  ): boolean => {
    const encoding = typeof encodingOrCb === 'string' ? encodingOrCb : undefined;
    const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
    const text =
      typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(encoding ?? 'utf8');
    const stable = stabilizeTerminalOutput(text);
    if (stable === text) {
      if (callback) return target.write(chunk as never, encoding as never, callback as never);
      return encoding ? target.write(chunk as never, encoding) : target.write(chunk as never);
    }
    return callback ? target.write(stable, callback as never) : target.write(stable);
  };
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop === 'write') return write;
      const value: unknown = Reflect.get(obj, prop, receiver);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(obj)
        : value;
    },
  });
}

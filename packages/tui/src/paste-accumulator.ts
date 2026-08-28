// Bracketed-paste accumulation, factored out of the TUI key handler so the
// (fiddly) marker logic can be unit-tested in isolation.
//
// A terminal in bracketed-paste mode wraps pasted text as
// `\x1b[200~<content>\x1b[201~`. The OS/terminal can split that across
// several stdin reads, and Ink's keypress parser sometimes strips the ESC
// byte — leaving a bare `[200~` / `[201~`. So we:
//   - detect both the ESC-prefixed and bare marker forms,
//   - buffer fragments across calls until the closing marker arrives,
//   - hand back the fully-assembled payload exactly once.

import { MAX_PASTE_CHARS } from './input-validation.js';

const BEGIN = '[200~';
const END = '[201~';

interface PasteOverflowState {
  readonly overflow: true;
}

export type PasteAccumState = string | PasteOverflowState | null;

const OVERFLOW_STATE: PasteOverflowState = Object.freeze({ overflow: true });
const BEGIN_RE = /\x1b?\[200~/g;
const END_RE = /\x1b?\[201~/g;
// Partial ANSI CSI without the ESC prefix — Ink strips ESC from sequences
// like \x1b[0m, leaving [0m which would otherwise appear as literal text.
const PARTIAL_ANSI_RE = /^\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/;
const ANSI_RE = new RegExp(
  [
    // CSI: ESC [ params* intermediates* final
    // params 0x30-0x3f (digits, ; : < = > ?)
    // intermediates 0x20-0x2f (space … /)
    // final 0x40-0x7e (@ … ~)
    '\\x1b\\[[\\x30-\\x3f]*[\\x20-\\x2f]*[\\x40-\\x7e]',
    // OSC: ESC ] … BEL (\x07) or ST (\x1b\\)
    '\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)',
    // DCS: ESC P … ST (\x1b\\)
    '\\x1bP[^\\x1b]*(?:\\x1b\\\\)',
    // SOS / PM: ESC X / ESC ^
    '\\x1b[XP][^\\x1b]*(?:\\x1b\\\\)',
    // Standalone ESC — guard only
    '\\x1b',
  ].join('|'),
  'g',
);

interface PasteFeedResult {
  /** New accumulator state: text while buffering, overflow marker, or `null` when idle. */
  accum: PasteAccumState;
  /**
   * The fully-assembled paste payload when an end marker closed it, else
   * `null` (still buffering).
   */
  complete: string | null;
  /** Set when accumulation exceeded the hard paste cap and was discarded. */
  error?: string | undefined;
}

/**
 * Feed one keypress fragment into the paste accumulator.
 *
 * @param accum current accumulator (`null` when idle, object after overflow)
 * @param input the raw keypress string for this event
 * @returns `null` when `input` is not part of a paste (the caller should
 *   handle it as normal input); otherwise the updated accumulation state.
 */
export function feedPaste(accum: PasteAccumState, input: string): PasteFeedResult | null {
  if (accum !== null && typeof accum !== 'string') {
    if (input.includes(END)) return { accum: null, complete: null };
    return { accum: OVERFLOW_STATE, complete: null };
  }
  if (accum === null && !input.includes(BEGIN)) {
    // If input starts with '[' but is not a paste marker, it may be a partial
    // ANSI CSI sequence whose ESC was stripped by Ink. Guard against it
    // appearing as literal text in the input buffer.
    if (input.startsWith('[') && !input.startsWith(BEGIN) && !input.startsWith(END)) {
      // Treat partial ANSI sequences (ESC stripped) as leaked control
      // fragments: swallow them so [0m doesn't leak into the buffer as
      // literal text, BUT do not enter paste mode. Entering accumulation
      // here would make the next ordinary keystrokes look like a continued
      // bracketed paste until the idle flush fires.
      if (PARTIAL_ANSI_RE.test(input)) {
        return { accum: null, complete: null };
      }
      // Bare '[' is not a paste marker and not a known partial ANSI
      // sequence — let it through as ordinary input.
      return null;
    }
    return null;
  }
  // Strip paste markers AND all ANSI sequences before accumulating.
  const piece = input.replace(BEGIN_RE, '').replace(END_RE, '').replace(ANSI_RE, '');
  const current = accum ?? '';
  if (current.length + piece.length > MAX_PASTE_CHARS) {
    return {
      accum: input.includes(END) ? null : OVERFLOW_STATE,
      complete: null,
      error: `Paste rejected: exceeds ${MAX_PASTE_CHARS.toLocaleString()} characters.`,
    };
  }
  const next = current + piece;
  if (input.includes(END)) return { accum: null, complete: next };
  return { accum: next, complete: null };
}

// Bracketed paste mode wraps pasted text with markers so the input layer can
// distinguish a paste from typed chunks.
export const BRACKETED_PASTE_ON = '\x1b[?2004h';
export const BRACKETED_PASTE_OFF = '\x1b[?2004l';

// DECSET 2026 synchronized output framing (BSU / ESU). Emulators buffer screen
// mutations between ON and OFF and present them atomically on scanout; older
// emulators ignore unknown private modes per ECMA-48.
export const SYNC_OUTPUT_ON = '\x1b[?2026h';
export const SYNC_OUTPUT_OFF = '\x1b[?2026l';

// DECRST/DECSET 7 (DECAWM). The TUI lays out every row to the grid width, so
// it never needs the terminal to wrap. When the terminal measures a glyph
// wider than the layout did, autowrap pushes the row's tail onto the next row
// and, on the last row, scrolls the whole frame: one disputed emoji in a
// browser terminal then shifts every row below it. With autowrap off the
// excess is clipped at the right margin and the frame stays where it was.
// The TUI turns it off inside its alternate screen and back on before leaving.
export const AUTOWRAP_OFF = '\x1b[?7l';
export const AUTOWRAP_ON = '\x1b[?7h';

// Quietly delete any active Kitty graphics placements on teardown/modal close.
export const KITTY_DELETE_ALL_IMAGES = '\x1b_Ga=d,d=a,q=2\x1b\\';

// Bracketed paste mode wraps pasted text with markers so the input layer can
// distinguish a paste from typed chunks.
export const BRACKETED_PASTE_ON = '\x1b[?2004h';
export const BRACKETED_PASTE_OFF = '\x1b[?2004l';

// DECSET 2026 synchronized output framing (BSU / ESU). Emulators buffer screen
// mutations between ON and OFF and present them atomically on scanout; older
// emulators ignore unknown private modes per ECMA-48.
export const SYNC_OUTPUT_ON = '\x1b[?2026h';
export const SYNC_OUTPUT_OFF = '\x1b[?2026l';

// Quietly delete any active Kitty graphics placements on teardown/modal close.
export const KITTY_DELETE_ALL_IMAGES = '\x1b_Ga=d,d=a,q=2\x1b\\';

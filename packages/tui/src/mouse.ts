/**
 * SGR mouse protocol (xterm DEC private modes). Mouse tracking and alternate
 * screen mode (?1049h) are independent terminal capabilities; the full-screen
 * TUI enables both and tears both down explicitly.
 *
 *   ?1000h — button press/release tracking (clicks + wheel)
 *   ?1002h — button-event tracking: adds drag (motion while a button is held)
 *   ?1003h — any-event tracking: adds hover (motion with no button) — EXPENSIVE,
 *            one event per cell the cursor crosses; gate behind a setting.
 *   ?1006h — SGR extended coordinates: `ESC [ < b ; x ; y (M|m)`, no 223-col cap.
 *
 * Trade-off: with ANY of these on, the terminal reports the wheel to us as
 * buttons 64/65 instead of scrolling its own scrollback. Shift+wheel (and
 * users keep access to terminal scrollback — but plain wheel events are owned
 * by the app while tracking is active. Managed history therefore keeps
 * button-drag tracking active (click + wheel + held-drag motion) so
 * drag-select-copy works by default; free hover (1003) remains opt-in.
 */

const ESC = String.fromCharCode(27);

/** Click + wheel only (mode 1000). Cheapest; no motion events. */
export const MOUSE_CLICK_ON = `${ESC}[?1000h${ESC}[?1006h`;
/** Click + wheel + drag (motion while a button is held; mode 1002). */
export const MOUSE_DRAG_ON = `${ESC}[?1000h${ESC}[?1002h${ESC}[?1006h`;
/** Click + wheel + free hover (motion with no button; mode 1003). Expensive. */
export const MOUSE_HOVER_ON = `${ESC}[?1000h${ESC}[?1003h${ESC}[?1006h`;
/**
 * Disable every tracking mode. Disabling a mode that was never set is a no-op,
 * so this is safe to send unconditionally on cleanup regardless of which
 * *_ON sequence (if any) was emitted.
 */
export const MOUSE_OFF = `${ESC}[?1003l${ESC}[?1002l${ESC}[?1000l${ESC}[?1006l`;

export interface MouseTrackingPolicy {
  /** Full-session pointer mode (`--mouse`, saved setting, or `/mouse on`). */
  fullMode: boolean;
  /** A picker that benefits from temporary click/wheel ownership is visible. */
  overlayOpen: boolean;
  /**
   * The chat transcript is rendered in a bounded, application-managed
   * viewport. Its wheel must be reported to the app because native terminal
   * scrollback cannot move virtualized content.
   */
  managedHistory: boolean;
  /**
   * The user explicitly handed the mouse back to the terminal (`/mouse native`).
   *
   * This is the ONLY input that can defeat `managedHistory`, and it exists
   * because nothing else could: with tracking on, the terminal reports the
   * wheel to us instead of scrolling, which also means it never starts a
   * native selection — so there was no way to select and copy transcript text
   * with the mouse at all. Native mode trades in-app wheel scrolling (PgUp/
   * PgDn and Ctrl+U/D still page) for that selection.
   *
   * It outranks `overlayOpen` too: letting a picker silently re-grab the mouse
   * would cancel an in-progress drag-selection.
   */
  native?: boolean | undefined;
  /** Startup terminal capability probe. Undefined keeps legacy callers enabled. */
  protocol?: 'none' | 'x10' | 'urxvt' | 'sgr' | undefined;
}

/** Decide whether the TUI should currently own terminal mouse reports. */
export function shouldEnableMouseTracking(policy: MouseTrackingPolicy): boolean {
  // An explicit hand-back wins over every other reason to hold the mouse.
  if (policy.native) return false;
  // This module decodes SGR reports only. Enabling mode 1000 on an X10/URXVT
  // terminal would produce a different byte format and leak it into the composer,
  // so legacy protocols degrade to keyboard/native-scrollback behavior.
  const supportsSgr = policy.protocol === undefined || policy.protocol === 'sgr';
  return supportsSgr && (policy.managedHistory || policy.fullMode || policy.overlayOpen);
}

/**
 * Enter the alternate screen buffer (DECSET 1049). The normal screen is
 * saved and restored on exit.
 */
export const ALT_SCREEN_ON = `${ESC}[?1049h`;

/**
 * Exit the alternate screen buffer (DECRST 1049), restoring the normal screen.
 */
export const ALT_SCREEN_OFF = `${ESC}[?1049l`;

type MouseEventKind = 'press' | 'release' | 'move' | 'wheel';
type MouseButton = 'left' | 'middle' | 'right' | 'none';

export interface MouseEventInfo {
  kind: MouseEventKind;
  button: MouseButton;
  /** 1-based terminal column (matches the SGR report; column 1 = leftmost). */
  x: number;
  /** 1-based terminal row (column 1 = topmost visible row). */
  y: number;
  /** Wheel direction: +1 = up (away from user), -1 = down, 0 = not a wheel event. */
  wheel: number;
  shift: boolean;
  /** Alt/Meta modifier. */
  meta: boolean;
  ctrl: boolean;
  /** True for motion events (button-held drag, or free hover). */
  motion: boolean;
}

// SGR mouse report: ESC [ < Cb ; Cx ; Cy (M|m)
// M = press / motion, m = release. Cb is a bitfield (see decodeMouse below).
const SGR_MOUSE_ANCHORED = new RegExp(`^${ESC}\\[<(\\d+);(\\d+);(\\d+)([Mm])$`, 'u');
// Same, unanchored + global: a fast wheel scroll batches several reports into
// one stdin chunk, and chunks can carry trailing/leading bytes.
const SGR_MOUSE_GLOBAL = new RegExp(`${ESC}\\[<(\\d+);(\\d+);(\\d+)([Mm])`, 'gu');

// Ink doesn't understand mouse reports: it strips the leading ESC and hands the
// rest to useInput as plain text, so an enabled-mouse terminal leaks
// `[<64;10;5M`-style strings into the input buffer. This matches that leaked
// form (ESC already gone). Unanchored — a fast scroll leaks several at once.
const LEAKED_MOUSE_RE = /\[<\d+;\d+;\d+[Mm]/;

/**
 * Decode an SGR Cb bitfield + coords into a structured event.
 *
 * Cb bitfield:
 *   bits 0-1 — button (0 left, 1 middle, 2 right, 3 none/released)
 *   bit  2   — shift          (+4)
 *   bit  3   — meta/alt       (+8)
 *   bit  4   — ctrl           (+16)
 *   bit  5   — motion         (+32)
 *   bit  6   — wheel          (+64; then bits 0-1: 0 up, 1 down, 2/3 horizontal)
 */
function decodeMouse(cb: number, x: number, y: number, released: boolean): MouseEventInfo {
  const shift = (cb & 4) !== 0;
  const meta = (cb & 8) !== 0;
  const ctrl = (cb & 16) !== 0;
  const motion = (cb & 32) !== 0;
  const wheel = (cb & 64) !== 0;
  const low = cb & 3;

  if (wheel) {
    // 64 = up, 65 = down, 66/67 = horizontal scroll (no vertical delta).
    const dir = low === 0 ? 1 : low === 1 ? -1 : 0;
    return { kind: 'wheel', button: 'none', x, y, wheel: dir, shift, meta, ctrl, motion: false };
  }

  const button: MouseButton =
    low === 0 ? 'left' : low === 1 ? 'middle' : low === 2 ? 'right' : 'none';
  const kind: MouseEventKind = motion ? 'move' : released ? 'release' : 'press';
  return { kind, button, x, y, wheel: 0, shift, meta, ctrl, motion };
}

/**
 * Parse a single, whole SGR mouse report into a structured event. Returns null
 * when `data` is not exactly one report.
 */
export function parseMouseEvent(data: string): MouseEventInfo | null {
  const m = data.match(SGR_MOUSE_ANCHORED);
  if (!m) return null;
  return decodeMouse(
    Number.parseInt(m[1] as string, 10),
    Number.parseInt(m[2] as string, 10),
    Number.parseInt(m[3] as string, 10),
    m[4] === 'm',
  );
}

/**
 * Scan raw stdin data for ALL SGR mouse reports, in order. A fast wheel scroll
 * coalesces several reports into one chunk; returns an empty array when the
 * data contains no report.
 */
export function parseMouseEvents(data: string): MouseEventInfo[] {
  const events: MouseEventInfo[] = [];
  for (const m of data.matchAll(SGR_MOUSE_GLOBAL)) {
    events.push(
      decodeMouse(
        Number.parseInt(m[1] as string, 10),
        Number.parseInt(m[2] as string, 10),
        Number.parseInt(m[3] as string, 10),
        m[4] === 'm',
      ),
    );
  }
  return events;
}

/**
 * Longest tail of `data` that is an SGR report the terminal has only partially
 * delivered, split off so the caller can carry it into the next chunk.
 *
 * A report is `ESC [ < b ; x ; y (M|m)` — up to ~18 bytes, and stdin makes no
 * promise about chunk boundaries. A fast drag or a wheel burst readily splits
 * one across two `data` events, and {@link parseMouseEvents} (which scans a
 * single chunk) then matches NEITHER half: the gesture is silently dropped and
 * the leading half falls through to the key parsers as garbage.
 *
 * Only the unambiguous case is held back: a trailing `ESC [ <` with no `M`/`m`
 * terminator after it. A bare trailing `ESC` or `ESC [` is deliberately NOT
 * buffered — a lone `ESC` is how the Esc KEY arrives, and swallowing it would
 * break the Esc ladder outright.
 *
 * The carry is capped: past {@link MAX_PARTIAL_MOUSE} bytes the tail cannot be
 * a real report any more (a malformed or hostile stream), so it is released as
 * ordinary data rather than accumulating forever.
 */
export function splitTrailingMousePartial(data: string): {
  consumed: string;
  pending: string;
} {
  const idx = data.lastIndexOf(`${ESC}[<`);
  if (idx === -1) return { consumed: data, pending: '' };
  const tail = data.slice(idx);
  // A terminator anywhere in the tail means the last report is whole.
  if (/[Mm]/.test(tail)) return { consumed: data, pending: '' };
  if (tail.length > MAX_PARTIAL_MOUSE) return { consumed: data, pending: '' };
  return { consumed: data.slice(0, idx), pending: tail };
}

/** Upper bound on a carried partial report (`ESC[<64;9999;9999M` is 18). */
const MAX_PARTIAL_MOUSE = 24;

/**
 * True when `input` (Ink's already-ESC-stripped text) is a leaked mouse report.
 * The input layer drops these so they never land in the buffer as typed text.
 */
export function isLeakedMouseInput(input: string): boolean {
  return LEAKED_MOUSE_RE.test(input);
}

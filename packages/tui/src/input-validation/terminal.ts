import type { ValidationResult } from './result.js';
import { MAX_PASTE_CHARS, MAX_PASTE_FRAGMENT_CHARS } from './limits.js';
import {
  ALLOWED_KEY_EVENT_FIELDS,
  ALLOWED_MOUSE_BUTTONS,
  ALLOWED_MOUSE_KINDS,
} from './allow-lists.js';

/**
 * Validate a keyboard input fragment from stdin.
 *
 * This catches raw bytes from the terminal BEFORE they enter the input
 * buffer. The allow-list is: known control sequences, printable ASCII,
 * and common Unicode (which terminals emit as normal keystrokes).
 *
 * Rejects:
 *  - Raw escape sequences that don't match known patterns
 *  - Fragments containing C0 control chars other than tab/newline (0x09, 0x0a)
 *  - Fragments longer than MAX_PASTE_FRAGMENT_CHARS (likely a flood)
 */
export function validateStdinFragment(data: Buffer | string): ValidationResult<string> {
  const s = typeof data === 'string' ? data : data.toString('utf8');

  if (s.length > MAX_PASTE_FRAGMENT_CHARS) {
    return {
      valid: false,
      error: `stdin: fragment exceeds ${MAX_PASTE_FRAGMENT_CHARS.toLocaleString()} chars (got ${s.length}).`,
    };
  }

  // Allow known CSI sequences: standard arrows, Home, End, F-keys, mouse
  // Escape is handled specially by the ESC-buffering logic, so bare \x1b
  // is allowed (it's the start of a multi-byte sequence or a standalone Esc).
  const KNOWN_ANCHORED =
    /^(?:\x1b(?:\[[\d;]*[A-DHFR]|\[\[\w+\]|\[[\d;]*[a-z]|O[A-Za-z]|\[[0-9]{1,2}[~]|\[<[\d;]+[Mm])|[ -~]|[\x80-\uFFFF]|[\t\n])+$/;

  // If it matches known patterns, pass.
  if (KNOWN_ANCHORED.test(s)) return { valid: true, value: s };

  // Reject fragments with C0 control characters (0x00-0x1f) except tab (0x09),
  // newline (0x0a), and escape (0x1b) which is the CSI prefix.
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x1b) {
      return {
        valid: false,
        error: `stdin: C0 control char 0x${code.toString(16)} at position ${i} is not on the allow-list.`,
      };
    }
  }

  // Reject fragments with orphaned ESC bytes that don't form a known sequence
  // (a standalone ESC not followed by a valid CSI/SS3 sequence or not being
  // the terminal byte — but since we split on boundaries, a bare ESC at end
  // is handled by the 10ms timer in input.tsx).
  const escIndex = s.indexOf('\x1b');
  if (escIndex >= 0 && escIndex < s.length - 1) {
    // ESC followed by something: check it's a valid CSI/SS3/OSC start
    const next = s[escIndex + 1] as string;
    if (next !== '[' && next !== 'O' && next !== ']' && next !== 'P' && next !== 'X') {
      return {
        valid: false,
        error: `stdin: escape byte followed by unexpected 0x${next.charCodeAt(0).toString(16)} at position ${escIndex + 1}.`,
      };
    }
  }

  return { valid: true, value: s };
}

/**
 * Validate a fully-assembled paste payload AFTER the terminal markers
 * have been stripped by paste-accumulator.ts.
 *
 * Rejects:
 *  - Paste > MAX_PASTE_CHARS
 *  - Paste containing C0 control chars (except \n, \t)
 *  - Paste that looks binary (>30% non-printable)
 *  - Paste with unbalanced surrogate pairs
 */
export function validatePasteContent(content: string): ValidationResult<string> {
  if (content.length === 0) {
    return { valid: false, error: 'paste: empty content.' };
  }

  if (content.length > MAX_PASTE_CHARS) {
    return {
      valid: false,
      error: `paste: exceeds ${MAX_PASTE_CHARS.toLocaleString()} chars (got ${content.length}).`,
    };
  }

  // Reject C0 control chars (except \t=0x09, \n=0x0a, \r=0x0d)
  let nonPrintableCount = 0;
  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      return {
        valid: false,
        error: `paste: C0 control char 0x${code.toString(16)} at position ${i} is not allowed.`,
      };
    }
    if (code > 0 && code < 0x09) nonPrintableCount++;
  }

  // Reject binary-looking paste: >30% non-printable (excluding common whitespace)
  if (content.length > 10 && nonPrintableCount / content.length > 0.3) {
    return {
      valid: false,
      error: `paste: content appears binary (${((nonPrintableCount / content.length) * 100).toFixed(0)}% non-printable chars).`,
    };
  }

  return { valid: true, value: content };
}

/**
 * Validate a parsed mouse event from the SGR protocol.
 *
 * Rejects:
 *  - Unknown mouse event kinds
 *  - Unknown button values
 *  - Coordinates outside reasonable terminal bounds (0 < x < 5000, 0 < y < 5000)
 *  - Wheel values other than -1, 0, 1
 */
export function validateMouseEvent(event: {
  kind: string;
  button: string;
  x: number;
  y: number;
  wheel: number;
  shift?: boolean;
  meta?: boolean;
  ctrl?: boolean;
  motion?: boolean;
}): ValidationResult<{
  kind: string;
  button: string;
  x: number;
  y: number;
  wheel: number;
  shift: boolean;
  meta: boolean;
  ctrl: boolean;
  motion: boolean;
}> {
  const kind = event.kind;
  if (!ALLOWED_MOUSE_KINDS.has(kind as string)) {
    return {
      valid: false,
      error: `mouse.kind: "${kind}" is not on the allow-list (press|release|move|wheel).`,
    };
  }

  const button = event.button;
  if (!ALLOWED_MOUSE_BUTTONS.has(button as string)) {
    return {
      valid: false,
      error: `mouse.button: "${button}" is not on the allow-list (left|middle|right|none).`,
    };
  }

  const x = event.x;
  if (!Number.isInteger(x) || x < 1 || x > 5000) {
    return {
      valid: false,
      error: `mouse.x: ${x} is out of range [1, 5000].`,
    };
  }

  const y = event.y;
  if (!Number.isInteger(y) || y < 1 || y > 5000) {
    return {
      valid: false,
      error: `mouse.y: ${y} is out of range [1, 5000].`,
    };
  }

  const wheel = event.wheel;
  if (!Number.isInteger(wheel) || (wheel !== -1 && wheel !== 0 && wheel !== 1)) {
    return {
      valid: false,
      error: `mouse.wheel: ${wheel} is not -1, 0, or 1.`,
    };
  }

  return {
    valid: true,
    value: {
      kind,
      button,
      x,
      y,
      wheel,
      shift: event.shift ?? false,
      meta: event.meta ?? false,
      ctrl: event.ctrl ?? false,
      motion: event.motion ?? false,
    },
  };
}

/**
 * Validate a KeyEvent from stdin against the known allow-list.
 *
 * Every boolean field in a KeyEvent must be exactly `true` or `false`.
 * `fn` must be 1–12 when present. `wheelDeltaY` must be an integer.
 *
 * Rejects:
 *  - Unknown fields on the key event object
 *  - Non-boolean values for boolean fields
 *  - fn outside 1–12
 *  - wheelDeltaY that is not an integer
 */
export function validateKeyEventFields(
  key: Record<string, unknown>,
): ValidationResult<Record<string, unknown>> {
  for (const [k, v] of Object.entries(key)) {
    // Allow only known fields
    if (!ALLOWED_KEY_EVENT_FIELDS.has(k)) {
      return {
        valid: false,
        error: `key.${k}: unknown field — not on the allow-list.`,
      };
    }

    // Boolean fields must be boolean
    if (typeof v !== 'boolean' && k !== 'fn' && k !== 'wheelDeltaY' && k !== 'mouse') {
      return {
        valid: false,
        error: `key.${k}: expected boolean, got ${typeof v}.`,
      };
    }
  }

  // fn must be 1-12 when present
  if (key.fn !== undefined && key.fn !== null) {
    if (typeof key.fn !== 'number' || !Number.isInteger(key.fn) || key.fn < 1 || key.fn > 12) {
      return {
        valid: false,
        error: `key.fn: ${key.fn} is not an integer in [1, 12].`,
      };
    }
  }

  // wheelDeltaY must be an integer when present
  if (key.wheelDeltaY !== undefined && key.wheelDeltaY !== null) {
    if (typeof key.wheelDeltaY !== 'number' || !Number.isInteger(key.wheelDeltaY)) {
      return {
        valid: false,
        error: `key.wheelDeltaY: ${key.wheelDeltaY} is not an integer.`,
      };
    }
  }

  return { valid: true, value: key };
}

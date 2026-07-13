import { toErrorMessage } from './error.js';

export interface SafeParseResult<T> {
  ok: boolean;
  value?: T | undefined;
  error?: string | undefined;
}

export function safeParse<T = unknown>(input: string, maxBytes = 5_000_000): SafeParseResult<T> {
  if (Buffer.byteLength(input, 'utf8') > maxBytes) {
    return { ok: false, error: `Input exceeds limit (${maxBytes} bytes)` };
  }
  try {
    return { ok: true, value: JSON.parse(input) as T };
  } catch (err) {
    return {
      ok: false,
      error: toErrorMessage(err),
    };
  }
}

export function safeStringify(value: unknown, pretty = false): string {
  const seen = new WeakSet();
  const replacer = (_k: string, v: unknown): unknown => {
    if (typeof v === 'bigint') return v.toString();
    if (v instanceof Error) {
      return { name: v.name, message: v.message, stack: v.stack };
    }
    if (typeof v === 'object' && v !== null) {
      if (seen.has(v as object)) return '[Circular]';
      // WeakSet.add can throw for non-extensible objects or proxies —
      // skip cycle tracking for that value rather than failing entirely.
      try { seen.add(v as object); } catch { /* skip cycle guard */ }
    }
    return v;
  };
  try {
    return JSON.stringify(value, replacer, pretty ? 2 : undefined) ?? 'null';
  } catch (err) {
    return JSON.stringify({
      __serialization_error: toErrorMessage(err),
    });
  }
}

/**
 * Attempt to parse JSON5-style input and return a valid JSON string.
 * Handles trailing commas, single-line comments, and unquoted keys
 * that are common in provider output.
 *
 * Returns the sanitized string if it parses successfully as JSON,
 * or `null` if the input cannot be made valid. Callers that get
 * `null` should try `repairJson()` (from json-repair.ts) as a
 * second pass — sanitisation handles comments/commas/control-chars,
 * repair handles structure. If both fail, fall back to raw handling.
 */
export function sanitizeJsonString(s: string): string | null {
  let out = s.trim();

  // Stage 1: strip single-line comments (// to end of line) that appear
  // outside of string values. This is a heuristic: comments inside strings
  // are preserved because we only strip // when preceded by a char that
  // strongly suggests we're not in a string (quote count modulo 2 is even).
  out = stripSingleLineComments(out);

  // Stage 1b: strip block comments (/* ... */) that appear outside of
  // string values. LLMs increasingly emit JSON5, and block comments are
  // the second most common non-standard extension after trailing commas.
  // Uses the same inString heuristic as single-line comments.
  out = stripBlockComments(out);

  // Stage 2: strip trailing commas before } or ]
  out = out.replace(/,(\s*[}\]])/g, '$1');

  // Stage 3: escape literal control characters that appear *inside* string
  // values. Models frequently emit raw newlines/tabs inside a code payload
  // (e.g. edit's old_string/new_string) instead of the required \n / \t, which
  // makes JSON.parse throw. This is the single most common malformed-args case.
  out = escapeControlCharsInStrings(out);

  // Stage 4: attempt full parse; return null if it fails so callers can
  // distinguish "already valid JSON" from "unrecoverable".
  try {
    JSON.parse(out);
    return out;
  } catch {
    return null; // stripped but still not valid JSON; caller handles it
  }
}

/**
 * Strip a Markdown code-fence wrapper from a payload.
 *
 * Models occasionally return tool-call arguments wrapped in ```json fences
 * (or embedded in prose around one) instead of bare JSON. Returns the inner
 * content when the input starts with a fence (closing fence optional, so a
 * truncated stream still unwraps) or contains one complete fenced block;
 * returns null when no fence is present. Callers should only invoke this
 * after a direct parse failed, so fences inside legitimate string values are
 * never touched.
 */
export function stripCodeFences(s: string): string | null {
  const trimmed = s.trim();
  // Whole-payload fence: ```lang? … ```? (closer optional for truncation)
  const opener = /^```[\w+-]*[ \t]*\r?\n?/.exec(trimmed);
  if (opener) {
    const inner = trimmed.slice(opener[0].length).replace(/(\r?\n)?[ \t]*```[ \t]*$/, '');
    return inner.trim();
  }
  // Fence embedded in prose: extract the first complete fenced block.
  const embedded = /```[\w+-]*[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/.exec(trimmed);
  if (embedded) return (embedded[1] ?? '').trim();
  return null;
}

/**
 * Walk the string tracking whether we are inside a JSON string literal and
 * replace raw control characters (U+0000–U+001F) that appear inside strings
 * with their valid JSON escape sequences. Characters outside strings are left
 * untouched (insignificant whitespace stays as-is). Already-escaped sequences
 * are not double-escaped because we only act on *literal* control bytes.
 */
function escapeControlCharsInStrings(s: string): string {
  let inString = false;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (c === '"' && (i === 0 || s[i - 1] !== '\\')) {
      inString = !inString;
      out += c;
      continue;
    }
    const code = c.charCodeAt(0);
    if (inString && code < 0x20) {
      switch (c) {
        case '\n':
          out += '\\n';
          break;
        case '\r':
          out += '\\r';
          break;
        case '\t':
          out += '\\t';
          break;
        case '\b':
          out += '\\b';
          break;
        case '\f':
          out += '\\f';
          break;
        default:
          out += `\\u${code.toString(16).padStart(4, '0')}`;
      }
      continue;
    }
    out += c;
  }
  return out;
}

function stripSingleLineComments(s: string): string {
  let inString = false;
  const chars: string[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s.charAt(i);
    if (c === '"' && (i === 0 || s.charAt(i - 1) !== '\\')) {
      inString = !inString;
      chars.push(c);
    } else if (c === '/' && s.charAt(i + 1) === '/' && !inString) {
      // skip to end of line
      while (i < s.length && s.charAt(i) !== '\n') i++;
    } else {
      chars.push(c);
    }
    i++;
  }
  return chars.join('');
}

function stripBlockComments(s: string): string {
  let inString = false;
  const chars: string[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s.charAt(i);
    if (c === '"' && (i === 0 || s.charAt(i - 1) !== '\\')) {
      inString = !inString;
      chars.push(c);
    } else if (c === '/' && s.charAt(i + 1) === '*' && !inString) {
      // skip to after the closing */
      i += 2; // skip /*
      while (i < s.length - 1) {
        if (s.charAt(i) === '*' && s.charAt(i + 1) === '/') {
          i += 2; // skip */
          break;
        }
        i++;
      }
      // If we hit end-of-string without closing */, the comment is
      // unterminated — consume everything (safer to over-strip than
      // leak comment text into parsed output).
    } else {
      chars.push(c);
    }
    i++;
  }
  return chars.join('');
}

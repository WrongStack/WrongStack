import { toErrorMessage } from './error.js';

export interface SafeParseResult<T> {
  ok: boolean;
  value?: T | undefined;
  error?: string | undefined;
}

export function safeParse<T = unknown>(input: string, maxBytes = 5_000_000): SafeParseResult<T> {
  if (typeof input !== 'string') {
    return { ok: false, error: 'Input must be a string' };
  }
  const effectiveMaxBytes =
    typeof maxBytes === 'number' && Number.isFinite(maxBytes) && maxBytes >= 0
      ? maxBytes
      : 5_000_000;
  if (
    input.length > effectiveMaxBytes ||
    (input.length * 3 > effectiveMaxBytes &&
      new TextEncoder().encode(input).byteLength > effectiveMaxBytes)
  ) {
    return { ok: false, error: `Input exceeds limit (${effectiveMaxBytes} bytes)` };
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
  const stack: object[] = [];
  const rawStack: object[] = [];
  const replacer = function (this: unknown, _k: string, v: unknown): unknown {
    if (typeof v === 'bigint') return v.toString();
    if (typeof this === 'object' && this !== null) {
      const thisIndex = stack.indexOf(this);
      if (thisIndex !== -1) {
        stack.length = thisIndex + 1;
        rawStack.length = thisIndex + 1;
      }
    }
    if (typeof v === 'object' && v !== null) {
      // Recover pre-toJSON identity for data properties without invoking accessors twice.
      const descriptor =
        typeof this === 'object' && this !== null
          ? Object.getOwnPropertyDescriptor(this, _k)
          : undefined;
      const rawVal: unknown = descriptor && 'value' in descriptor ? descriptor.value : v;
      const rawObj =
        typeof rawVal === 'object' && rawVal !== null ? (rawVal as object) : (v as object);
      if (stack.includes(v as object) || rawStack.includes(rawObj)) {
        return '[Circular]';
      }
      if (v instanceof Error) {
        const errObj = { name: v.name, message: v.message, stack: v.stack };
        stack.push(errObj);
        rawStack.push(rawObj);
        return errObj;
      }
      stack.push(v as object);
      rawStack.push(rawObj);
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
 * Handles trailing commas, line/block comments, and unquoted keys
 * that are common in provider output.
 *
 * Returns the sanitized string if it parses successfully as JSON,
 * or `null` if the input cannot be made valid. Callers use this to
 * decide whether to proceed with the parsed result or fall back to
 * raw handling.
 */
export function sanitizeJsonString(s: string): string | null {
  if (typeof s !== 'string') return null;
  let out = s.trim();

  // Stage 1: strip line and block comments outside JSON string values.
  out = stripJsonComments(out);

  // Stage 2: strip trailing commas before } or ] outside of string values
  out = stripTrailingCommas(out);

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
  if (typeof s !== 'string') return null;
  const trimmed = s.trim();
  // Closing fences must be at least as long as the opening backtick run.
  // The closer remains optional for truncated provider output.
  const opener = /^(`{3,})[\w+-]*[ \t]*(\r?\n)?/.exec(trimmed);
  if (opener?.[1]) {
    const body = trimmed.slice(opener[0].length);
    const fencePattern = opener[1] + '`*';
    const lineStart = opener[2] ? '(?:^|\\r?\\n)' : '';
    const closer = new RegExp(`${lineStart}[ \\t]*${fencePattern}[ \\t]*(?:\\r?\\n|$)`).exec(body);
    const rawInner = closer
      ? body.slice(0, closer.index)
      : body.replace(new RegExp(`(\\r?\\n)?[ \\t]*${fencePattern}[ \\t]*$`), '');
    const inner = rawInner.trim();
    return inner.length > 0 ? inner : null;
  }
  // Fence embedded in prose: extract the first complete fenced block.
  const embedded =
    /(?<!`)(`{3,})[\w+-]*[ \t]*(?:\r?\n([\s\S]*?)\r?\n|[ \t]+([^\n`]*?))[ \t]*\1`*/.exec(trimmed);
  if (embedded) {
    const inner = (embedded[2] ?? embedded[3] ?? '').trim();
    return inner.length > 0 ? inner : null;
  }
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
  let escaped = false;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (inString) {
      if (escaped) {
        escaped = false;
        out += c;
        continue;
      }
      if (c === '\\') {
        escaped = true;
        out += c;
        continue;
      }
      if (c === '"') {
        inString = false;
        out += c;
        continue;
      }
      const code = c.charCodeAt(0);
      if (code < 0x20) {
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
      continue;
    }
    if (c === '"') {
      inString = true;
    }
    out += c;
  }
  return out;
}

function stripTrailingCommas(s: string): string {
  let inString = false;
  let escaped = false;
  const chars: string[] = [];
  let i = 0;

  while (i < s.length) {
    const c = s.charAt(i);

    if (inString) {
      chars.push(c);
      if (escaped) {
        escaped = false;
      } else if (c === '\\') {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    if (c === '"') {
      inString = true;
      chars.push(c);
      i++;
      continue;
    }

    if (c === ',') {
      let j = i + 1;
      while (
        j < s.length &&
        (s.charAt(j) === ' ' ||
          s.charAt(j) === '\t' ||
          s.charAt(j) === '\n' ||
          s.charAt(j) === '\r')
      ) {
        j++;
      }
      if (j < s.length && (s.charAt(j) === '}' || s.charAt(j) === ']')) {
        i++;
        continue;
      }
    }

    chars.push(c);
    i++;
  }

  return chars.join('');
}

function stripJsonComments(s: string): string {
  let inString = false;
  let escaped = false;
  const chars: string[] = [];
  let i = 0;

  while (i < s.length) {
    const c = s.charAt(i);

    if (inString) {
      chars.push(c);
      if (escaped) {
        escaped = false;
      } else if (c === '\\') {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    if (c === '"') {
      inString = true;
      chars.push(c);
      i++;
      continue;
    }

    if (c === '/' && s.charAt(i + 1) === '/') {
      while (i < s.length && !/[\n\r\u2028\u2029]/.test(s.charAt(i))) i++;
      // ECMAScript's Unicode line terminators end comments, but are not JSON whitespace.
      if (s.charAt(i) === '\u2028' || s.charAt(i) === '\u2029') {
        chars.push('\n');
        i++;
      }
      continue;
    }

    if (c === '/' && s.charAt(i + 1) === '*') {
      const end = s.indexOf('*/', i + 2);
      if (end === -1) {
        // Preserve an unterminated opener so the final JSON.parse rejects it.
        chars.push(s.slice(i));
        break;
      }
      // A comment separates tokens: `1/**/2` must not turn into `12`.
      chars.push(' ');
      i = end + 2;
      continue;
    }

    chars.push(c);
    i++;
  }

  return chars.join('');
}

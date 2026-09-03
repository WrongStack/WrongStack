import { expectDefined } from './expect-defined.js';

/**
 * Attempt to close an incomplete JSON object string by auto-closing braces
 * and completing any unclosed double-quoted string values.
 *
 * Strategy:
 * 1. Compute origOpen from the ORIGINAL input (how many braces are unclosed).
 * 2. Add that many closing braces. If result is now valid JSON → return it.
 * 3. If still invalid: trim trailing whitespace, strip trailing backslash.
 * 4. Walk backwards to detect an unclosed string value.
 *    - Quote followed by `:` → key-name, skip
 *    - Quote followed by `,` `}` or end-of-string → toggle in/out of string
 * 5. If we end INSIDE a string (unclosed opening `"`), append `"` + origOpen `}`.
 *
 * Known limitations:
 * - Strings whose content ends with a `"` character cannot be repaired
 *   (algorithm can't distinguish content-`"` from string-terminator `"`).
 * - Input ending in bare `:` (incomplete value expression) can't be meaningfully repaired.
 * - Bare `{` returns unchanged.
 * - If origOpen=0 (braces balanced) but string is unclosed, repair is skipped
 *   (the input would be valid JSON per JSON.parse, so it's returned as-is).
 */
export function completePartialObject(s: string): string {
  if (!s.trim().startsWith('{')) return s;
  if (tryParse(s).ok) return s;
  return repairTruncated(s);
}

function repairTruncated(s: string): string {
  // Single forward scan capturing the structural state at the truncation point:
  // the open-container stack, whether we are inside a string, a dangling escape,
  // and where the last significant (non-trailing-whitespace) character sits.
  const stack: ('{' | '[')[] = [];
  let inString = false;
  let escaped = false;
  let sawKey = false; // have we seen any string (i.e. real content) yet?
  let prevSig = ''; // last significant char seen outside of a string
  let contentEnd = 0; // index just past the last significant char

  for (let i = 0; i < s.length; i++) {
    const ch = expectDefined(s[i]);
    if (inString) {
      contentEnd = i + 1;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
        prevSig = '"';
        continue;
      }
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') continue;
    contentEnd = i + 1;
    if (ch === '"') {
      inString = true;
      sawKey = true;
      prevSig = '"';
    } else if (ch === '{' || ch === '[') {
      stack.push(ch);
      prevSig = ch;
    } else if (ch === '}' || ch === ']') {
      stack.pop();
      prevSig = ch;
    } else {
      prevSig = ch;
    }
  }

  // A lone open brace (or anything with no key/content) can't be meaningfully
  // completed — return it untouched.
  if (!sawKey && !inString) return s;

  // Drop trailing whitespace that sits outside any string.
  let result = s.slice(0, contentEnd);

  if (inString) {
    // A dangling lone backslash can't begin a valid escape — drop it.
    if (escaped) {
      result = result.slice(0, -1);
    } else if (endsWithInvalidEscape(result)) {
      // A trailing invalid escape (e.g. `\}`) can't be completed into valid
      // JSON — strip the backslash and its bogus escapee.
      result = result.slice(0, -2);
    }
    result += '"';
  } else if (prevSig === ':') {
    // A key with no value (e.g. `{"k":`) — complete it to null.
    result += 'null';
  } else if (prevSig === ',') {
    // A trailing comma (e.g. `{"a": 1,` or `[1, 2,`) — strip it so closing
    // braces/brackets produce valid JSON.
    result = result.slice(0, -1).trimEnd();
  }

  // Close any still-open containers in reverse order.
  for (let k = stack.length - 1; k >= 0; k--) {
    result += stack[k] === '{' ? '}' : ']';
  }

  // Last resort: an empty value sitting before an existing close (`{"k":}`)
  // or a dangling comma (`{"k": 1, }`) leaves invalid JSON — patch them.
  if (!tryParse(result).ok) {
    const patched = result
      .replace(/:(\s*)([}\]])/g, ':null$2')
      .replace(/,(\s*[}\]])/g, '$1');
    if (tryParse(patched).ok) result = patched;
  }

  return result;
}

const VALID_ESCAPE = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']);

/** True when `str` ends with a backslash escape that JSON does not allow. */
function endsWithInvalidEscape(str: string): boolean {
  const last = str[str.length - 1];
  if (str[str.length - 2] !== '\\' || last === undefined) return false;
  if (VALID_ESCAPE.has(last)) return false;
  // The backslash must itself be unescaped (odd run of backslashes before it).
  let backslashes = 0;
  for (let k = str.length - 2; k >= 0 && str[k] === '\\'; k--) backslashes++;
  return backslashes % 2 === 1;
}

function tryParse(s: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
}

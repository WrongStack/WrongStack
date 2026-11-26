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
  if (typeof s !== 'string') return '';
  if (!s.trim().startsWith('{')) return s;
  if (tryParse(s).ok) return s;
  return repairTruncated(s);
}

function repairTruncated(s: string): string {
  // Single forward scan capturing the structural state at the truncation point:
  // the open-container stack, whether we are inside a string, a dangling escape,
  // and where the last significant (non-trailing-whitespace) character sits.
  const stack: ('{' | '[')[] = [];
  // Per open container: the keys already seen in an object (null for arrays),
  // and where its current member starts. Used only to recognise a dangling
  // REPEATED key, whose invented value would erase the complete field.
  const objectKeys: (Set<string> | null)[] = [];
  const memberStarts: number[] = [];
  let inString = false;
  let escaped = false;
  let sawKey = false; // have we seen any string (i.e. real content) yet?
  let isKey = false;
  let prevSig = ''; // last significant char seen outside of a string
  let contentEnd = 0; // index just past the last significant char
  let stringStart = 0; // index of the opening quote of the latest string
  let closedStringRaw = ''; // content of the most recently closed string
  let closedStringWasKey = false;
  /** The key of the dangling `"k":` at the cut repeats an earlier member. */
  let danglingKeyIsDuplicate = false;

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
        closedStringRaw = s.slice(stringStart + 1, i);
        closedStringWasKey = isKey;
        prevSig = '"';
        continue;
      }
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') continue;
    contentEnd = i + 1;
    if (ch === '"') {
      inString = true;
      stringStart = i;
      sawKey = true;
      isKey = stack[stack.length - 1] === '{' && (prevSig === '{' || prevSig === ',');
      prevSig = '"';
    } else if (ch === ':') {
      const keys = objectKeys[objectKeys.length - 1];
      if (keys && closedStringWasKey) {
        const key = decodeKeyName(closedStringRaw);
        danglingKeyIsDuplicate = keys.has(key);
        keys.add(key);
      }
      closedStringWasKey = false;
      isKey = false;
      prevSig = ':';
    } else if (ch === '{' || ch === '[') {
      stack.push(ch);
      objectKeys.push(ch === '{' ? new Set<string>() : null);
      memberStarts.push(i + 1);
      prevSig = ch;
    } else if (ch === '}' || ch === ']') {
      stack.pop();
      objectKeys.pop();
      memberStarts.pop();
      isKey = false;
      prevSig = ch;
    } else {
      if (ch === ',' && memberStarts.length > 0) {
        memberStarts[memberStarts.length - 1] = i + 1;
      }
      prevSig = ch;
    }
  }

  // A lone open brace (or anything with no key/content) can't be meaningfully
  // completed — return it untouched.
  if (!sawKey && !inString) return s;

  // Drop trailing whitespace that sits outside any string.
  let result = s.slice(0, contentEnd);

  if (inString && isKey) {
    // A key cut mid-name is not a field: completing it as `"<prefix>":null`
    // invents one, and when the prefix equals an earlier key the duplicate
    // wins in JSON.parse and erases that complete field. Drop it instead.
    result = s.slice(0, stringStart).trimEnd();
    if (result.endsWith(',')) result = result.slice(0, -1).trimEnd();
    isKey = false;
  } else if (inString) {
    // A dangling lone backslash can't begin a valid escape — drop it.
    if (escaped) {
      result = result.slice(0, -1);
    } else {
      const incompleteUnicodeLen = trailingIncompleteUnicodeLength(result);
      if (incompleteUnicodeLen > 0) {
        result = result.slice(0, -incompleteUnicodeLen);
      } else if (endsWithInvalidEscape(result)) {
        // A trailing invalid escape (e.g. `\}`) can't be completed into valid
        // JSON — strip the backslash and its bogus escapee.
        result = result.slice(0, -2);
      }
    }
    result += '"';
  } else if (isKey) {
    // An object key with no colon or value (e.g. `{"k"` or `{"a": 1, "b"`)
    const keys = objectKeys[objectKeys.length - 1];
    const repeat =
      closedStringWasKey && memberStarts.length > 0 && keys?.has(decodeKeyName(closedStringRaw));
    if (repeat) {
      // The key is complete and REPEATS an earlier member of this object.
      // Completing it to null would make the duplicate win in JSON.parse and
      // erase the complete field — the same harm the mid-name branch above and
      // the dangling-value branch below avoid. Drop the dangling member.
      result = s.slice(0, memberStarts[memberStarts.length - 1] as number).trimEnd();
      if (result.endsWith(',')) result = result.slice(0, -1).trimEnd();
    } else {
      result += ':null';
    }
    isKey = false;
  } else if (prevSig === ':') {
    if (danglingKeyIsDuplicate && memberStarts.length > 0) {
      // A repeated key with no value at the cut: completing it to `null` wins
      // over the earlier, complete member in JSON.parse and erases it — the
      // same harm the mid-name branch above avoids. Drop the dangling member.
      result = s.slice(0, memberStarts[memberStarts.length - 1] as number).trimEnd();
      if (result.endsWith(',')) result = result.slice(0, -1).trimEnd();
    } else {
      // A key with no value (e.g. `{"k":`) — complete it to null.
      result += 'null';
    }
  } else if (prevSig === ',') {
    // A trailing comma (e.g. `{"a": 1,` or `[1, 2,`) — strip it so closing
    // braces/brackets produce valid JSON.
    result = result.slice(0, -1).trimEnd();
  } else {
    result = completeTrailingScalar(result);
  }

  // Close any still-open containers in reverse order.
  for (let k = stack.length - 1; k >= 0; k--) {
    result += stack[k] === '{' ? '}' : ']';
  }

  // Last resort: an empty value sitting before an existing close (`{"k":}`)
  // or a dangling comma (`{"k": 1, }`) leaves invalid JSON — patch them.
  if (!tryParse(result).ok) {
    // Consume complete string tokens verbatim before matching structural
    // punctuation, or repairing another field can corrupt tool string content.
    const patched = result
      .replace(/"(?:[^"\\]|\\.)*"|:\s*([}\]])/g, (match, close: string | undefined) =>
        close === undefined ? match : `:null${close}`,
      )
      .replace(/"(?:[^"\\]|\\.)*"|,(\s*[}\]])/g, (match, close: string | undefined) =>
        close === undefined ? match : close,
      )
      .replace(/({|,)(\s*)("[^"\\]*(?:\\.[^"\\]*)*")(\s*})/g, '$1$2$3:null$4');
    if (tryParse(patched).ok) result = patched;
  }

  return result;
}

/**
 * Finish a bare scalar the truncation cut through: a literal prefix (`tr`,
 * `fals`, `nul`) becomes the literal, a number loses its dangling `.`/exponent
 * (`2.` → `2`, `1e-` → `1`) and a lone `-` becomes `null`. Left as is, the
 * whole object failed to parse and every complete field before it was lost.
 * A complete scalar is returned unchanged.
 */
function completeTrailingScalar(result: string): string {
  const match = /[A-Za-z0-9.+-]+$/.exec(result);
  if (!match) return result;
  const token = match[0];
  const head = result.slice(0, match.index);
  for (const literal of ['true', 'false', 'null']) {
    if (literal.startsWith(token)) return head + literal;
  }
  if (!/^-?\d/.test(token) && token !== '-') return result;
  const number = token.replace(/[.eE+-]+$/, '');
  return head + (number === '' || number === '-' ? 'null' : number);
}

const VALID_ESCAPE = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']);

/**
 * The string value a key's raw source denotes. `.slice` between the quotes is
 * exact only for unescaped keys; `"\u0061"` and `"a"` are the same member to
 * JSON.parse, and a duplicate missed here is one whose invented value erases
 * the complete field. Malformed escapes fall back to the raw text.
 */
function decodeKeyName(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

/** Length of a trailing incomplete Unicode escape (\u, \uX, \uXX, \uXXX), or 0 if none. */
function trailingIncompleteUnicodeLength(str: string): number {
  for (let h = 0; h <= 3; h++) {
    const uPos = str.length - 1 - h;
    if (uPos >= 0 && str[uPos] === 'u') {
      const suffix = str.slice(uPos + 1);
      if (/^[0-9a-fA-F]*$/.test(suffix)) {
        let backslashes = 0;
        for (let k = uPos - 1; k >= 0 && str[k] === '\\'; k--) backslashes++;
        if (backslashes % 2 === 1) {
          return 1 + 1 + h;
        }
      }
    }
  }
  return 0;
}

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

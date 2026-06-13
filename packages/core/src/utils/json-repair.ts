import { expectDefined } from './expect-defined.js';

/**
 * Bounded LRU cache for `completePartialObject` results. Implemented
 * as a Map because Map iteration order in JS is insertion order, so
 * the *first* key is also the oldest — deletion is O(1) without
 * walking a separate doubly-linked list.
 */
class LruStringCache {
  private readonly cap: number;
  private readonly map = new Map<string, string>();

  constructor(cap: number) {
    this.cap = cap;
  }

  get(key: string): string | undefined {
    return this.map.get(key);
  }

  set(key: string, value: string): void {
    if (this.map.has(key)) {
      // Re-insert to bump to the back (most-recently-used).
      this.map.delete(key);
    } else if (this.map.size >= this.cap) {
      // Evict the oldest by deleting the first key in insertion order.
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, value);
  }
}

const REPAIR_LRU = new LruStringCache(64);

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
  // H5: memoize the fast-path `tryParse(s).ok` and the slow repair
  // separately. The fast path is a JSON.parse; for streamed tool input
  // it's checked once at the very end (when the string is complete) and
  // again when the parser runs on the tool_use stop event. Without the
  // cache, the same long string gets parsed twice.
  if (tryParse(s).ok) return s;

  // LRU(64) for the slow path. Streaming input deltas are unique per
  // tool call, so the cache hit rate on the *repair* is low — but when
  // the same model emits the same truncated pattern across iterations
  // (very common in long autonomous sessions), the repair work is pure
  // repetition. A 64-entry cap keeps memory under ~256 KB at the worst
  // case (4 KB strings × 64), which is negligible against a 200 KB
  // iteration output cap.
  const cached = REPAIR_LRU.get(s);
  if (cached !== undefined) return cached;
  const result = repairTruncated(s);
  REPAIR_LRU.set(s, result);
  return result;
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
  // Count unbalanced `{` accumulated *inside* the currently-open string value,
  // so a truncation mid-string like `"a{` can be balanced before closing it.
  let stringBraceDepth = 0;

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
        stringBraceDepth = 0;
        continue;
      }
      if (ch === '{') stringBraceDepth++;
      else if (ch === '}' && stringBraceDepth > 0) stringBraceDepth--;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') continue;
    contentEnd = i + 1;
    if (ch === '"') {
      inString = true;
      sawKey = true;
      stringBraceDepth = 0;
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
    // Balance braces opened inside the truncated string before closing it.
    if (stringBraceDepth > 0) result += '}'.repeat(stringBraceDepth);
    result += '"';
  } else if (prevSig === ':') {
    // A key with no value (e.g. `{"k":`) — complete it to null.
    result += 'null';
  }

  // Close any still-open containers in reverse order.
  for (let k = stack.length - 1; k >= 0; k--) {
    result += stack[k] === '{' ? '}' : ']';
  }

  // Last resort: an empty value sitting before an existing close (`{"k":}`)
  // leaves invalid JSON — fill it with null.
  if (!tryParse(result).ok) {
    const patched = result.replace(/:(\s*)([}\]])/g, ':null$2');
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
  try { return { ok: true, value: JSON.parse(s) }; }
  catch { return { ok: false }; }
}
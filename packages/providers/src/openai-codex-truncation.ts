/**
 * Tool-output truncation the ChatGPT Codex catalog prescribes per model.
 *
 * Every model in the live `/codex/models` catalog publishes
 * `truncation_policy` (currently `{ mode: 'tokens', limit: 10000 }`). The
 * official client applies it to every function-call output before that output
 * enters the conversation it sends: the middle is cut, the head and tail kept,
 * and a `…N tokens truncated…` marker left in the gap
 * (codex-rs/utils/output-truncation + utils/string/src/truncate.rs). Our own
 * tool caps are provider-neutral and larger (a test or exec run keeps up to
 * 200 KB ≈ 50K tokens), and whatever a tool returned is re-sent on every later
 * request of the session — against a 5h/weekly plan window.
 *
 * This is a faithful port, including the 1.2× serialization allowance and the
 * 4-bytes-per-token estimate, so the model sees what it was trained to see.
 * It is deterministic in its input, which keeps the cached prompt prefix
 * byte-stable from one request to the next.
 */

export interface CodexTruncationPolicy {
  mode: 'tokens' | 'bytes';
  limit: number;
}

const APPROX_BYTES_PER_TOKEN = 4;
/** `with_serialization_allowance`: the budget applied to history is policy × 1.2. */
const SERIALIZATION_ALLOWANCE = 1.2;

/** Read a catalog `truncation_policy`; anything malformed means "no policy". */
export function parseCodexTruncationPolicy(value: unknown): CodexTruncationPolicy | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { mode, limit } = value as { mode?: unknown; limit?: unknown };
  if (mode !== 'tokens' && mode !== 'bytes') return undefined;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) return undefined;
  return { mode, limit };
}

/** Truncate one function-call output the way the official client records it. */
export function truncateCodexToolOutput(text: string, policy: CodexTruncationPolicy): string {
  return truncateMiddle(text, {
    mode: policy.mode,
    limit: Math.ceil(policy.limit * SERIALIZATION_ALLOWANCE),
  });
}

/** `truncate_text`: the policy as given, no allowance. Exported for tests. */
export function truncateMiddle(text: string, policy: CodexTruncationPolicy): string {
  if (policy.mode === 'bytes') return truncateWithByteEstimate(text, policy.limit, false);
  // `truncate_middle_with_token_budget`
  if (text.length === 0) return '';
  const maxBytes = policy.limit * APPROX_BYTES_PER_TOKEN;
  if (policy.limit > 0 && utf8Length(text) <= maxBytes) return text;
  return truncateWithByteEstimate(text, maxBytes, true);
}

function truncateWithByteEstimate(text: string, maxBytes: number, useTokens: boolean): string {
  if (text.length === 0) return '';
  const totalBytes = utf8Length(text);
  const safeMaxBytes = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : 0;
  if (safeMaxBytes === 0) {
    return marker(useTokens, removedUnits(useTokens, totalBytes, countChars(text)));
  }
  if (totalBytes <= safeMaxBytes) return text;
  const left = Math.floor(safeMaxBytes / 2);
  const [removedChars, before, after] = splitUtf8(text, left, safeMaxBytes - left);
  return `${before}${marker(useTokens, removedUnits(useTokens, totalBytes - safeMaxBytes, removedChars))}${after}`;
}

function marker(useTokens: boolean, removed: number): string {
  return useTokens ? `…${removed} tokens truncated…` : `…${removed} chars truncated…`;
}

function removedUnits(useTokens: boolean, removedBytes: number, removedChars: number): number {
  return useTokens ? Math.ceil(removedBytes / APPROX_BYTES_PER_TOKEN) : removedChars;
}

/**
 * Keep up to `beginningBytes` of whole characters from the front and every
 * character starting at or after `len - endBytes` at the back, counting in
 * UTF-8 bytes as Rust's `str` does. Returns the number of characters dropped.
 */
function splitUtf8(
  text: string,
  beginningBytes: number,
  endBytes: number,
): [number, string, string] {
  if (text.length === 0) return [0, '', ''];
  const len = utf8Length(text);
  const tailStartTarget = Math.max(0, len - endBytes);
  let byteIdx = 0;
  let prefixEnd = 0; // UTF-16 index
  let suffixStart = text.length; // UTF-16 index
  let suffixStartByte = len;
  let prefixEndByte = 0;
  let removedChars = 0;
  let suffixStarted = false;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i) as number;
    const units = cp > 0xffff ? 2 : 1;
    const charEnd = byteIdx + utf8CodePointLength(cp);
    if (charEnd <= beginningBytes) {
      prefixEnd = i + units;
      prefixEndByte = charEnd;
    } else if (byteIdx >= tailStartTarget) {
      if (!suffixStarted) {
        suffixStart = i;
        suffixStartByte = byteIdx;
        suffixStarted = true;
      }
    } else {
      removedChars += 1;
    }
    byteIdx = charEnd;
    i += units;
  }
  if (suffixStartByte < prefixEndByte) suffixStart = prefixEnd;
  return [removedChars, text.slice(0, prefixEnd), text.slice(suffixStart)];
}

/** UTF-8 length of one code point; a lone surrogate encodes as U+FFFD (3 bytes). */
function utf8CodePointLength(cp: number): number {
  if (cp < 0x80) return 1;
  if (cp < 0x800) return 2;
  if (cp < 0x10000) return 3;
  return 4;
}

function utf8Length(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function countChars(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

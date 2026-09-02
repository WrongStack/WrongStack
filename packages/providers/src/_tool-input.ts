import {
  completePartialObject,
  safeParse,
  sanitizeJsonString,
  stripCodeFences,
} from '@wrongstack/core/utils';

/**
 * Parse a tool-call arguments JSON blob into a canonical
 * `Record<string, unknown>`.
 *
 * Why this exists: providers stream tool-call arguments as raw JSON strings
 * accumulated over multiple `delta` events. Once complete, callers want a
 * dictionary. Naive `JSON.parse` plus `as Record<string, unknown>` is unsafe
 * — a buggy provider, a proxy that rewrites payloads, or a future API change
 * can yield `null`, an array, or a number, all of which would
 * type-check fine but crash downstream tool executors that index into the
 * input by key.
 *
 * Repair ladder (each step only runs when the previous ones failed, so a
 * well-formed payload costs a single JSON.parse):
 *   1. direct parse
 *   2. code-fence stripping (```json … ``` wrappers, fenced block in prose)
 *   3. JSON5-style sanitize (comments, trailing commas, literal control chars)
 *   4. truncation completion (auto-close braces/strings)
 *   5. both composed (truncated payloads with raw newlines inside strings)
 *   6. double-wrapped-string salvage (arguments serialized twice)
 *
 * Result contract:
 *   - Valid JSON object → returned as-is, typed as `Record<string, unknown>`.
 *   - Valid JSON array / scalar → wrapped under `{ __raw: value }` so the
 *     tool still receives an object (the executor can detect the anomaly).
 *   - Unrecoverable input → `{ __raw: rawString }` so no information is lost;
 *     the tool layer can decide whether to fail or salvage.
 *   - Empty/null input → returns `{}` (the "no arguments" case).
 */
export function parseToolInput(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  let parsed = safeParse<unknown>(raw);

  // Fast path: parsed cleanly into an object
  if (parsed.ok) {
    const fast = asObject(parsed.value);
    if (fast) return fast;
  }

  // Fence stripping: models sometimes wrap the arguments in a Markdown code
  // fence, or embed one in prose. Only reached after the direct parse failed
  // to yield an object, so fences inside legitimate string values are safe.
  const unfenced = stripCodeFences(raw);
  if (unfenced) {
    const viaFence = parseObject(unfenced) ?? repairObject(unfenced);
    if (viaFence) return viaFence;
  }

  // Repair ladder on the raw payload (sanitize → complete → both).
  const repaired = repairObject(raw);
  if (repaired) return repaired;

  // Keep legacy bookkeeping for the salvage/fallback paths below: when the
  // original parse failed or yielded a non-object, retry on the auto-closed
  // form so a truncated scalar/string payload still surfaces structurally.
  if (!parsed.ok || asObject(parsed.value) === null) {
    const completed = completePartialObject(raw);
    parsed = safeParse<unknown>(completed);
  }

  // Second salvage: if raw couldn't be parsed but looks like a string containing
  // a serialized JSON object (double-wrapped), unwrap it.
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    const unescaped = safeParse<unknown>(raw);
    if (unescaped.ok && typeof unescaped.value === 'string') {
      const inner = parseInnerString(unescaped.value);
      if (inner) return inner;
    }
  }

  // Salvage case: parsed value is a string (scalar) but contains a serialized
  // JSON object (common when proxies/models map OpenAI arguments string directly
  // to Anthropic input).
  if (parsed.ok && typeof parsed.value === 'string') {
    const inner = parseInnerString(parsed.value);
    if (inner) return inner;
  }

  // Give up — wrap under the sentinel key so the tool still receives an object.
  // Prefer the parsed scalar/array value (so a valid `[1,2,3]` / `42` / `"x"`
  // is preserved structurally); fall back to the original raw string when the
  // input couldn't be parsed at all. No information is lost either way.
  const fallback = parsed.ok ? parsed.value : undefined;
  return { __raw: fallback ?? raw };
}

/** Narrow to a plain (non-null, non-array) object, else null. */
function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Parse a candidate string and narrow to a plain object, else null. */
function parseObject(s: string): Record<string, unknown> | null {
  const parsed = safeParse<unknown>(s);
  return parsed.ok ? asObject(parsed.value) : null;
}

/**
 * Repair ladder for a malformed JSON object payload:
 * JSON5-style sanitize, then truncation completion, then both composed
 * (a truncated stream can also carry raw newlines inside string values).
 * Returns the recovered object or null when unrecoverable.
 */
function repairObject(s: string): Record<string, unknown> | null {
  const sanitized = sanitizeJsonString(s);
  if (sanitized !== null) {
    // sanitizeJsonString only returns strings that parse as valid JSON.
    const obj = parseObject(sanitized);
    if (obj) return obj;
  }
  const completed = completePartialObject(s);
  if (completed !== s) {
    const obj = parseObject(completed);
    if (obj) return obj;
    const sanitizedCompleted = sanitizeJsonString(completed);
    if (sanitizedCompleted !== null) {
      const combined = parseObject(sanitizedCompleted);
      if (combined) return combined;
    }
  }
  return null;
}

/**
 * Salvage an object from a string scalar that itself carries a serialized
 * (possibly fenced or malformed) JSON object.
 */
function parseInnerString(value: string): Record<string, unknown> | null {
  const innerRaw = value.trim();
  const candidate = stripCodeFences(innerRaw) ?? innerRaw;
  if (!candidate.startsWith('{')) return null;
  return parseObject(candidate) ?? repairObject(candidate);
}

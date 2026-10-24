/**
 * TechStack — `Provider` → {@link ResearchLlm} adapter.
 *
 * Mirrors the capability-probing pattern established by the WebUI completion
 * handler (`packages/webui-server/src/server/completion-handlers.ts`,
 * `loadLlmSuggestions`): prefer strict structured output, fall back to JSON
 * mode, fall back again to prompt-only discipline. Providers differ, and a
 * research pass must not be exclusive to the ones with schema support.
 *
 * @see docs/archive/specs/techstack-sdd.md §4.2
 */

import type { Provider, Request } from '@wrongstack/contracts/types';
import type { ResearchLlm, ResearchLlmRequest } from './types.js';

/** How the caller reaches a live provider. A getter, not a captured value —
 * the user can switch model or rotate credentials mid-session, and a snapshot
 * of the provider would silently go stale. */
export type LlmAccessor = () => { provider: Provider; model: string } | undefined;

const DEFAULT_TIMEOUT_MS = 45_000;

/**
 * Build a {@link ResearchLlm} from a provider accessor, or `undefined` when no
 * provider is currently wired — which is the signal `TechStackEngine` uses to
 * skip the research stage entirely and stay a deterministic tool.
 */
export function createProviderLlm(
  accessor: LlmAccessor,
  options: { readonly timeoutMs?: number | undefined } = {},
): ResearchLlm | undefined {
  if (!accessor()) return undefined;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (req: ResearchLlmRequest): Promise<string> => {
    req.signal?.throwIfAborted();
    // Re-resolve per call so a mid-session model switch takes effect.
    const llm = accessor();
    if (!llm) throw new Error('TechStack research: no provider available');

    const request: Request = {
      model: llm.model,
      system: [{ type: 'text', text: req.system }],
      messages: [{ role: 'user', content: req.prompt }],
      maxTokens: req.maxTokens,
    };

    if (llm.provider.capabilities.structuredOutput) {
      request.responseFormat = {
        type: 'json_schema',
        jsonSchema: { name: req.schemaName, strict: false, schema: req.schema },
      };
    } else if (llm.provider.capabilities.jsonMode) {
      request.responseFormat = { type: 'json_object' };
    }

    const timer = new AbortController();
    const onAbort = () => {
      timer.abort(new Error('TechStack research: cancelled'));
    };
    req.signal?.addEventListener('abort', onAbort, { once: true });
    const to = setTimeout(() => {
      timer.abort(new Error('TechStack research: LLM timeout'));
    }, timeoutMs);
    to.unref?.();

    try {
      const res = await llm.provider.complete(request, { signal: timer.signal });
      timer.signal.throwIfAborted();
      return res.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();
    } finally {
      req.signal?.removeEventListener('abort', onAbort);
      clearTimeout(to);
      timer.abort();
    }
  };
}

// ── Response parsing ──────────────────────────────────────────────────────

/** Strip one outer Markdown fence without touching inner fences. */
function stripOuterFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:[a-z0-9_-]+)?\s*\r?\n([\s\S]*?)\r?\n```$/i);
  return (match?.[1] ?? trimmed).trim();
}

/**
 * Pull the outermost JSON object out of a response.
 *
 * Even with `json_object` set, models prepend prose often enough that a bare
 * `JSON.parse` is a coin flip. Same salvage the completion handler does
 * (`extractJson`).
 */
/** Index just past the `}` matching the `{` at `start`, or undefined when unbalanced. */
function balancedEnd(text: string, start: number): number | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return index + 1;
  }
  return undefined;
}

/**
 * Pull the outermost JSON object out of a response.
 *
 * Three salvage passes, in order:
 *
 *   1. Try every `{` and pick the first BALANCED object that parses. Prose
 *      around the object has braces of its own ("see the range {>=1.0}"),
 *      and the first-`{`/last-`}` slice pulled that prose in. `JSON.parse`
 *      then failed, `parseFindings` was skipped, and the whole cluster's
 *      findings were dropped without a trace.
 *   2. If no balanced object exists, the response is a maxTokens-cut prefix
 *      (canonical shape: outermost `{` never closes). Repair the prefix by
 *      closing any unclosed string / object / array, then re-attempt the
 *      balanced scan. A recovered prefix still yields every finding whose
 *      object completed before the cut.
 *   3. Fall through to the raw trimmed text — `JSON.parse` will throw and
 *      `parseResearchJson` will return null, preserving the r25 promise that
 *      a truly unrecoverable response degrades the cluster to zero findings
 *      rather than failing the analyze job.
 */
function extractJsonObject(text: string): string {
  const trimmed = stripOuterFence(text);

  // Pass 1: balanced outermost object.
  for (let start = trimmed.indexOf('{'); start !== -1; start = trimmed.indexOf('{', start + 1)) {
    const end = balancedEnd(trimmed, start);
    if (end === undefined) break;
    const candidate = trimmed.slice(start, end);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // Braces in prose are not JSON — try the next `{`.
    }
  }

  // Pass 2: truncated-prefix repair. Close any open string / object / array
  // so the balanced scan above can find a parseable outermost object.
  const repaired = repairTruncatedJson(trimmed);
  if (repaired !== null) {
    for (
      let start = repaired.indexOf('{');
      start !== -1;
      start = repaired.indexOf('{', start + 1)
    ) {
      const end = balancedEnd(repaired, start);
      if (end === undefined) break;
      const candidate = repaired.slice(start, end);
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        // Try the next `{`.
      }
    }
  }

  // Pass 3: unrecoverable — let `parseResearchJson` return null.
  return trimmed;
}

/**
 * Close any unclosed string, object, or array in `text` so a truncated JSON
 * prefix becomes parseable. Returns `null` when the prefix has no `{` to
 * anchor on (so there is nothing recoverable).
 *
 * String-aware: an open string at the cut point is closed with `"`. A single
 * container stack tracks `{` and `[` in nesting order so the emitted closing
 * sequence is the correct reverse — `{"a":[1,` → `{"a":[1]}` and
 * `{"findings":[{…},{…,"severity":"med` → `{"findings":[{…},{…,"med"}]}`.
 *
 * An escape the cut interrupted is dropped before that quote is appended:
 * landing right after a `\` (inside an intended `\\`) or inside a partial
 * `\uXXXX`, the appended `"` is swallowed by the escape (`\"`) or invalidates
 * it (`\uD83"`), the string never closes, and the repaired object stays
 * unparseable — the cluster degrades to zero findings exactly as if the
 * repair pass did not exist.
 *
 * Also strips a dangling element-separator comma that the cut left behind
 * (e.g. `{"items": [1, 2, 3,` → `{"items": [1, 2, 3]}`), since `,` immediately
 * before `]` or `}` is invalid JSON.
 */
function repairTruncatedJson(text: string): string | null {
  if (!text.includes('{')) return null;
  let inString = false;
  let escaped = false;
  // Index of the `\` that opened the escape currently being scanned; escapes
  // only exist inside strings, and only the last one can still be incomplete.
  let escapeStart = -1;
  const stack: string[] = [];
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped)
        escaped = false; // this char completes a 2-char escape
      else if (char === '\\') {
        escaped = true;
        escapeStart = index;
      } else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      stack.push('}');
    } else if (char === '[') {
      stack.push(']');
    } else if (char === '}' || char === ']') {
      const expected = stack.pop();
      // Mismatched closer (prose between containers) — bail.
      if (expected !== char) return null;
    }
  }
  let repaired = text;
  if (inString) {
    // The cut landed mid-escape when the text ends right after a `\`, or when
    // everything past an unescaped `\` is `u` plus fewer than 4 hex digits.
    // (A stale `escapeStart` from an earlier, properly closed string can never
    // satisfy either test: the closed string's `"` would sit inside the slice.)
    const incompleteEscape =
      escapeStart >= 0 && (escaped || /^\\u[0-9a-fA-F]{0,3}$/.test(text.slice(escapeStart)));
    if (incompleteEscape) repaired = text.slice(0, escapeStart);
    repaired += '"';
  }
  // Strip a dangling comma the cut left immediately before the next closer.
  // Walk the repair suffix backwards: the next character is the last emitted
  // (or pre-existing) one; if it is `,` and the top of stack is `}` or `]`,
  // drop the comma.
  while (
    repaired.endsWith(',') &&
    (stack[stack.length - 1] === '}' || stack[stack.length - 1] === ']')
  ) {
    repaired = repaired.slice(0, -1);
  }
  while (stack.length > 0) {
    repaired += stack.pop();
  }
  return repaired;
}

/**
 * Parse a research response into a plain object, or `null` when the model
 * returned something unusable.
 *
 * Never throws: an unparseable research response degrades that cluster to zero
 * findings, it does not fail the analyze job.
 */
export function parseResearchJson(text: string): Record<string, unknown> | null {
  if (!text.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(extractJsonObject(text));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

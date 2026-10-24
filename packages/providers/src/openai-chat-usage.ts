import type { Usage } from '@wrongstack/contracts/types';

/**
 * The `usage` object of an OpenAI-shaped chat completion, as the many
 * OpenAI-compatible endpoints actually send it. They agree on `prompt_tokens`
 * and disagree on where the cache counts go:
 *
 * - OpenAI, xAI, Groq, z.ai, OpenRouter: `prompt_tokens_details.cached_tokens`
 *   (OpenRouter adds `prompt_tokens_details.cache_write_tokens`).
 * - DeepSeek: `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`.
 * - Kimi (Moonshot): top-level `cached_tokens`.
 * - DashScope (Qwen) explicit cache: `prompt_tokens_details.cache_creation_input_tokens`.
 * - Anthropic-backed proxies (LiteLLM, Kimi's mirror): top-level
 *   `cache_read_input_tokens` / `cache_creation_input_tokens`.
 * - MiniMax: sometimes only `total_tokens` + `completion_tokens`.
 */
export interface OpenAIChatUsageWire {
  prompt_tokens?: number | undefined;
  input_tokens?: number | undefined;
  completion_tokens?: number | undefined;
  total_tokens?: number | undefined;
  prompt_tokens_details?:
    | {
        cached_tokens?: number | undefined;
        cache_write_tokens?: number | undefined;
        cache_creation_input_tokens?: number | undefined;
      }
    | undefined;
  prompt_cache_hit_tokens?: number | undefined;
  prompt_cache_miss_tokens?: number | undefined;
  cached_tokens?: number | undefined;
  cache_read_input_tokens?: number | undefined;
  cache_creation_input_tokens?: number | undefined;
}

function nonNegative(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function optionalNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Normalize to the disjoint `Usage` every adapter reports: `input` is the
 * fresh, full-rate part of the prompt; `cacheRead` and `cacheWrite` are the
 * cached and cache-written parts. A cache count left inside `input` is billed
 * at the full rate and hides the hit from the cache-ratio display.
 *
 * `previous` is the usage seen so far in the stream: a later chunk that omits
 * a field keeps the earlier value.
 */
export function normalizeOpenAIChatUsage(u: OpenAIChatUsageWire, previous: Usage): Usage {
  const details = u.prompt_tokens_details;
  const hasDeepSeekCacheFields =
    u.prompt_cache_hit_tokens !== undefined || u.prompt_cache_miss_tokens !== undefined;
  const cached = nonNegative(
    details?.cached_tokens ??
      u.prompt_cache_hit_tokens ??
      u.cached_tokens ??
      u.cache_read_input_tokens,
  );
  const cacheWrite = nonNegative(
    details?.cache_write_tokens ??
      details?.cache_creation_input_tokens ??
      u.cache_creation_input_tokens,
  );
  // The cache counts that will actually be REPORTED at this stream position.
  // `cacheRead`/`cacheWrite` retain the previous chunk's value when the
  // current chunk omits them, so `input` must deduct the retained values too.
  // Deducting only the current chunk's zeros made a chunk that repeats
  // `prompt_tokens` without the cache detail re-count the whole cached prefix
  // as fresh, full-rate input — the double count this module exists to prevent.
  const retainedCacheRead = cached || previous.cacheRead || 0;
  const retainedCacheWrite = cacheWrite || previous.cacheWrite || 0;
  const completion = nonNegative(u.completion_tokens, previous.output);
  // Lean endpoints may report only `total_tokens` + `completion_tokens`;
  // prompt = total − completion recovers the input count instead of leaving it
  // at 0. Ordered after the explicit prompt fields.
  const hasPromptTotal = u.prompt_tokens !== undefined;
  const hasFreshInputDelta = !hasPromptTotal && u.input_tokens !== undefined;
  const cacheMiss = optionalNonNegative(u.prompt_cache_miss_tokens);
  const reportedPromptTotal = hasPromptTotal
    ? nonNegative(u.prompt_tokens)
    : hasDeepSeekCacheFields
      ? nonNegative(u.prompt_cache_hit_tokens) + nonNegative(u.prompt_cache_miss_tokens)
      : u.total_tokens !== undefined
        ? Math.max(0, u.total_tokens - completion)
        : previous.input + retainedCacheRead + retainedCacheWrite;
  // Hybrid gateways use Anthropic/MiniMax delta semantics in an OpenAI-shaped
  // envelope: `input_tokens` is fresh-only and the cache counts are separate.
  // `prompt_tokens`, when present, remains OpenAI's total. A broken gateway
  // reporting cached > total keeps both counters rather than a >100% ratio.
  const promptTotal =
    hasPromptTotal && retainedCacheRead > reportedPromptTotal
      ? reportedPromptTotal + retainedCacheRead
      : reportedPromptTotal;
  const next: Usage = {
    input:
      cacheMiss ??
      (hasFreshInputDelta
        ? Math.max(0, u.input_tokens ?? 0)
        : Math.max(0, promptTotal - retainedCacheRead - retainedCacheWrite)),
    output: completion,
    cacheRead: cached || previous.cacheRead,
  };
  if (cacheWrite || previous.cacheWrite !== undefined) {
    next.cacheWrite = cacheWrite || previous.cacheWrite;
  }
  return next;
}

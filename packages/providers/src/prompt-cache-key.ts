import type { Capabilities, Request } from '@wrongstack/core/types';

/**
 * Set OpenAI's `prompt_cache_key` from the provider-agnostic `req.cache.key`.
 *
 * On automatic-cache providers (`cacheControl: 'auto'` — OpenAI, GitHub Copilot,
 * Codex) a stable key routes prefix-sharing requests to the same cache
 * partition, which is what makes OpenAI's automatic prompt caching actually hit
 * on load-balanced backends. It is a no-op when the model doesn't use automatic
 * caching (`'native'` = Anthropic explicit markers; `'none'` = Google
 * cachedContent / no cache) or when no cache key was derived — so it is safe to
 * call unconditionally from every OpenAI-family builder.
 */
export function applyPromptCacheKey(
  body: Record<string, unknown>,
  req: Request,
  caps: Capabilities | undefined,
): void {
  if (req.cache?.key?.trim() && caps?.cacheControl === 'auto') {
    body['prompt_cache_key'] = req.cache.key;
  }
}

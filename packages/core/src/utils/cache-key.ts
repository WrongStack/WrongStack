import { createHash } from 'node:crypto';
import type { TextBlock } from '../types/blocks.js';
import type { Tool } from '../types/tool.js';

const keyCache = new WeakMap<readonly TextBlock[], string>();
const toolsKeyCache = new WeakMap<readonly TextBlock[], WeakMap<readonly Tool[], string>>();

/**
 * Derive a stable, provider-agnostic cache-partition key from a frozen
 * system-prompt epoch and active tool definitions. Requests that share the
 * same stable prefix (system prompt + tools) produce the same key, so provider
 * backends route them to the same automatic-cache partition — this is what
 * OpenAI's `prompt_cache_key` (and Gemini implicit routing) needs to actually
 * hit the cache on load-balanced deployments.
 *
 * When `tools` is provided, tools are sorted canonically by name before hashing
 * so registration order differences across plugins do not perturb the key.
 */
export function deriveCachePrefixKey(
  systemPrompt: readonly TextBlock[],
  tools?: readonly Tool[],
): string {
  if (!tools || tools.length === 0) {
    const cached = keyCache.get(systemPrompt);
    if (cached !== undefined) return cached;
    const h = createHash('sha256');
    for (const block of systemPrompt) h.update(block.text).update('\u0000');
    const key = `ws-${h.digest('hex').slice(0, 32)}`;
    keyCache.set(systemPrompt, key);
    return key;
  }

  let byPrompt = toolsKeyCache.get(systemPrompt);
  if (!byPrompt) {
    byPrompt = new WeakMap<readonly Tool[], string>();
    toolsKeyCache.set(systemPrompt, byPrompt);
  }
  const cached = byPrompt.get(tools);
  if (cached !== undefined) return cached;

  const h = createHash('sha256');
  for (const block of systemPrompt) h.update(block.text).update('\u0000');
  h.update('tools:\u0000');
  const sorted =
    tools.length > 1 ? [...tools].sort((a, b) => a.name.localeCompare(b.name)) : tools;
  for (const tool of sorted) {
    h.update(tool.name).update('\u0000');
  }
  const key = `ws-${h.digest('hex').slice(0, 32)}`;
  byPrompt.set(tools, key);
  return key;
}

import { createHash } from 'node:crypto';
import type { TextBlock } from '../types/blocks.js';
import type { Tool } from '../types/tool.js';

const keyCache = new WeakMap<readonly TextBlock[], string>();
const toolsKeyCache = new WeakMap<readonly TextBlock[], WeakMap<readonly Tool[], string>>();

/** Canonicalize JSON-like values without changing array semantics. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`;
}

/**
 * Derive a stable fingerprint for the portion of a tool definition sent to
 * provider wire formats. Runtime-only permission, execution, and token-estimate
 * fields are deliberately excluded.
 */
function canonicalToolFingerprint(tool: Tool): string {
  return canonicalJson({
    name: tool?.name ?? '',
    description: tool?.description ?? '',
    inputSchema: tool?.inputSchema ?? {},
  });
}

/**
 * Derive a stable, provider-agnostic cache-partition key from a frozen
 * system-prompt epoch and active tool definitions. Requests that share the
 * same stable prefix (system prompt + tools) produce the same key, so provider
 * backends route them to the same automatic-cache partition — this is what
 * OpenAI's `prompt_cache_key` (and Gemini implicit routing) needs to actually
 * hit the cache on load-balanced deployments.
 *
 * When `tools` is provided, tools are sorted by their canonical wire-relevant
 * fingerprint before hashing, so registration order and object property order
 * differences do not perturb the key while schema changes do.
 */
export function deriveCachePrefixKey(
  systemPrompt: readonly TextBlock[],
  tools?: readonly Tool[],
): string {
  if (!Array.isArray(systemPrompt)) return 'ws-empty';

  const safeTools = Array.isArray(tools) && tools.length > 0 ? tools : undefined;

  if (!safeTools) {
    const cached = keyCache.get(systemPrompt);
    if (cached !== undefined) return cached;
    const h = createHash('sha256');
    for (const block of systemPrompt) h.update(block?.text ?? '').update('\u0000');
    const key = `ws-${h.digest('hex').slice(0, 32)}`;
    keyCache.set(systemPrompt, key);
    return key;
  }

  let byPrompt = toolsKeyCache.get(systemPrompt);
  if (!byPrompt) {
    byPrompt = new WeakMap<readonly Tool[], string>();
    toolsKeyCache.set(systemPrompt, byPrompt);
  }
  const cached = byPrompt.get(safeTools);
  if (cached !== undefined) return cached;

  const h = createHash('sha256');
  for (const block of systemPrompt) h.update(block?.text ?? '').update('\u0000');
  h.update('tools:\u0000');
  const sorted =
    safeTools.length > 1
      ? [...safeTools].sort((a, b) =>
          canonicalToolFingerprint(a).localeCompare(canonicalToolFingerprint(b)),
        )
      : safeTools;
  for (const tool of sorted) {
    h.update(canonicalToolFingerprint(tool)).update('\u0000');
  }
  const key = `ws-${h.digest('hex').slice(0, 32)}`;
  byPrompt.set(safeTools, key);
  return key;
}

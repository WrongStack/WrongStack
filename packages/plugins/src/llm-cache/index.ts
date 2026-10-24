/**
 * llm-cache plugin — caches identical provider requests and skips the
 * provider call entirely on a hit.
 *
 * This is the deepest intervention a plugin can make: it registers an
 * `AgentExtension.wrapProviderRunner`, which the agent loop composes
 * around EVERY provider call (`agent-loop.ts` → `extensions
 * .wrapProviderRunner(baseRunner)`). The plugin fingerprints the
 * outgoing `Request` (model + system + messages + tools + sampling
 * params) and, on a match, returns the cached `Response` without ever
 * touching the network — killing redundant calls from retries, loops,
 * and re-runs.
 *
 * Safety posture: caching changes call semantics (a repeated request
 * returns the same answer instead of a fresh sample), so the plugin is
 * **opt-in** at host plugin loading. Once loaded, its internal switch is
 * enabled by default. Set `extensions['llm-cache'].enabled = false` to disable it. It only
 * caches deterministic requests (`temperature` 0 or unset) so a
 * sampled generation is never silently frozen.
 *
 * Config (`config.extensions['llm-cache']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,            // master switch after host loading
 *   "maxEntries": 256,          // LRU capacity
 *   "ttlMs": 0,                 // 0 = no expiry; else evict after N ms
 *   "onlyDeterministic": true,  // only cache temperature 0/unset requests
 *   "zeroUsageOnHit": false     // report 0 tokens on a hit (true) or keep
 *                               // the cached usage for context accounting (false)
 * }
 * ```
 *
 * Tools:
 *  - `llm_cache_status` — hit/miss/skip counters, size, config
 *  - `llm_cache_clear`  — drop all cached entries
 *
 * @public
 */

import { createHash } from 'node:crypto';
import type { Plugin, PluginAPI } from '@wrongstack/contracts/types';
import { createHostStates, providerSignal } from '../runtime/host-state.js';

// ---------------------------------------------------------------------------
// Minimal structural mirrors of the provider Request/Response. We keep these
// local (not imported) so the plugin stays decoupled from core's exact
// provider types — we only touch the fields we fingerprint or return.
// ---------------------------------------------------------------------------

interface CachedResponse {
  content: unknown;
  stopReason: unknown;
  usage: { input: number; output: number; [k: string]: unknown };
  model: string;
}

interface CacheEntry {
  response: CachedResponse;
  storedAt: number;
  hits: number;
}

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

interface LlmCacheState {
  abort: AbortController;
  generation: number;
  providers: WeakMap<object, number>;
  nextProviderId: number;
  /** LRU map: insertion order = recency; re-set on hit to bump. */
  cache: Map<string, CacheEntry>;
  hits: number;
  misses: number;
  /** Requests skipped from caching (non-deterministic, disabled, etc.). */
  skips: number;
  evictions: number;
  savedInputTokens: number;
  savedOutputTokens: number;
  extensionUnregister: null | (() => void);
}

function createState(): LlmCacheState {
  return {
    abort: new AbortController(),
    generation: 0,
    providers: new WeakMap(),
    nextProviderId: 0,
    cache: new Map(),
    hits: 0,
    misses: 0,
    skips: 0,
    evictions: 0,
    savedInputTokens: 0,
    savedOutputTokens: 0,
    extensionUnregister: null,
  };
}
const hosts = createHostStates(createState);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface LlmCacheConfig {
  enabled: boolean;
  maxEntries: number;
  ttlMs: number;
  onlyDeterministic: boolean;
  zeroUsageOnHit: boolean;
}

const DEFAULTS: LlmCacheConfig = {
  // Opt-in belongs to host enablement, not this switch — see the
  // plugin-enable-double-gate audit.
  enabled: true,
  maxEntries: 256,
  ttlMs: 0,
  onlyDeterministic: true,
  zeroUsageOnHit: false,
};

function readConfig(raw: unknown): LlmCacheConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  const rawMax = r['maxEntries'] ?? r['max_entries'] ?? r['limit'];
  const rawTtl = r['ttlMs'] ?? r['ttl_ms'] ?? r['ttl'];
  const rawDet = r['onlyDeterministic'] ?? r['only_deterministic'];
  const rawZero =
    r['zeroUsageOnHit'] ?? r['zero_usage_on_hit'] ?? r['zeroUsage'] ?? r['zero_usage'];
  return {
    enabled: r['enabled'] !== false,
    maxEntries:
      typeof rawMax === 'number' && rawMax >= 1 ? Math.floor(rawMax) : DEFAULTS.maxEntries,
    ttlMs: typeof rawTtl === 'number' && rawTtl >= 0 ? rawTtl : DEFAULTS.ttlMs,
    onlyDeterministic: rawDet !== false,
    zeroUsageOnHit: rawZero === true,
  };
}

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

/**
 * Whether a request is safe to cache under `onlyDeterministic`. Sampled
 * requests (temperature > 0) return different content each call, so
 * caching them would silently freeze the first sample.
 */
export function isDeterministic(request: Record<string, unknown>): boolean {
  const t = request['temperature'];
  return t === undefined || t === null || t === 0;
}

/**
 * Stable fingerprint of the request fields that affect the response.
 * Includes response-affecting fields and full tool definitions. Requests
 * may be mutated by callers, so object identity alone cannot cache a key.
 *
 * Determinism: uses canonical JSON key ordering (alphabetical) so
 * identical semantic requests produce identical fingerprints regardless
 * of property insertion order.
 */
export function fingerprintRequest(request: Record<string, unknown>): string {
  const rawTools =
    request['tools'] ??
    request['tool_definitions'] ??
    request['toolDefinitions'] ??
    request['functions'];
  const subset = {
    ...request,
    maxTokens: request['maxTokens'] ?? null,
    messages: request['messages'] ?? null,
    model: request['model'] ?? null,
    reasoning: request['reasoning'] ?? null,
    responseFormat: request['responseFormat'] ?? null,
    stopSequences: request['stopSequences'] ?? null,
    system: request['system'] ?? null,
    temperature: request['temperature'] ?? null,
    tools: rawTools ?? null,
    topK: request['topK'] ?? null,
    topP: request['topP'] ?? null,
  };
  const serialized = JSON.stringify(subset, (_key, value: unknown) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(
        Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
    return value;
  });
  return createHash('sha256').update(serialized).digest('hex');
}

// ---------------------------------------------------------------------------
// LRU helpers
// ---------------------------------------------------------------------------

function lruGet(state: LlmCacheState, key: string, ttlMs: number): CacheEntry | undefined {
  const entry = state.cache.get(key);
  if (!entry) return undefined;

  // TTL check: evict expired entries immediately.
  if (ttlMs > 0 && Date.now() - entry.storedAt > ttlMs) {
    state.cache.delete(key);
    return undefined;
  }

  // Bump recency: delete + re-insert moves it to the end of the Map.
  // Map maintains insertion order, so this is O(1) amortized.
  state.cache.delete(key);
  state.cache.set(key, entry);
  return entry;
}

function lruSet(
  state: LlmCacheState,
  key: string,
  response: CachedResponse,
  maxEntries: number,
): void {
  // If key already exists, delete it first so re-insertion bumps it to the end.
  if (state.cache.has(key)) {
    state.cache.delete(key);
  }

  state.cache.set(key, { response, storedAt: Date.now(), hits: 0 });

  // Evict oldest entries (first inserted) when over capacity.
  // Map.keys().next() is O(1) — no need to iterate the whole map.
  while (state.cache.size > maxEntries) {
    const oldest = state.cache.keys().next().value;
    if (oldest === undefined) break;
    state.cache.delete(oldest);
    state.evictions += 1;
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'llm-cache',
  version: '0.1.0',
  description:
    'Caches identical provider requests and short-circuits the provider call on a hit (wrapProviderRunner). Opt-in; deterministic-only by default.',
  apiVersion: '^0.1.10',
  capabilities: { tools: true },
  // Wrap-stack contract (issue #362): ExtensionRegistry composes wrappers
  // first-registered = outermost, and both dependsOn and optionalDeps load
  // dependencies first. Declaring prompt-firewall here guarantees the
  // firewall wraps OUTSIDE this cache even if the manifest order changes —
  // otherwise a cache hit short-circuits `inner` and bypasses redaction.
  optionalDeps: ['prompt-firewall'],
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      enabled: {
        type: 'boolean',
        default: true,
        description:
          'Master switch after the plugin is loaded. Plugin loading is controlled separately.',
      },
      maxEntries: {
        type: 'number',
        minimum: 1,
        default: 256,
        description: 'LRU capacity; oldest entries are evicted past this.',
      },
      ttlMs: {
        type: 'number',
        minimum: 0,
        default: 0,
        description: 'Entry lifetime in ms. 0 = no expiry.',
      },
      onlyDeterministic: {
        type: 'boolean',
        default: true,
        description:
          'Only cache requests with temperature 0 or unset (never freeze a sampled generation).',
      },
      zeroUsageOnHit: {
        type: 'boolean',
        default: false,
        description:
          'Report 0 tokens on a cache hit (true) so cost tracking reflects the saving, or keep the cached usage for context accounting (false).',
      },
    },
  },

  setup(api: PluginAPI) {
    const state = hosts.reset(api);
    const cfg = readConfig(api.config.extensions?.['llm-cache']);

    // ── The intervention: wrap every provider call ────────────────────
    if (cfg.enabled) {
      // Announce participation in the wrap stack so plugin-stack-observer
      // can build a system-prompt summary of who is wrapping what.
      api.emitCustom?.('provider.wrap:loaded', {
        plugin: 'llm-cache',
        kind: 'cache',
        wraps: ['request'],
      });
      state.extensionUnregister = api.extensions.register({
        name: 'llm-cache',
        owner: 'llm-cache',
        async wrapProviderRunner(
          _ctx: unknown,
          request: unknown,
          inner: (c: unknown, r: unknown) => Promise<unknown>,
        ) {
          const signal = providerSignal(state, _ctx);
          signal.throwIfAborted();
          const req = (request ?? {}) as Record<string, unknown>;
          if (cfg.onlyDeterministic && !isDeterministic(req)) {
            state.skips += 1;
            api.metrics.counter('skips');
            return inner(_ctx, request);
          }

          const provider = (_ctx as { provider?: unknown } | null)?.provider;
          let providerId = 0;
          if (provider && typeof provider === 'object') {
            providerId = state.providers.get(provider) ?? ++state.nextProviderId;
            state.providers.set(provider, providerId);
          }
          const key = `${providerId}:${fingerprintRequest(req)}`;
          const cached = lruGet(state, key, cfg.ttlMs);
          if (cached) {
            cached.hits += 1;
            state.hits += 1;
            state.savedInputTokens += cached.response.usage?.input ?? 0;
            state.savedOutputTokens += cached.response.usage?.output ?? 0;
            api.metrics.counter('hits');
            const replay = structuredClone(cached.response);
            if (cfg.zeroUsageOnHit) {
              return {
                ...replay,
                usage: { ...replay.usage, input: 0, output: 0 },
              };
            }
            return replay;
          }

          state.misses += 1;
          api.metrics.counter('misses');
          const generation = state.generation;
          const response = (await inner(_ctx, request)) as CachedResponse;
          signal.throwIfAborted();
          // Only cache well-formed responses that ended cleanly — never
          // cache a truncated / refusal / error-shaped response.
          const sr = response && typeof response === 'object' ? response.stopReason : undefined;
          const normSr = typeof sr === 'string' ? sr.toLowerCase() : '';
          const validStopReasons = new Set([
            'end_turn',
            'stop',
            'tool_use',
            'tool_calls',
            'function_call',
            'stop_sequence',
          ]);
          if (
            response &&
            typeof response === 'object' &&
            validStopReasons.has(normSr) &&
            generation === state.generation
          ) {
            try {
              lruSet(state, key, structuredClone(response), cfg.maxEntries);
            } catch {
              // An embedded provider may return non-cloneable metadata. Return it without caching.
            }
          }
          return response;
        },
      } as never);
    }

    // ── llm_cache_status tool ─────────────────────────────────────────
    api.tools.register({
      name: 'llm_cache_status',
      description:
        'Reports llm-cache state: enabled, size, hit/miss/skip counters, and tokens saved by cache hits.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute() {
        const total = state.hits + state.misses;
        return {
          ok: true,
          enabled: cfg.enabled,
          onlyDeterministic: cfg.onlyDeterministic,
          maxEntries: cfg.maxEntries,
          ttlMs: cfg.ttlMs,
          size: state.cache.size,
          counters: {
            hits: state.hits,
            misses: state.misses,
            skips: state.skips,
            evictions: state.evictions,
            hitRate: total > 0 ? Number((state.hits / total).toFixed(3)) : 0,
          },
          saved: { inputTokens: state.savedInputTokens, outputTokens: state.savedOutputTokens },
        };
      },
    });

    // ── llm_cache_clear tool ──────────────────────────────────────────
    api.tools.register({
      name: 'llm_cache_clear',
      description: 'Drops all cached provider responses (does not disable the cache).',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: true,
      async execute() {
        const cleared = state.cache.size;
        state.generation++;
        state.cache.clear();
        return { ok: true, cleared };
      },
    });

    api.log.info('llm-cache plugin loaded', {
      version: '0.1.0',
      enabled: cfg.enabled,
      onlyDeterministic: cfg.onlyDeterministic,
      maxEntries: cfg.maxEntries,
    });
  },

  teardown(api) {
    const state = hosts.remove(api);
    if (!state) return;
    const final = {
      hits: state.hits,
      misses: state.misses,
      skips: state.skips,
      savedInputTokens: state.savedInputTokens,
      savedOutputTokens: state.savedOutputTokens,
    };
    state.cache.clear();
    state.hits = 0;
    state.misses = 0;
    state.skips = 0;
    state.evictions = 0;
    state.savedInputTokens = 0;
    state.savedOutputTokens = 0;
    api.log.info('llm-cache: teardown complete', { final });
  },

  async health() {
    const state = createState();
    for (const active of hosts.values()) {
      state.hits += active.hits;
      state.misses += active.misses;
      state.skips += active.skips;
      state.evictions += active.evictions;
      state.savedInputTokens += active.savedInputTokens;
      state.savedOutputTokens += active.savedOutputTokens;
    }
    const cacheSize = [...hosts.values()].reduce((sum, active) => sum + active.cache.size, 0);
    const total = state.hits + state.misses;
    return {
      ok: true,
      message: `llm-cache: ${cacheSize} entr(ies), ${state.hits} hit(s) / ${state.misses} miss(es) (${total > 0 ? Math.round((state.hits / total) * 100) : 0}% hit rate), ~${state.savedInputTokens + state.savedOutputTokens} tokens saved`,
      counters: {
        hits: state.hits,
        misses: state.misses,
        skips: state.skips,
        evictions: state.evictions,
      },
    };
  },
};

export default plugin;

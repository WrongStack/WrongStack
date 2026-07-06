import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  ModelsDevPayload,
  ModelsDevProvider,
  ModelsRegistry,
  ResolvedModel,
  ResolvedProvider,
  WireFamily,
} from '../types/models-registry.js';
import { atomicWrite } from '../utils/atomic-write.js';
import { toErrorMessage } from '../utils/error.js';
import { mergeModelsPayload } from '../utils/merge-models-payload.js';
import { FetchError } from '../types/errors.js';

const DEFAULT_URL = 'https://models.dev/api.json';
/** Env var to override the models.dev base URL (e.g. for self-hosted mirrors). */
const ENV_URL_KEY = 'WRONGSTACK_MODELS_DEV_URL';
const DEFAULT_TTL_SECONDS = 24 * 3600;
const DEFAULT_REFRESH_TIMEOUT_MS = 15_000;

interface CacheEnvelope {
  fetchedAt: string;
  url: string;
  payload: ModelsDevPayload;
}

export interface DefaultModelsRegistryOptions {
  cacheFile: string;
  url?: string | undefined;
  ttlSeconds?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
  /** Pre-seeded payload — useful for offline scenarios and tests. */
  seed?: ModelsDevPayload | undefined;
  /**
   * Maximum age in seconds for stale cache fallback when network fails.
   * Defaults to 7 days. Set to `Infinity` for full offline resilience
   * (risk: deprecated models, wrong pricing). Set to `0` to disable
   * stale fallback entirely.
   */
  maxStaleAgeSeconds?: number | undefined;
  /**
   * Timeout in milliseconds for the models.dev network fetch. When exceeded,
   * the fetch is aborted and cache/stale fallback is used instead.
   * Defaults to 15 seconds. Set to `0` to disable (infinite wait).
   */
  refreshTimeoutMs?: number | undefined;
  /**
   * Curated override payload deep-merged ON TOP of the models.dev base via
   * `mergeModelsPayload` — adds providers/models the base lacks and overrides
   * fields it gets wrong. Resolution order (first non-empty wins): this
   * in-memory `overlay` → `overlayUrl` (fetched, cached) → `overlayFile`
   * (bundled, read from disk). A missing/broken overlay degrades to `{}` and
   * never throws, so the base alone still works.
   */
  overlay?: ModelsDevPayload | undefined;
  /** GitHub-raw (or any) URL serving the curated overlay `providers.json`. */
  overlayUrl?: string | undefined;
  /** Path to the bundled overlay `providers.json` (offline floor). */
  overlayFile?: string | undefined;
  /** Cache file for the fetched `overlayUrl`. Defaults next to `cacheFile`. */
  overlayCacheFile?: string | undefined;
}

/**
 * The npm package each models.dev provider declares determines which wire
 * family WrongStack speaks. Anything not listed falls into `unsupported` and
 * can be enabled by registering a custom provider factory via a plugin.
 */
const FAMILY_BY_NPM: Record<string, WireFamily> = {
  '@ai-sdk/anthropic': 'anthropic',
  '@ai-sdk/google-vertex/anthropic': 'anthropic',
  '@ai-sdk/openai': 'openai',
  '@ai-sdk/openai-compatible': 'openai-compatible',
  '@ai-sdk/groq': 'openai-compatible',
  '@ai-sdk/xai': 'openai-compatible',
  '@ai-sdk/cerebras': 'openai-compatible',
  '@ai-sdk/togetherai': 'openai-compatible',
  '@ai-sdk/mistral': 'openai-compatible',
  '@ai-sdk/perplexity': 'openai-compatible',
  '@ai-sdk/deepinfra': 'openai-compatible',
  '@openrouter/ai-sdk-provider': 'openai-compatible',
  'ai-gateway-provider': 'openai-compatible',
  '@ai-sdk/vercel': 'openai-compatible',
  '@ai-sdk/gateway': 'openai-compatible',
  '@aihubmix/ai-sdk-provider': 'openai-compatible',
  'venice-ai-sdk-provider': 'openai-compatible',
  '@ai-sdk/deepseek': 'openai-compatible',
  '@ai-sdk/google': 'google',
};

const FAMILY_BY_PROVIDER_ID: Partial<Record<string, WireFamily>> = {
  'anthropic-oauth': 'anthropic-oauth',
  'github-copilot': 'github-copilot',
  'openai-codex': 'openai-codex',
};

export function classifyFamily(npm: string | undefined): WireFamily {
  if (!npm) return 'unsupported';
  return FAMILY_BY_NPM[npm] ?? 'unsupported';
}

function classifyProviderFamily(p: ModelsDevProvider): WireFamily {
  const byNpm = classifyFamily(p.npm);
  return byNpm !== 'unsupported' ? byNpm : (FAMILY_BY_PROVIDER_ID[p.id] ?? 'unsupported');
}

export class DefaultModelsRegistry implements ModelsRegistry {
  /** Merged (base + overlay) payload — what every reader sees. */
  private payload?: ModelsDevPayload | undefined;
  /** Memoised overlay payload (in-memory / fetched / file). */
  private overlayPayload?: ModelsDevPayload | undefined;
  /**
   * Extra providers injected at runtime via `mergeOverlay()` — e.g. an
   * openai-compatible server (omniroute, LiteLLM, …) auto-discovered from its
   * `/v1/models` endpoint at boot. Applied LAST (on top of base + curated
   * overlay) and re-applied across `refresh()` so the discovered catalog
   * survives a models.dev refetch.
   */
  private extraOverlay?: ModelsDevPayload | undefined;
  private fetchedAt?: Date | undefined;
  private readonly cacheFile: string;
  private readonly url: string;
  private readonly ttlMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly seed?: ModelsDevPayload | undefined;
  private readonly maxStaleAgeMs: number;
  private readonly refreshTimeoutMs: number;
  private readonly overlay?: ModelsDevPayload | undefined;
  private readonly overlayUrl?: string | undefined;
  private readonly overlayFile?: string | undefined;
  private readonly overlayCacheFile?: string | undefined;

  constructor(opts: DefaultModelsRegistryOptions) {
    this.cacheFile = opts.cacheFile;
    this.url = opts.url ?? process.env[ENV_URL_KEY] ?? DEFAULT_URL;
    this.ttlMs = (opts.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.seed = opts.seed;
    // Default max stale age: 7 days
    const maxStaleSeconds = opts.maxStaleAgeSeconds ?? 7 * 24 * 3600;
    this.maxStaleAgeMs = maxStaleSeconds * 1000;
    this.refreshTimeoutMs = opts.refreshTimeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS;
    this.overlay = opts.overlay;
    this.overlayUrl = opts.overlayUrl;
    this.overlayFile = opts.overlayFile;
    this.overlayCacheFile =
      opts.overlayCacheFile ??
      (opts.overlayUrl
        ? path.join(path.dirname(opts.cacheFile), 'models-overlay-cache.json')
        : undefined);
  }

  async load(opts: { force?: boolean | undefined } = {}): Promise<ModelsDevPayload> {
    if (this.payload && !opts.force) return this.payload;
    // A `seed` is treated as the complete, final payload — used for offline
    // scenarios and tests. It bypasses both the base fetch and the overlay.
    if (this.seed) {
      this.payload = this.seed;
      this.fetchedAt = new Date();
      return this.payload;
    }
    // Load the overlay first so base degradation can tell whether there is
    // actually curated data to serve when models.dev is unreachable.
    const overlay = await this.loadOverlay(opts);
    const base = await this.loadBase(opts, Object.keys(overlay).length > 0);
    this.payload = this.withExtraOverlay(mergeModelsPayload(base, overlay));
    return this.payload;
  }

  /**
   * Merge an additional provider payload on top of the resolved catalog. Used
   * for runtime-discovered openai-compatible providers. Remembered so it is
   * re-applied across `refresh()`. A no-op for an empty payload.
   */
  mergeOverlay(payload: ModelsDevPayload): void {
    if (!hasEntries(payload)) return;
    this.extraOverlay = this.extraOverlay
      ? mergeModelsPayload(this.extraOverlay, payload)
      : payload;
    if (this.payload) this.payload = mergeModelsPayload(this.payload, this.extraOverlay);
  }

  private withExtraOverlay(payload: ModelsDevPayload): ModelsDevPayload {
    return this.extraOverlay ? mergeModelsPayload(payload, this.extraOverlay) : payload;
  }

  /**
   * Load the models.dev base payload: fresh cache → network → stale cache.
   * On total failure, degrade to `{}` (so a non-empty overlay still drives
   * the catalog) rather than throwing — unless there's no curated overlay to
   * fall back on, in which case the original error propagates so pure-
   * models.dev setups still surface the problem.
   */
  private async loadBase(
    opts: { force?: boolean | undefined } = {},
    overlayAvailable = false,
  ): Promise<ModelsDevPayload> {
    if (!opts.force) {
      const cached = await this.readCacheAt(this.cacheFile);
      if (cached && this.isFresh(cached.fetchedAt)) {
        this.fetchedAt = new Date(cached.fetchedAt);
        return cached.payload;
      }
    }
    try {
      return await this.refreshBase();
    } catch (err) {
      // Network failed — fall back to stale cache if within maxStaleAgeMs.
      const cached = await this.readCacheAt(this.cacheFile);
      if (cached && this.isWithinMaxStaleAge(cached.fetchedAt)) {
        this.fetchedAt = new Date(cached.fetchedAt);
        const ageSeconds = Math.floor((Date.now() - this.fetchedAt.getTime()) / 1000);
        // eslint-disable-next-line no-console -- user-visible operator warning
        console.warn(
          `ModelsRegistry: models.dev unavailable (${toErrorMessage(err)}); ` +
            `using stale cache from ${formatAge(ageSeconds)} ago. Run \`wstack models refresh\` to retry.`,
        );
        return cached.payload;
      }
      if (overlayAvailable) {
        // eslint-disable-next-line no-console -- one-line operator warning
        console.warn(
          `ModelsRegistry: models.dev unavailable (${toErrorMessage(
            err,
          )}); serving curated overlay only.`,
        );
        return {};
      }
      throw err;
    }
  }

  /** Fetch + cache the models.dev base. Throws on failure (used by `refresh`). */
  private async refreshBase(): Promise<ModelsDevPayload> {
    const controller = new AbortController();
    /* v8 ignore next -- timing: the abort callback only fires if the real fetch exceeds the timeout */
    const timeout = setTimeout(() => controller.abort(), this.refreshTimeoutMs);
    try {
      const res = await this.fetchImpl(this.url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) {
        throw new FetchError({
          message: `ModelsRegistry: HTTP ${res.status} fetching ${this.url}`,
          status: res.status,
          context: { url: this.url, op: 'refreshModels' },
        });
      }
      const json = (await res.json()) as ModelsDevPayload;
      this.fetchedAt = new Date();
      const envelope: CacheEnvelope = {
        fetchedAt: this.fetchedAt.toISOString(),
        url: this.url,
        payload: json,
      };
      await atomicWrite(this.cacheFile, JSON.stringify(envelope));
      return json;
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new FetchError({
          message: `ModelsRegistry: fetch timed out after ${this.refreshTimeoutMs}ms`,
          status: 408,
          context: { url: this.url, op: 'refreshModels', timedOut: true },
        });
      }
      throw err;
    }
  }

  /**
   * Resolve the curated overlay, memoised. Order: in-memory `overlay` →
   * fetched `overlayUrl` (cached, same TTL/stale rules) → `overlayFile` on
   * disk. Never throws — a missing/broken overlay yields `{}`.
   */
  private async loadOverlay(opts: { force?: boolean | undefined } = {}): Promise<ModelsDevPayload> {
    /* v8 ignore next -- unreachable: load() caches `payload` and short-circuits before re-calling loadOverlay non-forced */
    if (this.overlayPayload && !opts.force) return this.overlayPayload;
    if (hasEntries(this.overlay)) {
      this.overlayPayload = this.overlay;
      return this.overlayPayload;
    }
    const fetched = await this.loadOverlayFromUrl(opts);
    if (hasEntries(fetched)) {
      this.overlayPayload = fetched;
      return fetched;
    }
    const fromFile = await this.readOverlayFile();
    this.overlayPayload = fromFile ?? {};
    return this.overlayPayload;
  }

  private async loadOverlayFromUrl(opts: {
    force?: boolean | undefined;
  }): Promise<ModelsDevPayload | undefined> {
    if (!this.overlayUrl || !this.overlayCacheFile) return undefined;
    if (!opts.force) {
      const cached = await this.readCacheAt(this.overlayCacheFile);
      if (cached && this.isFresh(cached.fetchedAt)) return cached.payload;
    }
    try {
      const res = await this.fetchImpl(this.overlayUrl, {
        method: 'GET',
        headers: { accept: 'application/json' },
      });
      if (!res.ok)
        throw new FetchError({
          message: `HTTP ${res.status}`,
          status: res.status,
          context: { url: this.url, op: 'refreshModels' },
        });
      const json = (await res.json()) as ModelsDevPayload;
      const envelope: CacheEnvelope = {
        fetchedAt: new Date().toISOString(),
        url: this.overlayUrl,
        payload: json,
      };
      /* v8 ignore next -- best-effort: overlay-cache write failure is intentionally ignored */
      await atomicWrite(this.overlayCacheFile, JSON.stringify(envelope)).catch(() => {});
      return json;
    } catch {
      // Network/parse failure — fall back to stale overlay cache, then the
      // bundled file (handled by the caller).
      const cached = await this.readCacheAt(this.overlayCacheFile);
      if (cached && this.isWithinMaxStaleAge(cached.fetchedAt)) {
        const ageSeconds = Math.floor((Date.now() - new Date(cached.fetchedAt).getTime()) / 1000);
        // eslint-disable-next-line no-console -- operator-visible warning
        console.warn(
          `ModelsRegistry: overlay unavailable; using stale overlay from ${formatAge(ageSeconds)} ago.`,
        );
        return cached.payload;
      }
      return undefined;
    }
  }

  private async readOverlayFile(): Promise<ModelsDevPayload | undefined> {
    if (!this.overlayFile) return undefined;
    try {
      const raw = await fs.readFile(this.overlayFile, 'utf8');
      return JSON.parse(raw) as ModelsDevPayload;
    } catch {
      return undefined;
    }
  }

  async refresh(): Promise<ModelsDevPayload> {
    // Refresh the models.dev base (throws on failure so `wstack models refresh`
    // can report it), then recompute the merged payload with a fresh overlay.
    const base = await this.refreshBase();
    const overlay = await this.loadOverlay({ force: true });
    this.payload = this.withExtraOverlay(mergeModelsPayload(base, overlay));
    return this.payload;
  }

  async listProviders(): Promise<ResolvedProvider[]> {
    const payload = await this.load();
    return Object.values(payload).map((p) => this.resolveProvider(p));
  }

  async getProvider(id: string): Promise<ResolvedProvider | undefined> {
    const payload = await this.load();
    const p = payload[id];
    return p ? this.resolveProvider(p) : undefined;
  }

  async getModel(providerId: string, modelId: string): Promise<ResolvedModel | undefined> {
    const provider = await this.getProvider(providerId);
    if (!provider) return undefined;
    const model = provider.models.find((m) => m.id === modelId);
    if (!model) return undefined;
    return {
      providerId,
      modelId,
      capabilities: {
        tools: model.tool_call ?? false,
        vision: Boolean(model.modalities?.input?.includes('image')),
        reasoning: model.reasoning ?? model.reasoningConfig !== undefined,
        maxContext: model.limit?.context ?? 0,
        maxOutput: model.limit?.output,
        knowledge: model.knowledge,
        reasoningConfig: model.reasoningConfig,
      },
      cost: model.cost,
    };
  }

  async suggestModel(providerId: string): Promise<string | undefined> {
    const provider = await this.getProvider(providerId);
    if (!provider || provider.models.length === 0) return undefined;
    const ranked = [...provider.models].sort((a, b) => {
      const at = a.release_date ?? a.last_updated ?? '';
      const bt = b.release_date ?? b.last_updated ?? '';
      return bt.localeCompare(at);
    });
    return ranked[0]?.id;
  }

  async ageSeconds(): Promise<number> {
    if (!this.fetchedAt) {
      const cached = await this.readCacheAt(this.cacheFile);
      if (!cached) return Number.POSITIVE_INFINITY;
      return (Date.now() - new Date(cached.fetchedAt).getTime()) / 1000;
    }
    return (Date.now() - this.fetchedAt.getTime()) / 1000;
  }

  private resolveProvider(p: ModelsDevProvider): ResolvedProvider {
    return {
      id: p.id,
      name: p.name,
      family: classifyProviderFamily(p),
      apiBase: p.api,
      envVars: p.env ?? [],
      doc: p.doc,
      models: Object.values(p.models ?? {}),
      npm: p.npm,
    };
  }

  private isFresh(fetchedAtIso: string): boolean {
    return Date.now() - new Date(fetchedAtIso).getTime() < this.ttlMs;
  }

  private isWithinMaxStaleAge(fetchedAtIso: string): boolean {
    return Date.now() - new Date(fetchedAtIso).getTime() < this.maxStaleAgeMs;
  }

  private async readCacheAt(file: string): Promise<CacheEnvelope | undefined> {
    try {
      const raw = await fs.readFile(file, 'utf8');
      return JSON.parse(raw) as CacheEnvelope;
    } catch {
      return undefined;
    }
  }

  /** Used by `wstack models refresh` to expose where the cache lives. */
  cacheLocation(): string {
    return path.resolve(this.cacheFile);
  }
}

/** Render a seconds-duration as a human-friendly "Xh Ym" or "Xd" string. */
function formatAge(seconds: number): string {
  if (seconds < 60) return '<1m';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  return `${Math.floor(seconds / 86400)}d`;
}

function hasEntries(payload: ModelsDevPayload | undefined): payload is ModelsDevPayload {
  return payload !== undefined && Object.keys(payload).length > 0;
}

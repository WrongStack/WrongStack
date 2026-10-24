import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { FetchError } from '@wrongstack/contracts/types/errors';
import type { Logger } from '@wrongstack/contracts/types/logger';
import type {
  ModelCatalogSource,
  ModelsDevPayload,
  ModelsDevProvider,
  ModelsRegistry,
  ResolvedModel,
  ResolvedProvider,
} from '@wrongstack/contracts/types/models-registry';
import { noOpLogger } from '../infrastructure/logger.js';
import { atomicWrite } from '../utils/atomic-write.js';
import { toErrorMessage } from '../utils/error.js';
import { mergeModelsPayload } from '../utils/merge-models-payload.js';
import {
  annotatePayload,
  classifyProviderFamily,
  fillAccountModelGaps,
  formatAge,
  hasEntries,
  looksLikeModelsPayload,
  normalizeModelsDevModel,
} from './models-registry-normalization.js';

export { classifyFamily } from './models-registry-normalization.js';

const DEFAULT_URL = 'https://models.dev/api.json';
/** Env var to override the models.dev base URL (e.g. for self-hosted mirrors). */
const ENV_URL_KEY = 'WRONGSTACK_MODELS_DEV_URL';
const DEFAULT_TTL_SECONDS = 3 * 3600;
const DEFAULT_REFRESH_TIMEOUT_MS = 15_000;

export interface RuntimeModelsOverlayOptions {
  /** Source attached to every incoming model. Defaults to provider discovery. */
  source?: ModelCatalogSource | undefined;
  /** Provider ids whose incoming model keys replace, rather than extend, the catalog set. */
  authoritativeProviderIds?: readonly string[] | undefined;
  /** Observation time for live/cache-backed provider snapshots. */
  observedAt?: string | undefined;
  /**
   * Catalog provider whose same-id models fill the fields an account snapshot
   * does not state. Account catalogs (ChatGPT sign-in, the ChatGPT plan API)
   * publish their own context windows and reasoning levels but no output
   * ceiling or knowledge cutoff; models.dev publishes those for the identical
   * model ids under `openai`. Only gaps are filled: the account's context,
   * modalities and reasoning levels always win, and per-token API pricing and
   * lifecycle status are never copied onto a subscription model.
   */
  metadataFallbackProviderId?: string | undefined;
}

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
  /**
   * Structured logger. Defaults to noOpLogger (silent).
   * Callers pass a Logger to capture operator-visible diagnostics (cache
   * fallback warnings, overlay unavailability, etc.).
   */
  logger?: Logger | undefined;
}

export class DefaultModelsRegistry implements ModelsRegistry {
  /** Merged (base + overlay) payload — what every reader sees. */
  private payload?: ModelsDevPayload | undefined;
  /** Base + curated overlay, before runtime discovery is applied. */
  private catalogPayload?: ModelsDevPayload | undefined;
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
  private readonly authoritativeModelIds = new Map<string, Set<string>>();
  /** Account provider id -> catalog provider id that fills its snapshot's gaps. */
  private readonly metadataFallback = new Map<string, string>();
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
  private readonly logger: Logger;
  private refreshInFlight?: Promise<ModelsDevPayload> | undefined;
  private generation = 0;
  private readonly catalogListeners = new Set<(payload: ModelsDevPayload) => void>();

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
    this.logger = opts.logger ?? noOpLogger;
  }

  async load(opts: { force?: boolean | undefined } = {}): Promise<ModelsDevPayload> {
    if (this.payload && !opts.force) return this.payload;
    // A `seed` is treated as the complete, final payload — used for offline
    // scenarios and tests. It bypasses the base fetch and the CURATED overlay,
    // but NOT `extraOverlay`: that carries runtime-discovered providers, which
    // are orthogonal to where the catalog came from. Dropping it here silently
    // lost every auto-discovered model whenever `mergeOverlay` ran before the
    // first `load()` — the exact ordering a local gateway hits offline.
    if (this.seed) {
      this.catalogPayload = annotatePayload(this.seed, 'models-dev');
      this.fetchedAt = new Date();
      return this.publish(this.withExtraOverlay(this.catalogPayload));
    }
    // Load the overlay first so base degradation can tell whether there is
    // actually curated data to serve when models.dev is unreachable.
    const overlay = await this.loadOverlay(opts);
    const base = await this.loadBase(opts, Object.keys(overlay).length > 0);
    this.catalogPayload = mergeModelsPayload(
      annotatePayload(base, 'models-dev'),
      annotatePayload(overlay, 'wrongstack-overlay'),
    );
    return this.publish(this.withExtraOverlay(this.catalogPayload));
  }

  /**
   * Merge an additional provider payload on top of the resolved catalog. Used
   * for runtime-discovered openai-compatible providers. Remembered so it is
   * re-applied across `refresh()`. A no-op for an empty payload.
   */
  mergeOverlay(payload: ModelsDevPayload, opts: RuntimeModelsOverlayOptions = {}): void {
    if (!hasEntries(payload)) return;
    const source = opts.source ?? 'provider-discovery';
    const authoritative = new Set(opts.authoritativeProviderIds ?? []);
    const annotated = annotatePayload(payload, source, {
      observedAt: opts.observedAt ?? new Date().toISOString(),
      authoritative: authoritative.size > 0 ? true : undefined,
    });
    this.extraOverlay = this.extraOverlay
      ? mergeModelsPayload(this.extraOverlay, annotated)
      : annotated;
    for (const providerId of authoritative) {
      const incoming = annotated[providerId];
      if (!incoming) continue;
      this.authoritativeModelIds.set(providerId, new Set(Object.keys(incoming.models)));
      const cloned = mergeModelsPayload({}, { [providerId]: incoming })[providerId];
      if (cloned) this.extraOverlay[providerId] = cloned;
    }
    if (opts.metadataFallbackProviderId) {
      for (const providerId of Object.keys(payload)) {
        if (providerId !== opts.metadataFallbackProviderId)
          this.metadataFallback.set(providerId, opts.metadataFallbackProviderId);
      }
    }
    if (this.catalogPayload) this.publish(this.withExtraOverlay(this.catalogPayload));
  }

  private withExtraOverlay(payload: ModelsDevPayload): ModelsDevPayload {
    const merged = this.extraOverlay ? mergeModelsPayload(payload, this.extraOverlay) : payload;
    for (const [providerId, allowed] of this.authoritativeModelIds) {
      const provider = merged[providerId];
      if (!provider) continue;
      provider.models = Object.fromEntries(
        Object.entries(provider.models).filter(
          ([modelId, model]) =>
            allowed.has(modelId) ||
            // Explicit ChatGPT overlay suggestions survive stale/empty account
            // snapshots; generic models.dev membership remains account-scoped.
            (['openai-codex', 'openai-chatgpt'].includes(providerId) &&
              model.provenance?.sources.includes('wrongstack-overlay')),
        ),
      );
    }
    for (const [providerId, fromId] of this.metadataFallback) {
      const provider = merged[providerId];
      const from = merged[fromId];
      if (!provider || !from) continue;
      provider.models = Object.fromEntries(
        Object.entries(provider.models).map(([modelId, model]) => [
          modelId,
          fillAccountModelGaps(model, from.models[modelId]),
        ]),
      );
    }
    return merged;
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
        this.logger.warn(
          `ModelsRegistry: models.dev unavailable (${toErrorMessage(err)}); ` +
            `using stale cache from ${formatAge(ageSeconds)} ago. Run \`wstack models refresh\` to retry.`,
          { event: 'models_registry.stale_cache_fallback' },
        );
        return cached.payload;
      }
      if (overlayAvailable) {
        this.logger.warn(
          `ModelsRegistry: models.dev unavailable (${toErrorMessage(
            err,
          )}); serving curated overlay only.`,
          { event: 'models_registry.overlay_only_fallback' },
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
      const json = (await res.json()) as unknown;
      if (!looksLikeModelsPayload(json, true)) {
        // A 200 with non-catalog JSON (captive portal, CDN error page). Do NOT
        // cache it — throw so loadBase falls back to the stale cache instead of
        // serving poison for the full TTL.
        throw new FetchError({
          message: `ModelsRegistry: ${this.url} returned a non-catalog payload`,
          status: 502,
          context: { url: this.url, op: 'refreshModels', reason: 'invalid-shape' },
        });
      }
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
    const controller = new AbortController();
    // The base fetch is timeout-bounded; the overlay fetch was not, so a
    // stalled overlay host could hang load() (and boot) indefinitely.
    const timeout = setTimeout(() => controller.abort(), this.refreshTimeoutMs);
    try {
      const res = await this.fetchImpl(this.overlayUrl, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok)
        throw new FetchError({
          message: `HTTP ${res.status}`,
          status: res.status,
          context: { url: this.url, op: 'refreshModels' },
        });
      const json = (await res.json()) as unknown;
      // Reject a non-catalog payload (error page) so it can't poison the
      // overlay cache. Lenient: overlays may be partial diffs, so we don't
      // demand a `models` map on every entry.
      if (!looksLikeModelsPayload(json, false)) {
        throw new FetchError({
          message: `ModelsRegistry: ${this.overlayUrl} returned a non-catalog payload`,
          status: 502,
          context: { url: this.overlayUrl, op: 'refreshModels', reason: 'invalid-shape' },
        });
      }
      const envelope: CacheEnvelope = {
        fetchedAt: new Date().toISOString(),
        url: this.overlayUrl,
        payload: json,
      };
      /* v8 ignore next -- best-effort: overlay-cache write failure is intentionally ignored */
      await atomicWrite(this.overlayCacheFile, JSON.stringify(envelope)).catch(() => {});
      return json;
    } catch {
      clearTimeout(timeout);
      // Network/parse/timeout/invalid-shape failure — fall back to stale
      // overlay cache, then the bundled file (handled by the caller).
      const cached = await this.readCacheAt(this.overlayCacheFile);
      if (cached && this.isWithinMaxStaleAge(cached.fetchedAt)) {
        const ageSeconds = Math.floor((Date.now() - new Date(cached.fetchedAt).getTime()) / 1000);
        this.logger.warn(
          `ModelsRegistry: overlay unavailable; using stale overlay from ${formatAge(ageSeconds)} ago.`,
          { event: 'models_registry.overlay_stale_fallback', ageSeconds },
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

  refresh(): Promise<ModelsDevPayload> {
    // Single-flight: boot's background refresh, a model switch and the model
    // picker can all ask at once — they share one network round-trip instead
    // of racing three fetches (and three cache writes) against each other.
    if (this.refreshInFlight) return this.refreshInFlight;
    const run = this.refreshOnce().finally(() => {
      this.refreshInFlight = undefined;
    });
    this.refreshInFlight = run;
    return run;
  }

  private async refreshOnce(): Promise<ModelsDevPayload> {
    // Refresh the models.dev base (throws on failure so `wstack models refresh`
    // can report it), then recompute the merged payload with a fresh overlay.
    const base = await this.refreshBase();
    const overlay = await this.loadOverlay({ force: true });
    this.catalogPayload = mergeModelsPayload(
      annotatePayload(base, 'models-dev'),
      annotatePayload(overlay, 'wrongstack-overlay'),
    );
    return this.publish(this.withExtraOverlay(this.catalogPayload));
  }

  /**
   * Serve the cached catalog with NO network I/O: the models.dev base cache
   * (within `maxStaleAgeSeconds`, whatever the TTL) plus the overlay from its
   * cache or the bundled file. Lets a long-lived process start instantly and
   * refresh in the background. Resolves `false` — and leaves the registry
   * untouched — when there is no usable base cache; the caller then fetches.
   */
  async loadCached(): Promise<boolean> {
    if (this.seed) {
      await this.load();
      return true;
    }
    const cached = await this.readCacheAt(this.cacheFile);
    if (!cached || !this.isWithinMaxStaleAge(cached.fetchedAt)) return false;
    if (!looksLikeModelsPayload(cached.payload, true)) return false;
    const overlay = await this.loadCachedOverlay();
    this.fetchedAt = new Date(cached.fetchedAt);
    this.catalogPayload = mergeModelsPayload(
      annotatePayload(cached.payload, 'models-dev'),
      annotatePayload(overlay, 'wrongstack-overlay'),
    );
    this.publish(this.withExtraOverlay(this.catalogPayload));
    return true;
  }

  /** Overlay resolution without network: in-memory → URL cache → bundled file. */
  private async loadCachedOverlay(): Promise<ModelsDevPayload> {
    if (hasEntries(this.overlay)) return this.overlay;
    if (this.overlayCacheFile) {
      const cached = await this.readCacheAt(this.overlayCacheFile);
      if (
        cached &&
        this.isWithinMaxStaleAge(cached.fetchedAt) &&
        looksLikeModelsPayload(cached.payload, false) &&
        hasEntries(cached.payload)
      ) {
        return cached.payload;
      }
    }
    return (await this.readOverlayFile()) ?? {};
  }

  catalogGeneration(): number {
    return this.generation;
  }

  onCatalogChanged(listener: (payload: ModelsDevPayload) => void): () => void {
    this.catalogListeners.add(listener);
    return () => {
      this.catalogListeners.delete(listener);
    };
  }

  /**
   * The single write path for the served payload: swap it in, bump the
   * generation, then notify. Listeners run after the swap so they read the new
   * catalog; one throwing listener never blocks the rest or the caller.
   */
  private publish(next: ModelsDevPayload): ModelsDevPayload {
    this.payload = next;
    this.generation += 1;
    for (const listener of [...this.catalogListeners]) {
      try {
        listener(next);
      } catch (err) {
        this.logger.warn(`ModelsRegistry: catalog listener failed: ${toErrorMessage(err)}`, {
          event: 'models_registry.listener_failed',
        });
      }
    }
    return next;
  }

  async listProviders(): Promise<ResolvedProvider[]> {
    const payload = await this.load();
    return Object.values(payload).map((p) => this.resolveProvider(p));
  }

  async getProvider(id: string): Promise<ResolvedProvider | undefined> {
    const payload = await this.load();
    // Own-key read. `payload` is an ordinary object (JSON-derived catalog plus
    // merged overlays), so a bare `payload[id]` resolves inherited members for
    // ids like `toString`, `valueOf`, `constructor` or `__proto__` — an id that
    // names no catalog entry at all. `resolveProvider` then turns that
    // prototype value into a truthy `ResolvedProvider` (`name: 'toString'`,
    // empty models), so every existence-gated caller (`if (await
    // getProvider(id))`, `getModel`, `suggestModel`, the WebUI model picker
    // reaching this through a client-supplied `provider.models` id) accepts a
    // provider that does not exist.
    const p = Object.hasOwn(payload, id) ? payload[id] : undefined;
    return p ? this.resolveProvider(p) : undefined;
  }

  async getModel(providerId: string, modelId: string): Promise<ResolvedModel | undefined> {
    const provider = await this.getProvider(providerId);
    if (!provider) return undefined;
    const model = provider.models.find((m) => m.id === modelId);
    if (!model) return undefined;
    // NOTE (invariant): the raw-entry lookup above is a PLAIN id-find over
    // `resolveProvider(p).models`. `capabilities.reasoning` below coerces
    // `model.reasoning ?? false`, collapsing "documented non-reasoning" and
    // "metadata missing" — so consumers needing the raw fact (e.g. the CLI
    // /effort `loadModelLevels` raw-catalog lookup) must perform their own
    // find rather than trust the coerced boolean. If this lookup ever grows
    // aliasing, case-normalization, or provider filtering, those consumers
    // must follow or they will silently disagree with getModel.
    return {
      providerId,
      modelId,
      provenance: model.provenance,
      capabilities: {
        tools: model.tool_call ?? false,
        vision: Boolean(model.modalities?.input?.includes('image')),
        pdf: Boolean(model.modalities?.input?.includes('pdf')),
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
      models: Object.values(p.models ?? {}).map(normalizeModelsDevModel),
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

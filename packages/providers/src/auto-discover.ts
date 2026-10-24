import { createHash } from 'node:crypto';
import type {
  Config,
  ModelsDevModel,
  ModelsDevProvider,
  ProviderConfig,
} from '@wrongstack/contracts/types';
import { ProviderError } from '@wrongstack/contracts/types';
import type { CompatibleModelEntry } from './auto-discover-model-map.js';
import { mapCompatibleModel } from './auto-discover-model-map.js';
import { fetchCopilotModels } from './github-copilot-models.js';
import { copilotBaseUrlFromToken } from './github-copilot-token.js';
import {
  CODEX_BASE_URL,
  CODEX_ORIGINATOR,
  CODEX_USER_AGENT,
  codexClientVersion,
  codexModelsUrl,
} from './oauth/codex-protocol.js';
import { subscriptionModelsPath } from './oauth/subscription-models.js';
import { extractAccountId } from './openai-codex-account.js';
import { matchesActiveProviderCredential } from './provider-credential-state.js';
import { projectCompatibleProviderPresets } from './provider-definitions.js';
import { redirectSafeFetch } from './redirect-safe-fetch.js';
import { SUBSCRIPTION_ENDPOINTS, SubscriptionOAuthProvider } from './subscription-oauth.js';

export { mapCompatibleModel } from './auto-discover-model-map.js';

/** One provider that should have its model list fetched at boot. */
export interface DiscoveryTarget {
  id: string;
  cfg: ProviderConfig;
  baseUrl: string;
  apiKey?: string | undefined;
  /** Stable cache key. Shared so every host hits the same cache entries. */
  cacheKey: string;
  modelDiscoveryPath?: string | undefined;
  modelDiscoveryAuthoritative?: boolean | undefined;
  accountCatalog?: boolean | undefined;
  copilotCatalog?: boolean | undefined;
  modelsUrl?: string | undefined;
  headers?: Record<string, string> | undefined;
  /**
   * Leave the snapshot's `npm` unset so the catalog's own wire-family
   * classification stands. The ChatGPT account catalogs are not
   * openai-compatible endpoints: stamping that family on them downgraded every
   * model to the openai-compatible baseline (no reasoning) in `capabilitiesFor`.
   */
  inheritWireFamily?: boolean | undefined;
  /** Catalog provider whose same-id models fill the fields the account snapshot omits. */
  metadataCatalogId?: string | undefined;
  /** Renew account credentials before a catalog request; may update the cache identity. */
  prepareApiKey?: ((fetchImpl: typeof fetch) => Promise<string>) | undefined;
  /** Fence results if the selected account changes during discovery. */
  isCurrent?: (() => boolean) | undefined;
}

/**
 * models.dev provider that publishes the same model ids the ChatGPT account
 * catalogs serve. Used only to fill fields those catalogs never state (output
 * ceiling, knowledge cutoff); see `metadataFallbackProviderId`.
 */
export const CHATGPT_ACCOUNT_METADATA_CATALOG = 'openai';

/** Options a host passes to `registry.mergeOverlay` for one discovery snapshot. */
export interface DiscoveryOverlayOptions {
  authoritativeProviderIds?: readonly string[] | undefined;
  observedAt?: string | undefined;
  metadataFallbackProviderId?: string | undefined;
}

/**
 * The registry merge for one discovery snapshot, identical for every host.
 *
 * Both the CLI boot and the WebUI server merge discovery results; computing
 * the payload and options here keeps them from drifting. It also normalises
 * snapshots cached by older builds, which stamped the openai-compatible family
 * on account catalogs that are not openai-compatible.
 */
export function discoveryOverlay(
  target: Pick<
    DiscoveryTarget,
    'id' | 'modelDiscoveryAuthoritative' | 'inheritWireFamily' | 'metadataCatalogId'
  >,
  provider: ModelsDevProvider,
  observedAt?: string | undefined,
): { payload: Record<string, ModelsDevProvider>; options: DiscoveryOverlayOptions } {
  let snapshot = provider;
  if (target.inheritWireFamily && snapshot.npm !== undefined) {
    const { npm: _stamped, ...rest } = snapshot;
    snapshot = rest;
  }
  // Discovery names a snapshot after its config id; an account provider's
  // catalog entry already carries the real display name, which that id would
  // overwrite ("openai-codex" instead of "OpenAI Codex (ChatGPT sign-in)").
  // The merge keeps a base field the overlay leaves undefined.
  if (target.inheritWireFamily && snapshot.name === target.id) {
    snapshot = { ...snapshot, name: undefined } as unknown as ModelsDevProvider;
  }
  return {
    payload: { [target.id]: snapshot },
    options: {
      ...(target.modelDiscoveryAuthoritative
        ? { authoritativeProviderIds: [target.id], ...(observedAt ? { observedAt } : {}) }
        : {}),
      ...(target.metadataCatalogId ? { metadataFallbackProviderId: target.metadataCatalogId } : {}),
    },
  };
}

/**
 * Drop cache entries for earlier credentials of the same account catalog.
 *
 * Account cache keys carry a hash of the refresh token so one account's
 * models never stand in for another's. OAuth servers rotate that token on
 * every refresh, so without pruning each refresh appended a new full snapshot
 * and the cache file grew without bound (28 entries / 1.1 MB observed). Only
 * the current credential's snapshot can ever be read again.
 */
export function pruneDiscoveryCache(
  cache: Record<string, unknown>,
  target: Pick<DiscoveryTarget, 'id' | 'baseUrl' | 'accountCatalog' | 'cacheKey'>,
): boolean {
  if (!target.accountCatalog) return false;
  const prefix = `${target.id}\u0000${target.baseUrl}\u0000`;
  let pruned = false;
  for (const key of Object.keys(cache)) {
    if (key !== target.cacheKey && key.startsWith(prefix)) {
      delete cache[key];
      pruned = true;
    }
  }
  return pruned;
}

/** Active API key from a ProviderConfig (mirrors the provider factory's resolver). */
function resolveActiveKey(cfg: ProviderConfig): string | undefined {
  if (Array.isArray(cfg.apiKeys) && cfg.apiKeys.length > 0) {
    const active = cfg.activeKey ? cfg.apiKeys.find((k) => k.label === cfg.activeKey) : undefined;
    return (active ?? cfg.apiKeys[0])?.apiKey;
  }
  return cfg.apiKey && cfg.apiKey.length > 0 ? cfg.apiKey : undefined;
}

/**
 * Providers eligible for `/v1/models` auto-discovery, with their resolved base
 * URL and key.
 *
 * Single source of truth for BOTH hosts (CLI boot and the WebUI server). They
 * previously carried near-identical private copies whose cache keys used
 * different separators, so the two never shared a cache entry despite writing
 * to the same file.
 *
 * The preset is looked up by the config key AND by `cfg.type`, so a user alias
 * (`gateway-work` → `type: "ai-gateway"`) inherits `autoDiscover` and the
 * default base URL instead of silently opting out of discovery.
 */
export function resolveDiscoveryTargets(config: Config): DiscoveryTarget[] {
  const presets = projectCompatibleProviderPresets();
  const out: DiscoveryTarget[] = [];
  for (const [id, cfg] of Object.entries(config.providers ?? {})) {
    const active = cfg.apiKeys?.find((key) => key.label === cfg.activeKey) ?? cfg.apiKeys?.[0];
    const strategy = active?.oauthStrategyId;
    if (
      active?.authMethod === 'oauth' &&
      ((strategy && Object.hasOwn(SUBSCRIPTION_ENDPOINTS, strategy)) ||
        ['github-copilot', 'openai-codex'].includes(cfg.family ?? cfg.type))
    ) {
      const copilot = cfg.family === 'github-copilot';
      const codex = (cfg.family ?? cfg.type) === 'openai-codex';
      let baseUrl = cfg.baseUrl ?? (codex ? CODEX_BASE_URL : undefined);
      let modelsUrl: string | undefined;
      let headers: Record<string, string> | undefined;
      if (strategy && Object.hasOwn(SUBSCRIPTION_ENDPOINTS, strategy)) {
        try {
          new SubscriptionOAuthProvider({ id, credential: active, baseUrl });
        } catch {
          continue;
        }
        baseUrl ??= SUBSCRIPTION_ENDPOINTS[strategy];
      } else if (copilot) {
        baseUrl = copilotBaseUrlFromToken(active.apiKey);
      } else if (codex) {
        modelsUrl = `${codexModelsUrl(baseUrl)}?client_version=${encodeURIComponent(codexClientVersion())}`;
        headers = { originator: CODEX_ORIGINATOR, 'user-agent': CODEX_USER_AGENT };
        const accountId = active.accountId ?? extractAccountId(active.apiKey);
        if (accountId) headers['chatgpt-account-id'] = accountId;
      }
      if (!baseUrl) continue;
      const modelDiscoveryPath =
        strategy === 'xai' || strategy === 'chatgpt-api'
          ? subscriptionModelsPath(strategy)
          : undefined;
      const identity = createHash('sha256')
        .update(active.refreshToken ?? active.apiKey)
        .digest('hex');
      const target: DiscoveryTarget = {
        id,
        cfg,
        baseUrl,
        apiKey: active.apiKey,
        cacheKey: `${id}\u0000${baseUrl}\u0000${identity}`,
        modelDiscoveryPath,
        modelDiscoveryAuthoritative: true,
        accountCatalog: true,
        copilotCatalog: copilot,
        modelsUrl,
        headers,
      };
      if (codex || strategy === 'chatgpt-api') {
        target.inheritWireFamily = true;
        target.metadataCatalogId = CHATGPT_ACCOUNT_METADATA_CATALOG;
      }
      if (strategy && Object.hasOwn(SUBSCRIPTION_ENDPOINTS, strategy)) {
        let source = { ...active };
        const isCurrent = () =>
          matchesActiveProviderCredential(cfg, {
            label: source.label,
            accessToken: source.apiKey,
            refreshToken: source.refreshToken,
          });
        target.isCurrent = isCurrent;
        target.prepareApiKey = async (fetchImpl) => {
          const provider = new SubscriptionOAuthProvider({
            id,
            credential: source,
            baseUrl,
            fetchImpl,
          });
          const renewed = await provider.refreshAccountCredential({
            signal: AbortSignal.timeout(8_000),
          });
          if (!isCurrent()) throw new Error('Selected OAuth account changed during discovery.');
          cfg.apiKeys = cfg.apiKeys?.map((key) => (key.label === source.label ? renewed : key));
          source = renewed;
          target.apiKey = renewed.apiKey;
          const identity = createHash('sha256')
            .update(renewed.refreshToken ?? renewed.apiKey)
            .digest('hex');
          target.cacheKey = `${id}\u0000${baseUrl}\u0000${identity}`;
          return renewed.apiKey;
        };
      }
      out.push(target);
      continue;
    }
    const preset = presets[id] ?? (cfg.type ? presets[cfg.type] : undefined);
    const enabled = cfg.autoDiscoverModels ?? preset?.autoDiscover ?? false;
    if (!enabled) continue;
    const baseUrl = cfg.baseUrl ?? preset?.defaultBaseUrl;
    if (!baseUrl) continue;
    const modelDiscoveryPath = cfg.modelDiscoveryPath ?? preset?.modelDiscoveryPath;
    const modelDiscoveryAuthoritative =
      cfg.modelDiscoveryAuthoritative ?? preset?.modelDiscoveryAuthoritative;
    out.push({
      id,
      cfg,
      baseUrl,
      apiKey: resolveActiveKey(cfg),
      cacheKey: `${id}\u0000${baseUrl}${modelDiscoveryPath ? `\u0000${modelDiscoveryPath}` : ''}`,
      ...(modelDiscoveryPath ? { modelDiscoveryPath } : {}),
      ...(modelDiscoveryAuthoritative !== undefined ? { modelDiscoveryAuthoritative } : {}),
    });
  }
  return out;
}

export interface DiscoverOptions {
  /** Server base URL, e.g. `http://localhost:20128/v1`. */
  baseUrl: string;
  /** Bearer token. Some local servers accept any value; pass what you have. */
  apiKey?: string | undefined;
  /** Extra headers merged into the request. */
  headers?: Record<string, string> | undefined;
  /** Display name for the resulting provider (defaults to the id). */
  providerName?: string | undefined;
  /** Provider-specific model-list path below baseUrl. Defaults to `models`. */
  modelDiscoveryPath?: string | undefined;
  /** Abort the fetch after this many ms (default 8000). 0 disables. */
  timeoutMs?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
  accountCatalog?: boolean | undefined;
  copilotCatalog?: boolean | undefined;
  modelsUrl?: string | undefined;
  /** See {@link DiscoveryTarget.inheritWireFamily}. */
  inheritWireFamily?: boolean | undefined;
  prepareApiKey?: DiscoveryTarget['prepareApiKey'];
  /** Safe diagnostic categories only; response bodies and credentials are never reported. */
  onFailure?: ((reason: string) => void) | undefined;
}

/**
 * Fetch and map a `/v1/models` listing into a `ModelsDevProvider`. Resolves to
 * `undefined` (never throws) on any network/parse/shape failure or an empty
 * list, so callers can treat discovery as best-effort and fall back to a cache.
 */
export async function discoverOpenAICompatibleModels(
  providerId: string,
  opts: DiscoverOptions,
): Promise<ModelsDevProvider | undefined> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let apiKey = opts.apiKey;
  if (opts.prepareApiKey) {
    try {
      apiKey = await opts.prepareApiKey(fetchImpl);
    } catch (error) {
      const providerError = error instanceof ProviderError ? error : undefined;
      const status = providerError?.status;
      // `oauthFailure` validates body.error against the same regex; mirror it
      // so the gate stays in sync with whatever the producer considered an
      // OAuth error code. Non-OAuth throws fall through to the original wording.
      const codeRaw =
        providerError?.body && typeof providerError.body === 'object'
          ? (providerError.body as { code?: unknown }).code
          : undefined;
      const code =
        typeof codeRaw === 'string' && /^[a-z0-9_.-]{1,100}$/i.test(codeRaw) ? codeRaw : undefined;
      const detail =
        code && status ? ` (${code}, HTTP ${status})` : status ? ` (HTTP ${status})` : '';
      opts.onFailure?.(`OAuth credential renewal failed${detail}; check account sign-in`);
      return undefined;
    }
  }
  const base = opts.baseUrl.replace(/\/+$/, '');
  if (opts.copilotCatalog) {
    const live = opts.apiKey
      ? await fetchCopilotModels(opts.apiKey, undefined, fetchImpl)
      : undefined;
    if (live === undefined) {
      opts.onFailure?.('account model catalog request failed');
      return undefined;
    }
    return {
      id: providerId,
      name: opts.providerName ?? providerId,
      npm: '@ai-sdk/openai-compatible',
      api: base,
      env: [],
      models: Object.fromEntries(
        live.map((model) => [
          model.id,
          {
            id: model.id,
            name: model.name,
            tool_call: true,
            ...(model.maxContext ? { limit: { context: model.maxContext } } : {}),
          },
        ]),
      ),
    };
  }
  const modelPath = (opts.modelDiscoveryPath ?? 'models').replace(/^\/+/, '');
  const url =
    opts.modelsUrl ?? (/\/v\d+$/i.test(base) ? `${base}/${modelPath}` : `${base}/v1/${modelPath}`);
  const timeoutMs = opts.timeoutMs ?? 8000;
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  try {
    // Via `redirectSafeFetch`, not bare `fetch` (WS-084). This request carries
    // `authorization` plus any configured custom headers, and the default
    // `redirect: 'follow'` would replay them to whatever host a 302 named — so
    // a gateway that redirects hands the caller's API key to the redirect
    // target. `wire-adapter.ts` and `openai-codex.ts` already route through
    // this helper; discovery never adopted it.
    const res = await redirectSafeFetch(fetchImpl, url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...opts.headers,
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      opts.onFailure?.(
        `HTTP ${res.status}${res.status === 401 || res.status === 403 ? '; check account credentials and permissions' : ''}`,
      );
      return undefined;
    }
    const json = (await res.json()) as { data?: unknown; models?: unknown } | unknown;
    const list = Array.isArray(json)
      ? json
      : Array.isArray((json as { data?: unknown })?.data)
        ? (json as { data: unknown[] }).data
        : Array.isArray((json as { models?: unknown })?.models)
          ? (json as { models: unknown[] }).models
          : undefined;
    if (!list) {
      opts.onFailure?.('invalid model catalog response');
      return undefined;
    }
    const models: Record<string, ModelsDevModel> = {};
    for (const raw of list) {
      if (opts.accountCatalog && raw && typeof raw === 'object') {
        const visibility = (raw as CompatibleModelEntry).visibility;
        if (visibility !== undefined && visibility !== 'list') continue;
      }
      const entry = (raw ?? {}) as CompatibleModelEntry;
      // Kimi's account catalog uses "model" as an entity tag, not a task
      // class. Preserve actual modality filtering rather than hiding every ID.
      const mapped = mapCompatibleModel(
        opts.accountCatalog && entry.type === 'model' ? { ...entry, type: undefined } : entry,
      );
      if (mapped) models[mapped.id] = mapped;
    }
    if (Object.keys(models).length === 0 && !opts.accountCatalog) {
      opts.onFailure?.('model catalog contains no compatible models');
      return undefined;
    }
    return {
      id: providerId,
      name: opts.providerName ?? providerId,
      // Classifies to the openai-compatible wire family in the registry -
      // unless the target's own catalog entry already knows its family.
      ...(opts.inheritWireFamily ? {} : { npm: '@ai-sdk/openai-compatible' }),
      api: base,
      env: [],
      models,
    };
  } catch (error) {
    opts.onFailure?.(
      controller.signal.aborted
        ? 'model catalog request timed out'
        : error instanceof SyntaxError
          ? 'invalid JSON model catalog response'
          : 'model catalog network request failed',
    );
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

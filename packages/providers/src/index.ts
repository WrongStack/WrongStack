import { CODEX_MODELS } from '@wrongstack/core/models';
import type { ProviderFactory } from '@wrongstack/core/registry';
import type {
  Logger,
  ModelsRegistry,
  Provider,
  ProviderApiKey,
  ProviderConfig,
  ResolvedProvider,
  WireFamily,
} from '@wrongstack/core/types';
import { ConfigError, ERROR_CODES, WrongStackError } from '@wrongstack/core/types';
import { expectDefined } from '@wrongstack/core/utils';
import { AiGatewayProvider, createAiGatewayProviderFactory } from './ai-gateway.js';
import { AnthropicProvider } from './anthropic.js';
import { AnthropicOAuthProvider } from './anthropic-oauth.js';
import { CATALOG_ALIAS_BY_PROVIDER_TYPE, capabilitiesFor } from './capabilities.js';
import { createCatalogAwareProvider } from './catalog-provider-routing.js';
import { GitHubCopilotProvider } from './github-copilot.js';
import { GoogleProvider } from './google.js';
import { MiniMaxProvider } from './minimax.js';
import { OpenAIProvider } from './openai.js';
import { OpenAICodexProvider } from './openai-codex.js';
import {
  type CompatibilityQuirks,
  isCompatibilityQuirks,
  OpenAICompatibleProvider,
} from './openai-compatible.js';
import { OpenCodeZenProvider } from './opencode.js';
import { OpenCodeGoProvider } from './opencode-go.js';
import { lmstudioWireFormat, ollamaWireFormat, vllmWireFormat } from './presets/local-llm.js';
import { mistralWireFormat } from './presets/mistral.js';
import { projectCompatibleProviderPresets } from './provider-definitions.js';
import { createWireFormatFactory } from './wire-format.js';

export {
  type AiGatewayFactoryOptions,
  AiGatewayProvider,
  type AiGatewayProviderOptions,
  convertAiSdkStreamPart,
  convertMessages as convertMessagesToAiSdk,
  convertTools as convertToolsToAiSdk,
  convertUsage as convertAiSdkUsage,
  createAiGatewayProviderFactory,
  toProviderError as convertAiSdkProviderError,
} from './ai-gateway.js';
export { AnthropicProvider, type AnthropicProviderOptions } from './anthropic.js';
export {
  type AnthropicOAuthCredentials,
  AnthropicOAuthProvider,
  type AnthropicOAuthProviderOptions,
  type AnthropicOAuthTokens,
  CLAUDE_CODE_SYSTEM_PROMPT,
  refreshAnthropicOAuthToken,
} from './anthropic-oauth.js';
export {
  type DiscoverOptions,
  type DiscoveryTarget,
  discoverOpenAICompatibleModels,
  mapCompatibleModel,
  resolveDiscoveryTargets,
} from './auto-discover.js';
export { ANTHROPIC_MAX_BREAKPOINTS, capAnthropicCacheBreakpoints } from './cache-breakpoint-cap.js';
export {
  CATALOG_ALIAS_BY_PROVIDER_TYPE,
  capabilitiesFor,
  catalogProviderIdFor,
} from './capabilities.js';
export {
  CatalogRoutedProvider,
  type CatalogRoutedProviderOptions,
  type CatalogWireNpm,
  isCatalogWireNpm,
} from './catalog-routed.js';
export {
  type CodexResponsesParser,
  type CodexWebSocketFactory,
  CodexWebSocketFallbackError,
  type CodexWebSocketLike,
  type CodexWebSocketOptions,
  CodexWebSocketPool,
  type CodexWebSocketStreamOptions,
  defaultCodexWebSocketFactory,
} from './codex-websocket.js';
export { parseProviderHttpError } from './error-parse.js';
export { CAPABILITIES_BY_FAMILY, capabilitiesForFamily } from './family-capabilities.js';
export {
  type CopilotCredentials,
  type CopilotTokenResult,
  copilotBaseUrlFromToken,
  GitHubCopilotProvider,
  type GitHubCopilotProviderOptions,
  refreshCopilotToken,
} from './github-copilot.js';
export { GoogleProvider, type GoogleProviderOptions } from './google.js';
export { MiniMaxProvider, type MiniMaxProviderOptions } from './minimax.js';
export {
  type BuildBodyContext,
  clearModelOutputLimitResolver,
  type InstallCatalogOutputLimitsOptions,
  installCatalogModelOutputLimits,
  type ModelOutputLimitResolver,
  REQUIRED_FIELD_LAST_RESORT_MAX_OUTPUT,
  resolveCatalogMaxOutput,
  resolveMaxOutputTokens,
  resolveRequiredMaxOutputTokens,
  setModelOutputLimitResolver,
} from './model-output-limits.js';
export {
  createNativeCatalogProvider,
  isNativeCatalogNpm,
  type NativeCatalogNpm,
  type NativeCatalogProviderOptions,
} from './native-catalog.js';
export { OpenAIProvider, type OpenAIProviderOptions } from './openai.js';
export {
  type CodexCredentials,
  type CodexOAuthTokens,
  type CodexResponseMetadata,
  codexOutputCap,
  extractAccountId,
  OpenAICodexProvider,
  type OpenAICodexProviderOptions,
  refreshCodexAccessToken,
  resolveCodexModelsUrl,
  resolveCodexUrl,
  resolveCodexWebSocketUrl,
} from './openai-codex.js';
export { extractPlanType } from './openai-codex-account.js';
export {
  CODEX_QUOTA_PROVIDER_ID,
  parseCodexRateLimitEvent,
  parseCodexRateLimitForLimit,
  parseCodexRateLimitHeaders,
} from './openai-codex-rate-limits.js';
export {
  type CompatibilityQuirks,
  type OpenAICompatibleOptions,
  OpenAICompatibleProvider,
} from './openai-compatible.js';
export { OpenCodeGoProvider, type OpenCodeGoProviderOptions } from './opencode-go.js';
export { anthropicWireFormat } from './presets/anthropic.js';
export { googleWireFormat } from './presets/google.js';
export { lmstudioWireFormat, ollamaWireFormat, vllmWireFormat } from './presets/local-llm.js';
export { mistralWireFormat } from './presets/mistral.js';
export { openaiWireFormat } from './presets/openai.js';
// The probe's two pure functions are exported so a caller outside this package
// can answer "did the prefix survive this turn" against captured wire bodies —
// the recorder itself stays opt-in and internal.
export {
  type CacheProbeDiff,
  type CacheProbeFingerprint,
  diffCacheProbe,
  fingerprintCacheProbe,
  isCacheProbeEnabled,
  resetCacheProbeState,
} from './prompt-cache-probe.js';
export {
  type CompatibleProviderProjection,
  LOCAL_PROVIDER_DEFINITIONS,
  type LocalProviderPresetProjection,
  type OpenAICompatiblePolicyId,
  type PopularProviderProjection,
  PROVIDER_DEFINITIONS,
  type ProviderCatalogMetadata,
  type ProviderDefinition,
  type ProviderReferral,
  type ProviderUsage,
  projectCompatibleProviderPresets,
  projectLocalProviderPresets,
  projectPopularProviderCatalog,
  resolveProviderDefinition,
} from './provider-definitions.js';
export {
  createSetupProviderFactory,
  isSetupProvider,
  SETUP_MODEL_ID,
  SETUP_PROVIDER_ID,
  SETUP_PROVIDER_NAME,
  setupProviderResolved,
} from './setup-provider.js';
export { normalizeAnthropic, normalizeOpenAI } from './stop-reason.js';
export {
  type DebugStreamCallback,
  type DebugStreamStats,
  defaultDebugStreamCallback,
  isDebugStreamEnabled,
  pushDebugChunkStats,
  setDebugStreamCallback,
  setDebugStreamEnabled,
} from './stream-debug-state.js';
export { contentFromAnthropic } from './tool-format/from-anthropic.js';
export { contentFromOpenAI, type OpenAIChoice } from './tool-format/from-openai.js';
export { toolsToAnthropic } from './tool-format/to-anthropic.js';
export {
  type ConvertOptions,
  messagesToOpenAI,
  type OpenAIMessage,
  type OpenAIToolCall,
  toolsToOpenAI,
} from './tool-format/to-openai.js';
export {
  buildProviderConfigFromPreset,
  getTrustedProviderPreset,
  isTrustedProviderId,
  listTrustedProviderPresetIds,
  rehydrateCanonicalProviderConfig,
  resolvePresetForAlias,
  TRUSTED_PROVIDER_PRESETS,
  type TrustedProviderPreset,
} from './trusted-presets.js';
export { WireAdapter, type WireAdapterStreamOptions } from './wire-adapter.js';
export {
  createWireFormatFactory,
  defineWireFormat,
  type WireFactoryOptions,
  type WireFormatConfig,
  WireFormatProvider,
} from './wire-format.js';

/**
 * Built-in tuning for known openai-compatible providers that aren't in the
 * models.dev catalog. Lets a named provider (e.g. omniroute) come with the
 * right base URL, wire quirks, and model auto-discovery without the user
 * having to hand-configure any of it.
 */
export interface CompatiblePreset {
  /** Default base URL when the config omits one. */
  defaultBaseUrl?: string | undefined;
  /** Wire quirks merged UNDER any user-supplied quirks. */
  quirks?: CompatibilityQuirks | undefined;
  /** Fetch `{baseUrl}/models` at boot and inject the result into the catalog. */
  autoDiscover?: boolean | undefined;
  /** Provider-specific model-list path below baseUrl. Defaults to `models`. */
  modelDiscoveryPath?: string | undefined;
  /** Discovery result is the account-scoped visible-model allowlist. */
  modelDiscoveryAuthoritative?: boolean | undefined;
}

export const COMPATIBLE_PRESETS: Record<string, CompatiblePreset> =
  projectCompatibleProviderPresets();

export interface BuildFactoriesOptions {
  registry: ModelsRegistry;
  /** Used to log unsupported families during boot. */
  log?: Logger | undefined;
}

/** Rotated-token payload handed to the OAuth persister after a refresh. */
export interface OAuthRefreshedTokens {
  accessToken: string;
  /** Refresh token — not present for all OAuth families (e.g. GitHub Copilot). Callers who need it already hold it. */
  refreshToken?: string | undefined;
  expiresAt: number;
  /** ChatGPT account id (codex only); undefined for other OAuth families. */
  accountId?: string | undefined;
}

/**
 * Module-level hook so refreshed OAuth tokens (openai-codex, anthropic-oauth, …)
 * can be persisted back to the encrypted config WITHOUT threading a
 * vault/configPath through every provider-construction site. The CLI installs
 * this once at boot. When unset (tests, headless tools), refresh still works
 * in-memory for the session — only cross-session persistence is skipped.
 */
let _oauthPersist: ((providerId: string, creds: OAuthRefreshedTokens) => void) | undefined;

export function setOAuthTokenPersister(
  fn: ((providerId: string, creds: OAuthRefreshedTokens) => void) | undefined,
): void {
  _oauthPersist = fn;
}

/**
 * Persist a provider's live model list, the same way {@link _oauthPersist}
 * persists rotated tokens.
 *
 * A subscription provider's model list is account state, not a WrongStack
 * release artifact: it changes when a model rolls out to the account. It used
 * to be captured once at login and never revisited, so a stored list went
 * stale silently. The host installs this at boot; unset (tests, headless
 * tools) simply means the refreshed list is used for the session only.
 */
let _modelsPersist: ((providerId: string, models: ProviderLiveModel[]) => void) | undefined;

/** One picker-visible model as a provider's live catalog describes it. */
export interface ProviderLiveModel {
  id: string;
  name: string;
  description?: string | undefined;
  maxContext?: number | undefined;
}

export function setProviderModelPersister(
  fn: ((providerId: string, models: ProviderLiveModel[]) => void) | undefined,
): void {
  _modelsPersist = fn;
}

/**
 * Known openai-compatible provider ids with tuned wire-format presets.
 *
 * Presets are exported directly for manual use:
 *   ```
 *   import { mistralWireFormat } from '@wrongstack/providers';
 *   const factory = createWireFormatFactory(mistralWireFormat);
 *   ```
 */

/**
 * Build one ProviderFactory per provider known to models.dev. The factory's
 * `create(cfg)` resolves the wire-family at construction time and returns the
 * matching transport. Unsupported families return a stub that throws when
 * complete() is called, so the system can still boot.
 */
/**
 * Wrap a provider so the catalog-resolved `Capabilities` overlay is
 * applied after construction. The factory itself was created with the
 * family default; `capabilitiesFor(registry, ...)` layers per-model
 * facts on top — `ModelsDevModel.limit.output` for `maxOutput`, which
 * drives Chimera's `Request.maxTokens`.
 *
 * Failures inside the resolution step are swallowed: the family default
 * stands, and the per-request `resolveMaxOutputTokens` lookup still reaches
 * the catalog for `req.model`. The diagnostic lives at DEBUG so a healthy
 * boot stays quiet.
 */
export async function withCatalogCapabilities(
  registry: ModelsRegistry,
  providerId: string,
  provider: Provider,
  cfg: ProviderConfig,
  log?: Logger,
): Promise<Provider> {
  try {
    // Gateway transports are absent from models.dev under their own id; their
    // per-model facts live under the upstream provider named in the model id.
    // Detect from the instance, not from config, so user-chosen aliases
    // ("gateway-work") resolve the same way as the canonical id.
    const isGateway = provider instanceof AiGatewayProvider;
    const resolved = await capabilitiesFor(
      registry,
      providerId,
      cfg.model ?? '',
      cfg.customModels,
      {
        // No wire family describes a gateway, so read its facts from the
        // catalog id that does publish them and overlay onto what the transport
        // declared about itself rather than a family default.
        ...(isGateway
          ? {
              catalogProviderId: CATALOG_ALIAS_BY_PROVIDER_TYPE['ai-gateway'],
              baseCapabilities: provider.capabilities,
            }
          : {}),
      },
    );
    // `Provider.capabilities` is `readonly`; the property descriptor was
    // set with `writable: false` at construction time. Redefine it so
    // the catalog overlay lands cleanly.
    //
    // Assign a COPY: `capabilitiesFor` memoises one object per
    // (provider, model, customModels) key, and callers such as the fleet host
    // provider refine fields in place (`capabilities.maxContext = …`). Handing
    // out the cached instance would let one provider's refinement leak into
    // every other provider resolved from the same key.
    Object.defineProperty(provider, 'capabilities', {
      value: { ...resolved },
      writable: true,
      configurable: true,
      enumerable: true,
    });
  } catch (err) {
    log?.debug(
      `Provider capability overlay skipped for ${providerId}/${cfg.model ?? ''}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return provider;
}

export async function buildProviderFactoriesFromRegistry(
  opts: BuildFactoriesOptions,
): Promise<ProviderFactory[]> {
  const providers = await opts.registry.listProviders();
  const factories: ProviderFactory[] = [];
  const unsupported: ResolvedProvider[] = [];

  for (const p of providers) {
    if (p.family === 'unsupported') {
      unsupported.push(p);
      continue;
    }
    factories.push({
      type: p.id,
      family: p.family,
      create: (cfg: ProviderConfig) => makeProvider(p, cfg),
    });
  }

  // AI SDK 7 transport for Vercel AI Gateway model ids (`provider/model`).
  factories.push(createAiGatewayProviderFactory());

  // Generic factories so users can hand-roll a provider not in models.dev.
  factories.push({
    type: 'openai-compatible',
    family: 'openai-compatible',
    create: (cfg) => {
      const baseUrl = cfg.baseUrl;
      if (!baseUrl?.trim()) {
        throw new ConfigError({
          message:
            'OpenAI-compatible provider requires a base URL. Specify the endpoint (e.g. "https://api.example.com/v1").',
          code: 'CONFIG_INVALID',
        });
      }
      return new OpenAICompatibleProvider({
        id: 'openai-compatible',
        apiKey: requireKey(cfg),
        baseUrl,
        headers: cfg.headers,
        quirks: validateQuirks('openai-compatible', cfg.quirks),
      });
    },
  });

  if (unsupported.length > 0 && opts.log) {
    // Debug-only: the user already knows their plan; only surface when
    // troubleshooting why a specific provider isn't selectable.
    opts.log.info(
      `${unsupported.length} provider(s) need a plugin (unsupported wire family): ` +
        unsupported.map((p) => p.id).join(', '),
    );
  }

  return factories;
}

/**
 * Resolve the active API key from a ProviderConfig. Prefers `apiKeys[]`
 * (using `activeKey` to select), falls back to the legacy `apiKey` field.
 * This avoids reading `cfg.apiKey` directly, which may be absent after
 * `writeKeysBack` clears it to prevent serialization leaks.
 */
function resolveActiveKey(cfg: ProviderConfig): string | undefined {
  if (Array.isArray(cfg.apiKeys) && cfg.apiKeys.length > 0) {
    const active = cfg.activeKey ? cfg.apiKeys.find((k) => k.label === cfg.activeKey) : undefined;
    const key = (active ?? cfg.apiKeys[0])?.apiKey;
    return key?.trim() ? key : undefined;
  }
  return cfg.apiKey?.trim() ? cfg.apiKey : undefined;
}

/** Resolve the full active key ENTRY (not just the string) — needed by OAuth
 *  families that carry refresh tokens / expiry / account id alongside the key. */
function resolveActiveKeyEntry(cfg: ProviderConfig): ProviderApiKey | undefined {
  if (Array.isArray(cfg.apiKeys) && cfg.apiKeys.length > 0) {
    const active = cfg.activeKey ? cfg.apiKeys.find((k) => k.label === cfg.activeKey) : undefined;
    return active ?? cfg.apiKeys[0];
  }
  return undefined;
}

function makeProvider(p: ResolvedProvider, cfg: ProviderConfig): Provider {
  // Config overrides the catalog. This is the path that lets users wire
  // up internal proxies / self-hosted endpoints without needing models.dev.
  const family: WireFamily = cfg.family ?? p.family;
  // VULN-006 sentinel: a present-but-empty `envVars` array is written by
  // provider_manage's endpointChanged — "endpoint changed; do NOT silently
  // re-arm the credential from the catalog preset". Only an absent/undefined
  // envVars falls back to the preset.
  const envVars = Array.isArray(cfg.envVars) ? cfg.envVars : p.envVars;
  const explicitApiKey = resolveActiveKey(cfg);
  const catalogAware = createCatalogAwareProvider({
    provider: p,
    config: cfg,
    explicitApiKey,
    quirks: validateQuirks(p.id, cfg.quirks),
  });
  if (catalogAware) return catalogAware;
  const apiKey = explicitApiKey ?? readFromEnv(envVars);
  if (!apiKey && family !== 'unsupported') {
    throw new ConfigError({
      message: `Provider "${p.id}" requires an API key. Set ${
        envVars.join(' or ') || 'apiKey in config'
      } or run \`wstack auth ${p.id}\`.`,
      code: 'CONFIG_INVALID',
    });
  }
  const baseUrl = cfg.baseUrl ?? p.apiBase;

  if (!family || family === 'unsupported') {
    if (family === 'unsupported') {
      throw new ConfigError({
        message:
          `Provider "${p.id}" uses an unsupported wire family (${p.npm ?? 'unknown'}). ` +
          `Register a custom factory via a plugin to enable it.`,
        code: 'CONFIG_INVALID',
      });
    }
    throw new ConfigError({
      message:
        `Provider "${p.id}" has no wire family configured. ` +
        `Set an explicit family ("anthropic" | "openai" | "openai-compatible" | "google") in config or the models.dev catalog.`,
      code: 'CONFIG_INVALID',
    });
  }

  switch (family) {
    case 'anthropic':
      // Pass `id` so a config-side alias (e.g. `minimax-token-plan` with
      // `family: 'anthropic'`) keeps its user-visible id instead of being
      // collapsed to the wire-family canonical id. Without this the status
      // bar / pickers / fallback chain all see `id === 'anthropic'` and the
      // configured alias is silently lost — which is exactly the drift that
      // used to happen on `/model` switch and session resume.
      return new AnthropicProvider({
        apiKey: expectDefined(apiKey),
        baseUrl,
        id: p.id,
        maxTools: validateQuirks(p.id, cfg.quirks)?.maxTools,
      });
    case 'openai':
      return new OpenAIProvider({
        apiKey: expectDefined(apiKey),
        baseUrl,
        id: p.id,
        quirks: validateQuirks(p.id, cfg.quirks),
      });
    case 'openai-compatible': {
      // Provider/model discovery remains owned by models.dev. This adapter
      // only selects the gateway's per-model wire protocol.
      if (p.id === 'opencode') {
        return new OpenCodeZenProvider({
          id: p.id,
          apiKey: expectDefined(apiKey),
          baseUrl: expectDefined(baseUrl),
          headers: cfg.headers,
          models: p.models,
        });
      }
      if (p.id === 'opencode-go') {
        return new OpenCodeGoProvider({
          id: p.id,
          apiKey: expectDefined(apiKey),
          baseUrl,
          headers: cfg.headers,
          models: p.models,
        });
      }
      // MiniMax routes M-series models to its Anthropic-compatible surface
      // (interleaved thinking/tool blocks, prompt-cache usage) and keeps the
      // OpenAI fallback for everything else. Without this special-case the
      // trusted preset fell through to the generic OpenAICompatibleProvider,
      // so the routing existed only under unit tests.
      if (p.id === 'minimax' || p.id === 'minimax-coding-plan') {
        return new MiniMaxProvider({
          id: p.id,
          apiKey: expectDefined(apiKey),
          baseUrl,
          headers: cfg.headers,
        });
      }
      // Use a tuned preset when available (Mistral, Ollama, vLLM, LM Studio, …).
      if (p.id === 'mistral') {
        return createWireFormatFactory(mistralWireFormat, {
          apiKey: expectDefined(apiKey),
          baseUrl: baseUrl ?? mistralWireFormat.defaultBaseUrl,
        }).create(cfg);
      }
      if (p.id === 'ollama') {
        return createWireFormatFactory(ollamaWireFormat, {
          apiKey: expectDefined(apiKey),
          baseUrl: baseUrl ?? ollamaWireFormat.defaultBaseUrl,
        }).create(cfg);
      }
      if (p.id === 'vllm') {
        return createWireFormatFactory(vllmWireFormat, {
          apiKey: expectDefined(apiKey),
          baseUrl: baseUrl ?? vllmWireFormat.defaultBaseUrl,
        }).create(cfg);
      }
      if (p.id === 'lmstudio') {
        return createWireFormatFactory(lmstudioWireFormat, {
          apiKey: expectDefined(apiKey),
          baseUrl: baseUrl ?? lmstudioWireFormat.defaultBaseUrl,
        }).create(cfg);
      }
      const preset = COMPATIBLE_PRESETS[p.id];
      const resolvedBaseUrl = baseUrl ?? preset?.defaultBaseUrl;
      if (!resolvedBaseUrl?.trim()) {
        throw new ConfigError({
          message:
            `Provider "${p.id}" (openai-compatible) requires a base URL. ` +
            'Set it in config or register a preset with a defaultBaseUrl.',
          code: 'CONFIG_INVALID',
        });
      }
      return new OpenAICompatibleProvider({
        id: p.id,
        apiKey: expectDefined(apiKey),
        baseUrl: resolvedBaseUrl,
        headers: cfg.headers,
        // Preset quirks are the floor; explicit user quirks win on conflict.
        quirks: { ...preset?.quirks, ...validateQuirks(p.id, cfg.quirks) },
      });
    }
    case 'openai-codex': {
      const entry = resolveActiveKeyEntry(cfg);
      const parsedExpiry = entry?.expiresAt ? Date.parse(entry.expiresAt) : Number.NaN;
      return new OpenAICodexProvider({
        id: p.id,
        baseUrl,
        credentials: {
          accessToken: expectDefined(apiKey),
          refreshToken: entry?.refreshToken,
          expiresAt: Number.isFinite(parsedExpiry) ? parsedExpiry : undefined,
          accountId: entry?.accountId,
        },
        onRefresh: (creds) => _oauthPersist?.(p.id, creds),
        // The list the ChatGPT backend reports for THIS account, refreshed on
        // the catalog probe the transport already makes.
        onModels: (models) => _modelsPersist?.(p.id, models),
      });
    }
    case 'anthropic-oauth': {
      const entry = resolveActiveKeyEntry(cfg);
      const parsedExpiry = entry?.expiresAt ? Date.parse(entry.expiresAt) : Number.NaN;
      return new AnthropicOAuthProvider({
        id: p.id,
        baseUrl,
        credentials: {
          accessToken: expectDefined(apiKey),
          refreshToken: entry?.refreshToken,
          expiresAt: Number.isFinite(parsedExpiry) ? parsedExpiry : undefined,
        },
        onRefresh: (creds) => _oauthPersist?.(p.id, creds),
      });
    }
    case 'github-copilot': {
      const entry = resolveActiveKeyEntry(cfg);
      const parsedExpiry = entry?.expiresAt ? Date.parse(entry.expiresAt) : Number.NaN;
      return new GitHubCopilotProvider({
        id: p.id,
        credentials: {
          copilotToken: resolveActiveKey(cfg) ?? '',
          githubToken: entry?.refreshToken,
          expiresAt: Number.isFinite(parsedExpiry) ? parsedExpiry : undefined,
        },
        onRefresh: (creds) => _oauthPersist?.(p.id, creds),
      });
    }
    case 'google':
      return new GoogleProvider({
        id: p.id,
        apiKey: expectDefined(apiKey),
        baseUrl,
        maxTools: validateQuirks(p.id, cfg.quirks)?.maxTools,
      });
    default:
      throw new ConfigError({
        message: `Unknown provider family: ${String(family)}`,
        code: 'CONFIG_INVALID',
      });
  }
}

/**
 * Build a Provider purely from config — no models.dev lookup at all.
 * Used for user-defined providers and offline operation.
 */
export function makeProviderFromConfig(id: string, cfg: ProviderConfig): Provider {
  if (cfg.type === 'ai-gateway' || id === 'ai-gateway') {
    return createAiGatewayProviderFactory().create({ ...cfg, type: id });
  }
  if (!cfg.family) {
    throw new ConfigError({
      message: `Provider "${id}" needs an explicit family ("anthropic" | "openai" | "openai-compatible" | "google") when not in the models.dev catalog.`,
      code: 'CONFIG_INVALID',
    });
  }
  const synthetic: ResolvedProvider = {
    id,
    name: id,
    family: cfg.family,
    apiBase: cfg.baseUrl,
    envVars: cfg.envVars ?? [],
    models: seedConfigModels(cfg),
    npm: undefined,
  };
  return makeProvider(synthetic, cfg);
}

/**
 * Resolve the model list for a config-only Provider. The saved `cfg.models`
 * allowlist wins when non-empty, but an empty/absent allowlist must NOT yield
 * an empty picker for OAuth / subscription families whose canonical model list
 * is known offline — otherwise deleting the models from config (or a fresh
 * login that hasn't persisted an allowlist yet) leaves the provider showing
 * zero models. For `openai-codex` (ChatGPT sign-in) we fall back to the
 * canonical `CODEX_MODELS` catalog so the provider is always populated.
 */
function seedConfigModels(cfg: ProviderConfig): Array<{ id: string; name: string }> {
  const saved = cfg.models ?? [];
  if (saved.length > 0) return saved.map((m) => ({ id: m, name: m }));
  if (cfg.family === 'openai-codex' || cfg.type === 'openai-codex') {
    return CODEX_MODELS.map((m) => ({ id: m.id, name: m.name }));
  }
  return [];
}

function readFromEnv(vars: string[]): string | undefined {
  for (const v of vars) {
    const val = process.env[v];
    if (val?.trim()) return val;
  }
  return undefined;
}

function requireKey(cfg: ProviderConfig): string {
  const key = resolveActiveKey(cfg);
  if (key) return key;
  throw new ConfigError({
    message: 'Provider config requires apiKey (or set the corresponding env var).',
    code: 'CONFIG_INVALID',
  });
}

function validateQuirks(providerId: string, quirks: unknown): CompatibilityQuirks | undefined {
  if (quirks === undefined) return undefined;
  if (isCompatibilityQuirks(quirks)) return quirks;
  throw new WrongStackError({
    message: `Invalid quirks for provider "${providerId}". Expected CompatibilityQuirks.`,
    code: ERROR_CODES.CONFIG_INVALID,
    subsystem: 'provider',
  });
}

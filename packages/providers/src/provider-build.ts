import type {
  Provider,
  ProviderApiKey,
  ProviderConfig,
  ResolvedProvider,
  WireFamily,
} from '@wrongstack/contracts/types';
import { ConfigError, ERROR_CODES, WrongStackError } from '@wrongstack/contracts/types';
import { isKeylessLocalProvider } from '@wrongstack/core/models';
import { expectDefined } from '@wrongstack/core/utils';
import { AnthropicProvider } from './anthropic.js';
import { RetiredAnthropicOAuthProvider } from './anthropic-oauth.js';
import { createCatalogAwareProvider } from './catalog-provider-routing.js';
import { GitHubCopilotProvider } from './github-copilot.js';
import { GoogleProvider } from './google.js';
import { AntigravityProvider } from './google-antigravity.js';
import { isMiniMaxHost, isMiniMaxProviderId, MiniMaxProvider } from './minimax.js';
import { OpenAIProvider } from './openai.js';
import { OpenAICodexProvider } from './openai-codex.js';
import {
  type CompatibilityQuirks,
  isCompatibilityQuirks,
  OpenAICompatibleProvider,
} from './openai-compatible.js';
import { OpenAIResponsesProvider } from './openai-responses.js';
import { OpenCodeZenProvider } from './opencode.js';
import { OpenCodeGoProvider } from './opencode-go.js';
import { lmstudioWireFormat, ollamaWireFormat, vllmWireFormat } from './presets/local-llm.js';
import { mistralWireFormat } from './presets/mistral.js';
import type { OAuthRefreshedTokens, ProviderLiveModel } from './provider-account-types.js';
import {
  projectCompatibleProviderPresets,
  resolveProviderDefinition,
} from './provider-definitions.js';
import { SUBSCRIPTION_ENDPOINTS, SubscriptionOAuthProvider } from './subscription-oauth.js';
import { createWireFormatFactory } from './wire-format.js';
import { isZaiHost, withZaiAccountPlane, ZaiMessagesProvider, zaiWireContract } from './zai.js';

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

/**
 * Module-level hook so refreshed OAuth tokens (openai-codex, anthropic-oauth, …)
 * can be persisted back to the encrypted config WITHOUT threading a
 * vault/configPath through every provider-construction site. The CLI installs
 * this once at boot. When unset (tests, headless tools), refresh still works
 * in-memory for the session — only cross-session persistence is skipped.
 */
export interface ProviderCredentialSource {
  label?: string | undefined;
  accessToken: string;
  refreshToken?: string | undefined;
}

export let _oauthPersist:
  | ((providerId: string, creds: OAuthRefreshedTokens, source?: ProviderCredentialSource) => void)
  | undefined;

export function setOAuthTokenPersister(
  fn:
    | ((providerId: string, creds: OAuthRefreshedTokens, source?: ProviderCredentialSource) => void)
    | undefined,
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
export let _modelsPersist:
  | ((providerId: string, models: ProviderLiveModel[], source?: ProviderCredentialSource) => void)
  | undefined;

export function setProviderModelPersister(
  fn:
    | ((providerId: string, models: ProviderLiveModel[], source?: ProviderCredentialSource) => void)
    | undefined,
): void {
  _modelsPersist = fn;
}

/**
 * The Google OAuth client an Antigravity provider should refresh with.
 *
 * Config first, environment second. Returns a spreadable fragment so the
 * caller stays a single expression and the provider option is simply absent
 * when neither source has one — at which point the provider runs on its live
 * access token and fails with a setup message rather than an opaque 401.
 */
export function resolveAntigravityClient(
  cfg: ProviderConfig,
): { oauthClient: { clientId: string; clientSecret?: string | undefined } } | undefined {
  const clientId =
    cfg.oauthClientId?.trim() || process.env['WRONGSTACK_ANTIGRAVITY_CLIENT_ID']?.trim();
  if (!clientId) return undefined;
  const clientSecret =
    cfg.oauthClientSecret?.trim() || process.env['WRONGSTACK_ANTIGRAVITY_CLIENT_SECRET']?.trim();
  return { oauthClient: { clientId, ...(clientSecret ? { clientSecret } : {}) } };
}

export function oauthPersistenceCallbacks(
  providerId: string,
  cfg: ProviderConfig,
  accessToken: string,
) {
  const entry = resolveActiveKeyEntry(cfg);
  let source: ProviderCredentialSource = {
    label: entry?.label ?? (cfg.apiKey ? 'default' : undefined),
    accessToken,
    refreshToken: entry?.refreshToken,
  };
  return {
    onRefresh: (creds: OAuthRefreshedTokens) => {
      _oauthPersist?.(providerId, creds, { ...source });
      source = {
        ...source,
        accessToken: creds.accessToken,
        refreshToken: creds.refreshToken ?? source.refreshToken,
      };
    },
    onModels: (models: ProviderLiveModel[]) => _modelsPersist?.(providerId, models, { ...source }),
  };
}

/**
 * Resolve the active API key from a ProviderConfig. Prefers `apiKeys[]`
 * (using `activeKey` to select), falls back to the legacy `apiKey` field.
 * This avoids reading `cfg.apiKey` directly, which may be absent after
 * `writeKeysBack` clears it to prevent serialization leaks.
 */
export function resolveActiveKey(cfg: ProviderConfig): string | undefined {
  if (Array.isArray(cfg.apiKeys) && cfg.apiKeys.length > 0) {
    const active = cfg.activeKey ? cfg.apiKeys.find((k) => k.label === cfg.activeKey) : undefined;
    const key = (active ?? cfg.apiKeys[0])?.apiKey;
    return key?.trim() ? key : undefined;
  }
  return cfg.apiKey?.trim() ? cfg.apiKey : undefined;
}

/** Resolve the full active key ENTRY (not just the string) — needed by OAuth
 *  families that carry refresh tokens / expiry / account id alongside the key. */
export function resolveActiveKeyEntry(cfg: ProviderConfig): ProviderApiKey | undefined {
  if (Array.isArray(cfg.apiKeys) && cfg.apiKeys.length > 0) {
    const active = cfg.activeKey ? cfg.apiKeys.find((k) => k.label === cfg.activeKey) : undefined;
    return active ?? cfg.apiKeys[0];
  }
  return undefined;
}

export function buildProvider(
  p: ResolvedProvider,
  cfg: ProviderConfig,
  factoryType: string = p.id,
  /**
   * The user-visible provider id — the config key. A registry factory gets it
   * as `cfg.type` (every host builds `{ ...cfg, type: providerId }`), and a
   * config-only provider's synthetic `id` already is it. It names the
   * provider; the catalog entry `p` and `factoryType` decide how it behaves.
   */
  instanceId: string = p.id,
): Provider {
  const id = instanceId;
  // Config overrides the catalog. This is the path that lets users wire
  // up internal proxies / self-hosted endpoints without needing models.dev.
  const family: WireFamily = cfg.family ?? p.family;
  // VULN-006 sentinel: a present-but-empty `envVars` array is written by
  // provider_manage's endpointChanged — "endpoint changed; do NOT silently
  // re-arm the credential from the catalog preset". Only an absent/undefined
  // envVars falls back to the preset.
  const envVars = Array.isArray(cfg.envVars) ? cfg.envVars : p.envVars;
  const explicitApiKey = resolveActiveKey(cfg);
  const account = resolveActiveKeyEntry(cfg);
  if (account?.oauthStrategyId && Object.hasOwn(SUBSCRIPTION_ENDPOINTS, account.oauthStrategyId)) {
    return new SubscriptionOAuthProvider({
      id,
      credential: account,
      baseUrl: cfg.baseUrl,
      headers: cfg.headers,
      ...oauthPersistenceCallbacks(id, cfg, account.apiKey),
      onModels: (models, credential) =>
        _modelsPersist?.(id, models, {
          label: credential.label,
          accessToken: credential.apiKey,
          refreshToken: credential.refreshToken,
        }),
    });
  }
  const catalogAware = createCatalogAwareProvider({
    provider: p,
    instanceId: id,
    definitionId: factoryType,
    config: cfg,
    explicitApiKey,
    quirks: validateQuirks(factoryType, cfg.quirks),
  });
  if (catalogAware) return catalogAware;
  // Local runtimes (Ollama, OmniRoute, vLLM, LM Studio) are saved WITHOUT a key
  // by `wstack auth local` — keyless or optional-auth by definition — yet this
  // guard rejected them, so a freshly configured local provider could never be
  // built. They get the same placeholder the local presets already send. So
  // does any server on a loopback address that declares no key env var: boot
  // and the picker already accept those as usable, and refusing here made the
  // saved default fail at startup.
  const keyOptional =
    resolveProviderDefinition(factoryType)?.local !== undefined ||
    isKeylessLocalProvider({ apiBase: cfg.baseUrl ?? p.apiBase, envVars });
  const apiKey = explicitApiKey ?? readFromEnv(envVars) ?? (keyOptional ? 'no-key' : undefined);
  if (!apiKey && family !== 'unsupported') {
    throw new ConfigError({
      message: `Provider "${id}" requires an API key. Set ${
        envVars.join(' or ') || 'apiKey in config'
      } or run \`wstack auth ${id}\`.`,
      code: 'CONFIG_INVALID',
    });
  }
  const baseUrl = cfg.baseUrl ?? p.apiBase;
  if (factoryType === 'meta' && apiKey) {
    return new OpenAIResponsesProvider({
      id,
      apiKey,
      baseUrl: baseUrl ?? 'https://api.meta.ai/v1',
      headers: cfg.headers,
    });
  }

  if (!family || family === 'unsupported') {
    if (family === 'unsupported') {
      throw new ConfigError({
        message:
          `Provider "${id}" uses an unsupported wire family (${p.npm ?? 'unknown'}). ` +
          `Register a custom factory via a plugin to enable it.`,
        code: 'CONFIG_INVALID',
      });
    }
    throw new ConfigError({
      message:
        `Provider "${id}" has no wire family configured. ` +
        `Set an explicit family ("anthropic" | "openai" | "openai-compatible" | "google") in config or the models.dev catalog.`,
      code: 'CONFIG_INVALID',
    });
  }

  // MiniMax is keyed on the HOST: models.dev files every `minimax*` entry
  // (both regions) under the Anthropic family and the trusted preset under
  // openai-compatible, and an alias may name it anything. All of them need the
  // MiniMax transport — its thinking mapping, quota reads, region-aware auth.
  if (
    (family === 'anthropic' || family === 'openai-compatible') &&
    (isMiniMaxHost(baseUrl) || (family === 'openai-compatible' && isMiniMaxProviderId(factoryType)))
  ) {
    return new MiniMaxProvider({
      id,
      apiKey: expectDefined(apiKey),
      baseUrl,
      headers: cfg.headers,
    });
  }

  switch (family) {
    case 'anthropic': {
      // Pass `id` so a config-side alias (e.g. `minimax-token-plan` with
      // `family: 'anthropic'`) keeps its user-visible id instead of being
      // collapsed to the wire-family canonical id. Without this the status
      // bar / pickers / fallback chain all see `id === 'anthropic'` and the
      // configured alias is silently lost — which is exactly the drift that
      // used to happen on `/model` switch and session resume.
      const anthropicOpts = {
        apiKey: expectDefined(apiKey),
        baseUrl,
        id,
        maxTools: validateQuirks(id, cfg.quirks)?.maxTools,
      };
      // Z.AI's `/api/anthropic` (the Claude Code setup) takes GLM's own
      // thinking contract, not Anthropic's budget_tokens shape.
      if (isZaiHost(baseUrl)) {
        return withZaiAccountPlane(new ZaiMessagesProvider(anthropicOpts), {
          apiKey: expectDefined(apiKey),
          baseUrl,
        });
      }
      return new AnthropicProvider(anthropicOpts);
    }
    case 'openai':
      return new OpenAIProvider({
        apiKey: expectDefined(apiKey),
        baseUrl,
        id,
        quirks: validateQuirks(id, cfg.quirks),
      });
    case 'openai-compatible': {
      // Provider/model discovery remains owned by models.dev. This adapter
      // only selects the gateway's per-model wire protocol.
      if (factoryType === 'opencode') {
        return new OpenCodeZenProvider({
          id,
          apiKey: expectDefined(apiKey),
          baseUrl: expectDefined(baseUrl),
          headers: cfg.headers,
          models: p.models,
        });
      }
      if (factoryType === 'opencode-go') {
        return new OpenCodeGoProvider({
          id,
          apiKey: expectDefined(apiKey),
          baseUrl,
          headers: cfg.headers,
          models: p.models,
        });
      }
      // Use a tuned preset when available (Mistral, Ollama, vLLM, LM Studio, …).
      if (factoryType === 'mistral') {
        return createWireFormatFactory(mistralWireFormat, {
          apiKey: expectDefined(apiKey),
          baseUrl: baseUrl ?? mistralWireFormat.defaultBaseUrl,
        }).create({ ...cfg, type: id });
      }
      if (factoryType === 'ollama') {
        return createWireFormatFactory(ollamaWireFormat, {
          apiKey: expectDefined(apiKey),
          baseUrl: baseUrl ?? ollamaWireFormat.defaultBaseUrl,
        }).create({ ...cfg, type: id });
      }
      if (factoryType === 'vllm') {
        return createWireFormatFactory(vllmWireFormat, {
          apiKey: expectDefined(apiKey),
          baseUrl: baseUrl ?? vllmWireFormat.defaultBaseUrl,
        }).create({ ...cfg, type: id });
      }
      if (factoryType === 'lmstudio') {
        return createWireFormatFactory(lmstudioWireFormat, {
          apiKey: expectDefined(apiKey),
          baseUrl: baseUrl ?? lmstudioWireFormat.defaultBaseUrl,
        }).create({ ...cfg, type: id });
      }
      const preset = COMPATIBLE_PRESETS[factoryType];
      const resolvedBaseUrl = baseUrl ?? preset?.defaultBaseUrl;
      if (!resolvedBaseUrl?.trim()) {
        throw new ConfigError({
          message:
            `Provider "${id}" (openai-compatible) requires a base URL. ` +
            'Set it in config or register a preset with a defaultBaseUrl.',
          code: 'CONFIG_INVALID',
        });
      }
      // Z.AI / BigModel (zai, zai-coding-plan, zhipuai, zhipuai-coding-plan,
      // or any alias on their hosts) get the GLM wire contract when their
      // definition brings none, and the account plane on top of the wire.
      const glm = zaiWireContract(resolvedBaseUrl, factoryType);
      return withZaiAccountPlane(
        new OpenAICompatibleProvider({
          ...{ id, definitionId: glm?.definitionId ?? factoryType },
          apiKey: expectDefined(apiKey),
          baseUrl: resolvedBaseUrl,
          headers: cfg.headers,
          // Preset quirks are the floor; explicit user quirks win on conflict.
          quirks: { ...glm?.quirks, ...preset?.quirks, ...validateQuirks(id, cfg.quirks) },
        }),
        { apiKey: expectDefined(apiKey), baseUrl: resolvedBaseUrl },
      );
    }
    case 'openai-codex': {
      const entry = resolveActiveKeyEntry(cfg);
      const parsedExpiry = entry?.expiresAt ? Date.parse(entry.expiresAt) : Number.NaN;
      return new OpenAICodexProvider({
        id,
        baseUrl,
        credentials: {
          accessToken: expectDefined(apiKey),
          refreshToken: entry?.refreshToken,
          expiresAt: Number.isFinite(parsedExpiry) ? parsedExpiry : undefined,
          accountId: entry?.accountId,
        },
        ...(entry?.authMethod === 'oauth' ? { credential: entry } : {}),
        ...oauthPersistenceCallbacks(id, cfg, expectDefined(apiKey)),
        // The list the ChatGPT backend reports for THIS account, refreshed on
        // the catalog probe the transport already makes.
      });
    }
    case 'anthropic-oauth':
      // Retired: a saved entry still loads, but every request is refused with
      // guidance. Its tokens are never read, refreshed or sent.
      return new RetiredAnthropicOAuthProvider(id);
    case 'github-copilot': {
      const entry = resolveActiveKeyEntry(cfg);
      const parsedExpiry = entry?.expiresAt ? Date.parse(entry.expiresAt) : Number.NaN;
      return new GitHubCopilotProvider({
        id,
        credentials: {
          copilotToken: resolveActiveKey(cfg) ?? '',
          githubToken: entry?.refreshToken,
          expiresAt: Number.isFinite(parsedExpiry) ? parsedExpiry : undefined,
        },
        ...oauthPersistenceCallbacks(id, cfg, expectDefined(apiKey)),
      });
    }
    case 'google-antigravity': {
      const entry = resolveActiveKeyEntry(cfg);
      const parsedExpiry = entry?.expiresAt ? Date.parse(entry.expiresAt) : Number.NaN;
      const persistence = oauthPersistenceCallbacks(id, cfg, expectDefined(apiKey));
      return new AntigravityProvider({
        id,
        ...(cfg.baseUrl !== undefined ? { baseUrl: cfg.baseUrl } : {}),
        credentials: {
          accessToken: expectDefined(apiKey),
          refreshToken: entry?.refreshToken,
          expiresAt: Number.isFinite(parsedExpiry) ? parsedExpiry : undefined,
          project: entry?.project,
        },
        // The OAuth client is caller-supplied, never embedded — see the
        // provider module's note. Config wins over the environment so a
        // committed setup is not silently overridden by a stray export, but
        // the env fallback matters: sign-in reads the client from there, and
        // without it a user who signed in successfully would hit a refresh
        // failure an hour later for want of a config edit nothing told them
        // to make.
        ...(resolveAntigravityClient(cfg) ?? {}),
        onRefresh: persistence.onRefresh,
      });
    }
    case 'google':
      return new GoogleProvider({
        id,
        apiKey: expectDefined(apiKey),
        baseUrl,
        maxTools: validateQuirks(id, cfg.quirks)?.maxTools,
      });
    default:
      throw new ConfigError({
        message: `Unknown provider family: ${String(family)}`,
        code: 'CONFIG_INVALID',
      });
  }
}

export function readFromEnv(vars: string[]): string | undefined {
  for (const v of vars) {
    const val = process.env[v];
    if (val?.trim()) return val;
  }
  return undefined;
}

export function validateQuirks(
  providerId: string,
  quirks: unknown,
): CompatibilityQuirks | undefined {
  if (quirks === undefined) return undefined;
  if (isCompatibilityQuirks(quirks)) return quirks;
  throw new WrongStackError({
    message: `Invalid quirks for provider "${providerId}". Expected CompatibilityQuirks.`,
    code: ERROR_CODES.CONFIG_INVALID,
    subsystem: 'provider',
  });
}

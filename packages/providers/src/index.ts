import { CODEX_MODELS, ConfigError, expectDefined } from '@wrongstack/core';
import type {
  Logger,
  ModelsRegistry,
  Provider,
  ProviderApiKey,
  ProviderConfig,
  ProviderFactory,
  ResolvedProvider,
  WireFamily,
} from '@wrongstack/core';
import { ERROR_CODES, WrongStackError } from '@wrongstack/core';
import { capabilitiesFor } from './capabilities.js';
import { AnthropicProvider } from './anthropic.js';
import { AnthropicOAuthProvider } from './anthropic-oauth.js';
import { GitHubCopilotProvider } from './github-copilot.js';
import { GoogleProvider } from './google.js';
import { OpenAICodexProvider } from './openai-codex.js';
import {
  type CompatibilityQuirks,
  isCompatibilityQuirks,
  OpenAICompatibleProvider,
} from './openai-compatible.js';
import { OpenAIProvider } from './openai.js';
import { createWireFormatFactory } from './wire-format.js';
import { mistralWireFormat } from './presets/mistral.js';
import { ollamaWireFormat, vllmWireFormat, lmstudioWireFormat } from './presets/local-llm.js';
export { AnthropicProvider, type AnthropicProviderOptions } from './anthropic.js';
export { OpenAIProvider, type OpenAIProviderOptions } from './openai.js';
export {
  OpenAICompatibleProvider,
  type OpenAICompatibleOptions,
  type CompatibilityQuirks,
} from './openai-compatible.js';
export { GoogleProvider, type GoogleProviderOptions } from './google.js';
export {
  OpenAICodexProvider,
  type OpenAICodexProviderOptions,
  type CodexCredentials,
  type CodexOAuthTokens,
  refreshCodexAccessToken,
  extractAccountId,
  resolveCodexUrl,
} from './openai-codex.js';
export {
  AnthropicOAuthProvider,
  type AnthropicOAuthProviderOptions,
  type AnthropicOAuthCredentials,
  type AnthropicOAuthTokens,
  refreshAnthropicOAuthToken,
  CLAUDE_CODE_SYSTEM_PROMPT,
} from './anthropic-oauth.js';
export {
  GitHubCopilotProvider,
  type GitHubCopilotProviderOptions,
  type CopilotCredentials,
  type CopilotTokenResult,
  refreshCopilotToken,
  copilotBaseUrlFromToken,
} from './github-copilot.js';
export { WireAdapter, type WireAdapterStreamOptions } from './wire-adapter.js';
export {
  isDebugStreamEnabled,
  setDebugStreamEnabled,
  setDebugStreamCallback,
  pushDebugChunkStats,
  defaultDebugStreamCallback,
  type DebugStreamStats,
  type DebugStreamCallback,
} from './stream-debug-state.js';
export {
  WireFormatProvider,
  defineWireFormat,
  createWireFormatFactory,
  type WireFormatConfig,
  type WireFactoryOptions,
} from './wire-format.js';
export { mistralWireFormat } from './presets/mistral.js';
export { anthropicWireFormat } from './presets/anthropic.js';
export { openaiWireFormat } from './presets/openai.js';
export { googleWireFormat } from './presets/google.js';
export { ollamaWireFormat, vllmWireFormat, lmstudioWireFormat } from './presets/local-llm.js';
export { capabilitiesFor } from './capabilities.js';
export { capabilitiesForFamily, CAPABILITIES_BY_FAMILY } from './family-capabilities.js';
export { parseProviderHttpError } from './error-parse.js';
export { normalizeAnthropic, normalizeOpenAI } from './stop-reason.js';
export { toolsToAnthropic } from './tool-format/to-anthropic.js';
export { contentFromAnthropic } from './tool-format/from-anthropic.js';
export {
  toolsToOpenAI,
  messagesToOpenAI,
  type OpenAIMessage,
  type OpenAIToolCall,
  type ConvertOptions,
} from './tool-format/to-openai.js';
export { contentFromOpenAI, type OpenAIChoice } from './tool-format/from-openai.js';
export {
  discoverOpenAICompatibleModels,
  mapCompatibleModel,
  type DiscoverOptions,
} from './auto-discover.js';

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
}

export const COMPATIBLE_PRESETS: Record<string, CompatiblePreset> = {
  omniroute: {
    defaultBaseUrl: 'http://localhost:20128/v1',
    // omniroute fronts reasoning models (Claude via Claude Code, etc.) and
    // leaks a stray </think> into the content stream — strip it. See #N.
    quirks: { stripThinkTags: true },
    autoDiscover: true,
  },
};

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

/** @deprecated use OAuthRefreshedTokens */
export type CodexRefreshedTokens = OAuthRefreshedTokens;

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

/** @deprecated use setOAuthTokenPersister */
export const setCodexTokenPersister = setOAuthTokenPersister;

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
 * stands, and `agent-response.ts` keeps its 8192 safety net for the rare
 * cases where the catalog is unreachable. The diagnostic lives at DEBUG
 * so a healthy boot stays quiet.
 */
export async function withCatalogCapabilities(
  registry: ModelsRegistry,
  providerId: string,
  provider: Provider,
  cfg: ProviderConfig,
  log?: Logger,
): Promise<Provider> {
  try {
    const resolved = await capabilitiesFor(registry, providerId, cfg.model ?? '', cfg.customModels);
    // `Provider.capabilities` is `readonly`; the property descriptor was
    // set with `writable: false` at construction time. Redefine it so
    // the catalog overlay lands cleanly.
    Object.defineProperty(provider, 'capabilities', {
      value: resolved,
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

  // Generic factories so users can hand-roll a provider not in models.dev.
  factories.push({
    type: 'openai-compatible',
    family: 'openai-compatible',
    create: (cfg) =>
      new OpenAICompatibleProvider({
        id: 'openai-compatible',
        apiKey: requireKey(cfg),
        baseUrl: cfg.baseUrl ?? '',
        headers: cfg.headers,
        quirks: validateQuirks('openai-compatible', cfg.quirks),
      }),
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
    return (active ?? cfg.apiKeys[0])?.apiKey;
  }
  return cfg.apiKey && cfg.apiKey.length > 0 ? cfg.apiKey : undefined;
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
  const envVars = cfg.envVars && cfg.envVars.length > 0 ? cfg.envVars : p.envVars;
  const apiKey = resolveActiveKey(cfg) ?? readFromEnv(envVars);
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
      return new AnthropicProvider({ apiKey: expectDefined(apiKey), baseUrl, id: p.id });
    case 'openai':
      return new OpenAIProvider({
        apiKey: expectDefined(apiKey),
        baseUrl,
        id: p.id,
        quirks: validateQuirks(p.id, cfg.quirks),
      });
    case 'openai-compatible': {
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
      return new OpenAICompatibleProvider({
        id: p.id,
        apiKey: expectDefined(apiKey),
        baseUrl: baseUrl ?? preset?.defaultBaseUrl ?? '',
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
      return new GoogleProvider({ id: p.id, apiKey: expectDefined(apiKey), baseUrl });
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
    if (val) return val;
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

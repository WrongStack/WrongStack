import type { WireFamily } from '../models-registry.js';
import type { Capabilities } from '../provider.js';
import type { ModelRuntimeConfig } from './runtime.js';

export interface ProviderApiKey {
  /** Short human-readable label (e.g. "personal", "work", "rate-limit-backup"). */
  label: string;
  /**
   * The key itself. The field name contains `apiKey` so the secret-vault
   * walker will encrypt it on write and decrypt it on read.
   */
  apiKey: string;
  /** ISO-8601 timestamp the key was added. */
  createdAt: string;
  /**
   * How this credential was obtained.
   * - `api_key`       — manually pasted API key (default)
   * - `oauth`         — OAuth 2.0 device-code / authorization-code flow
   * - `session_token` — extracted from browser session (ChatGPT web, etc.)
   */
  authMethod?: 'api_key' | 'oauth' | 'session_token' | undefined;
  /** ISO-8601 expiry. When set, the token manager will refresh before this time. */
  expiresAt?: string | undefined;
  /**
   * OAuth refresh token. Stored encrypted by the secret-vault walker because
   * the field name contains `Token` (case-insensitive match by vault).
   */
  refreshToken?: string | undefined;
  /** Token type as returned by the OAuth endpoint (e.g. "bearer"). */
  tokenType?: string | undefined;
  /** OAuth scope string (e.g. "openai.models.read openai.models.use"). */
  scope?: string | undefined;
  /**
   * ChatGPT account id, extracted from the OAuth access-token JWT
   * (`https://api.openai.com/auth`.chatgpt_account_id). Sent as the
   * `chatgpt-account-id` header by the `openai-codex` wire family. Cached
   * here for display/diagnostics; the provider re-derives it from the live
   * token at request time so it can never go stale after a refresh.
   */
  accountId?: string | undefined;
}

export interface ProviderConfig {
  type: string;
  /**
   * Legacy single-key field. Still honored as a read fallback when `apiKeys`
   * is empty (for configs not yet migrated to multi-key format). After key
   * management operations (`writeKeysBack`), this field is **cleared** to
   * prevent accidental serialization of the plaintext key. Consumers that
   * need the active API key should use `resolveActiveApiKey()` (cli) or
   * resolve from `apiKeys[]` directly — never read `cfg.apiKey` in new code.
   */
  apiKey?: string | undefined;
  /** Multiple keys for the same provider — pick one with `activeKey`. */
  apiKeys?: ProviderApiKey[] | undefined;
  /** Label of the entry in `apiKeys` to use. Defaults to the first one. */
  activeKey?: string | undefined;
  baseUrl?: string | undefined;
  headers?: Record<string, string>;
  model?: string | undefined;
  quirks?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
  /**
   * Optional wire-family override. When present, the provider can be
   * constructed without consulting the models.dev catalog — useful for
   * self-hosted endpoints, internal proxies, or for working offline.
   */
  family?: WireFamily | undefined;
  /** Custom env var names to probe when `apiKey` is missing. */
  envVars?: string[] | undefined;
  /**
   * Optional list of models the user wants visible for this provider.
   * Raw JSON config may also contain model.dev-style objects here; the config
   * loader normalizes those objects into this string list plus `customModels`
   * before exposing a typed `Config` to runtime consumers.
   */
  models?: string[] | undefined;
  /**
   * Fetch this provider's model list + per-model capabilities from its
   * `{baseUrl}/models` endpoint at startup and inject them into the catalog.
   * For openai-compatible gateways/proxies (omniroute, LiteLLM, vLLM, …) that
   * expose rich metadata there. Defaults on for presets that set it (omniroute).
   * Discovery is best-effort: a down server or missing key is a no-op.
   */
  autoDiscoverModels?: boolean | undefined;
  /**
   * Provider-relative custom model definitions (maps modelId → definition).
   * Each entry adds/overrides a model for this provider with optional
   * capability overrides. The model id is the key, not a fully qualified id.
   */
  customModels?: Record<string, CustomModelDefinition>;
  /**
   * Per-provider OAuth configuration. When present, `wstack auth login <id>`
   * uses this instead of prompting for a raw API key. Set by the catalog or
   * by the user via `/settings`.
   */
  oauthConfig?:
    | {
        /** OAuth client id registered with the provider. */
        clientId?: string | undefined;
        /** Device authorization endpoint (RFC 8628). */
        deviceCodeEndpoint?: string | undefined;
        /** Token endpoint for code exchange and refresh. */
        tokenEndpoint?: string | undefined;
        /** Authorization server URL shown to the user for opening in browser. */
        authorizationEndpoint?: string | undefined;
        /** Default OAuth scopes to request. */
        scopes?: string[] | undefined;
      }
    | undefined;
}

/**
 * One entry in the per-task model matrix. Pins a catalog role, a phase, or
 * the `*` default to a specific model (and, optionally, a specific provider).
 * Resolved at subagent-spawn time so e.g. `security-scanner` can run a
 * different model than `documentation` while the leader stays on its own.
 */
export interface ModelMatrixEntry {
  /** Provider registry id (e.g. "anthropic", "minimax", "zai"). When omitted,
   *  the leader's provider is used with this entry's model. */
  provider?: string | undefined;
  /** Model id to run for the matched role/phase/default. */
  model?: string | undefined;
  /**
   * Runtime request overrides for subagents matched by this entry. This is
   * intentionally scoped to subagents: leader requests keep using top-level
   * `Config.modelRuntime`, while a role/phase can opt into its own reasoning
   * effort, cache TTL, or gated generation parameters.
   */
  modelRuntime?: ModelRuntimeConfig | undefined;
  /**
   * Named fallback profile to use for the matched role/phase/default. When
   * `model` is omitted, the first model in the profile becomes the primary and
   * the remaining entries become that subagent's fallback chain.
   */
  fallbackProfile?: string | undefined;
}

export interface CustomModelDefinition {
  /** Provider this model belongs to. Defaults to the owning ProviderConfig. */
  provider?: string | undefined;
  /** Optional display name. */
  name?: string | undefined;
  /** Capability overrides — only specified fields are overlaid. */
  capabilities?: Partial<Capabilities> | undefined;
  /**
   * Max output tokens. If not specified, the provider family default
   * or catalog entry is used.
   */
  maxOutput?: number | undefined;
}

/**
 * Skill subsystem configuration. All fields optional; the subsystem itself is
 * gated by `features.skills`. Honored from the user's active-profile config;
 * in the repo-committed in-project config the `extraDirs` field is stripped
 * (arbitrary directories are a prompt-injection vector) — only `readClaudeSkills`
 * and `mode` survive there.
 */

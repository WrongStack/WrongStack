import type { ModelsDevModel, WireFamily } from '../models-registry.js';
import type { NativeCloudSettings } from '../native-cloud.js';
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
  /** Provider-specific renewable auth flow; kept with this account, not its wire family. */
  oauthStrategyId?: string | undefined;
  /** Issued public OAuth client ID for this account registration. */
  oauthClientId?: string | undefined;
  /** Verified OIDC subject. Never inferred from an unverified access token. */
  oauthSubject?: string | undefined;
  /** Retained OIDC token for reauthorization hints; encrypted by SecretVault. */
  idToken?: string | undefined;
  /**
   * ChatGPT account id, extracted from the OAuth access-token JWT
   * (`https://api.openai.com/auth`.chatgpt_account_id). Sent as the
   * `chatgpt-account-id` header by the `openai-codex` wire family. Cached
   * here for display/diagnostics; the provider re-derives it from the live
   * token at request time so it can never go stale after a refresh.
   */
  accountId?: string | undefined;
  /**
   * Google Cloud Code project id, discovered at sign-in by the
   * `google-antigravity` wire family and sent in every request envelope.
   *
   * Cached here for the same reason `accountId` is: deriving it costs a
   * round-trip (two, on an account that has never been onboarded), it is
   * stable for the account, and a session that has it can send its first
   * request immediately. Unlike `accountId` it is NOT re-derivable from the
   * token, so this is the only record of it.
   */
  project?: string | undefined;
}

export interface ProviderConfig {
  type: string;
  /** Explicit per-profile native routing settings take precedence over environment fallbacks. */
  cloud?: NativeCloudSettings | undefined;
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
  /**
   * OAuth client id used to refresh this provider's subscription token.
   *
   * Only the `google-antigravity` family reads it today, and it exists because
   * that family's client is not ours to ship: Google checks which client
   * minted a token, and the one its desktop app uses is extracted from a
   * proprietary binary rather than published. Supplying it is the user's
   * decision, so it lives in their config instead of in our source.
   */
  oauthClientId?: string | undefined;
  /** Client secret paired with {@link ProviderConfig.oauthClientId}. */
  oauthClientSecret?: string | undefined;
  /**
   * A gateway's management credential, separate from the inference key —
   * OmniRoute's scoped access token (`oma_…`, `read` scope is enough). It
   * reads the gateway's per-account plan limits; nothing else uses it.
   * Encrypted at rest like every `*token` field.
   */
  managementToken?: string | undefined;
  /**
   * A plan-quota or balance read for a provider the built-in readers do not
   * know: an account endpoint on the provider's own host, and where in its
   * JSON the numbers are. Read with the provider's active key, never a model
   * call. See {@link ProviderQuotaEndpoint}.
   */
  quotaEndpoint?: ProviderQuotaEndpoint | undefined;
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
  /** Provider-relative endpoint below baseUrl. Defaults to `models`. */
  modelDiscoveryPath?: string | undefined;
  /** Treat discovery as the complete model set available to this credential. */
  modelDiscoveryAuthoritative?: boolean | undefined;
  /**
   * Provider-relative custom model definitions (maps modelId → definition).
   * Each entry adds/overrides a model for this provider with optional
   * capability overrides. The model id is the key, not a fully qualified id.
   */
  customModels?: Record<string, CustomModelDefinition>;
  // A generic `oauthConfig` block (clientId / deviceCodeEndpoint /
  // tokenEndpoint / authorizationEndpoint / scopes) was declared here and
  // documented as what `wstack auth login <id>` uses instead of an API-key
  // prompt. Nothing read it, and there is no `auth login` subcommand: the
  // OAuth that actually ships is per-provider and lives in
  // packages/providers/src/oauth/ (Anthropic, OpenAI Codex, GitHub Copilot),
  // driven by their own flows rather than by user-supplied endpoints. Removed
  // so config no longer advertises a hook that reaches nothing.
}

/**
 * Where a provider's account endpoint keeps its plan usage or balance.
 *
 * Paths are dot-separated (`data.usage.used`, `items.0.limit`; a leading `$.`
 * is accepted). A window needs `total` with `used` or `remaining`, or
 * `percent` (0..100 used); a balance needs `balance`. The URL must be on the
 * same host as the provider's `baseUrl` — the active key is sent to it.
 */
export interface ProviderQuotaEndpoint {
  /** Absolute https URL of the account read (http only on localhost). */
  url: string;
  /** How the active key is sent. Default `bearer`. */
  auth?: 'bearer' | 'x-api-key' | 'none' | undefined;
  used?: string | undefined;
  total?: string | undefined;
  remaining?: string | undefined;
  /** Percentage used, 0..100, for an endpoint that reports one directly. */
  percent?: string | undefined;
  /** Reset time: an ISO date string or epoch seconds/milliseconds. */
  resetAt?: string | undefined;
  /** Window length in minutes, when the endpoint does not say. */
  windowMinutes?: number | undefined;
  /** Window name shown on the bar (`month`, `daily`). */
  label?: string | undefined;
  /** Remaining prepaid balance. */
  balance?: string | undefined;
  /** Currency code of `balance` (`USD`, `CNY`). Default `USD`. */
  currency?: string | undefined;
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
  /**
   * Full models.dev model payload (ME-2, Model Editor). Stores all schema
   * fields for catalog overrides (delta — only changed fields are set) and
   * custom (non-catalog) models (full object). Validated by
   * `modelsDevModelSchema` from `@wrongstack/core/models`.
   *
   * Legacy derived fields above (`name`, `capabilities`, `maxOutput`) stay
   * functional for existing configs and are kept in sync by
   * `normalizeInlineProviderModels` — prefer setting `modelsDev` for new
   * code so the full schema round-trips.
   */
  modelsDev?: Omit<ModelsDevModel, 'id'> | undefined;
}

/**
 * Skill subsystem configuration. All fields optional; the subsystem itself is
 * gated by `features.skills`. Honored from the user's active-profile config;
 * in the repo-committed in-project config the `extraDirs` field is stripped
 * (arbitrary directories are a prompt-injection vector) — only `readClaudeSkills`
 * and `mode` survive there.
 */

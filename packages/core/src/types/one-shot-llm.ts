import type { TextBlock } from './blocks.js';
import type { ResponseFormat } from './provider.js';

/**
 * Input for a single one-shot LLM call.
 * Every field is optional with sensible defaults — the caller specifies
 * only what it needs to vary from the baseline.
 */
export interface OneShotLLMInput {
  /**
   * System prompt. Can be a string or structured TextBlock array.
   * When absent, the call is prompt-only (messages decide the tone).
   */
  system?: string | TextBlock[] | undefined;

  /**
   * Conversation messages to send alongside the user prompt.
   * Used for few-shot examples or multi-turn context.
   */
  messages?: import('./messages.js').Message[] | undefined;

  /**
   * Shortcut for a single user turn. Appended as a `user`-role message.
   * When both `userPrompt` and `messages` are set, the user message
   * is appended after the existing messages.
   */
  userPrompt?: string | undefined;

  // ── Provider & model selection ────────────────────────────────

  /**
   * Exact model id, e.g. "deepseek-chat", "gpt-4o-mini", "claude-3-haiku".
   * When set alongside `providerId`, both are used directly.
   * When set alone, the provider is resolved from the config's default.
   */
  model?: string | undefined;

  /**
   * Provider id, e.g. "anthropic", "openai", "deepseek".
   * When absent, the session's default provider is used.
   */
  providerId?: string | undefined;

  /**
   * Roster role for model-matrix routing. When set, the ModelRouter
   * picks the best provider+model for this task type instead of using
   * the default. Overrides `model` and `providerId` when the matrix
   * has an entry for this role.
   */
  role?: string | undefined;

  // ── Fallback ──────────────────────────────────────────────────

  /**
   * Resolved fallback model chain. Each entry is a model ref:
   * "model", "provider/model", or "provider model".
   *
   * Named profiles are resolved upstream through the shared
   * FallbackProfileManager (see {@link OneShotOrchestratorOptions.fallbackProfileManager})
   * — the OneShot tool/runtime only sees the already-resolved chain.
   */
  fallbackModels?: string[] | undefined;

  // ── Output controls ───────────────────────────────────────────

  /**
   * Maximum output tokens. Default: 1024.
   */
  maxTokens?: number | undefined;

  /**
   * Response format: text (default), json_object, or json_schema.
   */
  responseFormat?: ResponseFormat | undefined;

  /**
   * Sampling temperature. Default: provider-specific default.
   */
  temperature?: number | undefined;

  // ── Lifecycle ─────────────────────────────────────────────────

  /**
   * AbortSignal for cancellation. When combined with `timeoutMs`,
   * the sooner of the two wins.
   */
  signal?: AbortSignal | undefined;

  /**
   * Hard timeout in milliseconds. Creates an AbortSignal internally
   * when no external `signal` is provided. Default: 30_000 (30s).
   */
  timeoutMs?: number | undefined;
}

/**
 * Structured result from a one-shot LLM call.
 */
export interface OneShotLLMResult {
  /** The response text (trimmed). Empty on total failure. */
  text: string;

  /** Model that actually served the request. */
  model: string;

  /** Provider that actually served the request. */
  provider: string;

  /** Token usage breakdown. */
  tokens: {
    input: number;
    output: number;
    total: number;
  };

  /** Wall-clock duration of the LLM call (ms). */
  durationMs: number;

  /** Whether the response came from a fallback model. */
  fromFallback: boolean;

  /** Provider-level stop reason, if available. */
  stopReason?: string | undefined;

  /**
   * When set, the call failed (all providers exhausted, timeout,
   * invalid request). The error message describes the failure.
   */
  error?: string | undefined;
}

/** One role→model resolution. Mirrors `ModelPick` from the ModelRouter. */
export interface OneShotModelPick {
  provider: string;
  model: string;
  /**
   * True when the pick came from the user's `/setmodel` matrix (explicit
   * intent) rather than from capability heuristics. Only a matrix pick may
   * override a caller's explicit `providerId`/`model`.
   */
  fromMatrix?: boolean | undefined;
}

/** Minimal router contract consumed by role-based routing. */
export interface OneShotModelRouter {
  pickForTask(role: string, description: string): OneShotModelPick | undefined;
}

/**
 * Dependencies for OneShotOrchestrator.
 */
export interface OneShotOrchestratorOptions {
  /**
   * Build a credential-resolved Provider for a provider id+model.
   * Same contract as `FallbackModelDeps.buildProvider`.
   */
  buildProvider: (providerId: string, modelId?: string | undefined) => import('./provider.js').Provider | Promise<import('./provider.js').Provider>;

  /**
   * Returns the live config (re-read each turn so model switches
   * are honored without restart).
   */
  getConfig: () => import('./config.js').Config;

  /**
   * Shared live FallbackProfileManager for resolving fallback chains.
   */
  fallbackProfileManager: import('../core/fallback-profile-manager.js').FallbackProfileManager;

  /**
   * Optional role→model router. When absent, role-based routing is skipped
   * and `role` on an input is inert.
   *
   * Structurally typed rather than pinned to the concrete `ModelRouter` class
   * so a host can supply a router rebuilt from the LIVE config on every call
   * (the `/setmodel` matrix changes mid-session). `ModelRouter` satisfies it.
   */
  modelRouter?: OneShotModelRouter | undefined;

  /**
   * Optional logger for fallback warnings.
   */
  logger?: import('./logger.js').Logger | undefined;

  /**
   * Shared provider/model status tracker. When set, the orchestrator
   * records failures and successes, and skips blocked entries in the
   * fallback chain.
   */
  statusTracker?: import('../coordination/provider-status-tracker.js').ProviderModelStatusTracker | undefined;
}

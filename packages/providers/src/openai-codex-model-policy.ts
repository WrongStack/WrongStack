import type { ReasoningEffort } from '@wrongstack/contracts/types';
import type { CodexTruncationPolicy } from './openai-codex-truncation.js';

export { parseCodexTruncationPolicy } from './openai-codex-truncation.js';

/**
 * Fraction of a model's catalog `context_window` the backend actually lets a
 * request occupy, when the catalog does not say. The official Codex client
 * computes its usable window as
 * `resolved_context_window * effective_context_window_percent / 100`
 * (codex-rs/core/src/session/context_window.rs) and the live ChatGPT catalog
 * ships `effective_context_window_percent: 95` on every model, so 95 is the
 * value the field defaults to rather than a guess.
 */
export const CODEX_DEFAULT_EFFECTIVE_CONTEXT_PERCENT = 95;

/**
 * Derive the effective SEND ceiling from a catalog entry.
 *
 * The catalog publishes TWO windows and they mean different things:
 *
 * - `context_window` is the model's DEFAULT window (272K across the current
 *   lineup, 128K on spark).
 * - `max_context_window` is the largest window the model supports — the
 *   ceiling an explicit configured override may reach. The official client
 *   resolves it as `configured.min(max_context_window)`
 *   (codex-rs/models-manager/src/model_info.rs, `with_config_overrides`).
 *
 * So `max_context_window` IS a bigger window, just one a client has to ask
 * for; on gpt-6-astra and the gpt-5.6 family it is 872K against a 272K
 * default. Reporting the default as a hard cap throws away two thirds of the
 * window these models actually have, which is why the maximum is preferred
 * here and the default is only the fallback for older catalogs. The agent loop
 * still clamps this against its own configured baseline and any learned
 * overflow limit, so this is a ceiling, not a target.
 *
 * The effective percent is the output/overhead reserve the backend keeps
 * inside whichever window applies; there is no separate fixed subtraction to
 * make on top of it.
 */
export function codexSendCeiling(contextWindow: number, effectivePercent: number): number {
  const percent =
    Number.isFinite(effectivePercent) && effectivePercent > 0 && effectivePercent <= 100
      ? effectivePercent
      : CODEX_DEFAULT_EFFECTIVE_CONTEXT_PERCENT;
  return Math.max(1, Math.floor((contextWindow * percent) / 100));
}

export interface CodexModelMetadata {
  slug?: unknown;
  context_window?: unknown;
  max_context_window?: unknown;
  effective_context_window_percent?: unknown;
  default_reasoning_level?: unknown;
  supported_reasoning_levels?: unknown;
  input_modalities?: unknown;
  supports_parallel_tool_calls?: unknown;
  support_verbosity?: unknown;
  truncation_policy?: unknown;
  visibility?: unknown;
  display_name?: unknown;
  description?: unknown;
}

/** One picker-visible model, as the ChatGPT backend describes it. */
export interface CodexLiveModel {
  id: string;
  name: string;
  description?: string | undefined;
  /** Largest window the model supports, before the effective-window discount. */
  maxContext?: number | undefined;
}

/** Per-model policy the catalog publishes and the transport honours. */
export interface CodexModelPolicy {
  /** Input-token ceiling, already discounted by the effective-window percent. */
  sendCeiling: number;
  /** The model's own default reasoning effort, when the catalog names one. */
  defaultReasoningEffort?: ReasoningEffort | undefined;
  /**
   * Efforts this model accepts, in the catalog's own ascending order. Empty
   * when the catalog does not say, which means "send whatever was asked".
   */
  supportedReasoningEfforts: readonly ReasoningEffort[];
  /** False when the catalog lists no `image` input modality. */
  acceptsImages: boolean;
  /** False only when the catalog explicitly says the model cannot parallelise. */
  parallelToolCalls: boolean;
  supportsVerbosity: boolean;
  /** Tool-output truncation the catalog prescribes; absent means "send as-is". */
  truncation?: CodexTruncationPolicy | undefined;
}

/**
 * Reasoning efforts in ascending strength. Used only to answer "which
 * supported level is nearest below the one asked for" — the catalog decides
 * what a given model supports, this decides how to walk it.
 */
const CODEX_REASONING_LADDER = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly ReasoningEffort[];

const CODEX_REASONING_EFFORTS: ReadonlySet<string> = new Set(CODEX_REASONING_LADDER);

export function parseReasoningEffort(value: unknown): ReasoningEffort | undefined {
  return typeof value === 'string' && CODEX_REASONING_EFFORTS.has(value)
    ? (value as ReasoningEffort)
    : undefined;
}

/**
 * Read `supported_reasoning_levels`, an array of `{ effort, description }`.
 *
 * Kept in the catalog's order rather than sorted: that order is the backend's
 * own ranking, which is what makes "the nearest supported effort" meaningful
 * without this module hardcoding a ladder that the next model tier changes.
 */
export function parseSupportedReasoningEfforts(value: unknown): ReasoningEffort[] {
  if (!Array.isArray(value)) return [];
  const out: ReasoningEffort[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const effort = parseReasoningEffort((raw as { effort?: unknown }).effort);
    if (effort && !out.includes(effort)) out.push(effort);
  }
  return out;
}

/**
 * Clamp a requested reasoning effort to something this model actually accepts.
 *
 * The catalog's levels differ by tier — `max` exists on gpt-6-astra and the
 * gpt-5.6 family but NOT on gpt-5.5, gpt-5.4-mini or gpt-5.3-codex-spark, and
 * `minimal` exists nowhere. Forwarding an unsupported effort spends a whole
 * request to earn a 400, then spends another on the retry; degrading to the
 * nearest supported level spends one request that works.
 *
 * "Nearest" walks DOWN the catalog's own ordering from the requested level, so
 * `max` on a low/medium/high/xhigh model becomes `xhigh` rather than the
 * timid `medium` a blind fallback would pick.
 */
export function clampReasoningEffort(
  effort: ReasoningEffort,
  supported: readonly ReasoningEffort[],
): ReasoningEffort {
  if (supported.length === 0 || supported.includes(effort)) return effort;
  const requestedRank = CODEX_REASONING_LADDER.indexOf(effort);
  if (requestedRank < 0) return supported[supported.length - 1] ?? effort;
  let best: ReasoningEffort | undefined;
  let bestRank = -1;
  for (const candidate of supported) {
    const rank = CODEX_REASONING_LADDER.indexOf(candidate);
    if (rank < 0 || rank > requestedRank) continue;
    if (rank > bestRank) {
      bestRank = rank;
      best = candidate;
    }
  }
  // Everything the model offers is stronger than what was asked for: take the
  // weakest of those rather than silently escalating to the top.
  return best ?? supported[0] ?? effort;
}

export interface CodexModelsResponse {
  models?: unknown;
}

/**
 * Decide what happens to a caller's `req.maxTokens` on the Codex wire.
 *
 * ChatGPT's subscription-backed `/backend-api/codex/responses` surface rejects
 * `max_output_tokens` with HTTP 400, even though the public Responses API
 * accepts it. Always omit the field and let the backend apply the selected
 * model's own output policy.
 *
 * Kept as an exported compatibility helper for existing callers.
 */
export function codexOutputCap(_maxTokens: number | undefined): undefined {
  return undefined;
}

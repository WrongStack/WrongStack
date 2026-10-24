/** Option, result and telemetry shapes of the prompt refiner (prompt-enhancer.ts). */

import type { Provider, ReasoningRequest, Usage } from '@wrongstack/contracts/types/provider';
import type { OneShotOrchestrator } from './one-shot-llm.js';

/** A single text-only conversation turn used as refiner context. */
export interface ConversationTurn {
  role: 'user' | 'assistant';
  text: string;
}

/** Additional context the refiner may use to resolve references. */
export interface RefinerContextSection {
  title: string;
  items: string[];
}

/**
 * Minimal structural shape of the live agent context needed to enrich the
 * refiner. Kept structural so browser/client bundles do not need the Context
 * class and tests can pass plain objects.
 */
export interface RefinerSessionContextLike {
  projectRoot?: unknown;
  cwd?: unknown;
  workingDir?: unknown;
  readFiles?: unknown;
  writtenFiles?: unknown;
  todos?: unknown;
}

/**
 * Result of a successful prompt refinement. Carries the original-language and
 * validated English versions so the UI can offer both. English input still
 * uses the two-part wire contract; both fields may contain identical text.
 */
export interface EnhanceResult {
  /** Refined in the user's original language. */
  refined: string;
  /** Refined in English. Equals `refined` when the input was already English. */
  english: string;
}

/**
 * Why a refine attempt fell through. Callers use this to decide the recovery
 * path: `timeout` is a transient capacity/latency failure worth an automatic
 * retry with a longer window (the model was reachable, just slow); `empty` and
 * `provider_error` mean the attempt produced nothing useful, so the caller
 * should surface the recovery options (retry, switch model, send as-is) rather
 * than silently retry. User-initiated cancellation is NOT reported here (it
 * returns `null` with no `onError` call).
 */
export type EnhanceFailureKind = 'timeout' | 'empty' | 'provider_error';

/** Which refiner pass produced a usage report. */
export interface EnhancePassInfo {
  /** 1 = initial pass, 2 = the single corrective pass. */
  pass: 1 | 2;
  kind: 'initial' | 'corrective';
}

/** Final disposition of a refine call. */
export type EnhanceOutcomeKind = 'success' | 'timeout' | 'provider_error' | 'empty' | 'cancelled';

export interface EnhanceOutcome {
  result: EnhanceOutcomeKind;
  /** Total refiner passes (1 = clean; 2 = the corrective pass was used). */
  passes: number;
  /** Responses that failed the bilingual contract and required a corrective pass. */
  parseRejections: number;
  durationMs: number;
}

export interface EnhanceUserPromptOptions {
  provider: Provider;
  model: string;
  text: string;
  /**
   * Recent conversation turns (oldest→newest), text only, used purely as
   * CONTEXT so the refiner can resolve references in a follow-up message
   * ("it", "the same", "that file"). Without this, the refiner is blind to
   * the conversation and can only refine self-contained prompts. Build with
   * `recentTextTurns(ctx.messages)`.
   */
  history?: ConversationTurn[] | undefined;
  /**
   * Project/session context snippets, already filtered and compacted by the
   * caller. They are context only: the refiner may use them to resolve
   * references, names, files, conventions, and constraints, but must not turn
   * them into extra requirements.
   */
  contextSections?: RefinerContextSection[] | undefined;
  /** Previous refinement when the user asks for another pass. */
  previousRefinement?: EnhanceResult | undefined;
  /** Short instruction for a retry pass. Defaults to `DEFAULT_REFINER_RETRY_FEEDBACK`. */
  retryFeedback?: string | undefined;
  /** Parent abort signal (e.g. the run controller / Esc). */
  signal?: AbortSignal | undefined;
  /** Hard cap on how long to wait for the refiner before giving up. Default 90s. */
  timeoutMs?: number | undefined;
  /** Max tokens for the refined output. Default 2048. */
  maxTokens?: number | undefined;
  /**
   * Reasoning directive for the refiner call. Refinement is a shallow
   * restate-this-more-clearly task that does not benefit from extended
   * thinking, so callers pass a low-effort / thinking-disabled hint here to
   * cut latency and (hidden) reasoning-token cost — most impactful on slow
   * reasoning models. Build it with `gatedEnhancerReasoning(rc)` so the field
   * is gated to what the model accepts. Omit (undefined) to send no reasoning
   * directive at all (the provider's own default applies).
   */
  reasoning?: ReasoningRequest | undefined;
  /**
   * Called with a short reason and a machine-readable `kind` when refinement
   * fails (provider error, timeout, empty response). NOT called when the caller
   * cancels via `signal`. The `kind` lets the UI drive recovery: `timeout` is
   * eligible for an automatic longer-window retry; `empty` / `provider_error`
   * surface the recovery options instead. The second argument is optional so
   * existing callers that only read the reason keep compiling.
   */
  onError?: ((reason: string, kind?: EnhanceFailureKind) => void) | undefined;
  onUsage?: ((usage: Usage, pass: EnhancePassInfo) => void) | undefined;
  /**
   * Called exactly once with the final disposition of the call — including
   * cancellations, which `onError` deliberately omits. Pure telemetry for
   * metrics/event surfaces; absent, nothing is reported.
   */
  onOutcome?: ((outcome: EnhanceOutcome) => void) | undefined;
  /**
   * OneShotOrchestrator for the refiner LLM call. When set, uses it instead
   * of direct provider.complete(), gaining fallback chain support.
   */
  oneShotOrchestrator?: OneShotOrchestrator | undefined;
}

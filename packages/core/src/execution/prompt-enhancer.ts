import { isTextBlock } from '@wrongstack/contracts/types/blocks';
import type {
  Provider,
  ReasoningConfig,
  ReasoningEffort,
  ReasoningRequest,
  Request,
  Usage,
} from '@wrongstack/contracts/types/provider';
import { toErrorMessage } from '../utils/error.js';
import { readBundledInstructionText } from '../utils/instruction-file.js';
import type { OneShotOrchestrator } from './one-shot-llm.js';
import { buildRefinerInput, compactText } from './prompt-enhancer-context.js';
import { parseBilingualEnhancement } from './prompt-enhancer-language.js';
import type {
  EnhanceOutcomeKind,
  EnhancePassInfo,
  EnhanceResult,
  EnhanceUserPromptOptions,
} from './prompt-enhancer-types.js';

export {
  buildRefinerContextSections,
  DEFAULT_REFINER_RETRY_FEEDBACK,
  recentTextTurns,
} from './prompt-enhancer-context.js';
export { isValidEnglishRefinement, parseBilingualEnhancement } from './prompt-enhancer-language.js';
export type {
  ConversationTurn,
  EnhanceFailureKind,
  EnhanceOutcome,
  EnhanceOutcomeKind,
  EnhancePassInfo,
  EnhanceResult,
  EnhanceUserPromptOptions,
  RefinerContextSection,
  RefinerSessionContextLike,
} from './prompt-enhancer-types.js';

/**
 * Prompt refinement ("did you mean this?").
 *
 * Runs a one-shot LLM call in a SEPARATE context (its own system prompt, no
 * conversation history, no tools) that rewrites a raw user message into a
 * clearer, more complete instruction BEFORE the main agent sees it. The goal
 * is to make the main context start from a well-understood request rather than
 * guessing intent from terse input like "fix the bug".
 *
 * This mirrors `IntelligentCompactor.callSummarizer` — a plain
 * `provider.complete()` with a dedicated system prompt — and is deliberately
 * free of React / TUI dependencies so it can be unit-tested in isolation.
 */

export const ENHANCER_SYSTEM_PROMPT = readBundledInstructionText('llm/prompt-enhancer.md');

/** Words/phrases that are control answers, not refinable requests. */
const AFFIRMATION_RE =
  /^(y|n|yes|no|yep|nope|ok|okay|sure|go|go ahead|continue|proceed|stop|cancel|done|next|skip|retry|again|please do|do it)\b[.! ]*$/i;

/**
 * Non-English control answers for the languages NON_ENGLISH_PROMPT_WORDS
 * already covers (Turkish, Spanish/Portuguese, French, German). "evet devam
 * et" or "ja weiter" is a control answer, not a refinable request — skip it
 * like AFFIRMATION_RE skips the English ones. No `\b` tail: words ending in
 * non-ASCII letters (sí, geç) have no ASCII word boundary there, and the $
 * anchor already prevents the alternation from bleeding into longer input.
 */
const NON_ENGLISH_CONTROL_RE =
  /^(?:evet devam et|evet|hayır|tamam|devam et|devam|iptal|olur|dur|geç|tekrar|sí|si|continuar|sigue|cancelar|parar|listo|otra vez|vale|oui|continuer|annuler|arrêter|arrête|encore|d'accord|vas-y|ja|nein|weiter|abbrechen|fertig|nochmal)[.! ]*$/iu;

/**
 * Heuristic gate: should this raw input be sent through the refiner at all?
 * Pure + exported for unit testing. Returns false for inputs where refinement
 * is pointless or unwanted (slash commands, one-word affirmations, trivially
 * short text, bare numbers).
 */
export function shouldEnhance(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t.startsWith('/')) return false; // slash command
  if (t.length < 12) return false; // too short to be worth refining
  if (AFFIRMATION_RE.test(t) || NON_ENGLISH_CONTROL_RE.test(t)) return false; // "yes" / "continue" / "evet devam et" / ...
  if (/^[\d\s.,]+$/.test(t)) return false; // bare numbers (menu picks, etc.)
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 3) return false; // 1–2 words rarely benefit
  return true;
}

/**
 * Preference order when picking an effort level: the cheapest level that still
 * does SOME reasoning first ('low', then 'minimal'), then up the ladder, with
 * fully-off ('none') last so it's only chosen when it's the sole advertised
 * option. This keeps the refiner cheap without dropping reasoning entirely when
 * a little still helps. 'low' leads because it's the most widely accepted low
 * level across adapters (e.g. OpenAI's reasoning_effort set).
 */
const EFFORT_PREFERENCE: ReasoningEffort[] = [
  'low',
  'minimal',
  'medium',
  'high',
  'xhigh',
  'max',
  'none',
];

/**
 * Build a reasoning directive for the refiner that minimizes wasted thinking,
 * gated to what the model actually accepts. Refinement is a shallow rewrite
 * task — extended thinking adds latency and (hidden) token cost for little
 * gain — so we ask the model to spend as little reasoning as it safely can.
 *
 * The gating mirrors `resolveReasoningForRequest` so we never send a field the
 * model would reject:
 *   - effort-capable model      → its lowest advertised effort level;
 *   - else disable-capable model → disable thinking (`enabled: false`);
 *   - else (always-on / unknown) → `undefined` (leave the provider default).
 *
 * Returns `undefined` whenever nothing can be safely reduced. Callers forward
 * that verbatim to `enhanceUserPrompt`, which then sends no reasoning field —
 * identical to the behavior before this hint existed. Pure + exported for unit
 * testing.
 */
export function gatedEnhancerReasoning(
  rc: ReasoningConfig | undefined,
): ReasoningRequest | undefined {
  // Capabilities unknown → don't risk an unsupported field (matches the
  // conservative "capabilities unknown" branch in resolveReasoningForRequest).
  if (!rc) return undefined;
  if (rc.effortSupported && rc.effortLevels.length > 0) {
    const lowest = EFFORT_PREFERENCE.find((e) => rc.effortLevels.includes(e)) ?? rc.effortLevels[0];
    if (lowest) return { effort: lowest };
  }
  if (rc.disableSupported) return { enabled: false };
  return undefined;
}

/**
 * Normalize for "did the refiner actually change anything?" comparison —
 * collapse whitespace and lowercase so trivial reformatting doesn't trigger
 * the confirmation panel.
 */
export function normalizedEqual(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Refine a raw user prompt. Returns the refined text, or `null` when the
 * caller should fall back to the original (refiner errored, timed out, was
 * aborted, or returned nothing useful). NEVER throws — refinement is a
 * best-effort convenience and must never block the user from sending.
 */
export interface RefinerCompletionOptions {
  provider: Provider;
  oneShotOrchestrator?: OneShotOrchestrator | undefined;
  request: Request;
  signal: AbortSignal;
  timeoutMs: number;
}

/** Execute one refiner pass through either the orchestrator or direct provider. */
export async function completeRefinerPass(
  input: string,
  opts: RefinerCompletionOptions,
): Promise<{ text: string; error?: string | undefined; usage?: Usage | undefined }> {
  if (opts.oneShotOrchestrator) {
    const result = await opts.oneShotOrchestrator.call({
      system: ENHANCER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: input }],
      maxTokens: opts.request.maxTokens,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });
    return result.error
      ? { text: '', error: result.error }
      : {
          text: result.text.trim(),
          usage: { input: result.tokens.input, output: result.tokens.output },
        };
  }
  const response = await opts.provider.complete(
    { ...opts.request, messages: [{ role: 'user', content: input }] },
    { signal: opts.signal },
  );
  return {
    text: response.content
      .filter(isTextBlock)
      .map((block) => block.text)
      .join('\n')
      .trim(),
    usage: response.usage,
  };
}

export async function enhanceUserPrompt(
  opts: EnhanceUserPromptOptions,
): Promise<EnhanceResult | null> {
  const { provider, model, text } = opts;
  // Reasoning models ("thinking" models like DeepSeek reasoner / o1) take
  // longer to first token, so give a generous default window.
  const timeoutMs = opts.timeoutMs ?? 90000;
  // No default cap: on some endpoints the model's hidden "thinking" tokens
  // count against this budget, so any fixed cap can leave NO room for the
  // refined text (→ empty completion → null). Unset = the model's ceiling.
  const maxTokens = opts.maxTokens;
  const refinerInput = buildRefinerInput(
    text,
    opts.history,
    opts.contextSections,
    opts.previousRefinement,
    opts.retryFeedback,
  );

  const req: Request = {
    model,
    system: [{ type: 'text', text: ENHANCER_SYSTEM_PROMPT }],
    messages: [{ role: 'user', content: refinerInput }],
    maxTokens,
    // NOTE: deliberately NO `temperature`. The main agent loop never sets it,
    // and reasoning models (DeepSeek reasoner, o1/o3, …) return HTTP 400 when
    // `temperature` is present — which would make every refine call fail and
    // silently fall back to the original (no panel shown).
    //
    // A reasoning hint is forwarded ONLY when the caller supplies one (it must
    // already be gated to the model's advertised support — see
    // `gatedEnhancerReasoning`). Absent it, no reasoning field is sent, which
    // is identical to the original behavior.
    ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
  };

  const startedAt = Date.now();
  let passes = 0;
  let parseRejections = 0;
  // Observer exceptions must not escape the never-throws contract — a
  // throwing onOutcome would otherwise be re-reported as provider_error.
  const reportOutcome = (result: EnhanceOutcomeKind): void => {
    try {
      opts.onOutcome?.({
        result,
        passes,
        parseRejections,
        durationMs: Date.now() - startedAt,
      });
    } catch {
      // Swallowed by design: the observer is telemetry, not control flow.
    }
  };
  let timedOut = false;
  const runPass = async (
    input: string,
    pass: EnhancePassInfo,
  ): Promise<{ text: string; error?: string | undefined; usage?: Usage | undefined }> => {
    // Each model pass receives the full configured window. The parent signal
    // still cancels both passes immediately, while a slow first pass cannot
    // consume the corrective retry's entire timeout budget.
    passes = pass.pass;
    const timer = new AbortController();
    const timeout = setTimeout(() => timer.abort(new Error('enhancer timeout')), timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timer.signal]) : timer.signal;
    try {
      const out = await completeRefinerPass(input, {
        provider,
        oneShotOrchestrator: opts.oneShotOrchestrator,
        request: req,
        signal,
        timeoutMs,
      });
      // Orchestrator failures arrive as structured errors, not throws —
      // record whether OUR deadline fired before the finally masks the flag.
      if (out.error && timer.signal.aborted && !opts.signal?.aborted) timedOut = true;
      // A throwing cost-pipeline hook must not discard a completed response.
      if (out.usage) {
        try {
          opts.onUsage?.(out.usage, pass);
        } catch {
          // Swallowed by design: the observer is telemetry, not control flow.
        }
      }
      return out;
    } catch (error) {
      // A fired deadline wins the race against a same-tick caller cancel —
      // the pass WAS too slow, matching the mission-refiner classification.
      if (timer.signal.aborted) timedOut = true;
      throw error;
    } finally {
      timer.abort();
      clearTimeout(timeout);
    }
  };

  try {
    const first = await runPass(refinerInput, { pass: 1, kind: 'initial' });
    if (first.error) {
      // The orchestrator path never throws — OneShotOrchestrator.call returns
      // aborts as result.error — so classify caller cancellation HERE, not
      // only in the catch below, or it would surface as provider_error.
      if (timedOut) {
        // Our deadline fired while the orchestrator was running: the pass
        // WAS too slow, even though it reported back as a structured error.
        opts.onError?.(`timed out after ${Math.round(timeoutMs / 1000)}s`, 'timeout');
        reportOutcome('timeout');
        return null;
      }
      if (opts.signal?.aborted) {
        reportOutcome('cancelled');
        return null;
      }
      opts.onError?.(first.error, 'provider_error');
      reportOutcome('provider_error');
      return null;
    }
    const parsed = parseBilingualEnhancement(first.text, text);
    if (parsed) {
      reportOutcome('success');
      return parsed;
    }

    // The output contract is deliberately validated outside the model. Give a
    // malformed response one corrective pass, with the failure and exact wire
    // format made explicit, instead of silently treating non-English text as
    // the English option.
    parseRejections = 1;
    const correctionInput = [
      'Your previous response did not satisfy the required bilingual output contract.',
      'Return exactly two non-empty versions separated by one line containing only "---".',
      'The first version must match the language of the latest message. The second version must be English.',
      'Do not add labels, headings, fences, commentary, or additional separators.',
      '',
      `Latest message to refine:\n${text}`,
      '',
      `Invalid previous response:\n${compactText(first.text || '(empty response)', 1800)}`,
    ].join('\n');
    const corrected = await runPass(correctionInput, { pass: 2, kind: 'corrective' });
    if (corrected.error) {
      // Same orchestrator-path cancellation classification as above.
      if (timedOut) {
        opts.onError?.(`timed out after ${Math.round(timeoutMs / 1000)}s`, 'timeout');
        reportOutcome('timeout');
        return null;
      }
      if (opts.signal?.aborted) {
        reportOutcome('cancelled');
        return null;
      }
      opts.onError?.(corrected.error, 'provider_error');
      reportOutcome('provider_error');
      return null;
    }
    const correctedParsed = parseBilingualEnhancement(corrected.text, text);
    if (correctedParsed) {
      reportOutcome('success');
      return correctedParsed;
    }

    opts.onError?.('model returned malformed bilingual output after one corrective retry', 'empty');
    reportOutcome('empty');
    return null;
  } catch (err) {
    // A fired deadline wins the race against a same-tick caller cancel —
    // the pass WAS too slow, and cost attribution must see the timeout.
    if (timedOut) {
      opts.onError?.(`timed out after ${Math.round(timeoutMs / 1000)}s`, 'timeout');
      reportOutcome('timeout');
      return null;
    }
    // User-initiated cancel → stay silent (they chose to send the original).
    if (opts.signal?.aborted) {
      reportOutcome('cancelled');
      return null;
    }
    opts.onError?.(toErrorMessage(err), 'provider_error');
    reportOutcome('provider_error');
    return null;
  }
}

import type { ContentBlock } from '../types/blocks.js';
import { isTextBlock } from '../types/blocks.js';
import type { Message } from '../types/messages.js';
import type {
  Provider,
  ReasoningConfig,
  ReasoningEffort,
  ReasoningRequest,
  Request,
} from '../types/provider.js';
import { toErrorMessage } from '../utils/error.js';
import type { OneShotOrchestrator } from './one-shot-llm.js';
import { readBundledInstructionText } from '../utils/instruction-file.js';

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
  if (AFFIRMATION_RE.test(t)) return false; // "yes" / "continue" / ...
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

/** A single text-only conversation turn used as refiner context. */
export interface ConversationTurn {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * Result of a successful prompt refinement. Carries the original-language and
 * English versions so the UI can offer both. When the input was already in
 * English the refiner emits a single version and both fields hold the same
 * text (the UI then offers two identical choices, which is correct).
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
  /**
   * OneShotOrchestrator for the refiner LLM call. When set, uses it instead
   * of direct provider.complete(), gaining fallback chain support.
   */
  oneShotOrchestrator?: OneShotOrchestrator | undefined;
}

/**
 * Compose the single user message sent to the refiner: the recent
 * conversation embedded as plain text (so we never trip provider
 * role-alternation rules) followed by the latest message to refine.
 */
function buildRefinerInput(text: string, history?: ConversationTurn[]): string {
  if (!history || history.length === 0) return text;
  const lines = history.map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`);
  return [
    'Recent conversation (context only — do not act on it):',
    ...lines,
    '',
    'Latest message to refine:',
    text,
  ].join('\n');
}

/**
 * Refine a raw user prompt. Returns the refined text, or `null` when the
 * caller should fall back to the original (refiner errored, timed out, was
 * aborted, or returned nothing useful). NEVER throws — refinement is a
 * best-effort convenience and must never block the user from sending.
 */
export async function enhanceUserPrompt(
  opts: EnhanceUserPromptOptions,
): Promise<EnhanceResult | null> {
  const { provider, model, text } = opts;
  // Reasoning models ("thinking" models like DeepSeek reasoner / o1) take
  // longer to first token, so give a generous default window.
  const timeoutMs = opts.timeoutMs ?? 90000;
  // Generous default: on some endpoints the model's hidden "thinking" tokens
  // count against this budget, so a small cap can leave NO room for the actual
  // refined text (→ empty completion → null). 2048 keeps the output room ample.
  const maxTokens = opts.maxTokens ?? 2048;

  const req: Request = {
    model,
    system: [{ type: 'text', text: ENHANCER_SYSTEM_PROMPT }],
    messages: [{ role: 'user', content: buildRefinerInput(text, opts.history) }],
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

  // Link a local timeout to the parent signal so a stuck provider call can't
  // hang the submit path. AbortSignal.any keeps both cancellation sources.
  const timer = new AbortController();
  const to = setTimeout(() => timer.abort(new Error('enhancer timeout')), timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timer.signal]) : timer.signal;

  try {
    let raw: string;
    if (opts.oneShotOrchestrator) {
      const result = await opts.oneShotOrchestrator.call({
        system: ENHANCER_SYSTEM_PROMPT,
        messages: [
          { role: 'user', content: buildRefinerInput(text, opts.history) },
        ],
        maxTokens,
        timeoutMs,
        signal: opts.signal,
      });
      if (result.error) {
        opts.onError?.(result.error, 'provider_error');
        return null;
      }
      raw = result.text;
    } else {
      const res = await provider.complete(req, { signal });
      raw = res.content
        .filter(isTextBlock)
        .map((b) => b.text)
        .join('\n')
        .trim();
    }
    if (!raw) {
      opts.onError?.('model returned no text', 'empty');
      return null;
    }

    // English input → ONE version (no "---"); other languages → two versions
    // separated by a line with only "---". Split on the first occurrence so the
    // delimiter can still appear inside the second version's text.
    const sepIdx = raw.indexOf('\n---\n');
    if (sepIdx === -1) {
      // Single version: the input was already English (or the model chose not
      // to translate). Use it for both fields — the UI offers identical
      // "refined" / "english" options, which is correct and saves the model
      // from generating a redundant second copy. NOT an error.
      return { refined: raw, english: raw };
    }
    const refined = raw.slice(0, sepIdx).trim();
    const english = raw.slice(sepIdx + 5).trim(); // skip "\n---\n"
    if (!refined || !english) {
      opts.onError?.('one or both versions empty', 'empty');
      return null;
    }
    return { refined, english };
  } catch (err) {
    // User-initiated cancel → stay silent (they chose to send the original).
    if (opts.signal?.aborted) return null;
    if (timer.signal.aborted) {
      opts.onError?.(`timed out after ${Math.round(timeoutMs / 1000)}s`, 'timeout');
      return null;
    }
    opts.onError?.(toErrorMessage(err), 'provider_error');
    return null;
  } finally {
    // Idempotent — abort() after signal already fired is a no-op, so this is
    // always safe regardless of whether the timeout fired first.
    timer.abort();
    clearTimeout(to);
  }
}

/** Pull the visible text out of a message's content (ignores tool blocks). */
function messageText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter(isTextBlock)
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/**
 * Extract the last few user/assistant TEXT turns from a conversation, newest
 * last, for use as refiner context. Skips system messages and tool-only turns
 * (tool_use / tool_result carry no useful natural-language context and bloat
 * the call). Each turn is truncated to `maxChars`; at most `maxTurns` are
 * returned. Pure + exported for unit testing.
 */
export function recentTextTurns(
  messages: Message[],
  maxTurns = 6,
  maxChars = 1500,
): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (let i = messages.length - 1; i >= 0 && turns.length < maxTurns; i--) {
    const m = messages[i];
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const text = messageText(m.content);
    if (!text) continue;
    turns.unshift({
      role: m.role,
      text: text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text,
    });
  }
  return turns;
}

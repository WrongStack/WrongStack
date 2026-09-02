import type { Message } from '../types/messages.js';
import { compactToolDefinitionForWire } from './tool-wire-compact.js';

/**
 * Shared token estimation with JSON.stringify caching.
 * Avoids repeated stringification of tool input objects.
 *
 * ## Calibration
 *
 * `estimateRequestTokens` uses a fixed 3.5 chars/token heuristic — a
 * conservative overestimate that prevents underestimation but reduces
 * accuracy. After each API call, call `recordActualUsage()` with the
 * provider-authoritative effective prompt tokens (`input + cacheRead +
 * cacheWrite` after adapter normalization). The module maintains a rolling
 * average of `actual / estimated` ratio (EWM, α=0.3) and applies it to
 * subsequent calls via `estimateRequestTokensCalibrated`.
 *
 * Calibration is per-module (shared across all callers), which is
 * sufficient: the chars/token ratio is a property of the tokenizer,
 * not the model. Uncalibrated calls (before any samples, or when
 * `recordActualUsage` is not called) fall back to the uncalibrated
 * estimate so nothing breaks.
 */

const RoughTokenEstimate = (text: string, charsPerToken = 3.5): number =>
  Math.max(1, Math.ceil(text.length / charsPerToken));

/** Calibration state: actual/estimated ratio via exponential weighted moving average. */
interface CalState {
  ratio: number; // current calibration multiplier (actual / estimated)
  count: number; // number of samples recorded
  prevEst: number; // estimated tokens from the most recent estimateRequestTokens call
}

/** EWM α — higher = faster adaptation, more volatile. */
const CAL_ALPHA = 0.3;

/**
 * Calibration is keyed so that, in a multi-agent / model-switching process,
 * each (provider, model) tokenizer gets its own ratio instead of all of them
 * collapsing onto one shared number. Callers that don't pass a key use the
 * shared `__global__` bucket — that preserves the original single-session
 * behavior and keeps all existing call sites working unchanged.
 */
const CALIBRATION_GLOBAL_KEY = '__global__';
const _cals = new Map<string, CalState>();

function calState(key: string): CalState {
  let state = _cals.get(key);
  if (!state) {
    state = { ratio: 1.0, count: 0, prevEst: 0 };
    _cals.set(key, state);
  }
  return state;
}

const MIN_SAMPLES_FOR_CALIBRATION = 3;

/**
 * Fallback chars/token ratios per model family for providers that don't return
 * usage data. Used when `recordActualUsage` receives zero/negative tokens and
 * we have enough samples to trust the fallback. Keys are lowercase prefixes.
 */
const MODEL_FAMILY_RATIO: Record<string, number> = {
  // Anthropic: ~3.8-4.0 chars/token depending on model
  claude: 3.8,
  // OpenAI: ~4.0 chars/token
  'gpt-4': 4.0,
  'gpt-3.5': 4.0,
  // Google: ~3.5 chars/token
  gemini: 3.5,
  // DeepSeek: ~3.5 chars/token
  deepseek: 3.5,
};

/**
 * Per-payload memo for tool_use inputs and tool_result contents, keyed by the
 * payload OBJECT rather than by anything derived from its bytes.
 *
 * The previous shape keyed a bounded Map by `"<len>:<djb2>"` of the stringified
 * payload. That never paid off: `JSON.stringify` ran BEFORE the cache was
 * consulted, and the DJB2 key cost a second full pass over the same string —
 * two O(payload) walks to memoize `length / 3.5`, which is one division. Hit or
 * miss, the cache was slower than no cache. Measured over 200 passes across 300
 * ~2KB tool inputs (what a session's repeated context-pressure checks and
 * `getContextBreakdown` re-runs actually look like): 199ms with the hash Map
 * versus 1.9ms here.
 *
 * A WeakMap fixes all three problems at once. Repeat lookups on a history block
 * are O(1) with no serialization at all; entries die with the message instead of
 * living in a 50 000-entry Map; and there is no hash to collide, so an estimate
 * can no longer come back wrong because two unrelated payloads shared a length
 * and a 32-bit digest.
 *
 * Distinct objects holding identical content each pay one `JSON.stringify` —
 * exactly what a cache miss cost before.
 */
const PAYLOAD_TOKEN_MEMO = new WeakMap<object, number>();

function memoizedPayloadTokens(payload: object): number {
  const cached = PAYLOAD_TOKEN_MEMO.get(payload);
  if (cached !== undefined) return cached;
  let str: string;
  try {
    str = JSON.stringify(payload) ?? '';
  } catch {
    str = String(payload);
  }
  const estimate = RoughTokenEstimate(str);
  PAYLOAD_TOKEN_MEMO.set(payload, estimate);
  return estimate;
}

/**
 * Estimate tokens for a tool_use block input.
 *
 * Memoized on the input object, so the repeated context-window checks and
 * breakdown re-runs that walk the same history serialize each payload once.
 */
export function estimateToolInputTokens(input: unknown): number {
  if (typeof input === 'string') return RoughTokenEstimate(input);
  if (input === null || typeof input !== 'object') {
    return RoughTokenEstimate(String(input));
  }
  return memoizedPayloadTokens(input);
}

/**
 * Estimate tokens for a tool_result content.
 *
 * Same memo as {@link estimateToolInputTokens}; non-object contents (null,
 * numbers) are cheap enough to stringify outright and cannot key a WeakMap.
 */
export function estimateToolResultTokens(content: string | unknown): number {
  if (typeof content === 'string') return RoughTokenEstimate(content);
  if (content === null || typeof content !== 'object') {
    return RoughTokenEstimate(String(content));
  }
  return memoizedPayloadTokens(content);
}

/**
 * Estimate tokens for a text block.
 */
export function estimateTextTokens(text: string): number {
  return RoughTokenEstimate(text);
}

/**
 * Compute and cache the token estimate for a single message. This is the
 * canonical per-message estimator — called once by ConversationState on
 * append/replace so the O(n·m) content-block walk happens at mutation time,
 * not on every context-pressure check.
 */
export function computeMessageTokens(msg: Message): number {
  if (typeof msg.content === 'string') return estimateTextTokens(msg.content);
  let total = 0;
  for (const b of msg.content) {
    if (b.type === 'text') total += estimateTextTokens(b.text ?? '');
    else if (b.type === 'tool_use') total += estimateToolInputTokens(b.input);
    else if (b.type === 'tool_result') total += estimateToolResultTokens(b.content);
    else {
      let str: string;
      try {
        str = JSON.stringify(b) ?? '';
      } catch {
        str = String(b);
      }
      total += RoughTokenEstimate(str);
    }
  }
  return total;
}

/**
 * Estimate tokens for an array of messages (text + tool I/O), using the shared
 * 3.5 chars/token basis. This is the single canonical message-array estimator —
 * compactors, the context_manager tool, and the `/context` display all route
 * through it so the number a user sees matches the number compaction decides on.
 *
 * When a message carries a pre-computed `_estTokens` field (set by
 * ConversationState on append/replace), it is used directly instead of
 * re-walking the content blocks — turning the O(n·m) scan into an O(n)
 * sum for fully-cached arrays.
 */
export function estimateMessageTokens(messages: readonly Message[]): number {
  let total = 0;
  for (const m of messages) {
    if (typeof m._estTokens === 'number' && m._estTokens > 0) {
      total += m._estTokens;
      continue;
    }
    total += computeMessageTokens(m);
  }
  return total;
}

/**
 * Real-usage-anchored input-token count. Given the provider's authoritative
 * prompt-token count from the last response (`anchorTokens`, a REAL number) and
 * the `messages.length` of the request that produced it (`anchorMsgCount`),
 * returns `anchorTokens + estimate(messages appended since)` — so everything up
 * to the last turn is exact and only the newest, not-yet-sent messages are
 * estimated. This is deliberately NOT calibrated: the base is already real, and
 * on the next response the whole thing re-anchors to the new real count.
 *
 * Returns `null` when there is no usable anchor (no response yet, or the
 * message array shrank below the anchor — e.g. after compaction — in which case
 * the caller falls back to a full estimate until the next response re-anchors).
 */
export function realAnchoredInputTokens(
  messages: readonly Message[],
  anchorTokens: number | undefined,
  anchorMsgCount: number | undefined,
): number | null {
  if (typeof anchorTokens !== 'number' || anchorTokens <= 0) return null;
  if (typeof anchorMsgCount !== 'number' || anchorMsgCount < 0) return null;
  if (messages.length < anchorMsgCount) return null;
  const delta =
    anchorMsgCount === messages.length ? 0 : estimateMessageTokens(messages.slice(anchorMsgCount));
  return anchorTokens + delta;
}

/**
 * Rough estimate of tokens in a tool definition (name + description + schema).
 * Accounts for the JSON-serialized inputSchema which is sent to the API
 * but NOT included in roughEstimate(content).
 */
export function estimateToolDefTokens(tool: {
  name: string;
  description?: string | undefined;
  inputSchema: unknown;
}): number {
  // Fast path: pre-computed by ToolRegistry at registration time.
  const cached = (tool as { _estDefTokens?: number | undefined })._estDefTokens;
  if (typeof cached === 'number' && cached > 0) return cached;

  const compact = compactToolDefinitionForWire(tool);
  return (
    RoughTokenEstimate(tool.name) +
    RoughTokenEstimate(compact.description) +
    RoughTokenEstimate(JSON.stringify(compact.inputSchema))
  );
}

/**
 * Estimate the total API request token count: system prompt + tool definitions
 * + conversation messages. Use this for context-window bar calculations
 * instead of roughEstimate (which only counts messages).
 *
 * The overhead ratio (overhead / messages) varies by conversation length:
 *   - Short conversations (< 10 messages): ~30-50% overhead (large system+tools)
 *   - Medium (10-50 messages): ~15-30%
 *   - Long (> 50 messages): ~5-15%
 *
 * Returns { messages, systemPrompt, tools, total } for debugging display.
 */
export interface RequestTokenBreakdown {
  messages: number;
  systemPrompt: number;
  tools: number;
  total: number;
}

export function estimateRequestTokens(
  messages: unknown,
  systemPrompt: unknown,
  tools: { name: string; description?: string | undefined; inputSchema: unknown }[],
  calibrationKey: string = CALIBRATION_GLOBAL_KEY,
): RequestTokenBreakdown {
  // Messages: apply the same logic as roughEstimate
  let messagesTokens = 0;
  if (typeof messages === 'string') {
    messagesTokens = RoughTokenEstimate(messages);
  } else if (Array.isArray(messages)) {
    for (const m of messages) {
      if (typeof m === 'object' && m !== null && 'content' in m) {
        // Fast path: pre-computed per-message token estimate (set by
        // ConversationState on append/replace). Skips the O(m) content-block
        // walk entirely for cached messages.
        const cached = (m as { _estTokens?: number | undefined })._estTokens;
        if (typeof cached === 'number' && cached > 0) {
          messagesTokens += cached;
          continue;
        }
        const content = (m as { content: unknown }).content;
        if (typeof content === 'string') {
          messagesTokens += RoughTokenEstimate(content);
        } else if (Array.isArray(content)) {
          for (const b of content) {
            if (typeof b === 'object' && b !== null) {
              if ((b as { type?: string | undefined }).type === 'text') {
                messagesTokens += RoughTokenEstimate((b as { text: string }).text ?? '');
              } else {
                messagesTokens += RoughTokenEstimate(JSON.stringify(b));
              }
            }
          }
        }
      }
    }
  }

  // System prompt
  let systemTokens = 0;
  if (typeof systemPrompt === 'string') {
    systemTokens = RoughTokenEstimate(systemPrompt);
  } else if (Array.isArray(systemPrompt)) {
    for (const b of systemPrompt) {
      if (
        typeof b === 'object' &&
        b !== null &&
        (b as { type?: string | undefined }).type === 'text'
      ) {
        systemTokens += RoughTokenEstimate((b as { text: string }).text);
      }
    }
  }

  // Tool definitions
  let toolsTokens = 0;
  for (const t of tools) {
    toolsTokens += estimateToolDefTokens(t);
  }

  const total = messagesTokens + systemTokens + toolsTokens;

  // Record the raw estimate for calibration: the next recordActualUsage()
  // call will pair this against the actual API usage so the rolling ratio
  // stays in sync with the real chars/token ratio of the content.
  calState(calibrationKey).prevEst = total;

  return {
    messages: messagesTokens,
    systemPrompt: systemTokens,
    tools: toolsTokens,
    total,
  };
}

/**
 * Record the actual API input token count after a provider call so
 * `estimateRequestTokensCalibrated` can self-correct on subsequent calls.
 *
 * Prefer passing `estimatedInputTokens` explicitly (the calibrated pre-flight
 * estimate from the middleware) — this avoids race conditions when other code
 * also calls `estimateRequestTokens` between the pre-flight and this call
 * (e.g. audit logging in agent.ts).
 *
 * When `estimatedInputTokens` is omitted, falls back to the keyed bucket's
 * `prevEst` for backward compatibility with callers that don't have the
 * pre-flight value. `calibrationKey` selects the per-(provider,model) bucket
 * (defaults to the shared global bucket).
 */
export function recordActualUsage(
  actualInputTokens: number,
  estimatedInputTokens?: number,
  calibrationKey: string = CALIBRATION_GLOBAL_KEY,
): void {
  if (actualInputTokens <= 0) return;
  const cal = calState(calibrationKey);
  const est = estimatedInputTokens ?? cal.prevEst;
  if (est <= 0) return;

  const sampleRatio = actualInputTokens / est;
  if (cal.count === 0) {
    cal.ratio = sampleRatio;
  } else {
    // EWM: new = α * sample + (1-α) * old  →  α=0.3 = fast initial converge
    cal.ratio = CAL_ALPHA * sampleRatio + (1 - CAL_ALPHA) * cal.ratio;
  }
  // Sanity bound: keep the rolling ratio within [0.5, 1.5] so a sequence
  // of bad samples can't blow up the calibration for everyone.
  cal.ratio = Math.min(1.5, Math.max(0.5, cal.ratio));
  cal.count++;
}

/**
 * Returns the current calibration state for a bucket. Exposed for debugging
 * and tests — not needed by normal callers.
 */
export function getCalibrationState(calibrationKey: string = CALIBRATION_GLOBAL_KEY): {
  ratio: number;
  count: number;
  calibrated: boolean;
} {
  const cal = calState(calibrationKey);
  return {
    ratio: cal.ratio,
    count: cal.count,
    calibrated: cal.count >= MIN_SAMPLES_FOR_CALIBRATION,
  };
}

/**
 * Like `estimateRequestTokens` but applies the rolling calibration factor
 * so context pressure readings converge on reality within a few iterations.
 *
 * Before any `recordActualUsage` samples are collected, returns the same
 * result as `estimateRequestTokens` (ratio = 1.0, no distortion).
 * After `MIN_SAMPLES_FOR_CALIBRATION` samples, applies the calibrated
 * multiplier capped to the range [0.5, 1.5] as a sanity bound.
 */
export function estimateRequestTokensCalibrated(
  messages: unknown,
  systemPrompt: unknown,
  tools: { name: string; description?: string | undefined; inputSchema: unknown }[],
  calibrationKey: string = CALIBRATION_GLOBAL_KEY,
): RequestTokenBreakdown {
  const result = estimateRequestTokens(messages, systemPrompt, tools, calibrationKey);
  const cal = calState(calibrationKey);

  if (cal.count >= MIN_SAMPLES_FOR_CALIBRATION) {
    const safeRatio = Math.min(1.5, Math.max(0.5, cal.ratio));
    return {
      messages: Math.round(result.messages * safeRatio),
      systemPrompt: Math.round(result.systemPrompt * safeRatio),
      tools: Math.round(result.tools * safeRatio),
      total: Math.round(result.total * safeRatio),
    };
  }

  // No calibration samples yet — fall back to model-family ratio if available,
  // otherwise use the uncalibrated estimate (ratio = 1.0).
  const fallbackRatio = getModelFamilyRatio(calibrationKey);
  if (fallbackRatio !== null) {
    return {
      messages: Math.round(result.messages * fallbackRatio),
      systemPrompt: Math.round(result.systemPrompt * fallbackRatio),
      tools: Math.round(result.tools * fallbackRatio),
      total: Math.round(result.total * fallbackRatio),
    };
  }

  return result;
}

/** Per-block sample cap for the density scan — bounds work on giant blocks. */
const DENSITY_SAMPLE_PER_BLOCK = 4_096;
/** Hard cap on total sampled chars so the density scan stays cheap. */
const DENSITY_SAMPLE_TOTAL_CAP = 2_000_000;

/**
 * Estimate a **token-density multiplier** for content that the flat 3.5
 * chars/token basis under-counts. The basis is tuned for ASCII English
 * (~4 chars/token); CJK, and other high-codepoint scripts tokenize at ~1.5-2
 * chars/token, so a message that is mostly CJK carries up to ~2.3× the tokens
 * the flat basis predicts. Long unbroken ASCII runs (base64, minified blobs)
 * pack slightly denser too. This scans a bounded sample and returns a
 * multiplier in [1, 2.5] — always ≥ 1, so it can only push the estimate UP,
 * never down. Used only by the send-time overflow guard, never for display.
 */
function textDensityMultiplier(messages: readonly Message[]): number {
  let sampled = 0;
  let nonAscii = 0;
  let maxRun = 0;
  const consider = (s: string): void => {
    const n = Math.min(s.length, DENSITY_SAMPLE_PER_BLOCK);
    let run = 0;
    for (let i = 0; i < n; i++) {
      const c = s.charCodeAt(i);
      if (c > 127) nonAscii++;
      if (c === 32 || c === 9 || c === 10 || c === 13) {
        if (run > maxRun) maxRun = run;
        run = 0;
      } else {
        run++;
      }
    }
    if (run > maxRun) maxRun = run;
    sampled += n;
  };

  for (const m of messages) {
    if (typeof m.content === 'string') {
      consider(m.content);
    } else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === 'text') consider(b.text ?? '');
        else if (b.type === 'tool_result' && typeof b.content === 'string') consider(b.content);
        else if (b.type === 'thinking') consider(b.thinking);
      }
    }
    if (sampled >= DENSITY_SAMPLE_TOTAL_CAP) break;
  }

  if (sampled === 0) return 1;
  const nonAsciiRatio = nonAscii / sampled;
  // 3.5 chars/token at 0% non-ASCII → 1.5 at 100% (heavy CJK).
  let charsPerToken = 3.5 - 2.0 * nonAsciiRatio;
  // A very long unbroken ASCII run (base64/minified) packs a little denser.
  if (maxRun > 2_000 && nonAsciiRatio < 0.1) charsPerToken = Math.min(charsPerToken, 3.0);
  const multiplier = 3.5 / Math.max(1.4, charsPerToken);
  return Math.min(2.5, Math.max(1, multiplier));
}

/**
 * Never-undercount upper bound for the request token total, for the **send
 * guard** only. Takes the flat estimate and scales it up by the greater of the
 * content-density multiplier and the calibration ceiling, so the guarded value
 * satisfies `real ≤ upperBound`. The context bar and `/context` keep using the
 * calibrated estimate — this deliberately over-counts, which is only ever safe
 * for the "must this be trimmed before sending?" decision.
 */
export function estimateRequestTokensUpperBound(
  messages: unknown,
  systemPrompt: unknown,
  tools: { name: string; description?: string | undefined; inputSchema: unknown }[],
  calibrationKey: string = CALIBRATION_GLOBAL_KEY,
): RequestTokenBreakdown {
  const base = estimateRequestTokens(messages, systemPrompt, tools, calibrationKey);
  const density = Array.isArray(messages)
    ? textDensityMultiplier(messages as readonly Message[])
    : 1;
  const cal = calState(calibrationKey);
  const calCeiling =
    cal.count >= MIN_SAMPLES_FOR_CALIBRATION ? Math.min(1.5, Math.max(1, cal.ratio)) : 1;
  const mult = Math.max(density, calCeiling);
  if (mult <= 1) return base;
  return {
    messages: Math.ceil(base.messages * mult),
    systemPrompt: Math.ceil(base.systemPrompt * mult),
    tools: Math.ceil(base.tools * mult),
    total: Math.ceil(base.total * mult),
  };
}

/** Look up the fallback chars/token ratio for a calibration key (e.g. "provider/model"). */
function getModelFamilyRatio(calibrationKey: string): number | null {
  const lower = calibrationKey.toLowerCase();
  for (const [family, ratio] of Object.entries(MODEL_FAMILY_RATIO)) {
    if (lower.includes(family)) return ratio / 3.5; // MODEL_FAMILY_RATIO is chars/token, we need multiplier
  }
  return null;
}

/**
 * Resets calibration state. Primarily for tests that run in the same
 * process and need a clean slate between suites. With no argument it clears
 * every bucket (including the global one); pass a key to reset just that bucket.
 */
export function resetCalibration(calibrationKey?: string): void {
  if (calibrationKey === undefined) {
    _cals.clear();
    return;
  }
  _cals.delete(calibrationKey);
}

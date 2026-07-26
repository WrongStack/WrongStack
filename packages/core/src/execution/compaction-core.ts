import type { ContentBlock, ToolResultBlock, ToolUseBlock } from '../types/blocks.js';
import { isTextBlock } from '../types/blocks.js';
import type { Message } from '../types/messages.js';
import type { Logger } from '../types/logger.js';
import { repairToolUseAdjacency } from '../utils/message-invariants.js';
import {
  computeMessageTokens,
  estimateMessageTokens,
  estimateTextTokens,
  estimateToolInputTokens,
  estimateToolResultTokens,
} from '../utils/token-estimate.js';
export {
  buildSmartDigest,
  extractText,
  hasLargeToolResult,
  hasToolUse,
  scoreMessage,
  type ContentScore,
} from './compaction-scoring.js';

// Path hint extraction — used inside firstErrorLine path summaries.
const PATH_HINT_PATTERN = /(?:(?:[A-Za-z]:)?[./\\]?[\w@.-]+(?:[\\/][\w@(). -]+)+\.[A-Za-z0-9]{1,12})/g;
const PATH_BACKSLASH_PATTERN = /\\/g;
const PATH_TRIM_PATTERN = /^["'`]+|["'`),;:]+$/g;

// Error line detection — first non-blank line whose text matches the
// set of words that indicate something went wrong.
const ERROR_LINE_PATTERN = /\b(error|exception|failed|failure|fatal|panic|timeout|denied|enoent|eacces|eperm)\b/i;
const NEWLINE_SPLIT_PATTERN = /\r?\n/;
const WHITESPACE_COLLAPSE_PATTERN = /\s+/g;

/**
 * Instrumentation state for compaction hot-path analysis.
 * Tracks actual vs. nominal iteration counts to detect O(n·m) blowup.
 *
 * Logged as structured events so they can be aggregated from session JSONL
 * and plotted per-message-count to catch regressions before they ship.
 */
interface CompactionMetrics {
  /** Total messages in the compaction pass. */
  messageCount: number;
  /** Index where the preserved window starts (from findPreserveStart). */
  preserveStart: number;
  /** Outer-loop iterations in the elision fast-path scan. */
  fastPathIterations: number;
  /**
   * Inner-loop block iterations in the fast-path scan.
   * Ratio fastPathInner / fastPathIterations indicates avg blocks per message.
   */
  fastPathInnerIterations: number;
  /**
   * Outer-loop iterations in the full elision pass.
   * A targeted pass starts at the first oversized old tool block and stops at
   * the preserve boundary, so this should stay well below messageCount when
   * the fast-path hit is late in the old window.
   */
  fullPassIterations: number;
  /**
   * Inner-loop block iterations in the full elision pass.
   * Ratio fullPassInner / fullPassIterations indicates avg blocks per message.
   */
  fullPassInnerIterations: number;
  /** Estimated tokens saved by the elision pass. */
  tokensSaved: number;
  /** Whether the full elision pass made any changes. */
  changed: boolean;
}

/**
 * Whether compaction instrumentation should be emitted to stdout.
 * Gated behind WRONGSTACK_DEBUG=1 or NODE_ENV=development so the hot path
 * does not pay for JSON.stringify + console.log on every compaction pass
 * in production. Matches the guard at the ratio-guard site (line ~281).
 */
function compactionDebugEnabled(): boolean {
  return process.env['NODE_ENV'] === 'development' || process.env['WRONGSTACK_DEBUG'] === '1';
}

/**
 * Module-level debug logger for compaction instrumentation. Set by
 * compactor classes that have a Logger instance; falls back to
 * console.log/error when unset (preserves existing debug output).
 */
let _debugLogger: Logger | undefined;

/** Set the module-level compaction debug logger (called by compactor constructors). */
export function setCompactionDebugLogger(logger: Logger | undefined): void {
  _debugLogger = logger;
}

/** Emit compaction instrumentation as a structured log event (debug-only). */
function emitCompactionMetrics(event: string, metrics: CompactionMetrics): void {
  if (!compactionDebugEnabled()) return;
  const ctx = {
    event,
    messageCount: metrics.messageCount,
    preserveStart: metrics.preserveStart,
    fastPathIterations: metrics.fastPathIterations,
    fastPathInnerIterations: metrics.fastPathInnerIterations,
    fastPathInnerPerOuter:
      metrics.fastPathIterations > 0
        ? metrics.fastPathInnerIterations / metrics.fastPathIterations
        : 0,
    fullPassIterations: metrics.fullPassIterations,
    fullPassInnerIterations: metrics.fullPassInnerIterations,
    fullPassInnerPerOuter:
      metrics.fullPassIterations > 0
        ? metrics.fullPassInnerIterations / metrics.fullPassIterations
        : 0,
    tokensSaved: metrics.tokensSaved,
    changed: metrics.changed,
  };
  if (_debugLogger) {
    _debugLogger.debug(`compaction: ${event}`, ctx);
  } else {
    console.log(JSON.stringify({ level: 'debug', ...ctx }));
  }
}

/**
 * Token estimate for a message array (text + tool I/O). Re-exported from the
 * canonical `token-estimate` helper so compactors and the context-pressure
 * monitor share one number.
 */
export const estimateMessages = estimateMessageTokens;

// `buildCompactionPreview` (with its `safePreviewString`/`truncatePreview`
// helpers) moved to `../utils/compaction-preview.js` — a neutral layer both the
// execution compactors and the models-layer LLMSelector can import without the
// models→execution runtime cycle the boundary test forbids. The shared
// `extractPathHints`/`firstErrorLine` helpers stay here (they are also used by
// the elision summariser below).

/**
 * Shared, pure compaction primitives.
 *
 * Before this module the three compactors (`HybridCompactor`,
 * `IntelligentCompactor`, `SelectiveCompactor`) each carried their own copies
 * of message-token estimation, tool-result elision, text detection and digest
 * rendering — with subtle divergences (notably Selective lacked the
 * tool_use/tool_result pair preservation, so it could elide the result of a
 * tool call it was supposed to keep). These helpers are the single source of
 * truth. They operate on plain `Message[]` and never touch `Context`/state, so
 * each compactor keeps its own `ctx.state.replaceMessages(...)` plumbing.
 */

/** Does this message carry any non-empty text? */
export function hasTextContent(m: Message): boolean {
  if (typeof m.content === 'string') return m.content.trim().length > 0;
  return m.content.some((b) => b.type === 'text' && b.text.trim().length > 0);
}

/**
 * Index where the preserved (recent) window starts. Walks back counting
 * user/assistant messages until `preserveK` are covered, then walks forward to
 * keep any tool_use/tool_result protocol pair intact — so a tool_result whose
 * tool_use is preserved is never elided.
 *
 * Instrumentation: emits `compaction.find_preserve_start.ended` with the
 * repair-loop block count so we can track whether protocol-pair repair is
 * scanning too much content.
 */
export function findPreserveStart(messages: readonly Message[], preserveK: number): number {
  let pairCount = 0;
  let preserveStart = messages.length;
  for (let i = messages.length - 1; i >= 0 && pairCount < preserveK; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === 'user' || m.role === 'assistant') {
      pairCount++;
      preserveStart = i;
    }
  }

  // If the preserved window starts on a user tool_result, widen backward to
  // include the immediately preceding assistant tool_use. This keeps provider
  // protocol adjacency intact and avoids orphaned results after compaction.
  let pairRepairIterations = 0;
  let pairRepairInnerIterations = 0;
  while (preserveStart > 0) {
    pairRepairIterations++;
    const first = messages[preserveStart];
    const prev = messages[preserveStart - 1];
    if (!first || !prev || first.role !== 'user' || prev.role !== 'assistant') break;
    if (typeof first.content === 'string' || typeof prev.content === 'string') break;
    const pairCheck = hasMatchingToolPair(first.content, prev.content);
    pairRepairInnerIterations += pairCheck.iterations;
    if (!pairCheck.matched) break;
    preserveStart--;
  }

  if (compactionDebugEnabled()) {
    const ctx = {
      event: 'compaction.find_preserve_start.ended',
      messageCount: messages.length,
      preserveK,
      preserveStart,
      pairRepairIterations,
      pairRepairInnerIterations,
      pairRepairInnerPerOuter:
        pairRepairIterations > 0 ? pairRepairInnerIterations / pairRepairIterations : 0,
    };
    if (_debugLogger) {
      _debugLogger.debug('compaction: find_preserve_start.ended', ctx);
    } else {
      console.log(JSON.stringify({ level: 'debug', ...ctx }));
    }
  }

  return preserveStart;
}

function hasMatchingToolPair(
  resultContent: readonly ContentBlock[],
  useContent: readonly ContentBlock[],
): { matched: boolean; iterations: number } {
  let iterations = 0;
  let firstResultId: string | undefined;
  let resultIds: Set<string> | undefined;

  for (const block of resultContent) {
    iterations++;
    if (block.type !== 'tool_result') continue;
    if (firstResultId === undefined) {
      firstResultId = block.tool_use_id;
    } else {
      resultIds ??= new Set([firstResultId]);
      resultIds.add(block.tool_use_id);
    }
  }
  if (firstResultId === undefined) return { matched: false, iterations };

  for (const block of useContent) {
    iterations++;
    if (block.type !== 'tool_use') continue;
    if (resultIds ? resultIds.has(block.id) : block.id === firstResultId) {
      return { matched: true, iterations };
    }
  }

  return { matched: false, iterations };
}

export interface EliseResult {
  /** New message array, or the same reference when nothing changed. */
  messages: Message[];
  /** Estimated tokens reclaimed. */
  saved: number;
  changed: boolean;
}

/**
 * Elide oversized tool I/O that falls before the preserve window. Pure:
 * returns a fresh array (or the same reference when unchanged). Replaces the
 * duplicate copies that lived in all three compactors.
 */
export function eliseOldToolResults(
  messages: readonly Message[],
  opts: { preserveK: number; eliseThreshold: number },
): EliseResult {
  const preserveStart = findPreserveStart(messages, opts.preserveK);

  // ── Per-block token-estimate cache ───────────────────────────────────────
  //
  // Both the fast-path probe and the full pass call estimateToolResultTokens /
  // estimateToolInputTokens on the same block. On oversized-tool-result
  // sessions (thousands of 7 KB+ results) the redundant re-estimate is the
  // single biggest cost — profiling showed ~11 ms/msg dominated by the
  // estimator running twice per oversized block. The cache is keyed by the
  // block object itself (stable within one call), scoped to this invocation,
  // and free of GC risk: it dies with the closure. A plain Map is used rather
  // than WeakMap because ToolUseBlock/ToolResultBlock are plain object literals
  // (no identity stability guarantee across callers, but stable within one
  // pass — which is all we need).
  const tokenCache = new Map<ContentBlock, number>();
  const tokensFor = (b: ContentBlock): number => {
    const cached = tokenCache.get(b);
    if (cached !== undefined) return cached;
    const t =
      b.type === 'tool_result'
        ? estimateToolResultTokens(b.content)
        : b.type === 'tool_use'
          ? estimateToolInputTokens(b.input)
          : 0;
    tokenCache.set(b, t);
    return t;
  };

  // ── Fast path: probe for oversized tool I/O ─────────────────────────────
  //
  // Instruments the ratio of actual iterations to message count so we can
  // detect whether the inner block-scan loop is O(n·m) as expected or has
  // regressed to quadratic behaviour.
  let hasOversized = false;
  let firstOversizedIndex = -1;
  let fastPathIterations = 0;
  let fastPathInnerIterations = 0;
  for (let i = 0; i < preserveStart && !hasOversized; i++) {
    fastPathIterations++;
    const msg = messages[i];
    if (!msg || !Array.isArray(msg.content)) continue;
    for (const b of msg.content) {
      fastPathInnerIterations++;
      const oversized = tokensFor(b) >= opts.eliseThreshold;
      if (oversized) {
        hasOversized = true;
        firstOversizedIndex = i;
        break;
      }
    }
  }

  // ── Emit fast-path metrics (covers both fast-path hit and the early-exit) ──
  emitCompactionMetrics(
    hasOversized
      ? 'compaction.elision.fast_path.oversized_found'
      : 'compaction.elision.fast_path.no_oversized',
    {
      messageCount: messages.length,
      preserveStart,
      fastPathIterations,
      fastPathInnerIterations,
      fullPassIterations: 0,
      fullPassInnerIterations: 0,
      tokensSaved: 0,
      changed: false,
    },
  );

  if (!hasOversized) return { messages: messages as Message[], saved: 0, changed: false };

  // ── Targeted elision pass ────────────────────────────────────────────────
  //
  // The fast path already proved that every message before firstOversizedIndex
  // is below threshold, and preserveStart caps the old window. Only scan that
  // narrowed range, and only clone the message array/content array when an
  // actual replacement is made.
  let saved = 0;
  let changed = false;
  let fullPassIterations = 0;
  let fullPassInnerIterations = 0;
  let next: Message[] | undefined;
  for (let i = firstOversizedIndex; i < preserveStart; i++) {
    fullPassIterations++;
    const msg = messages[i];
    if (!msg || !Array.isArray(msg.content)) continue;
    const original = msg.content;
    let newContent: ContentBlock[] | undefined;
    for (let idx = 0; idx < original.length; idx++) {
      fullPassInnerIterations++;
      const b = original[idx];
      if (!b) continue;
      if (b.type === 'tool_use') {
        const tokens = tokensFor(b);
        if (tokens < opts.eliseThreshold) continue;
        const elidedInput = summarizeToolUseInputElision(b, tokens);
        saved += Math.max(0, tokens - estimateToolInputTokens(elidedInput));
        newContent ??= original.slice();
        newContent[idx] = { ...b, input: elidedInput };
        continue;
      }

      if (b.type !== 'tool_result') continue;
      const tokens = tokensFor(b);
      if (tokens < opts.eliseThreshold) continue;
      saved += tokens;
      const elided: ToolResultBlock = {
        type: 'tool_result',
        tool_use_id: b.tool_use_id,
        content: summarizeToolResultElision(b, tokens),
        is_error: b.is_error,
      };
      newContent ??= original.slice();
      newContent[idx] = elided;
    }
    if (newContent) {
      next ??= messages.slice() as Message[];
      // Clear the cached token estimate — content was replaced with
      // shorter elision markers but the spread preserves the original
      // `_estTokens` (set by ConversationState.appendMessage). Without
      // this, token estimates report the pre-elision size, making
      // compaction appear ineffective and risking false
      // AGENT_CONTEXT_OVERFLOW.
      next[i] = { ...msg, content: newContent, _estTokens: undefined };
      changed = true;
    }

    // ── Ratio guard: defensive assertion + conditional early-break ─────────
    //
    // Defensive assertion (threshold 10): fires in dev/debug if the inner loop
    // is running more than 10x what we'd expect per message. This catches
    // pathological regressions where a single message has hundreds of blocks.
    if (compactionDebugEnabled()) {
      const ratio = fullPassInnerIterations / fullPassIterations;

      if (ratio > 10) {
        // Defensive assertion: never expected in practice
        const ctx = {
          event: 'compaction.elision.regression',
          message: `fullPassInnerPerOuter=${ratio.toFixed(2)} exceeds threshold 10 — possible O(n·m) regression`,
          messageCount: messages.length,
          fullPassIterations,
          fullPassInnerIterations,
        };
        if (_debugLogger) {
          _debugLogger.error(`compaction: elision.regression — ratio ${ratio.toFixed(2)}`, ctx);
        } else {
          console.error(JSON.stringify({ level: 'error', ...ctx }));
        }
      }
    }
  }

  emitCompactionMetrics('compaction.elision.full_pass.ended', {
    messageCount: messages.length,
    preserveStart,
    fastPathIterations,
    fastPathInnerIterations,
    fullPassIterations,
    fullPassInnerIterations,
    tokensSaved: saved,
    changed,
  });

  return { messages: changed && next ? next : (messages as Message[]), saved, changed };
}

function summarizeToolUseInputElision(
  block: ToolUseBlock,
  tokens: number,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(block.input ?? {})) {
    fields[key] = summarizeToolUseInputValue(value);
  }

  return {
    __elided_tool_input: `~${tokens} tokens; original arguments are in the session log`,
    tool: block.name,
    fields,
  };
}

function summarizeToolUseInputValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const oneLine = value.replace(/\s+/g, ' ').trim();
    return oneLine.length <= 160 ? oneLine : `${oneLine.slice(0, 120)}...(${oneLine.length} chars)`;
  }
  if (Array.isArray(value)) {
    return `[array:${value.length}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    return `[object:${keys.slice(0, 8).join(',')}${keys.length > 8 ? ',...' : ''}]`;
  }
  return String(value);
}

function summarizeToolResultElision(block: ToolResultBlock, tokens: number): string {
  const parts = [`elided: ~${tokens} tokens`];
  if (block.name) parts.push(`tool=${block.name}`);
  const files = extractPathHints(block.content).slice(0, 5);
  if (files.length > 0) parts.push(`files=${files.join(', ')}`);
  const error = firstErrorLine(block.content);
  if (error) parts.push(`error=${error}`);
  return `[${parts.join('; ')}]`;
}

function extractPathHints(content: unknown): string[] {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  const out = new Set<string>();
  for (const match of text.matchAll(PATH_HINT_PATTERN)) {
    const clean = match[0]?.replace(PATH_BACKSLASH_PATTERN, '/').replace(PATH_TRIM_PATTERN, '');
    if (clean && clean.length <= 220) out.add(clean);
    if (out.size >= 5) break;
  }
  return [...out];
}

function firstErrorLine(content: unknown): string | undefined {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  for (const line of text.split(NEWLINE_SPLIT_PATTERN)) {
    if (!ERROR_LINE_PATTERN.test(line)) continue;
    const trimmed = line.replace(WHITESPACE_COLLAPSE_PATTERN, ' ').trim();
    if (trimmed) return trimmed.slice(0, 180);
  }
  return undefined;
}

// ── Last-resort emergency trim (the no-overflow guarantee) ─────────────────

export interface HardBudgetResult {
  /** New message array, or the same reference when nothing changed. */
  messages: Message[];
  changed: boolean;
  /** Estimated message tokens reclaimed (before − after). */
  saved: number;
  /** Number of content blocks elided or truncated. */
  trimmedBlocks: number;
  /** Number of whole messages dropped (last-resort Pass 4). */
  droppedMessages: number;
  /** True when the message array fits `budgetTokens` after trimming. */
  withinBudget: boolean;
}

/** Old text blocks above this token size are head/tail truncated in Pass 2. */
const EMERGENCY_TEXT_TOKEN_CAP = 400;
/** Pass 2 (old messages): generous head/tail retention. */
const EMERGENCY_KEEP_HEAD = 800;
const EMERGENCY_KEEP_TAIL = 300;
/** Pass 3 (whole array, incl. preserved window): tighter floor retention. */
const EMERGENCY_FLOOR_HEAD = 400;
const EMERGENCY_FLOOR_TAIL = 150;
/** Below this token size a text block is left alone (not worth a marker). */
const EMERGENCY_MIN_TRIM_TOKENS = 120;

function isElidedResultContent(content: string): boolean {
  return typeof content === 'string' && content.startsWith('[elided:');
}

function isElidedToolInput(input: Record<string, unknown> | undefined): boolean {
  return !!input && Object.hasOwn(input, '__elided_tool_input');
}

/**
 * Head/tail truncate a long string, keeping the first `keepHead` and last
 * `keepTail` characters with a token-count marker in between. Returns the
 * original when it is already small enough to make trimming pointless.
 */
function headTailTruncate(text: string, keepHead: number, keepTail: number): string {
  if (text.length <= keepHead + keepTail + 60) return text;
  const removedChars = text.length - keepHead - keepTail;
  const approxTokens = Math.ceil(removedChars / 3.5);
  return `${text.slice(0, keepHead)}\n… [truncated ~${approxTokens} tokens — see session log] …\n${text.slice(text.length - keepTail)}`;
}

/**
 * Truncate the oversized **text** content of one message (string content, or
 * `text` blocks in an array). Thinking blocks are never touched (their verbatim
 * echo — with signature — is a provider replay requirement) and protocol blocks
 * are handled by the elision pass. Returns a new message when it changed the
 * content, or `null` when nothing qualified.
 */
function truncateMessageText(
  m: Message,
  keepHead: number,
  keepTail: number,
  minTokens: number,
): { message: Message; trimmed: number } | null {
  if (typeof m.content === 'string') {
    if (estimateTextTokens(m.content) < minTokens) return null;
    const next = headTailTruncate(m.content, keepHead, keepTail);
    if (next === m.content) return null;
    return { message: { ...m, content: next, _estTokens: undefined }, trimmed: 1 };
  }
  let newContent: ContentBlock[] | undefined;
  let trimmed = 0;
  for (let j = 0; j < m.content.length; j++) {
    const b = m.content[j];
    if (!b) continue;
    if (b.type !== 'text') continue;
    if (estimateTextTokens(b.text) < minTokens) continue;
    const next = headTailTruncate(b.text, keepHead, keepTail);
    if (next === b.text) continue;
    newContent ??= m.content.slice();
    newContent[j] = { ...b, text: next };
    trimmed++;
  }
  if (!newContent) return null;
  return { message: { ...m, content: newContent, _estTokens: undefined }, trimmed };
}

/**
 * Elide every oversized tool_use / tool_result block in one message,
 * regardless of the usual `eliseThreshold` — this is the emergency floor, so
 * the threshold does not apply. Keeps the block (and its id) so tool_use ↔
 * tool_result pairing survives; only the payload is replaced with a marker.
 */
function elideMessageToolIo(m: Message): { message: Message; trimmed: number } | null {
  if (typeof m.content === 'string') return null;
  let newContent: ContentBlock[] | undefined;
  let trimmed = 0;
  for (let j = 0; j < m.content.length; j++) {
    const b = m.content[j];
    if (!b) continue;
    if (b.type === 'tool_result' && !isElidedResultContent(b.content)) {
      const tokens = estimateToolResultTokens(b.content);
      if (tokens < EMERGENCY_MIN_TRIM_TOKENS) continue;
      newContent ??= m.content.slice();
      newContent[j] = {
        type: 'tool_result',
        tool_use_id: b.tool_use_id,
        ...(b.name !== undefined && { name: b.name }),
        content: summarizeToolResultElision(b, tokens),
        is_error: b.is_error,
      };
      trimmed++;
    } else if (b.type === 'tool_use' && !isElidedToolInput(b.input)) {
      const tokens = estimateToolInputTokens(b.input);
      if (tokens < EMERGENCY_MIN_TRIM_TOKENS) continue;
      newContent ??= m.content.slice();
      newContent[j] = { ...b, input: summarizeToolUseInputElision(b, tokens) };
      trimmed++;
    }
  }
  if (!newContent) return null;
  return { message: { ...m, content: newContent, _estTokens: undefined }, trimmed };
}

/**
 * Last-resort trim that makes a request **structurally guaranteed** to fit its
 * budget. Call it after normal compaction when the message array still exceeds
 * the hard budget (a single huge paste, a preserved-window tool_result, or a
 * >1.5× token under-estimate). It escalates through four increasingly
 * destructive passes and stops the instant the array fits, so loss is
 * minimised:
 *
 *   1. Elide all old tool I/O before the preserve window (no threshold floor).
 *   2. Head/tail truncate large text in old messages.
 *   3. Head/tail truncate large text across the whole array (incl. preserved).
 *   4. Drop the oldest whole messages (never the last one) until it fits.
 *
 * A final `repairToolUseAdjacency` re-links any protocol pair Pass 4 orphaned.
 *
 * `budgetTokens` is the maximum tokens the **message array** may occupy — the
 * caller subtracts the system-prompt + tool-definition overhead from the
 * context window first, so this stays a pure function over `Message[]`.
 */
export function enforceHardBudget(
  messages: readonly Message[],
  budgetTokens: number,
  opts: { preserveK: number },
): HardBudgetResult {
  const target = Math.max(1, Math.floor(budgetTokens));
  const perMsg: number[] = messages.map((m) =>
    typeof m._estTokens === 'number' && m._estTokens > 0 ? m._estTokens : computeMessageTokens(m),
  );
  let total = perMsg.reduce((a, b) => a + b, 0);
  const before = total;
  if (total <= target) {
    return {
      messages: messages as Message[],
      changed: false,
      saved: 0,
      trimmedBlocks: 0,
      droppedMessages: 0,
      withinBudget: true,
    };
  }

  const work = messages.slice() as Message[];
  const preserveStart = findPreserveStart(messages, opts.preserveK);
  let changed = false;
  let trimmedBlocks = 0;

  // Replace message i, keeping `total`/`perMsg` in sync via a fresh estimate.
  const setMsg = (i: number, newMsg: Message): void => {
    const t = computeMessageTokens(newMsg);
    total += t - (perMsg[i] ?? 0);
    perMsg[i] = t;
    work[i] = newMsg;
    changed = true;
  };

  // ── Pass 1: elide all old tool I/O (before the preserve window) ──────────
  for (let i = 0; i < preserveStart && total > target; i++) {
    const m = work[i];
    if (!m) continue;
    const res = elideMessageToolIo(m);
    if (res) {
      trimmedBlocks += res.trimmed;
      setMsg(i, res.message);
    }
  }

  // ── Pass 2: truncate large text in old messages ─────────────────────────
  for (let i = 0; i < preserveStart && total > target; i++) {
    const m = work[i];
    if (!m) continue;
    const res = truncateMessageText(
      m,
      EMERGENCY_KEEP_HEAD,
      EMERGENCY_KEEP_TAIL,
      EMERGENCY_TEXT_TOKEN_CAP,
    );
    if (res) {
      trimmedBlocks += res.trimmed;
      setMsg(i, res.message);
    }
  }

  // ── Pass 3: floor-truncate text across the whole array (incl. preserved) +
  //            elide any remaining oversized tool I/O in the preserved tail ──
  for (let i = 0; i < work.length && total > target; i++) {
    const m = work[i];
    if (!m) continue;
    const elided = elideMessageToolIo(m);
    if (elided) {
      trimmedBlocks += elided.trimmed;
      setMsg(i, elided.message);
      if (total <= target) break;
    }
    const current = work[i];
    if (!current) continue;
    const res = truncateMessageText(
      current,
      EMERGENCY_FLOOR_HEAD,
      EMERGENCY_FLOOR_TAIL,
      EMERGENCY_MIN_TRIM_TOKENS,
    );
    if (res) {
      trimmedBlocks += res.trimmed;
      setMsg(i, res.message);
    }
  }

  // ── Pass 4: drop the oldest whole messages until it fits (guaranteed) ────
  let dropFrom = 0;
  while (total > target && dropFrom < work.length - 1) {
    total -= perMsg[dropFrom] ?? 0;
    dropFrom++;
    changed = true;
  }
  let trimmed: Message[] = dropFrom > 0 ? work.slice(dropFrom) : work;
  const droppedMessages = dropFrom;

  // Repair any tool_use/tool_result adjacency the drop pass orphaned.
  if (changed) {
    const repair = repairToolUseAdjacency(trimmed);
    if (repair.report.changed) trimmed = repair.messages;
  }

  return {
    messages: changed ? trimmed : (messages as Message[]),
    changed,
    saved: Math.max(0, before - total),
    trimmedBlocks,
    droppedMessages,
    withinBudget: total <= target,
  };
}

// ── Stale repeated-read dedup (smart cleanup) ──────────────────────────────

export interface DedupResult {
  messages: Message[];
  changed: boolean;
  /** Estimated tokens reclaimed. */
  saved: number;
  /** Number of stale reads collapsed. */
  deduped: number;
}

/** Path-like value from a read tool_use input (path / file / file_path…). */
function readPathOf(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  for (const key of ['file_path', 'path', 'file', 'filename']) {
    const v = input[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

function normalizePathKey(p: string): string {
  return p.replace(PATH_BACKSLASH_PATTERN, '/').toLowerCase();
}

/** Does `pathKey` refer to one of the hot (repeatedly-read) files? */
function isHotRead(pathKey: string, hot: readonly string[]): boolean {
  for (const h of hot) {
    if (pathKey === h) return true;
    if (pathKey.endsWith(h) || h.endsWith(pathKey)) return true;
    const base = pathKey.slice(pathKey.lastIndexOf('/') + 1);
    if (base && h.endsWith(base)) return true;
  }
  return false;
}

/**
 * Collapse **superseded** reads of the same file. When a file is read
 * repeatedly (tracked in `repeatedReads` evidence), every read of it before
 * the preserve window that is *not* the newest occurrence is redundant — the
 * later read replaced it. This replaces those stale `tool_result` payloads
 * with a one-line marker (and elides the paired `tool_use` input), keeping the
 * newest read verbatim. Complements `eliseOldToolResults`, which only fires on
 * results ≥ `eliseThreshold`: many small-but-repeated reads slip under that bar
 * and accumulate, so this catches the pattern `eliseThreshold` misses.
 */
export function dedupStaleReads(
  messages: readonly Message[],
  repeatedReads: readonly { file: string; count: number }[],
  opts: { preserveK: number },
): DedupResult {
  const unchanged: DedupResult = {
    messages: messages as Message[],
    changed: false,
    saved: 0,
    deduped: 0,
  };
  const hot = repeatedReads.filter((r) => r.count >= 2).map((r) => normalizePathKey(r.file));
  if (hot.length === 0) return unchanged;

  // Pass A: find, per hot path key, the newest message index that reads it.
  const newestIndexByKey = new Map<string, number>();
  const readKeyByUseId = new Map<string, string>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m.content === 'string') continue;
    for (const b of m.content) {
      if (b.type !== 'tool_use' || b.name.toLowerCase() !== 'read') continue;
      const p = readPathOf(b.input);
      if (!p) continue;
      const key = normalizePathKey(p);
      if (!isHotRead(key, hot)) continue;
      readKeyByUseId.set(b.id, key);
      const prev = newestIndexByKey.get(key);
      if (prev === undefined || i > prev) newestIndexByKey.set(key, i);
    }
  }
  if (newestIndexByKey.size === 0) return unchanged;

  const preserveStart = findPreserveStart(messages, opts.preserveK);

  // Pass B: collect the tool_use ids of stale (superseded, pre-preserve) reads.
  const staleIds = new Map<string, string>(); // tool_use_id → path key
  for (let i = 0; i < preserveStart; i++) {
    const m = messages[i];
    if (!m || typeof m.content === 'string') continue;
    for (const b of m.content) {
      if (b.type !== 'tool_use') continue;
      const key = readKeyByUseId.get(b.id);
      if (!key) continue;
      const newest = newestIndexByKey.get(key);
      if (newest !== undefined && i < newest) staleIds.set(b.id, key);
    }
  }
  if (staleIds.size === 0) return unchanged;

  // Pass C: rewrite stale tool_use inputs + their paired tool_result payloads.
  let saved = 0;
  let deduped = 0;
  let next: Message[] | undefined;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m.content === 'string') continue;
    let newContent: ContentBlock[] | undefined;
    for (let j = 0; j < m.content.length; j++) {
      const b = m.content[j];
      if (!b) continue;
      if (b.type === 'tool_use' && staleIds.has(b.id) && !isElidedToolInput(b.input)) {
        newContent ??= m.content.slice();
        newContent[j] = {
          ...b,
          input: { __stale_read: `superseded by a later read of ${staleIds.get(b.id)}`, tool: b.name },
        };
      } else if (b.type === 'tool_result' && staleIds.has(b.tool_use_id)) {
        const key = staleIds.get(b.tool_use_id);
        if (isElidedResultContent(b.content)) continue;
        const tokens = estimateToolResultTokens(b.content);
        if (tokens < 1) continue;
        saved += tokens;
        deduped++;
        newContent ??= m.content.slice();
        newContent[j] = {
          type: 'tool_result',
          tool_use_id: b.tool_use_id,
          ...(b.name !== undefined && { name: b.name }),
          content: `[stale read of ${key} — superseded by a later read; see session log]`,
          is_error: b.is_error,
        };
      }
    }
    if (newContent) {
      next ??= messages.slice() as Message[];
      next[i] = { ...m, content: newContent, _estTokens: undefined };
    }
  }

  if (!next) return unchanged;
  return { messages: next, changed: true, saved, deduped };
}

/**
 * Lossless textual digest of a message range. Every text block is kept verbatim
 * (across all roles, so prior `system` digests fold forward and nothing
 * accumulates as loss). `tool_use` / `tool_result` blocks are counted and
 * replaced with a marker rather than serialized — their payload is already
 * persisted in the session log. Empty/tool-only messages are skipped.
 */
export function buildLosslessDigest(messages: readonly Message[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    let text: string;
    let omitted = 0;
    if (typeof m.content === 'string') {
      text = m.content;
    } else {
      const parts: string[] = [];
      for (const b of m.content) {
        if (isTextBlock(b)) parts.push(b.text);
        else if (b.type === 'tool_use' || b.type === 'tool_result') omitted++;
      }
      text = parts.join(' ');
    }
    if (text.trim().length === 0 && omitted === 0) continue;
    const marker = omitted > 0 ? ` [${omitted} tool call(s) omitted — see session log]` : '';
    lines.push(`[${m.role}]: ${text}${marker}`);
  }
  return lines.join('\n');
}

/**
 * Nearest safe cut boundary in [from, to]: the start of the exchange of the
 * closest user-with-text message. Returns -1 when no such boundary exists.
 */
export function findSafeBoundary(messages: readonly Message[], from: number, to: number): number {
  for (let i = to; i >= from; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === 'user' && hasTextContent(m)) {
      return findExchangeStart(messages, i);
    }
  }
  return -1;
}

/**
 * Walk backwards from a user message to find where its logical exchange began
 * (just after the last assistant message that made no tool calls).
 */
export function findExchangeStart(messages: readonly Message[], userIndex: number): number {
  for (let i = userIndex - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === 'assistant') {
      const hasToolUse = Array.isArray(m.content)
        ? m.content.some((b) => b.type === 'tool_use')
        : false;
      if (!hasToolUse) return i + 1;
    } else if (m.role === 'user') {
      return i;
    }
  }
  return 0;
}

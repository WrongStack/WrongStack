import type { ContentBlock, ToolResultBlock, ToolUseBlock } from '../types/blocks.js';
import { isTextBlock } from '../types/blocks.js';
import type { Message } from '../types/messages.js';
import {
  estimateMessageTokens,
  estimateToolInputTokens,
  estimateToolResultTokens,
} from '../utils/token-estimate.js';

// ── Pre-compiled regexes for scoreMessage ─────────────────────────────
// These were previously declared inline as literal expressions inside
// `scoreMessage`, which means a fresh RegExp object was compiled on every
// call. With ~50k messages in a long agent run, that's a lot of wasted
// work. Hoisting them to module scope means the regex engine compiles
// them exactly once at module load.

// Repeated-failure detection (used twice in scoreMessage — once for the
// boolean match, once to extract the error key).
const FAILURE_PATTERN = /(error|fail|exception|timeout|enonet|eacces|eperm|enoent|abort)/i;

// User corrections / stop signals.
const CORRECTION_PATTERN = /\b(wrong|no\b|stop\b|don'?t\b|actually|fix that|undo|revert|forget|ignore|skip)\b/i;

// Error / exception / crash language.
const ERROR_LANG_PATTERN = /\b(error|exception|fatal|critical|crash|panic|abort|segfault|core dump|undefined is not|null pointer|typeerror|referenceerror|syntaxerror)\b/i;

// Security findings.
const SECURITY_PATTERN = /\b(security|vulnerability|injection|xss|csrf|secret|apikey|api.key|hardcoded|leak|exploit|cve)\b/i;

// Architecture / design decisions.
const ARCHITECTURE_PATTERN = /\b(architecture|design|approach|strategy|pattern|refactor|migrate|restructure|decision|trade.?off)\b/i;

// Grep / list / tree output markers (low-priority boilerplate).
const BOILERPLATE_PATTERN = /\b(files_with_matches|count|found \d+ match|directory tree|\.\.\. and \d+ more)\b/i;

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

/** Emit compaction instrumentation as a structured log event (debug-only). */
function emitCompactionMetrics(event: string, metrics: CompactionMetrics): void {
  if (!compactionDebugEnabled()) return;
  console.log(
    JSON.stringify({
      level: 'debug',
      event,
      messageCount: metrics.messageCount,
      preserveStart: metrics.preserveStart,
      fastPathIterations: metrics.fastPathIterations,
      fastPathInnerIterations: metrics.fastPathInnerIterations,
      // Ratios — anything > 2.0 indicates the inner loop is running more than expected
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
    }),
  );
}

/**
 * Token estimate for a message array (text + tool I/O). Re-exported from the
 * canonical `token-estimate` helper so compactors and the context-pressure
 * monitor share one number.
 */
export const estimateMessages = estimateMessageTokens;

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
    console.log(
      JSON.stringify({
        level: 'debug',
        event: 'compaction.find_preserve_start.ended',
        messageCount: messages.length,
        preserveK,
        preserveStart,
        pairRepairIterations,
        pairRepairInnerIterations,
        pairRepairInnerPerOuter:
          pairRepairIterations > 0 ? pairRepairInnerIterations / pairRepairIterations : 0,
      }),
    );
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
      const oversized =
        (b.type === 'tool_result' && estimateToolResultTokens(b.content) >= opts.eliseThreshold) ||
        (b.type === 'tool_use' && estimateToolInputTokens(b.input) >= opts.eliseThreshold);
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
        const tokens = estimateToolInputTokens(b.input);
        if (tokens < opts.eliseThreshold) continue;
        const elidedInput = summarizeToolUseInputElision(b, tokens);
        saved += Math.max(0, tokens - estimateToolInputTokens(elidedInput));
        newContent ??= original.slice();
        newContent[idx] = { ...b, input: elidedInput };
        continue;
      }

      if (b.type !== 'tool_result') continue;
      const tokens = estimateToolResultTokens(b.content);
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
      next[i] = { ...msg, content: newContent };
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
        console.error(
          JSON.stringify({
            level: 'error',
            event: 'compaction.elision.regression',
            message: `fullPassInnerPerOuter=${ratio.toFixed(2)} exceeds threshold 10 — possible O(n·m) regression`,
            messageCount: messages.length,
            fullPassIterations,
            fullPassInnerIterations,
          }),
        );
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

// ── Content-aware scoring ─────────────────────────────────────────────────

/** Importance score for a message — drives retention vs. summarization. */
export type ContentScore = 0 | 1 | 2 | 3 | 4 | 5;
// 5 = critical (error, correction, decision) — keep verbatim
// 3 = medium   (normal exchange, successful tool) — keep first sentence
// 1 = low      (large tool result, grep output)    — one-line summary
// 0 = noise    (repeated failure pattern)          — collapse to count

/**
 * Extract the plain text from a message (ignoring tool blocks).
 * Returns empty string if no text content exists.
 */
export function extractText(m: Message): string {
  if (typeof m.content === 'string') return m.content;
  return m.content
    .filter(isTextBlock)
    .map((b) => b.text)
    .join(' ');
}

/** Check if a message contains a tool_use block. */
export function hasToolUse(m: Message): boolean {
  if (typeof m.content === 'string') return false;
  return m.content.some((b) => b.type === 'tool_use');
}

/** Check if a message contains a tool_result block over the given char threshold. */
export function hasLargeToolResult(m: Message, threshold = 3000): boolean {
  if (typeof m.content === 'string') return false;
  return m.content.some(
    (b) =>
      b.type === 'tool_result' &&
      (b as ToolResultBlock).content &&
      (typeof (b as ToolResultBlock).content === 'string'
        ? (b as ToolResultBlock).content.length
        : JSON.stringify((b as ToolResultBlock).content).length) > threshold,
  );
}

/**
 * Score a message by content importance.
 *
 * CRITICAL (5): user corrections, explicit "no/wrong/stop", error messages,
 *   architecture decisions, security findings.
 * MEDIUM (3): normal exchanges, successful tool calls, file reads, edits.
 * LOW (1): large tool results (>3K chars), grep/file-list outputs, boilerplate.
 * NOISE (0): repeated identical failures (same tool, same error, 5th+ occurrence
 *   within the range), pure tool I/O with no text.
 */
export function scoreMessage(
  m: Message,
  context?: { failureCounts?: Map<string, number> },
): ContentScore {
  const text = extractText(m).toLowerCase();

  // ── Noise detection: pure tool I/O with no text ─────────────────────
  if (text.trim().length === 0 && (hasToolUse(m) || typeof m.content !== 'string')) {
    const hasResult =
      typeof m.content !== 'string' && m.content.some((b) => b.type === 'tool_result');
    if (hasToolUse(m) || hasResult) return 0;
  }

  // ── Repeated failure detection ─────────────────────────────────────
  if (context?.failureCounts && m.role === 'user' && hasToolUse(m) === false) {
    // Check if this is a tool_result that matches a failure pattern
    const failureMatch = FAILURE_PATTERN.exec(text);
    if (failureMatch) {
      // Build a key from the error type. Reuse the match result from
      // the boolean test above to avoid scanning the text twice.
      const errKey = failureMatch[0]?.toLowerCase() ?? 'error';
      const count = (context.failureCounts.get(errKey) ?? 0) + 1;
      context.failureCounts.set(errKey, count);
      if (count >= 5) return 0; // 5th+ identical failure → noise
      if (count >= 3) return 1; // 3rd-4th → low priority
    }
  }

  // ── Critical: user corrections / stop signals ──────────────────────
  if (m.role === 'user') {
    if (CORRECTION_PATTERN.test(text)) {
      return 5;
    }
  }

  // ── Critical: error / exception messages ───────────────────────────
  if (ERROR_LANG_PATTERN.test(text)) {
    return 5;
  }

  // ── Critical: security findings ────────────────────────────────────
  if (SECURITY_PATTERN.test(text)) {
    return 5;
  }

  // ── Critical: architecture / design decisions ──────────────────────
  if (m.role === 'assistant' && ARCHITECTURE_PATTERN.test(text)) {
    return 5;
  }

  // ── Low: large tool results ────────────────────────────────────────
  if (hasLargeToolResult(m)) return 1;

  // ── Low: grep / list / tree outputs ────────────────────────────────
  if (
    m.role === 'user' &&
    !hasToolUse(m) &&
    BOILERPLATE_PATTERN.test(text)
  ) {
    return 1;
  }

  // ── Default: medium ────────────────────────────────────────────────
  return 3;
}

/**
 * Build a content-aware digest of messages.
 *
 * Unlike `buildLosslessDigest` which preserves all text equally, this uses
 * `scoreMessage` to apply tiered treatment:
 * - Score 5 (critical): verbatim text
 * - Score 3 (medium):   first sentence only
 * - Score 1 (low):      one-line summary
 * - Score 0 (noise):    collapsed to count marker
 */
export function buildSmartDigest(messages: readonly Message[]): string {
  const lines: string[] = [];
  const failureCounts = new Map<string, number>();
  let noiseCount = 0;

  for (const m of messages) {
    // Noise early-bail: a message with no text AND no tool_use block is
    // pure tool I/O (only tool_result blocks). scoreMessage would return 0
    // for it after a full scan, so skip the regex suite entirely. This is
    // the dominant case in long sessions — repeated tool I/O often
    // accounts for >50% of message count.
    const isPureToolIO =
      Array.isArray(m.content) && m.content.length > 0 && !hasToolUse(m) && m.content.every((b) => b.type === 'tool_result');
    if (isPureToolIO) {
      noiseCount++;
      continue;
    }

    const score = scoreMessage(m, { failureCounts });
    const text = extractText(m);
    const toolCount = countToolBlocks(m);

    if (score === 0) {
      noiseCount++;
      continue;
    }

    const marker = toolCount > 0 ? ` [${toolCount} tool call(s)]` : '';
    let display: string;

    switch (score) {
      case 5: // Critical — keep verbatim
        display = text.trim();
        break;
      case 3: // Medium — first sentence
        display = firstSentence(text);
        break;
      case 1: // Low — one-line summary
        display = oneLineSummary(m, text);
        break;
      default:
        display = firstSentence(text);
    }

    if (display.length === 0 && toolCount === 0) continue;
    lines.push(`[${m.role}]: ${display}${marker}`);
  }

  if (noiseCount > 0) {
    lines.push(
      `[system]: ${noiseCount} low-importance turn(s) collapsed (repeated failures / pure tool I/O)`,
    );
  }

  return lines.join('\n');
}

function countToolBlocks(m: Message): number {
  if (typeof m.content === 'string') return 0;
  return m.content.filter((b) => b.type === 'tool_use' || b.type === 'tool_result').length;
}

function firstSentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '';
  const dot = trimmed.indexOf('. ');
  if (dot === -1) return trimmed.length > 150 ? `${trimmed.slice(0, 147)}…` : trimmed;
  const sentence = trimmed.slice(0, dot + 1);
  return sentence.length > 150 ? `${sentence.slice(0, 147)}…` : sentence;
}

function oneLineSummary(m: Message, text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    // Pure tool result with no text
    if (typeof m.content !== 'string') {
      const results = m.content.filter((b) => b.type === 'tool_result');
      if (results.length > 0) {
        return `[${results.length} tool result(s) — see session log]`;
      }
    }
    return '[no text content]';
  }
  // Truncate to one line (~100 chars)
  const firstLine = trimmed.split('\n')[0] ?? '';
  return firstLine.length > 100 ? `${firstLine.slice(0, 97)}…` : firstLine;
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

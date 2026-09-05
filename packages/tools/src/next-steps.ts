/**
 * Canonical `<nextsteps>` block parser — the single source of truth shared by
 * the TUI history renderer, the CLI REPL suggestion store, the CLI /suggest
 * subagent output, and the WebUI MessageBubble/NextStepsBar.
 *
 * Three code paths feed into the parser:
 *   1. TUI rendering  — entry.tsx parses only "<nextsteps>" from assistant output
 *   2. REPL store     — repl.ts parses only "<nextsteps>" from final agent output
 *   3. /suggest output — suggest.ts parses LLM-generated numbered lists (raw mode)
 *
 * Heading mode (`requireHeading = true`, the default):
 *   Assistant-output paths accept only balanced <nextsteps>...</nextsteps> blocks.
 *   Loose headings like "Next steps:" are intentionally ignored so `/next` only
 *   activates for the canonical machine-readable format.
 *
 * Raw mode (`requireHeading = false`):
 *   Parses numbered/bullet items from anywhere in text (subagent /suggest output).
 *
 * Supported assistant-output format:
 *   <nextsteps>      (canonical XML tag format)
 *
 * The parser also tolerates attributes on the opening tag so malformed model
 * output such as `<nextsteps auto="true">` does not leak into the UI. Opening
 * tag attributes are ignored; `auto="true"` has meaning only on the first item.
 *
 * This module is BROWSER-SAFE — no Node-only imports — so it is safe to import
 * from Vite-bundled WebUI as well as Node-based CLI/TUI. Mirrors the proven
 * `tool-summary` / `tool-icons` extraction pattern (PRs #236 / #237 / #238).
 */

// ── Types ─────────────────────────────────────────────────────────────────

export interface ParsedNextStep {
  index: number;
  text: string;
  /** Whether the first item has auto="true" for YOLO+auto autonomy mode. */
  auto?: boolean;
}

export interface ParseNextStepsOptions {
  requireHeading?: boolean;
}

export interface ParseNextStepsResult {
  /** Matched steps with their original index and stripped text. */
  steps: ParsedNextStep[];
  /** Flat string array — what gets stored in the suggestion store. */
  texts: string[];
  /**
   * Content with the entire canonical "<nextsteps>" block removed.
   * Used by entry.tsx to strip suggestions from the rendered message body.
   */
  stripped: string;
  /** The first item's text when it has auto="true"; otherwise empty. */
  autoTexts: string[];
}

/**
 * Validate the structured input of the `nextsteps` tool for UI consumers.
 *
 * The runtime normally folds this input into the terminal assistant response.
 * Browser clients still keep this projection as a fallback for a terminal
 * response that is missing (for example after an interrupted stream).
 */
export function projectNextStepsToolInput(input: unknown): ParsedNextStep[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  const rawSteps = (input as Record<string, unknown>)['steps'];
  if (!Array.isArray(rawSteps)) return [];

  const steps: ParsedNextStep[] = [];
  for (const candidate of rawSteps) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const text = (candidate as Record<string, unknown>)['text'];
    if (typeof text !== 'string' || !text.trim()) continue;
    const auto = steps.length === 0 && (candidate as Record<string, unknown>)['auto'] === true;
    steps.push(
      auto
        ? { index: steps.length + 1, text: text.trim(), auto: true }
        : { index: steps.length + 1, text: text.trim() },
    );
    if (steps.length >= MAX_STEPS) break;
  }
  return steps;
}

// ── Turn boundary ──────────────────────────────────────────────────────────

/**
 * Whether an LLM response's stop reason means the message is the FINAL one of
 * a turn.
 *
 * The agent loop calls the provider once per iteration, so a multi-step turn
 * emits several assistant messages. Only the last one — the response that
 * stopped without asking for another tool — is the model's actual answer;
 * everything before it is mid-turn prose the model wrote on its way to a tool
 * call. A `<nextsteps>` block in mid-turn text is noise: surfacing it would
 * offer the user suggestions while the work is still in flight, and would let
 * `/next` and auto-submit pick up a suggestion the model has already moved on
 * from.
 *
 * Every surface that renders suggestions gates on this so the three of them
 * cannot disagree about where a turn ends. Callers still strip the block from
 * the message body regardless — the raw XML must never reach the user.
 *
 * `tool_call` is the spelling some providers put on the WebUI wire (typed
 * loosely as `stopReason: string`); the canonical `StopReason` union uses
 * `tool_use`. An absent stop reason counts as final so legacy paths that never
 * carried one keep their suggestions.
 */
export function isFinalTurnStopReason(stopReason: string | undefined): boolean {
  return stopReason !== 'tool_use' && stopReason !== 'tool_call';
}

// ── Patterns ───────────────────────────────────────────────────────────────

/**
 * Byte ranges `[start, end)` of fenced code blocks (``` or ~~~) in `content`.
 *
 * A fence OPENS on a line whose first non-whitespace characters are 3+
 * backticks or tildes (an info string like ```xml may follow) and CLOSES on
 * the next line consisting only of the same marker character with at least
 * the opening length. An unterminated fence extends to end-of-text.
 *
 * Used to keep `<nextsteps>` examples inside code fences out of the parser:
 * a fenced example is documentation, not suggestion metadata.
 */
function fenceSpans(content: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const lines = content.split('\n');
  let offset = 0;
  let open: { markerChar: string; markerLength: number; start: number } | null = null;
  for (const line of lines) {
    const lineStart = offset;
    offset += line.length + 1;
    const trimmed = line.trim();
    const marker = /^(`{3,}|~{3,})/.exec(trimmed)?.[1];
    if (marker === undefined) continue;
    if (open === null) {
      open = { markerChar: marker[0]!, markerLength: marker.length, start: lineStart };
      continue;
    }
    // A closing fence is only the marker itself and must not be shorter than
    // the opening fence.
    if (marker[0] === open.markerChar && marker.length >= open.markerLength && trimmed === marker) {
      spans.push([open.start, offset]);
      open = null;
    }
  }
  if (open !== null) spans.push([open.start, content.length]);
  return spans;
}

/** Whether `index` falls inside a fenced code block of `content`. */
export function indexInsideCodeFence(content: string, index: number): boolean {
  return fenceSpans(content).some(([start, end]) => index >= start && index < end);
}

/** First occurrence of `needle` at/after `fromIndex` that sits outside code fences. */
function nonFencedIndexOf(
  content: string,
  needle: string,
  fromIndex: number,
  spans: Array<[number, number]>,
): number {
  let at = fromIndex;
  for (;;) {
    const found = content.indexOf(needle, at);
    if (found === -1) return -1;
    if (!spans.some(([start, end]) => found >= start && found < end)) return found;
    at = found + 1;
  }
}

/** Matches an item line: "1. text", "1) text", "- text", "* text". */
/** Also captures optional auto="true" attribute at the end. */
const ITEM_RE = /^(?:(\d+)[.)]\s*|[-*•]\s*)(.+?)(\s+auto="true")?$/;

const MAX_STEPS = 6;

// ── Core parser ─────────────────────────────────────────────────────────────

/**
 * Parse canonical "<nextsteps>" blocks from assistant output (or raw numbered lines).
 *
 * @param content        — raw assistant message text or subagent output
 * @param requireHeading — when true (default), a canonical XML tag must precede the item list.
 *                        when false, numbered/bullet items are parsed from anywhere in text
 *                        (used by /suggest subagent output which has no heading).
 */
export function parseNextSteps(content: string, requireHeading = true): ParseNextStepsResult {
  if (requireHeading) {
    return parseWithHeading(content);
  }
  return parseRawNumbered(content);
}

/** Push a step into the array, omitting `auto` when false (cleaner shape, matches WebUI parity). */
function pushStep(steps: ParsedNextStep[], index: number, text: string, hasAuto: boolean): void {
  steps.push(hasAuto ? { index, text, auto: true } : { index, text });
}

/** Parse numbered/bullet items from raw text without a heading. */
function parseRawNumbered(content: string): ParseNextStepsResult {
  const lines = content.split('\n');
  const steps: ParsedNextStep[] = [];
  const seenNumbers = new Set<number>();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const m = ITEM_RE.exec(line);
    if (!m) continue; // skip non-item lines in raw mode

    const numPart = m[1];
    const text = m[2]!.trim();
    let index: number;

    if (numPart !== undefined) {
      index = Number.parseInt(numPart, 10);
    } else {
      index = steps.length + 1; // bullet items get sequential indices
    }

    if (seenNumbers.has(index)) continue;
    seenNumbers.add(index);
    // Auto-submit is deliberately restricted to the first accepted item.
    // Later misplaced markers are stripped from display text but ignored.
    const hasAuto = !!m[3] && steps.length === 0 && index === 1;
    pushStep(steps, index, text, hasAuto);

    if (steps.length >= MAX_STEPS) break;
  }

  return {
    steps,
    texts: steps.map((s) => s.text),
    stripped: content,
    autoTexts: steps.filter((s) => s.auto).map((s) => s.text),
  };
}

/** Parse a heading + item block (the main assistant-message path). */
function parseWithHeading(content: string): ParseNextStepsResult {
  const empty: ParseNextStepsResult = { steps: [], texts: [], stripped: content, autoTexts: [] };
  const spans = fenceSpans(content);
  const outsideFences = (index: number): boolean =>
    !spans.some(([start, end]) => index >= start && index < end);

  // The heading tag must sit outside code fences: a <nextsteps> block inside a
  // fenced example is documentation the user asked to see, not metadata.
  const headingScan = /<nextsteps\b[^>]*>\s*\n+/gi;
  let heading: { index: number; length: number } | null = null;
  for (let m = headingScan.exec(content); m !== null; m = headingScan.exec(content)) {
    if (outsideFences(m.index)) {
      heading = { index: m.index, length: m[0].length };
      break;
    }
  }
  if (heading === null) return empty;

  const headingEnd = heading.index + heading.length;
  const afterHeading = content.slice(headingEnd);
  const lines = afterHeading.split('\n');
  const steps: ParsedNextStep[] = [];
  const seenNumbers = new Set<number>();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const m = ITEM_RE.exec(line);
    if (!m) break; // non-item line — block ends

    const numPart = m[1];
    const text = m[2]!.trim();
    let index: number;

    if (numPart !== undefined) {
      index = Number.parseInt(numPart, 10);
    } else {
      index = steps.length + 1;
    }

    if (seenNumbers.has(index)) continue;
    seenNumbers.add(index);
    // Only the first accepted item may opt into unattended auto-submit.
    const hasAuto = !!m[3] && steps.length === 0 && index === 1;
    pushStep(steps, index, text, hasAuto);

    if (steps.length >= MAX_STEPS) break;
  }

  if (steps.length === 0) return empty;

  // Require a closing tag outside code fences. Malformed XML is rejected so
  // raw text remains visible instead of being partially consumed as
  // automation input; a close inside a fence belongs to the example.
  const closeAbs = nonFencedIndexOf(content, '</nextsteps>', headingEnd, spans);
  if (closeAbs === -1) return empty;

  const texts = steps.map((s) => s.text);
  const autoTexts = steps.filter((s) => s.auto).map((s) => s.text);

  // Strip the heading tag through the closing tag (plus one trailing newline).
  let blockEndAbs = closeAbs + '</nextsteps>'.length;
  if (content[blockEndAbs] === '\n') blockEndAbs += 1;
  const stripped = (content.slice(0, heading.index) + content.slice(blockEndAbs))
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { steps, texts, stripped, autoTexts };
}

/**
 * Strip <nextsteps>...</nextsteps> blocks from subagent output text.
 * Subagent results should not contain suggestion blocks — those belong to
 * the main assistant's output. This prevents raw XML tags from appearing
 * as literal text in the fleet panel.
 *
 * Also strips the legacy `<next_steps>` spelling that older persisted
 * subagent output may contain (WebUI parity).
 *
 * Code-fence aware: a <nextsteps> example inside a fenced code block is
 * documentation and must survive verbatim. Only tags (and their blocks)
 * outside fences are removed; an unpaired open tag outside a fence is
 * reduced to nothing so raw XML never reaches the user.
 */
export function stripNextStepsBlock(text: string): string {
  const spans = fenceSpans(text);
  const outsideFences = (index: number): boolean =>
    !spans.some(([start, end]) => index >= start && index < end);

  let result = '';
  let cursor = 0;
  const openTagRe = /<next_?steps\b[^>]*>/gi;
  for (let match = openTagRe.exec(text); match !== null; match = openTagRe.exec(text)) {
    if (!outsideFences(match.index)) continue;

    let removed: number;
    if (match[0].endsWith('/>')) {
      // Self-closing spelling: the tag itself is the whole element.
      removed = match[0].length;
    } else {
      const closeRe = /<\/next_?steps\s*>/gi;
      closeRe.lastIndex = match.index + match[0].length;
      removed = -1;
      for (let close = closeRe.exec(text); close !== null; close = closeRe.exec(text)) {
        if (!outsideFences(close.index)) continue;
        // `removed` is a LENGTH (open-tag start → close-tag end) so the
        // cursor arithmetic below stays consistent with the self-closing
        // branch — an absolute end offset here would skip past the text
        // that follows the block.
        removed = close.index + close[0].length - match.index;
        break;
      }
      if (removed === -1) {
        // Unpaired tag: drop the tag itself so raw XML never reaches the user.
        removed = match[0].length;
      }
    }

    result += text.slice(cursor, match.index);
    cursor = match.index + removed;
    openTagRe.lastIndex = cursor;
  }
  result += text.slice(cursor);
  return result.replace(/\n{3,}/g, '\n\n').trim();
}

export const stripNextSteps = stripNextStepsBlock;


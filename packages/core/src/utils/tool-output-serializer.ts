import { estimateTextTokens } from './token-estimate.js';
import {
  clipInline,
  DEFAULT_LIST_LIMIT,
  INLINE_LIMIT,
  isScalar,
  joinSections,
  oneLineJson,
  type RecordValue,
  renderHeader,
  renderStringList,
  renderToolObject,
} from './tool-output-renderers.js';
/**
 * Tool output serialization utilities.
 * Extracted from Agent.executeTools to allow reuse and consistent output handling.
 */

export interface ToolOutputSerializerOptions {
  perIterationOutputCapBytes?: number | undefined;
  estimator?: ((text: string) => number) | undefined;
}

export interface ToolOutputSerializeContext {
  toolName?: string | undefined;
  input?: unknown;
  /**
   * Optional reference to the Tool object. When present and the tool defines
   * a `serialize()` method, the serializer delegates to it instead of the
   * central `renderToolObject()` switch (P3 #21).
   */
  tool?: { serialize?: (output: unknown, input: unknown) => string } | undefined;
}

/** A high surrogate without its low half, or a low one without its high half. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function createToolOutputSerializer(opts: ToolOutputSerializerOptions = {}) {
  const capBytes = opts.perIterationOutputCapBytes ?? 100_000;

  // Tools cap output at UTF-16 unit counts (capture caps, head+tail windows,
  // inline clips); a cut inside a surrogate pair leaves a lone surrogate, which
  // reaches the provider as an unpaired `\udXXX` escape. Every tool result
  // passes here, so it leaves well-formed (a lone half becomes U+FFFD).
  function serialize(value: unknown, context: ToolOutputSerializeContext = {}): string {
    return serializeValue(value, context).replace(LONE_SURROGATE, '�');
  }

  function serializeValue(value: unknown, context: ToolOutputSerializeContext = {}): string {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') {
      // An empty list used to serialize to "" — a blank tool result the model
      // could not tell apart from a dropped one (ADR `list` with no records).
      if (Array.isArray(value)) {
        return value.length === 0
          ? '(no items)'
          : value.map((item) => serializeValue(item)).join('\n');
      }
      // P3 #21 (before-release.md): prefer the tool's own serialize() method
      // when it defines one — lets tools own their output formatting without
      // adding a branch to the central renderToolObject() god function.
      if (context.tool?.serialize) {
        try {
          return context.tool.serialize(value, context.input);
        } catch {
          // Fall through to the central renderer if the tool's serializer
          // throws — never let a formatting error break the tool result.
        }
      }
      if (context.toolName) {
        const compact = renderToolObject(context.toolName, value as RecordValue, context.input);
        if (compact !== undefined) return compact;
        return renderGenericToolObject(context.toolName, value as RecordValue);
      }
      if ('text' in (value as Record<string, unknown>)) {
        const t = (value as Record<string, unknown>).text;
        return typeof t === 'string' ? t : JSON.stringify(value, null, 2);
      }
      try {
        return JSON.stringify(value, null, 2);
      } catch {
        return String(value);
      }
    }
    return String(value);
  }

  function enforceCap(text: string, remainingBudget: number): { text: string; newBudget: number } {
    if (typeof text !== 'string') text = String(text ?? '');
    if (remainingBudget <= 0) {
      return { text: '[truncated: iteration output cap exceeded]', newBudget: 0 };
    }
    const textBytes = Buffer.byteLength(text, 'utf8');
    if (textBytes <= remainingBudget) {
      return { text, newBudget: remainingBudget - textBytes };
    }
    const marker = `\n…[truncated ${textBytes - remainingBudget} bytes]…\n`;
    const markerBytes = Buffer.byteLength(marker, 'utf8');
    const available = remainingBudget - markerBytes;
    if (available <= 0) {
      return { text: '[truncated: iteration output cap exceeded]', newBudget: 0 };
    }
    const half = Math.floor(available / 2);
    const first = utf8Prefix(text, half);
    const second = utf8Suffix(text, available - Buffer.byteLength(first, 'utf8'));
    return { text: `${first}${marker}${second}`, newBudget: 0 };
  }

  return { serialize, enforceCap, capBytes };
}

function utf8Prefix(text: string, maxBytes: number): string {
  if (typeof text !== 'string' || maxBytes <= 0) return '';
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) low = mid;
    else high = mid - 1;
  }
  let end = low;
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
  return text.slice(0, end);
}

function utf8Suffix(text: string, maxBytes: number): string {
  if (typeof text !== 'string' || maxBytes <= 0) return '';
  let low = 0;
  let high = text.length;
  while (low < high) {
    const chars = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(text.length - chars), 'utf8') <= maxBytes) low = chars;
    else high = chars - 1;
  }
  let start = text.length - low;
  if (start < text.length && /[\uDC00-\uDFFF]/.test(text[start]!)) start++;
  return text.slice(start);
}

function renderGenericToolObject(toolName: string, obj: RecordValue): string {
  const scalars: RecordValue = {};
  const blocks: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (isScalar(value)) {
      const inline = String(value);
      if (inline.length <= INLINE_LIMIT && !inline.includes('\n')) {
        scalars[key] = value;
      } else {
        blocks.push(`${key}:\n${inline}`);
      }
      continue;
    }
    if (Array.isArray(value)) {
      if (value.every((item) => typeof item === 'string')) {
        blocks.push(`${key}:\n${renderStringList(value as string[])}`);
      } else {
        blocks.push(`${key}:\n${renderUnknownList(value)}`);
      }
      continue;
    }
    blocks.push(`${key}: ${clipInline(oneLineJson(value))}`);
  }
  return joinSections([renderHeader(toolName, scalars), ...blocks]);
}

function renderUnknownList(items: unknown[], limit = DEFAULT_LIST_LIMIT): string {
  const shown = items.slice(0, limit).map((item) => clipInline(oneLineJson(item), 1_000));
  const omitted = items.length - shown.length;
  if (omitted > 0)
    shown.push(`[serializer omitted ${omitted} item(s); narrow the request for more]`);
  return shown.join('\n');
}

/**
 * Render a tool result body for inclusion in the `tool.executed` event.
 * Tool outputs can be large (file dumps, command output); UIs only want a
 * preview line, so cap at ~400 chars with an ellipsis marker.
 */
export function truncateForEvent(content: string, max = 400): string {
  if (!content) return '';
  if (content.length <= max) return content;
  // Never cut a surrogate pair: a lone half reaches providers (brain context)
  // as an unpaired `\udXXX` escape.
  let end = max - 1;
  if (end > 0 && /[\uD800-\uDBFF]/.test(content[end - 1]!)) end--;
  return `${content.slice(0, end)}…`;
}

/**
 * Derive size signals (bytes / tokens / lines) for the chip rendered beside
 * each tool result. Computed once over the FULL `content` BEFORE the
 * 400-char event preview is taken.
 *
 *  - bytes: UTF-8 byte length (multi-byte aware).
 *  - tokens: standard ~3.5 chars/token heuristic.
 *  - lines: read prefixes lines with `<n>→`; for shell/grep/logs we fall
 *    back to a newline count. Undefined for tools without a line notion.
 */
const READ_LINE_PREFIX_RE = /^\s*\d+→/gm;

export function sizeSignals(
  toolName: string | undefined,
  content: string,
): { outputBytes: number; outputTokens: number; outputLines: number | undefined } {
  if (!content || content.length === 0) {
    return { outputBytes: 0, outputTokens: 0, outputLines: undefined };
  }
  const outputBytes = Buffer.byteLength(content, 'utf8');
  // Canonical chars-based estimator (3.5 chars/token, ceiling) so the chip and
  // the model-facing evidence digest agree with the context bar and compaction.
  // A UTF-8 byte basis made short ASCII under-count and CJK over-count.
  const outputTokens = estimateTextTokens(content);
  let outputLines: number | undefined;
  if (toolName === 'read') {
    READ_LINE_PREFIX_RE.lastIndex = 0;
    let count = 0;
    while (READ_LINE_PREFIX_RE.exec(content) !== null) count++;
    if (count > 0) outputLines = count;
  } else if (
    toolName === 'bash' ||
    toolName === 'shell' ||
    toolName === 'grep' ||
    toolName === 'logs'
  ) {
    let nl = 0;
    for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) nl++;
    outputLines = nl + (content.endsWith('\n') ? 0 : 1);
  }
  return { outputBytes, outputTokens, outputLines };
}

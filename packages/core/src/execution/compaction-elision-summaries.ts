/**
 * One-line summaries for elided tool-use inputs and tool results. Split out
 * of compaction-elision.ts.
 */
import type { ToolResultBlock, ToolUseBlock } from '@wrongstack/contracts/types/blocks';
import { sliceUtf16Safe } from './compaction-scoring.js';

const PATH_HINT_PATTERN =
  /(?:(?:[A-Za-z]:)?[./\\]?[\w@.-]+(?:[\\/][\w@(). -]+)+\.[A-Za-z0-9]{1,12})/g;

export const PATH_BACKSLASH_PATTERN = /\\/g;

const PATH_TRIM_PATTERN = /^["'`]+|["'`),;:]+$/g;

const ERROR_LINE_PATTERN =
  /\b(error|exception|failed|failure|fatal|panic|timeout|denied|enoent|eacces|eperm)\b/i;

const STRONG_ERROR_LINE_PATTERN =
  /\b(error|exception|fatal|panic|timeout|denied|enoent|eacces|eperm)\b/i;

const NEWLINE_SPLIT_PATTERN = /\r?\n/;

const WHITESPACE_COLLAPSE_PATTERN = /\s+/g;

export function summarizeToolUseInputElision(
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
    return oneLine.length <= 160
      ? oneLine
      : `${sliceUtf16Safe(oneLine, 0, 120)}...(${oneLine.length} chars)`;
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

export function summarizeToolResultElision(block: ToolResultBlock, tokens: number): string {
  const parts = [`elided: ~${tokens} tokens`];
  if (block.name) parts.push(`tool=${block.name}`);
  const files = extractPathHints(block.content).slice(0, 5);
  if (files.length > 0) parts.push(`files=${files.join(', ')}`);
  const error = firstErrorLine(block.content);
  if (error) parts.push(`error=${error}`);
  const excerpt = semanticToolResultExcerpt(block.content);
  if (excerpt) parts.push(`excerpt=${excerpt}`);
  return `[${parts.join('; ')}]`;
}

function semanticToolResultExcerpt(content: unknown, maxChars = 480): string | undefined {
  const text = safeToolResultString(content).replace(WHITESPACE_COLLAPSE_PATTERN, ' ').trim();
  if (!text) return undefined;
  if (text.length <= maxChars) return text;
  const separator = ' … ';
  const headChars = Math.ceil((maxChars - separator.length) * 0.65);
  const tailChars = maxChars - separator.length - headChars;
  return `${sliceUtf16Safe(text, 0, headChars)}${separator}${sliceUtf16Safe(text, text.length - tailChars)}`;
}

function safeToolResultString(content: unknown): string {
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

export function extractPathHints(content: unknown): string[] {
  const text = safeToolResultString(content);
  const out = new Set<string>();
  for (const match of text.matchAll(PATH_HINT_PATTERN)) {
    const clean = match[0]?.replace(PATH_BACKSLASH_PATTERN, '/').replace(PATH_TRIM_PATTERN, '');
    if (clean && clean.length <= 220) out.add(clean);
    if (out.size >= 5) break;
  }
  return [...out];
}

function firstErrorLine(content: unknown): string | undefined {
  const text = safeToolResultString(content);
  const lines = text.split(NEWLINE_SPLIT_PATTERN);
  for (const pattern of [STRONG_ERROR_LINE_PATTERN, ERROR_LINE_PATTERN]) {
    for (const line of lines) {
      if (!pattern.test(line)) continue;
      const trimmed = line.replace(WHITESPACE_COLLAPSE_PATTERN, ' ').trim();
      if (trimmed) return sliceUtf16Safe(trimmed, 0, 180);
    }
  }
  return undefined;
}

import { randomUUID } from 'node:crypto';
import type { ContentBlock, ToolUseBlock } from '@wrongstack/contracts/types';
import { sanitizeJsonString } from '@wrongstack/core/utils';
import type { OpenAIToolCall } from './to-openai.js';

export interface OpenAIChoice {
  message: {
    role: string;
    content: string | null;
    tool_calls?: OpenAIToolCall[] | undefined;
  };
  finish_reason: string | null;
}

export interface FromOpenAIOptions {
  /**
   * Called when a tool call's `arguments` field can't be parsed even after
   * the sanitizer pass. Callers can use this to emit a structured event,
   * log it, or surface it in a UI. The block is still appended with
   * `{ __raw_arguments }` so the tool gets *something* to fail on, but
   * silently producing garbage input is the kind of bug that wastes
   * debugging hours — this is the hook to find out.
   */
  onParseFailure?: (info: { toolName: string; toolCallId: string; raw: string }) => void;
}

export function contentFromOpenAI(
  choice: OpenAIChoice,
  opts: FromOpenAIOptions = {},
): ContentBlock[] {
  const out: ContentBlock[] = [];
  const text = choice.message.content;
  // Preserve any non-empty text, including whitespace-only — model output
  // sometimes legitimately starts with a newline or padding spaces. Only
  // skip the truly empty case to avoid duplicate empty blocks.
  if (typeof text === 'string' && text.length > 0) {
    out.push({ type: 'text', text });
  }
  for (const tc of choice.message.tool_calls ?? []) {
    const raw = tc.function.arguments ?? '{}';
    // Some OpenAI-compatible servers omit `id` on tool calls. An empty id
    // breaks tool_result correlation downstream, so synthesize a stable one
    // — matching the streaming path and the Google adapter.
    const id = tc.id || `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const input = parseToolArguments(raw, tc.function.name, id, opts);
    const block: ToolUseBlock = {
      type: 'tool_use',
      id,
      name: tc.function.name,
      input,
    };
    out.push(block);
  }
  if (out.length === 0) {
    out.push({ type: 'text', text: '' });
  }
  return out;
}

function parseToolArguments(
  raw: string,
  toolName: string,
  toolCallId: string,
  opts: FromOpenAIOptions,
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    // Salvage case: parsed value is a string (scalar) but contains a serialized JSON object.
    if (typeof parsed === 'string') {
      const trimmed = parsed.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        const parsed2 = JSON.parse(trimmed) as unknown;
        if (parsed2 && typeof parsed2 === 'object' && !Array.isArray(parsed2)) {
          return parsed2 as Record<string, unknown>;
        }
      }
    }
    // JSON parsed but is a scalar/array — wrap so the tool gets a stable
    // object shape, but flag it as a parse anomaly so callers can detect.
    opts.onParseFailure?.({ toolName, toolCallId, raw });
    return { __raw_arguments: raw };
  } catch {
    // First-pass failed — try the sanitizer (handles trailing commas,
    // JS-style comments, smart quotes the model sometimes emits).
    const sanitized = sanitizeJsonString(raw);
    if (sanitized !== null) {
      try {
        const parsed = JSON.parse(sanitized) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
        if (typeof parsed === 'string') {
          const trimmed = parsed.trim();
          if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
            const parsed2 = JSON.parse(trimmed) as unknown;
            if (parsed2 && typeof parsed2 === 'object' && !Array.isArray(parsed2)) {
              return parsed2 as Record<string, unknown>;
            }
          }
        }
      } catch {
        // fall through
      }
    }
    opts.onParseFailure?.({ toolName, toolCallId, raw });
    return { __raw_arguments: raw };
  }
}
